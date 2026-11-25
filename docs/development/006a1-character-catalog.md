# 006A-1 三角色目录、获得规则和诺瓦素材

日期：2026-11-25。对应 V1.1 §3、§6.1 及 [用户美术方向](../design/character-art-direction.md)。进入阶段 B 游戏完整机制，005 平台验收依用户要求延后。本次独立提交纯模板/获得判定及第三少女资源，未做玩家领取写入。

- `@pet-desktop/domain/character-catalog` version 1 为权威静态角色定义，独立身份语义、背景、职业、人格/话语风格、voiceStyleId（仅 internal hint）、冒险倾向、HP/ATK/DEF/SPD/LUK 初始值与每等级成长，保持两个既有 starter ID 和旧 basePower=30/25，不改历史存档。诺瓦（`nova`）为新仿生机械助手少女，basePower=28。
- 首版产品每模板至多 1 实例、总实例 ≤100（底层不设 characterId 唯一约束，后续可开放同模板多个独立实例）。既有两 starter 免费。诺瓦获得候选要求全账户至少 3 个已结算旅行 + 16 枚共享游戏金币（非购买真钱）。`evaluateCharacterAcquisition` 纯判定未知、已拥有、容量、未达探索、币不足，实际领取时必须服务同事务重算并扣账；目录不私自写宠、币或进度。Unicode 昵称 NFC/trim、有界80 UTF-16单位、拒绝控制/格式/破损surrogate，真正改名仍属服务命令。
- 诺瓦完整内置工程 pack 1.0.0 与 static/SVG fallback（银白发、青蓝光学单眼镜、科技制服裙；明确人形美少女）。图集六语义/24帧、768×512、单帧128×128，49,398 bytes。原两角色 1.0.1 逐字节保留；生成器不覆盖同版本不同内容，registry 精确登记三版本，并验证目录角色与素材一一对应。

## 实际检查

角色目录定向 36/36，真实内置 pack 测试 7/7（含三角色实际文件、hash 与 Vite lazy bytes）、Node26 `generate-demo-packs.mjs --check` 三包通过；domain TSC 及原 Node smoke 7/7、Vue TSC 通过。未创建真实应用宠物、运行窗口、进行付费购买或正式美术验收。

## 下一步

006A-2 真实领取/改名、legacy 获取日期标记、`characters/list` 控制中心窄查询、事务成本/命令回执、独立 UI。纯角色模板进一步形成业务投影前不虚报领取功能已完成。006B/C/D 等纯规则可并行开发，SQL/应用服务集成严格串行迁移以避免冲突。
