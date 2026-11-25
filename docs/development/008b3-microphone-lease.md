# 008B-3A Main 麦克风一次性授权策略

日期：2026-11-25。依据 V1.1 §9、§13.2、§20 与 [Electron Session](https://www.electronjs.org/docs/latest/api/session)、[MediaAccessPermissionRequest](https://www.electronjs.org/docs/latest/api/structures/media-access-permission-request) 明确的 permission handler 行为。该纯模块是后续 Main/native consent 接口的策略核心，未修改真实 permission handler。

- 仅可信 control-center 主 frame、当前 host 观察到的 document epoch/service generation、有效 pet/voice job 及用户明确原生同意后创建一次性 grant；不接受 renderer 自造 grant。最多一个 pending 或已消费 grant。
- 通用 permission check 始终 false；单次 media 请求必须明确仅 audio、精确文档与代次，消费未过期 grant 后不能再次请求；camera、display-capture、mixed、缺失类型、跨窗、子 frame 一律拒绝。Pending 15s；已消费不自动释放后发新 grant，以免旧录音重叠。
- Exact job/grant/owner 才可撤销。Host 锁屏/挂起/换代/重载/退出通知具体已取消 job；35s 监督时限后须实际停止或回收窗口才重新授权。真实设备录音状态与 OS/Chromium 权限运行需要后续接入及验收。

5/5 专项测试通过（未运行 Electron、麦克风）。Native dialog、permission request handler、捕获端清理及 watchdog 将在业务会话/控制中心 PTT 联通时绑定；目前主程序仍默认拒绝所有媒体权限。
