# Pet Desktop

从零开发的 Windows AI 桌宠，包含独立多角色、离线放置 RPG、随机 CG、AI 陪伴与桌面助手的长期架构。当前仍在 P0 技术验证阶段，不宣称完整产品已经实现。

## 开发导航

- [V1.1 产品与技术设计基线](docs/design/V1.1.md) · [二次元美少女视觉方向](docs/design/character-art-direction.md)
- [开发记录索引](docs/development/README.md)
- [架构决策](docs/adr/0001-architecture-baseline.md) · [Electron 构建与沙箱](docs/adr/0003-electron-build-and-sandbox.md)
- [POC 验收矩阵](docs/qa/poc-matrix.md)

## 工具链

使用 Node.js、pnpm workspace 和 Git。具体依赖版本是 POC 候选值；Windows 真机、实际安装包、原生模块兼容性验证通过后才冻结。Mac 可以开发并验证纯逻辑、编译与桌面原型，但不能替代 Windows 宿主验收。

开发阶段的每次提交必须记录完成范围、实际验证、失败原因和待验证项。不要将尚未执行的测试标为通过。

### 当前开发环境验证

```sh
pnpm install
mise exec node@26.12.1 -- pnpm typecheck
mise exec node@26.12.1 -- pnpm test
```

纯旅行领域的依赖无关 smoke 已可运行：在项目根目录执行 `pnpm test:smoke`。

完整 SQLite POC 测试需 Node 26.12.1（或后续验证过且 SQLite 满足项目版本门槛的开发环境）；旧 Node 25 的内置 SQLite 3.51.2 不满足本项目文件数据库门槛。依赖变更应提交真实生成的 `pnpm-lock.yaml`。

### 桌面原型

003 已建立 Electron Main、独立本地服务进程、两套受限 preload、两个 Vue renderer。004 加入人形二次元少女内置资源/Canvas2D 序列帧降级、跨窗交接及实际历史 CG 图鉴。首页、宠物馆、旅行地图、报告、图鉴、设置使用真实服务数据；其余功能入口仍明确标记待开发。正式 Pixi WebGL、精细美术、Live2D 与 Windows 真机验证尚未完成。

```sh
mise exec node@26.12.1 -- pnpm --filter @pet-desktop/desktop exec install-electron
mise exec node@26.12.1 -- pnpm --filter @pet-desktop/desktop rebuild:native
mise exec node@26.12.1 -- pnpm build
mise exec node@26.12.1 -- pnpm dev
```

Electron 的运行时二进制及 native addon 必须在当前平台安装、重建。`pnpm build` 会验证独立入口和沙箱 preload，生成 `apps/desktop/out/`；开发存档单独写到 `apps/desktop/.data/development/`。原型的游戏命令接入本地业务服务，不使用模拟数据替代持久化。实际运行和平台发布的验证状态以 [POC 矩阵](docs/qa/poc-matrix.md) 为准。

## 目标环境

Windows 11 x64 优先，Windows 10 22H2 x64 作为兼容性验证环境。分阶段支持序列帧、经授权的 Live2D、AI、语音和快捷入口。
