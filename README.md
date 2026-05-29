# OpenClaw Memory Hybrid

Local-first layered memory for OpenClaw, built on top of `graph-memory`.

This project turns the original graph-memory core into a practical OpenClaw memory system for:

- multi-agent collaboration
- scoped memory isolation
- elastic recall depth
- controlled promotion from private memory to shared team memory
- optional local memory service for external integrations

It is designed to run on Windows and macOS with minimal external dependencies.

Quick links:

- [Installation Guide](./docs/INSTALL.md)
- [OpenClaw Config Example](./docs/openclaw.config.example.json)
- [Product Overview](./docs/PRODUCT.md)
- [Release Guide](./docs/RELEASE.md)
- [Changelog](./CHANGELOG.md)
- [Chinese Guide](./README_CN.md)

## What It Does

`openclaw-memory-hybrid` ships as two parts:

- `OpenClaw context-engine plugin`
- `ocm-memoryd local memory service`

The plugin handles OpenClaw lifecycle integration:

- `ingest()`
- `afterTurn()`
- `assemble()`
- `prepareSubagentSpawn()`
- `onSubagentEnded()`

The local service exposes simple HTTP endpoints for search, recall planning, promotion, stats, ingestion, and reindexing.

## Core Capabilities

### 1. Layered memory scopes

Each memory item is stored in one of four scopes:

- `session`
- `agent`
- `project`
- `team`

Default behavior:

- new memory stays in `session` or `agent`
- project-specific knowledge can be shared in `project`
- `team` is reserved for verified shared knowledge

This prevents cross-agent contamination while still allowing controlled reuse.

### 2. Elastic recall depth

Recall is not always full-depth. The planner classifies the query and chooses one of four levels:

- `L0`: no recall
- `L1`: confirmation/summary only
- `L2`: event-level recall
- `L3`: deep recall with richer detail

Examples:

- `昨天那个 skill 我们遇到过故障对吧` -> typically `L1`
- `昨天我们开发那个 skill 遇到的故障是什么来着` -> typically `L2` or `L3`

### 3. Local-first recall order

Recall is scoped and local-first:

- `session`
- `agent`
- `project`
- `team`

The team layer is not searched by default unless the query or plan requires it.

### 4. Shared memory promotion

Shared memory uses mixed promotion plus double verification:

- a memory starts as private or project-level
- it can be marked as a promotion candidate
- it reaches `team` only after validation

Promotion can happen when:

- the same conclusion is confirmed again in another session
- another agent reuses and validates it
- the user explicitly promotes it

### 5. Knowledge-file bridge

The indexer intentionally avoids whole-workspace ingestion.

It only auto-indexes:

- files under `memory/`
- files explicitly marked with configured knowledge markers

This keeps the graph low-noise and token-efficient.

### 6. Lightweight temporal compatibility

The current build already includes lightweight temporal support:

- `eventTime`
- `resolvedAt`
- `supersededBy`
- node version snapshots
- `past / current / evolution` recall modes

This is enough to support questions like:

- `之前那个 skill-history 是怎么做的`
- `后来那个流程怎么改的`

## Architecture

```text
OpenClaw
  -> openclaw-memory-hybrid plugin
      -> HybridMemoryEngine
          -> scoped store
          -> recall planner
          -> hybrid recaller
          -> promotion layer
          -> file indexer
  -> optional ocm-memoryd service
      -> /search
      -> /recall-plan
      -> /promote
      -> /stats
      -> /ingest
      -> /maintenance/run
      -> /reindex
```

## Repository Layout

```text
index.ts                     OpenClaw plugin entry
service.ts                   Local HTTP memory service
openclaw.plugin.json         Plugin manifest
src/hybrid/engine.ts         Main orchestration layer
src/hybrid/recall-plan.ts    Elastic recall planner
src/hybrid/recaller.ts       Scoped recall execution
src/hybrid/promotion.ts      Candidate promotion and team sharing
src/hybrid/files.ts          Knowledge-file discovery and indexing
src/store/db.ts              SQLite schema and migrations
src/store/store.ts           Core graph-memory store logic
test/hybrid.test.ts          Layered memory behavior tests
```

## Install

### Requirements

- Node.js 22+
- OpenClaw with plugin support

### Local development install

```bash
git clone <your-repo-or-local-copy>
cd openclaw-memory-hybrid
npm install
npm test
npm run build
```

## OpenClaw Setup

Register the plugin as a context engine in your OpenClaw config.

Example:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "openclaw-memory-hybrid"
    },
    "entries": {
      "openclaw-memory-hybrid": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/openclaw-memory-hybrid.db",
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
- if embedding is missing, the system degrades to FTS-based recall

## Run The Local Service

```bash
npm run service
```

Environment variables:

- `OCM_HOST`
- `OCM_PORT`
- `OCM_DB_PATH`
- `OCM_TEAM_ID`
- `OCM_AGENT_ID`
- `OCM_PROJECT_ID`
- `OCM_MODEL`

Default service endpoint:

```text
http://127.0.0.1:42690
```

## Service API

### `GET /health`

Health check.

### `GET /stats`

Returns scoped graph stats.

Query params:

- `sessionId`
- `agentId`
- `projectId`
- `teamId`

### `POST /recall-plan`

Request body:

```json
{
  "query": "昨天那个 skill 我们遇到过故障对吧",
  "ctx": {
    "sessionId": "sess-1",
    "agentId": "agent-a",
    "projectId": "proj-1",
    "teamId": "team-1"
  }
}
```

### `POST /search`

Request body:

```json
{
  "query": "skill-history",
  "ctx": {
    "sessionId": "sess-1",
    "agentId": "agent-a",
    "projectId": "proj-1",
    "teamId": "team-1"
  }
}
```

### `POST /ingest`

Push a message into memory processing.

### `POST /promote`

Explicitly promote a memory candidate.

### `POST /maintenance/run`

Run maintenance tasks manually.

### `POST /reindex`

Reindex `memory/` and explicitly marked knowledge files.

## OpenClaw Tools

The plugin registers these tools:

- `ocm_search`
- `ocm_remember`
- `ocm_stats`
- `ocm_promote`
- `ocm_reindex`
- `ocm_inspect`
- `ocm_candidates`

## Current Status

This repository currently provides a working v1:

- plugin builds
- service runs
- layered recall works
- temporal version recall works
- tests pass

Verified locally:

- `npm test` -> 93 passing tests
- `npm run build` -> passes

## Limitations

Current v1 intentionally does not try to be a full memory platform.

Known boundaries:

- no full workspace indexing by default
- team memory is quality-first, not speed-first
- temporal modeling is lightweight, not yet a full event timeline engine
- packaging and OS-specific installers are not included yet

## Next Recommended Work

- add Windows/macOS startup scripts
- add packaged OpenClaw install instructions for real deployment
- expand temporal graph support into a richer `v1.5`
- add admin/debug APIs for promotion review and scope inspection

## License

MIT
