# 006B-1 家中活动与离线需求纯规则

日期：2026-11-25。对应 V1.1 §4、§6.1，独立于 006A 正在开发的角色库；仅实现纯领域 `@pet-desktop/domain/home-simulation`，不改已有 trip 模拟和真实存档。用户要求真实窗口验收延后。

`HomeSimulationState` 组合位置、活动、情绪、健康、0–1000 固定点 needs 与 `lastSimAt`、`activityDueAt`、三个积分余数、UTC 奖励日/计数/最后有效互动时间。初始化只从已知逻辑时间起算，不凭空补旧收益。`advanceHomeState` 用整数/BigInt 商余积分，长离线 O(1)/有界活动到期，逻辑时钟回拨夹紧；HOME 每小时恢复20能量点，health 及 mood 向中性默认每小时10点，不衰减长期好感，数值饱和清余数；AWAY/RETURNING 不获得家中恢复。服务返家时必须用真实 `actualReturnedAt` 重置 HOME 时间起点，再推进到当前水位。

低体力休息/睡眠有独立 enter/exit 阈值，手动 REST 不瞬间加数值；WAKE 有安全 awake grace。有限 INTERACT/EAT/CELEBRATE 到期返回基础状态，CHAT/DRAG 保持外部 owner；按稳定 pet ID 与绝对五分钟 slot 产生有限走动，避免逐帧/随机重抽。`interactHome` PET 有 30 秒冷却、UTC 每日10次奖励上限；超限允许视觉反馈但无额外 mood/bond；HOME/AWAY 规则分离。以上候选数值集中配置，UTC 日作为确定性首版计量，不将其冒充本地日历已实现。

实测 `test/home-simulation.test.ts` 27/27 通过、domain tsc 通过：72h 分段比较、BigInt 安全时间、回拨、饱和、离家/返家、不同角色移动独立、同刻/跨日/超限、活动到期。未修改实体状态、SQLite、renderer 或真实窗口。下一步 006B-2 单独迁移持久时钟、在既有 app-service 唯一写入事务接入；不因纯计算函数提高当前产品功能评分。
