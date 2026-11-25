# 006F-2B 两个实际剧情 CG 及不同来源图鉴契约

日期：2026-11-25，依据 V1.1 §7、§17。两幅原创 SD 美少女工程画面：星咏与夜窗星图、绒绒与归家炉火/茶桌。实际768×432 PNG和256×144缩略，各自确定性生成、精确 bytes+SHA256+完整descriptor版本。视觉仍为工程占位的原有人形少女 SD，不是正式比例插图或 Live2D；原旅行CG的两个哈希不变。

- `EVENT_CG_CATALOG` 独立于原旅程固定目录，star 家中 routeId=null，ranger 归旅 routeId为真实草原。两个事件定义由v1→v2，event catalog v2，绑定实际精确版本CG和唯一 CG_UNLOCK；已有旧冻结 occurrence 的未来/无资源状态不重写。
- 原旅行 `sourceTripId` 行保留原形；事件获取使用 `sourceTripId:null`+`sourceEventId`，仅精确 PINNED，不伪造 trip FK。Loader 按 source 分目录、历史 manifest hash 校验，锁定或版本错误不加载；图鉴界面区分所属剧情/旅程和家中事件。尚需 v7 实际独立事件 CG 权威事务与合并查询。

实际生成四组文件后 `generate-demo-cg --check` 验证全部 PNG/thumbnail；domain event 64/64，CG asset/registry20/20，gallery contracts87/87；Node/Vue/test TSC及生产构建通过。未运行窗口。正式美术制作后只能发布新版本，不能替换这些已固定版本字节。
