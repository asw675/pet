# 004B 渲染适配契约、动作时钟、局部命中与口型时间轴

日期：2026-11-25。对应 V1.1 §17.2–17.5、§20.4。依赖 [004A](004a-character-packs.md)；只建立不依赖 Electron/SDK 的前端表现核心，不修改任何权威游戏状态。用户推迟真实窗口、Windows 与端到端验收。

## 子代理独立实施

| 模块 | 文件 | 能力 |
|---|---|---|
| 渲染契约 | `rendering/contract.ts` | `PetRenderer` 全部方法，质量、姿态、动作请求/结果、语义命中、标准化口型 DTO |
| 动作调度 | `rendering/action-controller.ts` | 由 snapshot activity 选择基础动作；可打断优先级、循环与一次性、最新基础恢复、缺失动作 idle 降级、请求去重与取消、独立帧时钟 |
| 几何 | `rendering/geometry.ts` | contain/anchor、pose CSS 像素偏移、镜像/缩放、逆变换、规范化命中区域；分离 DPR/绘图缓冲并约束极端分辨率 |
| 口型 | `rendering/mouth-timeline.ts` | 外部音频时间轴、严格播放轮次、顺序/过期样本、限长预取、平滑、暂停/结束/取消立即闭口 |

实际动作请求 ID 与业务 `commandId` 完全隔离。基础循环只呈现权威活动，不以动画播放结束确认业务命令；已结束/取消的视觉请求不再恢复旧状态。序列帧无 blend 骨骼混合能力，`blendMs` 只是保留统一契约字段。适配器自行持有模型/纹理对象，不进 Pinia，未来 Pixi/Live2D/VRM 可实现同一接口。

`calculateModelGeometry` 将逻辑角色坐标映射到 Canvas 的 CSS 区域；用同一 pose+anchor 逆变换判断 pack 规范化命中矩形。DPR 只计算 backing pixels，负朝向围绕同一锚点镜像，不把 DPI 重复乘进 hit test。此处仍是区域数学，并非 Windows 实际鼠标穿透或真实动态 alpha mask。

`MouthTimeline` 由音频播放层显式 `begin(generation)`，按实际相对播放时钟而非 frame index 采样，默认 256 个待消费样本、150ms 过期和 40ms 平滑；新播放、暂停、取消、关闭后的旧消息不能重开嘴型。此处无 STT/TTS、音频设备或完整角色嘴部图层，不能记为语音功能已实现。

类型验证将 Node/特权进程、Vue renderer、混合环境测试三套 tsconfig 分开，避免 renderer 测试引入 DOM 类型后使 Node 主进程的独立类型约束失效。

## 专项检查

`mise exec node@26.12.1 -- pnpm --filter @pet-desktop/desktop exec vitest run tests/action-controller.test.ts tests/rendering-geometry.test.ts tests/mouth-timeline.test.ts` **38/38 通过**：动作调度 14、几何 11、口型 13。`pnpm --filter @pet-desktop/desktop typecheck` 三套配置通过。对真实 pack 的播放、实际渲染与 GPU 性能还需适配器及平台层。

## 进度与下一步

P0-05 保持进行中，75 项总体功能评分仍为 27.3%（本次增加底层能力，不重复给已有原型或尚未联通的语音打分）。004C 将接入真实序列帧与静态降级、重载/取消资源生命周期和 Vue Canvas，正式 Pixi WebGL 另验；004D 验证跨窗口换宠，004E 处理 CG 历史版本。
