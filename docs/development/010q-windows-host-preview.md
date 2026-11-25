# 010Q Windows 宿主预览与页内导航

2026-11-25。隔离运行实际发现控制中心切到设置页后可读取游戏快照，但宿主设置仍返回服务不可用。Chromium 的常规加载事件在 Vue 哈希路由变更时重置了宿主的文档就绪标记。Main 改用 Electron 的主帧跨文档导航事件管理文档权限。哈希路由和子框架导航继续使用现有文档状态，主帧重新加载仍撤销之前的授权。宿主测试直接复现页内导航后读取设置，并保留真实文档重载的拒绝用例。[Electron 导航事件](https://www.electronjs.org/docs/latest/api/web-contents#event-did-start-navigation)

Windows Electron 43.8.4 在隔离数据目录启动。应用服务和两个窗口到达 READY，控制中心设置页实际读取到三个已注册的全局热键，桌宠使用 Pixi WebGL 加载星咏 1.1.0 的后备画面。本地日志记录服务 READY 和双窗口加载。随包 SAPI 助手枚举到四种有效音色，选取简体中文音色合成得到 122582 字节的 WAV。测试在内存中检查 WAV，未使用麦克风或扬声器。

`pnpm typecheck`、`pnpm -r --if-present test --maxWorkers=2`、`pnpm build` 均通过。95 个测试文件，2444 项通过，3 项按平台条件跳过。复用已验证的同版本 Electron 与原生 SQLite，使用 electron-builder 和 NSIS 生成 x64 测试安装包。解包比对最终安装包内 `app.asar` 和新增全屏助手与暂存原文件的 SHA-256 一致。安装包 169195065 字节，SHA-256 为 `EB7898DD00462F6BFF7C0BE1BD9554D5184720E2537D9984F09B687D01393B2F`，Authenticode 状态为未签名。

隔离运行验证直接启动暂存应用。干净机器安装、真实全屏输入和混合 DPI、签名升级以及真实 Cubism 模型运行仍待验收。
