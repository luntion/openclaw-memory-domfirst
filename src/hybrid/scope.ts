import type {
  GmNode,
  GmEdge,
  MemoryMetadata,
  ScopeContext,
  ScopeFilter,
  ScopeType,
  Visibility,
  PromotionState,
} from "../types.ts";

export interface ScopeSelection {
  filters: ScopeFilter[];
  includeTeam: boolean;
}

export function defaultMetadata(
  ctx: ScopeContext,
  scopeType: ScopeType = "agent",
  visibility: Visibility = scopeType === "team" || scopeType === "project" ? "shared" : "private",
  promotionState: PromotionState = scopeType === "team" ? "promoted" : "private",
): MemoryMetadata {
  const scopeId = scopeType === "session"
    ? ctx.sessionId
    : scopeType === "agent"
      ? ctx.agentId
      : scopeType === "project"
        ? (ctx.projectId ?? ctx.agentId)
        : (ctx.teamId ?? "team-default");

  return {
    scopeType,
    scopeId,
    visibility,
    sourceAgentId: ctx.agentId,
    sourceSessionId: ctx.sessionId,
    projectId: ctx.projectId ?? null,
    confidence: scopeType === "team" ? 0.9 : 0.65,
    verificationCount: 1,
    promotionState,
    eventTime: null,
    resolvedAt: null,
    supersededBy: null,
  };
}

export function buildScopeFilters(ctx: ScopeContext, includeTeam = false): ScopeFilter[] {
  const filters: ScopeFilter[] = [
    { scopeType: "session", scopeIds: [ctx.sessionId] },
    { scopeType: "agent", scopeIds: [ctx.agentId] },
  ];
  if (ctx.projectId) {
    filters.push({ scopeType: "project", scopeIds: [ctx.projectId] });
  }
  if (includeTeam && ctx.teamId) {
    filters.push({ scopeType: "team", scopeIds: [ctx.teamId] });
  }
  return filters;
}

export function matchesScopeFilters(
  item: Pick<GmNode, "scopeType" | "scopeId"> | Pick<GmEdge, "scopeType" | "scopeId">,
  filters: ScopeFilter[] | undefined,
): boolean {
  if (!filters?.length) return true;
  return filters.some((filter) => {
    if (filter.scopeType !== item.scopeType) return false;
    if (!filter.scopeIds?.length) return true;
    return filter.scopeIds.includes(item.scopeId);
  });
}

export function groupScopeReason(filters: ScopeFilter[]): string {
  return filters.map((filter) => `${filter.scopeType}:${filter.scopeIds?.join(",") ?? "*"}`).join(" | ");
}
