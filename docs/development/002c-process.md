# 002C 独立 Node 应用服务进程 POC

日期：2026-11-25

## 范围与契约

`src/node-process-entry.mjs` 是开发机独立 Node fork 验证入口，不是最终 Electron utilityProcess。可信父进程经启动参数给出绝对存档文件路径；子进程在打开文件前检查内置 SQLite 实际版本。仅处理闭合的 `request`、`shutdown` 帧，发送 `ready`、`result`、`stopped` 或脱敏 `fatal`；真实业务请求再次通过版本化公共 schema。数据库、文件系统和任意程序执行从未暴露给 renderer。

`AppService` 及仓储负责业务和唯一连接；收到 shutdown 或父进程断开时先关闭该连接再完成进程退出。测试以实际进程 `exit` 判定旧写者结束。生产 Main 的唯一 utilityProcess 生命周期、重启退避及崩溃监督仍需 003 实现并验收，本步骤不声称已证明多进程互斥。

## 验证与问题修复

- Node 26.12.1 原生 TypeScript 剥离不接受 TS 参数属性，改为显式字段和构造赋值，不改变业务语义。生产构建仍由后续 electron-vite 处理。
- Node 26 在父端主动断开 IPC 后可能不发 `close`，真实 `exit` 才是旧 writer 停止证据；修正子进程测试回收等待逻辑。
- Node 26 / SQLite 3.54.0：真实子进程测试 3 项通过（连接同一数据库重启、命令回执复现、非法 transport 拒绝、父端断开及启动路径），旧版本专用拒绝测试跳过。
- Node 25 / SQLite 3.51.2：旧驱动在打开持久数据库前拒绝及启动路径约束 2 项通过，持久数据库用例按版本门槛跳过。
- 本阶段完整回归：`mise exec node@26.12.1 -- pnpm typecheck` 通过；`pnpm test`（同一 Node 环境）contracts 125、domain 15、app-service 37，共 177 项通过，1 项旧 SQLite 专用用例跳过（已在 Node25验证）；`pnpm test:smoke` 7/7 通过。

## 下一步

003 构建 Electron main/preload/utilityProcess 与 Vue 两个独立入口。以本阶段 app-service/IPC 为真实业务后端，先完成透明宠物窗口和普通控制中心的最小功能，再验证受控消息、旧服务进程退出后才重启、原生驱动 ABI、Windows 窗口与安装包。P0-01、P0-02、P0-03 仍未进行目标平台真机验证。
