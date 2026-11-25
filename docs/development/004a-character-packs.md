# 004A 角色资源包契约、完整性准备与内置测试包

日期：2026-11-25。对应 V1.1 §3.4、§17.3–17.4、§22。前置 [003](003-desktop-host.md)，覆盖率基准 [003-Q](003-progress-audit.md)。本提交只负责数据格式、可信内置资源和装载前准备；没有改变宠物业务投影，也未接入实际桌宠 Canvas。

## 实现与子代理分工

| 工序 | 位置 | 实际能力 |
|---|---|---|
| 004A-1 契约 | `packages/contracts/src/character-pack.ts` | 严格 Zod schema、TS 类型、结构 JSON Schema 导出、资源预算、跨字段/atlas 引用校验 |
| 004A-2 原创 fixture | `apps/desktop/scripts/generate-demo-packs.mjs`、`src/renderer/asset-packs/builtin/` | 星咏、绒绒各独立版本、PNG 图集、静态封面、thumbnail、完整 hash 清单 |
| 004A-3 解析器 | `src/renderer/asset-packs/resolve-pack.ts` | 注入受限本地数据源、精确文件集合、字节及 SHA-256、图片格式/CRC/尺寸、atlas/版本、取消/超时及只读准备结果 |
| 004A-4 装配与复核 | `builtin-registry.ts`、`tests/builtin-packs.test.ts` | 固定角色白名单、Vite lazy 数据导入、真实文件/业务 ID 对齐、拒绝未声明或任意 URL |

Manifest 和 atlas 使用 `schemaVersion:1`；资源包版本各自独立于业务 schema、数据库及旅行规则。角色 ID 与现存两个实例模板一致（`star-singer`、`fluffy-ranger`），资源 `packVersion:1.0.0`、当前 `minAppVersion:0.0.0`。未来 renderer 枚举预留，但本次装载仅允许 sprite/static，且要求静态 fallback。许可字段标记原创工程 fixture，不代表商用素材权利审核已完成。

## 数据与装载边界

- 限制每文件 16 MiB、每包 64 MiB、≤256 个资源；PNG 纹理边长 ≤2048、全包解码估算 ≤64 MiB。拒绝路径越界、绝对路径、URL、Windows 保留设备名、ADS、大写/重复路径、未知可执行格式及 JSON 原型危险键。声明清单需完整覆盖当前支持的所有资源引用。
- `atlas.json` 是独立自有数据格式：图集图像路径及尺寸、clip 到帧数组映射、像素 `rect` 与 `durationMs`。首个版本只支持等尺寸完整帧（不裁边、不旋转）；clip/帧数/时间与边界有上限，未来格式独立升级。Manifest 的 `idle` 对每个 variant 必需；动作/lipSync 映射的 clip 必须真实存在。
- 结构 JSON Schema 可导出用于编辑器检查；Zod 的跨字段 refine、跨文件、版本兼容、字节和 hash 校验仍是权威，不能只凭 JSON Schema 判定文件完整。
- `resolvePack` 返回新准备结果，不切换当前素材、不写权威状态。对清单内全部字节进行 hash 检查，PNG 仅接受无附加 chunk、非隔行 RGBA8 基线，检查 IHDR/IDAT/IEND 和 CRC；实际像素解码需后续渲染器。同一资源数据不会由调用方借共享引用修改。失败返回稳定错误类别，不泄露原始路径或源异常；取消/超时不覆盖旧资源。
- Vite 仅懒加载已登记内置 JSON/PNG，图片由 inline data 转为 bytes，避免依赖生产 file:// 的任意 fetch 或 renderer 文件系统权限。实际目录测试拒绝符号链接和未声明文件。外部导入/压缩包/下载签名/磁盘 LRU 与权威 pins 均未开放；hash 只能证明已选清单对应的内容完整，不能证明来源可信。

## 测试内容与实际结果

- contracts 专项 87/87，原有 125 项契约回归仍通过（合计 212/212）；覆盖路径、格式、交叉引用、动作必需、错误键、命中区域、帧越界、资源限制及 JSON Schema。
- desktop resolver 34/34，覆盖 bytes/hash/PNG 容器与预算、版本、目录一致性、atlas 关联、取消和超时、失败脱敏。
- 真实内置 pack 测试 5/5（两角色目录与真实文件 hash、未知 ID 拒绝、Vite inline 读取后的校验与不可变复制）。生成器 `node apps/desktop/scripts/generate-demo-packs.mjs --check` 字节级再生检查通过。两资源包共 73,601 字节，各 6 个动作（idle/sleep/happy/tap.head/talk/walk），每动作 4 帧，图集 768×512、单帧 128×128；独立 inflate 检查 48 帧确实含透明、半透明与不透明像素。
- contracts TSC、desktop Node TSC 与 Vue TSC 定向检查通过。遵循用户要求未启动 Electron、未执行真实窗口/Windows/性能验收。

## 完成度与后续

按固定 75 项基准，角色资源包从 N 到 P（有真实资源与验证、尚未连接正式适配器/安装管理），覆盖率从 26.7% 到 **27.3%**；P0-05 只进入“进行中”。不因新文件、测试行数或 fixture 素材数量额外加分。下一步 004B 动作和几何契约、004C Canvas2D 降级与后续正式 Pixi WebGL；跨窗换宠、缓存 pin、CG 历史版本仍独立开发。
