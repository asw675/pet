# 007C/D SQLite AI 会话、记忆与真实权威上下文（独立）

日期：2026-11-25。依据 V1.1 §8–9、§19，[007A-1–3](007a3-chat-coordinator.md)、[007B-1](007b1-memory-policy.md)。独立 `AiStateStorage` + `AiAuthorityService`，在注入现有连接与 active transaction 内工作，不能自行打开第二数据库；下一步挂载项目 v8 与实际 utility/main/preload 接入。

- schema 附加 provider config（仅 credentialRef）、逐宠精确 providerRevision/consent/assignedAt，独立 conversation/turn/message。一次请求同时写真实 USER 和唯一 pending assistant，终态 compare-and-set；重复ID/tombstone、重启未完成恢复，持久 actual persona/snapshot provenance、授权 source revisions。修改/删除源消息或变更provider授权、scope/记忆授权撤销后，旧在途 COMPLETE fail closed，回滚后可失败终态；不伪造成功。
- 候选真实 completed USER 来源、逐宠隔离；用户确认或编辑后写 PRIVATE/显名 SHARED recipient grants；可固定/编辑/删/清空/撤销，源删除同步失效、相关记忆及建议不可继续检索。SQL 授权有界读取再 lexical policy，不声明FTS或向量；删除源不追溯擦除历史助手可能引用的旧文本。摘要当前明确禁用，未实现 summarization。
- Authority 真实 pet snapshot/角色目录/受限状态/recent messages/授权记忆构建 turn，选择用户实际设置的 provider；无默认隐式云模型。允许经过现实游戏约束的本人休息/路线建议，不授予执行权限；快捷场景未挂载前 deny。主动本地规则入口独立，DND/offsite/cloud proactive 拒绝，公共只 USER；实际主动调度仍需后续。

21/21 real SQLite 持久模块、14/14 real SQLite authority、新 provider revision/授权再验证协调器专项（36/36 at development checkpoint），独立严格 Node TSC、全 app-service/desktop TSC及原生Node导入通过。未调用真实API/窗口。下一步 v8迁移挂载、异步utility和 Main 加密凭据、真实对话/记忆界面。
