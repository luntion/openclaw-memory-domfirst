import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { getDb } from "./src/store/db.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";
import { DomFirstMemoryEngine } from "./src/domfirst/engine.ts";
import { upsertScopedNode } from "./src/domfirst/store.ts";

function readProviderModel(apiConfig: unknown): { provider: string; model: string } {
  let raw = "";
  if (apiConfig && typeof apiConfig === "object") {
    const model = (apiConfig as any).agents?.defaults?.model;
    if (typeof model === "string" && model.trim()) raw = model.trim();
    if (!raw && model && typeof model === "object" && typeof model.primary === "string") {
      raw = model.primary.trim();
    }
  }
  if (!raw) raw = "openai/gpt-4o-mini";
  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    return { provider, model: rest.join("/").trim() };
  }
  return { provider: "openai", model: raw };
}

function ctxFromHook(input: any, cfg: GmConfig, sessionId?: string) {
  return {
    sessionId: sessionId ?? input?.sessionId ?? input?.sessionKey ?? "session-default",
    agentId: input?.agentId ?? input?.agent ?? cfg.defaultAgentId,
    projectId: input?.projectId ?? cfg.defaultProjectId,
    teamId: input?.teamId ?? cfg.teamId,
    userId: input?.userId,
  };
}

function formatSearchResult(payload: Awaited<ReturnType<DomFirstMemoryEngine["search"]>>): string {
  const lines: string[] = [];
  const { plan, result } = payload;

  lines.push(`Recall depth: ${plan.depth}`);
  lines.push(`Temporal mode: ${plan.temporalMode ?? "current"}`);
  lines.push(`Reason: ${plan.reason}`);

  if (result.timelineSummary) {
    lines.push("");
    lines.push("Temporal summary:");
    lines.push(result.timelineSummary);
  }

  if (result.timeline?.length) {
    lines.push("");
    lines.push("Timelines:");
    for (const item of result.timeline.slice(0, 3)) {
      const chain = item.versions
        .map((version) => `${version.timelineLabel ?? `v${version.versionNo}`}: ${version.description}`)
        .join(" -> ");
      lines.push(`- ${item.name}: ${chain}`);
    }
  }

  if (result.nodes.length) {
    lines.push("");
    lines.push("Memory hits:");
    for (const node of result.nodes.slice(0, 6)) {
      lines.push(`[${node.scopeType}] ${node.name}`);
      lines.push(node.description);
      lines.push(node.content.slice(0, 300));
      lines.push("");
    }
  } else {
    lines.push("");
    lines.push("No relevant memory found.");
  }

  return lines.join("\n").trim();
}

function formatInspectResult(payload: ReturnType<DomFirstMemoryEngine["inspect"]>): string {
  const lines: string[] = [];
  if (payload.nodes.length) {
    lines.push("Current nodes:");
    for (const node of payload.nodes) {
      lines.push(`[${node.scopeType}] ${node.name}`);
      lines.push(`${node.description}`);
      lines.push(`status=${node.status} promotion=${node.promotionState} confidence=${node.confidence}`);
      lines.push(node.content.slice(0, 240));
      lines.push("");
    }
  }
  if (payload.versions.length) {
    lines.push("Versions:");
    for (const version of payload.versions.slice(0, 8)) {
      lines.push(`v${version.versionNo} ${version.timelineLabel ?? ""}`.trim());
      lines.push(version.description);
      lines.push(version.content.slice(0, 240));
      lines.push("");
    }
  }
  return lines.length ? lines.join("\n").trim() : "No matching memory found.";
}

function formatCandidateResult(nodes: ReturnType<DomFirstMemoryEngine["candidates"]>): string {
  if (!nodes.length) return "No promotion candidates found.";
  return nodes.map((node) =>
    [
      `[${node.scopeType}] ${node.name}`,
      `${node.description}`,
      `promotion=${node.promotionState} verification=${node.verificationCount} confidence=${node.confidence}`,
    ].join("\n"),
  ).join("\n\n");
}

const plugin = {
  id: "openclaw-memory-domfirst",
  name: "OpenClaw Memory DomFirst",
  kind: "context-engine" as const,

  register(api: OpenClawPluginApi) {
    const cfg: GmConfig = { ...DEFAULT_CONFIG, ...((api.pluginConfig ?? {}) as object) };
    const db = getDb(cfg.dbPath);
    const { provider, model } = readProviderModel(api.config);
    const llm = createCompleteFn(provider, model, cfg.llm);
    const engine = new DomFirstMemoryEngine(db, cfg, llm, api.logger);

    createEmbedFn(cfg.embedding)
      .then((embed) => {
        engine.setEmbedFn(embed);
        api.logger.info(`[openclaw-memory-domfirst] ready | db=${cfg.dbPath} | provider=${provider} | model=${model}`);
      })
      .catch(() => {
        engine.setEmbedFn(null);
        api.logger.info(`[openclaw-memory-domfirst] ready in FTS fallback mode | db=${cfg.dbPath}`);
      });

    api.registerContextEngine("openclaw-memory-domfirst", () => ({
      info: {
        id: "openclaw-memory-domfirst",
        name: "OpenClaw Memory DomFirst",
        ownsCompaction: false,
      },
      async ingest({ sessionId, message, isHeartbeat }: any) {
        return engine.ingestMessage(ctxFromHook({}, cfg, sessionId), message, isHeartbeat);
      },
      async assemble({ sessionId, messages, prompt, threadId }: any) {
        const ctx = ctxFromHook({ threadId }, cfg, sessionId);
        return engine.assemble({ ctx, messages, prompt });
      },
      async afterTurn({ sessionId, messages, prePromptMessageCount, isHeartbeat, agentId, projectId, teamId }: any) {
        if (isHeartbeat) return;
        const ctx = ctxFromHook({ agentId, projectId, teamId }, cfg, sessionId);
        const newMessages = messages.slice(prePromptMessageCount ?? 0);
        await engine.afterTurn(ctx, newMessages);
      },
      async compact() {
        return { ok: true, compacted: false, reason: "delegated to OpenClaw auto compaction" };
      },
      async prepareSubagentSpawn({ parentSessionKey, childSessionKey, agentId, projectId, teamId }: any) {
        const parent = ctxFromHook({ agentId, projectId, teamId }, cfg, parentSessionKey);
        const child = ctxFromHook({ agentId: `${parent.agentId}-child`, projectId, teamId }, cfg, childSessionKey);
        return {
          rollback: () => engine.disposeSession(child.sessionId),
          systemPromptAddition: `Subagent scope inheritance: session=${child.sessionId}, agent=${child.agentId}, project=${child.projectId ?? "none"}, team=${child.teamId ?? "none"}.`,
        };
      },
      async onSubagentEnded({ childSessionKey }: any) {
        engine.disposeSession(childSessionKey);
      },
      async dispose() {
        // Session-local state is already ephemeral.
      },
    }));

    api.registerTool(
      (toolCtx: any) => ({
        name: "ocm_search",
        label: "Search Layered Memory",
        description: "Search scoped long-term memory with elastic recall depth.",
        parameters: Type.Object({
          query: Type.String(),
          depth: Type.Optional(Type.String({ description: "Optional recall depth override L0-L3" })),
        }),
        async execute(_toolCallId: string, params: { query: string; depth?: string }) {
          const ctx = ctxFromHook(toolCtx, cfg);
          const overridePlan = params.depth ? { depth: params.depth as any } : undefined;
          const result = await engine.search(params.query, ctx, overridePlan);
          return {
            content: [{ type: "text", text: formatSearchResult(result) }],
            details: result,
          };
        },
      }),
      { name: "ocm_search" },
    );

    api.registerTool(
      (toolCtx: any) => ({
        name: "ocm_remember",
        label: "Record Memory",
        description: "Store an explicit memory item into the layered graph.",
        parameters: Type.Object({
          name: Type.String(),
          type: Type.String(),
          description: Type.String(),
          content: Type.String(),
          scopeType: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: any) {
          const ctx = ctxFromHook(toolCtx, cfg);
          const { node } = upsertScopedNode(
            db,
            {
              type: params.type,
              name: params.name,
              description: params.description,
              content: params.content,
            },
            ctx,
            params.scopeType ? { scopeType: params.scopeType } : undefined,
          );
          return {
            content: [{ type: "text", text: `Recorded ${node.name} in ${node.scopeType}:${node.scopeId}` }],
            details: node,
          };
        },
      }),
      { name: "ocm_remember" },
    );

    api.registerTool(
      (toolCtx: any) => ({
        name: "ocm_stats",
        label: "Memory Stats",
        description: "Show scoped graph statistics.",
        parameters: Type.Object({}),
        async execute() {
          const ctx = ctxFromHook(toolCtx, cfg);
          const stats = engine.stats(ctx);
          return {
            content: [{ type: "text", text: `Nodes=${stats.totalNodes}, Edges=${stats.totalEdges}, Communities=${stats.communities}` }],
            details: stats,
          };
        },
      }),
      { name: "ocm_stats" },
    );

    api.registerTool(
      (toolCtx: any) => ({
        name: "ocm_promote",
        label: "Promote Shared Memory",
        description: "Promote a private/project memory into the team layer once verified.",
        parameters: Type.Object({
          name: Type.String(),
          explicit: Type.Optional(Type.Boolean()),
        }),
        async execute(_toolCallId: string, params: { name: string; explicit?: boolean }) {
          const ctx = ctxFromHook(toolCtx, cfg);
          const result = engine.promote(params.name, ctx, params.explicit === true);
          return {
            content: [{ type: "text", text: result.promoted ? `Promoted ${params.name} to team memory.` : `Promotion skipped: ${result.reason}` }],
            details: result,
          };
        },
      }),
      { name: "ocm_promote" },
    );

    api.registerTool(
      (toolCtx: any) => ({
        name: "ocm_reindex",
        label: "Reindex Knowledge Files",
        description: "Reindex memory/ and explicit knowledge files into project or agent scopes.",
        parameters: Type.Object({
          root: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { root?: string }) {
          const ctx = ctxFromHook(toolCtx, cfg);
          const result = engine.reindex(params.root ?? process.cwd(), ctx);
          const indexed = result.filter((item) => item.indexed).length;
          return {
            content: [{ type: "text", text: `Indexed ${indexed}/${result.length} knowledge files.` }],
            details: result,
          };
        },
      }),
      { name: "ocm_reindex" },
    );

    api.registerTool(
      (toolCtx: any) => ({
        name: "ocm_inspect",
        label: "Inspect Memory",
        description: "Inspect current nodes and version history for a memory item.",
        parameters: Type.Object({
          name: Type.String(),
          includeTeam: Type.Optional(Type.Boolean()),
        }),
        async execute(_toolCallId: string, params: { name: string; includeTeam?: boolean }) {
          const ctx = ctxFromHook(toolCtx, cfg);
          const result = engine.inspect(params.name, ctx, params.includeTeam !== false);
          return {
            content: [{ type: "text", text: formatInspectResult(result) }],
            details: result,
          };
        },
      }),
      { name: "ocm_inspect" },
    );

    api.registerTool(
      (toolCtx: any) => ({
        name: "ocm_candidates",
        label: "List Promotion Candidates",
        description: "List memory items currently marked as team-promotion candidates.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number()),
          includeTeam: Type.Optional(Type.Boolean()),
        }),
        async execute(_toolCallId: string, params: { limit?: number; includeTeam?: boolean }) {
          const ctx = ctxFromHook(toolCtx, cfg);
          const result = engine.candidates(ctx, params.includeTeam !== false, params.limit ?? 20);
          return {
            content: [{ type: "text", text: formatCandidateResult(result) }],
            details: result,
          };
        },
      }),
      { name: "ocm_candidates" },
    );
  },
};

export default plugin;
