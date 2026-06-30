# Change Assurance

Change Assurance 是一个面向 PR/MR 合并前审查的证据驱动代码审查系统。

它的目标不是让模型生成更多评论，而是基于可追溯证据，判断一次变更是否具备合并条件。

## 事实来源

- `package.json` 是项目运行环境、包管理器和基础设施命令的唯一事实来源。

  - 执行安装、构建、测试或检查前，先读取 `engines`、`packageManager` 和 `scripts`。
  - 不要自行猜测 Node、pnpm 版本或项目命令。

- `docs/` 是项目 Wiki 入口。

  - 修改审查行为、工作流、artifact、schema 或 policy 语义前，先阅读相关文档。
  - 本文件不承载完整协议；缺失细节时不得自行脑补。

## 架构边界

- **Skill**：提供用户入口和审查行为指引。
- **Harness CLI**：负责流程编排、输入冻结、验证执行、artifact 写入、规则校验和报告生成。
- **Policy**：仅承载仓库特定规则，不承载通用审查理论。
- **Claude**：可以提出语义结论，但不能自行定义事实，也不能直接写入正式审查产物。

## 不可突破的规则

- 正式审查必须通过 Harness 执行，Skill 不得绕过 Harness。
- `.change-assurance/runs/` 下的 artifact 只能由 Harness 写入，禁止手动修改。
- dry run 模式不得修改业务代码，不得回写 PR/MR。
- 仅允许执行 Policy 中声明的验证命令。
- “计划执行”或“建议执行”的命令不能作为 passed evidence。
- Blocking issue 必须具备有效的 location、trigger、impact、evidence reference，且 confidence 不能为 low。
- Evidence 必须明确区分：

  - Observed：直接观察到的事实
  - Derived：基于事实得出的推断
  - Hypothesis：尚未验证的假设

- Synthesis 只能合并和总结已审计的问题，不能新增 issue、evidence 或验证结论。

## Impact 级别规则

- `merge_blocking`：确认的行为缺陷，会导致运行时错误行为（如状态永久卡死、数据丢失）
  - 要求：高置信度 + observed 证据
  - 只有 Behavior Review 可以提出，Test Review 不允许
- `material`：需要关注但不是确认的生产缺陷（如缺少输入验证、缺少测试）
- `advisory`：低风险建议（如代码风格、文档改进）
- `needs_context`：无法确定风险，需要更多上下文

特殊降级规则：
- evidenceRefs 只指向测试文件 → 自动降级到 material
- evidenceRefs 指向 change-assurance.yaml → 自动降级到 material
- finding 关于 verification/verify/check → 自动降级到 material
- evidenceClass 为 hypothesis → 不允许 merge_blocking

## 去重规则

- `deduplicated`：同一根因、同一行为偏差、同一修复动作
- `related`：同一风险链，但修复动作不同
- Behavior Review 和 Test Review 的 finding 几乎不应被去重
- 跨 stage 去重被禁止，自动恢复为 accepted

## 工作方式

- 优先实现最小但完整的方案，不为了未来可能需求提前扩展。
- 确定性逻辑应放在 Harness 中，不应依赖 Prompt 约束。
- 修改工作流时必须保持 artifact 可追溯性和 schema 有效性。
- 当实现、文档、配置或测试结果之间存在冲突时，必须明确指出冲突；在冲突会影响正确性时，先与用户确认，不得静默选择其中一方。

## 事实与决策原则

- 以仓库文件、命令输出、测试结果、Git 状态和已确认文档为事实依据。
- 不要盲猜、补全或臆想不存在的需求、约束、接口行为、命令结果或实现细节。
- 无法确认的内容必须明确标记为假设、不确定项或待确认项，不得包装为事实。
- 当关键信息缺失，且不同假设会导致不同实现、风险或结论时，先向用户确认；不要擅自选择。
- 当可以通过阅读代码、文档、配置或执行只读检查获得事实时，优先自行验证，不要把可探索的问题直接抛给用户。

## 思考与行动方式

- 思考和行动遵循第一性原理：先识别目标、事实、约束与不变量，再选择实现方式。
- 不要因为现有代码、既有命名或历史实现存在，就默认它们合理；先判断它们是否仍符合当前目标与约束。
- 优先解决真实问题，选择最小、直接、可验证的方案，避免为假设中的未来需求增加复杂度。

## 编码前检查

编写代码前，先回答 Linus 三问：

1. 这是真实存在的问题吗？
2. 有更简单的解决方案吗？
3. 这个改动会破坏什么？

若无法回答以上任一问题，应先补充事实、缩小范围或与用户确认，再开始实现。

## TDD 实现流程

实现代码时，必须调用 `implement` skill，严格遵循 TDD 流程：

1. 先写失败测试
2. 写最小实现让测试通过
3. 重构（如有需要）
4. 验证完整测试套件

## 常用命令

```bash
# 安装依赖
pnpm install

# 构建所有包（使用 tsc -b 增量构建）
pnpm build

# 类型检查（使用 tsc -b --noEmit）
pnpm typecheck

# 运行测试
pnpm test

# 代码检查（oxlint）
pnpm lint

# 自动修复
pnpm lint:fix

# 代码格式化（oxfmt）
pnpm fmt

# 检查格式（不修改）
pnpm fmt:check

# CLI 命令
pnpm ca review prepare --base <ref> --head <ref>
```

## TypeScript Project References

本项目使用 TypeScript Project References 管理包依赖。

**配置结构:**

- `tsconfig.base.json` - 共享编译选项
- `tsconfig.json` - solution 文件，引用所有包
- `packages/core/tsconfig.json` - core 包，启用 composite
- `packages/cli/tsconfig.json` - cli 包，引用 core
- `packages/adapter-claude/tsconfig.json` - adapter 包，引用 core

**构建命令:**

```bash
# 增量构建（自动处理依赖顺序）
tsc -b

# 清理构建产物
tsc -b --clean

# 监听模式
tsc -b --watch

# 详细日志
tsc -b --verbose
```

## 项目结构

```
change-assurance/
├─ packages/
│  ├─ core/             # 领域模型、schema、artifact、校验规则
│  ├─ cli/              # ca 命令入口与 workflow 编排
│  ├─ adapter-claude/   # Claude Code 非交互调用适配层
│  └─ skills/           # Claude Code Skill 模板与安装资源
├─ docs/                # 项目 Wiki 入口
├─ evals/               # 评测与回归测试
└─ scripts/             # 脚本工具
```

**职责边界:**

- `core`: 领域对象、artifact 路径规则、Git 操作
- `cli`: 命令解析、workflow 编排、policy 加载
- `adapter-claude`: Claude Code 调用（未实现）
- `skills`: Skill 模板（未实现）

## pnpm workspace

本项目使用 pnpm workspace 管理 monorepo。

**核心概念:**

- `pnpm-workspace.yaml` 定义 workspace 包位置
- `workspace:*` 引用本地包，不从 npm 下载
- `pnpm -r` 递归执行所有包的脚本
- `pnpm --filter <pkg>` 执行指定包的脚本

**常用命令:**

```bash
# 安装依赖（根级别）
pnpm add -w -D <dev-dep>

# 安装依赖到指定包
pnpm --filter @change-assurance/cli add <dep>

# 执行指定包的脚本
pnpm --filter @change-assurance/core build
pnpm --filter @change-assurance/cli typecheck

# 递归执行所有包
pnpm -r run build
pnpm -r run typecheck

# 添加本地包依赖
pnpm --filter @change-assurance/cli add @change-assurance/core@workspace:*
```

**最佳实践:**

- 根级别放共享 devDependencies（typescript, @types/node）
- 各包只放自己的 dependencies
- 使用 `workspace:*` 引用本地包
- 构建顺序：先 core，再 cli（依赖关系）

## CLI 使用

当前已实现：

```bash
# 准备 review run
ca review prepare --base origin/main --head HEAD

# 验证 review run
ca review verify --run <run-id>

# 语义审查阶段
ca review stage --run <run-id> --stage change-map --engine claude
ca review stage --run <run-id> --stage behavior-review --engine claude
ca review stage --run <run-id> --stage test-review --engine claude
ca review stage --run <run-id> --stage evidence-audit --engine claude
ca review stage --run <run-id> --stage synthesis --engine claude

# 校验审查结果
ca review validate --run <run-id>

# 生成报告
ca review report --run <run-id>

# 完整流程
ca review run --base origin/main --head HEAD --engine claude --dry-run

# 评测
ca eval run --case <case-id> --engine claude --repeat <n>
ca eval run --all --engine claude --repeat <n>
```
