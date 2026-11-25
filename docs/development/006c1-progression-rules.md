# 006C-1 职业成长与装备纯领域规则

日期：2026-11-25。对应 V1.1 §5.3、§6.1–6.2。独立于 006A 的领取/昵称持久化和 006B 的家中调度，先建立可复用纯规则，不修改任何冻结旅行、SQLite 或奖励流水。

- `@pet-desktop/domain/progression` 保持已有累计经验曲线 `100+35×(Lv−1)`、最大Lv20（7885 XP 阈值，保留超额累计 XP）；可查询下级进度、等级阈值、好感阶段20/50/80。HP/ATK/DEF/SPD/LUK 与存储健康0–1000分离；职业模板、等级成长、装备加成按整数计算，有上限及越界防护。战力基于既有基础值加明确属性/等级增量，Lv1 无装备星咏=30、绒绒=25 保持旧 fixture。新旅行方可选择新导出战力；所有历史 trip-v1 的 frozen power 不重算、随机序列/old snapshot 不改。
- `@pet-desktop/domain/equipment-rules` 三槽（武器、防具、饰品）、品质COMMON/UNCOMMON/RARE/EPIC/LEGENDARY、实体装备 slot 与 instance 唯一性、强化等级≤5、基础/逐级加成；`evaluateUpgrade` 返回明确金币和材料成本、目标等级与加成，`evaluateSalvage` 返回少量材料，不返金币。候选公式按稀有档k与目标等级t：coin=10kt、material=k+floor((t−1)/2)，分解=k+floor(enhancement/2)。由 service 后续同事务重算、验证所有权/余额再操作；quote 不写物品或权威资源。

实测 `progression.test.ts` 49/49、`equipment-rules.test.ts` 23/23，合计72/72；domain TSC 通过，既有 trip-v1 deterministic fixture 的冻结行为保持一致。纯学科模块不算“已穿戴装备”“已强化商城”功能实现。006C-2 将采用侧车/现有角色属性投影，006D 将接 `item_instances`、`pet_equipment`、真实消耗账本与 UI；不改旧 reward_ledger/receipt。实际窗口、平台和最终数值体验待后续验收。
