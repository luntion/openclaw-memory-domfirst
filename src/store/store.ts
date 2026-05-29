/**
 * graph-memory core store, adapted for openclaw-memory-hybrid.
 */

import { createHash } from "crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type {
  GmNode,
  GmEdge,
  GmNodeVersion,
  EdgeType,
  NodeType,
  Signal,
  ScopeFilter,
  MemoryMetadata,
  ScopeType,
} from "../types.ts";
import { matchesScopeFilters } from "../hybrid/scope.ts";

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function toNode(row: any): GmNode {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description ?? "",
    content: row.content,
    scopeType: row.scope_type ?? "agent",
    scopeId: row.scope_id ?? "default",
    visibility: row.visibility ?? "private",
    sourceAgentId: row.source_agent_id ?? null,
    sourceSessionId: row.source_session_id ?? null,
    projectId: row.project_id ?? null,
    confidence: row.confidence ?? 0.6,
    verificationCount: row.verification_count ?? 1,
    promotionState: row.promotion_state ?? "private",
    eventTime: row.event_time ?? null,
    resolvedAt: row.resolved_at ?? null,
    supersededBy: row.superseded_by ?? null,
    status: row.status,
    validatedCount: row.validated_count,
    sourceSessions: JSON.parse(row.source_sessions ?? "[]"),
    communityId: row.community_id ?? null,
    pagerank: row.pagerank ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEdge(row: any): GmEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type,
    instruction: row.instruction,
    condition: row.condition ?? undefined,
    sessionId: row.session_id,
    scopeType: row.scope_type ?? "agent",
    scopeId: row.scope_id ?? "default",
    visibility: row.visibility ?? "private",
    sourceAgentId: row.source_agent_id ?? null,
    projectId: row.project_id ?? null,
    createdAt: row.created_at,
  };
}

function toNodeVersion(row: any): GmNodeVersion {
  return {
    ...toNode(row),
    nodeId: row.node_id,
    capturedAt: row.captured_at,
    supersededAt: row.superseded_at ?? null,
    versionNo: row.version_no,
    reason: row.reason ?? "superseded",
  };
}

function defaultMeta(sessionId: string): MemoryMetadata {
  return {
    scopeType: "agent",
    scopeId: "agent-default",
    visibility: "private",
    sourceAgentId: null,
    sourceSessionId: sessionId,
    projectId: null,
    confidence: 0.65,
    verificationCount: 1,
    promotionState: "private",
    eventTime: null,
    resolvedAt: null,
    supersededBy: null,
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export function findByName(
  db: DatabaseSyncInstance,
  name: string,
  filters?: ScopeFilter[],
): GmNode | null {
  const rows = db.prepare("SELECT * FROM gm_nodes WHERE name = ? AND status='active'").all(normalizeName(name)) as any[];
  return rows.map(toNode).find((row) => matchesScopeFilters(row, filters)) ?? null;
}

export function listByName(
  db: DatabaseSyncInstance,
  name: string,
  filters?: ScopeFilter[],
): GmNode[] {
  const rows = db.prepare("SELECT * FROM gm_nodes WHERE name = ? AND status='active' ORDER BY updated_at DESC").all(normalizeName(name)) as any[];
  return rows.map(toNode).filter((row) => matchesScopeFilters(row, filters));
}

export function findById(db: DatabaseSyncInstance, id: string): GmNode | null {
  const row = db.prepare("SELECT * FROM gm_nodes WHERE id = ?").get(id) as any;
  return row ? toNode(row) : null;
}

export function allActiveNodes(db: DatabaseSyncInstance): GmNode[] {
  return (db.prepare("SELECT * FROM gm_nodes WHERE status='active'").all() as any[]).map(toNode);
}

export function allEdges(db: DatabaseSyncInstance): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges").all() as any[]).map(toEdge);
}

export function upsertNode(
  db: DatabaseSyncInstance,
  candidate: { type: NodeType; name: string; description: string; content: string },
  sessionId: string,
  meta?: Partial<MemoryMetadata>,
): { node: GmNode; isNew: boolean } {
  const resolvedMeta = { ...defaultMeta(sessionId), ...meta };
  const name = normalizeName(candidate.name);
  const existing = findByName(db, name, [{ scopeType: resolvedMeta.scopeType, scopeIds: [resolvedMeta.scopeId] }]);

  if (existing) {
    if (
      existing.content !== candidate.content ||
      existing.description !== candidate.description ||
      (resolvedMeta.eventTime ?? null) !== (existing.eventTime ?? null) ||
      (resolvedMeta.resolvedAt ?? null) !== (existing.resolvedAt ?? null) ||
      (resolvedMeta.supersededBy ?? null) !== (existing.supersededBy ?? null)
    ) {
      snapshotNodeVersion(db, existing.id, "content-update");
    }

    const sessions = JSON.stringify(Array.from(new Set([...existing.sourceSessions, sessionId])));
    const content = candidate.content;
    const description = candidate.description;
    const validatedCount = existing.validatedCount + 1;
    const confidence = Math.max(existing.confidence, resolvedMeta.confidence);
    const verificationCount = Math.max(existing.verificationCount, (existing.verificationCount ?? 1) + 1);

    db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
      source_sessions=?, confidence=?, verification_count=?, promotion_state=?, event_time=?, resolved_at=?, superseded_by=?, updated_at=? WHERE id=?`)
      .run(
        content,
        description,
        validatedCount,
        sessions,
        confidence,
        verificationCount,
        existing.promotionState === "promoted" ? "promoted" : resolvedMeta.promotionState,
        resolvedMeta.eventTime ?? existing.eventTime ?? null,
        resolvedMeta.resolvedAt ?? existing.resolvedAt ?? null,
        resolvedMeta.supersededBy ?? existing.supersededBy ?? null,
        Date.now(),
        existing.id,
      );

    return {
      node: {
        ...existing,
        content,
        description,
        validatedCount,
        confidence,
        verificationCount,
        eventTime: resolvedMeta.eventTime ?? existing.eventTime ?? null,
        resolvedAt: resolvedMeta.resolvedAt ?? existing.resolvedAt ?? null,
        supersededBy: resolvedMeta.supersededBy ?? existing.supersededBy ?? null,
      },
      isNew: false,
    };
  }

  const id = uid("n");
  db.prepare(`INSERT INTO gm_nodes
    (id, type, name, description, content, scope_type, scope_id, visibility, source_agent_id, source_session_id,
     project_id, confidence, verification_count, promotion_state, event_time, resolved_at, superseded_by,
     status, validated_count, source_sessions, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?,?)`)
    .run(
      id,
      candidate.type,
      name,
      candidate.description,
      candidate.content,
      resolvedMeta.scopeType,
      resolvedMeta.scopeId,
      resolvedMeta.visibility,
      resolvedMeta.sourceAgentId,
      resolvedMeta.sourceSessionId,
      resolvedMeta.projectId,
      resolvedMeta.confidence,
      resolvedMeta.verificationCount,
      resolvedMeta.promotionState,
      resolvedMeta.eventTime,
      resolvedMeta.resolvedAt,
      resolvedMeta.supersededBy,
      JSON.stringify([sessionId]),
      Date.now(),
      Date.now(),
    );

  return {
    node: findByName(db, name, [{ scopeType: resolvedMeta.scopeType, scopeIds: [resolvedMeta.scopeId] }])!,
    isNew: true,
  };
}

export function snapshotNodeVersion(
  db: DatabaseSyncInstance,
  nodeId: string,
  reason = "superseded",
): void {
  const node = findById(db, nodeId);
  if (!node) return;
  const row = db.prepare("SELECT COALESCE(MAX(version_no), 0) as v FROM gm_node_versions WHERE node_id=?").get(nodeId) as any;
  const versionNo = Number(row?.v ?? 0) + 1;
  db.prepare(`
    INSERT INTO gm_node_versions (
      id, node_id, version_no, type, name, description, content, scope_type, scope_id, visibility,
      source_agent_id, source_session_id, project_id, confidence, verification_count, promotion_state,
      event_time, resolved_at, superseded_by, status, validated_count, source_sessions, community_id,
      pagerank, created_at, updated_at, captured_at, superseded_at, reason
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid("nv"),
    node.id,
    versionNo,
    node.type,
    node.name,
    node.description,
    node.content,
    node.scopeType,
    node.scopeId,
    node.visibility,
    node.sourceAgentId,
    node.sourceSessionId,
    node.projectId,
    node.confidence,
    node.verificationCount,
    node.promotionState,
    node.eventTime,
    node.resolvedAt,
    node.supersededBy,
    node.status,
    node.validatedCount,
    JSON.stringify(node.sourceSessions),
    node.communityId,
    node.pagerank,
    node.createdAt,
    node.updatedAt,
    Date.now(),
    Date.now(),
    reason,
  );
}

export function getNodeVersions(
  db: DatabaseSyncInstance,
  name: string,
  filters?: ScopeFilter[],
): GmNodeVersion[] {
  const rows = db.prepare(`
    SELECT * FROM gm_node_versions
    WHERE name = ?
    ORDER BY version_no DESC, captured_at DESC
  `).all(normalizeName(name)) as any[];
  return rows.map(toNodeVersion).filter((row) => matchesScopeFilters(row, filters));
}

export function listPromotionCandidates(
  db: DatabaseSyncInstance,
  filters?: ScopeFilter[],
  limit = 20,
): GmNode[] {
  const rows = db.prepare(`
    SELECT * FROM gm_nodes
    WHERE status='active' AND promotion_state='candidate'
    ORDER BY updated_at DESC, verification_count DESC, confidence DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(toNode).filter((row) => matchesScopeFilters(row, filters));
}

export function searchNodeVersions(
  db: DatabaseSyncInstance,
  query: string,
  filters?: ScopeFilter[],
  limit = 10,
): GmNodeVersion[] {
  const terms = extractVersionQueryTerms(query);
  const rows = db.prepare(`
    SELECT * FROM gm_node_versions
    ORDER BY captured_at DESC, version_no DESC
  `).all() as any[];
  const versions = rows.map(toNodeVersion).filter((row) => matchesScopeFilters(row, filters));
  if (!terms.length) return versions.slice(0, limit);
  return versions
    .filter((version) => {
      const haystack = `${version.name}\n${version.description}\n${version.content}`.toLowerCase();
      return terms.some((term) => haystack.includes(term) || version.name === normalizeName(term));
    })
    .slice(0, limit);
}

function extractVersionQueryTerms(query: string): string[] {
  const stopWords = new Set([
    "之前", "上次", "昨天", "当时", "后来", "怎么", "如何", "是什么", "什么", "做的",
    "那个", "我们", "遇到", "过", "了", "吗", "来着", "对吧", "是不是",
    "the", "was", "did", "how", "what", "before", "past", "previous", "earlier",
  ]);

  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/[?？！!,.，。:：;；"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const whitespaceTerms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => !stopWords.has(term));

  const tokenTerms = (normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])
    .map((term) => normalizeName(term))
    .filter(Boolean)
    .filter((term) => !stopWords.has(term));

  return Array.from(new Set([...whitespaceTerms, ...tokenTerms])).slice(0, 12);
}

export function deprecate(db: DatabaseSyncInstance, nodeId: string): void {
  db.prepare("UPDATE gm_nodes SET status='deprecated', updated_at=? WHERE id=?")
    .run(Date.now(), nodeId);
}

export function mergeNodes(db: DatabaseSyncInstance, keepId: string, mergeId: string): void {
  const keep = findById(db, keepId);
  const merge = findById(db, mergeId);
  if (!keep || !merge) return;

  const sessions = JSON.stringify(Array.from(new Set([...keep.sourceSessions, ...merge.sourceSessions])));
  const count = keep.validatedCount + merge.validatedCount;
  const content = keep.content.length >= merge.content.length ? keep.content : merge.content;
  const description = keep.description.length >= merge.description.length ? keep.description : merge.description;

  db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
    source_sessions=?, updated_at=? WHERE id=?`)
    .run(content, description, count, sessions, Date.now(), keepId);

  db.prepare("UPDATE gm_edges SET from_id=? WHERE from_id=?").run(keepId, mergeId);
  db.prepare("UPDATE gm_edges SET to_id=? WHERE to_id=?").run(keepId, mergeId);
  db.prepare("DELETE FROM gm_edges WHERE from_id = to_id").run();
  db.prepare(`
    DELETE FROM gm_edges WHERE id NOT IN (
      SELECT MIN(id) FROM gm_edges GROUP BY from_id, to_id, type
    )
  `).run();

  deprecate(db, mergeId);
}

export function updatePageranks(db: DatabaseSyncInstance, scores: Map<string, number>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET pagerank=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const [id, score] of scores) {
      stmt.run(score, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateCommunities(db: DatabaseSyncInstance, labels: Map<string, string>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET community_id=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const [id, cid] of labels) {
      stmt.run(cid, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function upsertEdge(
  db: DatabaseSyncInstance,
  edge: {
    fromId: string;
    toId: string;
    type: EdgeType;
    instruction: string;
    condition?: string;
    sessionId: string;
    scopeType?: ScopeType;
    scopeId?: string;
    visibility?: "private" | "shared" | "inherited";
    sourceAgentId?: string | null;
    projectId?: string | null;
  },
): void {
  const existing = db.prepare("SELECT id FROM gm_edges WHERE from_id=? AND to_id=? AND type=?")
    .get(edge.fromId, edge.toId, edge.type) as any;
  if (existing) {
    db.prepare("UPDATE gm_edges SET instruction=? WHERE id=?").run(edge.instruction, existing.id);
    return;
  }

  db.prepare(`INSERT INTO gm_edges
    (id, from_id, to_id, type, instruction, condition, session_id, scope_type, scope_id, visibility, source_agent_id, project_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      uid("e"),
      edge.fromId,
      edge.toId,
      edge.type,
      edge.instruction,
      edge.condition ?? null,
      edge.sessionId,
      edge.scopeType ?? "agent",
      edge.scopeId ?? "agent-default",
      edge.visibility ?? "private",
      edge.sourceAgentId ?? null,
      edge.projectId ?? null,
      Date.now(),
    );
}

export function edgesFrom(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE from_id=?").all(id) as any[]).map(toEdge);
}

export function edgesTo(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE to_id=?").all(id) as any[]).map(toEdge);
}

let fts5Availability: boolean | null = null;

function fts5Available(db: DatabaseSyncInstance): boolean {
  if (fts5Availability !== null) return fts5Availability;
  try {
    db.prepare("SELECT * FROM gm_nodes_fts LIMIT 0").all();
    fts5Availability = true;
  } catch {
    fts5Availability = false;
  }
  return fts5Availability;
}

export function searchNodes(db: DatabaseSyncInstance, query: string, limit = 6): GmNode[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return topNodes(db, limit);

  if (fts5Available(db)) {
    try {
      const ftsQuery = terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
      const rows = db.prepare(`
        SELECT n.*, rank FROM gm_nodes_fts fts
        JOIN gm_nodes n ON n.rowid = fts.rowid
        WHERE gm_nodes_fts MATCH ? AND n.status = 'active'
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit) as any[];
      if (rows.length > 0) return rows.map(toNode);
    } catch {
      // Fall through to LIKE search.
    }
  }

  const where = terms.map(() => "(name LIKE ? OR description LIKE ? OR content LIKE ?)").join(" OR ");
  const likes = terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]);
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active' AND (${where})
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(...likes, limit) as any[]).map(toNode);
}

export function topNodes(db: DatabaseSyncInstance, limit = 6): GmNode[] {
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active'
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(limit) as any[]).map(toNode);
}

export function graphWalk(
  db: DatabaseSyncInstance,
  seedIds: string[],
  maxDepth: number,
): { nodes: GmNode[]; edges: GmEdge[] } {
  if (!seedIds.length) return { nodes: [], edges: [] };

  const placeholders = seedIds.map(() => "?").join(",");
  const walkRows = db.prepare(`
    WITH RECURSIVE walk(node_id, depth) AS (
      SELECT id, 0 FROM gm_nodes WHERE id IN (${placeholders}) AND status='active'
      UNION
      SELECT
        CASE WHEN e.from_id = w.node_id THEN e.to_id ELSE e.from_id END,
        w.depth + 1
      FROM walk w
      JOIN gm_edges e ON (e.from_id = w.node_id OR e.to_id = w.node_id)
      WHERE w.depth < ?
    )
    SELECT DISTINCT node_id FROM walk
  `).all(...seedIds, maxDepth) as any[];

  const nodeIds = walkRows.map((row: any) => row.node_id);
  if (!nodeIds.length) return { nodes: [], edges: [] };

  const nodePlaceholders = nodeIds.map(() => "?").join(",");
  const nodes = (db.prepare(`
    SELECT * FROM gm_nodes WHERE id IN (${nodePlaceholders}) AND status='active'
  `).all(...nodeIds) as any[]).map(toNode);

  const edges = (db.prepare(`
    SELECT * FROM gm_edges WHERE from_id IN (${nodePlaceholders}) AND to_id IN (${nodePlaceholders})
  `).all(...nodeIds, ...nodeIds) as any[]).map(toEdge);

  return { nodes, edges };
}

export function getBySession(db: DatabaseSyncInstance, sessionId: string): GmNode[] {
  return (db.prepare(`
    SELECT DISTINCT n.* FROM gm_nodes n, json_each(n.source_sessions) j
    WHERE j.value = ? AND n.status = 'active'
  `).all(sessionId) as any[]).map(toNode);
}

export function saveMessage(
  db: DatabaseSyncInstance,
  sessionId: string,
  turn: number,
  role: string,
  content: unknown,
): void {
  db.prepare(`INSERT OR IGNORE INTO gm_messages (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("m"), sessionId, turn, role, JSON.stringify(content), Date.now());
}

export function getMessages(db: DatabaseSyncInstance, sessionId: string, limit?: number): any[] {
  if (limit) {
    return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index DESC LIMIT ?")
      .all(sessionId, limit) as any[];
  }
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index")
    .all(sessionId) as any[];
}

export function getUnextracted(db: DatabaseSyncInstance, sessionId: string, limit: number): any[] {
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? AND extracted=0 ORDER BY turn_index LIMIT ?")
    .all(sessionId, limit) as any[];
}

export function markExtracted(db: DatabaseSyncInstance, sessionId: string, upToTurn: number): void {
  db.prepare("UPDATE gm_messages SET extracted=1 WHERE session_id=? AND turn_index<=?")
    .run(sessionId, upToTurn);
}

export function getEpisodicMessages(
  db: DatabaseSyncInstance,
  sessionIds: string[],
  nearTime: number,
  maxChars = 1500,
): Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> {
  if (!sessionIds.length) return [];

  const results: Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> = [];
  let usedChars = 0;

  for (const sessionId of sessionIds) {
    if (usedChars >= maxChars) break;

    const rows = db.prepare(`
      SELECT turn_index, role, content, created_at FROM gm_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY ABS(created_at - ?) ASC
      LIMIT 6
    `).all(sessionId, nearTime) as any[];

    for (const row of rows) {
      if (usedChars >= maxChars) break;
      let text = "";
      try {
        const parsed = JSON.parse(row.content);
        if (typeof parsed === "string") {
          text = parsed;
        } else if (typeof parsed?.content === "string") {
          text = parsed.content;
        } else if (Array.isArray(parsed)) {
          text = parsed
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text ?? "")
            .join("\n");
        } else {
          text = String(parsed).slice(0, 300);
        }
      } catch {
        text = String(row.content).slice(0, 300);
      }

      if (!text.trim()) continue;
      const truncated = text.slice(0, Math.min(text.length, maxChars - usedChars));
      results.push({
        sessionId,
        turnIndex: row.turn_index,
        role: row.role,
        text: truncated,
        createdAt: row.created_at,
      });
      usedChars += truncated.length;
    }
  }

  return results;
}

export function saveSignal(db: DatabaseSyncInstance, sessionId: string, signal: Signal): void {
  db.prepare(`INSERT INTO gm_signals (id, session_id, turn_index, type, data, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("s"), sessionId, signal.turnIndex, signal.type, JSON.stringify(signal.data), Date.now());
}

export function pendingSignals(db: DatabaseSyncInstance, sessionId: string): Signal[] {
  return (db.prepare("SELECT * FROM gm_signals WHERE session_id=? AND processed=0 ORDER BY turn_index")
    .all(sessionId) as any[])
    .map((row) => ({ type: row.type, turnIndex: row.turn_index, data: JSON.parse(row.data) }));
}

export function markSignalsDone(db: DatabaseSyncInstance, sessionId: string): void {
  db.prepare("UPDATE gm_signals SET processed=1 WHERE session_id=?").run(sessionId);
}

export function getStats(db: DatabaseSyncInstance): {
  totalNodes: number;
  byType: Record<string, number>;
  totalEdges: number;
  byEdgeType: Record<string, number>;
  communities: number;
} {
  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM gm_nodes WHERE status='active'").get() as any).c;
  const byType: Record<string, number> = {};
  for (const row of db.prepare("SELECT type, COUNT(*) as c FROM gm_nodes WHERE status='active' GROUP BY type").all() as any[]) {
    byType[row.type] = row.c;
  }
  const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM gm_edges").get() as any).c;
  const byEdgeType: Record<string, number> = {};
  for (const row of db.prepare("SELECT type, COUNT(*) as c FROM gm_edges GROUP BY type").all() as any[]) {
    byEdgeType[row.type] = row.c;
  }
  const communities = (db.prepare(
    "SELECT COUNT(DISTINCT community_id) as c FROM gm_nodes WHERE status='active' AND community_id IS NOT NULL",
  ).get() as any).c;
  return { totalNodes, byType, totalEdges, byEdgeType, communities };
}

export function saveVector(db: DatabaseSyncInstance, nodeId: string, content: string, vec: number[]): void {
  const hash = createHash("md5").update(content).digest("hex");
  const f32 = new Float32Array(vec);
  const blob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  db.prepare(`INSERT INTO gm_vectors (node_id, content_hash, embedding) VALUES (?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash=excluded.content_hash, embedding=excluded.embedding`)
    .run(nodeId, hash, blob);
}

export function getVectorHash(db: DatabaseSyncInstance, nodeId: string): string | null {
  return (db.prepare("SELECT content_hash FROM gm_vectors WHERE node_id=?").get(nodeId) as any)?.content_hash ?? null;
}

export function getAllVectors(db: DatabaseSyncInstance): Array<{ nodeId: string; embedding: Float32Array }> {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding FROM gm_vectors v
    JOIN gm_nodes n ON n.id = v.node_id WHERE n.status = 'active'
  `).all() as any[];
  return rows.map((row) => {
    const raw = row.embedding as Uint8Array;
    return {
      nodeId: row.node_id,
      embedding: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
    };
  });
}

export type ScoredNode = { node: GmNode; score: number };

export function vectorSearchWithScore(
  db: DatabaseSyncInstance,
  queryVec: number[],
  limit: number,
  minScore = 0.35,
): ScoredNode[] {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding, n.*
    FROM gm_vectors v JOIN gm_nodes n ON n.id = v.node_id
    WHERE n.status = 'active'
  `).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = Math.sqrt(q.reduce((sum, value) => sum + value * value, 0));
  if (qNorm === 0) return [];

  return rows
    .map((row) => {
      const raw = row.embedding as Uint8Array;
      const vector = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let dot = 0;
      let vectorNorm = 0;
      const len = Math.min(vector.length, q.length);
      for (let i = 0; i < len; i++) {
        dot += vector[i] * q[i];
        vectorNorm += vector[i] * vector[i];
      }
      return { score: dot / (Math.sqrt(vectorNorm) * qNorm + 1e-9), node: toNode(row) };
    })
    .filter((row) => row.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function vectorSearch(
  db: DatabaseSyncInstance,
  queryVec: number[],
  limit: number,
  minScore = 0.35,
): GmNode[] {
  return vectorSearchWithScore(db, queryVec, limit, minScore).map((row) => row.node);
}

export function communityRepresentatives(db: DatabaseSyncInstance, perCommunity = 2): GmNode[] {
  const rows = db.prepare(`
    SELECT * FROM gm_nodes
    WHERE status = 'active' AND community_id IS NOT NULL
    ORDER BY community_id, updated_at DESC
  `).all() as any[];

  const byCommunity = new Map<string, GmNode[]>();
  for (const row of rows) {
    const node = toNode(row);
    const communityId = row.community_id as string;
    if (!byCommunity.has(communityId)) byCommunity.set(communityId, []);
    const list = byCommunity.get(communityId)!;
    if (list.length < perCommunity) list.push(node);
  }

  const communities = Array.from(byCommunity.entries())
    .sort((a, b) => {
      const aTime = Math.max(...a[1].map((node) => node.updatedAt));
      const bTime = Math.max(...b[1].map((node) => node.updatedAt));
      return bTime - aTime;
    });

  const result: GmNode[] = [];
  for (const [, nodes] of communities) result.push(...nodes);
  return result;
}

export interface CommunitySummary {
  id: string;
  summary: string;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

export function upsertCommunitySummary(
  db: DatabaseSyncInstance,
  id: string,
  summary: string,
  nodeCount: number,
  embedding?: number[],
): void {
  const now = Date.now();
  const blob = embedding ? new Uint8Array(new Float32Array(embedding).buffer) : null;
  const existing = db.prepare("SELECT id FROM gm_communities WHERE id=?").get(id) as any;
  if (existing) {
    if (blob) {
      db.prepare("UPDATE gm_communities SET summary=?, node_count=?, embedding=?, updated_at=? WHERE id=?")
        .run(summary, nodeCount, blob, now, id);
    } else {
      db.prepare("UPDATE gm_communities SET summary=?, node_count=?, updated_at=? WHERE id=?")
        .run(summary, nodeCount, now, id);
    }
  } else {
    db.prepare("INSERT INTO gm_communities (id, summary, node_count, embedding, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(id, summary, nodeCount, blob, now, now);
  }
}

export function getCommunitySummary(db: DatabaseSyncInstance, id: string): CommunitySummary | null {
  const row = db.prepare("SELECT * FROM gm_communities WHERE id=?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    summary: row.summary,
    nodeCount: row.node_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllCommunitySummaries(db: DatabaseSyncInstance): CommunitySummary[] {
  return (db.prepare("SELECT * FROM gm_communities ORDER BY node_count DESC").all() as any[])
    .map((row) => ({
      id: row.id,
      summary: row.summary,
      nodeCount: row.node_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

export type ScoredCommunity = { id: string; summary: string; score: number; nodeCount: number };

export function communityVectorSearch(
  db: DatabaseSyncInstance,
  queryVec: number[],
  minScore = 0.15,
): ScoredCommunity[] {
  const rows = db.prepare(
    "SELECT id, summary, node_count, embedding FROM gm_communities WHERE embedding IS NOT NULL",
  ).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = Math.sqrt(q.reduce((sum, value) => sum + value * value, 0));
  if (qNorm === 0) return [];

  return rows
    .map((row) => {
      const raw = row.embedding as Uint8Array;
      const vector = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let dot = 0;
      let vectorNorm = 0;
      const len = Math.min(vector.length, q.length);
      for (let i = 0; i < len; i++) {
        dot += vector[i] * q[i];
        vectorNorm += vector[i] * vector[i];
      }
      return {
        id: row.id as string,
        summary: row.summary as string,
        score: dot / (Math.sqrt(vectorNorm) * qNorm + 1e-9),
        nodeCount: row.node_count as number,
      };
    })
    .filter((row) => row.score > minScore)
    .sort((a, b) => b.score - a.score);
}

export function nodesByCommunityIds(
  db: DatabaseSyncInstance,
  communityIds: string[],
  perCommunity = 3,
): GmNode[] {
  if (!communityIds.length) return [];
  const placeholders = communityIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM gm_nodes
    WHERE community_id IN (${placeholders}) AND status='active'
    ORDER BY community_id, updated_at DESC
  `).all(...communityIds) as any[];

  const byCommunity = new Map<string, GmNode[]>();
  for (const row of rows) {
    const node = toNode(row);
    const communityId = row.community_id as string;
    if (!byCommunity.has(communityId)) byCommunity.set(communityId, []);
    const list = byCommunity.get(communityId)!;
    if (list.length < perCommunity) list.push(node);
  }

  const result: GmNode[] = [];
  for (const communityId of communityIds) {
    const members = byCommunity.get(communityId);
    if (members) result.push(...members);
  }
  return result;
}

export function pruneCommunitySummaries(db: DatabaseSyncInstance): number {
  const result = db.prepare(`
    DELETE FROM gm_communities WHERE id NOT IN (
      SELECT DISTINCT community_id FROM gm_nodes WHERE community_id IS NOT NULL AND status='active'
    )
  `).run();
  return result.changes;
}
