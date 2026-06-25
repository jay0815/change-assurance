# Change Assurance 项目规划

## 1. 项目目标

第一阶段目标是跑通一条可信的 PR/MR 合并前审查链路：

```text
Git diff
→ 输入冻结
→ 受控验证
→ Agent 语义审查
→ 证据校验
→ 审查报告
```

首个运行模式：

```text
pre_merge_review + dry_run + Claude Code
```

其中 dry run 不修改代码、不回写 PR/MR、不自动批准或阻断合并。

---

## 2. 第一阶段范围

### 要完成

* 提供统一 CLI：`ca review ...`
* 支持 base/head diff 审查。
* 支持加载仓库级 policy。
* 支持冻结审查输入与生成 run artifact。
* 支持白名单验证命令执行与结果记录。
* 支持 Claude Code 作为语义审查执行器。
* 支持最小审查阶段：

  * change map
  * behavior / regression review
  * test effectiveness review
  * evidence audit
  * synthesis
* 输出：

  * review report
  * issue ledger
  * evidence ledger
  * coverage ledger
* 建立少量 golden cases 做回归验证。

### 暂不完成

* Codex adapter。
* PR/MR 评论回写。
* CI required check。
* 自动修复。
* 多 Agent 并行调度。
* Coding Agent delivery acceptance。
* 复杂领域专项审查器。

---

## 3. 里程碑

### M1：项目骨架与协议

目标：定义系统边界，避免实现先于规则。

产物：

```text
- CLI command skeleton
- review run directory convention
- policy manifest schema
- input manifest schema
- issue / evidence / coverage schema
- 基础项目文档
```

完成标准：

```text
能够创建一个空 review run；
所有核心 artifact 都有明确格式。
```

---

### M2：确定性 Harness

目标：让输入和验证结果成为可信事实。

产物：

```text
ca review prepare
ca review verify
```

能力：

```text
- 解析 base/head
- 收集 diff 与 changed files
- 加载仓库 policy
- 创建 immutable input manifest
- 执行 allowlisted verification commands
- 保存 stdout、stderr、exit code
```

完成标准：

```text
未执行命令不能被标记为 passed；
每次 run 都可独立回放输入与验证结果。
```

---

### M3：Claude Code 审查链路

目标：让 Claude 参与审查，但不拥有最终事实解释权。

产物：

```text
ca review stage --stage change-map
ca review stage --stage behavior-review
ca review stage --stage test-review
ca review stage --stage evidence-audit
ca review stage --stage synthesis
```

完成标准：

```text
每个 stage 输出符合 JSON schema；
每个 issue 可引用输入或验证 artifact；
synthesis 不得新增 issue 或 evidence。
```

---

### M4：正式报告与决策校验

目标：形成可阅读、可审计的 dry run 结果。

产物：

```text
ca review validate
ca review report
```

报告至少包含：

```text
- merge recommendation
- blocking / material / advisory issues
- 已执行与未执行验证
- 已审查与未覆盖范围
- 需要人工确认的问题
```

完成标准：

```text
缺少证据链的 blocker 被降级或拒绝；
报告可独立解释“为什么建议合并或不建议合并”。
```

---

### M5：评测与回归

目标：验证系统不是“看起来会审”，而是真的稳定。

产物：

```text
evals/
├─ fixtures/
├─ golden-cases/
└─ scoring/
```

首批案例建议覆盖：

```text
- 明确回归 bug
- 测试存在但无效
- 无证据猜测
- 正常可合并变更
- PR 描述与 diff 不一致
- 高风险变更缺少验证
```

完成标准：

```text
每次修改 Skill、Prompt、Schema 或 Adapter 后，
可比较 issue precision、blocker precision 与 evidence completeness。
```

---

## 4. 后续演进顺序

```text
Phase 1
Claude Code + PR/MR dry run

Phase 2
Codex adapter + repository policy packs

Phase 3
CI integration + PR summary / check output

Phase 4
Coding Agent delivery acceptance

Phase 5
专项 reviewer、多 Agent 并行与 enforcing mode
```

---

## 5. 当前 MVP 完成定义

MVP 完成不代表“自动 Code Review 已成熟”。

MVP 完成意味着：

> 对一个本地分支相对 base branch 的变更，系统能够以固定协议生成一份带证据、带覆盖范围、可回放的合并前审查报告。
