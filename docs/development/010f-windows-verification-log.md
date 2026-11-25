# 010F Windows 测试诊断与备份文件忽略

日期 2026-11-25。Windows 作业失败时把测试日志末尾加入作业注解，便于定位 Windows 专属错误。导出的 `.sqlite3` 文件、SQLite 附属文件和导出临时目录加入 Git 忽略范围。

已用本地 `git check-ignore` 验证三个备份文件路径。Windows 打包继续待 CI 验证。
