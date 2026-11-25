# 006A-2 角色领取、独立昵称、获取历史及真实角色馆

日期：2026-11-25。对应 V1.1 §3、§12.3、§18.4 以及用户确认的人形美少女视觉方向。前置 [006A-1](006a1-character-catalog.md)。本次把角色模板升级为实际可获得、可改名的独立实例，控制中心不再只有两张固定 demo 卡。

## 真实功能与权威事务

- `characters/list` 返回同事务同 revision/钱包的 CharacterCatalogPage（真实模板、人格/职业/属性配置、获得条件、拥有实例与获取日期/来源、当前 eligibility）。闭合分页边界≤100，并校验拥有身份与 snapshot、实际探索次数/余额对应的可获得性；旧未知模板仍保留在 snapshot，目录不凭空制造定义。`ControlCenterBridge.listCharacters()` 独占固定空 payload；pet、跨角色窗口拒绝查询、领取及改名。普通/图库/角色查询结果严校验 method + requestId + shape，不可串用，而旧 command receipt 快照保持原结构。
- `PET_ACQUIRE` 接收 characterId 与 catalogVersion，不接受客户端价格、petId、属性或任意奖励。单写 service 当前逻辑时间/事务重算真实已结算旅行数、当前 wallet、模板/容量/已拥有条件，生成唯一 petId，初始化 HOME/IDLE/HIDDEN、独立 needs/XP/属性；星咏绒绒既有 ID 保留，诺瓦候选 3 次旅行及 16 游戏币。成功记录新实例、原子扣币、获取凭据、revision/outbox、command receipt。相同命令历史重放不再次扣账；新命令同模板拒绝。角色切换不改变现有主宠或在途实例，不涉及任何真实付费。
- `PET_RENAME` 仅作用指定实例昵称，NFC/trim 后有界验证；允许在途改名，不改变 characterId、装备/旅程/历史、其他宠物或获得凭据；相同昵称无重复状态效果。初始两只 starter 的获取记录只有真实新档初始化时写权威 logicalTime，历史旧档明确 LEGACY/acquiredAt=null。

## SQLite v3 保持历史

001 与 002 部署后的 SQL 校验和逐字节固定（`fnv1a32:9d3ced6f`、`fnv1a32:a0036d79`），新 003 additive `pet_acquisitions` sidecar。原 pets、trip、CG、ledger 和 receipt 旧行不重写；既有宠物在升级后没有伪造 sidecar。真实 v1/v2→v3 走既有 pre-migration `VACUUM INTO`+只读校验；失败不继续 schema/业务迁移。

获取记录固定 petId、获得时间、来源、catalogVersion、coinCost 和关联 commandId；STARTER 必须零币无命令，GAME 唯一 command+deferred FK 并双向约束精确成功 `PET_ACQUIRE` 回执。必须同事务先写 acquisition 再写匹配成功 receipt，时间/角色/版本/实际新 petId 一致，禁止历史事后挂接、孤立成功 receipt、篡改/重复记录或关联凭据；失败 command receipt 可独立记录，无游戏扣费。新有获取记录实例固定模板 ID，改名/成长不受影响，旧历史兼容。独立审核发现并修订以上同事务和时间不变量，非仅依赖 UI 确认。

## 控制中心真实页面

`PetsView` 保留已有实例选择/显示/旅行导航，每只增加昵称编辑，原始 petId/name 与 generation 绑定；只有权威结果更新名称。独立模板目录三位人形少女、职业/背景/人格与属性成长、目前条件；无权限/不合格明确禁用。诺瓦显示实际探索次数、共享币成本，选择后必须明确二次确认当前 revision/catalogVersion/钱包/成本，状态变化需重新确认，不盲目重试、不自动领取。页级展示最多9项、实际数据来自 service，非虚构商店；不同少女仍用同一资源协议，诺瓦有真实内置 sprite/static 文件。

## 已执行检查

- contracts 302/302（新角色查询/旧接口兼容 4 项）；desktop 全部 265/265：包括 Main 18、preload 84、角色界面策略 7、原有图鉴/动画/进程/资源回归；Node/Vue/test TypeScript 通过，生产代码 bundle 构建及独立入口检查通过。
- app-service 81 项通过、1 个旧 SQLite 环境专用 case 跳过：仓储36、service28、真实SQLite集成10、backup4、实际Node子进程4。真实 SQLite 全新、v2（以及原 v1）迁移、backup/failure rollback、exact receipt FK/触发器；应用层重复/失配/余额/无门槛领取、获取独立性、角色 ID 碰撞、Unicode 改名、旅行中改名与重启验证。
- 真实 Electron 运行、Windows 验收、精细美术、AI 人格模型及声音仍按用户要求推迟。这里的角色人格/voiceStyle 目录只是后续 AI/STT/TTS 的稳定数据，不把未接模型计成功。

按照 [004-Q](004-progress-audit.md) 固定75项口径，角色模板 P→D、实际获取与昵称 N→D，角色库现5D/1P（正式资源安装升级等仍P）；全产品约 **37.3%**（15D/26P/34N），这不是正式验收通过率。正在并行完成的 006B 纯规则、006C 纯报价等尚未业务联通，不额外记入此数字。
