import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig } from "../types.ts";
import type { BackendRuntime } from "./types.ts";
import { createGraphitiNeo4jRuntime } from "./graphiti-neo4j.ts";
import { createSQLiteRuntime } from "./sqlite.ts";

export function createBackendRuntime(db: DatabaseSyncInstance, cfg: GmConfig): BackendRuntime {
  if (cfg.backend.mode === "graphiti-neo4j") {
    return createGraphitiNeo4jRuntime(db, cfg);
  }
  return createSQLiteRuntime(db, cfg);
}
