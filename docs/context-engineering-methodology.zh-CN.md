# Context Engineering 方法论

[English](context-engineering-methodology.md)

这套方法把耐久 Agent 上下文变成可审计的数据与流程系统。它来自项目 continuity 实践，以及
Boron Content 中经过验证的有边界、approval-first 工作流。

## 运行闭环

```text
Intention -> Ontology 定位 -> 风险/policy 检查 -> 窄范围来源扩展
          -> Agent 执行 -> 验证 -> 语义里程碑写回
```

1. **捕获 intention。** 用户目标、项目、范围和约束要与检索证据分开。
2. **先定位，再搜索。** 先在 Ontology 中解析项目身份、alias、entity、当前 relation、source
   anchor 和 policy reference。
3. **风险门禁。** 高风险 intention 在扩展其它来源前检索已确认 policy。缺少 policy 是客户端
   unresolved gate，不是默认授权。
4. **窄范围扩展。** 符号与实现进入 Codebase；决策、解释与 continuity 进入 Wiki。优先已配置
   live adapter，并明确标记 snapshot fallback。
5. **在 Boron 外执行。** Agent 使用自己的工具、权限和当前状态验证。
6. **只写语义 delta。** 保存决策、已验证结果、纠正和 relation 变化，不保存完整过程对话。

## 五个设计不变量

1. **来源真相有类型。** Ontology、实时外部来源和已存储 snapshot 不能互相冒充。
2. **确认边界显式。** 人工或确定性权威事实可以 confirmed；模型推断保持 candidate。
3. **状态变化有时间。** 用 relation 的 assert/retract 表达变化，而不是堆积重复状态文字。
4. **行动权限在外部。** Context retrieval 永远不会自动授予部署、发布、凭据、付款、删除或其它
   写操作权限。
5. **指标说明反事实。** Re-explanation reuse 和 source-window savings 是不同指标，需要不同证据。

## 有边界工作单元

可重复流程中的一次运行应建模为：

```text
一个已授权 trigger
一个选定 project
一个 primary work unit
一个明确 approval/policy boundary
一个已验证 outcome
一个完成的 Boron session
```

稳定 event ID 和 idempotency key 让重试安全。`no_material_change`、`blocked` 和
`inconclusive` 都是合法结果；为了得到正结果而制造工作会污染 context ledger。

## Agent 与人工分工

| 适合 Agent                    | 需要人工或外部 policy 决策   |
| ----------------------------- | ---------------------------- |
| 解析有边界上下文和 provenance | 确认有歧义的项目身份         |
| 检测过期/冲突证据             | 批准高风险动作或 policy 例外 |
| 运行测试并收集确定性结果      | 提供凭据或作出不可逆承诺     |
| 提议 candidate relation       | 确认推断关系                 |
| 记录脱敏语义里程碑            | 决定敏感证据能否保留         |

## 指标纪律

- Capsule/candidate token 估算用于比较 Boron 运行，不是模型供应商账单。
- 只有确实拥有原始来源大小估算的证据才能报告 source savings。
- 部分覆盖的 savings 必须同时展示 coverage。
- Boron 自己的模型调用要与客户端 Agent 已有模型 turn 分开报告。
- 使用 Inspector 审计 stage 顺序、adapter truth、选择、score 和 coverage，同时不暴露 excerpt
  或凭据。

## 接入检查表

- 定义稳定 project/object URI。
- 定义每项事实和大型资产的 source of truth。
- 定义 candidate 到 confirmed 的 authority。
- 定义高风险 policy gate 和合法 blocked outcome。
- 定义真正值得保留的少量 semantic activity type。
- 为变化状态定义 relation assert/retract。
- 只在需要当前来源访问时配置 live adapter。
- 测试冷启动、重试幂等、部分失败、脱敏、迁移和 installed-artifact 行为。
