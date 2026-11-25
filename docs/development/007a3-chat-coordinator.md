# 007A-3 逐宠异步会话与持久终态协调器

日期：2026-11-25。依据 V1.1 §8、§19，与 [007A-2](007a2-provider-adapter.md) 及 [007B-1](007b1-memory-policy.md) 联合。`ChatCoordinator` 注入同步权威 port、provider registry、credential broker。仍未接入真实权威数据库和界面。

- Public start 仅 USER，可信本地内部 proactive 单独入口且无记忆/行动候选；每宠单活、全局最多3，重复/忙/关停拒绝，取消明确旧身份。权威先事务创建 user+pending assistant、冻结本人上下文，再 microtask 异步模型；不在 await 中持有 SQLite 事务。
- 按完整 request/pet/conversation 及阶段、deadline、流序列、output mode 校验；provider/credential 只由持久设置 resolver 决定，无自动 retry/fallback 或隐式网络；晚到消息/取消后 delta 无效。重复检查当前 broker key 不泄漏（仅已知 exact key，非通用敏感内容检测）。
- COMPLETE/FAILED/CANCELLED 仅同步 CAS 一次，authority false 不发送成功终态；异常 best-effort FAILED。不可信 motion ID 限制到角色允许列表；行动建议 authority allowlist 默认拒绝，候选必须绑定真实 completed USER 来源并经 memory policy 筛查。不能执行工具、不直接写 CONFIRMED 长期记忆，权威最终还需重新验证实际来源和权限。

33/33 fake authority/provider 专项、独立 strict Node/source/test TSC 通过，未发起真实 API、未启动 Electron。下一步真实 SQLite conversation/message/memory/consent store、用户确认与 Main API/界面；不把纯协调器算成真实对话上线。
