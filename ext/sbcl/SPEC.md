# sbcl —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。
读之前先读 `ext/chez/SPEC.md`：这两门共用"语法只到 datum"那一半，本份只写不同的地方。

## 一、为了什么

**sbcl 进来压的是两件 chez 压不出来的事。**

1. **`lvar`：边是一等的。** SBCL 的 IR1 里，节点之间那条"值从哪儿流到哪儿"不是指针，
   是一格具名结构 `lvar`（`src/compiler/node.lisp:208`），而且它上面能挂一族
   **注解**（`lvar-annotation` 及其 8 个子类，:238-289）。
   ——这是 ADR-0033 §3.3「`value` 边」与 `node-graph-contract.md` §2「附属节点」
   在一个**独立实现**里的存在证明：别人也把"边"与"挂在边上的东西"分开了，而且分得比我们早。
2. **非局部出口有七种写法、一台机器。** `cleanup` 那格结构的 `kind` 只有七个取值：
   `:special-bind :catch :unwind-protect :block :tagbody :dynamic-extent :restore-nsp`
   （`src/compiler/node.lisp:688-691`）。CL 里 `block`/`return-from`、`tagbody`/`go`、
   `catch`/`throw`、`unwind-protect`、`let` 的特殊变量绑定、`dynamic-extent` 声明 ——
   **六族语法，一格 cleanup 机制**。ADR-0033 §5 那条"至少两个提供者才配叫能力"
   在这一门上是 6 个提供者，G5 的门槛（≥4）一门语言就够了。

第三格附带的收益：CL 的读取器比 Scheme 花，且**读时条件 `#+/#-` 会吃两条 datum**
（`ext/sbcl/sbcl.grammar:100-101`）—— 这是"语法只该说这儿有两条 datum，哪个特性成立是宿主的事"
那条纪律的来源。

## 二、需要什么内容

- **官方规格**：CLHS（ANSI CL）。与节点有关的只有一章：**3.1.2.1.2.1 特殊算子**，
  **一共 25 个** —— 这就是 CL 那张"一张表就能放心"的表。
  另外 §3.1.1（求值模型）、§5.3（`declare` 那一族）、§9（条件系统）。
- **参考实现里真正要读的三处**（不是全树，SBCL 树很大）：
  - `src/compiler/node.lisp` —— IR1 的全部节点与边。三段：
    `lvar` 与注解（:208-289）、`cleanup` / `physenv` 那一族（:684 起）、
    节点定义（:1494-1800）。
  - `src/compiler/ir1-translators.lisp` —— **44 个 `def-ir1-translator`**（量的是这一份文件）。
    CLHS 那 25 个特殊算子大半在这儿，剩下的散在别处（`progv` 在 `ir2tran.lisp:1982`、
    `load-time-value` 在 `ltv.lisp:16`），另外这 44 个里有一批是 SBCL 自己的内部形式
    （`%funcall` / `%primitive` / `with-source-form` / `jump-table` …）。
    这份表的用处是"CL 那 25 个算子各落到哪个 IR1 节点上"，不是数目对账。
  - `src/compiler/ir1tran.lisp` —— 宏展开与 `ir1-convert` 的主循环（宏那一格要用）。
- **语料与现状**：`ext/sbcl/bench.json` = SBCL 树里的 `.lisp`（src / contrib / tests 全算）。
  量出来 **1415/1433（99%）**。剩下的 18 份是语法侧的明账（见 §六）。

## 三、原子化特性表

### 3.1 读取器那一层（已实现，语法侧）

与 chez 重叠的不重复（`datum` / `abbrev` / `datum-label` / `numeric-tower`）。CL 独有的：

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `reader-cond` | `#+特性 形式` / `#-特性 形式` —— **吃两条 datum**，读取器那一层就决定收不收 | `read-time-cond` | sbcl.grammar:60,101 |
| `read-eval` | `#.形式` —— 读的时候就求值 | `read-time-eval` | sbcl.grammar:69,102 |
| `uninterned` | `#:foo` —— 不进包的符号 | `symbol-identity` | sbcl.grammar:105 |
| `struct-datum` | `#S(名字 槽 值 …)` 结构字面量 | `record` | sbcl.grammar:114-115 |
| `array-datum` | `#2A(…)` 多维数组、`#*1011` 位向量 | `array` | sbcl.grammar:53,55,113 |
| `complex-datum` | `#C(1 2)` 复数 | `number-tower` | sbcl.grammar:116-117 |
| `pathname` | `#P"…"` 路径名是**一格类型**，不是串 | `host-path` | sbcl.grammar:54 |
| `backquote` | `` ` `` `,` `,@` `,.` 四格（比 Scheme 多一个 `,.`） | `sexpr-read` | sbcl.grammar:121-124 |

`read-time-cond` / `read-time-eval` / `host-path` 三格能力**只有 CL 一家提供**。按
ADR-0033 §5 的纪律，它们暂时不算能力，是这门语言的内部事 —— 除非 freebasic 的
`#if` 那族预处理（已在 `ext/freebasic/freebasic.grammar` 里做成 `pp-head`）能与
`read-time-cond` 对上。**这是十份规格取并集时要专门看的一格。**

### 3.2 特殊算子（CLHS 那 25 个）→ 落到哪台机器

不给这 25 个各开一格节点。按它们**落到哪格能力**归并（出处 = `ir1-translators.lisp` 行号）：

| 归并到 | CL 的写法 | 能力 |
| --- | --- | --- |
| 常量 | `quote`、`load-time-value` | `const` |
| 取名 / 写名 | `setq`、`symbol-macrolet` | `bind` |
| 绑定 + 域 | `let`(:856)、`let*`(:891)、`flet`(:999)、`labels`(:1032)、`locally`(:919)、`macrolet`(:429) | `bind` + `region` |
| 函数 | `function`(:710)、`lambda` | `callable` |
| 调用 | `multiple-value-call`(:1561)、`%funcall`(:769) | `indirect-call` |
| 分支 | `if`(:24) | `branch` |
| 次序 | `progn`(:17)、`multiple-value-prog1`(:1606) | —（`effect` 边，不是节点） |
| **非局部出口** | `block`(:167)/`return-from`(:192)、`tagbody`(:251)/`go`(:299)、`catch`(:1410)/`throw`(:1351)、`unwind-protect`(:1450) | `may-early-exit` 效应 + `scope-exit` |
| 动态绑定 | `progv`、`let` 里的 special 变量 | `dynamic-bind`（= `region` 的一种提供者） |
| 类型断言 | `the`(:1112)、`truly-the`(:1135) | `cast`（附属，见 §3.3） |
| 编译期 | `eval-when`(:333)、`macrolet` | `stage`（编译期求值 = 消去规则引擎自己） |
| 多值 | `multiple-value-call`、`values` | `multi-value`（= `callable` 的一格附属） |

**这张表最要紧的一行是"非局部出口"**：CL 用四族语法说同一件事，SBCL 用**两个节点**
（`entry`:1738 / `exit`:1754）+ **一格 `cleanup`** 收下全部四族。
我们的对应物是 `may-early-exit` 效应 + ADR-0033 §3.5 第 3 条的切段 —— **零个新节点**。

### 3.3 IR1 的节点表（14 格，别人量好的）

`src/compiler/node.lisp` 里 `(:include node)` 那一族，全部：

| 节点 | 一句话 | 我们的对应 | 出处 |
| --- | --- | --- | --- |
| `ref` | 取一格 leaf（变量 / 常量 / 函数）的值 | `ref` | :1494 |
| `cset` | 写一格变量 | `set` + `writes` | :1556 |
| `cif` | 两支 | `branch` | :1523 |
| `combination` | 调用 | `call` | :1620 |
| `mv-combination` | 多值调用 | `call` + `multi-value` 附属 | :1639 |
| `bind` | 一格 lambda 的形参进场 | `region` 的入口 | :1648 |
| `creturn` | 一格 lambda 的返回 | `region` 的出口 | :1661 |
| `cast` | **类型断言，不产生代码** | **附属节点**（挂在一条 `value` 边上） | :1683 |
| `entry` / `exit` | 非局部出口的两端 | `may-early-exit` 切段 | :1738,:1754 |
| `enclose` | 闭包**在这儿分配** | `allocates` 效应 + `lifetime: owns` | :1772 |
| `cdynamic-extent` | "这几格的寿命只到这个域" | `region` + `lifetime` | :1790 |
| `jump-table` / `vop-jumper` | 跳转表（后端优化用） | 不对应 —— 它们是后端的事，不进图 | :1541,:1551 |

三条要记下的账：

1. **`cast` 是附属节点的又一个实例**：它挂在一条边上，删掉它图照样连着
   （SBCL 自己也说它多数时候不产生代码）。`the` / `truly-the` / `declare type`
   全落在它上面。——十门语言里的类型标注（go 的 `x.(T)` 断言除外）大半是这一格。
2. **`enclose` 把"闭包分配"显式成一个节点**。我们的做法不同：`allocates` 是效应栏的一格
   （ADR-0033 §3.2），不是节点。**这一格要在实现时对账** —— 谁的粒度对，拿"闭包能不能
   提出循环"这道题量。
3. **`jump-table` / `vop-jumper` 不进图**。这是"哪些东西属于后端"的一条现成界线：
   后端可以有自己的节点，那是它答卷的事（`node-graph-contract.md` §6 `backend.lower`），
   不许倒灌进契约。

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  ref / cset            → bind
  let / let* / flet / labels / bind / creturn → bind, region
  cif                   → branch
  function / lambda     → callable
  combination           → indirect-call
  mv-combination        → indirect-call, multi-value
  enclose               → callable, region（+ allocates 效应）
  cdynamic-extent       → region
  entry / exit          → （may-early-exit 效应 + scope-exit 能力）
  progv / special bind  → dynamic-bind
  struct-datum          → record, layout
  array-datum           → array
  complex-datum         → number-tower

attached-to（真依赖）
  cast                        → 一条 value 边（the / truly-the / declare type）
  lvar-annotation 那 8 个子类  → 一条 value 边（node.lisp:238-289）
  cleanup                     → 一格 region（七种 kind，node.lisp:688-691）
  preinfo 的对应物（source-form / source-path） → call / lambda
```

**这一节要证明的三句话（sbcl 上全部成立）：**

1. **删光所有类型，`record` 还在。** CL 的类型系统是**运行期的谓词 + 编译期的断言**
   （`cast` 那一格），`defstruct` 不需要类型层就成立。与 chez 同一个结论，
   但 sbcl 更强一点：它**有**类型声明，而那些声明是**附属**的（`cast` 挂在边上，
   删掉只是少一次检查）。——"删掉一个类型 class 不崩"在这门语言上是**可跑的实验**。
2. **没有 `stmt` 这个 sort。** CL 里 `progn` 是表达式，`tagbody` 也是表达式（返回 `nil`）。
   `stmt` 从来不是通用概念，它是 C 那一系的形状。
3. **`cleanup` 的七种 kind 之间没有依赖，只有共用。** 删掉 `catch`/`throw`，
   `unwind-protect` 一个字不用改 —— 这正是 I3 的形状，而且是别人的代码库里现成的证据。

## 五、优先级和顺序

1. **`scope-exit` + `may-early-exit`** —— 排第一，与 chez 的顺序不同：
   sbcl 是十门语料里**唯一一门把七种 cleanup 摆在同一格**的语言，
   拿它当第一台公共机器的验收场最便宜（go 的 `defer`、cpp 的 RAII、mojo 的 drop
   要等它们各自的规格）。
2. **`bind` + `region`**（`let` / `let*` / `flet` / `labels` / `bind` / `creturn`）——
   与 chez 第 1 项同一格能力，两门语言对账。
3. **`cast` 那一格附属节点** —— 它是"附属节点挂在**边**上而不是节点上"的第一个实例，
   要在这儿把端口/边的挂点定下来。
4. **`multi-value`** —— CL 的 `values` / `multiple-value-call` 是这一格最狠的语料
   （go 的多返回值、lua 的多值都比它弱）。定在这儿，后面两门就是特例。
5. **`dynamic-bind`** —— 特殊变量。它与 `region` 的关系要单独想：动态作用域是
   **一条按时间的边**，不是按嵌套的。ADR-0033 §3.3 的四种边里它落在 `bind` + `region`
   的组合上，**这一条要在实现里验，别先下结论**。
6. **条件系统（`signal` / `handler-bind` / `restart`）** —— 排最后。它比异常强
   （处理器在**发信号的栈上**跑，还能重启），是 `may-early-exit` 那台机器的**上限压测**。
   现在只记账。
7. **宏 + `eval-when`** —— 与 chez 第 7 项同一格；两门语言的宏系统一起看，
   才知道"用户可写的特性"这条要做到哪一步。

## 六、明说的不足（不猜）

1. **语法侧三笔已记在 `sbcl.grammar:20-24`**：块注释按字符计数（竖线符号里的 `#|`
   也会被算上）、包标记 `pkg:sym` 不切开、`#nA` 的维数与 `#*` 的位数不校验。
2. **1433 份里差 18 份**，是语法侧唯一的明账。没有逐份分类 —— 按项目的规矩，
   没分类就不许说原因。要动这 18 份之前先跑一次失败分类。
3. **`values` 的元数没进语法**：多值在语法层看不出来（它是 `call` 的性质），
   所以 §3.2 那行"多值"的能力名 `multi-value` 现在只是一个占位，
   等 go 与 lua 的规格写完再定它是能力还是附属。
4. **`enclose` 与 `allocates` 的粒度之争没结论**（§3.3 第 2 条）。这是这份规格留下的
   **最有价值的一个未决问题**：它决定"闭包分配"是节点还是效应。
5. **CLOS 完全没读**（`src/pcl/`）。泛函数与多重派发会落到 `dispatch` 能力，
   而且它是**多参派发**——比 go 的 interface、mojo 的 trait 都强一档。
   这一格要等 `dispatch` 有了两个简单提供者之后再回来，不能先按 CLOS 设计。
6. **条件系统只记了名字**（§5 第 6 项），没读 `src/code/cold-error.lisp` 那一族。
