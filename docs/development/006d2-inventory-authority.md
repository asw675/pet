# 006D-2B/C/D 成长、背包、装备、商城真实闭环

日期：2026-11-25。依据 V1.1 §6、§12.3、§18，前置 [006C-1](006c1-progression-rules.md)、[006D-1](006d1-item-catalog.md)、[006D-2A](006d2a-inventory-contract.md)。三个子代理分别实现 v5 仓储、权威业务、Vue 页面，再交叉复核，不只建静态页面。

## 权威数据与交易

- SQLite 005 additive：独立装备实例（版本、强化、获得时间；回收后不可复用 ID 的 tombstone）、唯一 `(petId,slot)` 与唯一 instance 归属，操作流水及受约束的材料/购买实例关系行。旧 001–004 SQL 校验和逐字节不变 `9d3ced6f/a0036d79/519a9ef3/0f3c0f0e`；新 005 实测 `fnv1a32:16a20fb2`。真实 v4 备份升级、失败回滚，历史库存、trip、奖励账本、CG、家中水位、回执保留。
- 六种闭合命令：`SHOP_PURCHASE`、`EQUIPMENT_EQUIP/UNEQUIP/UPGRADE/SALVAGE`、`ITEM_USE`。全部 strict mandatory expectedRevision、目录版本与目标，客户端无币价/属性输入。真实 quote 重新核算，原子扣除游戏币/材料、创建唯一装备、同槽明确确认后原子替换、禁止从其他宠直接抢装备、升级+1上限5、仅未装备回收；消耗/礼物仅HOME非CHAT/DRAG、精准上限及EAT恢复安排。不涉及真实支付。
- 单次成功必须同事务有 immutable commerce operation + exact command receipt、revision 与余额一致；失败无 operation，重复历史命令返回原始回执，不复制奖励或扣费；数据库验证身份、关系与终态，金额/材料 before→after 的游戏规则由 service 事务负责，不能声称 DB 单独证明全部余额差额。现有 trip reward ledger FK/历史字节不改。逐宠实际等级/职业属性/战力、三槽和版本 bonus；装备可在途调整，但只有未来新出发使用新 battlePower，不重算历史 trip-v1。

## 实际控制中心及兼容审查

`inventory/list` 返回 coherent snapshot/revision/wallet/宠物身份与 XP、目录、持有数量、真实装备 quote 与逐宠成长。ControlCenterBridge 仅暴露该闭合查询，pet/子 frame 无权查询/改商业状态。`/inventory` `/shop` 真实页面：选角色、属性/经验、装备与材料、购买数量确认、功能可用性、费用/替换/销毁明确二次确认；任何 stale epoch/revision/报价重新确认，无本地发奖或自动重试。

独立审查复现两个旧档边界：旧 stack ID 可与现代装备重名，及超过256历史栈后新旅行奖励可能使投影失败。现全部已修：兼容 stack 始终完整，旧/不兼容 stack 明确 LEGACY_UNKNOWN（不借现代装备名/效果、不转换），独立128条/页 offset+total，游戏新栈容量256不被历史记录阻塞。真实 v4→v5含261历史栈迁移、新旅行结算、购买及后续原始行数量一致验证。

## 实际验证

- app-service 206 通过、1 环境专用旧分支跳过（记忆策略93、仓储52、service35、真实 SQLite19、备份4、实际 Node 4；测试为重叠阶段的全包总数）。真实游戏赚取40币→购买、换装、独立归属、强化、消费、回收，始终保留旧冻结输入和前五次历史账本；重复回执重启、注入终态失败全回滚。
- contracts 555/555；desktop 相关 172/172（29库存页面策略、85 preload、19 Main、7 store、11 service-client、21 utility transport）；业务/契约 TS、Vue/test TS 已通过。未启动真实窗口；实际 Windows 平台仍未验收。

原有固定75项口径：成长职业、属性、背包、共享货币、装备/强化已接实际权威和界面；区域解锁需下一步三条路线资格接入，平台验收独立。下一步006E-2B/C/D 旅行资格、实际出发冻结物资/属性、完整报告；006F-2 权威随机事件。
