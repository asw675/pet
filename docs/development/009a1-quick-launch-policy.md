# 009A-1 快捷工作台宿主授权与目标复核策略

日期：2026-11-25。依据 V1.1 §10、§21。参考 [Electron dialog](https://www.electronjs.org/docs/latest/api/dialog)、[shell](https://www.electronjs.org/docs/latest/api/shell/)、[security](https://www.electronjs.org/docs/latest/tutorial/security)、[Node child_process](https://nodejs.org/api/child_process.html)、Microsoft [Windows path](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)、[FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)、[GetDriveTypeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew)、[reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations)。本步为 Main-only 注入策略，不实际创建进程。

- 仅明确用户选择的本地 Win32 EXE、目录或 HTTPS；规范盘符/路径与各父级真实身份，拒 UNC/device/reparse/未确认系统工具、脚本、命令解释器、未知可执行分类；EXE完整256MiB上限 SHA256+身份/前后检查，目录真实 identity。HTTPS拒用户信息、疑似凭据参数及其他协议，只规范目标，不联网或声称网页安全。
- SAVE/RUN 单用途30秒 ticket，精确窗口 documentId/sender、当前可信版本、目标及 fingerprint；用户原生确认添加、明确已存按钮启动授权，先消费再 await 防重放，执行前再次取当前权威、复核文件及过期/窗口；撤销/失配拒绝。Launcher port 只接收已批准固定定位符，不接受命令或参数，unknown 不自动重播。没有 AI 自主执行、后台启动、提权。

122/122 注入 fake port 专项，desktop Node/test TSC通过。实际 Win32 文件识别、PE/DriveType/reparse adapter、可信用户手势、原生确认、真实固定启动与批量场景、持久化及控制中心还需接通；不宣称已防御宿主同用户恶意程序或已经在Windows测试。未启动程序/浏览器/Electron。
