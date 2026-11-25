# 项目开发约定

- 以 `docs/design/V1.1.md` 为产品与技术基线；架构变更先记录 ADR，避免跨阶段 silently 重写。
- 从零开发，不引用 AIRI 的业务代码或项目结构。
- 按 POC 和开发记录逐步推进。每个可独立验证的开发步骤必须更新 `docs/development/` 和 `docs/qa/poc-matrix.md`（涉及验收状态时），再形成独立 Git 提交。
- app-service 是 SQLite 唯一写入权威；Main 负责宿主、权限和 IPC；renderer 仅持业务投影。AI 不能直接修改游戏数据或执行操作系统命令。
- 新增契约时同步更新类型、运行时校验和测试。不得在日志或仓库中保存真实密钥、用户聊天、数据库、音频或凭据。
- 未实测的 Windows 行为、性能、授权与打包结果明确标记待验证；Mac 测试通过不代表 Windows POC 通过。
- 并行工作只能在明确 ownership 的文件/包内进行；统一由主开发者合并、验证、提交。
