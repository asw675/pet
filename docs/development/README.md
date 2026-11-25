# 开发记录索引

每个步骤对应一个不可变的开发记录与 Git 提交；后续修订新增记录，不默默改写历史测试结论。

| 步骤 | 内容 | 状态 | 文档 |
|---|---|---|---|
| 000 | 建立从零开发的仓库、设计基线及开发约定 | 已完成 | [000-bootstrap](000-bootstrap.md) |
| 001A | 公共契约与运行时校验 | 正式测试通过 | [001a-contracts](001a-contracts.md) |
| 001A-R | 公共契约独立审核修订 | 正式测试通过 | [001a-review](001a-review.md) |
| 001B | 纯领域核心与确定性旅行原型 | 正式测试及 Node smoke 通过 | [001b-domain](001b-domain.md) |
| 001-V | 真实依赖锁文件及完整测试 | 完成 | [001-validation](001-validation.md) |
| 002A | SQLite 事务仓库、版本化迁移 | 开发机测试通过 | [002a-storage](002a-storage.md) |
| 002B | 应用用例与原子结算 | 单元及真实数据库集成通过 | [002b-app-service](002b-app-service.md) |
| 002C | 独立子进程验证 | Node 真实进程验证通过 | [002c-process](002c-process.md) |
| 003-V | 首版单陪伴位与文档对齐 | 正式测试通过 | [003-visibility-alignment](003-visibility-alignment.md) |
| 003 | 宿主、独立服务、preload 与双 renderer 原型（A–E、R） | 代码、类型、测试与构建通过；真实 Electron 启动待验证 | [003-desktop-host](003-desktop-host.md) |
| 003-Q | 独立产品功能覆盖与代码行数审计 | 基准 26.7%，实际窗口验收按用户要求暂缓 | [003-progress-audit](003-progress-audit.md) |
| 004A | 角色资源包契约、完整性准备与内置素材 | 代码与专项测试通过 | [004a-character-packs](004a-character-packs.md) |
| 004A-R | 美少女桌伴视觉定位、参考设定和 1.0.1 工程素材 | 更新完成 | [004a-art-direction](004a-art-direction.md) |
| 004B | 渲染适配契约、纯动作时钟、局部命中、口型时间轴 | 代码与专项测试通过 | [004b-rendering-core](004b-rendering-core.md) |
| 004C | Canvas2D 真实序列帧与桌宠 Canvas 接入（降级） | 代码及专项测试通过，正式 Pixi 待开发 | [004c-canvas-fallback](004c-canvas-fallback.md) |
| 004D | 跨窗原子视觉交接及权限防竞态 | 代码及专项测试通过，真实窗口待验收 | [004d-pet-handover](004d-pet-handover.md) |
| 004E-1 | 图鉴契约、真实内置 CG 场景及历史目录 | 代码与专项测试通过 | [004e1-cg-catalog](004e1-cg-catalog.md) |
| 004E-2 | SQLite v2 历史迁移、冻结 CG、权威图鉴及 IPC | 代码和数据库/传输测试通过 | [004e2-cg-authority](004e2-cg-authority.md) |
| 004E-3 | 实际 CG 图鉴界面及精确资源回看 | 代码、专项测试与构建通过 | [004e3-gallery-ui](004e3-gallery-ui.md) |
| 004-Q | V1.1 功能及代码规模复核 | 产品覆盖约34.0% | [004-progress-audit](004-progress-audit.md) |
| 005 | Windows 安装包与真机 P0 验收 | 按用户要求推迟至约90%开发覆盖 | — |
| 006A-1 | 角色模板与获得规则、诺瓦内置资源 | 代码与专项测试通过 | [006a1-character-catalog](006a1-character-catalog.md) |
| 006A-2 | 真实角色获得、昵称、v3迁移与控制中心目录 | 代码、数据库与专项测试通过 | [006a2-character-authority](006a2-character-authority.md) |
| 006B-1 | 家中状态与需求纯规则 | 领域 27 项通过 | [006b1-home-rules](006b1-home-rules.md) |
| 006B-2 | 家中权威调度、v4持久化、桌面走动接入 | 数据库/专项测试通过，Windows待验收 | [006b2-home-authority](006b2-home-authority.md) |
| 006C-1 | 职业成长与装备纯规则 | 领域 72 项通过 | [006c1-progression-rules](006c1-progression-rules.md) |
| 006D-1 | 物品目录及商城纯报价 | 领域93项通过 | [006d1-item-catalog](006d1-item-catalog.md) |
| 006D-2A | 背包、装备、成长、商城闭合契约 | 专项87项通过 | [006d2a-inventory-contract](006d2a-inventory-contract.md) |
| 006E-1 | 三路线目录与出发前置纯规则 | 领域74项通过 | [006e1-travel-preparation](006e1-travel-preparation.md) |
| 006E-2A | 旅行准备、冻结出发与完整历史投影契约 | 11项专项通过，权威接入待完成 | [006e2a-travel-contract](006e2a-travel-contract.md) |
| 006F-1 | 随机剧情、分支冻结及六项原创事件 | 领域64项通过 | [006f1-event-engine](006f1-event-engine.md) |
| 006-Q | 中间代码与功能核对（固定5b6f4dc） | 开发覆盖41.3% | [006-progress-checkpoint](006-progress-checkpoint.md) |
| 006C-2/D-2/E-2/F | 成长投影、装备经济、旅行、随机事件 | 分模块开发中 | — |
| 007A-1 | AI 人格/Provider/逐宠会话及记忆契约 | 专项136项通过 | [007a1-ai-contract](007a1-ai-contract.md) |
| 007A-2 | OpenAI-compatible Provider、受限流、人格 prompt | Fake fetch 61项通过，真实服务待配置 | [007a2-provider-adapter](007a2-provider-adapter.md) |
| 007B-1 | 逐宠记忆候选、同源约束、敏感筛查及授权检索 | 专项93项通过 | [007b1-memory-policy](007b1-memory-policy.md) |
| 008A-1 | 语音契约、单会话取消及实际音频 RMS 口型算法 | 50项专项通过，实际设备/供应商待接入 | [008a1-voice-contract](008a1-voice-contract.md) |

每份记录包含：日期、范围、设计依据、具体变更、测试命令与真实结果、已知限制、下一步。完整验收状态见 [POC 矩阵](../qa/poc-matrix.md)。
