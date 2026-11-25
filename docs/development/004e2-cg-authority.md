# 004E-2 CG 历史迁移、冻结资产、权威图鉴及 IPC

日期：2026-11-25；依据 V1.1 §7、§12.3–12.5、§17.5、§18.4–18.6。前置 [004E-1](004e1-cg-catalog.md) 的资源目录和 DTO。将真实图鉴数据、收藏和查看接入唯一 SQLite 业务服务；界面在 004E-3 单独完成。

## 数据迁移及兼容性

- SQLite schema 由 1→2，001 SQL 保持逐字节一致（独立复核 8,371 bytes，已存校验 `fnv1a32:9d3ced6f`），新 002 独立注册、逐个事务迁移，连续校验完整迁移历史、外键和旧 trip/CG 行数。既有 trip v1 frozen snapshot、规则、随机状态和历史事实/reward key 不改。旧 `cg_unlocks` 迁移明确 `LEGACY_UNVERSIONED`（未知版本、hash、历史角色/事件均 NULL），不造图。旧在途 trip 标明旧 pin schema，未来结算也不推断新图版本。新 trip 使用 v2 departure pin schema。
- 已存在持久库升级必须在迁移事务前由唯一 app-service 调用备份钩子。生产 Electron utility 与纯 Node process 入口生成唯一 sibling backup path，使用 `VACUUM INTO` 复制包括已提交 WAL 的一致数据库；另用只读连接校验版本、`integrity_check`、FK 后关闭，失败停止迁移，不覆盖源存档。异常 delete-mode 库启用 WAL 时 pragma 可能变化，不承诺备份失败后二进制字节完全相同；旧业务行、版本与历史不改是验证目标。fresh DB 顺序 001、002 无须伪造旧库备份。
- `trip_cg_asset_pins` 按 trip/pet/cg/variant 冻结当前角色、事件、assetVersion/assetHash，或明确 `UNAVAILABLE_AT_DEPARTURE`。只能在出发事务、初始 checkpoint（逻辑时间=出发时间、无已执行节点/事实）插入；数据库 trigger 禁止修改/删除。新 v2 旅行缺 pin 不允许解锁，旧 v1 旅行没有 pin 为 legacy。首次 CG 获得只复制出发 pin，保留首次来源；重复获得不能覆盖旧图、收藏或查看；原 `reward_ledger` 按 trip/cg:variant 的幂等键继续使用。首次和后续来源须有 exact CG reward ledger 条目（kind、source、pet、target、amount=1），SQL 与业务仓储双层保护。
- `CG_SET_FAVORITE` 仅操作已有解锁，`CG_MARK_VIEWED` 必须匹配完整历史 PINNED ref（character/event/version/hash）。权威 logicalTime 记录首次查看；收藏与查看只修改独立元数据、全局 revision/事件，不写奖励、XP、金币、旅行事实。旧版不可播放但可收藏历史记录。读取分页快照事务先推进既有到期事件，再构造 GalleryPage 并严格匹配 snapshot revision；展示 exact 历史目录或明确缺失而非 newest 兜底。

## 请求传输与方法隔离

新增 `gallery/list` 受限读取请求，只有 `ControlCenterBridge.listGallery` 和经 Main 校验的控制中心角色可调用；宠物及 staging/retiring 窗不具有图鉴查询或收藏/查看命令。兼容旧 `IpcResult` 和保存的 command receipt：普通成功仍为原 `{snapshot}`，仅新 gallery 成功增加严格 `{gallery:GalleryPage}`，两个成功结构不互换，错误结构不变；旧数据库回执不迁移、不重新执行。Worker、ServiceClient、Main、preload 都校验 request ID+method，preload 核实分页，gallery revision=快照 revision，非法结果不发布。没有 shell/文件路径/任意 SQL 或资源正文传输。

`@pet-desktop/app-service` 的包公共导出及 gallery-service 内部导入改为 `package.json#imports`，原生 Node 26 可直接 import 与 Vitest/Electron bundler 一致（修复同类 `.js` 源码解析问题）。

## 实际验证

| 检查 | 结果 |
|---|---|
| contracts | 298 项通过（含 5 项新增 gallery transport/result/命令测试） |
| app-service | 61 项通过、1 个旧 SQLite 环境 case 跳过；仓储 26、service 19、真实 SQLite 集成 9、备份 4、Node 子进程 4 |
| Desktop request 层/renderer store | 定向 125 项通过（Main boundary 17、ServiceClient 11、Utility 21、preload 69、store 7） |
| 类型检查 | app-service 与 contracts 通过；preload 主/renderer 类型检查通过，最终全 workspace 回归在 004E-3 |
| 原生 Node 26 包导入 | 实际从 desktop 目录导入 AppService、SQLiteRepository、backup helper 成功 |

独立审查发现并在提交前修正两处缺口：只校验 settlement cgIds 未校验 exact ledger、以及无事实但逻辑时间已经推进后仍可补 departure pin。补充缺/错 variant/kind/amount ledger 拒绝及回滚、无事实迟到 pin 拒绝等实测。真实 v1 fixture 及备份测试、旧在途结算、重复 CG、跨重启收藏、精确首次查看、无重奖、迁移失败回退覆盖。真实 Electron binary/Windows/安装/长时体验没有启动，按用户要求保留后续平台验收。

## 下步

004E-3 实际图鉴视图与按授权 lazy 加载 exact 图资源，完成后再核算产品功能整体覆盖。正式 Pixi WebGL、自定义包下载/签名、通用缓存回收、通用 EVENT 来源奖励、正式精细角色和 CG 尚待后续。旧迁移 002 此后与 001 同样不可改写，新阶段使用更高的增量版本。
