# ADR 0001 独立项目与技术基线

状态：已采用作为 POC 基线；依赖版本冻结待验证。

日期：2026-11-25

## 决策

- 独立 pnpm workspace，TypeScript 作为统一领域和契约语言。
- Electron Main 负责桌面窗口、托盘、系统权限与受控 IPC；app-service 独立 utilityProcess 持有 SQLite 唯一写入权威；Vue renderer 只读投影并发送明确命令。
- 游戏内核不依赖 Electron、Vue、SQLite 或模型 SDK；离线旅行基于冻结快照、确定性随机序列与幂等事务。
- 基础角色使用 PixiJS/序列帧，Live2D 接入另行完成 POC 和授权；AI、STT/TTS、记忆和快捷工具通过窄接口扩展。
- 工程主选 electron-vite、electron-builder NSIS；真实安装包及 Windows 测试是冻结前置条件。

## 理由

具体候选对比、官方资料、风险与验收见 [设计基线](../design/V1.1.md) 第 15–23 章。此 ADR 只记录采用基线，不宣称已验证。
