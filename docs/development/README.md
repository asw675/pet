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
| 004F | Pixi WebGL 与 Canvas2D 降级接入桌宠窗口 | 专项测试与生产构建通过，Windows GPU 待验收 | [004f-pixi-desktop](004f-pixi-desktop.md) |
| 004-Q | V1.1 功能及代码规模复核 | 产品覆盖约34.0% | [004-progress-audit](004-progress-audit.md) |
| 005 | Windows 安装包与真机 P0 验收 | 按用户要求推迟至约90%开发覆盖 | — |
| 006A-1 | 角色模板与获得规则、诺瓦内置资源 | 代码与专项测试通过 | [006a1-character-catalog](006a1-character-catalog.md) |
| 006A-2 | 真实角色获得、昵称、v3迁移与控制中心目录 | 代码、数据库与专项测试通过 | [006a2-character-authority](006a2-character-authority.md) |
| 006B-1 | 家中状态与需求纯规则 | 领域 27 项通过 | [006b1-home-rules](006b1-home-rules.md) |
| 006B-2 | 家中权威调度、v4持久化、桌面走动接入 | 数据库/专项测试通过，Windows待验收 | [006b2-home-authority](006b2-home-authority.md) |
| 006C-1 | 职业成长与装备纯规则 | 领域 72 项通过 | [006c1-progression-rules](006c1-progression-rules.md) |
| 006D-1 | 物品目录及商城纯报价 | 领域93项通过 | [006d1-item-catalog](006d1-item-catalog.md) |
| 006D-2A | 背包、装备、成长、商城闭合契约 | 专项87项通过 | [006d2a-inventory-contract](006d2a-inventory-contract.md) |
| 006D-2B/C/D | v5真实装备经济、成长属性、背包商城与历史库存兼容 | 数据库、业务、页面专项通过 | [006d2-inventory-authority](006d2-inventory-authority.md) |
| 006E-1 | 三路线目录与出发前置纯规则 | 领域74项通过 | [006e1-travel-preparation](006e1-travel-preparation.md) |
| 006E-2A | 旅行准备、冻结出发与完整历史投影契约 | 11项专项通过，权威接入待完成 | [006e2a-travel-contract](006e2a-travel-contract.md) |
| 006E-2B/C/D | v6三路线真实出发、物资与装备冻结、历史战报 | 数据库、专项、生产构建通过 | [006e2-travel-authority](006e2-travel-authority.md) |
| 006E-3 | 在途地图读取冻结路线和实际节点进度 | 真实 SQLite 联合验证通过 | [006e3-active-travel-map](006e3-active-travel-map.md) |
| 006E-4 | 新版回合战斗纯规则和敌人目录 | 4 项专项通过，旅行接入待开发 | [006e4-battle-rules](006e4-battle-rules.md) |
| 006F-1 | 随机剧情、分支冻结及六项原创事件 | 领域64项通过 | [006f1-event-engine](006f1-event-engine.md) |
| 006F-2A | 事件待选、已提交效果与历史查询契约 | 5项专项通过，持久业务待接入 | [006f2a-event-projection](006f2a-event-projection.md) |
| 006F-2B | 新增2个剧情CG、事件源图鉴、精确版本读取 | 实际PNG与专项测试通过，解锁事务待接入 | [006f2b-narrative-cg-assets](006f2b-narrative-cg-assets.md) |
| 006-Q | 中间代码与功能核对（固定5b6f4dc） | 开发覆盖41.3% | [006-progress-checkpoint](006-progress-checkpoint.md) |
| 006-Q2 | 成长/三路线完成后核对（固定e513c0b） | 开发覆盖50.7% | [006-travel-progress-checkpoint](006-travel-progress-checkpoint.md) |
| 006F-2C/D | v7真实随机触发、分支、事件CG、实际事件箱 | SQLite/业务/页面验证通过 | [006f2-random-event-authority](006f2-random-event-authority.md) |
| 007A-1 | AI 人格/Provider/逐宠会话及记忆契约 | 专项136项通过 | [007a1-ai-contract](007a1-ai-contract.md) |
| 007A-2 | OpenAI-compatible Provider、受限流、人格 prompt | Fake fetch 61项通过，真实服务待配置 | [007a2-provider-adapter](007a2-provider-adapter.md) |
| 007A-3 | 逐宠异步会话、取消、持久终态 port 与授权候选 | 33项专项通过；实际存储接入待完成 | [007a3-chat-coordinator](007a3-chat-coordinator.md) |
| 007B-1 | 逐宠记忆候选、同源约束、敏感筛查及授权检索 | 专项93项通过 | [007b1-memory-policy](007b1-memory-policy.md) |
| 007C/D | 独立持久AI会话、记忆、Provider和真实权威投影 | 35真实SQLite专项，主迁移待挂载 | [007c-ai-storage-authority](007c-ai-storage-authority.md) |
| 007D-1 | v8/v9/v10 AI工作台语音统一存储挂载 | 320通过1跳过、真实迁移备份验证 | [007d1-unified-storage-migrations](007d1-unified-storage-migrations.md) |
| 007E-1 | AI闭合用户API与Main加密凭据仓 | 10项专项通过，IPC接入待完成 | [007e1-ai-ipc-vault](007e1-ai-ipc-vault.md) |
| 008A-1 | 语音契约、单会话取消及实际音频 RMS 口型算法 | 50项专项通过，实际设备/供应商待接入 | [008a1-voice-contract](008a1-voice-contract.md) |
| 008B-1 | AudioWorklet 真实录放音 API 与有界清理 | 28项专项、Vite构建通过；设备/权限待联通 | [008b1-webaudio-adapter](008b1-webaudio-adapter.md) |
| 008B-2 | Whisper/SAPI 本地供应商适配与Windows helper源码 | 24项专项、Node TSC通过；发行工件待验证 | [008b2-local-voice-provider](008b2-local-voice-provider.md) |
| 008B-3A | 主进程麦克风一次性授权与监督策略 | 5项专项，默认拒绝，实际接入待完成 | [008b3-microphone-lease](008b3-microphone-lease.md) |
| 009A-1 | 快捷工作台宿主一次性批准/文件身份复核 | 122项专项，平台适配待完成 | [009a1-quick-launch-policy](009a1-quick-launch-policy.md) |
| 009A-2/B-2 | 真实独立工作台/场景/隐私统计 SQLite 存储与契约 | 53合同+17真实SQLite通过，待主迁移挂载 | [009a2-workspace-storage](009a2-workspace-storage.md) |
| 009B-1 | 本地频次/时段/共现推荐纯策略 | 9项专项，历史与界面待接入 | [009b1-recommendation-rules](009b1-recommendation-rules.md) |
| 007E-2/008C/009D | AI、语音、工作台同一写入者及闭合真实业务传输、原生发行门禁 | 296项专项、生产构建通过；真实 Windows 待验收 | [007e2-feature-transport](007e2-feature-transport.md) |
| 007E-3/008D/009F | 聊天、记忆、语音口型及工作台实际页面 | 专项及生产构建通过，实机待验收 | [007e3-user-interfaces](007e3-user-interfaces.md) |
| 007F-1 | 主动陪伴存储与内部本地会话权限 | SQLite、契约和控制服务专项通过，调度与界面待接入 | [007f1-proactive-foundation](007f1-proactive-foundation.md) |
| 007-Q | 固定 d20fc41 核心功能及代码规模核对 | 开发覆盖约82.7% | [007-progress-checkpoint](007-progress-checkpoint.md) |
| 010A | SQLite v11、宿主显示偏好与手动备份 | SQLite 和宿主专项通过，Windows 真机待验收 | [010a-host-preferences-and-backup](010a-host-preferences-and-backup.md) |
| 010B | Windows x64 原生构建及 NSIS 安装包工作流 | 配置与生产构建通过，Windows 打包待 CI | [010b-windows-package](010b-windows-package.md) |
| 010C | Windows 构建检查诊断与 Pixi CSP 兼容接线 | 开发机专项和生产构建通过，Windows CI 待复跑 | [010c-package-qualification](010c-package-qualification.md) |
| 010D | Mac 生产运行及 Windows 迁移测试夹具 | Mac 实际运行通过，Windows 待 CI 复测 | [010d-runtime-and-windows-ci](010d-runtime-and-windows-ci.md) |
| 010E | 固定 Windows 检出的角色图集校验字节 | 模拟自动换行检出通过，Windows CI 待复测 | [010e-character-pack-line-endings](010e-character-pack-line-endings.md) |

每份记录包含：日期、范围、设计依据、具体变更、测试命令与真实结果、已知限制、下一步。完整验收状态见 [POC 矩阵](../qa/poc-matrix.md)。
