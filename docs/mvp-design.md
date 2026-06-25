# Change Assurance MVP 设计

## 1. 设计目标

MVP 要实现一条可回放的 PR/MR 合并前 dry run 审查链路：

```text
base/head
→ prepare
→ verify
→ semantic review
→ evidence audit
→ decision validation
→ report
```

核心约束：

* Claude Code 负责语义判断，不负责定义事实。
* Harness 负责输入冻结、命令执行、artifact 写入和规则校验。
* 所有正式结论必须来自已保存的 artifact。
* dry run 不修改业务代码，不回写 PR/MR。

---

## 2. 核心分层

```text
Skill
  用户入口与审查行为说明

Harness CLI
  流程编排、输入冻结、验证执行、artifact 管理、规则校验

Policy Pack
  仓库特定规则、验证命令、风险规则

Claude Adapter
  调用 Claude Code，传入阶段上下文，接收结构化结果
```

职责边界：

```text
Skill 不直接完成正式审查。
Claude 不直接写最终 report。
Harness 是 run artifact 的唯一写入者。
Policy 不承载通用审查理论。
```

---

## 3. MVP CLI

```bash
ca review prepare --base origin/main --head HEAD

ca review verify --run <run-id>

ca review stage --run <run-id> --stage <stage> --engine claude

ca review validate --run <run-id>

ca review report --run <run-id>

ca review run --base origin/main --head HEAD --engine claude --dry-run
```

其中：

```text
review run
= prepare
+ verify
+ stage change-map
+ stage behavior-review
+ stage test-review
+ stage evidence-audit
+ stage synthesis
+ validate
+ report
```

---

## 4. 审查阶段

### 4.1 Prepare

确定性执行。

输入：

```text
base ref
head ref
repository root
change-assurance.yaml
```

输出：

```text
diff.patch
changed-files.json
git-state.json
policy.snapshot.yaml
input-manifest.json
```

职责：

* 确认实际审查范围。
* 冻结本次 run 使用的 Git 输入与 Policy。
* 生成唯一 `runId`。

---

### 4.2 Verify

确定性执行。

职责：

* 根据 Policy 计算必须执行的验证命令。
* 仅运行白名单命令。
* 保存 stdout、stderr、exit code、执行状态。

验证状态只能是：

```text
passed
failed
skipped
not_required
```

禁止：

```text
planned
→ 被写成 passed

agent claimed passed
→ 被写成 passed
```

---

### 4.3 Change Map

由 Claude Code 执行。

目标：

```text
识别本次变更影响的模块、行为面、接口、状态流与风险区域。
```

输出：

```text
changed modules
behavior changes
risk areas
review priorities
uncovered context
```

Change Map 不输出 blocker。

---

### 4.4 Behavior Review

由 Claude Code 执行。

目标：

```text
审查成功路径、失败路径、状态恢复、边界条件与回归风险。
```

每个 issue 必须包含：

```text
location
trigger
observed / derived evidence
impact
recommendation
confidence
```

---

### 4.5 Test Review

由 Claude Code 执行。

目标：

```text
判断测试是否真正证明新增或修改行为。
```

重点不是“是否新增测试”，而是：

```text
changed behavior
→ implementation path
→ test case
→ assertion
```

测试缺口必须关联具体行为，不能只写“测试不足”。

---

### 4.6 Evidence Audit

由 Claude Code + Harness 共同完成。

Claude 负责判断：

```text
- issue 是否有足够证据
- 是否把假设误写成事实
- 是否存在重复 issue
- 是否需要降级为 needs_context
```

Harness 负责校验：

```text
- evidenceRef 是否存在
- blocker 是否有 location / trigger / impact
- passed command 是否存在于 verification ledger
```

---

### 4.7 Synthesis

由 Claude Code 执行。

输入只允许读取已通过审计的 artifact。

允许：

```text
- 合并重复 issue
- 汇总 coverage
- 形成 merge recommendation
```

禁止：

```text
- 新增 issue
- 新增 evidence
- 声称执行新的验证命令
- 将 needs_context 升级为 blocker
```

---

## 5. Artifact 目录

```text
.change-assurance/
└─ runs/
   └─ <run-id>/
      ├─ input/
      │  ├─ input-manifest.json
      │  ├─ diff.patch
      │  ├─ changed-files.json
      │  ├─ git-state.json
      │  └─ policy.snapshot.yaml
      │
      ├─ verification/
      │  ├─ verification-ledger.json
      │  └─ logs/
      │
      ├─ stages/
      │  ├─ change-map.json
      │  ├─ behavior-review.json
      │  ├─ test-review.json
      │  ├─ evidence-audit.json
      │  └─ synthesis.json
      │
      ├─ ledgers/
      │  ├─ evidence-ledger.json
      │  ├─ issue-ledger.json
      │  └─ coverage-ledger.json
      │
      └─ report/
         ├─ review-report.md
         └─ review-report.json
```

---

## 6. 核心数据模型

### Issue

```ts
type Issue = {
  id: string;
  severity: 'blocking' | 'material' | 'advisory' | 'needs_context';
  title: string;

  location?: {
    file: string;
    startLine?: number;
    endLine?: number;
  };

  trigger?: string;
  impact?: string;
  recommendation?: string;

  evidenceRefs: string[];
  confidence: 'high' | 'medium' | 'low';
};
```

### Evidence

```ts
type Evidence = {
  id: string;
  kind: 'diff' | 'source' | 'verification' | 'policy' | 'requirement';
  sourcePath: string;
  excerpt?: string;
};
```

### Coverage

```ts
type CoverageItem = {
  area: string;
  status: 'reviewed' | 'tool_verified' | 'uncovered' | 'needs_context';
  evidenceRefs: string[];
  reason?: string;
};
```

---

## 7. Blocker 校验规则

只有同时满足以下条件，Issue 才能保持为 `blocking`：

```text
- 有明确 location
- 有明确 trigger
- 有明确 impact
- 有至少一个有效 evidenceRef
- evidenceRef 指向本次 run 内真实 artifact
- confidence 不是 low
```

否则 Harness 必须：

```text
降级为 material / needs_context
或拒绝生成该 blocker
```

---

## 8. Claude Code 接入

仓库内提供：

```text
.claude/
└─ skills/
   └─ pre-merge-review/
      └─ SKILL.md
```

Skill 的职责：

```text
- 接收用户的审查意图
- 调用 `ca review run`
- 展示 report 摘要
- 不绕过 Harness
- 不自行声明正式审查完成
```

用户体验：

```text
/pre-merge-review --base origin/main
```

正式执行仍由：

```bash
ca review run --base origin/main --head HEAD --engine claude --dry-run
```

完成。

---

## 9. MVP 非目标

MVP 不实现：

```text
- 多 Agent 并行
- 自动 PR 评论
- 自动批准或阻断合并
- 自动修复
- Codex adapter
- Coding Agent delivery acceptance
- 复杂专项风险审查器
```

---

## 10. 设计原则总结

```text
Agent 提出候选结论；
Harness 决定该结论是否具备成为正式结论的资格。

Skill 提供交互入口；
CLI 提供权威执行入口；
Artifact 提供可追溯证据；
Policy 提供仓库约束；
Schema 提供最低可信边界。
```
