# 006D-1 物品、装备目录与游戏内商城纯报价

日期：2026-11-25。对应 V1.1 §6.2、§18；前置 [006C-1](006c1-progression-rules.md) 的三槽及强化规则。独立实现 `@pet-desktop/domain/item-catalog` 和 `@pet-desktop/domain/commerce-rules`，不触碰玩家钱包、仓库、装备/旅行或真实购买。

- ITEM_CATALOG_VERSION=1 独立不可变目录，18 项物品（原 `herb`、`slime-gel` 保持；新增森林/遗迹、强化/分解材料、ration/healing-potion、礼物和武器/护甲/饰品等 7 项装备），13 个普通游戏内 offer。装备每件独立实例，材料/补给/礼物堆叠；闭合效果数据只声明恢复或 mood/bond，不是脚本。本版本无真实付费、支付 SDK 或任意命令。
- 商品固定币价与数量限制、目录版本、引用已声明物品；装备强化/分解材料引用必须是 stack MATERIAL，严拒未知/重复ID、错槽/越界/额外字段。深冻结目录，禁止客户端改价。
- `quotePurchase(offerId,quantity,catalogVersion,walletCoins,catalog)` 只返回权威候选精确成本、数量、剩余余额与 stack/独立 +0 装备产出或明确错误；用 BigInt 计算并拒溢出，不接受客户端自由价格/装备属性，不写任何实际状态。后续 app-service 在成交事务内重新读取 wallet/目录并执行，quote 不能作为扣款授权。

实测 93 项专项（物品55、commerce38）通过，domain TypeScript、原 Node 旅行 smoke 7/7、Node26 native package alias import 通过。现有 trip-v1 算法未修改。006D-2 还需实例装备/穿戴、商城扣费、强化分解和实际界面；纯目录及报价不计作完整功能。真实窗口推迟。
