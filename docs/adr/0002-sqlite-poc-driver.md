# ADR 0002 SQLite 开发机验证驱动

状态：已采用用于 P0 本地验证；生产驱动未冻结。

日期：2026-11-25

## 决策

应用服务以 `SqliteConnection`（同步 exec/prepare/close）及 `AppRepository` 作为窄接口。业务用例不感知 SQLite 原生模块、Node API 或 Electron。

本次开发机持久化 POC 使用 `node:sqlite` 的 `DatabaseSync` 适配接口，既能在真实 SQLite 文件上演练迁移、事务、重启和结算，又不额外依赖 Electron 的原生 ABI。V1.1 中的生产主选 `better-sqlite3` 保留：后续 Electron 安装包必须验证独立 utilityProcess 中的实际可用性、模块 ABI、打包及驱动功能。未通过前不宣布数据库技术冻结。

## 环境证据

本机执行 `SELECT sqlite_version()` 与 FTS5 建表探测：Node 25.6.1 内嵌 SQLite 3.51.2；Node 26.12.1 内嵌 SQLite 3.54.0，均能创建 FTS5 表。本项目 POC 采用保守统一的版本门槛 SQLite 3.51.3 及以上；特定旧版修复回移不在此次支持矩阵。故持久化测试使用已安装 Node 26.12.1，旧版 SQLite 的测试应明确跳过相关持久化用例或验证拒绝，不绕开版本门槛。

依据见 [设计基线第 18 章](../design/V1.1.md)，SQLite WAL 官方说明：https://www.sqlite.org/wal.html 。

## 后续约束

文件数据库使用 WAL、FULL 同步、外键、单写者、事务回滚和显式 SQL 迁移；内存数据库仅用于测试。存档不随仓库提交，测试文件放入独立临时目录。仅在 Windows/Electron 真实打包验证达到 P0-03 后更新此 ADR 的生产冻结结论。
