# Agent API、文档与文案优化计划

## 状态与范围

- **状态：源码实施、构建与便携受控门禁已完成；依赖重装及产物 digest 证据受阻，未安装部署。** A/B/C/D 与 E 的受控协议回归已落地；真实模型行为收益尚未验证。本文记录实施状态，不是公共发布验收报告或部署许可。
- 基线：`df91ce8` 加当前未提交工作区；实施前必须重新核对源码与工作区差异，不得按 HEAD 覆盖已有改动。
- 讨论依据：`artifacts/reviews/agent-api-and-wording-current.zh-CN.md` 及当前源码。该快照是被忽略的审计产物，不是构建输入、live system prompt 或最终 provider wire schema。
- 目标：提高首次调用正确率和故障恢复质量，减少路径猜测、重复派单与不必要管理调用。声明字符数只是辅助指标，不以继续压缩文字为主要目标。
- 本计划本身不授权真实模型、网络、人类审批、安装部署、Nix 激活或发布；后续显式用户授权另行限定范围，公共发布状态不因计划或受控测试改变。

## 已决设计（实施口径，优先于下文实施前快照）

- 所有相对路径（包括 `../foo`）按该 Agent 的 execution cwd 解释；绝对路径保持原义。Source cwd 仅保留 instructions/settings/config/trust 继承职责。
- 未初始化 worktree 的所有相对项都逻辑延迟绑定。Source 候选只做 deny-only 预检（含适用 external surfaces），不验 source 存在性，不导入 ALLOW。不同 Agent provisional 资源暂无已知重叠，不等于真实 disjoint。
- 健康 session/workspace 创建后、history begin / child input 之前，执行真实 canonical/边界/权限/存在性/claim 复核。失败仅当前 task failed，健康 Agent idle 可复用；setup/SDK assembly 失败另按现有 cleanup/recovery 处理。
- 首次 provisional→bound 是一次性 refinement，既有 bound ownership/tree 不能变化；后续 pump/answer 对 ownership/tree claims 严格资源相等。Inputs 每次按声明重验真实路径/权限/存在性，不是持有的资源锁（after 可产生 input symlink）。所有字段仍须逐项对应字面声明。
- 可信 runtime 使用 authority-owned live workspace binding 的 restriction-alias seam；不让模型提供 source roots，不新增第二套权限矩阵。Source alias 不能导入 ALLOW 或外部边界豁免。
- 执行 slot 在 actual execution exit 后释放，可早于 history finalization；resident、claims、tree lease、Owner lease 保留各自 finalization/cleanup 确认边界。cleanup_uncertain 不意味着仍占 provider execution slot，更不允许释放 claims。
- Spawn 是 create + submit first task，可排队，不承诺立即执行。After 固定绑定 current or latest task，非 completed 失败；依赖回答续跑须等 agent_answer 返回后再提交，不靠同 batch 顺序。
- Schema 声明/token 预算与工具回复 65536-byte double-JSON cap 是两套预算；自然语言可增加 schema 预算，不能据此放宽回复 cap。实测字符量不是 tokenizer 或模型效果证据。

## 0. 总体动机（Motivation）

本节与所有“现行原文”均为**实施前历史快照**，不是切换后的操作指引；当前规范见 [tool contract](tool-contract.md)、[workspaces](workspaces.md)、[task dispatch](task-dispatch.md)。

对当前源码（`harness/src/tools/parent-tools.ts`、`harness/src/core/owner-controller.ts`、`harness/src/core/dispatch.ts`）与 API 快照的审计表明，父模型在委派管理调用上的摩擦主要来自两类根因，而非单纯“缺少长篇系统提示词教程”：

1. **底层路径契约分裂（Split Coordinate System）迫使文案解释反直觉例外**
   - 现行实现中，子 Agent 的工具在绑定后的实际 `workspace.cwd`（例如独立 worktree）执行，但 `dispatch.inputs / ownership / tree` 的相对路径却在接单时按父会话的 `source_cwd` 解析；且首次 `worktree` 任务在 `agent.workspace` 尚未初始化前直接拒绝声明 `tree`（`DISPATCH_WORKTREE_UNINITIALIZED`）。
   - 这迫使模型在同一次调用中同时维护两个路径基准，并在 schema 的 `prompt`（要求 `"full file paths"`）与未知的未来 worktree 路径之间陷入矛盾：模型要么盲猜路径，要么被迫拆成“先不填 `tree` 启动 → 调 `agent_list` 查真实路径 → 再调 `agent_run` 续跑”的多步管理调用。
   - **治本原则**：如果你需要用三句话解释一个反直觉的例外，说明底层契约需要收敛。将“声明 → 逻辑资源 → 真实绑定资源”的分阶段转换收进可信 `core/runtime`，才能让模型面对唯一、自然的相对路径规则。

2. **过度压缩的“电报体（Telegraphic Compression）”与“内部校验器视角（Validator Perspective）”增加了模型解码负担**
   - 前期为缩减声明体积，多处 schema description 被压缩为高密度分号短句或内部行话（如 `"One full-gate validation owner."`、`"If none, spawn; for its result alone, spawn with after."`、`"Requires settled needs_input and an idle reusable Agent."`、`"current, pending question, else latest"`）。
   - 这类写法站在**内部状态机断言视角**而非**调用者行动视角（Caller Action Perspective）**，存在代词悬垂（如 `builds_on` 中的 `its`）、因果链缺失（如为何 `ask_parent` 后不能立即 `agent_answer` 或在同一并行批次中挂 `after`）以及术语不自洽。
   - **治本原则**：工具 schema 声明预算与 65536-byte 回复 envelope 预算独立审查；工具 schema 描述应优先保证**首次阅读零歧义与下一步操作可直接执行**，不再为节省几十个声明字符而牺牲关键行动条件。

## 1. 必须保留的边界

1. 保留九个父管理工具及现有功能：必填 `agent_run.builds_on`，可选 label、after、dispatch、context、budgets，以及 wait 的 all/any、各工具的 wait_ms、read 的 task/cursor/max_chars。
2. 子通信仍是 `alert_parent` / `ask_parent`，无嵌套委派；退休工具名继续在 deny/exclusion 中，不增加别名。
3. 保留 profile ID、`harness:*` 历史记录、配置路径、生命周期事件和 `Symbol.for` keys；历史记录不改写，用户文件不自动覆盖或删除。
4. Owner 生命周期与原子 claims 属于 core；workspace、SDK、文件系统和权限服务适配属于 runtime；授权仍归 managed permission system/policy；UI 仅投影。
5. Off、接受请求回放、任务绑定、问题身份与 reservation、结果分页、通知消费、清理不确定和 Owner lease 的边界不能被优化削弱。
6. 不复制凭据，不静默启用模型，不放宽 deny，不把 dispatch、工具审批、profile 或 workspace 当作权限授予或 OS sandbox。
7. 不重新引入 metadata-only read、details 模式、任意 cwd、自动安装/合并/删除、恢复 hydration、force release 或通用自动重试。

需始终准确表述：

- `ask_parent` 记录问题并要求子 Agent 收尾，**不会强制暂停或立即产生可回答的 settlement**。
- closed schema 能约束输入，但不证明取消、SDK input admission 或生命周期转换具有原子性。
- interrupt 是请求停止；kill 的 exiting/cleanup_uncertain 不是已释放证明。

## 2. 工作包与优先级

| 工作包 | 优先级 | 交付物 |
| --- | --- | --- |
| A. 统一 workspace 路径语义与延迟绑定 | P0，主要契约改动 | 一次 spawn 可声明完整 worktree 工作，不要求先查询路径再续跑 |
| B. 高风险语义与错误恢复文案 | P1，与 A 同步收口 | 直接可操作的工具/参数描述与 resolution |
| C. 人类快速使用文档与权威来源整理 | P1 | 工具选择表、可验证的完整流程、减少重复规范 |
| D. Envelope 预算维护 | P1，贯穿实施 | 必需字段预算清单、极端组合与生成式回归 |
| E. 行为评测 | P1 受控协议测试；真实模型另行授权 | 误用场景、明确指标、可比较的基线 |

不在本轮顺带改工具数量、命名策略、difficulty 路由或 delegation 模式。先测试其实际效果，再决定后续取舍。

## 3. A：统一 workspace 路径语义与延迟绑定

### 3.1 当前问题与目标规则

实施前子工具在实际 workspace cwd 执行，但 dispatch 的相对路径以 source cwd 解释；未初始化 worktree 又不能声明 tree。模型因此既要记住双重基准，也可能为了声明 tree 而先启动任务、查询 cwd、再提交后续任务。

注意：**当前首个 worktree 任务已经可以不声明 tree 而执行获分配的检查**，并非所有 worktree 工作都必须两步走。此改动消除的是“完整声明必须等路径”的额外成本，而不是新增构建权限。

目标规则：

> dispatch.inputs / ownership / tree 的相对路径，一律相对于该 Agent 的实际执行 cwd；绝对路径保持原义。checks 仍是计划标识，不是命令、权限或执行证据。

| 选择 | 相对路径基准 |
| --- | --- |
| shared | 原始执行 cwd |
| worktree | 绑定后的实际 worktree cwd；source cwd 在仓库子目录时保留相应子目录位置，不误用 checkout root |
| 原仓库或其他目录的显式引用 | 使用绝对路径，仍接受普通权限和外部目录检查 |

这是一项明确的父 API 契约变化，不保留旧 source-relative 语义的隐藏兼容分支，不增加 `path_base` 开关、初始化工具或 `$WORKTREE` 路径宏。原始 source cwd 仍用于源项目 instructions/settings/config/trust 继承，不能因路径基准变更而被替换。

### 3.2 目标调用示例

以下是本次实施目标调用；源代码切换与受控验证统一完成后生效，不作为已通过证据：

```json
{
  "agent": "alpha",
  "profile": "worker",
  "reasoning_difficulty": 3,
  "workspace": "worktree",
  "prompt": "在分配的工作副本中修改 src/parser.ts，并执行指定检查。",
  "dispatch": {
    "inputs": ["src/parser.ts"],
    "ownership": ["src/parser.ts"],
    "tree": "build",
    "checks": ["parser tests"]
  }
}
```

预期：dispatch 中的文件/目录声明均引用该工作副本，不要求父模型预知其绝对路径。tree 可声明尚未创建的输出目录，但若目标已存在则必须是目录。inputs 必须在实际检查时存在。

想处理当前 dirty/untracked 内容仍应选择 shared；worktree 不因此复制源工作区文件、依赖、缓存或设置。声明 source 的绝对输入也不会自动把它复制进 worktree。

### 3.3 内部表示与代码设计：区分声明、逻辑资源与已绑定资源

**动机**：不能仅把 `prepareDispatch` 的 `cwd` 参数简单替换。当前 `OwnerController` 在 `submit`（接单）和 `pump`（出队）时，worktree 尚未创建（`createSession` 位于异步的 `executeRun` 内部），此时依赖 `PreparedDispatch` 进行 `checkClaims` 冲突检测；同时，若任务 1 在 `queued` 阶段被 `agent_interrupt` 取消，该 `worktree` Agent 在后续调用 `agent_run`（任务 2）时 `agent.workspace` 依然为 `undefined`。因此，走“未绑定逻辑路径”还是“已绑定真实路径”的唯一判据必须是 **`agent.settings.workspace === "worktree" && !agent.workspace`**，而非工具名是 `agent_spawn` 还是 `agent_run`。

实施时在内部明确区分三层结构（不给模型新增 UUID、状态矩阵、必需回复字段或路径注册工具）：

1. **原始声明（`Dispatch`）**：模型提供的有界字面路径及 `checks`，作为不可变请求内容保留在 `RunRecord.dispatch`。
2. **准备态路径节点（`PreparedPath`）**：在 `harness/src/core/dispatch.ts` 中区分已解析真实路径与待绑定 worktree 相对路径：
   ```ts
   export type DispatchPath = {
     kind?: "bound";
     path: string;
     canonical: string;
   };

   export type UnboundWorktreePath = {
     kind: "unbound_worktree";
     /** 仅由受信 Owner 填入的内部 agent.id，绝不接受模型输入或对外暴露 */
     agent_id: string;
     /** 相对于该 Agent 实际 worktree 执行 cwd 的规范化相对路径 */
     rel: string;
   };

   export type PreparedPath = DispatchPath | UnboundWorktreePath;
   ```
   - 当 `agent.settings.workspace === "worktree" && !agent.workspace` 且为相对路径时（包括 `../foo`），生成 `UnboundWorktreePath`；`rel` 规范化不抹去 `..` 的真实含义。
   - 任何显式**绝对路径**（无论在 `shared` 还是未初始化的 `worktree` 中），在接单期一律直接解析为 `kind: "bound"`，当场执行权限、外部目录与同 Owner Claim 冲突检查。
3. **冲突判定矩阵（`resourcesOverlap` / `sameResources`）**：
   - **`bound` vs `bound`**：沿用现有 `pathsOverlap`，比对 `path` 与 `canonical` 的父子包含关系。
   - **`unbound_worktree` vs `unbound_worktree`**：
     - 若 `left.agent_id !== right.agent_id`：接单期**暂无已知重叠**（例如同名 `tree: "build"` 可并行入队），不是实际资源 disjoint 保证；`..`、symlink 或其他别名仍可能在绑定时重叠。
     - 若 `left.agent_id === right.agent_id`：比对规范化相对路径 `rel` 的父子包含关系。
   - **`unbound_worktree` vs `bound`**：接单期不假定冲突；待阶段 3（worktree 创建后、子模型输入前）将 `unbound_worktree` 全部解析升级为真实 `bound` 路径后，立即重跑 `checkClaims`。若仓库内 symlink 或相对路径实际指向了已被占用的 `bound` 资源，在交付子模型前当场拦截。

### 3.4 接受与执行流程（三阶段检查与关键代码机关）

1. **阶段一：准备与接受（`OwnerController.submit` & `dispatch-runtime.ts:prepare`）**
   - 校验 closed schema、字面路径语法（`supportedLiteralPath`）、界限、profile、`after` 和 admission 状态。
   - 对已知目标（`shared`、已初始化的 `worktree`、以及任何显式绝对路径）执行完整的权限、`canonicalPath` 与冲突检查。
   - 对未初始化 worktree（`!agent.workspace`）的相对路径：
     - **静态 Deny 前置拦截**：结合 `source_cwd` 计算对应的源路径候选值并查询 `checkPermission`；若相对路径词法越出 `cwd`（如 `../foo`）则同时查询 `external_directory_*`。只要命中 `"deny"`，当场在接单期抛出 `PREFLIGHT_DENIED`（已知 deny 绝不被延迟或被未知路径诊断掩盖）。
     - **禁止冒充存在性与授权**：不对未创建的 worktree 相对路径做 `source_cwd` 下的 `statSync` 存在性检查（不用 source 的 dirty 文件冒充 worktree 输入），也不把 source 上的 `"allow"` 当作跨目录授权。
   - `core` 原子记录逻辑 Claim 与接受事实；`prepare`、admission 和 accepted-request replay 均不创建 worktree。

2. **阶段二：出队与任务启动（`OwnerController.pump`）**
   - `after` 仍绑定原始任务；依赖未 `completed` 时不得提前执行，失败依赖仍由 `failDoomed()` 及时失败其后继。
   - 若工作区已就绪（`shared`，或之前任务已初始化好 `agent.workspace` 的 `worktree`），在 `pump()` 中用真实工作区路径同步执行 `prepareDispatch(..., deferInputs = false)` 与 `checkClaims`。
   - 若为尚未初始化的 `worktree`（`!agent.workspace`），`pump()` 仅复核已知/绝对路径冲突与前驱状态，将真实文件存在性检查（`deferInputs = false`）留到 `executeRun` 内 worktree 创建完成那一刻，绝不在 worktree 创建前用 `source_cwd` 误判输入缺失或通过。
   - `runtime` 在原有 `executeRun -> createSession` 时点创建 worktree，解析并记录当时的本地 `HEAD`，通过 `bindWorkspacePolicy` 绑定受信 source policy，返回可信 `{ workspace, workspace_details }`（含 `checkout_root`）及 authority-owned live `workspace_policy` seam，而非交给 core 拼装 raw source-root 授权别名。不能提前分配目录或提前固定排队任务的 `HEAD`；setup 失败不能退回 `shared`。

3. **阶段三：Worktree 绑定后、交付子模型之前（`OwnerController.executeRun`）**
   - 在 `createSession` 返回并完成 `validWorkspace` / `validWorkspaceDetails` 校验后、**在 `port.history.begin` 与 `port.run` 交付给子模型之前**，基于真实 `workspace.cwd` 执行绑定态 `prepareDispatch(..., deferInputs = false)`：
     - **真实路径与外部边界检查**：所有相对路径基于真实 `workspace.cwd` 解析出 `path` 与 `canonical`；凡越出 `workspace.cwd`（含通过 `..` 或 symlink 指向 `checkout_root` 兄弟目录或外部目录）一律触发 `external_directory_read` / `external_directory_write` 检查。
     - **Source Policy Alias Deny 复核**：由 authority-owned live workspace binding 生成已验证的 restriction aliases；runtime 查询这些路径的 `checkPermission`，命中 `"deny"` 即抛 `PREFLIGHT_DENIED`。不让模型或 core 自行传 raw source roots 冒充绑定；仅继承限制，不导入 `ALLOW` 或豁免外部目录检查。
     - **真实输入与目录分类**：在真实 `workspace.cwd` 下执行 `classify()`，校验 `inputs` 存在且类型合法、`tree` 若存在则必须为目录。
     - **原子升级 Claim 与获取 Tree 锁**：逐项验证声明对应，并仅允许 ownership/tree claims 的一次性 provisional→bound refinement（已 bound 资源仍严格不变）；inputs 按真实路径/权限/存在性重验，不作为持有锁。调用 `this.checkClaims(prepared, run.claim, new Set(), run.record.run_id)` 复核真实 `canonical` 路径与同 Owner 所有活跃/挂起 Claim 的交集；通过后原子更新 `run.prepared = prepared` 及 `run.claim.prepared = prepared`，**随后再调用 `await this.observeDispatch(run)`**。这保证 `dispatch.start` 的 `FileLeaseLock` 与最终 `validationReceipt` 均使用真实 worktree 下 `tree.canonical` 绝对路径。
   - 每个 `await` 后继续遵守 Owner/context/revision/stop 检查；绑定中途取消不得继续交付 prompt。

4. **阶段四：失败分类、Agent 存活保护与清理（`OwnerController.finishRun` 关键机关）**
   - **防止误杀已建好 Session 的 Agent（`owner-controller.ts:1233` 机关）**：
     - 现行代码第 1233 行为：`if (run.quarantine || (!run.hadSession && !run.record.input_entered && !run.record.stop_reason && !run.prestartFailure))` 则调用 `releaseAgent(agent, "initialization_failed", run)`。
     - 对于首次 `worktree` 任务，入队时 `run.hadSession === false`。当 `createSession` 已经成功创建出健康的 `agent.session` 与 `agent.workspace`，但随后的绑定态 `prepareDispatch` / `checkClaims` 失败（如 `DISPATCH_INPUT_MISSING`、`PREFLIGHT_DENIED`、`RESOURCE_OWNED`）时，**必须在 `executeRun` 的绑定 `catch` 块中显式设置 `run.prestartFailure`**（区分 `"dependency_input_missing"` 与 `"dispatch_preflight_failed"`）。
     - **动机**：若不设置 `run.prestartFailure`，`finishRun` 会将输入缺失或权限/资源冲突误判为 SDK/Session 初始化崩溃（`initialization_failed`），从而错误销毁刚刚建好的健康 Agent 与 Session，且丢失精确的 `outcome.reason`。设置 `run.prestartFailure` 后，仅当前 Task 明确失败并在 `finishRun` 末尾通过 `releaseClaimsIfIdle(agent)` 释放该 Task 的未决 Claim，而 Agent 本身保持 idle 可复用（或由父模型显式 `agent_kill`）。
   - 部分创建产物按现有 recovery/retention 规则保留；不输出预期但不存在的路径，不自动删除。
   - 资源释放仍以真实执行退出、finalization 与必要 cleanup 确认为准；不确定状态不得 force release。

### 3.5 阶段 × 不变量核对表与边界约束

| 阶段 / 场景 | 相对路径状态 | 允许的副作用 | 冲突与权限保证 | 失败时的状态与回滚保证 |
| --- | --- | --- | --- | --- |
| **1. Admission (`submit`)** | `shared` 或已有 `agent.workspace`：`bound`；未初始化 `worktree`：`unbound_worktree`（绝对路径仍为 `bound`） | 仅内存接单与记录逻辑/绑定 Claim；**绝不创建 worktree** | 静态 source deny、已知越界 deny、以及 `bound` 路径冲突当场拒绝 | 同步抛出 `HarnessError`，不入队、不消耗 Agent 名称或槽位 |
| **2. Accepted Replay** | 保持首次接受时的状态 | 零副作用；不新分配 worktree、不重复转换 Claim | 相同 `request_digest` 幂等返回；不同参数报 `REQUEST_CONFLICT` | 不消费已排队的通知或更改已有任务状态 |
| **3. Queue (`pump`)** | 已绑定工作区重验 `bound`；未初始化 `worktree` 保持 `unbound_worktree` | 失败依赖由 `failDoomed` 移除队列；不提前为阻塞任务建 worktree | 已绑定工作区复核 `sameResources` 与 `checkClaims` | 设 `run.prestartFailure`，任务转 `failed`，不占用执行并发槽 |
| **4. Worktree Init & Bind (`executeRun` pre-input)** | `unbound_worktree` → 全部解析升级为真实 `bound` | 创建 worktree（锁定当时本地 `HEAD`）、绑定 policy alias、随后锁 `tree` | 真实 `workspace.cwd` 权限 + source alias deny + `external_directory_*` + 真实 `canonical` 同 Owner `checkClaims` | Worktree 创建失败附带 `recovery` 并释放 Agent；绑定后预检/冲突失败设 `run.prestartFailure`，保留健康 Agent/worktree，释放当前任务 Claim |
| **5. Question & Answer Rollback** | `agent.workspace` 已在提问任务中绑定，全程为 `bound` | `answer` 继承原 `dispatch`、`workspace` 与 `claim`（含已持有的 `tree` lease） | 先校验 `sameResources` 与 `checkClaims` 通过后再更新引用，**绝不提前覆盖 `inheritedClaim.prepared`** | 若在 `input_entered` 前失败或取消，解除 `question.reserved_by`，将 `claim.run_id` 指回原提问任务，原问题保持可回答且不丢 `tree` 锁 |
| **6. Kill / Cleanup Uncertain** | 任意 | 请求停止并尝试关闭 Session 与释放 `claim.lease` | 关联 Claim/resident/lease 保留必要 cleanup 边界；provider execution slot 在真实 execution exit 后释放，不混同 | 保留 worktree 目录供人工恢复；`cleanup_uncertain` 不准提前释放对应 Claim |

补充边界说明：

- Jev 的 `source-cwd` evidence 与实际 `worktree cwd` 的既有限制不顺手放宽；路径优化不等于修复自动审批证据绑定。
- `workspace` 的公开成功元数据仍只能来源于受信成功 binding（Run-local），不能借用 Agent 后来任务的路径补造早期事实。

### 3.6 主要实施位置

- `harness/src/core/dispatch.ts`：`PreparedPath`（`DispatchPath | UnboundWorktreePath`）类型、`resourcesOverlap` 冲突判定、以及接收真实执行 `cwd` 与 `source_cwd` 的 `dispatchText`。
- `harness/src/core/owner-controller.ts`：`prepareDispatch` 的未绑定/已绑定双模式、admission/pump/executeRun 的三阶段检查、Claims 原子升级、`executeRun` 绑定失败时的 `prestartFailure` 分类保护、answer lineage 回滚保护，以及移除 `DISPATCH_WORKTREE_UNINITIALIZED`。
- `harness/src/core/ports.ts` 及 `harness/src/runtime/child-factory.ts`：透传 worktree 策略复核所需的 authority-owned live binding seam（`workspace_policy`，不是模型可控 source roots）；新增公有入口同步更新 `owner-guard-coverage.test.mjs`。
- `harness/src/runtime/dispatch-runtime.ts`：未初始化 worktree 的静态 source deny 预检、已绑定 worktree 基于真实 `workspace.cwd` 的路径解析、source policy alias deny 复核、`external_directory_*` 边界检查与 `classify` 输入/目录检验。
- `harness/src/tools/parent-tools.ts`：**在完整绑定链落地并通过受控测试后**，移除 `checked()` 中的首任务 `tree` 拒绝（第 212–216 行），同步更新 `dispatch`、`prompt` 及相关工具描述；切勿先移除 guard。
- 相关 schema/preflight 文案、错误 resolution、资源声明和文档一起切换，不输出相互矛盾的提示。

## 4. B：工具、参数与错误文案（含 Motivation 与具体定稿方向）

下列“现行原文”仅保存实施前历史比较；最终注册对象由
`harness/src/tools/{parent-tools,child-tools}.ts` 定义，契约见 `tool-contract.md`。
不以这里的英文备选稿代替实际注册 schema。

### 4.1 核心工具与参数描述修订对照

文案修订遵循三条准则：
1. **从“校验器断言视角”转为“调用者行动视角”**：直接告诉模型满足什么条件、先调什么再调什么，而不是堆砌内部状态名。
2. **消除悬垂指代与电报体省略**：补齐被分号省略的主语和因果链。
3. **与工作包 A 的唯一相对路径基准严格自洽**：消除 `prompt` 要求 `"full file paths"` 与 `dispatch` 使用工作区相对路径之间的自我矛盾。

#### (1) `agent_spawn` 及 `prompt` 参数
- **Motivation**：
  - 实施前 tool description 仅写 `"Create an Agent for new work/reviews"`，未点明该调用会**创建 Agent 并提交首个任务（可排队）**，而非创建空 worker 容器或保证立即执行。
  - 现行 `spawnSchema.prompt`（及 `runSchema.prompt`）写的是 `"full file paths"`（在英文中常被模型解读为必须写 `/home/...` 绝对路径），这与未知的未来 worktree 路径直接冲突，是诱导模型去猜路径或拆成两步调用的重要诱因。
- **现行原文**：
  - Tool: `Create an Agent for new work/reviews. Model/profile/workspace/context/budgets stay fixed; no nested delegation. Follow-ups: agent_run. If acceptance is unclear, check agent_list before repeating.`
  - `prompt`: `Task instructions: deliverable, scope, stopping conditions, full file paths and needed context.`
- **目标英文定稿**：
  - Tool:
    ```text
    Create an Agent and submit its first task for new work or reviews; execution may queue. Model, profile, workspace, context and budgets stay fixed; no nested delegation. Use agent_run for follow-ups. If acceptance is unclear, check agent_list before repeating.
    ```
  - `spawnSchema.prompt`：
    ```text
    Task instructions: deliverable, scope, stopping conditions, workspace-relative paths (or explicit absolute paths), and needed context.
    ```
  - `runSchema.prompt`：
    ```text
    Follow-up instructions with scope, deliverable and workspace-relative paths (or explicit absolute paths); earlier conversation is retained.
    ```

#### (2) `agent_run` 与 `builds_on` 参数
- **Motivation**：现行 `builds_on` 的 `"If none, spawn; for its result alone, spawn with after."` 存在严重的代词悬垂（`"its"` 语法上离 `none` 或 `this task` 最近，实际却指代“该 Agent 先前的工作”），且省略过多导致模型不易一眼区分何时复用会话、何时新建会话挂 `after`。
- **现行原文**：
  - `builds_on`: `Earlier work this task continues; not sent to the Agent. If none, spawn; for its result alone, spawn with after.`
- **目标英文定稿**：
  ```text
  Earlier work by this Agent that this follow-up continues; recorded for coordination, not sent to the Agent. For unrelated work, use agent_spawn. If a new Agent only needs this Agent's output, use agent_spawn with after.
  ```

#### (3) `after` 参数（`agent_spawn` / `agent_run` 共用）
- **Motivation**：模型容易把 `after: ["alpha"]` 误解为“动态等待 `alpha` 未来所有的任务或回答续跑”。必须点明它绑定的是**本次调用被接受那一刻 `alpha` 的 current or latest task**，且当 `alpha` 处于 `needs_input` 时，不能在同一批并行调用中一边 `agent_answer` 一边挂 `after`，必须先完成 `agent_answer` 让续跑任务成为当前任务。
- **现行原文**：
  `Tasks selected now; all must complete. Results are reference context. For answer continuations, name the Agent after agent_answer returns.`
- **目标英文定稿**：
  ```text
  Wait for each named Agent's current or latest task, fixed when this call is accepted, to reach completed; any other settled status fails the dependency. Results become reference context. Does not follow later tasks or answers: wait until agent_answer returns before naming its Agent here.
  ```

#### (4) `agent_answer` 与子工具 `ask_parent`（双向预期对齐）
- **Motivation**：
  - 父模型侧：现行 `"Requires settled needs_input and an idle reusable Agent"` 是内部状态机术语。模型看到 `has_question: true` 或读到历史问题文本时，需要知道具体操作动作：等原任务真正结束进入 `status="needs_input"` 并从 `agent_wait` / `agent_read` 拿到当前的 `question_id`。
  - 子模型侧：`ask_parent` 只是记录问题，**不会强制中断子模型的当前 turn**。若子模型调完 `ask_parent` 后继续调用其他工具，任务就无法 settle 到 `needs_input`，父模型也拿不到 `question_id`。因此在 `ask_parent` 中点明因果关系，能显著减少子模型“提问后仍不收尾”的故障。
- **现行原文**：
  - `agent_answer`: `Answer the exact pending question_id and start a continuation. Requires settled needs_input and an idle reusable Agent. Keeps fixed settings and the asking task's label/dispatch.`
  - `ask_parent`: `Ask for a required parent decision, then finish. The first question is kept, not replaced.`
- **目标英文定稿**：
  - `agent_answer`:
    ```text
    Answer the exact pending question_id and submit a continuation. First wait for status="needs_input" and a current question_id from agent_wait or agent_read; historical text alone cannot be answered. Keeps fixed settings and the asking task's label/dispatch.
    ```
  - `ask_parent`:
    ```text
    Record a blocking question for the parent, then stop calling tools and end your turn so the task can settle for an answer. Only the first question is kept. This call does not force suspension.
    ```

#### (5) `dispatch` 对象、`dispatch.tree` 与动态 `dispatchText`
- **Motivation**：
  - 配合工作包 A，将相对路径基准统一表述为 `the Agent's execution cwd`，彻底移除“先不填 `tree`、查 `agent_list` 后再填绝对路径”的两步指引。
  - 将内部黑话 `"One full-gate validation owner."` 还原为清晰、可执行的自然语言指令。
- **现行原文**：
  - `dispatch`: `Scope/planned checks, not permissions or execution evidence. Literal paths; no padding/expansion/globs. Relative paths use source cwd even in worktree; outputs there need absolute paths. One full-gate validation owner.`
  - `dispatch.tree`: `Build/test directory; needs write permission. Declared-task coordination only. For worktree, omit until initialized; then use actual absolute cwd from agent_list.`
- **目标英文定稿**：
  - `dispatch`:
    ```text
    Task scope and planned checks, not permissions or execution evidence. Use literal paths without padding, globs or shell expansion. Relative paths resolve from the Agent's execution cwd (including worktree); absolute paths keep their meaning. Assign full-suite validation to one designated Agent after shared source is stable.
    ```
  - `dispatch.tree`:
    ```text
    Build/test output directory; needs write permission and, if it exists, must be a directory. Overlapping declared resources conflict within this Owner; cross-Owner tree locks are advisory, not global exclusivity.
    ```
  - 动态注入给子模型的 `dispatchText`（`harness/src/core/dispatch.ts`）：
    ```text
    Parent dispatch (coordination scope and planned checks, not permissions or execution evidence):
    Execution cwd: ${JSON.stringify(executionCwd)}
    Relative inputs, ownership, and tree paths resolve from this execution cwd. Policy and settings inherit from source cwd (${JSON.stringify(sourceCwd)}); declarations grant no permissions.
    ${JSON.stringify(dispatch)}
    --- End of dispatch declarations ---
    ```

#### (6) `agent_wait.agents` 与 `agent_read.agent` 的选择器语法
- **Motivation**：现行 `"current, pending question, else latest"` 过度省略词性，模型不易看出这是“运行/排队中任务 → 否则未回答问题 → 否则最近结束任务”的固定回退优先级链。
- **现行原文**：
  - `agent_wait.agents`: `Tasks selected now: current, pending question, else latest; alerts span those Agents. Omit for unfinished tasks, answerable questions and all Agents' alerts.`
  - `agent_read.agent`: `Agent to read. Without task/cursor: current task, pending question, else latest.`
- **目标英文定稿**：
  - `agent_wait.agents`:
    ```text
    Bind each named Agent's active (running/queued) task, else its pending question, else its latest finished task, once at this call. Alerts span those Agents. Omit to wait on unfinished tasks, answerable questions and all Agents' alerts.
    ```
  - `agent_read.agent`:
    ```text
    Agent to read. Without task or cursor, selects its active task, else its pending question, else its latest finished task.
    ```

#### (7) `agent_send`、`agent_interrupt` 与 `agent_kill`
- **Motivation**：保持并強化“请求停止不等于已结算（settlement）”、“送达不等于已执行（delivery != action）”、“`exiting` / `cleanup_uncertain` 不等于资源已释放”的精确边界表述。

### 4.2 Prompt、错误恢复与绑定期失败诊断的一致性

- **移除过时恢复文案**：A 完成后，移除 `WORKTREE_TREE_RESOLUTION`（`"Start without tree; once initialized..."`）及相关 `DISPATCH_WORKTREE_UNINITIALIZED` 分支；历史记录保持字面原样。
- **绑定阶段（Post-acceptance / Pre-input）失败的可操作诊断**：
  - **Motivation**：在延迟绑定下，首次 `worktree` 任务的 `DISPATCH_INPUT_MISSING`、`DISPATCH_TREE_TYPE`、`PREFLIGHT_DENIED` 或真实路径 `RESOURCE_OWNED` / `BUILD_TREE_BUSY` 发生在任务已入队接受之后、进入子模型执行之前。父模型通过 `agent_wait` / `agent_read` 观察到的是该任务变为 `status: "failed"` 并携带 `error` 字段。
  - 因此，`error` 投影文本必须明确区分是**工作区中缺少已提交输入文件**（提醒模型：未提交的 source dirty/untracked 文件不会进入 worktree）、**权限拒绝**、**类型错误**还是**与其他 Agent 的真实路径冲突**，避免模型误以为是子模型执行崩溃而盲目重试。
- 检查 `QUEUE_FULL`、`RESIDENT_LIMIT`、`PENDING_QUESTION`、`DEPENDENCY_NOT_COMPLETED`、`STALE_ANSWER`、`INVALID_CURSOR`、Owner fault 和 `cleanup_uncertain` 等 resolution，确保下一步指引与改后的 API 行为完全对齐。
- 不向默认 system prompt 新增长篇编排教程，不重新加入通用 `recovery_hint` 或默认遥测。
- `resources/worker.md` standing prompt 只保留通用工作纪律；完整验证负责人的额外证据义务仍由明确任务分配携带。

## 5. C：人类文档分层与去重

### 5.1 一页快速使用

拟新增 `harness/docs/agent-tools-quickstart.md`，从根 README 和 tool contract 链接，包含：

| 目的 | 工具 |
| --- | --- |
| 新的独立工作 | agent_spawn |
| 继续同一条工作线 | agent_run |
| 修正尚未结束的任务 | agent_send |
| 回答明确待决问题 | agent_answer |
| 等事件或结束 | agent_wait |
| 取结果、历史任务或下一页 | agent_read |
| 请求停止当前任务、保留会话 | agent_interrupt |
| 永久结束 Agent | agent_kill |
| 只读查看 roster | agent_list |

给出完整流程，而非只列孤立调用：

1. 并行派单 → 长 wait → 收集结果与 remaining pages。
2. ask → settled needs_input → 精确 answer → 再提交依赖回答续跑的任务；不在同一并行 batch 假设调用顺序。
3. Agent 复用后 → 用旧 task 启动读取 → 用同一 Agent 的 next_cursor 翻页。
4. 单次 worktree spawn → 已分配修改/检查 → 读取实际路径与结果；集成与手动清理另行处理，不保证主仓库 dirty 内容被测试。

文档不伪造工具返回。示例只展示调用，question/cursor 占位 token 明确无效；doc-driven 受控协议测试以当次真实 fixture 返回替换它们，避免把固定示例名或可误用 token 塞进常驻描述。

### 5.2 权威来源划分

- `tool-contract.md`：模型工具输入、选择规则、返回和通信语义。
- `workspaces.md`：workspace 创建、相对路径、绑定、保留与恢复的完整规范。
- `task-dispatch.md`：声明、claims、依赖/answer lineage 与验证观察。
- `security.md`：权限继承、别名限制、研究员外传风险和残余安全边界。
- `limitations.md`：支持边界、SDK/取消/恢复/部署限制。
- `development.md`：实现归属、测试和 matched migration。

其他文档仅保留与自身主题相关的必要结论并链接，减少多处复制完整 workspace 规范。权限非 dispatch 授予、worktree 非 sandbox 等关键边界仍可在调用附近重复提醒。

字段/description 清单尽量从真实注册对象生成；调用流程用受控测试验证。审计快照与私有报告继续位于被忽略产物目录，不升级为构建输入或第一份教程。

## 6. D：Envelope 预算维护

Schema description/serialized declaration/token 预算与回复 envelope 独立。
本轮 caller-contract 将 schema 预算设为 whole declarations ≤16000 characters、
parameter descriptions ≤6500 characters、single tool description ≤340 characters，
作为可审查上界而非实测 token 数；统一验证后记录实际字符量/token（若有 tokenizer）。
回复 65536-byte cap 不变，不因 schema 增长而改变。

快照中的保守必需 fixture 为 65438 double-JSON UTF-8 bytes，距 65536 上限仅 98 bytes。这不是普通回复长度，也不是当前未重新运行后的测量结果；实施时必须重测。

- 列出必需控制行、action、question identity、定长 cursor、完整首 alert、pending count 等的预算贡献和组合前提。
- 保留全体绑定行、必需控制、分页可寻址性、FIFO 前缀、先构造最终回复再原子消费的保证。
- 增加 Unicode、双重 JSON 转义、最大行数、最大问题/alert、workspace_pending 和字段组合的生成式/边界测试，使用可复现 seed 与明确反例。
- 验证整体省略可选路径而不截成假路径，省略仍准确标记，未展示通知不丢失。
- 路径重构优先使用内部状态，不往必需 envelope 增加逻辑资源 ID 或新状态字段。
- 不以 98-byte 余量为由直接抬高上限、删除控制、增加详情模式或让接收者承担预算责任。任何必需字段变化都重新做预算审查。

## 7. E：验证与行为评测

### 7.1 A 的关键受控回归

- 首次 worktree spawn 携带相对 inputs/ownership/tree，成功绑定到实际 cwd；无 init/read/run 前置调用，无对 source 文件的误声明。
- shared 相对路径保持原义；绝对 source/外部引用保持绝对语义，并完整执行权限检查。
- source 为子目录、空格路径、`..`、symlink、缺失输入、既存非目录 tree、未创建输出、canonical ancestor 的行为均明确。
- source 有文件而 HEAD/worktree 无文件时，不能错误通过输入检查；dirty/untracked 和依赖不被复制。
- 两个独立 worktree 的同名相对输出不产生假的 source 冲突；指向同一真实绝对/别名资源时仍能发现冲突并阻止子输入。
- accepted replay 不新分配 worktree、不重复转换 claims、不重放已消费通知；不同参数仍遵守 REQUEST_CONFLICT。
- 排队后 HEAD 改变，仍按实际初始化时点选 baseline；依赖失败不应为了绑定而创建无用子会话。
- 绑定前/中/后取消、Owner loss、workspace setup 失败、SDK assembly 失败、部分产物、cleanup_uncertain 均不提前执行或伪造释放。
- pending question → answer → pre-input rollback → reopened question 保持同一 workspace、claims 和 tree lease；kill/关闭/隔离不恢复回答权。
- source deny 经 trusted workspace alias 仍有效；无 ALLOW 导入或 external 豁免；researcher ceiling 和不可变资源 floor 不变。
- 默认/历史 task/cursor 的 Run-local workspace 投影、保留路径真实性、通知原子消费和字节上限不退化。
- 新增/改变 core 公有入口必须更新 `harness/test/unit/owner-guard-coverage.test.mjs`，覆盖重入、吞掉错误和状态不变。

优先扩展现有 parent-dispatch、dispatch-wording、task-floor、workspace、agent-workspace、child-factory、orchestration、owner communication、SDK/packaging 及 `test/runtime/fixtures/worktree-spawn.mjs` 等受控测试，不用文字匹配替代真实路径/claim/输入边界断言。

### 7.2 API 误用场景

1. 无关工作误用 run；仅需结果却无限复用会话。
2. pending question 误用 send，或在尚未 settled 时 answer。
3. 返回不明确后重复 spawn，制造重复任务。
4. 把 after 误当动态 Agent 依赖，尤其误认为它跟随 answer。
5. 未回答问题导致默认 wait 循环，而非回答或显式等待其他 Agent。
6. 误以为 worktree 包含 dirty 文件、已安装依赖或能自动合并。
7. interrupt/kill 请求后过早宣布工作停止或资源释放。
8. Owner fault / cleanup_uncertain 时自动重试、换 difficulty 或再建 Agent。
9. 路径未知时猜 cwd，或给 source 和 worktree 声明错资源。

受控 scripted provider 可验证协议分支与示例，但不能证明真实模型会选对工具。

### 7.3 指标与证据

- 首次动作/参数正确率。
- 额外管理调用数、错误恢复调用数、重复接受任务数。
- 最终任务结果正确性与验证覆盖；completed 和 declared checks 不等于正确。
- 文案字符量/实测 token 与端到端耗时作为辅助指标，不能单独代表委派收益。
- 难度选择、必填 builds_on、同主题昵称、delegation 模式区分的收益先保留为待验证假设；不凭合成注册或主观感受宣称有效。

先建立受控基线。真实模型 A/B 需另行授权，固定模型/配置/任务与并行条件、使用隔离 fixture 和显式成本边界，记录失败样本而非只展示成功案例。现有 `session-analysis.md` 的离线计数可辅助分析，但不是质量判定器，不挖掘私有正文生成 deny 或模型能力评分，不把不完整 usage 当完整账单。

## 8. 实施顺序与停止条件

实施进度：A 的逻辑路径与绑定态 claims、authority-owned live alias seam、
绑定失败保留健康 session、B/C 文案及 quickstart 四条 doc-driven 协议流程、
D 的固定 seed envelope 组合回归已落地。Source-relative/两步 tree 的现行规则已替换；
历史原文仅在本计划保留。统一负责人已执行 build、聚焦回归与完整 portable gate；
注册对象 API 快照与预算已重新测量。精确命令、实际计数和日志保留在私有证据，
不将受控 provider/composition 测试称为真实模型或 installed-host 验收。

依赖准备的离线 `npm ci --ignore-scripts --offline` 复合命令在执行前被权限层拒绝，
未重试；后续构建使用现有开发依赖。生成资源 hash 采集也被拒绝，未绕过；
上游 LICENSE 仅确认存在及许可正文，未作字节身份比较。以上证据缺口保留，
不影响如实报告已执行的构建/测试，但不能据此宣称干净依赖重装或部署验收。
本次未新增公有 Owner 入口或 Run callback；既有 guard inventory 与动态回归仍通过。

### 阶段 0：设计收口

- [x] 重新核对当前未提交改动、实际注册对象与相关测试。
- [x] 确定逻辑/绑定资源类型、原子转换时点、真实路径冲突失败方式、policy binding seam 和取消/answer rollback 行为。
- [x] 为接单、绑定、执行、失败、pending question、cleanup 逐项列出不变量及测试。
- [x] 确认没有新增模型必需字段、路径宏或第二套权限系统。

### 阶段 1：核心与 runtime

- [x] 建立 A 的正反例并实现逻辑声明、运行时解析和 core claims 转换。
- [x] 保持 shared、after、回放、Off、answer lineage、执行预算起点与清理的既有语义。
- [x] 首任务 tree 拒绝及对应恢复文案与完整绑定链一并切换，已通过首次子输入前真实检查的受控回归。
- [x] 权限、claims 原子性、取消和清理边界经实现与独立静态审查核对，未以文案替代检查。

### 阶段 2：文案与文档

- [x] 同步 schema 描述、动态 dispatch/prompt、resolution 和权威契约；worker/profile 保持通用工作纪律。
- [x] 新增快速使用与受控可验证流程，整理重复 workspace 规范并修复交叉链接。
- [x] 重生成注册对象 API 快照并标明语义差异；未覆盖旧快照或修改旧历史含义。

### 阶段 3：统一验证

- [x] 冻结共享源码后，只由一个明确指定的验证负责人执行 build → focused regressions → full portable gate；其他工作仅跑分配的 focused checks。
- [ ] 从根按开发要求使用 `npm ci --ignore-scripts`、`npm run build`、`npm run check`；便携 policy 可通过 `npm run test:policy` 单独复核，不与完整门禁竞争同一树。
- [ ] Node/Pi/配置、源码版本与 dirty 状态、生成资源 digest、精确命令、退出码、实际测试数及 unrun/blocked/interrupted/zero-match 结果写入私有证据，不能引用旧测试数充当本次通过。
- [ ] controlled host collector 另行授权安排；本次未执行，不把 package 合成测试称为 host 或模型验收，真实模型/网络/人工批准流程亦未执行。
- [x] 重测 envelope 预算并确认构建产物保留上游 permission-system LICENSE；未安装或部署。

### 阶段 4：匹配迁移，另行执行

- [ ] package、生成 runtime、managed definitions 和 policy 作为 matched unit；仅通过 build 生成，不手改 runtime/vendor。
- [ ] 现有用户资源先盘点/备份，由操作者显式协调；absent-only init 不修复或覆盖现有文件，不复制凭据、不启用路由。
- [ ] 如需安装，仅验证 built tarball 后使用 `--omit=dev --legacy-peer-deps --ignore-scripts`，host Pi 独立提供；这不是本计划的默认执行步骤。
- [ ] 确认旧 Owner 关闭后启动匹配资源的新 Pi 进程；不热换运行中的 Owner。回退恢复完整 matched unit，不对历史声明重新解释或 hydration。

### 独立 review 后续收口

独立 D5 静态 review 未发现阻断项。其可落实建议已补齐：provisional deny
诊断明确 source 候选语义（不增加模型必需字段或改变 verdict）；answer 排队期间
input 缺失/权限变化导致 pump 失败的直接回滚测试；真实 composition 中两个
独立 worktree 经已提交 symlink 竞争同一 canonical tree 的拒绝与健康 session
复用测试；既有 4096 次 authority binding 容量的限制说明。防御性逻辑路径重叠
分支保留。后续完整门禁重新运行，精确命令和结果仍在私有证据中，不宣称真实
模型行为收益或自动部署验收。

## 9. 完成定义

本轮完成应同时满足：

1. 模型无需知道 worktree 的实际目录，就能一次提交包含相对 inputs/ownership/tree 的首任务。
2. 所有 dispatch 相对路径与实际工具执行使用同一 cwd；引用 source/外部目录必须明确，检查不被绕过。
3. 实际权限和真实资源冲突在子任务输入前完成；逻辑资源不冒充 filesystem/permission 事实。
4. 回放、依赖、问题/回答、取消、清理与保留语义经受控正反例覆盖；没有新 sandbox、强制停止或可靠送达承诺。
5. API 描述、动态提示、错误恢复、快速使用、契约与生成资源一致，不再残留“两步声明 tree”的现行指引。
6. envelope 预算有重新运行的证据，行为收益与协议正确性分开报告；未做的真实模型/host/人类验证明确标为未做。

**取舍原则：把必要复杂度收进可信 core/runtime，让模型面对一个自然、一致的路径规则；不把复杂度转移成更多 flags、工具或常驻说明。**
