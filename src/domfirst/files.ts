import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, extname } from "path";
import type { ScopeContext } from "../types.ts";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { upsertScopedNode } from "./store.ts";

const DEFAULT_EXTENSIONS = new Set([".md", ".txt"]);

export interface IndexedFileResult {
  path: string;
  indexed: boolean;
  reason?: string;
}

export function discoverKnowledgeFiles(root: string, markers: string[]): string[] {
  const resolvedRoot = resolve(root);
  const results: string[] = [];

  function visit(pathname: string): void {
    const stat = statSync(pathname);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(pathname)) {
        visit(join(pathname, entry));
      }
      return;
    }

    if (!DEFAULT_EXTENSIONS.has(extname(pathname).toLowerCase())) return;
    const normalized = pathname.replace(/\\/g, "/");
    if (normalized.includes("/memory/")) {
      results.push(pathname);
      return;
    }

    const text = readFileSync(pathname, "utf8");
    if (markers.some((marker) => text.includes(marker))) {
      results.push(pathname);
    }
  }

  visit(resolvedRoot);
  return results;
}

export function indexKnowledgeFiles(
  db: DatabaseSyncInstance,
  files: string[],
  ctx: ScopeContext,
): IndexedFileResult[] {
  const results: IndexedFileResult[] = [];
  for (const file of files) {
    try {
      const text = readFileSync(file, "utf8");
      const content = text.trim();
      if (!content) {
        results.push({ path: file, indexed: false, reason: "empty file" });
        continue;
      }
      const isProject = file.replace(/\\/g, "/").includes("/memory/");
      const scopeType = isProject ? "project" : "agent";
      const name = fileToName(file);
      upsertScopedNode(
        db,
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
        },
      );

      db.prepare(`
        INSERT INTO gm_documents (id, path, scope_type, scope_id, project_id, source_agent_id, content_hash, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          scope_type = excluded.scope_type,
          scope_id = excluded.scope_id,
          project_id = excluded.project_id,
          source_agent_id = excluded.source_agent_id,
          content_hash = excluded.content_hash,
          indexed_at = excluded.indexed_at
      `).run(
        `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        scopeType,
        isProject ? (ctx.projectId ?? ctx.agentId) : ctx.agentId,
        ctx.projectId ?? null,
        ctx.agentId,
        createHash("md5").update(content).digest("hex"),
        Date.now(),
      );

      results.push({ path: file, indexed: true });
    } catch (error) {
      results.push({ path: file, indexed: false, reason: String(error) });
    }
  }
  return results;
}

function fileToName(file: string): string {
  return file
    .replace(/\\/g, "/")
    .split("/")
    .slice(-2)
    .join("-")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}
