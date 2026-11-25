# 007D-1 统一 SQLite v8–v10：AI、工作台、逐宠语音

日期：2026-11-25。将此前独立 [AI](007c-ai-storage-authority.md)、[工作台](009a2-workspace-storage.md) 和语音配置存储挂载到已有唯一 SQLiteRepository connection。没有另建 JSON 或独立数据库写者。

- 008 AI schema `fnv1a32:eb3b9ef0`、009 workspace `08f24fcd`、010 voice profiles `233919ba`；原001–007 SQL checksums 保持不变。真实v7/v8/v9归档升级备份、DDL失败回滚、v7→v8成功后v9失败的有效历史处理；原pet/home/gear/trip/CG/event/receipt完整保留，新provider/target/remembered facts不伪造。
- `AppTransaction.aiState()/workspaceState()/voiceProfiles()` 挂同一活动连接及 guard，跨模块同事务原子commit/rollback、退出scope禁止访问、真实文件/WAL重启。没有外部工具改库、没有双写。
- VoiceProfile 每宠 revision CAS，未配置返回 revision0 默认本地STT、TTS disabled（不插假行）；实际枚举的 SAPI voice 才允许选入，可信授权 scope/ref 才允许新云配置，未接云服务不回退；已提交同pet/conversation/request assistant才可取供合成，没有原始音频存档。复原默认保持单调revision。已修原生 Node strip 的参数属性和运行时alias，不改变010 SQL。

实际 voice-profile 独立12项、native repo84/84；全app-service 320通过1环境专用旧case跳过，TypeScript、真实Node子进程及旧档迁移测试通过。尚未启动真实桌宠、配置外部 API/本地语音工件。真实 renderer/utility服务联通在007E/008C/009E。
