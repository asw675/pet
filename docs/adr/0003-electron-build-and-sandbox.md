# ADR 0003 Electron 运行环境与独立构建入口

状态：003 开发候选，需实际构建与 Windows POC 冻结。

日期：2026-11-25

## 决策

在 `apps/desktop` 使用 electron-vite 6 + Electron 的单一桌面宿主。按 V1.1 §15、16、22 构建独立 Main、utilityProcess、pet preload、control-center preload，以及两个 Vue renderer。四个可信/受限入口均为分别可加载的 CJS 入口。Main 与 utilityProcess 可共用无状态契约 chunk，但运行地址空间及数据库所有权独立；preload 使用 `isolatedEntries`，关闭依赖外置，保证每个沙箱 preload 不依赖其他本地 chunk。SQLite 原生驱动只从 app-service 入口外置加载，Main/renderer/preload 不导入。实际安装的 electron-vite 6.0.0 类型仅支持 preload / renderer 的 `isolatedEntries`，Main 不使用此选项。

版本候选已在清单中精确声明：Electron 43.8.4、electron-vite 6.0.0、electron-builder 26.16.1、Vite 8.3.4、Vue 3.5.41、Pinia 3.0.4、Vue Router 4.6.4、better-sqlite3 12.11.1；公共契约复用 Zod 4.3.6，TypeScript 5.9.3。候选依据为可核验的公开包清单及工具官方说明，但并不将版本号等同于实际 ABI 或平台兼容性保证。开发工具链继续使用 Node 26.12.1、pnpm 10.30.3。

## 构建验证

- `electron-vite build` 必须预期生成六个独立入口；`scripts/verify-build.mjs` 检查 CJS 文件是否独立、preload 是否只 require Electron 公共 API、Main 不携带数据库模块、utilityProcess 模块保留 native driver。禁止通过关闭 sandbox、nodeIntegration 或绕过原生 ABI 来获得成功。
- `electron-builder install-app-deps` 在实际应用依赖目录重建 native 模块。Mac/Windows 和不同架构分别验证，不跨平台复制 native 二进制。
- `electron-builder.yml` 预设 Windows x64 NSIS、普通用户安装、保留数据；安装包实际验收、签名/自动更新及 Win32 独有行为仍属于后续 POC。

参考官方资料：[Electron UtilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[ParentPort](https://www.electronjs.org/docs/latest/api/parent-port)、[electron-vite 多窗口](https://electron-vite.org/guide/dev)、[依赖处理](https://electron-vite.org/guide/dependency-handling)、[Vue Router 的本地 hash 路由](https://electron-vite.org/guide/troubleshooting.html)。
