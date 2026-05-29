# 安装部署说明

这份说明用于把 `openclaw-memory-domfirst` 作为：

- OpenClaw 的 `context-engine` 插件
- 可选的本地 memory service

部署到本地环境中。

## 1. 前置要求

- Node.js 22+
- 支持插件的 OpenClaw
- 一个可写的本地数据库目录

推荐但非强制：

- 一个可用的 LLM 接口，用于抽取
- 一个 embedding 接口，用于语义召回

## 2. 安装依赖

在项目根目录执行：

```bash
npm install
npm test
npm run build
```

## 3. 配置 OpenClaw 插件

把 `openclaw-memory-domfirst` 注册成 OpenClaw 的 `contextEngine`。

配置片段示例：

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
          }
        }
      }
    }
  }
}
```

重点：

- 如果没有 `plugins.slots.contextEngine`，OpenClaw 不会跑这套生命周期钩子
- `llm` 建议配置，不然抽取能力会弱很多
- `embedding` 可选，不配时会降级到全文检索

## 4. 启动本地服务

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

默认服务地址：

```text
http://127.0.0.1:42690
```

## 5. 环境变量

本地服务支持这些环境变量：

- `OCM_HOST`
- `OCM_PORT`
- `OCM_DB_PATH`
- `OCM_TEAM_ID`
- `OCM_AGENT_ID`
- `OCM_PROJECT_ID`
- `OCM_MODEL`

## 6. 验证服务是否正常

健康检查：

```bash
curl http://127.0.0.1:42690/health
```

预期返回：

```json
{ "status": "ok", "service": "ocm-memoryd" }
```

## 7. 验证插件是否生效

你可以先做一轮短对话，然后确认：

- 消息是否入库
- 节点是否成功抽取
- 分层召回是否返回结果

建议检查方式：

- 调用 `ocm_stats`
- 调用 `ocm_search`
- 调用 `ocm_reindex`

## 8. 首次验证建议

1. 让 OpenClaw 执行一个会产生明确故障或修复的小任务。
2. 等这一轮结束，让 `afterTurn` 抽取完成。
3. 然后问：

```text
昨天那个任务我们遇到过故障对吧
```

预期行为：

- 触发浅层召回
- 给出确认型回答

再问：

```text
昨天那个任务遇到的故障是什么来着
```

预期行为：

- 触发更深层召回
- 返回更完整的原因和修复信息

## 9. 知识文件索引

当前只会索引：

- `memory/` 目录下文件
- 含显式知识标记的文件

手动重建索引示例：

```bash
curl -X POST http://127.0.0.1:42690/reindex ^
  -H "content-type: application/json" ^
  -d "{ \"root\": \"D:/AI-workspace/your-project\", \"ctx\": { \"sessionId\": \"sess-1\", \"agentId\": \"agent-a\", \"projectId\": \"proj-1\", \"teamId\": \"team-1\" } }"
```

## 10. 常见问题

### 插件看起来加载了，但没有记忆

检查：

- `plugins.slots.contextEngine` 是否设置
- 数据库路径是否可写
- OpenClaw 是否真的加载了这个插件条目

### 服务能启动，但检索质量一般

常见原因：

- 没有配置 embedding
- 记忆积累还不够
- 可索引知识文件范围过窄

### 召回正常，但团队记忆不出现

这是默认行为，除非：

- 查询明确需要共享经验
- 该记忆已经晋升到 `team`

### 重建索引失败

检查：

- 目标目录是否存在
- 文件是否为 UTF-8 文本
- 非 `memory/` 文件是否真的带了 marker
