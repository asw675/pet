# 001A 公共契约与运行时校验

日期：2026-11-25

## 目标与范围

从 V1.1 第 12、15、18–22 章建立第一个独立 workspace 包 `@pet-desktop/contracts`。只定义应用边界的序列化 DTO 和运行时校验，不实现 Electron、游戏存档、AI、语音或系统执行。并行开发的领域内核不依赖此 DTO 包。

## 变更

- `packages/contracts/src/index.ts`：Zod 严格 schema 与推导类型，版本常量 `CONTRACT_SCHEMA_VERSION = 1`。
- `PetSnapshot` / `AppSnapshot`：区分 `Presence`、`Activity`、`Mood`、`HealthStatus`、`Visibility` 与 0–100 数值；校验重复宠物 ID、主宠引用和在途状态一致性。
- `DomainCommand`：七类显式命令，命令幂等键、时间和 revision；不暴露通用执行或数据库接口。
- `DomainEvent`：独立事件版本与有限扁平 JSON payload；复杂事件后续使用专门的版本化类型。
- `IpcRequest` / `IpcResult` / `IpcError` / `AppBridge`：仅开放 snapshot/get 与 command/dispatch；统一错误码，订阅支持取消。
- `tests/contracts.test.ts`：正常 DTO、未知字段、错枚举、时间、数值、非法命令负载与跨字段状态规则的测试。

## 验证记录

| 检查 | 真实结果 |
|---|---|
| Node 26.12.1 `node --check packages/contracts/src/index.ts` | 通过语法检查 |
| Node 26.12.1 `node --check packages/contracts/tests/contracts.test.ts` | 通过语法检查 |
| `package.json`、`tsconfig.json` JSON 解析 | 通过 |
| `pnpm --filter @pet-desktop/contracts typecheck` | 未执行，依赖未安装 |
| `pnpm --filter @pet-desktop/contracts test` | 未执行，依赖未安装 |

## 依赖阻塞与版本策略

本地缓存索引确认为候选版本：TypeScript 5.9.3、Zod 4.3.6、Vitest 4.0.18，包清单使用精确版本。当前环境访问 npm registry 返回 `ENOTFOUND`。独立临时项目的离线安装在 pnpm 尝试向已有 store 注册项目时返回 `EPERM`，未获得安装结果。未修改系统缓存和全局配置，未创建虚假 lockfile。

下一次验证需要在用户常规终端的项目根目录运行 `pnpm install`，成功后将真实 `pnpm-lock.yaml` 独立提交，并执行 `pnpm typecheck`、`pnpm test`。直至验证通过，本步骤标为源代码已实现、正式验证阻塞。

## 下一步

与纯领域内核联合验证后，才开始 app-service 并将 DTO 映射到独立领域对象。禁止在接口仍未验证的情况下宣称 P0-02 已完成。
