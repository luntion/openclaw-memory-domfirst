# OpenClaw Memory DomFirst

这是一个面向 OpenClaw 的分层记忆系统，插件层保持本地优先，记忆主核可切换到 `Graphiti + Neo4j`。

它保留了你最初要求的几类能力：

- 多 agent 记忆隔离
- `session / agent / project / team` 四层共享控制
- 按问题深度弹性召回
- 团队记忆晋升与防污染
- `past / current / evolution` 时序视角查询

当前支持两种后端模式：

- `sqlite`
  本地兼容模式，适合最小依赖运行
- `graphiti-neo4j`
  以 Graphiti 负责事实/时序检索，以 Neo4j 负责分层治理、来源链、候选审查和审计

快速入口：

- [安装说明](./docs/INSTALL_CN.md)
- [英文说明](./README.md)
- [默认配置示例](./docs/openclaw.config.example.json)
- [本机 Graphiti 示例](./docs/openclaw.config.graphiti-local.json)
- [远程 Graphiti 示例](./docs/openclaw.config.graphiti-remote.json)
- [产品说明](./docs/PRODUCT_CN.md)
- [更新记录](./CHANGELOG.md)

## 成品现在能做什么

`openclaw-memory-domfirst` 由两个运行组件组成：

- `openclaw-memory-domfirst`
  OpenClaw `context-engine` 插件
- `ocm-memoryd`
  本地 `memory service`

插件负责接入 OpenClaw 生命周期：

- `ingest()`
- `afterTurn()`
- `assemble()`
- `compact()`
- `prepareSubagentSpawn()`
- `onSubagentEnded()`

本地服务负责对外暴露记忆能力：

- `GET /health`
- `GET /stats`
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

## 核心能力

### 1. 四层分级记忆

每条记忆都落在以下作用域之一：

- `session`
- `agent`
- `project`
- `team`

默认召回顺序保持局部优先：

- `session -> agent -> project -> team`

这保证了：

- agent 私有经验默认隔离
- 同项目多 agent 可以复用 `project` 层
- `team` 层只承接经过验证的共享知识

### 2. 弹性记忆召回

系统不会每次都全量深召回，而是按问题深度做四档规划：

- `L0`
- `L1`
- `L2`
- `L3`

典型例子：

- `昨天那个任务我们遇到过故障对吧` 通常走 `L1`
- `昨天那个任务遇到的故障是什么，后来怎么修的` 通常走 `L2` 或 `L3`

这样可以减少无效召回，降低 token 消耗，并保持响应速度。

### 3. 团队共享晋升

团队层不是默认自动写入，而是走“混合晋升 + 双重验证”：

- 后续会话再次确认同一经验
- 另一个 agent 复用并验证同一经验
- 用户或管理 agent 明确批准共享

这样做的目的，是防止单次低质量经验污染团队记忆。

### 4. 时序记忆

当前已经支持三种时间视角：

- `current`
- `past`
- `evolution`

在 `graphiti-neo4j` 模式下：

- Graphiti 负责事实检索与时间相关结果
- Neo4j 负责版本链、来源链、共享状态与治理关系
- 插件层继续控制 `L0-L3` 召回深度和上下文注入

### 5. 治理与审查

当前版本已经补上这些管理能力：

- 来源链追踪
- 候选共享审查
- 审计视图
- 对 `stale / superseded / disputed` 状态的识别与降权

## 架构形态

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

## 目录概览

```text
index.ts                     OpenClaw 插件入口
service.ts                   本地 memory service
openclaw.plugin.json         插件清单
src/domfirst/engine.ts       主编排层
src/domfirst/recall-plan.ts  弹性召回评级
src/backend/                 后端运行时适配层
src/store/db.ts              SQLite 缓冲数据库与迁移
src/store/store.ts           SQLite 兼容存储层
test/domfirst.test.ts        分层记忆与召回测试
```

## OpenClaw 接入

在 OpenClaw 配置中把它注册为 `contextEngine`。

示例见：

- [默认配置](./docs/openclaw.config.example.json)
- [本机 Graphiti 配置](./docs/openclaw.config.graphiti-local.json)
- [远程 Graphiti 配置](./docs/openclaw.config.graphiti-remote.json)

关键说明：

- `llm` 建议配置，否则抽取质量会明显下降
- `embedding` 可选，不配置时会退化到全文检索
- `backend.mode = "sqlite"` 使用本地兼容模式
- `backend.mode = "graphiti-neo4j"` 使用 Neo4j + Graphiti 主核
- `graphiti-neo4j` 模式会在首次成功连接时自动准备 Neo4j 约束、索引和全文检索索引

## 本地服务启动

```bash
npm run service
```

也可以直接使用平台脚本：

- Windows: `npm run service:ps`
- macOS / Linux: `npm run service:sh`

后端健康检查脚本：

- Windows: `npm run backend:check:ps`
- macOS / Linux: `npm run backend:check:sh`

服务或插件启动时会做一次非阻塞后端预热，并在日志里说明 Neo4j schema 是否初始化成功，或者当前处于降级状态。

默认服务地址：

```text
http://127.0.0.1:42690
```

## OpenClaw 工具

插件当前注册这些工具：

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

## 当前验证状态

本地已验证：

- `npm run build` 通过
- `npm test` 通过，`97` 个测试全部通过
- `npm run package:ps` 通过

当前打包产物：

- `release/openclaw-memory-domfirst-0.3.0.zip`

## 当前边界

- Graphiti 与 Neo4j 的真实联调仍依赖可用的服务和数据库实例
- SQLite 现在是消息缓冲与兼容回退层，不再是主记忆真源
- 时序能力已可用，但还没有扩展成完整的高阶时间线引擎

## 许可证

MIT
