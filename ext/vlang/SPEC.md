# vlang —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

**这门语言没有明文规格**（只有 `doc/docs.md` 这份手册与 `vlib/v/ast/ast.v` 这份实现）。
所以下面每一条都标出处，凡是"量出来的"都写明 —— 按 `docs/EXTENSIONS.md` §八那条纪律。

## 一、为了什么

**vlang 进来压的是"早退"那一族：一门语言把 option / result 做成语法的第一等公民时，
`may-early-exit` 那格效应要长成什么样。**

Go 用 `if err != nil` 手写，cpp 用异常，chez 用 `call/cc`，而 V 有四种写法落在同一件事上：

```v
f() or { … }          // OrExpr —— 出错时跑这一块
f()!                  // 传播（PostfixExpr 的 `!`）
f()?                  // 传播（把错误变成 none）
if x := f() { … }     // IfGuardExpr —— 拆包 + 分支
```

**四种语法，一格 `may-early-exit` 效应 + 一格"错误出端口"。** ADR-0033 §3.2 说
"多出端口是常态：值、错误、续延各一格" —— V 是这句话唯一的**语法级**证据：
它的类型 `?T` / `!T` 就是"两格出端口"写在类型上。

第二格独有的东西：**`lock x { … }` 是一格带互斥的 region**（`ast.v` 的 `LockExpr`）。
`node-graph-contract.md` §7 第 3 层写着"channel / mutex —— 续延之间的交接"，
V 是唯一一门把 mutex 做成**语法 region** 的语言 —— 于是"锁的获取与释放"是
`region` + `scope-exit`，不是两个手写的调用。

第三格：**不可变是默认的**（要写 `mut` 才可变）。这是一格"不产生代码的检查特性"
（ADR-0033 §7 已列），而且它给 `lifetime` 栏的 `borrow` 那一格提供了**最便宜的语料**。

## 二、需要什么内容

- **文档（不是规格）**：`vlang/doc/docs.md`（手册全篇）、`doc/ownership.md`
  （**实验中的所有权检查，`-ownership` 开关，目前只管字符串**）、
  `doc/c_and_v_type_interoperability.md`（C 互操作 —— `ptr` 那一格要它）。
- **参考实现里要读的两处**：
  - `vlib/v/ast/ast.v:29-83` —— `Expr` 与 `Stmt` 两个和类型，**约 55 + 28 = 83 格**。
    这是"V 的语法有多少形状"的上界。
  - `vlib/v/checker/` —— option/result 的传播规则、`mut` 的检查在这儿（语义，不在语法里）。
- **我们自己量出来的**（这一门尤其重要，因为没有规格）：`vlang.grammar`
  453 条产生式 / 679 处冲突，尾巴上那条曲线。里面有两条**只能量出来**的结论：
  - **`ret` 里那三条与 `type` 重复的产生式一共 171 处冲突**（850 的两成），删掉之后
    850 → 679，语义一点没少。这是"按冲突参与度排名"那把尺子的第一次成功。
  - **CDIRECTIVE 的 `not-after` 名单里不能有 `}`**（`}` 换行接着写 `#flag` 是常见排版）——
    净 −1，量过，退回来了。
- **语料与现状**：V 树里的 `.v`。量出来 **4015/6183（65%）**。
  最大的一类欠账已经定位：**约 290 份是串插值里又有引号**
  （`'${os.join_path(out, 'index.html')}'`）——那要一格能递归回表达式的词法器，
  不是加产生式能解决的。

## 三、原子化特性表

### 3.1 早退那一族（这一门的第一格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `option` (`?T`) | 可能没有值；`none` 是它的空 | `may-early-exit` + **错误出端口** | 手册 Option/Result；`ast.v` 的 `None` |
| `result` (`!T`) | 可能出错；错误带信息 | 同上 | 手册 |
| `or-block` | `f() or { … }` —— 出错时跑这一块，且这一块必须**收尾**（返回或 panic） | 错误出端口的一格消费者 | `ast.v` 的 `OrExpr` |
| `propagate` (`!` / `?`) | `f()!` —— 出错就返回给调用者 | **切段**（ADR-0033 §3.5 第 3 条） | `ast.v` 的 `PostfixExpr` |
| `if-guard` | `if x := f() { … }` —— 拆包 + 分支 | 错误出端口 + `branch` | `ast.v` 的 `IfGuardExpr` |
| `no-null` | 没有 null；`nil` 只在 `unsafe` 里 | 反面能力：**`zero-init` 不含"空指针"** | 手册 |
| `panic` / `assert` | 不可恢复 / 检查 | `may-early-exit` | `ast.v` 的 `AssertStmt` |

**这一栏给节点清单的结论：错误出端口不是"某个节点的特殊情况"，是一格通用的出端口。**
go 那份规格里 `x, ok = m[k]` / `v, ok = <-c` / `x, ok = i.(T)` 三种"值 + 有没有"
是同一形状（`ext/go/SPEC.md` §五第 1 项）—— **V 把那个形状升成了类型**。
两门语言合起来把"多出端口 + 切段"这台机器的两侧都给了：go 给了用法，V 给了声明。

### 3.2 并发与共享（第二格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `spawn` / `go` | 起一格线程 / 协程（`spawn` 是真线程，`go` 是协程） | `task-queue` | `ast.v` 的 `SpawnExpr` / `GoExpr` |
| `thread T` 句柄 | `spawn f()` 交出一格 `thread T`，可 `.wait()` | `task-queue`（`join` 那一格） | vlang.grammar（`[]thread int` 已收） |
| `chan` / `<-` | 通道，收发两半 | `channel` + `suspends` | vlang.grammar（发送那一半值 106 份） |
| `select` | 多路等待 | **不给节点**（n 路挂起点 + 一格分支，与 go 同结论） | `ast.v` 的 `SelectExpr` |
| `lock` / `rlock` | **`lock x { … }` 是一格带互斥的 region** | `region` + `scope-exit` + `mutex` | `ast.v` 的 `LockExpr` |
| `shared` | 一格"要加锁才能碰"的类型修饰 | `mutex` 的类型侧 | 手册 |
| `atomic` | 原子字段 | 方言要一格保证 | 手册 |

**`lock` 是这份规格对 `node-graph-contract.md` §7 的一处补充**：
第 3 层原来只写了 channel，现在明确 **mutex 落成 `region` + `scope-exit`，零新节点** ——
"取锁 / 放锁"就是那台已经有四个提供者的 `scope-exit` 机器的第五个用法。

### 3.3 数据与形状（骨架，从 83 格 AST 归并）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `struct` | 字段 + 默认值 + **嵌入** + `implements` | `record` + `layout` | `StructDecl` / `StructInit` |
| `sumtype` | `type Foo = A \| B` | `tagged-union` | `TypeDecl` |
| `interface` | 方法集（结构式，与 go 同） | `dispatch` | `InterfaceDecl` |
| `enum` | 可带值、可 `.flag` | `enum` | `EnumDecl` |
| `array` / `map` | **语言内建**（不是库）：`[]T` / `map[K]V`，带字面量 | `array` / `dict` | `ArrayInit` / `MapInit` |
| `string-interp` | `'x = ${a.b()}'` —— **插值里能放任意表达式** | `bytes` + 一格拼接 | `StringInterLiteral`；词法层的 `interp-string` |
| `match` | 模式匹配（值 / 类型 / 范围），**是表达式** | `branch` + `tagged-union` | `MatchExpr` |
| `if` / `for`（三种） | `if` 是表达式；`for` 有 C 式 / `in` 式 / 无条件三种 | `branch` / `loop-region` | `IfExpr` / `ForCStmt` / `ForInStmt` / `ForStmt` |
| `fn` / `AnonFn` / `LambdaExpr` | 具名 / 匿名 / `\|x\| x+1` 三种写法，一个节点 | `callable` | `FnDecl` / `AnonFn` / `LambdaExpr` |
| `method` | `fn (r Recv) m()` —— 接收者写在前面 | `callable` + `dispatch` | `FnDecl` |
| `defer` | 延到函数返回 | `scope-exit` | `DeferStmt` |
| `generic` | `fn f[T](x T)` | `monomorphize` | 手册 |
| `mut` / 不可变默认 | 变量、形参、接收者三处都要显式 `mut` | **不产生代码的检查** | 手册 |
| `unsafe` | 一格块，里面才许裸指针 | `ptr` | `UnsafeExpr` |
| C 互操作 | `#flag` / `#include` / `C.fn()` / `C.struct` | `foreign-call` | `HashStmt`；vlang.grammar 的 CDIRECTIVE |
| comptime | `$if` / `$for` / `$(field.name)` / `ComptimeCall` | `stage` | `ComptimeFor` / `ComptimeCall` / `ComptimeSelector` |
| `asm` | 内联汇编 | 后端的事，不进图 | `AsmStmt` |
| `sql` | **语言里嵌的 DSL**：`sql db { select from User }` | 见下 | `SqlStmt` / `SqlExpr` |

**`sql` 那一格要单独说。** V 把一门查询语言嵌进了自己的语法（`SqlStmt` / `SqlExpr` /
`SqlQueryDataExpr` 三格 AST）。按我们的纪律这**不是**语言特性，是
"一格 DSL 落在宿主语言里" —— 与 `ext/gsl-shell` 那格"字符串里的 DSL"同一类
（`docs/EXTENSIONS.md` §一提到的样板）。**不给节点，记账**：
它的存在只证明一件事 —— 语法侧要能收，语义侧可以整块当外部调用。

### 3.4 83 格 AST 塌成多少

与 go 那份（151→约 25）同样数一遍，但 V 的 AST 是**语义处理前**的，所以塌得少：

- **12 格是字面量与名字**（`IntegerLiteral` / `FloatLiteral` / `StringLiteral` /
  `CharLiteral` / `BoolLiteral` / `Nil` / `None` / `EnumVal` / `Ident` / `TypeNode` /
  `EmptyExpr` / `NodeError`）→ **2 格**（`const` / `ref`）。
- **9 格是编译期与内省**（`ComptimeCall` / `ComptimeSelector` / `ComptimeType` /
  `ComptimeFor` / `SizeOf` / `OffsetOf` / `TypeOf` / `IsRefType` / `AtExpr`）→
  **1 格 `stage`**（+ 若干 `primitive`）。
- **7 格是编译器内部或调试**（`CTempVar` / `DumpExpr` / `Likely` / `DebuggerStmt` /
  `Comment` / `SemicolonStmt` / `AsmStmt`）→ **0 格**（与 go 的 17 格后端 Op、
  sbcl 的 `jump-table` 同一条界线）。
- **4 格 SQL** → **0 格**（§3.3 末）。
- **6 格早退**（`OrExpr` / `PostfixExpr` 的 `!?` / `IfGuardExpr` / `None` / `AssertStmt`）→
  **0 格新节点**：一格效应 + 一格出端口（§3.1）。
- 剩下约 45 格 → 约 **20 格**骨架节点。

合计 **83 → 约 23**。三条界线（编译器内部不进图、DSL 不进图、早退是效应不是节点）
各自砍掉一批 —— **与 go 那份的三条（类型特化 / 后端 / 内建）不同，但结论同一个：
节点数由"有几件事"定，不由"有几种写法"定。**

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  fn / AnonFn / LambdaExpr / method → callable（method 另要 dispatch）
  struct / StructInit    → record, layout
  sumtype / match        → tagged-union, branch
  interface              → dispatch
  array / map            → array, dict
  string-interp          → bytes
  if / match             → branch
  for（三种）             → loop-region
  defer / lock           → scope-exit（lock 另要 region, mutex）
  spawn / go             → task-queue
  chan / <- / select     → channel, （suspends 效应）
  generic                → monomorphize
  unsafe / C.xxx         → ptr, foreign-call
  comptime（$if/$for/$()） → stage

attached-to（真依赖）
  option/result 的错误出端口 → 一格 call（= may-early-exit 效应）
  or-block / propagate / if-guard → 那格错误出端口的三种消费法
  mut（变量/形参/接收者）    → 一格声明（只检查，不产生代码）
  shared / atomic          → 一格字段或变量
  嵌入（embed）/ implements  → struct
  chan 的方向               → chan-new
  attr（`@[inline]` 那一族） → 一格声明
  thread 句柄               → spawn 的出端口
```

**这一节要证明的三句话：**

1. **删掉 option/result，`call` 不崩。** 它们是 `call` 的一格**出端口** +
   三种消费语法。删光之后 V 变成"只有 panic 的语言"（那就是 V 早期），
   `struct` / `fn` / `for` 一个字不用改。
   —— 这是"附属挂在骨架上"最贴近用户直觉的一例：错误处理看起来最"核心"，
   其实是挂件。
2. **删掉 `mut`（不可变默认），语言还完整。** 它是纯检查，不产生代码。
   与 mojo 的所有权检查、nim 的 `requires/ensures` 同一类。
3. **`array` / `map` 内建不等于它们是骨架。** V 把它们做进语言（有字面量、有类型语法），
   但它们要的能力（`array` / `dict`）与 lua 的 `table`、awk 的关联数组、go 的
   `map` 是同一格。**"内建"是语法上的位置，不是节点清单上的位置。**

## 五、优先级和顺序

1. **错误出端口 + 切段**（§3.1）—— 排第一。V 是唯一把它写在类型上的语言，
   而 go 提供用法语料、nim 提供 `raises` 声明。**三门一起把这台机器定死。**
2. **`scope-exit` 的第五个用法：`lock`**（§3.2）—— 与 defer/`=destroy`/`<close>`/
   `cleanup` 四家合起来，G5 那条"提供者名单"这一格就满了。
3. **`tagged-union`（sumtype + match）** —— 与 nim 的 object 变体、cpp 的 union 三家。
   V 的 `match` 是表达式且带穷尽检查，是这格能力最完整的语料。
4. **`dispatch`（interface）** —— 与 go 同形（结构式），所以这一步是**验证**而非探索：
   两门语言的 interface 应该落到**同一块子图**，落不上就是有人写错了。
5. **`stage`（comptime）** —— `$if` / `$for` / `$(field.name)`。与 nim 的 `when`/`template`、
   chez 的宏三门对账。V 这份最弱（没有宏），所以它定**下界**：
   一门语言只要有编译期分支，就要 `stage`。
6. **C 互操作（`foreign-call`）** —— 与 chez 的 `foreign`/`fcallable`、
   nim 的 `importc` 三家。这一格直通 `node-graph-contract.md` §8（信息保留到 native）。
7. **`ownership`（实验中）** —— 最后，且**只当参照**：V 的所有权检查目前只管字符串
   （`doc/ownership.md` 明写），所以它不能当 `lifetime` 那栏的主语料 ——
   主语料是 mojo 与 nim。

## 六、明说的不足（不猜）

1. **语法侧还欠 2168 份**，最大一类已定位：约 290 份是**串插值里又有引号**，
   需要"能递归回表达式的词法器"（`vlang.grammar` 尾巴第 1 条）。
   其余约 240 份 `too many concurrent parses` + 零散形状三类。
2. **679 处冲突**仍比 go（61）高一个数量级。已知主因是 `operand` / `h-operand`
   受限链的重复（与 nim 的 551 同形）。语法侧的账。
3. **没有明文规格是这门语言最大的风险。** 这份规格里凡是"手册"出处的条目，
   都可能与实现不一致（V 的手册滞后是公认的）。**判据只能是语料 + 参考实现的行为**，
   不是手册的措辞。这一条要在实现每一格时重复。
4. **`spawn` 与 `go` 的区别没量清**：手册说前者是真线程、后者是协程，
   但在不同后端（C / JS）上落法不同。这正是 `task-queue` 那格能力
   **有多个提供者**的意思，但具体对应关系要跑起来才知道。不猜。
5. **`sql` 那一格只记账**（§3.3 末）。如果以后要真接，它是"宿主语言里嵌 DSL"的
   第一个正经语料，那时候要回来写一份单独的说明。
6. **autofree / ARC 那条线没读**（V 有几种内存管理模式）。与 lua 的 `__gc`、
   nim 的 `=trace` 是同一笔账：**`gc-lifetime` 与图算出来的释放点冲突** ——
   三门语言都指到这儿了，这笔账该单独立一份 ADR。
