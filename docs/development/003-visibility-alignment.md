# 003-V V1 单陪伴位规则对齐

日期：2026-11-25

## 设计依据

V1.1 第 17.2 节明确首版 `visiblePetIds.length <= 1`，主宠身份、真实位置及显示偏好分别独立。002 已支持逐宠显示状态，但尚未限制同时占据陪伴位。

## 修订

在 `AppService` 权威事务内执行 `PET_SET_VISIBILITY(VISIBLE)`，将原可见宠设为 HIDDEN 与新宠设为 VISIBLE 同时提交；每宠自己的 revision 更新，全局 revision 只增加一次，事件反映实际变更。重复同一 commandId 不额外修改状态。主宠与旅行位置不被改变，原宠仍可在途、结算和保留进度。以后开放多宠同屏容量应显式修改此规则及验收，而非在 renderer 自行覆盖。

## 验证

新增原宠正在旅行时更换陪伴位的用例，确认主宠不变、旅程未被打断、只有一个 VISIBLE、重复回执无副作用。`mise exec node@26.12.1 -- pnpm --filter @pet-desktop/app-service typecheck` 通过，专属测试 38 项通过、1 项旧 SQLite 专属测试按预期跳过。
