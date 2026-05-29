# Product Overview

`openclaw-memory-hybrid` is a local-first memory engine for OpenClaw built on the `graph-memory` core and extended for real multi-agent work.

## What Users Experience

Instead of treating every old conversation as raw chat history, the system turns experience into structured memory and only recalls the amount of detail needed for the current question.

Typical behaviors:

- `Did we hit that issue yesterday?`
  The system gives a short confirmation.
- `What exactly was that issue yesterday?`
  The system recalls the event, cause, and repair path in more detail.
- `How did that skill change over time?`
  The system can return an evolution chain instead of a flat memory hit.

## Main Product Advantages

### Layered isolation

Memory is split across:

- `session`
- `agent`
- `project`
- `team`

This keeps one agent's temporary or noisy experience from polluting everyone else.

### Elastic recall

The engine does not always perform deep recall. It chooses among:

- `L0` no recall
- `L1` confirmation-level recall
- `L2` event-level recall
- `L3` deep recall

That improves response speed and reduces token waste.

### Controlled sharing

Private memory does not automatically become team memory.

Shared promotion is gated by verification, so the team layer stays cleaner and more trustworthy.

### Temporal memory

The system supports:

- current-state recall
- past-version recall
- evolution recall

This matters when workflows, fixes, or skill implementations change over time.

### Local-first deployment

The memory engine runs as:

- an OpenClaw plugin
- an optional local memory service

This keeps the system practical on Windows and macOS without building a heavy remote platform first.

## What Makes It Different

Compared with a plain graph memory plugin, this version adds:

- scoped multi-agent isolation
- promotion control between private and shared memory
- query-sensitive recall depth
- lightweight temporal versioning
- temporal summaries injected directly into context

Compared with naive vector memory, it keeps stronger structure and better recall control.

## Current Delivery Shape

The current implementation already includes:

- OpenClaw context-engine integration
- local HTTP memory service
- layered scope model
- promotion workflow
- admin/debug inspection tools
- knowledge-file indexing
- past/evolution recall
- temporal timeline and summary injection

## Good Fit

This product is a good fit when you want:

- multiple agents working on the same project
- memory reuse without uncontrolled contamination
- lower token spend than replaying raw history
- better answers to `before / later / now` style questions

## Next Productization Steps

- add packaged installation and release artifacts
- add richer UI/debug views for promotion review and timelines
- add admin tooling for inspecting scope contamination and promotion lineage
