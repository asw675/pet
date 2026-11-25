# 006E-1 三路线目录与出发准备纯规则

日期：2026-11-25。对应 V1.1 §5.1–5.4、§18.3。独立子代理实现 `@pet-desktop/domain/route-catalog`、`@pet-desktop/domain/trip-preparation`；不修改已冻结的 trip-v1 模拟、现有 DEMO_ROUTE/奖励或实际服务数据。

- 晨露草原原 `morning-dew-meadow` 对象及 15 分钟/15精力规则保持；新增 `mist-forest` 迷雾森林 Lv4/60min/30精力/ration×1，`starfall-ruins` 星落遗迹 Lv10/4h/50精力/ration×2+healing-potion×1。固定版本、风险、标题、节点、掉落目录/物资及限定时长，素材用既有 herb/slime-gel 及新 forest-wood/ruin-shard 等真实 item IDs。新路线初版仅 GATHER/BATTLE，不伪造尚未准备 CG 的图像，不通过未实现补给战斗加成宣传复杂战斗。
- `previewTripPreparation` 只读权威输入候选：路线版本/存在性、HOME、无在途、健康、等级、精力、精确有限的已选且存在补给。输出明确拒绝原因及精确 consumption/duration/energy，不接受客户端战力或任意路线，不写币/物资/快照；真实提交须服务在同事务重新校验并冻结新 travel loadout。原草原无需强制补给，避免贫穷宠物无路可走。

实测 74/74（route 17、preparation 57）通过，domain TSC、原7项 Node26 smoke 通过，实际 native package subpath 导入成功。森林/遗迹各64 seed×power、one-shot vs 多段JSON恢复一致/召回不结未发生节点；`src/index.ts` 未改。006E-2 还须接真实三路线、入场消耗、冻结装备和完整历史报告。用户要求实际窗口仍推迟，不将纯报价虚计为可出发功能。
