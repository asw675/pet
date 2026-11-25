# 004E-3 真实 CG 图鉴、收藏和历史资源回看

日期：2026-11-25。对应 V1.1 §7.5、§17.2、§17.5。前置 [004E-1](004e1-cg-catalog.md)、[004E-2](004e2-cg-authority.md)。将此前 `/gallery` 待开发页面替换为真实权威图鉴视图。不是实际 Windows 界面验收。

## 实际功能

- `GalleryView.vue` 调用控制中心独占 `listGallery`，支持全部/已解锁/未解锁/收藏、宠物实例、角色、路线、事件、稀有度筛选及分页（12/page）。卡片展示宠物、事件、路线、提示、真实解锁时间与历史资产状态；锁定为剪影/线索，不请求或渲染缩略图/高清正文。真实 `PINNED` 历史版本可显示已验证的缩略图和完整 CG；未知旧版、出发时缺资源、精确版本丢失、hash 失败均明确错误或历史占位，不回退新版、不解锁/重奖。收藏调用权威命令，不在 UI 自增计数。
- `cg-assets/registry.ts` 使用闭合 GalleryRow schema，只有 UNLOCKED PINNED 且角色/cgId/variant/event/route/version/hash 精确解析成功才选择本地 lazy PNG import。验证 canonical descriptor SHA256、文件 bytes/SHA256 与 PNG 尺寸；取消后的迟到结果不污染当前页面；不使用远程 URL 或 IPC 路径。高清图只有打开已解锁画面后才加载，保留锁定数据泄漏检查。内置包的正常 UI 访问门槛不是加密 DRM，用户安装包内原始资产不能靠 renderer 锁定保证秘密。
- 独立弹层显示 CG、字幕、事件、初次获得来源与版本，支持跳过/重看、缩放、减少动态效果。历史精确资源不可用时保留记录和重试入口。首次查看必须当前同 generation、当前 query/revision 精确 row、已校验高清图片真实 `img` load 且尺寸对应，才发 `CG_MARK_VIEWED`；缩略图、锁定、切换查询、迟到/损坏回执不计入。重复 replay 不触碰奖品。异常命令未确认时不静默重发。
- `gallery-view-policy.ts` 将当前权威修订号及分页过滤一致性隔离为纯函数。Vue store 仅持可序列化业务投影；实际图片加载生命周期不进游戏数据。

## 已执行检查

- `tests/gallery-assets.test.ts` 9/9 通过：exact pin、锁定拒绝 lazy import、真实库内 PNG 字节、descriptor/hash、错版本/sha、取消、过滤/代际/修订号、真实 image-view 请求条件。Vue TypeScript 及 desktop Node/test TypeScript 均通过。
- `mise exec node@26.12.1 -- pnpm build` 通过，生成两个 renderer（CG 缩略和原图为分别 lazy 资源 chunk）、两独立沙箱 preload、Main、utilityProcess，并通过可达模块入口审查。不启动应用；Chromium 实际图片解码、透明渲染、对话框、Windows 行为及性能仍待验收。
- 004E-2 的历史数据、奖励及真实 SQLite 测试详见独立记录。所有锁定与重复奖励测试使用开发 fixture，不触碰用户实际存档。

## 后续

004 的本地工程路径已有角色资源、Canvas2D 序列帧、跨窗交接、真实 CG 业务与图鉴。未完成正式 Pixi WebGL、模型授权/下载/缓存的完整生命周期、P0 Windows 验收、多角色正式精细素材、通用随机故事/事件源；它们不被标记为通过。依用户决定，真实启动、Windows 端到端及发布验证推迟到产品代码覆盖约 90%，后续继续 006 游戏完整机制而非等待平台实测。
