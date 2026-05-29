import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { EmbedFn } from "../engine/embed.ts";
import type { GmConfig, GmNode, MemoryMetadata, ScopeContext, ScopeFilter } from "../types.ts";
import type {
  BackendRuntime,
  MemoryGraphStore,
  MessageStore,
  RecallBackend,
  ScopedStats,
} from "./types.ts";
import {
  edgesFrom,
  edgesTo,
  findByName,
  getCommunitySummary,
  getEpisodicMessages,
  getMessages,
  getNodeVersions,
  getStats,
  getUnextracted,
  listByName,
  listPromotionCandidates,
  markExtracted,
  saveMessage,
} from "../store/store.ts";
import { DomFirstRecaller } from "../domfirst/recaller.ts";
import {
  findScopedNodeByName,
  getScopedSessionNodes,
  getScopedStats,
  inspectScopedMemoryByName,
  listScopedPromotionCandidates,
  upsertScopedEdge,
  upsertScopedNode,
} from "../domfirst/store.ts";
import { buildScopeFilters, matchesScopeFilters } from "../domfirst/scope.ts";
import { markPromotionCandidate, maybePromoteToTeam } from "../domfirst/promotion.ts";

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

class SQLiteRecallBackend implements RecallBackend {
  private recaller: DomFirstRecaller;

  constructor(db: DatabaseSyncInstance, cfg: GmConfig) {
    this.recaller = new DomFirstRecaller(db, cfg);
  }

  setEmbedFn(fn: EmbedFn | null): void {
    if (fn) {
      this.recaller.setEmbedFn(fn);
      return;
    }
    this.recaller.setEmbedFn(null as unknown as EmbedFn);
  }

  recall(query: string, plan: any) {
    return this.recaller.recall(query, plan);
  }
}

class SQLiteGraphStore implements MemoryGraphStore {
  constructor(private db: DatabaseSyncInstance) {}

  async upsertNode(
    input: { type: GmNode["type"]; name: string; description: string; content: string },
    ctx: ScopeContext,
    meta?: Partial<MemoryMetadata>,
  ) {
    const result = upsertScopedNode(this.db, input, ctx, meta);
    return { node: result.node, created: result.isNew };
  }

  async upsertEdge(
    input: { fromId: string; toId: string; type: any; instruction: string; condition?: string },
    ctx: ScopeContext,
    meta?: Partial<MemoryMetadata>,
  ): Promise<void> {
    upsertScopedEdge(this.db, input, ctx, meta);
  }

  async getSessionNodes(sessionId: string, filters?: ScopeFilter[]) {
    return getScopedSessionNodes(this.db, sessionId, filters);
  }

  async getEdgesForNode(nodeId: string) {
    return [...edgesFrom(this.db, nodeId), ...edgesTo(this.db, nodeId)];
  }

  async stats(filters?: ScopeFilter[]): Promise<ScopedStats> {
    return getScopedStats(this.db, filters);
  }

  async findNodeByName(name: string, filters?: ScopeFilter[]) {
    return findScopedNodeByName(this.db, name, filters);
  }

  async inspect(name: string, filters?: ScopeFilter[]) {
    return inspectScopedMemoryByName(this.db, name, filters);
  }

  async listCandidates(filters?: ScopeFilter[], limit = 20) {
    return listScopedPromotionCandidates(this.db, filters, limit);
  }

  async markCandidate(nodeId: string): Promise<void> {
    markPromotionCandidate(this.db, nodeId);
  }

  async promote(name: string, ctx: ScopeContext, explicit = false) {
    const node = findScopedNodeByName(this.db, name, buildScopeFilters(ctx, false));
    if (!node) return { promoted: false, reason: "node not found" };
    if (explicit) {
      this.db.prepare(`
        UPDATE gm_nodes
        SET promotion_state='candidate',
            verification_count = MAX(verification_count, 2),
            confidence = MAX(confidence, 0.95),
            updated_at = ?
        WHERE id = ?
      `).run(Date.now(), node.id);
    } else {
      markPromotionCandidate(this.db, node.id);
    }
    const refreshed = findScopedNodeByName(this.db, name, buildScopeFilters(ctx, false));
    if (!refreshed) return { promoted: false, reason: "node disappeared" };
    return maybePromoteToTeam(this.db, refreshed, ctx, explicit ? "explicit promotion" : "verified candidate");
  }

  async lineage(name: string, filters?: ScopeFilter[]) {
    const nodes = listByName(this.db, name, filters);
    const versions = getNodeVersions(this.db, name, filters);
    return {
      name,
      nodes,
      versions,
      sources: nodes.map((node) => ({
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

  async reviewCandidate(name: string, ctx: ScopeContext, action: any, targetName?: string) {
    const node = findScopedNodeByName(this.db, name, buildScopeFilters(ctx, true));
    if (!node) {
      return { ok: false, action, name, reason: "candidate not found" };
    }
    if (action === "approve") {
      const promoted = await this.promote(name, ctx, true);
      return { ok: promoted.promoted, action, name, reason: promoted.reason };
    }
    if (action === "reject") {
      this.db.prepare("UPDATE gm_nodes SET promotion_state='private', updated_at=? WHERE id=?").run(Date.now(), node.id);
      return { ok: true, action, name, reason: "candidate reset to private" };
    }
    if (action === "defer") {
      this.db.prepare("UPDATE gm_nodes SET updated_at=? WHERE id=?").run(Date.now(), node.id);
      return { ok: true, action, name, reason: "candidate deferred" };
    }
    if (action === "merge-into-existing" && targetName) {
      const target = findByName(this.db, targetName, buildScopeFilters(ctx, true));
      if (!target) return { ok: false, action, name, reason: "merge target not found" };
      this.db.prepare("UPDATE gm_nodes SET superseded_by=?, status='deprecated', updated_at=? WHERE id=?")
        .run(target.id, Date.now(), node.id);
      return { ok: true, action, name, reason: `merged into ${target.name}` };
    }
    return { ok: false, action, name, reason: "unsupported review action" };
  }

  async audit(filters?: ScopeFilter[]) {
    const rows = (this.db.prepare("SELECT * FROM gm_nodes WHERE status='active'").all() as any[])
      .map((row) => row as GmNode)
      .filter((row) => matchesScopeFilters(row, filters));
    const findings = [];
    for (const row of rows) {
      if (row.promotionState === "promoted" && row.verificationCount < 2) {
        findings.push({
          name: row.name,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          severity: "high" as const,
          reason: "team memory lacks double verification",
          status: row.status,
          promotionState: row.promotionState,
          confidence: row.confidence,
          verificationCount: row.verificationCount,
        });
      }
      if (row.promotionState === "candidate" && row.confidence < 0.7) {
        findings.push({
          name: row.name,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          severity: "medium" as const,
          reason: "candidate confidence is low",
          status: row.status,
          promotionState: row.promotionState,
          confidence: row.confidence,
          verificationCount: row.verificationCount,
        });
      }
    }
    return findings;
  }
}

export function createSQLiteRuntime(db: DatabaseSyncInstance, cfg: GmConfig): BackendRuntime {
  return {
    config: cfg,
    graphStore: new SQLiteGraphStore(db),
    messageStore: new SQLiteMessageStore(db),
    recallBackend: new SQLiteRecallBackend(db, cfg),
    async initialize() {
      // SQLite compatibility mode is already ready after local DB open/migration.
    },
    async health() {
      const base = getStats(db);
      return {
        backend: "sqlite",
        status: "ok",
        totalNodes: base.totalNodes,
        totalEdges: base.totalEdges,
        communities: base.communities,
        hasCommunitySummaries: Boolean(getCommunitySummary(db, "missing") === null),
      };
    },
  };
}
