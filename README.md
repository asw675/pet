# Pet Desktop

从零开发的 Windows AI 桌宠，包含独立多角色、离线放置 RPG、随机 CG、AI 陪伴与桌面助手的长期架构。当前仍在 P0 技术验证阶段，不宣称完整产品已经实现。

## 开发导航

- [V1.1 产品与技术设计基线](docs/design/V1.1.md)
- [开发记录索引](docs/development/README.md)
- [架构决策](docs/adr/0001-architecture-baseline.md)
- [POC 验收矩阵](docs/qa/poc-matrix.md)

## 工具链

使用 Node.js、pnpm workspace 和 Git。具体依赖版本是 POC 候选值；Windows 真机、实际安装包、原生模块兼容性验证通过后才冻结。Mac 可以开发并验证纯逻辑、编译与桌面原型，但不能替代 Windows 宿主验收。

开发阶段的每次提交必须记录完成范围、实际验证、失败原因和待验证项。不要将尚未执行的测试标为通过。

### 当前开发环境验证

```sh
pnpm install
pnpm typecheck
pnpm test
```

当前只有公共契约和纯领域开发阶段，不存在可直接运行的 Electron 应用；`pnpm dev` 将在宿主与双 renderer 原型完成后启用。首次依赖安装成功后应提交真实生成的 `pnpm-lock.yaml`。

## 目标环境

Windows 11 x64 优先，Windows 10 22H2 x64 作为兼容性验证环境。分阶段支持序列帧、经授权的 Live2D、AI、语音和快捷入口。
