# 006F-2C/D 随机事件真实触发、选择、结算和CG图鉴

日期：2026-11-25，依据 V1.1 §7、§17、§18，[006F-1](006f1-event-engine.md)、[006F-2A](006f2a-event-projection.md)、[006F-2B](006f2b-narrative-cg-assets.md)。存储、权威调度、实际界面分别独立开发并交叉复核。

- 四类触发 HOME_DAILY(60%)、AFTER_INTERACTION(35%)、TRIP_RETURNED(60%)、BOND_MILESTONE(100%)，单宠最多3个待选。当前 UTC 日 HOME 一次、不补抽历史缺失日期；有效互动奖励才触发，冷却/重复命令不再抽。返家按冻结 actualReturnedAt；好感实际跨 20/50/80 点时一次，旧档不 retro，当前前置不满足也消费该阈值，后续新阈值可触发。独立 event-v1 RNG seed、唯一触发键，NO_EVENT（含机会未中/无适用/容量）同样持久，重启不 reroll。
- 真实权威调度 merge 返家及选项 deadline 按逻辑时间，先进行对应宠家中模拟，再应用 clamped 心情/好感、精确币/材料/CG效果；截止时使用冻结默认分支，用户选择/在途选择与过期同规则 CAS，不能重复发奖。不重写已出发 trip-v1、原旅行奖励。选择 EVENT_CHOOSE 必须当前 revision、owner和选项，事务统一修订，互斥回执。
- SQLite 007 additive 事件触发receipt、immutable frozen occurrence、finalizations、独立 event_effect evidence、event CG acquisition，不造虚假 trip FK。v1–6 SQL checksums 原样，007 `fnv1a32:049ff093`；新表与历史 v6 备份及回滚，选项 success receipt精确 intent/revision/time/wallet，冻结branch与已提交effect 不矛盾。事件和旅行图鉴源独立，首次 `(petId,cgId,variant)` 跨源唯一，实际 pinned CG、收藏/首次查看、历史资源仍检验 exact hash，两个真实新增工程剧情CG可解锁。
- `events/list` 同 snapshot revision/角色归属、分页/筛选，ControlCenterBridge 精确 method/filter/offset，桌宠窗口无权选择或查询。`/events` 真正事件箱：待处理/已结束/全、角色筛选、实际时限、明确选择确认、已结算结果/实际效果/CG入口；HOME 首页权威 pendingTotal/最新故事，仅 revision/代次信号去抖，无定时偷窥或自动点击。无本地奖励或重新抽取。

## 实际证据

app-service 298通过1原环境跳过（其中事件/旧业务39 memory、74 native repo、33真实SQLite、4备份、4真实Node；其余是独立记忆/AI/工作台尚未挂载的存储测试）。新的真实 SQLite 验证生产概率、NO_EVENT重启、cap、有效互动、好感阈值与前置、离家选择、饱和、按实际返家及到期时间、CG first provenance、跨源收藏 viewed、故障回滚。独立审查发现原生 Node strip 不支持 TS parameter property，已经改成显式字段并实际 Node子进程回归通过，非把错误埋到后续。

contracts 615/615（含新workspace/voice/AI/旅行契约，非全算事件）；desktop 164/164（46事件页面/真实Vue生命周期、87preload、21Main、10gallery）。app-service TSC、Vue及test TSC通过。未启动实际窗口。下一步AI/记忆、语音及工作台全链路挂载。
