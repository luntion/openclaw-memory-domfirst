import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type {
  GmEdge,
  GmNode,
  MemoryMetadata,
  ScopeContext,
  ScopeFilter,
} from "../types.ts";
import { matchesScopeFilters, defaultMetadata } from "./scope.ts";
import {
  allActiveNodes,
  allEdges,
  findByName,
  getNodeVersions,
  getBySession,
  getStats,
  graphWalk,
  listByName,
  listPromotionCandidates,
  searchNodes,
  topNodes,
  upsertEdge,
  upsertNode,
  vectorSearchWithScore,
} from "../store/store.ts";

export function upsertScopedNode(
  db: DatabaseSyncInstance,
  input: { type: GmNode["type"]; name: string; description: string; content: string },
  ctx: ScopeContext,
  meta?: Partial<MemoryMetadata>,
) {
  const resolved = { ...defaultMetadata(ctx, meta?.scopeType ?? "agent"), ...meta };
  return upsertNode(db, input, ctx.sessionId, resolved);
}

export function upsertScopedEdge(
  db: DatabaseSyncInstance,
  input: {
    fromId: string;
    toId: string;
    type: GmEdge["type"];
    instruction: string;
    condition?: string;
  },
  ctx: ScopeContext,
  meta?: Partial<MemoryMetadata>,
): void {
  const resolved = { ...defaultMetadata(ctx, meta?.scopeType ?? "agent"), ...meta };
  upsertEdge(db, {
    ...input,
    sessionId: ctx.sessionId,
    scopeType: resolved.scopeType,
    scopeId: resolved.scopeId,
    visibility: resolved.visibility,
    sourceAgentId: resolved.sourceAgentId,
    projectId: resolved.projectId,
  });
}

export function getScopedSessionNodes(
  db: DatabaseSyncInstance,
  sessionId: string,
  filters?: ScopeFilter[],
): GmNode[] {
  return getBySession(db, sessionId).filter((node) => matchesScopeFilters(node, filters));
}

export function searchScopedNodes(
  db: DatabaseSyncInstance,
  query: string,
  limit: number,
  filters?: ScopeFilter[],
): GmNode[] {
  return searchNodes(db, query, limit).filter((node) => matchesScopeFilters(node, filters)).slice(0, limit);
}

export function topScopedNodes(
  db: DatabaseSyncInstance,
  limit: number,
  filters?: ScopeFilter[],
): GmNode[] {
  return topNodes(db, limit).filter((node) => matchesScopeFilters(node, filters)).slice(0, limit);
}

export function graphWalkScoped(
  db: DatabaseSyncInstance,
  seedIds: string[],
  maxDepth: number,
  filters?: ScopeFilter[],
): { nodes: GmNode[]; edges: GmEdge[] } {
  const walked = graphWalk(db, seedIds, maxDepth);
  const nodes = walked.nodes.filter((node) => matchesScopeFilters(node, filters));
  const nodeSet = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: walked.edges.filter(
      (edge) =>
        nodeSet.has(edge.fromId) &&
        nodeSet.has(edge.toId) &&
        matchesScopeFilters(edge, filters),
    ),
  };
}

export function vectorSearchScoped(
  db: DatabaseSyncInstance,
  queryVec: number[],
  limit: number,
  filters?: ScopeFilter[],
): GmNode[] {
  return vectorSearchWithScore(db, queryVec, Math.max(limit * 4, limit))
    .map((result) => result.node)
    .filter((node) => matchesScopeFilters(node, filters))
    .slice(0, limit);
}

export function getScopedStats(db: DatabaseSyncInstance, filters?: ScopeFilter[]) {
  const nodes = allActiveNodes(db).filter((node) => matchesScopeFilters(node, filters));
  const nodeSet = new Set(nodes.map((node) => node.id));
  const edges = allEdges(db).filter(
    (edge) =>
      nodeSet.has(edge.fromId) &&
      nodeSet.has(edge.toId) &&
      matchesScopeFilters(edge, filters),
  );
  const base = getStats(db);
  return {
    ...base,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    scopedNodeIds: [...nodeSet],
  };
}

export function findScopedNodeByName(
  db: DatabaseSyncInstance,
  name: string,
  filters?: ScopeFilter[],
): GmNode | null {
  return findByName(db, name, filters);
}

export function inspectScopedMemoryByName(
  db: DatabaseSyncInstance,
  name: string,
  filters?: ScopeFilter[],
) {
  const nodes = listByName(db, name, filters);
  const versions = getNodeVersions(db, name, filters);
  return { nodes, versions };
}

export function listScopedPromotionCandidates(
  db: DatabaseSyncInstance,
  filters?: ScopeFilter[],
  limit = 20,
) {
  return listPromotionCandidates(db, filters, limit);
}
