# 004D 跨窗口预装载、视觉交接与权限防竞态

日期：2026-11-25。对应 V1.1 §16.3–16.4、§17.2–17.4。此前 Canvas2D 只支持同 surface 原子替换；本步骤补齐首版单陪伴位下 **两个独立 pet 窗口** 的视觉交接逻辑。业务服务仍然唯一权威。

## 实施

- `main/pet-handover.ts` 为纯计划器，以权威 snapshot、service generation、host suppression、窗体 identity/phase/ready 信息和单调时间计算当前目标、active、staging、retiring、应删除和创建窗体。不允许多可见或非 HOME 目标；窗口身份固定为 petId、characterId、service generation。`bootstrap.ts` 应用计划。
- 真正换宠时旧且 HOME、健康、已可见的 A 可以保留画面作为 retiring；新 B 隐藏 staging。A 立即释放 2 秒交互租约并整窗穿透；旧画面仅是视觉过渡，不再许可领域命令。B 必须文档加载、首次绘制与角色准备成功（或明确 fallback）三项就绪才成为 active；先隐藏/销毁旧 A 再显示 B；最多一个可见旧/新窗口和一个 staging。
- A→B→A 可恢复原本就绪画面，销毁多余 staging；A→B→C 不延长 A 的既定 10 秒退场截止时间。新窗口 staging 也有限时，与原有失败重试/托盘诊断协作；切换失败不得无限保留旧角色，锁屏、休眠、离家、免打扰、手动隐藏、服务换代立即清理/恢复，不复用旧代 ready。
- `petVisualReady` 为 pet preload 独占窄方法（generation、characterId、READY/FALLBACK，无路径、任意 petId/命令），strict runtime schema、固定 channel、脱敏响应。Main 从绑定窗口推导身份，拒绝 CC/非主帧/非受信来源/错误角色/陈旧代/未加载文档等信号。READY 只代表表现层已准备，不能修改宠物或放开奖励权。`PetCanvas` 在验证 decode/draw 后或非命中 fallback 后发报告，隐藏 staging 不依赖 RAF；`PetApp` 绑定权威窗口代和角色、限次重试，旧回执不控制新身份。旧 HIDDEN 画面保留但暂停动画和禁用动作。
- Main 只允许当前 visible active 宠物发起已有允许列表内的本宠命令，retiring/staging 仅可读 snapshot（托盘/控制中心入口独立）。active 命令必须带 Main 当前 snapshot revision，任何缺失或过期/未来 revision 拒绝；即便服务已切换但主机尚未收到新 snapshot，服务原事务 precondition 仍可拒绝旧宠命令，消除额外跨进程竞争。CC 原权限不变。

## 已执行专项检查

- Main boundary 15/15、handover 8/8（合计 23/23）：双重就绪、A→B→A/过期、旧有效/home 与抑制、跨代、请求角色、必需 revision。
- preload 42/42（相比 003 新增 22 项）：窄视觉方法、严格输入及异常响应、控制中心不可调用。
- Main 和 preload 首轮 Node tsc、Vue tsc 通过；随后并行 004E 正在更改 app-service 存储接口，完整跨包 tsc 须在 004E 集成后再回归（未将其他模块的中途报错标记完整成功）。本步骤没有启动真实窗口。

## 后续

原子交接是已实现并有纯计划/边界测试的逻辑；实际 Windows `ready-to-show`、显示、快速换宠、穿透和超时体验依然待平台验收。正式 Pixi WebGL、磁盘可下载资源版本/签名、LRU/pin 仍需开发；004E 先处理历史 CG 与冻结旅行素材引用，保障随机事件可回看而不重奖。固定产品评分保守不变；不以窗口数或测试数虚增覆盖。
