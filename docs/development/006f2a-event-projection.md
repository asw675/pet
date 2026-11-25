# 006F-2A 随机事件发生、分支与已提交效果投影

日期：2026-11-25。依据 V1.1 §7、§17，独立 `@pet-desktop/contracts/events`。与 [006F-1](006f1-event-engine.md) 对齐。

- PENDING 与 RESOLVED/EXPIRED 闭合形状，历史 occurrence identity、宠物、版本、触发来源、文本、选择与期限；只有 TRIP_RETURNED 同时拥有具体 route+trip。选择前没有奖励、资产 hash、seed 或 trigger key，无法通过客户端重新抽取。
- 已提交效果只列实际 clamped 心情/好感、币、材料、实际 CG 身份及是否首次收录；严格检查选择 ID、到期边界、已获得图鉴状态与唯一奖励行。`EVENT_CHOOSE` 意图仅 petId/occurrenceId/choiceId；实际交易需当前 revision 和权威非递减时间。
- 角色/待选/历史/全部过滤，有界每页30、稳定时间排序、真实总数及 pendingTotal，跨宠/错页拒绝。

5/5 新契约专项通过（与 travel 11/11 同轮）；实际持久触发 receipt、事件结算、事件CG和页面下一步联通，尚未计新业务完成。
