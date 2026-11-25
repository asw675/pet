# 009A-2/B-2 快捷工作台、场景及隐私推荐独立存储

日期：2026-11-25。对应 V1.1 §10、§21，[009A-1](009a1-quick-launch-policy.md)、[009B-1](009b1-recommendation-rules.md)。独立 `@pet-desktop/contracts/workspace` 和 `WorkspaceStorage(connection,inScope)`；同一 SQLite 写者的增量 SQL 已准备，但尚未挂载项目全局迁移。

- 清晰分离 native-approved 内部目标与 renderer/AI 投影：真实定位符、fingerprint 只 Main/authority，UI ID/name/kind/revision/安全basename/domain，AI只可推荐目标 ID/name。已批准目标修改/复核/撤销、精确版本、场景最多12个有序收藏、串行/并行(delay0)、失败策略、避免重复、引用更新与删除。未获批准不构成启动许可。
- 默认统计禁用；仅曾由本软件发起且已允许的结果写入 `launch_history`（target/run/source/outcome/5分钟时间桶+offset），不保存路径、页面、进程信息。当前 action revision 校验防止旧执行训练换过的目标；重批准清除旧使用，撤销/删除/关闭/清理按请求处理。7/30天留存、最多1000事实、真实 impression 每日≤2，清历史不重置频率预算；仅推荐仍启用已批准目标，采用现有规则，不自动启动。
- `WORKSPACE_MIGRATION_SQL` 是 additive tables/索引/关键 triggers，class不自行打开连接/事务，后续将挂 v9。当前只证明独立持久模块，无实际 UI/已批准 launch 调用、批量流程或真实平台执行。

53/53 contracts、17/17 real Node SQLite（内存+文件重开），contracts 全包TSC、独立storage strict ES2022与原生Node导入通过。未启动实际应用、网络、窗口。
