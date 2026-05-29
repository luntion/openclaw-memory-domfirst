import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { EmbedFn } from "../engine/embed.ts";
import type { GmConfig, RecallPlan, RecallResult } from "../types.ts";
import { graphWalkScoped, searchScopedNodes, vectorSearchScoped } from "./store.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";
import { searchNodeVersions } from "../store/store.ts";

export class DomFirstRecaller {
  private embed: EmbedFn | null = null;

  constructor(
    private db: DatabaseSyncInstance,
    private cfg: GmConfig,
  ) {}

  setEmbedFn(fn: EmbedFn | null): void {
    this.embed = fn;
  }

  async recall(query: string, plan: RecallPlan): Promise<RecallResult> {
    if (plan.depth === "L0") {
      return { nodes: [], edges: [], tokenEstimate: 0, timeline: [], timelineSummary: "" };
    }

    const limit = plan.maxNodes;
    if (plan.temporalMode === "past" || plan.temporalMode === "evolution") {
      const versionRecall = this.recallFromVersions(query, plan);
      if (versionRecall.nodes.length && plan.temporalMode === "past") {
        return versionRecall;
      }
      if (versionRecall.nodes.length && plan.temporalMode === "evolution") {
        const currentRecall = await this.recallCurrent(query, plan);
        return this.mergeResults(currentRecall, versionRecall, limit);
      }
    }

    return this.recallCurrent(query, plan);
  }

  private async recallCurrent(query: string, plan: RecallPlan): Promise<RecallResult> {
    const limit = plan.maxNodes;
    let seeds = this.filterByTime(
      searchScopedNodes(this.db, query, limit * 2, plan.scopeFilters),
      plan,
    );

    if (this.embed) {
      try {
        const vector = await this.embed(query);
        const vectorMatches = this.filterByTime(
          vectorSearchScoped(this.db, vector, limit * 2, plan.scopeFilters),
          plan,
        );
        const seen = new Set<string>();
        seeds = [...vectorMatches, ...seeds].filter((node) => {
          if (seen.has(node.id)) return false;
          seen.add(node.id);
          return true;
        });
      } catch {
        // Keep FTS-only behavior.
      }
    }

    seeds = seeds.slice(0, Math.max(limit, 1));

    if (!seeds.length) {
      return { nodes: [], edges: [], tokenEstimate: 0, timeline: [], timelineSummary: "" };
    }

    const seedIds = seeds.map((seed) => seed.id);
    const walked = graphWalkScoped(this.db, seedIds, plan.maxDepth, plan.scopeFilters);
    if (!walked.nodes.length) {
      return { nodes: [], edges: [], tokenEstimate: 0, timeline: [], timelineSummary: "" };
    }

    const timeFilteredNodes = this.filterByTime(walked.nodes, plan);
    const walkedNodeIds = new Set(timeFilteredNodes.map((node) => node.id));
    const timeFilteredEdges = walked.edges.filter(
      (edge) => walkedNodeIds.has(edge.fromId) && walkedNodeIds.has(edge.toId),
    );

    const candidateIds = timeFilteredNodes.map((node) => node.id);
    const { scores } = personalizedPageRank(this.db, seedIds, candidateIds, this.cfg);
    const sorted = timeFilteredNodes
      .sort(
        (a, b) =>
          this.scoreNode(b, scores, plan) - this.scoreNode(a, scores, plan) ||
          b.validatedCount - a.validatedCount ||
          b.updatedAt - a.updatedAt,
      )
      .slice(0, limit);

    const visible = new Set(sorted.map((node) => node.id));
    const edges = timeFilteredEdges.filter((edge) => visible.has(edge.fromId) && visible.has(edge.toId));

    return {
      nodes: sorted,
      edges,
      tokenEstimate: Math.ceil(
        sorted.reduce((sum, node) => sum + node.content.length + node.description.length, 0) / 3,
      ),
      timeline: [],
      timelineSummary: "",
    };
  }

  private recallFromVersions(query: string, plan: RecallPlan): RecallResult {
    const filtered = searchNodeVersions(this.db, query, plan.scopeFilters, plan.maxNodes * 4)
      .filter((version) => this.matchesTime(version.eventTime ?? version.updatedAt, plan))
      .sort((a, b) =>
        (b.capturedAt - a.capturedAt) ||
        (b.versionNo - a.versionNo),
      )
      .slice(0, plan.maxNodes);

    const nodes = filtered.map((version, index, arr) => ({
      ...version,
      id: `${version.nodeId}#v${version.versionNo}`,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
      timelineLabel: this.buildTimelineLabel(version, arr[index - 1]),
    }));

    const timeline = this.buildTimeline(nodes);
    const timelineSummary = this.buildTimelineSummary(timeline);

    return {
      nodes,
      edges: [],
      tokenEstimate: Math.ceil(nodes.reduce((sum, node) => sum + node.content.length + node.description.length, 0) / 3),
      timeline,
      timelineSummary,
    };
  }

  private filterByTime(nodes: RecallResult["nodes"], plan: RecallPlan) {
    if (!plan.timeRange) return nodes;
    return nodes.filter((node) => this.matchesTime(node.eventTime ?? node.updatedAt ?? node.createdAt, plan));
  }

  private scoreNode(
    node: RecallResult["nodes"][number],
    scores: Map<string, number>,
    plan: RecallPlan,
  ) {
    let score = scores.get(node.id) ?? 0;
    if (plan.preferRecent) {
      const ageMs = Date.now() - (node.eventTime ?? node.updatedAt ?? node.createdAt);
      const ageDays = Math.max(ageMs / (24 * 60 * 60 * 1000), 0);
      score += 1 / (1 + ageDays);
    }
    return score;
  }

  private matchesTime(ts: number, plan: RecallPlan): boolean {
    if (!plan.timeRange) return true;
    if (plan.timeRange.start !== undefined && ts < plan.timeRange.start) return false;
    if (plan.timeRange.end !== undefined && ts >= plan.timeRange.end) return false;
    return true;
  }

  private matchesVersionQuery(
    version: { name: string; description: string; content: string },
    terms: string[],
  ): boolean {
    if (!terms.length) return true;
    const haystack = `${version.name}\n${version.description}\n${version.content}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  private mergeResults(current: RecallResult, versioned: RecallResult, limit: number): RecallResult {
    const seen = new Set<string>();
    const nodes = [...current.nodes, ...versioned.nodes].filter((node) => {
      const key = `${node.name}:${node.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
    const visibleIds = new Set(nodes.map((node) => node.id));
    const edges = current.edges.filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));
    return {
      nodes,
      edges,
      tokenEstimate: Math.ceil(nodes.reduce((sum, node) => sum + node.content.length + node.description.length, 0) / 3),
      timelineSummary: versioned.timelineSummary || current.timelineSummary || "",
      timeline: versioned.timeline?.length ? versioned.timeline : current.timeline,
    };
  }

  private buildTimeline(nodes: RecallResult["nodes"]): RecallResult["timeline"] {
    const groups = new Map<string, NonNullable<RecallResult["timeline"]>[number]>();
    for (const node of nodes) {
      if (!("nodeId" in node) || typeof (node as any).versionNo !== "number") continue;
      const key = node.name;
      if (!groups.has(key)) {
        groups.set(key, { name: key, versions: [] });
      }
      groups.get(key)!.versions.push({
        id: node.id,
        nodeId: (node as any).nodeId,
        versionNo: (node as any).versionNo,
        content: node.content,
        description: node.description,
        capturedAt: (node as any).capturedAt,
        supersededAt: (node as any).supersededAt ?? null,
        timelineLabel: (node as any).timelineLabel,
      });
    }

    return Array.from(groups.values()).map((group) => ({
      ...group,
      versions: group.versions.sort((a: { versionNo: number }, b: { versionNo: number }) => a.versionNo - b.versionNo),
    }));
  }

  private buildTimelineLabel(
    version: { versionNo: number; capturedAt: number },
    previous?: { capturedAt: number },
  ): string {
    if (version.versionNo === 1) return "initial";
    if (!previous) return `v${version.versionNo}`;
    const deltaMs = Math.max(version.capturedAt - previous.capturedAt, 0);
    const deltaHours = Math.round(deltaMs / (60 * 60 * 1000));
    if (deltaHours <= 1) return `v${version.versionNo} (+${Math.max(deltaHours, 0)}h)`;
    if (deltaHours < 24) return `v${version.versionNo} (+${deltaHours}h)`;
    const deltaDays = Math.round(deltaHours / 24);
    return `v${version.versionNo} (+${deltaDays}d)`;
  }

  private buildTimelineSummary(timeline?: RecallResult["timeline"]): string {
    if (!timeline?.length) return "";

    const lines = timeline.slice(0, 3).map((item) => {
      const first = item.versions[0];
      const last = item.versions[item.versions.length - 1];
      if (!first || !last) return "";
      if (item.versions.length === 1) {
        return `${item.name}: single recorded version - ${first.description || first.content.slice(0, 80)}`;
      }
      const middle = item.versions.slice(1, -1)
        .map((version) => version.description || version.content.slice(0, 48))
        .slice(0, 2)
        .join(" -> ");
      const parts = [
        `${item.name}:`,
        `${first.description || first.content.slice(0, 48)}`,
        middle,
        `${last.description || last.content.slice(0, 48)}`,
      ].filter(Boolean);
      return parts.join(" -> ");
    }).filter(Boolean);

    return lines.join("\n");
  }
}
