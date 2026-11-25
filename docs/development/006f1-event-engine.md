# 006F-1 随机剧情、分支及冻结事件纯规则

日期：2026-11-25。对应 V1.1 §7、§17，独立事件 RNG `event-v1`，不改变既有旅行 RNG、冻结快照或奖励账本。

- 版本化 `EventDefinition`、触发 HOME_DAILY/AFTER_INTERACTION/TRIP_RETURNED/BOND_MILESTONE、条件组合、同角色历史前置、冷却、次数限额、机会与加权选择；固定输入与排序下可重放。重复 source/triggerKey 由历史检测，包括无事件结果。持久化层必须为每次有效 trigger 保存 receipt，不能靠重新抽取冒充幂等。
- 选择产生冻结 occurrence（角色、触发来源、版本、文本、选项/默认分支、到期、效果），显式用户选择或可信时间到期；重复/跨宠事件不能再兑现。限制效果与选择数量、文本和数值范围；CG 仅接受精确历史身份/版本/hash，FUTURE_UNAVAILABLE 不授予 CG；历史重放不以当前目录覆盖旧 pin。旅行触发必须同时包含 routeId/sourceTripId，其他触发不能伪造旅行来源。
- 六项实际内置少女原创剧情，三位各有内容，包含茶会/星光笔记/工坊和旅行归来等情节。分支产生好感、心情、游戏币、真实已存在材料的效果草案；目前两个未来 CG 标记明确不可用。实际事件确认、权威事务扣账/发奖、CG 资产及页面均在后续步骤，不将此纯模块计作随机事件产品完成。

独立接手复核：event-engine 49/49、event-catalog 15/15（64/64）；domain TSC、原 trip-v1 native Node smoke 7/7、实际 package subpath 导入与冻结 JSON replay 通过。未启动应用。
