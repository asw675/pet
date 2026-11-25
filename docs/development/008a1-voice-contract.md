# 008A-1 独立语音契约、会话调度、口型采样

日期：2026-11-25。依据 V1.1 §9、§16，先实现开发级的闭合控制层，不把语音 DTO 当录音或 TTS 完成。

- Local 与 Cloud 各自配置及明确授权；每次手动 PTT 绑定宠物/请求/会话代次，STT、chat、TTS 各自阶段、错误、取消、provider 回执；禁止隐式混用账户或自动云回退。30 秒、16kHz mono PCM16 WAV，严格 RIFF chunk/frame 与音量、字节上限，拒绝共享 buffer 或畸形数据。
- 一个全局 coordinator 代次，新的请求先停止旧音频、清空旧口型、释放旧 tracks，再取消准确的旧 STT/chat/TTS；迟到权限 grant 立即释放，失配阶段/身份/请求丢弃。静音或 TTS 失败时保留已完成文字。
- `PlaybackMouthSampler` 接入外部提供的真实播放位置及 post-gain waveform，RMS 映射既有渲染 MouthSample；可选 viseme，旧 job 不能污染新口型。当前无真实声音输入源/播放器。

16 项 contracts、34 项 coordinator/RMS（50/50），contracts TSC、renderer vue-tsc 均通过。下一步真实 WebAudio capture/playback 适配、显式 Main 麦克风权限、实际本地 STT/TTS 供应商和控制中心会话接入；尚未调用麦克风、网络或启动 Electron。
