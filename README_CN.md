# OpenClaw Memory DomFirst

这是一个面向 OpenClaw 的分层记忆系统。它保留本地优先的使用方式，同时支持把记忆主核切换到 `Graphiti + Neo4j`。

这套实现重点解决的是：

- 多 agent 记忆隔离
- `session / agent / project / team` 四层作用域
- 按问题深度弹性召回记忆
- 团队共享记忆的受控晋升
- `past / current / evolution` 时序查询

当前支持两种后端模式：

- `sqlite`
  纯本地兼容模式
- `graphiti-neo4j`
  由 Graphiti 负责事实检索，由 Neo4j 负责分层治理、来源链、审计和版本关系

快速入口：

- [安装说明](./docs/INSTALL_CN.md)
- [英文说明](./README.md)
- [默认配置示例](./docs/openclaw.config.example.json)
- [本机 Graphiti 配置示例](./docs/openclaw.config.graphiti-local.json)
- [远程 Graphiti 配置示例](./docs/openclaw.config.graphiti-remote.json)
- [产品说明](./docs/PRODUCT_CN.md)
- [更新记录](./CHANGELOG.md)

## 组成

`openclaw-memory-domfirst` 由两个部分组成：

- `OpenClaw context-engine 插件`
- `ocm-memoryd 本地 memory service`

插件负责：

- `ingest()`
- `afterTurn()`
- `assemble()`
- `prepareSubagentSpawn()`
- `onSubagentEnded()`

本地服务负责暴露接口：

- `GET /health`
- `GET /stats`
- `GET /diagnostics`
- `POST /ingest`
- `POST /search`
- `POST /search/temporal`
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

### 1. 分层记忆

每条记忆都属于以下作用域之一：

- `session`
- `agent`
- `project`
- `team`

默认召回顺序保持局部优先：

- `session -> agent -> project -> team`

这可以避免不同 agent 的私有经验互相污染，同时允许同项目下的 agent 复用 `project` 层经验。

### 2. 弹性召回

系统会根据问题自动选择召回深度：

- `L0`
- `L1`
- `L2`
- `L3`

例如：

- “昨天那个问题我们遇到过对吧？”通常会走 `L1`
- “昨天那个问题具体是什么，后来怎么修的？”通常会走 `L2` 或 `L3`

这样可以减少不必要的全量记忆注入，降低 token 消耗。

### 3. 团队共享晋升

`team` 层不是自动写入的，仍然遵循“混合晋升 + 双重验证”：

- 后续独立会话再次验证
- 另一个 agent 再次复用并确认
- 用户或管理 agent 显式批准

这样可以降低错误经验污染团队层的风险。

### 4. 时序记忆

当前支持三种时序视角：

- `current`
- `past`
- `evolution`

并且现在已经支持显式时序检索：

- 插件工具 `ocm_search_temporal`
- 服务接口 `POST /search/temporal`

显式时序检索支持：

- `temporalMode`
- 自定义 `timeRange.start`
- 自定义 `timeRange.end`
- 自定义 `timeRange.label`

### 5. 记忆治理

当前版本已经具备这些治理能力：

- 来源链查询
- 候选共享审查
- 审计视图
- 对 `stale / superseded / disputed` 状态的识别
- 当前态召回对这些状态自动降权

其中：

- `current` 模式会压低过时或有争议的结果
- `past / evolution` 模式会更容易返回被替代的历史内容

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
src/domfirst/recall-plan.ts  弹性召回规划
src/domfirst/recaller.ts     SQLite 兼容召回器
src/backend/                 后端适配层
src/store/db.ts              SQLite schema 与迁移
src/store/store.ts           SQLite 兼容存储
test/domfirst.test.ts        分层与时序行为测试
```

## OpenClaw 接入

把它注册为 `contextEngine`。

可参考：

- [默认配置示例](./docs/openclaw.config.example.json)
- [本机 Graphiti 配置示例](./docs/openclaw.config.graphiti-local.json)
- [远程 Graphiti 配置示例](./docs/openclaw.config.graphiti-remote.json)

关键说明：

- 建议配置 `llm`，否则抽取质量会下降
- `embedding` 可选，不配置时会退化到全文检索
- `backend.mode = "sqlite"` 表示使用本地兼容模式
- `backend.mode = "graphiti-neo4j"` 表示启用 Neo4j + Graphiti 主核
- 在 `graphiti-neo4j` 模式下，系统会自动初始化所需的 Neo4j 约束和索引

## 服务启动

```bash
npm run service
```

常用脚本：

- `npm run service:ps`
- `npm run service:sh`
- `npm run backend:check:ps`
- `npm run backend:check:sh`
- `npm run smoke:ps`
- `npm run smoke:sh`

默认地址：

```text
http://127.0.0.1:42690
```

## OpenClaw 工具

当前插件会注册这些工具：

- `ocm_search`
- `ocm_search_temporal`
- `ocm_remember`
- `ocm_stats`
- `ocm_promote`
- `ocm_reindex`
- `ocm_inspect`
- `ocm_candidates`
- `ocm_lineage`
- `ocm_review_candidate`
- `ocm_audit`

`GET /diagnostics` 用于联调时快速查看：

- 后端健康状态
- 各作用域节点数
- 候选共享记忆数量
- 审计样本

## 当前验证状态

本地已验证：

- `npm test` 通过，`101` 个测试
- `npm run build` 通过

## 当前边界

- Graphiti 与 Neo4j 的真实联调仍依赖可用服务
- SQLite 现在主要承担消息缓冲和兼容回退
- 中文文档已修复为 UTF-8，但更细的使用示例还可以继续补充

## 许可证

MIT
