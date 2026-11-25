# 008B-2 本地 STT/TTS 供应商与 Windows SAPI Helper 源码

日期：2026-11-25，依据 V1.1 §20.2–20.4。实现 LocalVoiceProviders、固定工件校验及单任务实际进程接口；Windows 二进制尚未发布，缺工件/哈希明确 UNAVAILABLE，不伪装语音成功。

- Whisper.cpp 固定 win-x64 `whisper-cli.exe`、内部固定参数与固定 Bundled root；模型 multilingual base/small 按 [官方模型固定版本](https://huggingface.co/ggerganov/whisper.cpp/tree/fb5ed9369c26eaf08392504d8446da431e0fffb9) SHA-256，工件 digest 必须由发行配置提供。仅 bounded PCM16/WAV、隔离临时目录、受控输入输出（UTF8/大小/100ms监测/有界读取，非内核quota）、shell:false、无自由参数/路径，取消/超时等待真实 close，未确认终止时隔离不并发、迟到 cleanup。无 PATH/GPU/模型自动下载或 cloud fallback。
- `native/sapi-helper/` .NET 10 Windows/System.Speech 10.0.0 win-x64 helper 候选源码：固定 JSON stdin 指令枚举/合成，实际启用 system voices、精确 ID/名称/locale/选中复核、plain Speak 限长，bounded WAV stdout，不读任意文件、不接 SSML、不直接扬声器播放。文档附真实 Windows restore/build/license 与 digest 发布步骤，未运行 helper。

24/24 fake processes + 真实隔离 synthetic temp FS 专项、desktop Node TSC pass。官方 [whisper.cpp v1.9.2](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2)、[CLI](https://github.com/ggml-org/whisper.cpp/tree/master/examples/cli)、[Node child process](https://nodejs.org/api/child_process.html)，SAPI官方资料在 helper README。尚未下载模型/编译Windows需依赖的二进制/调用实际麦克风或语音 API；与真实 provider status/权限/控制中心会话联通后再验收，不关闭语音平台 POC。
