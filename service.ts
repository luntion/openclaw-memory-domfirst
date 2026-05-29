import { createServer } from "node:http";
import { getDb } from "./src/store/db.ts";
import { createBackendRuntime } from "./src/backend/factory.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { DomFirstMemoryEngine } from "./src/domfirst/engine.ts";

function formatSearchResult(payload: Awaited<ReturnType<DomFirstMemoryEngine["search"]>>): string {
  const lines: string[] = [];
  const { plan, result } = payload;
  lines.push(`Recall depth: ${plan.depth}`);
  lines.push(`Temporal mode: ${plan.temporalMode ?? "current"}`);
  if (result.timelineSummary) {
    lines.push("");
    lines.push("Temporal summary:");
    lines.push(result.timelineSummary);
  }
  if (result.nodes.length) {
    lines.push("");
    lines.push("Memory hits:");
    for (const node of result.nodes.slice(0, 6)) {
      lines.push(`[${node.scopeType}] ${node.name}`);
      lines.push(node.description);
      lines.push(node.content.slice(0, 240));
      lines.push("");
    }
  } else {
    lines.push("");
    lines.push("No relevant memory found.");
  }
  return lines.join("\n").trim();
}

function formatInspectResult(payload: Awaited<ReturnType<DomFirstMemoryEngine["inspect"]>>): string {
  const lines: string[] = [];
  if (payload.nodes.length) {
    lines.push("Current nodes:");
    for (const node of payload.nodes) {
      lines.push(`[${node.scopeType}] ${node.name}`);
      lines.push(node.description);
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

function formatCandidateResult(nodes: Awaited<ReturnType<DomFirstMemoryEngine["candidates"]>>): string {
  if (!nodes.length) return "No promotion candidates found.";
  return nodes.map((node) =>
    [
      `[${node.scopeType}] ${node.name}`,
      node.description,
      `promotion=${node.promotionState} verification=${node.verificationCount} confidence=${node.confidence}`,
    ].join("\n"),
  ).join("\n\n");
}

function formatLineageResult(payload: Awaited<ReturnType<DomFirstMemoryEngine["lineage"]>>): string {
  const lines = [`Memory: ${payload.name}`];
  if (payload.sources.length) {
    lines.push("", "Sources:");
    for (const source of payload.sources.slice(0, 8)) {
      lines.push(`[${source.scopeType}] ${source.scopeId} promotion=${source.promotionState} verification=${source.verificationCount} confidence=${source.confidence}`);
    }
  }
  if (payload.versions.length) {
    lines.push("", "Versions:");
    for (const version of payload.versions.slice(0, 6)) {
      lines.push(`v${version.versionNo} ${version.description}`.trim());
    }
  }
  return lines.join("\n");
}

function formatAuditResult(items: Awaited<ReturnType<DomFirstMemoryEngine["audit"]>>): string {
  if (!items.length) return "No audit findings.";
  return items.map((item) =>
    `${item.severity.toUpperCase()} [${item.scopeType}] ${item.name}\n${item.reason}\nstatus=${item.status} promotion=${item.promotionState} verification=${item.verificationCount} confidence=${item.confidence}`,
  ).join("\n\n");
}

function readConfig(): GmConfig {
  return {
    ...DEFAULT_CONFIG,
    serviceHost: process.env.OCM_HOST ?? DEFAULT_CONFIG.serviceHost,
    servicePort: Number(process.env.OCM_PORT ?? DEFAULT_CONFIG.servicePort),
    dbPath: process.env.OCM_DB_PATH ?? DEFAULT_CONFIG.dbPath,
    teamId: process.env.OCM_TEAM_ID ?? DEFAULT_CONFIG.teamId,
    defaultAgentId: process.env.OCM_AGENT_ID ?? DEFAULT_CONFIG.defaultAgentId,
    defaultProjectId: process.env.OCM_PROJECT_ID ?? DEFAULT_CONFIG.defaultProjectId,
    backend: {
      mode: (process.env.OCM_BACKEND_MODE as GmConfig["backend"]["mode"]) ?? DEFAULT_CONFIG.backend.mode,
      graphiti: {
        ...DEFAULT_CONFIG.backend.graphiti,
        baseUrl: process.env.OCM_GRAPHITI_URL ?? DEFAULT_CONFIG.backend.graphiti.baseUrl,
        groupPrefix: process.env.OCM_GRAPHITI_GROUP_PREFIX ?? DEFAULT_CONFIG.backend.graphiti.groupPrefix,
        timeoutMs: Number(process.env.OCM_GRAPHITI_TIMEOUT_MS ?? DEFAULT_CONFIG.backend.graphiti.timeoutMs),
      },
      neo4j: {
        ...DEFAULT_CONFIG.backend.neo4j,
        uri: process.env.OCM_NEO4J_URI ?? DEFAULT_CONFIG.backend.neo4j.uri,
        username: process.env.OCM_NEO4J_USER ?? DEFAULT_CONFIG.backend.neo4j.username,
        password: process.env.OCM_NEO4J_PASSWORD ?? DEFAULT_CONFIG.backend.neo4j.password,
        database: process.env.OCM_NEO4J_DATABASE ?? DEFAULT_CONFIG.backend.neo4j.database,
        workspace: process.env.OCM_NEO4J_WORKSPACE ?? DEFAULT_CONFIG.backend.neo4j.workspace,
      },
    },
  };
}

function readProviderModel(): { provider: string; model: string } {
  const raw = process.env.OCM_MODEL ?? "openai/gpt-4o-mini";
  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    return { provider, model: rest.join("/") };
  }
  return { provider: "openai", model: raw };
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const db = getDb(cfg.dbPath);
  const runtime = createBackendRuntime(db, cfg);
  const { provider, model } = readProviderModel();
  const llm = createCompleteFn(provider, model, cfg.llm);
  const engine = new DomFirstMemoryEngine(runtime, db, cfg, llm, console);
  const embed = await createEmbedFn(cfg.embedding).catch(() => null);
  engine.setEmbedFn(embed);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${cfg.serviceHost}:${cfg.servicePort}`);
    const body = await readBody(req);
    res.setHeader("content-type", "application/json; charset=utf-8");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return void res.end(JSON.stringify({ status: "ok", service: "ocm-memoryd", backend: await engine.health() }));
      }

      if (req.method === "GET" && url.pathname === "/stats") {
        const ctx = engine.buildScopeContext({
          sessionId: url.searchParams.get("sessionId") ?? "service-session",
          agentId: url.searchParams.get("agentId") ?? cfg.defaultAgentId,
          projectId: url.searchParams.get("projectId") ?? cfg.defaultProjectId,
          teamId: url.searchParams.get("teamId") ?? cfg.teamId,
        });
        return void res.end(JSON.stringify(await engine.stats(ctx)));
      }

      if (req.method === "POST" && url.pathname === "/recall-plan") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        return void res.end(JSON.stringify(engine.planRecall(String(body.query ?? ""), ctx)));
      }

      if (req.method === "POST" && url.pathname === "/search") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const result = await engine.search(String(body.query ?? ""), ctx, body.plan ?? undefined);
        return void res.end(JSON.stringify({ ...result, displayText: formatSearchResult(result) }));
      }

      if (req.method === "POST" && url.pathname === "/ingest") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        if (body.message) {
          engine.ingestMessage(ctx, body.message, body.isHeartbeat);
          await engine.afterTurn(ctx, [body.message]);
          return void res.end(JSON.stringify({ status: "ingested", sessionId: ctx.sessionId }));
        }
        return void res.end(JSON.stringify({ status: "ignored", reason: "missing message" }));
      }

      if (req.method === "POST" && url.pathname === "/promote") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const result = await engine.promote(String(body.name ?? ""), ctx, Boolean(body.explicit));
        return void res.end(JSON.stringify(result));
      }

      if (req.method === "POST" && url.pathname === "/inspect") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const result = await engine.inspect(String(body.name ?? ""), ctx, body.includeTeam !== false);
        return void res.end(JSON.stringify({ ...result, displayText: formatInspectResult(result) }));
      }

      if (req.method === "POST" && url.pathname === "/candidates") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const result = await engine.candidates(ctx, body.includeTeam !== false, Number(body.limit ?? 20));
        return void res.end(JSON.stringify({ items: result, displayText: formatCandidateResult(result) }));
      }

      if (req.method === "POST" && url.pathname === "/lineage") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const result = await engine.lineage(String(body.name ?? ""), ctx, body.includeTeam !== false);
        return void res.end(JSON.stringify({ ...result, displayText: formatLineageResult(result) }));
      }

      if (req.method === "POST" && url.pathname === "/candidates/review") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const result = await engine.reviewCandidate(String(body.name ?? ""), ctx, String(body.action ?? "defer") as any, body.targetName ? String(body.targetName) : undefined);
        return void res.end(JSON.stringify(result));
      }

      if (req.method === "POST" && url.pathname === "/audit") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const result = await engine.audit(ctx, body.includeTeam !== false);
        return void res.end(JSON.stringify({ items: result, displayText: formatAuditResult(result) }));
      }

      if (req.method === "POST" && url.pathname === "/maintenance/run") {
        const result = await engine.runMaintenance();
        return void res.end(JSON.stringify(result));
      }

      if (req.method === "POST" && url.pathname === "/reindex") {
        const ctx = engine.buildScopeContext(body.ctx ?? {});
        const root = String(body.root ?? process.cwd());
        return void res.end(JSON.stringify(engine.reindex(root, ctx)));
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  server.listen(cfg.servicePort, cfg.serviceHost, () => {
    console.log(`[ocm-memoryd] listening on http://${cfg.serviceHost}:${cfg.servicePort}`);
  });
}

async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

main().catch((error) => {
  console.error("[ocm-memoryd] fatal", error);
  process.exit(1);
});
