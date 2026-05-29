# OpenClaw Memory Hybrid

这是一个基于 `graph-memory` 主干改造出来的 OpenClaw 分层弹性记忆系统。

它不是单纯把图做大，而是把记忆系统做成更适合 OpenClaw 实际协作场景的形态：

- 多 agent 可隔离
- 共享记忆可控
- 召回深度可弹性调节
- 本地优先、低依赖、低噪音
- 可作为 OpenClaw 插件，也可作为外部本地扩展服务

目标平台：

- Windows
- macOS

快速入口：

- [安装部署说明](./docs/INSTALL_CN.md)
- [OpenClaw 配置示例](./docs/openclaw.config.example.json)
- [产品说明](./docs/PRODUCT_CN.md)
- [发布说明](./docs/RELEASE.md)
- [更新记录](./CHANGELOG.md)
- [English README](./README.md)

## 这个成品现在能做什么

当前实现已经具备可运行的 v1 能力。

它由两个组件组成：

- `openclaw-memory-hybrid`
  OpenClaw `context-engine` 插件
- `ocm-memoryd`
  本地常驻 memory service

插件负责接入 OpenClaw 生命周期：

- `ingest()`
- `afterTurn()`
- `assemble()`
- `prepareSubagentSpawn()`
- `onSubagentEnded()`

本地服务负责对外提供：

- 检索
- 召回计划
- 显式写入
- 共享晋升
- 文件重建索引
- 统计与维护

## 核心能力

### 1. 四层记忆分级

每条记忆都带作用域，首版支持四层：

- `session`
- `agent`
- `project`
- `team`

默认规则：

- 新记忆先进入 `session` 或 `agent`
- 项目共享知识进入 `project`
- 团队层 `team` 只接收经过验证的稳定记忆

这能避免多 agent 之间互相污染。

### 2. 弹性记忆召回

系统不会每次都全量深召回，而是先判断你对记忆细节的需求等级。

当前支持四档：

- `L0` 不召回
- `L1` 只给结论或确认
- `L2` 返回事件级细节
- `L3` 返回更深的过程、原因、修复路径

例子：

- `昨天那个 skill 我们遇到过故障对吧`
  一般走 `L1`
- `昨天我们开发那个 skill 遇到的故障是什么来着`
  一般走 `L2` 或 `L3`

这样可以减少无意义的大规模召回，降低 token 消耗。

### 3. 局部优先召回

默认召回顺序不是全图扫，而是：

- `session`
- `agent`
- `project`
- `team`

只有局部不足、或者问题明显指向共享经验时，才会拉高到团队层。

### 4. 共享晋升机制

团队共享采用“混合晋升 + 双重验证”。

流程是：

- 私有或项目层先沉淀
- 系统可标记为 `candidate`
- 满足验证条件后再进入 `team`

验证来源包括：

- 第二次独立命中同一经验
- 第二个 agent 复用并验证
- 用户显式确认要晋升

这能保证团队层不被单次低质量记忆污染。

### 5. 文件记忆桥接

当前不会默认扫描整个工作区。

只索引两类文件：

- `memory/` 目录下的文件
- 带显式知识标记的文档

这样做的目的很明确：

- 避免噪音灌入图谱
- 避免召回质量下降
- 避免 token 被无关内容拖高

### 6. 轻量时序能力

虽然完整时序图谱还没扩展到完整版 `v1.5`，但当前实现已经有轻量时序兼容：

- `eventTime`
- `resolvedAt`
- `supersededBy`
- 历史版本快照
- `current / past / evolution` 三种时间模式召回

所以它已经能处理这类问题：

- `之前那个 skill-history 是怎么做的`
- `后来那个流程怎么改的`

## 架构形态

```text
OpenClaw
  -> openclaw-memory-hybrid 插件
      -> HybridMemoryEngine
          -> 分层存储
          -> 召回评级器
          -> 分层召回器
          -> 晋升层
          -> 文件索引器
  -> ocm-memoryd 本地服务
      -> /search
      -> /recall-plan
      -> /promote
      -> /stats
      -> /ingest
      -> /maintenance/run
      -> /reindex
```

## 目录说明

```text
index.ts                     OpenClaw 插件入口
service.ts                   本地 memory service
openclaw.plugin.json         插件清单
src/hybrid/engine.ts         核心编排层
src/hybrid/recall-plan.ts    弹性召回评级
src/hybrid/recaller.ts       分层召回执行
src/hybrid/promotion.ts      晋升逻辑
src/hybrid/files.ts          文件记忆索引
src/store/db.ts              SQLite 表结构与迁移
src/store/store.ts           graph-memory 主干存储逻辑
test/hybrid.test.ts          分层记忆测试
```

## 安装与本地运行

### 前置要求

- Node.js 22+
- 支持插件的 OpenClaw

### 本地开发安装

```bash
git clone <your-repo-or-local-copy>
cd openclaw-memory-hybrid
npm install
npm test
npm run build
```

## OpenClaw 接入方式

在 OpenClaw 配置中，把它注册成 `contextEngine`。

示例：

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

说明：

- `llm` 建议配置，用于抽取质量
- `embedding` 可选
- 没有 embedding 时会自动降级到全文检索，不会阻断使用

## 启动本地服务

```bash
npm run service
```

可用环境变量：

- `OCM_HOST`
- `OCM_PORT`
- `OCM_DB_PATH`
- `OCM_TEAM_ID`
- `OCM_AGENT_ID`
- `OCM_PROJECT_ID`
- `OCM_MODEL`

默认地址：

```text
http://127.0.0.1:42690
```

## 服务接口

### `GET /health`

健康检查。

### `GET /stats`

返回当前作用域统计。

可带查询参数：

- `sessionId`
- `agentId`
- `projectId`
- `teamId`

### `POST /recall-plan`

请求体示例：

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

请求体示例：

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

写入一条待处理消息。

### `POST /promote`

显式执行共享晋升。

### `POST /maintenance/run`

手动执行维护。

### `POST /reindex`

重建 `memory/` 和显式知识文件索引。

## OpenClaw 工具

插件已注册这些工具：

- `ocm_search`
- `ocm_remember`
- `ocm_stats`
- `ocm_promote`
- `ocm_reindex`

## 当前实现状态

这套仓库现在已经是可运行的 v1：

- 插件可构建
- service 可启动
- 分层记忆生效
- 弹性召回生效
- 历史版本召回生效
- 测试通过

当前本地验证结果：

- `npm test` -> `93 passed`
- `npm run build` -> 通过

## 当前边界

这个 v1 有意保持克制，不做过重的平台化。

目前边界：

- 不默认索引整个工作区
- 团队共享优先质量，不优先速度
- 时序层是轻量兼容，不是完整事件时间线引擎
- 还没有做 Windows/macOS 打包安装器

## 下一步建议

建议按这个顺序继续：

- 补 Windows/macOS 启动脚本
- 补真实部署用的 OpenClaw 安装文档
- 扩展到更完整的 `v1.5` 时序图谱
- 增加管理员审查和调试接口

## 许可证

MIT
