# 007A-1 AI 逐宠人格与 Provider / 记忆契约

日期：2026-11-25。对应 V1.1 §8–9、§19；游戏 006 集成并行，先以独立 `@pet-desktop/contracts/ai` 冻结严格边界。没有接外部 API，不写聊天/记忆数据库，也不改变任何游戏存档。

- ProviderConfig 分开端点种类（官方 Responses/兼容/Anthropic/Ollama/MOCK）、LOCAL/CLOUD/MOCK 隐私、配置 baseUrl/modelId、opaque credentialRef、能力/预算/超时。URL 只允许明确设置 HTTPS 或本机 loopback，拒绝 userinfo/任意 query/fragment/路径混淆；实际 key 不在任何 DTO、日志、renderer 或模型请求上下文；运行时端点由可信注册表解析，模型与输入无权覆写。
- 逐 `petId/conversationId/requestId` 的用户/主动/摘要/记忆抽取 TurnRequest 和 context（版本化 persona、当前同宠游戏事实与 revision、同宠完成近轮、授权记忆、受限摘要），验证身份、来源/数量/长度。流事件 `textDelta/final/error/cancelled` 同身份和 sequence；structured/JSON/text 结果闭合 Zod，usage 有界，JSON Schema 可导出；纯文本 fallback 没有提议或候选。
- `ChatReply` 发语义情绪/动作表现、有限建议草稿和记忆候选；action 只接受类型/授权目标 ID/理由，禁止任意命令、路径、自由参数，真实 proposalId/petId/expiry/确认要求由可信层生成。记忆草稿包含 user 来源 ID、scope/type/summary/置信度，不能自己成为生效/共享记忆；仅人工确认、指定 recipient 授权及可信检索后可进入实际上下文，模型没有 OS、数据库或奖励写权限。

136 项专项测试全部通过，contracts TSC 通过；覆盖端点分类、严格闭合形状、错宠/会话、来源、stream/elements、授权草稿与安全出错路径。当前 schema 不是实际 AI 或隐私权限的运行证明；后续真实 Provider 适配器、凭据 broker、取消/限并发、SQLite 逐宠会话和长期记忆、UI 与受控授权仍需实现。用户要求实机及真实模型调用延后，不为纯契约给功能完成度加分。
