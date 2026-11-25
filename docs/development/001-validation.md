# 001-V 依赖安装及完整测试验证

日期：2026-11-25

## 前提

用户已在常规终端完成 `pnpm install`。检查确认项目根目录存在实际生成的 `pnpm-lock.yaml`、workspace `node_modules` 与包内工具链接。此次提交冻结目前测试过的依赖解析结果，不人工构造锁文件。

## 验证结果

| 命令 | 真实结果 |
|---|---|
| `pnpm typecheck` | contracts、domain 均通过 TypeScript 5.9.3 |
| `pnpm test` | contracts 125/125、domain 15/15，共 140 项通过 |
| `pnpm test:smoke` | 7/7 通过 |

执行环境是 macOS arm64、Node 25.6.1、pnpm 10.30.3；未做目标 Windows 实机验证。001A、001A-R 与 001B 的依赖验证阻塞解除，现进入 002。完整 P0-02/P0-04 仍需服务、持久化、结算与安装验证。
