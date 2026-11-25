# 008B-1 真实 Web Audio 录放音与口型适配器

日期：2026-11-25。依据 V1.1 §9、§20 和 [008A-1](008a1-voice-contract.md)。本步将纯语音状态机的 effect 接到浏览器实际接口；Main/renderer PTT 生命周期和语音供应商业务后续联通。

- `WebAudioVoiceAdapter` 注入 broker request/revoke 和设备/AudioContext 依赖，必须从明确 PTT 手势开始；授权属于 exact voice job，迟到 grant/stream/worklet/decode 释放。最多一个未结束的设备申请与解码，避免不可 abort 的浏览器 Promise 积压。
- `AudioWorkletProcessor` 静态本地资源、63-tap windowed-sinc FIR，持续相位并单声道 downsample 16kHz PCM16 批次，严格 frame 与录音墙钟限制≤30s。停止即时释放 mic、撤销 grant，最多250ms flush 后封装有界 WAV；取消不提交音频，不保存原始文件，不使用远程/blob脚本。
- 用户手势同步预热播放 context，验证 WAV/PCM 后 decode→source→gain→analyser→destination；采样真实 `context.currentTime-startAt` 与 post-gain RMS 给 exact job 口型。停止/换宠/错误/超时清理资源，无旧回调污染。

28/28 新音频专项；合并 coordinator/RMS 62/62；renderer Vue TSC 通过；独立 Vite8 build 实际生成本地静态 `audio-capture-worklet-*.js`。测试通过注入 fake 对象，无真实麦克风/音频/设备/网络/窗口调用。Windows Chromium file CSP、权限 broker、autoplay 与设备时延尚需实际验收；provider 未接入期间仍文字降级。
