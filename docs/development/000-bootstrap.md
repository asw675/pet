# 000 项目初始化及版本控制

日期：2026-11-25

## 范围

从零建立独立 `pet-desktop` Git 仓库；保存经过确认的 V1.1 原始设计、ADR、POC 验收矩阵、workspace 目录约定和开发记录制度。无业务实现、无第三方依赖引入。

## 设计基线

- 文档：`docs/design/V1.1.md`，保留经用户确认的 V1.1 原文。
- SHA-256：`e9d26714c386e9a3ad7b36dadddf4bd13ec2bc07764239ef07f94e0a2ca98f4b`。
- 技术决策：`docs/adr/0001-architecture-baseline.md`。

## 本地验证

- `git init -b main` 成功；本地存在 Git 仓库。
- 当前开发机为 macOS arm64；检测到 Node 25.6.1，全局 pnpm 10.30.3，并验证 `mise exec node@26.12.1 -- node --version` 返回 v26.12.1，作为可重复的开发候选环境。
- 当前环境访问 npm 官方 registry 的读取测试返回 `ENOTFOUND`。依赖安装和 Windows 验收仍未执行；后续优先尝试合法的离线包管理器缓存，无法获取的依赖不得伪造锁文件或测试结果。

## 下一步

先完成可独立测试的公共契约和确定性游戏领域核心；再实现 app-service 及宿主/UI；最终在 Windows 真机对照 P0 闸门。
