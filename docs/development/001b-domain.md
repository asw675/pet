# 001B 纯 TypeScript 确定性旅行内核

日期：2026-11-25

## 范围

建立 `@pet-desktop/domain`。领域包不依赖 Electron、Vue、Zod、数据库、AI、DOM 或真实墙钟；实现 P0-04 中的最小确定性旅行原型。实际物品发放、数据库结算和命令幂等由下一步 app-service 负责，当前代码不能被误称为完整放置 RPG。

## 实现内容

| 能力 | 实现 |
|---|---|
| 冻结旅行 | 版本化路线、战力、seed、预计返家时间、内容指纹；深拷贝节点和掉落配置 |
| 随机序列 | xorshift32 非零 32 位种子，固定抽取顺序及数量；V1 不是密码学随机数 |
| 离散模拟 | 最多 12 个路线节点及返程；采集、简化自动战斗、CG 事件、撤退；无逐帧循环 |
| 离线恢复 | 时间水位只前进，检查点可 JSON 序列化；一次推进和分段推进得到一致事实与奖励草稿 |
| 主动召回 | 先执行已到期节点，再按返程时间结算；未到达的节点不产生奖励 |
| 数据边界 | 版本、时间、ID、随机状态、进度、奖励结构与返程状态校验；损坏数据抛错而不自动重新随机 |
| 示例路线 | `DEMO_ROUTE` 晨露草原，采集→战斗→CG事件→返家，共 15 分钟，所有数值仅为 POC fixture |

### 对外接口

- `createTripSnapshot(input)`：调用者提供唯一 tripId、petId、seed、startAt、power 与路线定义。
- `createTripCheckpoint(snapshot)`：返回出发检查点，无奖励。
- `advanceTrip(snapshot, checkpoint, targetTime)`：返回新检查点、此次新增事实、累计奖励草稿、旅行位置及状态。
- `recallTrip(snapshot, checkpoint, targetTime)`：执行到期事件后主动返程。
- `getTripDurationMs(route)`、`DEMO_ROUTE`、`TRIP_RULES_VERSION`：路线校验、示例及规则版本。

`rewardDraft` 是累计候选而非增量，只有 `COMPLETE` 后才允许 app-service 使用唯一旅行结算 ID 产生真实奖励。事实的 eventId 为 `tripId:sequence`。下阶段应对存档事实及奖励草稿进行权威校验，不允许直接信任外部提供的奖励数值。

## 测试与审核

正式 Vitest 用例位于 `packages/domain/test/trip.test.ts`；另提供不依赖第三方包的 `test/smoke.mjs`，用于当前受限环境的真实验证。

| 检查 | 结果 |
|---|---|
| Node 26.12.1 `node --experimental-strip-types --test packages/domain/test/smoke.mjs` | 7/7 通过，覆盖固定随机金样、战斗及 CG、跨日/72 小时推进、回拨、重复推进、召回、快照和损坏状态 |
| 仓库根目录 `pnpm test:smoke` | 7/7 通过，无需安装第三方依赖 |
| 额外独立 1,000 seed 对比 | 通过；每段 JSON 重载，检查最终 checkpoint、所有事实与一次推进一致 |
| 独立代码审核代理额外 300 组随机路线、分段/召回与时间边界 | 通过（所检版本）；审核发现的状态边界随后修订 |
| 已存在的 TypeScript 6.0.3 CLI 对领域源码进行独立 strict/NodeNext/ES2022/noEmit 检查 | 通过；仅辅助验证，不代表锁定 TypeScript 5.9.3 或整个 workspace 通过 |
| 正式 Vitest 15 项、锁定 TSC 及整个 workspace 测试 | 未执行，依赖未安装，见 001A |
| SQLite 事务与重复奖励验证 | 尚未实现；属于 002 app-service |

## 下一步

用户终端安装依赖并提交真实 lockfile，通过 `pnpm typecheck`、`pnpm test` 后开始 002。先建立 app-service 数据仓库、唯一写者和持久化命令/事件结构，然后执行相同 tripId 重复提交、崩溃恢复及 SQLite 验收。P0-04 仍处于部分验证状态；没有关闭完整 P0 门槛。
