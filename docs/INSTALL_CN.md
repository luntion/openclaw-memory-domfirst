# 安装部署说明

这份说明用于把 `openclaw-memory-domfirst` 部署为：

- OpenClaw 的 `context-engine` 插件
- 可选的本地 `memory service`

支持 Windows 和 macOS，本说明默认不依赖 Docker。

## 1. 前置要求

- Node.js 22+
- 可加载插件的 OpenClaw
- 一个可写本地目录，用于 SQLite 消息缓冲

推荐但非强制：

- 一个可用的 LLM 接口，用于记忆抽取
- 一个 embedding 接口，用于语义召回
- 一个可用的 Graphiti 服务
- 一个可用的 Neo4j 实例

## 2. 安装依赖

在项目根目录执行：

```bash
npm install
npm test
npm run build
```

## 3. OpenClaw 插件注册

在 OpenClaw 配置中，把 `openclaw-memory-domfirst` 注册成 `contextEngine`。

示例：

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
          },
          "backend": {
            "mode": "graphiti-neo4j",
            "graphiti": {
              "baseUrl": "http://127.0.0.1:18000",
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

关键说明：

- 没有 `plugins.slots.contextEngine`，OpenClaw 不会把这套插件当上下文引擎使用
- `llm` 建议配置，否则抽取质量会下降
- `embedding` 可选，不配置时会退化到全文检索
- `backend.mode = "sqlite"` 使用本地兼容模式
- `backend.mode = "graphiti-neo4j"` 使用 Neo4j + Graphiti 主核
- 在 `graphiti-neo4j` 模式下，首次成功连接后会自动初始化 Neo4j 约束和索引

## 4. 两种后端接入方式

### 方案 A：本机 Neo4j + 本机 Graphiti

适合：

- Windows 本机开发
- macOS 本机开发
- 不想依赖 Docker 作为主安装方式

建议配置：

- Neo4j 监听 `bolt://127.0.0.1:7687`
- Graphiti 监听 `http://127.0.0.1:18000`

可参考：

- [本机 Graphiti 配置示例](./openclaw.config.graphiti-local.json)

### 方案 B：外部 Neo4j + 外部 Graphiti

适合：

- 已有远程 Neo4j
- 已有独立部署的 Graphiti 服务

建议配置：

- `backend.neo4j.uri` 使用 `bolt://` 或 `bolt+s://`
- `backend.graphiti.baseUrl` 指向远程服务

可参考：

- [远程 Graphiti 配置示例](./openclaw.config.graphiti-remote.json)

## 5. 启动本地 memory service

### Windows

```powershell
npm run service:ps
```

### macOS / Linux

```bash
npm run service:sh
```

### 直接启动

```bash
npm run service
```

默认地址：

```text
http://127.0.0.1:42690
```

## 6. 环境变量

本地 `memory service` 支持这些环境变量：

- `OCM_HOST`
- `OCM_PORT`
- `OCM_DB_PATH`
- `OCM_TEAM_ID`
- `OCM_AGENT_ID`
- `OCM_PROJECT_ID`
- `OCM_MODEL`
- `OCM_BACKEND_MODE`
- `OCM_GRAPHITI_URL`
- `OCM_GRAPHITI_GROUP_PREFIX`
- `OCM_GRAPHITI_TIMEOUT_MS`
- `OCM_NEO4J_URI`
- `OCM_NEO4J_USER`
- `OCM_NEO4J_PASSWORD`
- `OCM_NEO4J_DATABASE`
- `OCM_NEO4J_WORKSPACE`

## 7. 健康检查

### 检查 memory service

```bash
curl http://127.0.0.1:42690/health
```

### 查看综合诊断

```bash
curl http://127.0.0.1:42690/diagnostics
```

### 运行 smoke test

Windows：

```powershell
npm run smoke:ps
```

macOS / Linux：

```bash
npm run smoke:sh
```

### 一次性检查 Graphiti / Neo4j / memoryd

Windows：

```powershell
npm run backend:check:ps
```

macOS / Linux：

```bash
npm run backend:check:sh
```

这个检查会覆盖：

- Graphiti `/healthcheck`
- `ocm-memoryd` `/health`
- Neo4j Bolt 连通性

在 `graphiti-neo4j` 模式下，`/health` 还会返回：

- `schemaReady`
- `neo4j`
- `graphiti`

## 8. 显式时序检索

当前版本支持显式时序查询：

- 插件工具：`ocm_search_temporal`
- 服务接口：`POST /search/temporal`

你可以显式传入：

- `temporalMode: current | past | evolution`
- `timeRange.start`
- `timeRange.end`
- `timeRange.label`

适合处理：

- 指定时间窗口内的问题
- 明确要求看历史版本
- 明确要求看演化链

## 9. 首次联调建议

建议先做一轮小任务，然后验证：

1. OpenClaw 是否正常写入消息
2. `afterTurn` 是否完成记忆抽取
3. `ocm_search` 是否能返回结果
4. `ocm_search_temporal` 是否能返回 `past / evolution` 结果
5. `/diagnostics` 是否显示正常的后端状态

## 10. 文件记忆索引

当前只会索引：

- `memory/` 目录下文件
- 带显式知识标记的文件

手动重建索引：

```bash
curl -X POST http://127.0.0.1:42690/reindex \
  -H "content-type: application/json" \
  -d "{ \"root\": \"D:/AI-workspace/your-project\", \"ctx\": { \"sessionId\": \"sess-1\", \"agentId\": \"agent-a\", \"projectId\": \"proj-1\", \"teamId\": \"team-1\" } }"
```

## 11. 常见问题

### 插件加载了，但没有形成记忆

先检查：

- `plugins.slots.contextEngine` 是否设置
- `dbPath` 是否可写
- OpenClaw 是否真的加载了这个插件

### Graphiti / Neo4j 模式下记忆质量差

先检查：

- Graphiti 是否可达
- Neo4j Bolt 是否可连接
- `llm` 与 `embedding` 是否配置
- scope 是否设置正确

### `team` 层没有结果

这是默认行为，除非：

- 查询本身明显需要团队共享经验
- 记忆已经晋升到 `team`
- 或者显式传入 `includeTeam=true`

### 健康检查失败

优先检查：

- Graphiti `baseUrl`
- Neo4j `uri / username / password / database`
- `npm run backend:check:*` 的错误输出
