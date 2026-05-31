# Changelog

## 0.4.1 - 2026-05-31

Summary:
- Standardized GitHub release workflow for versioned publishing.

New features:
- Added `release:prepare` to handle SemVer bumps, version file synchronization, changelog seeding, and release notes generation.
- Added `release:publish` to run verification, create the release commit, push `main`, create the Git tag, and push the tag.

Fixes:
- Fixed version drift between `package.json`, `package-lock.json`, and `openclaw.plugin.json`.
- Added release guardrails for clean working trees, duplicate tag prevention, and blocking placeholder changelog content.

Compatibility:
- No breaking configuration changes.

Verification:
- `npm test` passed on 2026-05-31
- `npm run build` passed on 2026-05-31
## 0.4.0

Temporal search and memory-governance upgrade for OpenClaw Memory DomFirst.

Highlights:

- explicit temporal search API via `POST /search/temporal`
- new plugin tool: `ocm_search_temporal`
- explicit temporal modes now support custom `timeRange`
- current recall now downranks `stale`, `superseded`, and `disputed` memories
- `past` and `evolution` modes now surface superseded history more naturally
- SQLite compatibility mode now supports the same extended node statuses as the Neo4j core
- README updated for explicit temporal search behavior

Verification status for this release:

- `npm test` passing with `101` tests
- `npm run build` passing

## 0.3.0

Graphiti + Neo4j core refactor for OpenClaw Memory DomFirst.

Highlights:

- backend abstraction layer for `sqlite` and `graphiti-neo4j`
- Neo4j governance graph store with lineage, candidate review, and audit APIs
- Graphiti-backed scoped recall path with Neo4j metadata persistence
- local SQLite reduced to message buffering and compatibility fallback
- new service endpoints: `lineage`, `candidates/review`, and `audit`
- new plugin tools: `ocm_lineage`, `ocm_review_candidate`, and `ocm_audit`
- configuration support for local or external Neo4j and Graphiti services

Verification status for this release:

- `npm test` passing
- `npm run build` passing

## 0.2.0

First release candidate of `openclaw-memory-domfirst`.

Highlights:

- graph-memory-first architecture for OpenClaw
- layered scopes: `session / agent / project / team`
- elastic recall depth: `L0-L3`
- local-first memory service
- controlled promotion from private memory to shared team memory
- file memory bridge for `memory/` and explicit knowledge files
- lightweight temporal versioning
- `past / current / evolution` recall modes
- timeline injection into assembled context
- temporal summary injection for evolution-style questions
- cross-platform startup and packaging scripts

Verification status for this release:

- `npm test` passing
- `npm run build` passing

## 0.1.0

Initial working prototype with plugin, service, scoped recall, and promotion flow.
