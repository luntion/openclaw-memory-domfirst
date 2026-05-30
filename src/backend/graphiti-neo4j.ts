import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import neo4j, { type Driver, type Record as Neo4jRecord, type Session } from "neo4j-driver";
import type { EmbedFn } from "../engine/embed.ts";
import type {
  AuditFinding,
  CandidateReviewAction,
  GmConfig,
  GmEdge,
  GmNode,
  GmNodeVersion,
  MemoryMetadata,
  RecallPlan,
  RecallResult,
  ScopeContext,
  ScopeFilter,
  ScopeType,
} from "../types.ts";
import type {
  BackendRuntime,
  MemoryGraphStore,
  MessageStore,
  RecallBackend,
  ScopedStats,
} from "./types.ts";
import {
  getEpisodicMessages,
  getMessages,
  getUnextracted,
  markExtracted,
  saveMessage,
} from "../store/store.ts";
import { defaultMetadata, matchesScopeFilters } from "../domfirst/scope.ts";

type GraphitiFact = {
  uuid: string;
  name?: string;
  fact: string;
  valid_at?: string | null;
  invalid_at?: string | null;
  created_at?: string | null;
  expired_at?: string | null;
};

const MEMORY_TEXT_INDEX = "domfirst_memory_text";

class SQLiteMessageStore implements MessageStore {
  constructor(private db: DatabaseSyncInstance) {}

  saveMessage(sessionId: string, turnIndex: number, role: string, content: unknown): void {
    saveMessage(this.db, sessionId, turnIndex, role, content);
  }

  getMessages(sessionId: string, limit?: number) {
    return getMessages(this.db, sessionId, limit);
  }

  getUnextracted(sessionId: string, limit: number) {
    return getUnextracted(this.db, sessionId, limit);
  }

  markExtracted(sessionId: string, upToTurn: number): void {
    markExtracted(this.db, sessionId, upToTurn);
  }

  getEpisodicMessages(sessionIds: string[], beforeTs: number, limitChars: number) {
    return getEpisodicMessages(this.db, sessionIds, beforeTs, limitChars);
  }
}

class GraphitiClient {
  constructor(
    private baseUrl: string,
    private timeoutMs: number,
  ) {}

  async health(): Promise<{ status: string }> {
    const res = await this.request("/healthcheck", { method: "GET" });
    return res as { status: string };
  }

  async addMessages(groupId: string, messages: Array<{
    uuid: string;
    name: string;
    role: string;
    role_type: string;
    content: string;
    timestamp: string;
    source_description: string;
  }>): Promise<void> {
    await this.request("/messages", {
      method: "POST",
      body: JSON.stringify({
        group_id: groupId,
        messages,
      }),
    });
  }

  async search(groupIds: string[], query: string, maxFacts: number): Promise<GraphitiFact[]> {
    const res = await this.request("/search", {
      method: "POST",
      body: JSON.stringify({
        group_ids: groupIds,
        query,
        max_facts: maxFacts,
      }),
    }, Math.min(this.timeoutMs, 3_000)) as { facts?: GraphitiFact[] };
    return res.facts ?? [];
  }

  private async request(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Graphiti request failed: ${res.status} ${res.statusText}`);
      }
      if (res.status === 202) return {};
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }
}

function toNumber(value: unknown, fallback = 0): number {
  if (neo4j.isInt(value)) return value.toNumber();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return fallback;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function scopeIdFor(ctx: ScopeContext, scopeType: ScopeType, fallbackTeamId: string): string {
  if (scopeType === "session") return ctx.sessionId;
  if (scopeType === "agent") return ctx.agentId;
  if (scopeType === "project") return ctx.projectId ?? ctx.agentId;
  return ctx.teamId ?? fallbackTeamId;
}

function groupIdFor(cfg: GmConfig, scopeType: ScopeType, scopeId: string): string {
  const prefix = cfg.backend.graphiti.groupPrefix.trim() || "ocm";
  return `${prefix}:${cfg.backend.neo4j.workspace}:${scopeType}:${scopeId}`;
}

function parseGroupId(raw: string | undefined, cfg: GmConfig): { scopeType: ScopeType; scopeId: string } {
  if (!raw) return { scopeType: "team", scopeId: cfg.teamId };
  const parts = raw.split(":");
  if (parts.length >= 4) {
    return {
      scopeType: parts[2] as ScopeType,
      scopeId: parts.slice(3).join(":"),
    };
  }
  return { scopeType: "team", scopeId: raw };
}

function buildScopeClauses(filters?: ScopeFilter[], variableName = "m"): { where: string; params: Record<string, unknown> } {
  if (!filters?.length) return { where: "", params: {} };
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  filters.forEach((filter, index) => {
    const typeKey = `scopeType${index}`;
    params[typeKey] = filter.scopeType;
    if (filter.scopeIds?.length) {
      const idsKey = `scopeIds${index}`;
      params[idsKey] = filter.scopeIds;
      clauses.push(`(${variableName}.scopeType = $${typeKey} AND ${variableName}.scopeId IN $${idsKey})`);
    } else {
      clauses.push(`(${variableName}.scopeType = $${typeKey})`);
    }
  });
  return { where: `WHERE ${clauses.join(" OR ")}`, params };
}

function mapNode(record: Neo4jRecord, key = "m"): GmNode {
  const props = record.get(key).properties;
  return {
    id: String(props.id),
    type: props.type,
    name: String(props.name),
    description: String(props.description ?? ""),
    content: String(props.content ?? ""),
    scopeType: props.scopeType,
    scopeId: String(props.scopeId),
    visibility: props.visibility,
    sourceAgentId: props.sourceAgentId ?? null,
    sourceSessionId: props.sourceSessionId ?? null,
    projectId: props.projectId ?? null,
    confidence: Number(props.confidence ?? 0.6),
    verificationCount: toNumber(props.verificationCount, 1),
    promotionState: props.promotionState,
    eventTime: props.eventTime == null ? null : toNumber(props.eventTime),
    resolvedAt: props.resolvedAt == null ? null : toNumber(props.resolvedAt),
    supersededBy: props.supersededBy ?? null,
    status: props.status,
    validatedCount: toNumber(props.validatedCount, 1),
    sourceSessions: Array.isArray(props.sourceSessions) ? props.sourceSessions.map(String) : [],
    communityId: props.communityId ?? null,
    pagerank: Number(props.pagerank ?? 0),
    createdAt: toNumber(props.createdAt, Date.now()),
    updatedAt: toNumber(props.updatedAt, Date.now()),
  };
}

function mapVersion(record: Neo4jRecord, key = "v"): GmNodeVersion {
  const props = record.get(key).properties;
  return {
    id: String(props.id),
    nodeId: String(props.nodeId),
    versionNo: toNumber(props.versionNo, 1),
    type: props.type,
    name: String(props.name),
    description: String(props.description ?? ""),
    content: String(props.content ?? ""),
    scopeType: props.scopeType,
    scopeId: String(props.scopeId),
    visibility: props.visibility,
    sourceAgentId: props.sourceAgentId ?? null,
    sourceSessionId: props.sourceSessionId ?? null,
    projectId: props.projectId ?? null,
    confidence: Number(props.confidence ?? 0.6),
    verificationCount: toNumber(props.verificationCount, 1),
    promotionState: props.promotionState,
    eventTime: props.eventTime == null ? null : toNumber(props.eventTime),
    resolvedAt: props.resolvedAt == null ? null : toNumber(props.resolvedAt),
    supersededBy: props.supersededBy ?? null,
    status: props.status,
    validatedCount: toNumber(props.validatedCount, 1),
    sourceSessions: Array.isArray(props.sourceSessions) ? props.sourceSessions.map(String) : [],
    communityId: props.communityId ?? null,
    pagerank: Number(props.pagerank ?? 0),
    createdAt: toNumber(props.createdAt, Date.now()),
    updatedAt: toNumber(props.updatedAt, Date.now()),
    capturedAt: toNumber(props.capturedAt, Date.now()),
    supersededAt: props.supersededAt == null ? null : toNumber(props.supersededAt),
    reason: String(props.reason ?? "superseded"),
    timelineLabel: props.timelineLabel ?? undefined,
  };
}

function mapEdge(record: Neo4jRecord, relKey = "r", fromKey = "from", toKey = "to"): GmEdge {
  const rel = record.get(relKey);
  const props = rel.properties;
  return {
    id: String(props.id),
    fromId: String(record.get(fromKey).properties.id),
    toId: String(record.get(toKey).properties.id),
    type: props.edgeType,
    instruction: String(props.instruction ?? ""),
    condition: props.condition ?? undefined,
    sessionId: String(props.sessionId ?? ""),
    scopeType: props.scopeType,
    scopeId: String(props.scopeId ?? ""),
    visibility: props.visibility,
    sourceAgentId: props.sourceAgentId ?? null,
    projectId: props.projectId ?? null,
    createdAt: toNumber(props.createdAt, Date.now()),
  };
}

class GraphitiNeo4jRecallBackend implements RecallBackend {
  private embed: EmbedFn | null = null;
  private graphitiSearchDisabledUntil = 0;

  constructor(
    private driver: Driver,
    private graphiti: GraphitiClient,
    private cfg: GmConfig,
    private ensureReady: () => Promise<void>,
  ) {}

  setEmbedFn(fn: EmbedFn | null): void {
    this.embed = fn;
  }

  async recall(query: string, plan: RecallPlan): Promise<RecallResult> {
    await this.ensureReady();
    if (plan.depth === "L0") {
      return { nodes: [], edges: [], tokenEstimate: 0, timeline: [], timelineSummary: "" };
    }

    if (plan.temporalMode === "past" || plan.temporalMode === "evolution") {
      const versioned = await this.recallVersions(query, plan);
      if (plan.temporalMode === "past" && versioned.nodes.length) return versioned;
      if (plan.temporalMode === "evolution" && versioned.nodes.length) {
        const current = await this.recallCurrent(query, plan);
        return this.mergeResults(current, versioned, plan.maxNodes);
      }
    }

    return this.recallCurrent(query, plan);
  }

  private async recallCurrent(query: string, plan: RecallPlan): Promise<RecallResult> {
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const graphitiNodes = await this.searchGraphitiFacts(query, plan);
      const neo4jNodes = await this.searchNeo4jMemories(session, query, plan);
      const deduped = dedupeNodes([...neo4jNodes, ...graphitiNodes]).slice(0, plan.maxNodes);
      const edges = deduped.length
        ? await this.loadEdges(session, deduped.map((node) => node.id), plan)
        : [];
      return {
        nodes: deduped,
        edges,
        tokenEstimate: estimateTokens(deduped),
        timeline: [],
        timelineSummary: "",
      };
    } finally {
      await session.close();
    }
  }

  private async searchGraphitiFacts(query: string, plan: RecallPlan): Promise<GmNode[]> {
    if (this.graphitiSearchDisabledUntil > Date.now()) {
      return [];
    }
    const candidateFilters = plan.scopeFilters.slice(0, 2);
    const nodes: GmNode[] = [];
    for (const filter of candidateFilters) {
      for (const scopeId of filter.scopeIds ?? []) {
        const groupId = groupIdFor(this.cfg, filter.scopeType, scopeId);
        let facts: GraphitiFact[] = [];
        try {
          facts = await this.graphiti.search([groupId], query, Math.max(2, plan.maxNodes));
        } catch {
          this.graphitiSearchDisabledUntil = Date.now() + 5 * 60_000;
          continue;
        }
        for (const fact of facts) {
          const ts = parseGraphitiDate(fact.valid_at ?? fact.created_at);
          if (!matchesTime(ts, plan)) continue;
          nodes.push({
            id: `graphiti:${fact.uuid}`,
            type: "EVENT",
            name: fact.name?.trim() || compactName(fact.fact),
            description: fact.fact,
            content: fact.fact,
            scopeType: filter.scopeType,
            scopeId,
            visibility: filter.scopeType === "team" || filter.scopeType === "project" ? "shared" : "private",
            sourceAgentId: null,
            sourceSessionId: null,
            projectId: filter.scopeType === "project" ? scopeId : null,
            confidence: 0.82,
            verificationCount: 1,
            promotionState: filter.scopeType === "team" ? "promoted" : "private",
            eventTime: ts,
            resolvedAt: parseGraphitiDate(fact.invalid_at),
            supersededBy: null,
            status: plan.temporalMode === "past" ? "superseded" : "active",
            validatedCount: 1,
            sourceSessions: [],
            communityId: null,
            pagerank: 0,
            createdAt: parseGraphitiDate(fact.created_at) || Date.now(),
            updatedAt: ts || Date.now(),
          });
        }
      }
    }
    return nodes;
  }

  private async searchNeo4jMemories(session: Session, query: string, plan: RecallPlan): Promise<GmNode[]> {
    const workspace = this.cfg.backend.neo4j.workspace;
    const limit = neo4j.int(Math.max(plan.maxNodes * 2, 6));
    const q = query.trim();

    try {
      const { where, params } = buildScopeClauses(plan.scopeFilters, "node");
      const scopedWhere = where
        ? `${where} AND node.workspace = $workspace`
        : "WHERE node.workspace = $workspace";
      const result = await session.run(
        `
        CALL db.index.fulltext.queryNodes($indexName, $ftsQuery) YIELD node, score
        ${scopedWhere}
        RETURN node as m, score
        ORDER BY score DESC, m.verificationCount DESC, m.confidence DESC, m.updatedAt DESC
        LIMIT $limit
        `,
        {
          indexName: MEMORY_TEXT_INDEX,
          ftsQuery: buildFullTextQuery(q),
          workspace,
          limit,
          ...params,
        },
      );
      return result.records
        .map((record) => mapNode(record))
        .filter((node) => matchesTime(node.eventTime ?? node.updatedAt, plan));
    } catch {
      const { where, params } = buildScopeClauses(plan.scopeFilters);
      const result = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace})
        ${where}
          AND (
            toLower(m.name) CONTAINS $q OR
            toLower(m.description) CONTAINS $q OR
            toLower(m.content) CONTAINS $q
          )
        RETURN m
        ORDER BY m.verificationCount DESC, m.confidence DESC, m.updatedAt DESC
        LIMIT $limit
        `,
        {
          workspace,
          q: q.toLowerCase(),
          limit,
          ...params,
        },
      );
      return result.records
        .map((record) => mapNode(record))
        .filter((node) => matchesTime(node.eventTime ?? node.updatedAt, plan));
    }
  }

  private async loadEdges(session: Session, nodeIds: string[], plan: RecallPlan): Promise<GmEdge[]> {
    const result = await session.run(
      `
      MATCH (from:DomFirstMemory)-[r:DOMFIRST_EDGE]->(to:DomFirstMemory)
      WHERE from.id IN $ids AND to.id IN $ids
      RETURN from, r, to
      LIMIT $limit
      `,
      {
        ids: nodeIds,
        limit: neo4j.int(Math.max(plan.maxNodes * 2, 8)),
      },
    );
    return result.records.map((record) => mapEdge(record));
  }

  private async recallVersions(query: string, plan: RecallPlan): Promise<RecallResult> {
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const { where, params } = buildScopeClauses(plan.scopeFilters);
      const result = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace})-[:HAS_VERSION]->(v:DomFirstVersion)
        ${where}
          AND (
            toLower(v.name) CONTAINS $q OR
            toLower(v.description) CONTAINS $q OR
            toLower(v.content) CONTAINS $q
          )
        RETURN v
        ORDER BY v.capturedAt DESC, v.versionNo DESC
        LIMIT $limit
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          q: query.trim().toLowerCase(),
          limit: neo4j.int(Math.max(plan.maxNodes * 4, 8)),
          ...params,
        },
      );
      const versions = result.records
        .map((record) => mapVersion(record))
        .filter((version) => matchesTime(version.eventTime ?? version.updatedAt, plan))
        .slice(0, plan.maxNodes);
      const nodes = versions.map((version) => ({
        ...version,
        id: `${version.nodeId}#v${version.versionNo}`,
      })) as GmNode[];
      const timeline = buildTimeline(versions);
      return {
        nodes,
        edges: [],
        tokenEstimate: estimateTokens(nodes),
        timeline,
        timelineSummary: buildTimelineSummary(timeline),
      };
    } finally {
      await session.close();
    }
  }

  private mergeResults(current: RecallResult, versioned: RecallResult, limit: number): RecallResult {
    const nodes = dedupeNodes([...current.nodes, ...versioned.nodes]).slice(0, limit);
    const visible = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: current.edges.filter((edge) => visible.has(edge.fromId) && visible.has(edge.toId)),
      tokenEstimate: estimateTokens(nodes),
      timeline: versioned.timeline,
      timelineSummary: versioned.timelineSummary,
    };
  }
}

class GraphitiNeo4jGraphStore implements MemoryGraphStore {
  constructor(
    private driver: Driver,
    private graphiti: GraphitiClient,
    private cfg: GmConfig,
    private ensureReady: () => Promise<void>,
  ) {}

  async upsertNode(
    input: { type: GmNode["type"]; name: string; description: string; content: string },
    ctx: ScopeContext,
    meta?: Partial<MemoryMetadata>,
  ) {
    await this.ensureReady();
    const resolved = { ...defaultMetadata(ctx, meta?.scopeType ?? "agent"), ...meta };
    const scopeType = resolved.scopeType;
    const scopeId = resolved.scopeId ?? scopeIdFor(ctx, scopeType, this.cfg.teamId);
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    const nameKey = normalizeName(input.name);
    const now = Date.now();
    const nodeId = `mem:${this.cfg.backend.neo4j.workspace}:${scopeType}:${scopeId}:${nameKey}`;
    try {
      const existingRes = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace, scopeType: $scopeType, scopeId: $scopeId, nameKey: $nameKey})
        RETURN m
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          scopeType,
          scopeId,
          nameKey,
        },
      );
      const existing = existingRes.records[0] ? mapNode(existingRes.records[0]) : null;

      if (existing && (
        existing.content !== input.content ||
        existing.description !== input.description ||
        (resolved.eventTime ?? null) !== (existing.eventTime ?? null) ||
        (resolved.resolvedAt ?? null) !== (existing.resolvedAt ?? null) ||
        (resolved.supersededBy ?? null) !== (existing.supersededBy ?? null)
      )) {
        const versionNoRes = await session.run(
          `MATCH (m:DomFirstMemory {id: $id})-[:HAS_VERSION]->(v:DomFirstVersion) RETURN coalesce(max(v.versionNo), 0) as v`,
          { id: existing.id },
        );
        const versionNo = toNumber(versionNoRes.records[0]?.get("v"), 0) + 1;
        await session.run(
          `
          MATCH (m:DomFirstMemory {id: $id})
          CREATE (v:DomFirstVersion {
            id: $versionId,
            nodeId: m.id,
            versionNo: $versionNo,
            type: m.type,
            name: m.name,
            description: m.description,
            content: m.content,
            scopeType: m.scopeType,
            scopeId: m.scopeId,
            visibility: m.visibility,
            sourceAgentId: m.sourceAgentId,
            sourceSessionId: m.sourceSessionId,
            projectId: m.projectId,
            confidence: m.confidence,
            verificationCount: m.verificationCount,
            promotionState: m.promotionState,
            eventTime: m.eventTime,
            resolvedAt: m.resolvedAt,
            supersededBy: m.supersededBy,
            status: m.status,
            validatedCount: m.validatedCount,
            sourceSessions: m.sourceSessions,
            communityId: m.communityId,
            pagerank: m.pagerank,
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
            capturedAt: $capturedAt,
            supersededAt: $capturedAt,
            reason: 'content-update'
          })
          MERGE (m)-[:HAS_VERSION]->(v)
          `,
          {
            id: existing.id,
            versionId: `${existing.id}:v${versionNo}`,
            versionNo,
            capturedAt: now,
          },
        );
      }

      const sourceSessions = Array.from(new Set([...(existing?.sourceSessions ?? []), ctx.sessionId]));
      const props = {
        id: existing?.id ?? nodeId,
        workspace: this.cfg.backend.neo4j.workspace,
        type: input.type,
        name: nameKey,
        nameKey,
        description: input.description,
        content: input.content,
        scopeType,
        scopeId,
        visibility: resolved.visibility,
        sourceAgentId: resolved.sourceAgentId ?? null,
        sourceSessionId: resolved.sourceSessionId ?? ctx.sessionId,
        projectId: resolved.projectId ?? ctx.projectId ?? null,
        confidence: Math.max(existing?.confidence ?? 0.6, resolved.confidence),
        verificationCount: Math.max(existing?.verificationCount ?? 1, (existing?.verificationCount ?? 1) + 1),
        promotionState: existing?.promotionState === "promoted" ? "promoted" : resolved.promotionState,
        eventTime: resolved.eventTime ?? existing?.eventTime ?? null,
        resolvedAt: resolved.resolvedAt ?? existing?.resolvedAt ?? null,
        supersededBy: resolved.supersededBy ?? existing?.supersededBy ?? null,
        status: existing?.status ?? "active",
        validatedCount: (existing?.validatedCount ?? 0) + 1,
        sourceSessions,
        communityId: existing?.communityId ?? null,
        pagerank: existing?.pagerank ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await session.run(
        `
        MERGE (m:DomFirstMemory {workspace: $workspace, scopeType: $scopeType, scopeId: $scopeId, nameKey: $nameKey})
        SET m = $props
        WITH m
        MERGE (scope:DomFirstScope {workspace: $workspace, scopeType: $scopeType, scopeId: $scopeId})
        MERGE (m)-[:BELONGS_TO_SCOPE]->(scope)
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          scopeType,
          scopeId,
          nameKey,
          props,
        },
      );

      await this.linkLineage(session, props.id, ctx, scopeType, scopeId);
      await this.ingestNodeToGraphiti(props.id, input, scopeType, scopeId);

      return {
        node: {
          id: props.id,
          type: input.type,
          name: props.name,
          description: props.description,
          content: props.content,
          scopeType: props.scopeType,
          scopeId: props.scopeId,
          visibility: props.visibility,
          sourceAgentId: props.sourceAgentId,
          sourceSessionId: props.sourceSessionId,
          projectId: props.projectId,
          confidence: props.confidence,
          verificationCount: props.verificationCount,
          promotionState: props.promotionState,
          eventTime: props.eventTime,
          resolvedAt: props.resolvedAt,
          supersededBy: props.supersededBy,
          status: props.status,
          validatedCount: props.validatedCount,
          sourceSessions: props.sourceSessions,
          communityId: props.communityId,
          pagerank: props.pagerank,
          createdAt: props.createdAt,
          updatedAt: props.updatedAt,
        },
        created: !existing,
      };
    } finally {
      await session.close();
    }
  }

  async upsertEdge(
    input: { fromId: string; toId: string; type: GmEdge["type"]; instruction: string; condition?: string },
    ctx: ScopeContext,
    meta?: Partial<MemoryMetadata>,
  ): Promise<void> {
    await this.ensureReady();
    const resolved = { ...defaultMetadata(ctx, meta?.scopeType ?? "agent"), ...meta };
    const scopeType = resolved.scopeType;
    const scopeId = resolved.scopeId ?? scopeIdFor(ctx, scopeType, this.cfg.teamId);
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const edgeId = `edge:${input.fromId}:${input.toId}:${input.type}`;
      await session.run(
        `
        MATCH (from:DomFirstMemory {id: $fromId}), (to:DomFirstMemory {id: $toId})
        MERGE (from)-[r:DOMFIRST_EDGE {id: $edgeId}]->(to)
        SET r.edgeType = $edgeType,
            r.instruction = $instruction,
            r.condition = $condition,
            r.sessionId = $sessionId,
            r.scopeType = $scopeType,
            r.scopeId = $scopeId,
            r.visibility = $visibility,
            r.sourceAgentId = $sourceAgentId,
            r.projectId = $projectId,
            r.createdAt = coalesce(r.createdAt, $createdAt)
        `,
        {
          fromId: input.fromId,
          toId: input.toId,
          edgeId,
          edgeType: input.type,
          instruction: input.instruction,
          condition: input.condition ?? null,
          sessionId: ctx.sessionId,
          scopeType,
          scopeId,
          visibility: resolved.visibility,
          sourceAgentId: resolved.sourceAgentId ?? null,
          projectId: resolved.projectId ?? ctx.projectId ?? null,
          createdAt: Date.now(),
        },
      );
    } finally {
      await session.close();
    }
  }

  async getSessionNodes(sessionId: string, filters?: ScopeFilter[]) {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const { where, params } = buildScopeClauses(filters);
      const result = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace})
        ${where || "WHERE m.scopeType = 'session' AND m.scopeId = $sessionId"}
        RETURN m
        ORDER BY m.updatedAt DESC
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          sessionId,
          ...params,
        },
      );
      return result.records.map((record) => mapNode(record)).filter((node) => node.scopeType === "session" ? node.scopeId === sessionId : true);
    } finally {
      await session.close();
    }
  }

  async getEdgesForNode(nodeId: string) {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const result = await session.run(
        `
        MATCH (from:DomFirstMemory)-[r:DOMFIRST_EDGE]-(to:DomFirstMemory)
        WHERE from.id = $id OR to.id = $id
        RETURN from, r, to
        `,
        { id: nodeId },
      );
      return result.records.map((record) => mapEdge(record));
    } finally {
      await session.close();
    }
  }

  async stats(filters?: ScopeFilter[]): Promise<ScopedStats> {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const { where, params } = buildScopeClauses(filters);
      const nodes = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace})
        ${where}
        RETURN count(m) as total
        `,
        { workspace: this.cfg.backend.neo4j.workspace, ...params },
      );
      const edges = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace})-[r:DOMFIRST_EDGE]->(n:DomFirstMemory {workspace: $workspace})
        RETURN count(r) as total
        `,
        { workspace: this.cfg.backend.neo4j.workspace },
      );
      return {
        totalNodes: toNumber(nodes.records[0]?.get("total"), 0),
        totalEdges: toNumber(edges.records[0]?.get("total"), 0),
        communities: 0,
      };
    } finally {
      await session.close();
    }
  }

  async findNodeByName(name: string, filters?: ScopeFilter[]) {
    await this.ensureReady();
    const result = await this.inspect(name, filters);
    return result.nodes[0] ?? null;
  }

  async inspect(name: string, filters?: ScopeFilter[]) {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    const nameKey = normalizeName(name);
    try {
      const { where, params } = buildScopeClauses(filters);
      const nodesRes = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace, nameKey: $nameKey})
        ${where}
        RETURN m
        ORDER BY m.updatedAt DESC
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          nameKey,
          ...params,
        },
      );
      const versionsRes = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace, nameKey: $nameKey})-[:HAS_VERSION]->(v:DomFirstVersion)
        ${where}
        RETURN v
        ORDER BY v.versionNo DESC, v.capturedAt DESC
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          nameKey,
          ...params,
        },
      );
      return {
        nodes: nodesRes.records.map((record) => mapNode(record)),
        versions: versionsRes.records.map((record) => mapVersion(record)),
      };
    } finally {
      await session.close();
    }
  }

  async listCandidates(filters?: ScopeFilter[], limit = 20) {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const { where, params } = buildScopeClauses(filters);
      const result = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace})
        ${where ? `${where} AND m.promotionState = 'candidate'` : "WHERE m.promotionState = 'candidate'"}
        RETURN m
        ORDER BY m.updatedAt DESC
        LIMIT $limit
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          limit: neo4j.int(limit),
          ...params,
        },
      );
      return result.records.map((record) => mapNode(record));
    } finally {
      await session.close();
    }
  }

  async markCandidate(nodeId: string): Promise<void> {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      await session.run(
        `MATCH (m:DomFirstMemory {id: $id}) SET m.promotionState='candidate', m.updatedAt=$now`,
        { id: nodeId, now: Date.now() },
      );
    } finally {
      await session.close();
    }
  }

  async promote(name: string, ctx: ScopeContext, explicit = false) {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    const nameKey = normalizeName(name);
    const teamId = ctx.teamId ?? this.cfg.teamId;
    try {
      const sourceRes = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace, nameKey: $nameKey})
        WHERE m.scopeType <> 'team' AND (
          (m.scopeType = 'session' AND m.scopeId = $sessionId) OR
          (m.scopeType = 'agent' AND m.scopeId = $agentId) OR
          (m.scopeType = 'project' AND m.scopeId = $projectId)
        )
        RETURN m
        ORDER BY m.verificationCount DESC, m.updatedAt DESC
        LIMIT 1
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          nameKey,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          projectId: ctx.projectId ?? "",
        },
      );
      if (!sourceRes.records.length) return { promoted: false, reason: "node not found" };
      const source = mapNode(sourceRes.records[0]);
      const verificationCount = explicit ? Math.max(source.verificationCount, 2) : source.verificationCount;
      if (verificationCount < 2) {
        return { promoted: false, reason: "double verification threshold not met" };
      }

      const targetId = `mem:${this.cfg.backend.neo4j.workspace}:team:${teamId}:${nameKey}`;
      await session.run(
        `
        MATCH (source:DomFirstMemory {id: $sourceId})
        MERGE (team:DomFirstMemory {workspace: $workspace, scopeType: 'team', scopeId: $teamId, nameKey: $nameKey})
        SET team.id = $targetId,
            team.type = source.type,
            team.name = source.name,
            team.description = source.description,
            team.content = source.content,
            team.visibility = 'shared',
            team.sourceAgentId = source.sourceAgentId,
            team.sourceSessionId = source.sourceSessionId,
            team.projectId = source.projectId,
            team.confidence = CASE WHEN source.confidence > 0.95 THEN source.confidence ELSE 0.95 END,
            team.verificationCount = CASE WHEN source.verificationCount > 2 THEN source.verificationCount ELSE 2 END,
            team.promotionState = 'promoted',
            team.eventTime = source.eventTime,
            team.resolvedAt = source.resolvedAt,
            team.supersededBy = source.supersededBy,
            team.status = source.status,
            team.validatedCount = source.validatedCount,
            team.sourceSessions = source.sourceSessions,
            team.communityId = source.communityId,
            team.pagerank = source.pagerank,
            team.createdAt = coalesce(team.createdAt, $now),
            team.updatedAt = $now
        MERGE (team)-[:DERIVED_FROM]->(source)
        MERGE (scope:DomFirstScope {workspace: $workspace, scopeType: 'team', scopeId: $teamId})
        MERGE (team)-[:BELONGS_TO_SCOPE]->(scope)
        SET source.promotionState = 'promoted', source.updatedAt = $now
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          sourceId: source.id,
          teamId,
          nameKey,
          targetId,
          now: Date.now(),
        },
      );
      return {
        promoted: true,
        reason: explicit ? "explicit promotion" : "verified candidate",
        source: source.id,
        targetScope: teamId,
      };
    } finally {
      await session.close();
    }
  }

  async lineage(name: string, filters?: ScopeFilter[]) {
    await this.ensureReady();
    const inspect = await this.inspect(name, filters);
    return {
      name,
      nodes: inspect.nodes,
      versions: inspect.versions,
      sources: inspect.nodes.map((node) => ({
        scopeType: node.scopeType,
        scopeId: node.scopeId,
        sourceAgentId: node.sourceAgentId,
        sourceSessionId: node.sourceSessionId,
        projectId: node.projectId,
        promotionState: node.promotionState,
        confidence: node.confidence,
        verificationCount: node.verificationCount,
        status: node.status,
      })),
    };
  }

  async reviewCandidate(name: string, ctx: ScopeContext, action: CandidateReviewAction, targetName?: string) {
    await this.ensureReady();
    if (action === "approve") {
      const result = await this.promote(name, ctx, true);
      return { ok: result.promoted, action, name, reason: result.reason };
    }
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    const nameKey = normalizeName(name);
    try {
      if (action === "reject") {
        await session.run(
          `MATCH (m:DomFirstMemory {workspace: $workspace, nameKey: $nameKey}) SET m.promotionState='private', m.updatedAt=$now`,
          { workspace: this.cfg.backend.neo4j.workspace, nameKey, now: Date.now() },
        );
        return { ok: true, action, name, reason: "candidate reset to private" };
      }
      if (action === "defer") {
        await session.run(
          `MATCH (m:DomFirstMemory {workspace: $workspace, nameKey: $nameKey}) SET m.updatedAt=$now`,
          { workspace: this.cfg.backend.neo4j.workspace, nameKey, now: Date.now() },
        );
        return { ok: true, action, name, reason: "candidate deferred" };
      }
      if (action === "merge-into-existing" && targetName) {
        await session.run(
          `
          MATCH (source:DomFirstMemory {workspace: $workspace, nameKey: $sourceName}), (target:DomFirstMemory {workspace: $workspace, nameKey: $targetName})
          SET source.supersededBy = target.id, source.status = 'superseded', source.updatedAt = $now
          MERGE (source)-[:SUPERSEDED_BY]->(target)
          `,
          {
            workspace: this.cfg.backend.neo4j.workspace,
            sourceName: nameKey,
            targetName: normalizeName(targetName),
            now: Date.now(),
          },
        );
        return { ok: true, action, name, reason: `merged into ${targetName}` };
      }
      return { ok: false, action, name, reason: "unsupported review action" };
    } finally {
      await session.close();
    }
  }

  async audit(filters?: ScopeFilter[]): Promise<AuditFinding[]> {
    await this.ensureReady();
    const session = this.driver.session({ database: this.cfg.backend.neo4j.database });
    try {
      const { where, params } = buildScopeClauses(filters);
      const result = await session.run(
        `
        MATCH (m:DomFirstMemory {workspace: $workspace})
        ${where}
        RETURN m
        `,
        {
          workspace: this.cfg.backend.neo4j.workspace,
          ...params,
        },
      );
      const nodes = result.records.map((record) => mapNode(record));
      const findings: AuditFinding[] = [];
      for (const node of nodes) {
        if (node.promotionState === "promoted" && node.verificationCount < 2) {
          findings.push({
            name: node.name,
            scopeType: node.scopeType,
            scopeId: node.scopeId,
            severity: "high",
            reason: "team memory lacks double verification",
            status: node.status,
            promotionState: node.promotionState,
            confidence: node.confidence,
            verificationCount: node.verificationCount,
          });
        }
        if (node.status === "stale" || node.status === "disputed") {
          findings.push({
            name: node.name,
            scopeType: node.scopeType,
            scopeId: node.scopeId,
            severity: node.status === "disputed" ? "high" : "medium",
            reason: `memory is marked ${node.status}`,
            status: node.status,
            promotionState: node.promotionState,
            confidence: node.confidence,
            verificationCount: node.verificationCount,
          });
        }
        if (node.promotionState === "candidate" && node.confidence < 0.7) {
          findings.push({
            name: node.name,
            scopeType: node.scopeType,
            scopeId: node.scopeId,
            severity: "low",
            reason: "candidate confidence is low",
            status: node.status,
            promotionState: node.promotionState,
            confidence: node.confidence,
            verificationCount: node.verificationCount,
          });
        }
      }
      return findings;
    } finally {
      await session.close();
    }
  }

  private async linkLineage(session: Session, nodeId: string, ctx: ScopeContext, scopeType: ScopeType, scopeId: string): Promise<void> {
    await session.run(
      `
      MATCH (m:DomFirstMemory {id: $nodeId})
      MERGE (sessionNode:DomFirstSession {workspace: $workspace, sessionId: $sessionId})
      MERGE (m)-[:MENTIONED_IN]->(sessionNode)
      MERGE (agentNode:DomFirstAgent {workspace: $workspace, agentId: $agentId})
      MERGE (m)-[:DERIVED_FROM_AGENT]->(agentNode)
      FOREACH (_ IN CASE WHEN $projectId <> '' THEN [1] ELSE [] END |
        MERGE (projectNode:DomFirstProject {workspace: $workspace, projectId: $projectId})
        MERGE (m)-[:BELONGS_TO_PROJECT]->(projectNode)
      )
      FOREACH (_ IN CASE WHEN $teamId <> '' THEN [1] ELSE [] END |
        MERGE (teamNode:DomFirstTeam {workspace: $workspace, teamId: $teamId})
        MERGE (m)-[:SHARED_TO]->(teamNode)
      )
      `,
      {
        workspace: this.cfg.backend.neo4j.workspace,
        nodeId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        projectId: ctx.projectId ?? "",
        teamId: scopeType === "team" ? scopeId : (ctx.teamId ?? ""),
      },
    );
  }

  private async ingestNodeToGraphiti(
    nodeId: string,
    input: { type: GmNode["type"]; name: string; description: string; content: string },
    scopeType: ScopeType,
    scopeId: string,
  ): Promise<void> {
    try {
      await this.graphiti.addMessages(groupIdFor(this.cfg, scopeType, scopeId), [{
        uuid: nodeId,
        name: input.name,
        role: "system",
        role_type: "memory",
        content: `[${input.type}] ${input.name}\n${input.description}\n${input.content}`,
        timestamp: new Date().toISOString(),
        source_description: `domfirst:${scopeType}`,
      }]);
    } catch {
      // Neo4j remains the source of truth; Graphiti sync is best-effort.
    }
  }
}

function dedupeNodes(nodes: GmNode[]): GmNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = `${node.scopeType}:${node.scopeId}:${node.name}:${node.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function estimateTokens(nodes: GmNode[]): number {
  return Math.ceil(nodes.reduce((sum, node) => sum + node.content.length + node.description.length, 0) / 3);
}

function compactName(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.slice(0, 64) || "memory-fact";
}

function buildFullTextQuery(text: string): string {
  const cleaned = text
    .split(/\s+/)
    .map((token) => token.replace(/[+\-!(){}\[\]^"~*?:\\/]/g, "").trim())
    .filter(Boolean);
  if (!cleaned.length) {
    const fallback = text.replace(/[+\-!(){}\[\]^"~*?:\\/]/g, " ").trim();
    return fallback ? `"${fallback}"` : "\"memory\"";
  }
  return cleaned.map((token) => `"${token}"`).join(" OR ");
}

function parseGraphitiDate(raw?: string | null): number | null {
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function matchesTime(ts: number | null | undefined, plan: RecallPlan): boolean {
  if (!plan.timeRange || ts == null) return true;
  if (plan.timeRange.start !== undefined && ts < plan.timeRange.start) return false;
  if (plan.timeRange.end !== undefined && ts >= plan.timeRange.end) return false;
  return true;
}

function buildTimeline(versions: GmNodeVersion[]): NonNullable<RecallResult["timeline"]> {
  const groups = new Map<string, NonNullable<RecallResult["timeline"]>[number]>();
  for (const version of versions) {
    if (!groups.has(version.name)) {
      groups.set(version.name, { name: version.name, versions: [] });
    }
    groups.get(version.name)!.versions.push({
      id: version.id,
      nodeId: version.nodeId,
      versionNo: version.versionNo,
      content: version.content,
      description: version.description,
      capturedAt: version.capturedAt,
      supersededAt: version.supersededAt,
      timelineLabel: version.timelineLabel ?? `v${version.versionNo}`,
    });
  }
  return [...groups.values()].map((item) => ({
    ...item,
    versions: item.versions.sort((a, b) => a.versionNo - b.versionNo),
  }));
}

function buildTimelineSummary(timeline?: RecallResult["timeline"]): string {
  if (!timeline?.length) return "";
  return timeline.slice(0, 3).map((item) => {
    if (item.versions.length === 1) {
      return `${item.name}: ${item.versions[0].description || item.versions[0].content.slice(0, 72)}`;
    }
    const first = item.versions[0];
    const last = item.versions[item.versions.length - 1];
    return `${item.name}: ${first.description || first.content.slice(0, 40)} -> ${last.description || last.content.slice(0, 40)}`;
  }).join("\n");
}

async function ensureNeo4jSchema(driver: Driver, cfg: GmConfig): Promise<void> {
  const session = driver.session({ database: cfg.backend.neo4j.database });
  try {
    const statements = [
      "CREATE CONSTRAINT domfirst_memory_id IF NOT EXISTS FOR (m:DomFirstMemory) REQUIRE m.id IS UNIQUE",
      "CREATE CONSTRAINT domfirst_version_id IF NOT EXISTS FOR (v:DomFirstVersion) REQUIRE v.id IS UNIQUE",
      "CREATE INDEX domfirst_memory_scope IF NOT EXISTS FOR (m:DomFirstMemory) ON (m.workspace, m.scopeType, m.scopeId)",
      "CREATE INDEX domfirst_memory_name IF NOT EXISTS FOR (m:DomFirstMemory) ON (m.workspace, m.nameKey)",
      "CREATE INDEX domfirst_memory_promotion IF NOT EXISTS FOR (m:DomFirstMemory) ON (m.workspace, m.promotionState)",
      "CREATE INDEX domfirst_version_node IF NOT EXISTS FOR (v:DomFirstVersion) ON (v.nodeId, v.versionNo)",
      "CREATE INDEX domfirst_session_id IF NOT EXISTS FOR (s:DomFirstSession) ON (s.workspace, s.sessionId)",
      "CREATE INDEX domfirst_agent_id IF NOT EXISTS FOR (a:DomFirstAgent) ON (a.workspace, a.agentId)",
      "CREATE INDEX domfirst_project_id IF NOT EXISTS FOR (p:DomFirstProject) ON (p.workspace, p.projectId)",
      "CREATE INDEX domfirst_team_id IF NOT EXISTS FOR (t:DomFirstTeam) ON (t.workspace, t.teamId)",
      `CREATE FULLTEXT INDEX ${MEMORY_TEXT_INDEX} IF NOT EXISTS FOR (m:DomFirstMemory) ON EACH [m.name, m.description, m.content]`,
    ];
    for (const statement of statements) {
      await session.run(statement);
    }
  } finally {
    await session.close();
  }
}

export function createGraphitiNeo4jRuntime(db: DatabaseSyncInstance, cfg: GmConfig): BackendRuntime {
  const driver = neo4j.driver(
    cfg.backend.neo4j.uri,
    neo4j.auth.basic(cfg.backend.neo4j.username, cfg.backend.neo4j.password),
  );
  const graphiti = new GraphitiClient(cfg.backend.graphiti.baseUrl, cfg.backend.graphiti.timeoutMs);
  let readyPromise: Promise<void> | null = null;

  const ensureReady = async (): Promise<void> => {
    if (!readyPromise) {
      readyPromise = (async () => {
        await driver.verifyConnectivity();
        await ensureNeo4jSchema(driver, cfg);
      })().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    await readyPromise;
  };

  return {
    config: cfg,
    graphStore: new GraphitiNeo4jGraphStore(driver, graphiti, cfg, ensureReady),
    messageStore: new SQLiteMessageStore(db),
    recallBackend: new GraphitiNeo4jRecallBackend(driver, graphiti, cfg, ensureReady),
    async initialize() {
      await ensureReady();
    },
    async health() {
      const graphitiHealth = await graphiti.health().catch((error) => ({ status: "error", detail: String(error) }));
      try {
        await ensureReady();
        return {
          backend: "graphiti-neo4j",
          status: graphitiHealth.status === "error" ? "degraded" : "ok",
          neo4j: "ok",
          graphiti: graphitiHealth.status,
          schemaReady: true,
          workspace: cfg.backend.neo4j.workspace,
          graphitiBaseUrl: cfg.backend.graphiti.baseUrl,
          neo4jUri: cfg.backend.neo4j.uri,
          graphitiDetail: "detail" in graphitiHealth ? graphitiHealth.detail : undefined,
        };
      } catch (error) {
        return {
          backend: "graphiti-neo4j",
          status: "error",
          neo4j: "error",
          neo4jError: String(error),
          graphiti: graphitiHealth.status,
          schemaReady: false,
          workspace: cfg.backend.neo4j.workspace,
          graphitiBaseUrl: cfg.backend.graphiti.baseUrl,
          neo4jUri: cfg.backend.neo4j.uri,
          graphitiDetail: "detail" in graphitiHealth ? graphitiHealth.detail : undefined,
        };
      }
    },
    async dispose() {
      await driver.close();
    },
  };
}
