import type { GmNode, ScopeContext } from "../types.ts";

export function classifyNodeScope(
  ctx: ScopeContext,
  candidate: { type: string; name: string; description: string; content: string },
  conversationText: string,
): "session" | "agent" | "project" | "team" {
  if (candidate.type === "TASK") return "session";
  if (!ctx.projectId) return "agent";
  const text = `${candidate.name}\n${candidate.description}\n${candidate.content}\n${conversationText}`.toLowerCase();
  const projectSignals = [
    "skill",
    "plugin",
    "project",
    "module",
    "repo",
    "repository",
    "workspace",
    "build",
    "deploy",
    "openclaw",
    "memory/",
    ".ts",
    ".py",
    "功能",
    "项目",
    "插件",
    "模块",
    "代码",
    "仓库",
    "构建",
  ];
  const genericSignals = ["通用", "generic", "global", "shared by all"];
  if (genericSignals.some((signal) => text.includes(signal))) return "agent";
  if (projectSignals.some((signal) => text.includes(signal))) return "project";
  return "agent";
}

export function classifyEdgeScope(
  ctx: ScopeContext,
  from: GmNode,
  to: GmNode,
): "session" | "agent" | "project" | "team" {
  if (from.scopeType === "session" || to.scopeType === "session") return "session";
  if (from.scopeType === "project" || to.scopeType === "project") return "project";
  if (from.scopeType === "team" || to.scopeType === "team") return "team";
  if (ctx.projectId && (from.projectId === ctx.projectId || to.projectId === ctx.projectId)) return "project";
  return "agent";
}

export function scopeIdFor(
  ctx: ScopeContext,
  fallbackTeamId: string,
  scopeType: "session" | "agent" | "project" | "team",
) {
  if (scopeType === "session") return ctx.sessionId;
  if (scopeType === "agent") return ctx.agentId;
  if (scopeType === "project") return ctx.projectId ?? ctx.agentId;
  return ctx.teamId ?? fallbackTeamId;
}

export function extractEventTime(text: string, now = Date.now()): number | null {
  if (/昨天/u.test(text)) {
    return now - 24 * 60 * 60 * 1000;
  }
  if (/今天|刚刚|刚才/u.test(text)) {
    return now;
  }
  return null;
}
