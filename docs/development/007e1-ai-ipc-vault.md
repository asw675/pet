# 007E-1 主控 AI 闭合意图及加密凭据仓

日期：2026-11-25。依据 V1.1 §13.2、§19，[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) 官方异步 API。`ai-ipc.ts` 便于实际 IPC 分层；本步尚未打开 Main IPC 或实际调用 OS 凭据仓。

- 用户设置/会话与分页/消息编辑删除/纯USER chat start-cancel/待确认行动建议/记忆确认编辑删除撤权等20个闭合 method，明确 scope/revision/transport ID vs turn ID、严格结果形状/跨方法检查；不接受客户端权威上下文、任意操作、模型地址透传或秘密。凭据写入入口独立于所有 AI conversation/result，credential lookup仅Main→受信utility。
- `CredentialVault` 采用 async Electron safeStorage port，拒不可用或Linux basic_text；provider+reference绑定加密 envelope、SHA256固定文件名、仅1–8192 ASCII安全头部字符、≤64KiB密文、app-owned目录临时wx mode0600+sync+rename，串行写/撤销；错误/腐败/错scope fail closed，不记录原文或给renderer读接口。测试只使用临时目录 and synthetic AES-GCM，不实际触碰用户Keychain/DPAPI。不是对同用户恶意软件的防御承诺。

10/10专项（5 API+5真实临时目录合成密钥测试），Node TSC通过。未来真实 UI save/撤权、Main受信窗口、utility关联凭据请求与精确provider授权再验证，均不得保留原始key日志；不默认连接任何模型。
