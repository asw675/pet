# 010B Windows x64 测试安装包构建

日期 2026-11-25。依据 V1.1 第 22 节，保留原生文件 SHA-256 门禁。新增 Windows x64 构建步骤，从固定的 Whisper.cpp v1.9.2 提交编译 CLI，并构建仓库内的 SAPI 和应用启动检查辅助程序。安装目录现在与语音服务固定查找的 `native/voice/win-x64/` 一致，打包后检查辅助程序哈希、x64 可执行文件与 SQLite addon；保留 Whisper 许可文本。模型文件仍由用户另行准备。

GitHub Actions 在 Windows 2022 上运行锁定依赖安装、类型检查、测试、原生构建和 NSIS 安装包检查。结果作为构建工件保存，不发布 GitHub Release。安装包采用未签名测试配置。

Mac 已执行生产构建和六入口检查，验证锁文件与项目匹配，并解析工作流和打包配置。Mac 无 Windows 辅助程序，直接运行 Windows 打包在原生文件门禁报缺少 Whisper CLI。Windows 构建结果以工作流实际运行记录为准。真实安装、升级、卸载、GPU、语音和宿主行为仍待目标 Windows 真机验收。
