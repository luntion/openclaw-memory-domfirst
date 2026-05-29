# Changelog

## 0.2.0

First release candidate of `openclaw-memory-hybrid`.

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
