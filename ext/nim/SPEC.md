# nim —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

## 一、为了什么

**nim 进来压的是 ADR-0033 那两栏最难填的格子：`effects` 与 `lifetime`。**
别的语言只能给出这两栏的一半证据，nim 是唯一一门**自己的编译器就把这两栏写在签名上**的语言。

1. **效应写在签名上，而且真的被检查。** Nim 的每个 proc 类型带一格
   `nkEffectList`，**六个槽**（`compiler/astdef.nim:175-181`）：
   `exceptionEffects`(0) / `requiresEffects`(1) / `ensuresEffects`(2) /
   `tagEffects`(3) / `pragmasEffects`(4) / `forbiddenEffects`(5)。
   ADR-0033 §8 说"借 Koka 那条'效应写在签名上且可被处理'，不借类型层的效应推断" ——
   **nim 就是那条路在一门产 C 的语言上的实例**：`raises: []` / `{.tags: [].}` /
   `{.noSideEffect.}` 全是声明 + 检查，不是推断出来的类型。
   我们的六格效应（`reads` `writes` `allocates` `may-early-exit` `suspends` `unordered`）
   与它的六个槽**不是一一对应**，但"几个槽 + 声明 + 检查"这个形状是同一个。
   **这一门是我们那六格效应唯一的外部对照。**
2. **生命期钩子有七格，而且挂在类型上。** `TTypeAttachedOp`
   （`compiler/astdef.nim:809-816`）：`attachedWasMoved` / `attachedDestructor` /
   `attachedAsgn` / `attachedDup` / `attachedSink` / `attachedTrace` /
   `attachedDeepCopy`。ADR-0033 §3.2 的 `lifetime` 栏（`owns` / `borrows` / `static`，
   入端口 `borrow` / `consume`）在 nim 这儿是**七个可写的钩子** ——
   也就是说"释放点算出来之后由谁填那个动作"这一问，nim 给了一份现成的答案表。
   `doc/destructors.md` 是它的规格。

第三格：**`sink` / `lent` / `var` 三种形参**恰好是 `borrow` / `consume` 那两格的语法形式；
第四格：**宏在 166 格节点的 AST 上重写**（`compiler/nodekinds.nim:13`）——
与 chez 的 `syntax-rules` 一起构成"用户可写的特性"的两个证据，且 nim 这份是**带类型的**。

## 二、需要什么内容

- **官方规格**：`Nim/doc/manual.md`（很长，但结构清楚）。与节点有关的章节：
  Types（含 `distinct` / `object variants` / `ref/ptr` 三种引用）、
  Procedures（含 UFCS、命令式调用、`var`/`sink`/`lent` 形参、`result`）、
  Statements and expressions（**`when` 是编译期分支**）、
  Iterators（inline vs closure —— 两种落法）、Exception handling、
  Templates / Macros、Compile-time execution（那台 VM）。
  另有三份专门的：**`doc/effects.txt`（效应）**、**`doc/destructors.md`（ARC/ORC 与七个钩子）**、
  `doc/astspec.txt`（AST 形状 —— 写宏的人看的那份，正是"语言的节点表"）。
- **参考实现里要读的三处**：
  - `compiler/nodekinds.nim` —— **166 格 `TNodeKind`**。它是"Nim 的语法有多少形状"的上界；
    注意它同时装了**未经语义处理**与**语义处理之后**两拨节点（`nkCall` 与 `nkHiddenCallConv`
    那种），所以塌成节点清单的比例会比 go 那份（151→25）更大。
  - `compiler/astdef.nim:175-181`（效应六槽）与 `:809-816`（七个生命期钩子）——
    这两段是这份规格的核心，见 §一。
  - `compiler/astdef.nim` 的 `TTypeKind`（**50 格**）—— 类型那一侧的形状。
- **我们自己量出来的**：`nim.grammar` 405 条产生式 / 551 处冲突，尾巴上那条十二刀的账。
  两条一般教训（不是 Nim 独有的）已经写在那儿：
  "too many concurrent parses 从来不是驱动器不够强，是语法里有真歧义"；
  "只差空白的两种写法要在词法层分开，且 `tight-after` 那格记号只在特定前一个记号后才发"。
- **语料与现状**：Nim 树里 `lib/` 下的 `.nim`。量出来 **166/316（53%）** ——
  十门里覆盖率倒数第二，原因清楚（缩进块 + 命令式调用 + `optInd`），
  失败已分三类（`nim.grammar` 尾巴）。**语法侧没做满，这份规格照写** ——
  规格问的是"这门语言要什么"，不是"我们收了多少"。

## 三、原子化特性表

### 3.1 效应（这一门的第一格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `raises` | `{.raises: [IOError].}` —— 声明能抛哪些；空表 = 不抛 | `may-early-exit` 效应的**声明形式** | astdef.nim:175 |
| `tags` | `{.tags: [ReadIOEffect].}` —— **用户自定义的效应名** | 我们没有的一格：**可扩展效应** | astdef.nim:178 |
| `noSideEffect` / `func` | 纯函数；编译器检查 | `pure`（= 六格全空） | manual Procedures |
| `requires` / `ensures` | 前后条件（drnim 那条线） | 不进图：是检查，不产生代码 | astdef.nim:176-177 |
| `forbids` | 禁止某格效应出现 | 契约的**否定形式** | astdef.nim:180 |
| `gcsafe` / `threadvar` | 线程相关的效应 | `task-queue` 的附属 | manual |
| `discardable` / `discard` | "这格值可以不要" —— 不写 `discard` 是**编译错误** | 出端口的一格附属 | manual |

**`tags` 是这份规格发现的一个真缺口。** 我们的效应栏是**固定六格**
（ADR-0033 §3.2），nim 允许用户定义效应名并沿调用图传播。
两种设计的差别不是表达力，是**谁来检查**：固定六格 ⇒ 调度器能用它们算次序；
可扩展效应 ⇒ 只能做"传播 + 比对声明"。
**结论（现在就写下，免得以后当新发现）**：调度器要用的那六格不动；
用户效应名如果要收，收成"挂在节点上的一格附属标记 + 一次沿 `value`/`effect` 边的传播查询"，
**不进五栏**。理由：五栏是调度器的输入，输入的格数必须是闭的。

### 3.2 生命期与所有权（第二格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `=destroy` | 释放动作 | `scope-exit` 的**提供者** | attachedDestructor |
| `=copy` / `=dup` | 复制 / 复制成新值 | `lifetime` 栏的 `owns` 那一格的动作 | attachedAsgn / attachedDup |
| `=sink` / `=wasMoved` | 移动 + 把源标成"已搬走" | 入端口 `consume` 的动作 | attachedSink / attachedWasMoved |
| `=trace` | 给 ORC 的环检测用 | `gc-lifetime` 能力 | attachedTrace |
| `=deepCopy` | 跨线程的深拷贝 | `task-queue` 的附属 | attachedDeepCopy |
| `sink T` 形参 | 夺 | 入端口 `consume` | manual |
| `lent T` / `var T` 形参 | 借（只读 / 可写） | 入端口 `borrow` | manual |
| `ref` / `ptr` / `addr` | 三种引用：GC 的 / 裸的 / 取址 | `gc-lifetime` / `ptr` | manual Types |

**这一栏是十门里唯一一门把"释放点算出来之后填什么动作"写成表的。**
ADR-0033 §3.5 第 4 条说"释放**动作**由 `scope-exit` 能力的提供者填" ——
nim 的七个钩子就是那句话的完整清单。**做 `scope-exit` 那台机器时照它对账**：
我们要么能对上这七格，要么能说清为什么少一格。

### 3.3 语法与形状（骨架，从 166 格 `TNodeKind` 归并）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `proc` / `func` / `method` / `converter` / `iterator` | **五种例程**，形状同一个（名字 + 泛型参数 + 形参组 + 返回 + pragma + 体） | `callable`（+ `dispatch` 给 `method`） | nim.grammar 的 `routine` 那一族 |
| `call`（三种写法） | `f(x)` / `x.f()`（UFCS） / `f x`（命令式） —— **同一个节点** | `indirect-call` | nim.grammar；值了那边 79/141 两刀 |
| `object` | 字段 + **变体（`case` 字段）** + 继承 + `of` 测试 | `record` + `layout` + `tagged-union` | manual Types |
| `tuple` | 结构式元组，可具名；**解包赋值** | `record` + `multi-value` | nim.grammar |
| `enum` | 可带值、可带字符串 | `enum` | manual |
| `distinct` | **从已有类型造一格不兼容的新类型**（零开销） | `named-type` | manual |
| `if` / `case` / `when` | 前两个运行期，**`when` 是编译期分支** | `branch` / `stage` | nim.grammar |
| `while` / `for` | `for` 走**迭代器**（不是语言内建的容器协议） | `loop-region` + `indirect-call` | manual Iterators |
| `try` / `except` / `finally` / `raise` | 异常 | `may-early-exit` + `scope-exit` | manual |
| `defer` | 语句级延后 | `scope-exit` | manual |
| `block` / `break label` | 具名块 + 带标签跳出 | `region` + `may-early-exit` | manual |
| `template` | 卫生宏（AST 替换，**编译期**） | `stage`（= 消去规则引擎自己） | manual Templates |
| `macro` | 在 166 格 AST 上写 Nim 代码重写 AST | `stage` + `meta-ast` | manual Macros |
| `generic` / `static[T]` / `concept` | 泛型 + **编译期值参数** + 结构约束 | `monomorphize` | nim.grammar（三种已收） |
| `pragma` | `{.inline.}` / `{.cast(noSideEffect).}` / … 挂在任何位置 | **附属节点的总入口** | nim.grammar；值了 166 那一刀 |
| `iterator`（inline / closure） | 两种落法：内联展开 / 一格续延 | `suspends`（closure 那种） | manual Iterators |
| `async` / `await` | **不是语言特性**：是标准库的宏（`std/asyncdispatch`） | `suspends` + `task-queue` | manual Macros |

三条要记下的：

1. **`async` 在 nim 里是库，不是语言。** 一格宏把 `await` 重写成续延。
   这是"宏 = 用户可写的特性"最有说服力的一个例子（ADR-0033 §7 那句话的实例），
   也说明**我们的 `suspends` 那格效应必须能被一条消去规则用上** ——
   否则我们永远只能内建 async，不能让它是库。
2. **`pragma` 是附属节点的总入口。** Nim 把"挂在任何位置的注解"做成一格统一语法。
   十门语言里的 `attr` / `tag` / `annotation` / `declspec` 全是这一格 ——
   `node-graph-contract.md` §2 那条"附属节点"的语法证据。
   而语法侧那一刀（`nim.grammar` 的 166 那记）证明了它的代价：**pragma 能出现在
   任何位置，于是每处都要收一条**。
3. **五种例程一个形状。** `proc` / `func` / `method` / `converter` / `iterator`
   差的只有效应声明与派发方式 —— 又一份"一个特性 ≠ 一个节点"的数据
   （对照 go 那份 151→25）。

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  proc/func/method/converter/iterator → callable（method 另要 dispatch）
  call（三种写法）        → indirect-call
  object / tuple         → record, layout（变体另要 tagged-union）
  distinct               → named-type
  enum                   → enum
  if / case              → branch
  when                   → stage（编译期）
  while / for            → loop-region（for 另要 indirect-call）
  try/except/raise       → （may-early-exit 效应）+ scope-exit
  defer / =destroy       → scope-exit
  block / break label    → region, （may-early-exit 效应）
  ref                    → gc-lifetime
  ptr / addr             → ptr
  template / macro       → stage（+ meta-ast 给 macro）
  generic / static / concept → monomorphize
  closure iterator / await → suspends, task-queue

attached-to（真依赖）
  pragma（全部）           → 它所在的那一格声明 / 语句 / 类型
  raises / tags / forbids / noSideEffect → 一格 callable 的效应签名
  requires / ensures      → 一格 callable（只检查，不产生代码）
  sink / lent / var 形参   → callable 的一格形参（= lifetime 栏）
  七个 =hook              → 一格类型（= scope-exit 的动作表）
  discardable / discard   → 一格出端口
  object 的 case 字段      → object（tagged-union 的形状）
```

**这一节要证明的三句话：**

1. **删掉异常，`scope-exit` 不崩。** nim 的 `=destroy` 与 `defer` 不需要 `try`；
   反过来 `try/finally` 用的是同一台 `scope-exit`。两家共用一格能力、互不依赖
   —— 与 sbcl 那份的第 3 条（`catch` 与 `unwind-protect` 互不依赖）是同一个结论，
   **两门语言独立成立**。
2. **删掉 `ref`（GC），`object` 还在。** Nim 有 `object`（值）与 `ref object`（GC 引用）
   两条腿，删掉后者只是少一种存储。—— "删一格存储不影响结构"的又一实例。
3. **`pragma` 全是附属，删光它们语言还完整。** `{.inline.}` / `{.raises.}` /
   `{.noSideEffect.}` 一个都不影响图连不连；而删掉宿主声明，pragma 无处可挂。
   **166 格节点里有一大批是这种挂件** —— 这是"骨架 vs 附属"在最大的一份节点表上的验证。

## 五、优先级和顺序

1. **效应六格的边界**（§3.1 的结论）—— 排第一，因为它决定五栏的输入是不是闭的。
   产出是一句话写进契约：**调度器用的效应格数固定，用户效应名只能是附属 + 传播查询。**
   nim 是唯一能验这一条的语料。
2. **`scope-exit` 的动作表**（§3.2 的七个钩子）—— 与 sbcl 的 `cleanup` 七种 kind、
   go 的 `defer`、lua 的 `<close>` 四门对账。
   **注意这两个"七"不是同一个七**：sbcl 那七是"哪些语法要清理"，nim 那七是"清理时做什么"。
   四门语言合起来才把这台机器的两侧都定住。
3. **`lifetime` 栏的 `borrow` / `consume`**（`var` / `lent` / `sink` 三种形参）——
   与 mojo 的所有权那一族同一格，两门一起做。nim 这边有现成的语法。
4. **`stage`（编译期求值）** —— `when` / `template` / `macro` / `static[T]`。
   与 chez 的 `syntax-rules`、sbcl 的 `eval-when` 三门对账。
   nim 这份的特殊价值：**它是带类型的**，而且 `async` 是库（§3.3 第 1 条）——
   所以这一格做成了，`suspends` 就能被用户的规则用上。
5. **`tagged-union`（object 变体）** —— 与 vlang 的 sumtype、cpp 的 union 三家。
6. **`dispatch`（`method`）** —— nim 的 `method` 是**多分派**（按运行期类型挑），
   与 sbcl 的 CLOS 同一档。排在 go/mojo 的单分派之后，当上限压测。
7. **闭包迭代器 + `await`** —— 与 go 的 channel、lua 的协程共用续延机器。

## 六、明说的不足（不猜）

1. **语法侧还欠 150 份，已分三类**（`nim.grammar` 尾巴）：28 份是 `optInd` 的剩余形状
   （返回类型或实参写在下一行）—— **那一族要么一处处枚举，要么等驱动器里那格列号谓词，
   是真正的机制欠账**；11 份是命令式调用嵌在运算符里（受限链挡过了头）；
   剩下是零散形状（`{: }`、`parseEnum[:T]`、`object` 里的 `when`、`concept`）。
2. **551 处冲突**，主因已量出来：`operand` / `h-operand` 那一族受限链的重复
   （与 vlang 的 685 处同一个形状）。这是语法侧的账，不是规格的账。
3. **`concept` 没读**（结构式约束，还是实验特性）。它可能是 `monomorphize` 之外的
   一格独立能力（"按结构判定"），也可能与 go 的 interface 同一格。不猜。
4. **ORC 的环检测（`=trace`）与我们"释放点靠图上最后一次使用算"的关系没想清**。
   与 lua 的 `__gc`/弱表那笔账（`ext/lua/SPEC.md` §六第 3 条）是同一个问题：
   **`gc-lifetime` 与图算出来的释放点冲突**。两门语言都指到这儿，说明它是真问题，
   要单独一节（可能是一份新 ADR），现在只记账。
5. **`requires` / `ensures`（drnim）不进图**，写在这儿免得以后有人想给它开节点：
   它们是检查，不产生代码 —— 与 mojo 的所有权检查、vlang 的 immutable-by-default
   同一类（ADR-0033 §7 已列"不产生代码的特性"）。
6. **UFCS 与重载择优的交互没读**。`x.f()` 要先查 `f(x)` 的重载集，
   而重载择优是 ADR-0033 §10 保留的**求解器**之一。这一格是"规则里以副作用自由的查询
   调用求解器"的实例，做的时候要写清它用了哪个求解器。
