# OpenClaw Memory DomFirst

Layered memory for OpenClaw with a local-first plugin layer and an optional `Graphiti + Neo4j` memory core.

This repository keeps the OpenClaw-facing behavior you asked for:

- multi-agent memory isolation
- scoped shared memory
- elastic recall depth
- controlled promotion into team memory
- temporal recall for `past / current / evolution`

It now supports two backend modes:

- `sqlite`
  local-only compatibility mode
- `graphiti-neo4j`
  Graphiti service for temporal fact retrieval plus Neo4j for DomFirst governance, lineage, review, and audit

Quick links:

- [Installation Guide](./docs/INSTALL.md)
- [Chinese Guide](./docs/INSTALL_CN.md)
- [Default Config Example](./docs/openclaw.config.example.json)
- [Local Graphiti Config Example](./docs/openclaw.config.graphiti-local.json)
- [Remote Graphiti Config Example](./docs/openclaw.config.graphiti-remote.json)
- [Product Overview](./docs/PRODUCT.md)
- [Release Guide](./docs/RELEASE.md)
- [Changelog](./CHANGELOG.md)

## What It Ships

`openclaw-memory-domfirst` has two runtime components:

- `OpenClaw context-engine plugin`
- `ocm-memoryd local memory service`

The plugin owns:

- `ingest()`
- `afterTurn()`
- `assemble()`
- `prepareSubagentSpawn()`
- `onSubagentEnded()`

The local service exposes:

- `GET /health`
- `GET /stats`
- `GET /diagnostics`
- `POST /ingest`
- `POST /search`
- `POST /recall-plan`
- `POST /inspect`
- `POST /promote`
- `POST /lineage`
- `POST /candidates`
- `POST /candidates/review`
- `POST /audit`
- `POST /reindex`
- `POST /maintenance/run`

## Core Capabilities

### 1. Layered scopes

Each memory item belongs to one of:

- `session`
- `agent`
- `project`
- `team`

Default recall order stays local-first:

- `session -> agent -> project -> team`

### 2. Elastic recall depth

The planner still chooses:

- `L0`
- `L1`
- `L2`
- `L3`

Examples:

- `"Did we hit that failure yesterday?"` -> usually `L1`
- `"What exactly was the failure yesterday, and how did we fix it?"` -> usually `L2` or `L3`

### 3. Shared memory promotion

Team memory is still controlled by mixed promotion plus double verification:

- repeated confirmation in later sessions
- validation by another agent
- explicit user or admin approval

### 4. Temporal memory

The system supports:

- `current`
- `past`
- `evolution`

This now maps to:

- Graphiti fact retrieval
- Neo4j lineage and version graph
- plugin-side depth control and context assembly

### 5. Governance and inspection

The new backend mode adds:

- lineage lookup
- candidate review
- audit findings
- stale / superseded / disputed state awareness

## Architecture

```text
OpenClaw
  -> openclaw-memory-domfirst plugin
      -> DomFirstMemoryEngine
          -> recall planner
          -> scope policy
          -> promotion policy
          -> context assembly
          -> backend runtime
              -> sqlite runtime
              -> graphiti + neo4j runtime
  -> optional ocm-memoryd service
      -> health / search / inspect / promote
      -> lineage / candidates / review / audit
      -> reindex / maintenance
```

## Repository Layout

```text
index.ts                     OpenClaw plugin entry
service.ts                   Local HTTP memory service
openclaw.plugin.json         Plugin manifest
src/domfirst/engine.ts       Main orchestration layer
src/domfirst/recall-plan.ts  Elastic recall planner
src/domfirst/recaller.ts     SQLite fallback recaller
src/backend/                 Backend runtime adapters
src/store/db.ts              SQLite schema and migrations
src/store/store.ts           SQLite compatibility store
test/domfirst.test.ts        Layered memory behavior tests
```

## OpenClaw Setup

Register the plugin as the `contextEngine`.

Example:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "openclaw-memory-domfirst"
    },
    "entries": {
      "openclaw-memory-domfirst": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/openclaw-memory-domfirst.db",
          "serviceHost": "127.0.0.1",
          "servicePort": 42690,
          "teamId": "team-default",
          "defaultAgentId": "agent-main",
          "defaultProjectId": "project-main",
          "llm": {
            "apiKey": "YOUR_API_KEY",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "YOUR_API_KEY",
            "baseURL": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "dimensions": 512
          },
          "backend": {
            "mode": "graphiti-neo4j",
            "graphiti": {
              "baseUrl": "http://127.0.0.1:8000",
              "groupPrefix": "ocm",
              "timeoutMs": 20000
            },
            "neo4j": {
              "uri": "bolt://127.0.0.1:7687",
              "username": "neo4j",
              "password": "YOUR_NEO4J_PASSWORD",
              "database": "neo4j",
              "workspace": "main"
            }
          }
        }
      }
    }
  }
}
```

Notes:

- `llm` is recommended for extraction quality
- `embedding` is optional
- `backend.mode = "sqlite"` keeps local compatibility mode
- `backend.mode = "graphiti-neo4j"` enables the Neo4j + Graphiti core
- `backend.neo4j.uri` may point to local Neo4j Desktop or an external Neo4j instance
- `backend.graphiti.baseUrl` may point to a local or external Graphiti service
- in `graphiti-neo4j` mode, the runtime auto-creates the required Neo4j constraints, lookup indexes, and full-text index on first successful connection

## Service Startup

```bash
npm run service
```

Convenience wrappers:

- `npm run service:ps`
- `npm run service:sh`
- `npm run backend:check:ps`
- `npm run backend:check:sh`
- `npm run smoke:ps`
- `npm run smoke:sh`

When the service or plugin starts in `graphiti-neo4j` mode, it performs a non-blocking backend warmup and logs whether Neo4j schema bootstrap succeeded or the backend is degraded.

Default endpoint:

```text
http://127.0.0.1:42690
```

## OpenClaw Tools

The plugin registers:

- `ocm_search`
- `ocm_remember`
- `ocm_stats`
- `ocm_promote`
- `ocm_reindex`
- `ocm_inspect`
- `ocm_candidates`
- `ocm_lineage`
- `ocm_review_candidate`
- `ocm_audit`

`GET /diagnostics` is intended for real backend bring-up: it combines backend health, per-scope node counts, candidate counts, and audit sample output into one response.

The smoke scripts are the fastest end-to-end check for a running `memoryd`: they ingest one sample failure/fix event, run shallow recall, run deeper recall, and then print diagnostics for the same scope.

## Verification Status

Current local verification:

- `npm test` -> 97 passing tests
- `npm run build` -> passes
- `npm run package:ps` -> passes

Latest packaged artifact:

- `release/openclaw-memory-domfirst-0.3.0.zip`

## Current Boundaries

- Graphiti and Neo4j live integration still depends on a running service and database
- SQLite remains the message buffer and compatibility fallback
- full temporal event modeling is still lighter than a dedicated v1.5 timeline engine

## License

MIT
