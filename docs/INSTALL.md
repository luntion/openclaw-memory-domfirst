# Installation Guide

This guide covers local setup for `openclaw-memory-hybrid` as:

- an OpenClaw context-engine plugin
- an optional local memory service

## 1. Requirements

- Node.js 22+
- OpenClaw with plugin support
- a writable local directory for the SQLite database

Optional but recommended:

- an LLM endpoint for extraction
- an embedding endpoint for semantic recall

## 2. Install Dependencies

From the project root:

```bash
npm install
npm test
npm run build
```

## 3. OpenClaw Plugin Registration

Add `openclaw-memory-hybrid` as the context engine in your OpenClaw config.

Example config fragment:

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
          "serviceHost": "127.0.0.1",
          "servicePort": 42690,
          "teamId": "team-default",
          "defaultAgentId": "agent-main",
          "defaultProjectId": "project-main",
          "knowledgeMarkers": [
            "knowledge: true",
            "memory-scope:",
            "team-memory: true"
          ],
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

Important:

- without `plugins.slots.contextEngine`, OpenClaw will not run the plugin lifecycle hooks
- `llm` is recommended for extraction quality
- `embedding` is optional; the system can fall back to FTS-only recall

## 4. Local Service Startup

### Windows

```powershell
npm run service:ps
```

### macOS / Linux

```bash
npm run service:sh
```

### Direct start

```bash
npm run service
```

Default service URL:

```text
http://127.0.0.1:42690
```

## 5. Environment Variables

The local service supports these environment variables:

- `OCM_HOST`
- `OCM_PORT`
- `OCM_DB_PATH`
- `OCM_TEAM_ID`
- `OCM_AGENT_ID`
- `OCM_PROJECT_ID`
- `OCM_MODEL`

## 6. Verify The Service

Health check:

```bash
curl http://127.0.0.1:42690/health
```

Expected response:

```json
{ "status": "ok", "service": "ocm-memoryd" }
```

## 7. Verify Plugin Behavior

Use a short OpenClaw conversation, then confirm:

- messages are ingested
- nodes are extracted
- scoped recall returns results

Suggested checks:

- call `ocm_stats`
- call `ocm_search`
- call `ocm_reindex`
- call `ocm_inspect`
- call `ocm_candidates`

## 8. Recommended First Test

1. Ask OpenClaw to do a small task that produces a clear event or fix.
2. Let one turn finish so extraction can run.
3. Ask:

```text
昨天那个任务我们遇到过故障对吧
```

Expected behavior:

- shallow recall
- confirmation-oriented answer

Then ask:

```text
昨天那个任务遇到的故障是什么来着
```

Expected behavior:

- deeper recall
- more detailed cause/fix answer

## 9. Knowledge File Indexing

The indexer only pulls:

- files inside `memory/`
- files containing configured knowledge markers

Manual reindex:

```bash
curl -X POST http://127.0.0.1:42690/reindex ^
  -H "content-type: application/json" ^
  -d "{ \"root\": \"D:/AI-workspace/your-project\", \"ctx\": { \"sessionId\": \"sess-1\", \"agentId\": \"agent-a\", \"projectId\": \"proj-1\", \"teamId\": \"team-1\" } }"
```

## 10. Troubleshooting

### The plugin loads but nothing is remembered

Check:

- `plugins.slots.contextEngine` is set
- the database path is writable
- your OpenClaw process is actually using this plugin entry

### Service starts but search quality is weak

Likely causes:

- no embedding configured
- not enough memory accumulated yet
- the knowledge file scope is too narrow

### Recall works but team knowledge does not appear

This is expected unless:

- the query explicitly needs shared knowledge
- the memory was promoted into `team`

### Reindex fails

Check:

- the target root exists
- files are UTF-8 text
- markers are present for non-`memory/` documents
