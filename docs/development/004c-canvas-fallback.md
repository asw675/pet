# 004C 真实序列帧 Canvas2D 降级与桌宠投影接入

日期：2026-11-25。对应 V1.1 §17.3–17.6。前置 [004A](004a-character-packs.md)、[004B](004b-rendering-core.md)。本次是能播放内置 pack 的 Canvas2D **降级适配器**，非设计选定正式 PixiJS WebGL adapter。真实 Electron、GPU/Windows、多屏和 E2E 仍按用户要求推迟。

## 实际范围

- `rendering/canvas-renderer.ts` 实现 `PetRenderer` 统一接口、独立 `loadPack`/`resize`/`setPose`/`play`/`tick`/`hitTest`/quality/pause/dispose；把验证后 PNG bytes 用 Blob/`createImageBitmap` 解码，实际解码尺寸必须与准备结果一致，atlas 帧矩形随动作时钟改变 `drawImage` 源矩形，不用 CSS 假装逐帧播放。静态 variant 为活动降级，缺动作不修改领域状态。
- 以候选 bitmap + 动作实例准备新 pack，成功绘制后再提交并释放旧实例；取消/快速换版/失败/解码超时不覆盖新一轮或旧画面，迟到 bitmap 主动 close。每 variant 解码等待上限默认 8 秒，sprite 失败可试静态 variant；两者全失败保留已成功的旧帧；无法绘制则清画面、命中返回空。限制 backing store 16 MiB，缩放或镜像按 004B 几何，防护无效值；没有支持的表情/口型通道时明确 no-op，而非声称语音已联动。
- `pet/PetCanvas.vue` 替代桌宠窗口旧 DOM 动效占位为真正 Canvas 组件。Vue 仅响应式保存装载状态，渲染实例和图像资源不进入 Pinia。订阅权威 Activity 对应基础视觉动作，摸头可立即触发独立视觉请求，业务请求仍由现有 `AppBridge` 确认；不依赖动画成功或播放完成发放奖励。按 document visibility、暂停、系统降低动态效果选项管理 30/15fps 节奏与资源生命周期，ResizeObserver/DPR 更新。
- `PetApp.vue` 与原有 500ms 命中续约合并：先 Canvas CSS 局部坐标→模型区域；仅实际匹配才发送命中主机意图，另保留名称/拖动/按钮的 DOM 入口。旧资源未验证匹配当前 `characterId` 时不能触发当前角色业务；初次加载失败仅显示非命中的 SVG 占位和反馈。此处采用 pack 人工归一化矩形，不宣称逐像素点击穿透已经完成。

## 已执行检查

- `pnpm --filter @pet-desktop/desktop exec vitest run tests/canvas-renderer.test.ts` **12/12 通过**：使用真实内置资源数据及注入 bitmap/Canvas mock 验证播放源矩形随时钟变化、静态降级、相同 surface 中 A→B 失败保留/A→B→A 竞态、取消与释放、候选绘制失败回滚、解码 deadline 迟到释放、DPR 命中与 reduced motion 等。
- Desktop Node、Vue、test TypeScript 三套配置通过（包含实际 `PetCanvas.vue`）。没有调用真实窗口控制器、无 Windows GPU/透明命中/帧率实测。Mock Canvas 证明适配逻辑而不证明任何具体驱动行为。

## 未完成及下一步

当前正式 PixiJS WebGL 路径、GPU 上下文丢失恢复、动态 alpha mask、正式角色素材及 Live2D 尚未完成。已做到**同一 surface** 的原子替换，但 Main 管理两独立窗口时尚缺 staged 新窗口视觉就绪握手，因此不能认为 V1.1 的跨窗换宠保留旧画面已完成。004D 继续该宿主策略、资源版本/缓存；004E 处理 CG 业务与历史资源。

固定 75 项功能评分仍保守为约 27.3%；状态/资源包已有真实较深原型但完整产品流程和发行能力未到 D。用户指定的实际窗口启动验收继续暂缓。
