# 安装部署说明

这份说明用于把 `openclaw-memory-domfirst` 作为：

- OpenClaw 的 `context-engine` 插件
- 可选的本地 `memory service`

部署到 Windows 或 macOS 环境中。

## 1. 前置要求

- Node.js 22+
- 支持插件的 OpenClaw
- 一个可写的本地目录，用于 SQLite 消息缓冲数据库

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

重点：

- 没有 `plugins.slots.contextEngine`，OpenClaw 不会跑这套生命周期钩子
- `llm` 建议配置，否则抽取质量会明显下降
- `embedding` 可选，不配置时会退化到全文检索
- `backend.mode = "graphiti-neo4j"` 表示启用 Neo4j + Graphiti 主核

## 4. Neo4j 与 Graphiti 两种接入方式

### 方案 A：本机 Neo4j Desktop / 本地 Graphiti

适合：

- Windows 本机开发
- macOS 本机开发
- 不想依赖 Docker

建议配置：

- Neo4j Desktop 或本地 Neo4j 服务监听 `bolt://127.0.0.1:7687`
- Graphiti 服务监听 `http://127.0.0.1:8000`

可参考：

- [本机 Graphiti 配置示例](./openclaw.config.graphiti-local.json)

### 方案 B：外部 Neo4j / 外部 Graphiti

适合：

- 你已有远程 Neo4j
- 你已有单独部署的 Graphiti 服务

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

### 一次性检查 Graphiti / Neo4j / memoryd

Windows：

```powershell
npm run backend:check:ps
```

macOS / Linux：

```bash
npm run backend:check:sh
```

这个脚本会检查：

- Graphiti `/healthcheck`
- `ocm-memoryd` `/health`
- Neo4j Bolt 端口连通性

## 8. 验证插件是否生效

建议先做一轮短对话，然后确认：

- 消息已进入缓冲层
- 记忆节点已被抽取
- 召回能返回作用域正确的结果

建议检查：

- `ocm_stats`
- `ocm_search`
- `ocm_reindex`
- `ocm_inspect`
- `ocm_candidates`
- `ocm_lineage`
- `ocm_audit`

## 9. 首次联调建议

1. 让 OpenClaw 完成一个会产生明确故障或修复记录的小任务
2. 等该轮结束，确保 `afterTurn` 已完成抽取
3. 提问：

```text
昨天那个任务我们遇到过故障对吧
```

预期：

- 触发浅召回
- 给出确认型回答

再提问：

```text
昨天那个任务遇到的故障是什么来着
```

预期：

- 触发更深层召回
- 返回更完整的原因、关系和修复信息

## 10. 文件记忆索引

当前只会索引：

- `memory/` 目录下文件
- 带显式知识标记的文件

手动重建索引：

```bash
curl -X POST http://127.0.0.1:42690/reindex ^
  -H "content-type: application/json" ^
  -d "{ \"root\": \"D:/AI-workspace/your-project\", \"ctx\": { \"sessionId\": \"sess-1\", \"agentId\": \"agent-a\", \"projectId\": \"proj-1\", \"teamId\": \"team-1\" } }"
```

## 11. 常见问题

### 插件加载了，但没有形成记忆

检查：

- `plugins.slots.contextEngine` 是否设置
- `dbPath` 是否可写
- OpenClaw 是否真的加载了这个插件条目

### Graphiti / Neo4j 模式下记忆质量差

检查：

- Graphiti 服务是否真的可达
- Neo4j Bolt 是否可连接
- `llm` 与 `embedding` 是否配置
- scope 是否设置过窄

### `team` 层没有结果

这是默认行为，除非：

- 查询明显需要共享经验
- 记忆已经晋升进 `team`
- 或者你显式查看 `includeTeam=true`

### 健康检查失败

优先检查：

- Graphiti `baseUrl`
- Neo4j `uri / username / password / database`
- `npm run backend:check:*` 输出的失败点
