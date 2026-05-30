import type { EmbedFn } from "../engine/embed.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type {
  BackendDiagnostics,
  CandidateReviewAction,
  GmConfig,
  GmNode,
  RecallPlan,
  ScopeContext,
  TemporalMode,
} from "../types.ts";
import type { BackendRuntime } from "../backend/types.ts";
import { Extractor } from "../extractor/extract.ts";
import { getCommunitySummary } from "../store/store.ts";
import { assembleContext } from "../format/assemble.ts";
import { planRecall } from "./recall-plan.ts";
import { discoverKnowledgeFiles, type IndexedFileResult } from "./files.ts";
import { classifyEdgeScope, classifyNodeScope, extractEventTime, scopeIdFor } from "./classify.ts";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";

export class DomFirstMemoryEngine {
  private extractor: Extractor;
  private embedFn: EmbedFn | null = null;
  private msgSeq = new Map<string, number>();
  private extractChain = new Map<string, Promise<void>>();

  constructor(
    private runtime: BackendRuntime,
    private localDb: DatabaseSyncInstance,
    private cfg: GmConfig,
    private llm: CompleteFn,
    private logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void },
  ) {
    this.extractor = new Extractor(cfg, llm);
  }

  setEmbedFn(fn: EmbedFn | null): void {
    this.embedFn = fn;
    this.runtime.recallBackend.setEmbedFn(fn);
  }

  buildScopeContext(input: Partial<ScopeContext>): ScopeContext {
    return {
      sessionId: input.sessionId ?? "session-default",
      agentId: input.agentId ?? this.cfg.defaultAgentId,
      projectId: input.projectId ?? this.cfg.defaultProjectId,
      teamId: input.teamId ?? this.cfg.teamId,
      userId: input.userId,
    };
  }

  ingestMessage(ctx: ScopeContext, message: any, isHeartbeat?: boolean): { ingested: boolean } {
    if (isHeartbeat) return { ingested: false };
    let seq = this.msgSeq.get(ctx.sessionId);
    if (seq === undefined) {
      const existing = this.runtime.messageStore.getMessages(ctx.sessionId);
      seq = existing.length ? Math.max(...existing.map((row) => Number(row.turn_index ?? 0))) : 0;
    }
    seq += 1;
    this.msgSeq.set(ctx.sessionId, seq);
    this.runtime.messageStore.saveMessage(ctx.sessionId, seq, message.role ?? "unknown", message);
    return { ingested: true };
  }

  async afterTurn(ctx: ScopeContext, newMessages: any[]): Promise<void> {
    if (!newMessages.length) return;
    const prev = this.extractChain.get(ctx.sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const msgs = this.runtime.messageStore.getUnextracted(ctx.sessionId, 50);
      if (!msgs.length) return;
      const existing = (await this.runtime.graphStore.getSessionNodes(ctx.sessionId, [{ scopeType: "session", scopeIds: [ctx.sessionId] }]))
        .map((node) => node.name);
      const result = await this.extractor.extract({ messages: msgs, existingNames: existing });
      const conversationText = msgs.map((msg) => this.contentToText(msg.content)).join("\n");

      const knownNodes = new Map<string, GmNode>();
      for (const candidate of result.nodes) {
        const scopeType = classifyNodeScope(ctx, candidate, conversationText);
        const scopeId = scopeIdFor(ctx, this.cfg.teamId, scopeType);
        const eventTime = extractEventTime(conversationText);
        const resolvedAt = /修复|fix|resolved|解决|处理好了/i.test(candidate.content) ? Date.now() : null;
        const { node } = await this.runtime.graphStore.upsertNode(
          candidate,
          ctx,
          {
            scopeType,
            scopeId,
            visibility: scopeType === "project" || scopeType === "team" ? "shared" : "private",
            confidence: 0.7,
            verificationCount: 1,
            promotionState: scopeType === "team" ? "promoted" : "private",
            eventTime,
            resolvedAt,
          },
        );
        knownNodes.set(node.name, node);
        if (candidate.type !== "TASK" && (node.validatedCount >= 1 || /修复|fix|解决|error|故障/i.test(candidate.content))) {
          await this.runtime.graphStore.markCandidate(node.id);
          if (node.verificationCount >= 2) {
            await this.runtime.graphStore.promote(node.name, ctx, false);
          }
        }
      }

      for (const edge of result.edges) {
        const from = knownNodes.get(edge.from) ?? await this.runtime.graphStore.findNodeByName(edge.from, buildScopeFilters(ctx, true));
        const to = knownNodes.get(edge.to) ?? await this.runtime.graphStore.findNodeByName(edge.to, buildScopeFilters(ctx, true));
        if (!from || !to) continue;
        const scopeType = classifyEdgeScope(ctx, from, to);
        await this.runtime.graphStore.upsertEdge(
          {
            fromId: from.id,
            toId: to.id,
            type: edge.type,
            instruction: edge.instruction,
            condition: edge.condition,
          },
          ctx,
          {
            scopeType,
            scopeId: scopeIdFor(ctx, this.cfg.teamId, scopeType),
            visibility: scopeType === "project" || scopeType === "team" ? "shared" : "private",
            confidence: 0.7,
            verificationCount: 1,
            promotionState: scopeType === "team" ? "promoted" : "private",
          },
        );
      }

      const maxTurn = Math.max(...msgs.map((msg) => Number(msg.turn_index)));
      this.runtime.messageStore.markExtracted(ctx.sessionId, maxTurn);
      this.logger?.info?.(`[openclaw-memory-domfirst] extracted ${result.nodes.length} nodes and ${result.edges.length} edges`);
    }).catch((error) => {
      this.logger?.error?.(`[openclaw-memory-domfirst] afterTurn extract failed: ${error}`);
    });
    this.extractChain.set(ctx.sessionId, next);
    await next;
  }

  planRecall(query: string, ctx: ScopeContext): RecallPlan {
    return planRecall(query, ctx);
  }

  async search(query: string, ctx: ScopeContext, overridePlan?: Partial<RecallPlan>) {
    const plan = this.resolvePlan(query, ctx, overridePlan);
    const result = await this.runtime.recallBackend.recall(query, plan);
    return { plan, result };
  }

  async searchTemporal(
    query: string,
    ctx: ScopeContext,
    options?: {
      temporalMode?: TemporalMode;
      includeTeam?: boolean;
      depth?: RecallPlan["depth"];
      timeRange?: RecallPlan["timeRange"];
      preferRecent?: boolean;
      maxNodes?: number;
      maxDepth?: number;
    },
  ) {
    const plan = this.resolvePlan(query, ctx, {
      temporalMode: options?.temporalMode,
      includeTeam: options?.includeTeam,
      depth: options?.depth,
      timeRange: options?.timeRange,
      preferRecent: options?.preferRecent,
      maxNodes: options?.maxNodes,
      maxDepth: options?.maxDepth,
    });
    const result = await this.runtime.recallBackend.recall(query, plan);
    return { plan, result };
  }

  remember(
    input: { type: GmNode["type"]; name: string; description: string; content: string },
    ctx: ScopeContext,
    meta?: Record<string, unknown>,
  ) {
    return this.runtime.graphStore.upsertNode(input, ctx, meta as any);
  }

  async assemble(params: {
    ctx: ScopeContext;
    messages: any[];
    prompt?: string;
  }): Promise<{ messages: any[]; estimatedTokens: number; systemPromptAddition?: string; recallPlan: RecallPlan }> {
    const query = params.prompt?.trim() || this.lastUserText(params.messages) || "";
    const recallPlan = this.planRecall(query, params.ctx);
    const recalled = await this.runtime.recallBackend.recall(query, recallPlan);
    const activeNodes = await this.runtime.graphStore.getSessionNodes(params.ctx.sessionId, [{ scopeType: "session", scopeIds: [params.ctx.sessionId] }]);
    const activeEdges = dedupeEdges((await Promise.all(activeNodes.map((node) => this.runtime.graphStore.getEdgesForNode(node.id)))).flat());
    const recallForContext =
      recallPlan.depth === "L1"
        ? { ...recalled, nodes: recalled.nodes.slice(0, 3), edges: [] }
        : recallPlan.depth === "L2"
          ? { ...recalled, nodes: recalled.nodes.slice(0, 5), edges: recalled.edges.slice(0, 5) }
          : recalled;

    const { xml, systemPrompt, tokens, episodicXml, temporalXml } = assembleContext({
      tokenBudget: 0,
      activeNodes,
      activeEdges,
      recalledNodes: recallForContext.nodes,
      recalledEdges: recallForContext.edges,
      timeline: recallForContext.timeline,
      timelineSummary: recallForContext.timelineSummary,
      getCommunitySummary: (communityId) => getCommunitySummary(this.localDb, communityId),
      getEpisodicMessages: (sessionIds, beforeTs, limitChars) =>
        this.runtime.messageStore.getEpisodicMessages(sessionIds, beforeTs, limitChars),
    });

    const systemPromptAddition = [systemPrompt, temporalXml, xml, episodicXml].filter(Boolean).join("\n\n") || undefined;
    return {
      messages: this.keepRecentMessages(params.messages),
      estimatedTokens: tokens,
      systemPromptAddition,
      recallPlan,
    };
  }

  stats(ctx: ScopeContext) {
    return this.runtime.graphStore.stats(buildScopeFilters(ctx, true));
  }

  inspect(name: string, ctx: ScopeContext, includeTeam = true) {
    return this.runtime.graphStore.inspect(name, buildScopeFilters(ctx, includeTeam));
  }

  candidates(ctx: ScopeContext, includeTeam = true, limit = 20) {
    return this.runtime.graphStore.listCandidates(buildScopeFilters(ctx, includeTeam), limit);
  }

  promote(name: string, ctx: ScopeContext, explicit = false) {
    return this.runtime.graphStore.promote(name, ctx, explicit);
  }

  lineage(name: string, ctx: ScopeContext, includeTeam = true) {
    return this.runtime.graphStore.lineage(name, buildScopeFilters(ctx, includeTeam));
  }

  reviewCandidate(name: string, ctx: ScopeContext, action: CandidateReviewAction, targetName?: string) {
    return this.runtime.graphStore.reviewCandidate(name, ctx, action, targetName);
  }

  audit(ctx: ScopeContext, includeTeam = true) {
    return this.runtime.graphStore.audit(buildScopeFilters(ctx, includeTeam));
  }

  async health() {
    return this.runtime.health();
  }

  async diagnostics(ctx: ScopeContext): Promise<BackendDiagnostics> {
    const health = await this.runtime.health();
    const degraded = typeof health?.status === "string" && health.status !== "ok";
    const emptyStats = { totalNodes: 0, totalEdges: 0, communities: 0 };
    const emptyDiagnostics: BackendDiagnostics = {
      backend: this.cfg.backend.mode,
      health,
      scopeStats: {
        session: 0,
        agent: 0,
        project: 0,
        team: 0,
      },
      candidateCount: 0,
      auditFindingCount: 0,
      sampleCandidates: [],
      sampleAuditFindings: [],
    };

    if (degraded) {
      return emptyDiagnostics;
    }

    const [sessionStats, agentStats, projectStats, teamStats, candidates, auditFindings] = await Promise.all([
      this.runtime.graphStore.stats([{ scopeType: "session", scopeIds: [ctx.sessionId] }]).catch(() => emptyStats),
      this.runtime.graphStore.stats([{ scopeType: "agent", scopeIds: [ctx.agentId] }]).catch(() => emptyStats),
      ctx.projectId
        ? this.runtime.graphStore.stats([{ scopeType: "project", scopeIds: [ctx.projectId] }]).catch(() => emptyStats)
        : Promise.resolve(emptyStats),
      ctx.teamId
        ? this.runtime.graphStore.stats([{ scopeType: "team", scopeIds: [ctx.teamId] }]).catch(() => emptyStats)
        : Promise.resolve(emptyStats),
      this.runtime.graphStore.listCandidates(buildScopeFilters(ctx, true), 10).catch(() => []),
      this.runtime.graphStore.audit(buildScopeFilters(ctx, true)).catch(() => []),
    ]);

    return {
      backend: this.cfg.backend.mode,
      health,
      scopeStats: {
        session: sessionStats.totalNodes,
        agent: agentStats.totalNodes,
        project: projectStats.totalNodes,
        team: teamStats.totalNodes,
      },
      candidateCount: candidates.length,
      auditFindingCount: auditFindings.length,
      sampleCandidates: candidates.slice(0, 5).map((node) => ({
        name: node.name,
        scopeType: node.scopeType,
        scopeId: node.scopeId,
        verificationCount: node.verificationCount,
        confidence: node.confidence,
        promotionState: node.promotionState,
      })),
      sampleAuditFindings: auditFindings.slice(0, 5).map((item) => ({
        name: item.name,
        scopeType: item.scopeType,
        scopeId: item.scopeId,
        severity: item.severity,
        reason: item.reason,
      })),
    };
  }

  async runMaintenance(): Promise<any> {
    return {
      ok: true,
      backend: this.cfg.backend.mode,
      skipped: this.cfg.backend.mode !== "sqlite",
      reason: this.cfg.backend.mode === "sqlite" ? "maintenance delegated to sqlite graph routines" : "maintenance is backend-managed in graphiti-neo4j mode",
    };
  }

  async reindex(root: string, ctx: ScopeContext): Promise<IndexedFileResult[]> {
    const files = discoverKnowledgeFiles(root, this.cfg.knowledgeMarkers);
    const results: IndexedFileResult[] = [];
    for (const file of files) {
      try {
        const text = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
        const content = text.trim();
        if (!content) {
          results.push({ path: file, indexed: false, reason: "empty file" });
          continue;
        }
        const isProject = file.replace(/\\/g, "/").includes("/memory/");
        const scopeType = isProject ? "project" : "agent";
        const name = file
          .replace(/\\/g, "/")
          .split("/")
          .slice(-2)
          .join("-")
          .replace(/\.[^.]+$/, "")
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "-")
          .replace(/-{2,}/g, "-")
          .replace(/^-|-$/g, "");
        await this.runtime.graphStore.upsertNode(
          {
            type: "SKILL",
            name,
            description: `Knowledge file indexed from ${file}`,
            content: `[${name}]\nSource: ${file}\nSummary: ${content.slice(0, 240)}\n\n${content}`,
          },
          ctx,
          {
            scopeType,
            scopeId: isProject ? (ctx.projectId ?? ctx.agentId) : ctx.agentId,
            visibility: isProject ? "shared" : "private",
            confidence: 0.8,
            verificationCount: 1,
            promotionState: "private",
          },
        );
        results.push({ path: file, indexed: true });
      } catch (error) {
        results.push({ path: file, indexed: false, reason: String(error) });
      }
    }
    return results;
  }

  disposeSession(sessionId: string): void {
    this.extractChain.delete(sessionId);
    this.msgSeq.delete(sessionId);
  }

  getRecentMessages(sessionId: string, limit = 10): any[] {
    return this.runtime.messageStore.getMessages(sessionId, limit);
  }

  private keepRecentMessages(messages: any[]): any[] {
    return messages.slice(-12);
  }

  private lastUserText(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .filter((block: any) => block?.type === "text" && typeof block.text === "string")
          .map((block: any) => block.text)
          .join("\n");
      }
      return String(message.content ?? "");
    }
    return "";
  }

  private contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => typeof block?.text === "string" ? block.text : "")
        .join("\n");
    }
    return String(content ?? "");
  }

  private resolvePlan(query: string, ctx: ScopeContext, overridePlan?: Partial<RecallPlan>): RecallPlan {
    const base = this.planRecall(query, ctx);
    const cleanedOverrides = Object.fromEntries(
      Object.entries(overridePlan ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<RecallPlan>;
    const includeTeam = cleanedOverrides.includeTeam ?? base.includeTeam;
    const plan = {
      ...base,
      ...cleanedOverrides,
      includeTeam,
      scopeFilters: buildScopeFilters(ctx, includeTeam),
    } as RecallPlan;

    if (cleanedOverrides.depth) {
      if (cleanedOverrides.maxNodes === undefined) {
        plan.maxNodes = defaultMaxNodesForDepth(cleanedOverrides.depth);
      }
      if (cleanedOverrides.maxDepth === undefined) {
        plan.maxDepth = defaultGraphDepthForRecall(cleanedOverrides.depth);
      }
      if (!cleanedOverrides.reason) {
        plan.reason = `explicit ${cleanedOverrides.depth} override`;
      }
    }

    return plan;
  }
}

function defaultMaxNodesForDepth(depth: RecallPlan["depth"]): number {
  if (depth === "L0") return 0;
  if (depth === "L1") return 3;
  if (depth === "L2") return 5;
  return 8;
}

function defaultGraphDepthForRecall(depth: RecallPlan["depth"]): number {
  if (depth === "L0" || depth === "L1") return 0;
  if (depth === "L2") return 1;
  return 2;
}

function buildScopeFilters(ctx: ScopeContext, includeTeam = true) {
  const filters: Array<{ scopeType: "session" | "agent" | "project" | "team"; scopeIds: string[] }> = [
    { scopeType: "session" as const, scopeIds: [ctx.sessionId] },
    { scopeType: "agent" as const, scopeIds: [ctx.agentId] },
  ];
  if (ctx.projectId) filters.push({ scopeType: "project" as const, scopeIds: [ctx.projectId] });
  if (includeTeam && ctx.teamId) filters.push({ scopeType: "team" as const, scopeIds: [ctx.teamId] });
  return filters;
}

function dedupeEdges(edges: GmNode extends never ? never : any[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}
