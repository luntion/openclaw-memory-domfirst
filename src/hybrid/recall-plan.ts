import type { RecallPlan, ScopeContext } from "../types.ts";
import { buildScopeFilters } from "./scope.ts";

const CONFIRMATION_PATTERNS = [
  /对吧/u,
  /是不是/u,
  /记得吗/u,
  /right\??$/i,
  /did we/i,
];

const DETAIL_PATTERNS = [
  /什么/u,
  /why/i,
  /怎么/u,
  /如何/u,
  /修复/u,
  /原因/u,
  /过程/u,
  /what was/i,
  /how did/i,
];

const DEEP_DETAIL_PATTERNS = [
  /具体/u,
  /详细/u,
  /当时/u,
  /最后/u,
  /导致/u,
  /修好的/u,
];

const MEMORY_ANCHORS = [
  /昨天/u,
  /上次/u,
  /之前/u,
  /那次/u,
  /后来/u,
  /最近/u,
  /记忆/u,
  /故障/u,
  /skill/u,
  /项目/u,
  /we\b.*\bused/i,
];

export function planRecall(query: string, ctx: ScopeContext, now = Date.now()): RecallPlan {
  const text = query.trim();
  const filtersBase = buildScopeFilters(ctx, false);
  const temporalMode = detectTemporalMode(text);

  if (!text || text.length < 6) {
    return {
      depth: "L0",
      includeTeam: false,
      maxNodes: 0,
      maxDepth: 0,
      reason: "query too short",
      scopeFilters: filtersBase,
      temporalMode,
    };
  }

  const hasConfirmation = CONFIRMATION_PATTERNS.some((pattern) => pattern.test(text));
  const hasDetail = DETAIL_PATTERNS.some((pattern) => pattern.test(text));
  const hasDeepDetail = DEEP_DETAIL_PATTERNS.some((pattern) => pattern.test(text));
  const hasMemoryAnchor = MEMORY_ANCHORS.some((pattern) => pattern.test(text));
  const includeTeam = /(团队|公共|shared|team)/iu.test(text);
  const timeRange = parseTemporalHints(text, now);
  const preferRecent = Boolean(timeRange) || /(最近|后来|上次|last|recent|latest)/iu.test(text);

  if (!hasMemoryAnchor && !hasDetail && !hasConfirmation) {
    return {
      depth: "L0",
      includeTeam,
      maxNodes: 0,
      maxDepth: 0,
      reason: "no memory anchor detected",
      scopeFilters: buildScopeFilters(ctx, includeTeam),
      timeRange: timeRange ?? undefined,
      preferRecent,
      temporalMode,
    };
  }

  if (hasConfirmation && !hasDetail) {
    return {
      depth: "L1",
      includeTeam,
      maxNodes: 3,
      maxDepth: 0,
      reason: "confirmation-oriented query",
      scopeFilters: buildScopeFilters(ctx, includeTeam),
      timeRange: timeRange ?? undefined,
      preferRecent,
      temporalMode,
    };
  }

  if (hasDetail && !hasDeepDetail) {
    return {
      depth: "L2",
      includeTeam,
      maxNodes: 5,
      maxDepth: 1,
      reason: "detail requested",
      scopeFilters: buildScopeFilters(ctx, includeTeam),
      timeRange: timeRange ?? undefined,
      preferRecent,
      temporalMode,
    };
  }

  return {
    depth: "L3",
    includeTeam,
    maxNodes: 8,
    maxDepth: 2,
    reason: "deep detail or cause/process requested",
    scopeFilters: buildScopeFilters(ctx, includeTeam),
    timeRange: timeRange ?? undefined,
    preferRecent,
    temporalMode,
  };
}

function detectTemporalMode(text: string): RecallPlan["temporalMode"] {
  if (/(后来|演变|变化|怎么改|evolution|changed? over time)/iu.test(text)) {
    return "evolution";
  }
  if (/(之前|上次|昨天|当时|before|past)/iu.test(text)) {
    return "past";
  }
  return "current";
}

function parseTemporalHints(text: string, now: number): RecallPlan["timeRange"] | null {
  const date = new Date(now);
  const startOfToday = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;

  if (/昨天/u.test(text)) {
    return { start: startOfToday - day, end: startOfToday, label: "yesterday" };
  }
  if (/今天|刚才|刚刚/u.test(text)) {
    return { start: startOfToday, end: startOfToday + day, label: "today" };
  }
  if (/最近|近日/u.test(text)) {
    return { start: now - 7 * day, end: now + day, label: "recent-7d" };
  }
  if (/上次|最近一次/u.test(text)) {
    return { start: now - 30 * day, end: now + day, label: "latest-30d" };
  }
  if (/之前/u.test(text)) {
    return { end: now, label: "before-now" };
  }
  if (/后来/u.test(text)) {
    return { start: now - 30 * day, end: now + day, label: "afterwards-30d" };
  }
  return null;
}
