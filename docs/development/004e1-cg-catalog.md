# 004E-1 图鉴数据契约与版本化 CG 目录

日期：2026-11-25。对应 V1.1 §7.5、§12.3、§17.5、§18.4；前置 [004A-R](004a-art-direction.md) 的二次元少女美术方向及 [004D](004d-pet-handover.md)。此提交不改 CG 解锁、旅行结算、存档或 IPC 请求，先冻结新契约及可信内容目录。

## 内容与契约

- `packages/contracts/src/gallery.ts`：闭合图鉴查询、过滤/分页、LOCKED vs UNLOCKED 投影、CG 资源状态 PINNED、LEGACY_UNVERSIONED、UNAVAILABLE_AT_DEPARTURE，收藏/标记查看 payload。锁定条目不存在版本/摘要/资源路径/正文；解锁条目仅返回身份及历史 pin，未授权资源和任意字段不通过 schema。校验角色/事件/版本/hash、查看时间、页大小、重复 identity；版本未明的旧记录不能伪造已查看。
- `packages/domain/src/cg-catalog.ts`：通过独立 `@pet-desktop/domain/cg-catalog` subpath 暴露只读内置 CG 描述，按 `characterId,cgId,variant,assetVersion` 精确匹配。历史明确版本找不到则失败，只有无版本的当前内容查询才使用 latest。实际两项 `morning-dew/default/1.0.0` 对应两少女角色和冻结 demo 路线 `morning-dew-meadow`、事件 `dew-postcard`；包含文案/提示/稀有度/权利标记、原图与缩略图长度/摘要。
- `assetHash` 是对固定顺序 canonical JSON descriptor 的 UTF-8 SHA256（包身份、版本、文案、许可、两图 bytes/sha256 均纳入），不含绝对路径和 `assetHash` 自身。未来换图/文案必须新版本，禁止以最新图冒充历史。目录本身不持有解锁、奖励、收藏或查看状态；应用服务唯一权威将于 004E-2 冻结并保存。
- `generate-demo-cg.mjs` 生成两幅原创工程 CG（星咏晨曦草地、绒绒溪畔），人物沿 1.0.1 资源设定，768×432 场景及真实同源 256×144 缩略图，四个 PNG 总 397,038 字节。非正式高精度商业美术，不直接分发用户参考图。

## 兼容性复核与实际检查

- 在本步骤的原生 Node 26 包导入检查中发现 004A 的内部 `.js` export（源码为 `.ts`）在 Vitest bundler 能正常解析，但 Node 独立进程报 `ERR_MODULE_NOT_FOUND`。改用 contracts `package.json` 的 `#character-pack`、`#gallery` 显式内部 imports，实际从 app-service 目录原生 Node import 两 schema 成功；不通过关闭类型校验或重写全局解析来规避。domain 采用独立 subpath，保留无需构建的原生旅行 smoke。
- gallery 契约 81/81、character-pack 87/87，通过；CG 目录/实际 PNG 专项 9/9，包括独立 descriptor 计算、版本/哈希、深冻结、真实文件及像素缩略数据。固定 Node 26.12.1 生成器 `--check` 通过；domain typecheck、contracts typecheck、domain 原生 smoke 7/7 通过。实际 app-service 迁移及新请求整合由 004E-2 后续全量回归；此处不启动真实 Electron。

## 下步

004E-2 保护历史存档：原有 001 迁移不可改写；新增 v2，历史 CG 和无 pin 的旧在途旅行标记真实的 legacy，而不是用本次 1.0.0 图片冒充；新出发按目录冻结 pin 后通过既有结算原子解锁。004E-3 受限查询和真实图鉴视图，收藏/查看不可触碰奖励账本。仅目录存在不算产品 CG 回放或收藏完成。
