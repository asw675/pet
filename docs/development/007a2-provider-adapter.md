# 007A-2 AI Provider HTTP 流与人格上下文适配

日期：2026-11-25。对应 V1.1 §8、§19。独立子代理根据官方 [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 实现 OpenAI-compatible HTTP adapter；不冒称已接官方 Responses SDK，也不默认连接任意服务。

- explicit configured provider/endpoint capability，注入 fetch/broker；限制合法 HTTPS/本地 loopback 配置，无 request-time URL、header、tool、重定向或回退。Credential 仅进入 Authorization，实际已知 key 不进入 prompt/output（含跨 delta），外部错误返回固定脱敏枚举，不透传响应正文。
- Chat Completions bounded SSE（256KiB total/64KiB event/4096 events/8000 chars/2000 delta），处理跨 UTF-8/CRLF/UTF-16，只有 stop+[DONE] 才成功；structured 只在 final 严格验证闭合 ChatReply。不执行模型行动，不自动重试。请求截止与 idle timeout、外部取消和迟到回调，明确 usage 字段。
- persona+真实 authority context 构造 prompt，保守 3000 UTF-8 字节代理预算，优先删可选历史/记忆，不偷偷截断当前用户输入；模型输入历史和记忆视为数据。显式独立 mock provider，`usage:null`，不会伪装实际云请求。

61/61 fake-fetch 专项通过、与项目同 strict Node/DOM 配置独立 TSC 通过。未发起真实 API 或提供凭据，未启动 Electron。下一步逐宠会话协调及单写者 durable messages、配置/安全凭据 broker、控制中心真实对话。
