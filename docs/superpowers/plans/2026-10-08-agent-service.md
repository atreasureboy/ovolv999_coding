# 统一运行服务与持久事件实施切片

本计划执行已批准的 [核心整改路线](2026-10-03-agent-core-roadmap.md) T09，保留原始架构整改要求。第五批交付 A/B/C 的实际命令行调用链；TTY、Ink、ACP 的 D 迁移单独验收，完成前 T09 保持部分状态。

## 契约与责任

| 范围 | 文件 | 责任及依赖 |
| --- | --- | --- |
| A 持久事件 | core/agentEvents、agentEventStore | 独立实现者；复用持久锁，顺序事件、分段保留、快照、游标过期和有界订阅 |
| B 会话服务 | core/agentService、agentSession | 独立实现者；消费 A，复用 session v2；统一历史、运行身份、取消、补充指令、持久审批视图和完成结算 |
| C 输出契约 | core/outputSchema、cli/execArgs | 独立实现者；严格有界 schema 子集及 exec 参数；不修改旧 pipe |
| 公共接线 | Engine、runContext、sessionManager、approvalBroker、cli/exec、bin、package smoke | 主实现者；只增加兼容可选接口，连接真实 CLI 和安装包 |
| D 后续迁移 | TTY、Ink、ACP | 尚未交付，不以独立服务类替代生产入口迁移的证明 |

事件公共字段为 schemaVersion、sequence、threadId、turnId；turnId 等于预留 runId。Engine 以真实 toolCallId 生成 itemId，服务只在验收及历史保存完成后发布 turn.finished。诊断 EventLog 保留原用途。

服务从既有 config 工厂构建 Engine，不再次读取或扩大配置。历史沿用 sessionId/revision/owner 和原子保存；完整历史与模型窗口分离。旧回合取消、补充指令及审批不得作用新回合。订阅断开不等于运行取消。

## 实施与验证

1. 先观察新回归失败：身份、同名并行工具配对、半段 HTTP 流终结、真实 Write 后事件失败、同回合补充指令、会话快照、审批发布失败。
2. 持久事件验证真实子进程中断、排他写入、序号重开、损坏拒绝、分段保留边界和慢订阅。
3. 服务验证真实 Engine/本地 HTTP、历史续接、并发与过期身份、保存失败、重启不重放及物理隔离。
4. exec --jsonl 经过现有配置装配调用服务；标准输出仅事件；原 pipe 保持回答入口。schema 启动前验证，最终值本地校验，不声称完整 JSON Schema。
5. 独立交叉审查，修复可复现缺陷；冻结后执行全量测试、类型、Lint、构建、安装包与短时持续运行，记录同一源码指纹后提交并正常推送。

不新增跳过、不提高旧测试超时、不隐藏持久化失败、不自动重放未知副作用、不调用付费模型或发布 npm。平台资格与整个路线的完成状态分别记录。
