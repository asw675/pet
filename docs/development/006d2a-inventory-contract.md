# 006D-2A 背包、装备、成长投影及游戏商城契约

日期：2026-11-25，依据 V1.1 §6/§12.3/§18。前置 [006C-1](006c1-progression-rules.md)、[006D-1](006d1-item-catalog.md)。独立 subpath `@pet-desktop/contracts/inventory` 提供严格数据形状；现有 IPC、业务权威与数据库暂未接入，不将契约当功能完成。

InventoryPage revision/catalogVersion/walletCoins、版本化 definitions/stack 数量、独立装备实例/获得时间/强化级别/唯一 pet-slot/equipment bonus、真实 quote 升级成本与可负担/分解状态、shop offers、逐宠累计XP进度/战斗属性/战力/好感阶段/equipped 映射；支持历史未知 stack 和不可用旧装备明确 null/UNAVAILABLE，不假装拥有当前 catalog。上限 stacks/definitions/offers256、装备500、宠物100，严验双向唯一穿戴/槽位/版本/目录材料引用、数量与报价 affordability。

新增闭合意图 payload（尚未纳入 IPC）：SHOP_PURCHASE、EQUIPMENT_EQUIP/UNEQUIP/UPGRADE/SALVAGE、ITEM_USE；仅目标 ID/数量/目录版本/预期强化，不让 renderer 提供币价、材料成本、属性、任意奖励、路径或有效性标记。实际权威重新校验并同事务写，不能信任页面 quote。

87/87 专项测试、独立严格 NodeNext TSC 通过。完整 workspace typecheck 待并行语音/AI契约和006B集成完成；未运行真实桌面。下一步006D-2B 数据仓储、实际扣款/穿戴/强化/使用、权威查询与真实 `/inventory` `/shop` 页面，维持旧旅行和奖励历史。
