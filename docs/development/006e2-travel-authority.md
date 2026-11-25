# 006E-2B/C/D 三条实际旅行路线、冻结准备和完整战报

日期：2026-11-25。依据 V1.1 §6、§12.3、§18。独立三子代理负责 v6 存储、权威业务和控制中心页面；完成后对事务和历史做交叉复核。前置 [006E-1](006e1-travel-preparation.md)、[006E-2A](006e2a-travel-contract.md)。

- `travel/catalog` 真实三路线：晨露草原15分钟精力15、迷雾森林1小时精力30/口粮1、星落遗迹4小时精力50/口粮2/药剂1；等级门槛分别1/4/10，独立风险、历史版本、实际库存。`travel/preview` 仅收 petId/routeId/catalogVersion/选物资，返回同 snapshot 的权威资格、闭合原因、费用、时长。HOME/健康/等级/在途/精力/CHAT或DRAG/物资完整校验；per-route相关库存只取所需 ID，避免历史 archive 影响出发。
- `TRIP_START_PREPARED` 要求 expectedRevision；真实重新评估，原子消费已选必需物资、精力，冻结 route nodes/trip-v1 RNG snapshot+实际属性/战力/等级/三槽装备精确版本/强化/bonus/物资/目录版本及现有 CG pin。旧 `TRIP_START` meadow 兼容，新出发也冻结实际配置；历史保存格式/已有 RNG 规则不重写。在途中卸装、强化或回收不改变已冻结输入。
- SQLite 006 additive，`trip_departure_loadouts` 与有界供给/装备关系及 marked trip deferred FK，必须同权威成功命令 receipt 提交；精确 pet/route/trip/time/revision/wallet、HOME时真实gear身份+版本+强化、实际AWAY精力减量；旧行 marker null，不事后伪造。旧 v1–5 checksums `9d3ced6f/a0036d79/519a9ef3/0f3c0f0e/16a20fb2`，006 `fnv1a32:c7bfac9e`；真实 v5 活跃旧档、装备/家中时钟/CG/回执备份、失败回滚。SQL保证身份/冻结/终态与精力证据；供应 before/after 差额以及目录属性规则仍由权威 service 重算、原子事务验证。
- `travel/reports` 实际 settled history 按归来时间 desc + stable tripId、逐宠页≤20；从历史 frozen config deterministic replay 核对所有 fact 与 committed ledger，无 speculative drops、旧档无 sidecar 明确 null。Home capture/recall/read 仍原有权限。真实控制中心选择三路线、角色、逐数量补给、预览理由与二次确认、报告逐节点时间/战斗胜负/材料/XP/金币/CG/冻结配置、已读、召回；无真实数值作假、旧报价/换代/重入禁止提交。

## 已验证

app-service 本阶相关39内存+64仓储+21真实SQLite+4备份+4原生子进程，共132通过1原环境跳过；并行已纳入纯记忆93和未挂载独立AI存储16时全包240通过1跳过（不计算为旅行功能）。真实 SQLite 三路线（真实消耗+等级fixture）、在途装备变化/回收及重启冻结、故障回滚、分页/时间tie、旧战报兼容。仓储和业务交叉审查无正常业务阻断。

desktop 实际171/171 targeted（26旅行页面、86preload、20Main、7store、11service-client、21utility transport）；Node/Vue/test TSC 全通过；`pnpm build` 正式生产六入口生成及布局检查通过。未启动窗口、未运行真实Windows，不关闭平台P0。战斗仍 trip-v1 数学模拟，不声称正式多回合技能系统。

下一步006F-2：本地随机触发持久receipt、角色原创分支、过期自动默认、独立事件奖励及精确事件CG；AI/语音/快捷工具独立并行。
