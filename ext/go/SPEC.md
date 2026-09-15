# go —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

## 一、为了什么

**go 进来压两件事，而且这两件事都不是"go 有什么特性"，是"节点该有多少格"。**

1. **一个特性 ≠ 一个节点，这一门给出量化答案。** Go 编译器的 IR 有
   **151 格 `Op`**（`src/cmd/compile/internal/ir/node.go:114-311`）。按族分完（§3.4）
   它们塌成 **20 多格节点**。差在哪儿：Go 的 IR 在类型检查之后**按类型特化**
   （`OSLICE` / `OSLICEARR` / `OSLICESTR` / `OSLICE3` / `OSLICE3ARR` 是同一件事的五种类型），
   而我们把"按类型落成什么"放在**契约的 `backend.carry` 那一问**里
   （`node-graph-contract.md` §6），不放在节点上。
   **这就是"很多特性表达的是同一件事"最硬的一份数据。**
2. **并发那一族的模型。** goroutine / channel / select / `defer` —— 四样东西，
   在我们这儿是**一格 `suspends` 效应 + 一格 `task-queue` 能力 + 五个节点**
   （`node-graph-contract.md` §7）。go 是那一节唯一的**完整**语料：
   别的语言各有一半（chez 只有 `call/cc`、lua 只有协程、mojo 只有 `async`）。

第三格顺手的收益：Go 是十门里**语法覆盖率最高**的一门（8114/8218，98.7%），
所以它是唯一能拿"整棵标准库 + 编译器自身"当语义侧语料的语言。

## 二、需要什么内容

- **官方规格**：`go/doc/go_spec.html` —— 一份完整、自洽、带 EBNF 的规格。
  与节点有关的章节：Types（含 underlying type 与 type identity）、
  Properties of types and values（**assignability / convertibility 两张表**）、
  Expressions（Order of evaluation 那一节是 ADR-0033 §3.5 第 1 条的直接对照）、
  Statements（含 `defer` 与 `go` 的求值时机）、
  **Type parameters / Type constraints**（泛型那一族）。
  另有 `go/doc/go_mem.html`（内存模型）—— 并发那一族要它。
- **参考实现里要读的三处**：
  - `src/cmd/compile/internal/ir/node.go:114-311` —— **151 格 `Op`**，每格一句注释。
    §3.4 那张归并表就是从这一段量出来的。
  - `src/cmd/compile/internal/syntax/` —— 纯 AST（类型检查之前），是"语言的形状"，
    比 `ir` 更接近规格。
  - `src/runtime/`（`chan.go` / `proc.go` / `select.go`）—— 并发那一族的**语义**在这儿，
    不在语法里。
- **我们自己量出来的**：`go.grammar` 332 条产生式 / 61 处冲突，尾巴上那条曲线（十刀）。
  最贵的三刀都与节点有关：右递归值 2571 份、类型 switch 单开非终结符值 391 份、
  `nx-type`（"一看就不是表达式"的类型）值 189 份。**第三刀说明"类型与表达式在
  语法位置上分得开"** —— 这一条到语义侧还要再用一次（§4 第 2 条）。
- **语料与现状**：Go 树里的 `.go`。量出来 **8114/8218（98.7%）**，
  坏例 25+4（`internal/syntax/testdata/` 里带 `ERROR` 标记的，见 `ext/go/bench.json`）。

## 三、原子化特性表

### 3.1 类型那一侧（Go 是十门里类型最"有形状"的一门）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `named-type` | `type T U` 造一格**新类型**（不是别名）；`type T = U` 才是别名 | `named-type` | 规格 Type declarations |
| `struct` | 字段 + 标签 + **嵌入**（匿名字段带方法提升） | `record` + `layout` | 规格 Struct types |
| `pointer` | `*T`、`&x`、`new(T)`。**没有指针算术** | `ptr` | 规格 Pointer types |
| `slice` | `[]T` = 三元组（ptr/len/cap），`s[a:b:c]` | `array` + `ptr` | `OSLICE*` 五格 |
| `array` | `[N]T`，**值语义**（赋值即复制） | `array` | 规格 Array types |
| `map` | `m[k]`，`m[k]` 读缺键得**零值**、`v, ok = m[k]` 双值 | `dict` | `OINDEXMAP` / `OAS2MAPR` |
| `chan` | `chan T` / `<-chan T` / `chan<- T` | `channel` | §3.3 |
| `func-type` | 函数是一等值；**多返回值** | `callable` + `multi-value` | 规格 Function types |
| `interface` | 方法集；**结构式**（不用声明实现） | `dispatch` | 规格 Interface types |
| `type-param` | `[T any]` / `[T ~int \| string]` / `[S ~[]T]` | `monomorphize` | go.grammar（三种形状已收） |
| `zero-value` | 每格类型都有零值，**声明即初始化** | `nullable` 的反面：`zero-init` | 规格 The zero value |
| `untyped-const` | 无类型常量 + 默认类型 + 任意精度 | `const` + `number-tower` | 规格 Constants |

两条要立刻记下的：

1. **`zero-init` 与 lua / awk 的 `nullable` 是同一格能力的两个答案。**
   awk"读一格就建一格空的"、lua"没有就是 `nil`"、go"每格类型有确定的零值"——
   三家都在回答"一格没写过的存储读出来是什么"。这一格是**能力**（三个提供者），
   不是节点。
2. **`interface` 的结构式判定不影响图。** "T 实现了 I 吗"是一次**查询**
   （ADR-0033 §10 那条"保留求解器"），不是节点也不是边。
   图上只有 `makeface`（装箱）与 `dotinter`（派发）两件事。

### 3.2 语句与表达式（骨架）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `assign` | `=` / `:=` / `op=` / 多值赋值 / `x, ok = …` 三种双值形式 | `bind` | `OAS*` 八格 |
| `call` | 函数 / 方法 / 接口方法 / 类型转换**在语法上同形** | `indirect-call` + `dispatch` | `OCALL*` 八格 |
| `select-field` | `x.f`（含**指针自动解引用**与嵌入字段提升） | `record` | `ODOT*` 九格 |
| `index` / `slice-expr` | `a[i]` / `s[a:b:c]`（数组 / 切片 / 串 / map 四种落法） | `array` / `dict` | `OINDEX*` / `OSLICE*` |
| `composite-lit` | `T{…}`（struct / array / slice / map 四种 + `&T{…}`） | `record`/`array`/`dict` | `OCOMPLIT` 等六格 |
| `make` / `new` | 三种 `make` + `new` | `allocates` 效应 | `OMAKE*` 五格 |
| `if` / `switch` / `type-switch` | 三种分支；`switch` 带 `init`、无条件、`fallthrough` | `branch` | `OIF`/`OSWITCH`/`OTYPESW` |
| `for` / `range` | 一种循环 + `range`（数组/切片/串/map/chan/**函数**六种被迭代物） | `loop-region` | `OFOR`/`ORANGE` |
| `return` / `break` / `continue` / `goto` / `label` | 出口五种写法 | `may-early-exit` 效应 | 各自的 `Op` |
| `func-decl` / `closure` | 函数声明 / 函数字面量（**捕获按引用**） | `callable` + `region` | `ODCLFUNC`/`OCLOSURE` |
| `defer` | 延到函数返回时跑；**实参当场求值** | `scope-exit` | `ODEFER` |
| `go` | 起一格 goroutine；**实参当场求值** | `task-queue` | `OGO` |
| `send` / `recv` | `c <- v` / `<-c` | `channel` + `suspends` 效应 | `OSEND`/`ORECV` |
| `select` | 多路等待 + `default` | `channel` + `suspends` | `OSELECT` |
| `panic` / `recover` | 非局部展开 + 在 `defer` 里拦住 | `may-early-exit` + `scope-exit` | `OPANIC`/`ORECOVER` |
| `builtin` | `len`/`cap`/`append`/`copy`/`delete`/`min`/`max`/`clear`/`close`/`print`/`complex`/`real`/`imag`/`unsafe.*` | **`primitive`（chez 的 `pr` 那一格）** | 23 格 `Op` |

### 3.3 并发那一族（`node-graph-contract.md` §7 的完整语料）

| 层 | go 的写法 | 我们的落法 | 新节点 |
| --- | --- | --- | --- |
| 1 | `<-c` / `c <- v` 阻塞、`select` 等待 | `suspends` 效应 → 图在这一点切段 | 0 |
| 2 | `go f(x)` | `spawn`；`task-queue` 能力的提供者 = GMP 调度器 | 1（`spawn`；`join` go 里没有，靠 chan/WaitGroup） |
| 3 | `chan T`、`make(chan T, n)`、`close` | `chan-new` / `chan-send` / `chan-recv` | 3 |
| — | `select` | **不是新节点**：n 路 `chan-recv` + 一格 `branch`，全部挂 `suspends` | 0 |
| — | `defer` | `scope-exit`（与 sbcl 的 `cleanup`、lua 的 `<close>` 同一台机器） | 0 |
| — | `panic`/`recover` | `may-early-exit` + `scope-exit` 上的一格拦截器 | 0 |

**六族语法，四个新节点。** 这一栏是 §7 那个模型的第一次完整对账，而且它给出一条
之前没写下的判据：**`select` 不该有节点** —— 它是"若干挂起点 + 一格分支"的形状，
与 awk 的 pipeline 同一条道理（`node-graph-contract.md` §9(a)）。

`defer` 的一格细节要记下：**实参当场求值、调用延后**。在五栏里这是
"入端口 `value`（当场取）+ 出端口挂到 `region` 的出口" —— `scope-exit` 那台机器
本来就该长这样，go 只是把它写得最明确。`go f(x)` 同理。

### 3.4 151 格 `Op` 是怎么塌成 20 多格的（这一节是这份规格的主要产出）

按族数，`node.go:114-311`：

- **12 格是"同一件事的不同表示"**：`OCONV` / `OCONVIFACE` / `OCONVNOP` /
  `OBYTES2STR` / `OBYTES2STRTMP` / `ORUNES2STR` / `OSTR2BYTES` / `OSTR2BYTESTMP` /
  `OSTR2RUNES` / `OSLICE2ARR` / `OSLICE2ARRPTR` / `ORUNESTR` → **1 格 `conv`**
  （"落成哪种表示"是 `backend.carry` 的答案，不是节点的身份）。
- **8 格赋值** → **1 格 `assign`** + `multi-value` 附属（`OAS2FUNC`/`OAS2MAPR`/
  `OAS2RECV`/`OAS2DOTTYPE`/`OSELRECV2` 都是"右边产生两格值"的特例）。
- **8 格调用** → **1 格 `call`** + `dispatch` 附属（`OCALLINTER` vs `OCALLMETH`）。
- **9 格选择器** → **1 格 `select-field`** + `dispatch` 附属。
- **5 格切片 + 2 格下标** → **2 格**（`index` / `slice-expr`）。
- **6 格复合字面量** → **1 格 `composite-lit`**（类型在端口上，不在节点名上）。
- **5 格 `make`** → **1 格 `make`**（+ `allocates` 效应）。
- **19 格二元 + 7 格一元** → **2 格**（`binop` / `unop`；`OPAREN` 是附属，
  `OANDAND`/`OOROR` 的第二个入端口是 `lazy`）。
- **23 格内建** → **1 格 `primitive`** —— 与 chez 的 `pr`（`ext/chez/SPEC.md` §3.2）
  **同一格**。两门语言独立指向同一结论：内建函数不是语言结构。
- **约 17 格是后端的东西，不进图**：`OITAB` / `OIDATA` / `OSPTR` / `OMAKEFACE` /
  `OSLICEHEADER` / `OSTRINGHEADER` / `OCHECKNIL` / `ORESULT` / `OINLMARK` /
  `OLINKSYMOFFSET` / `OJUMPTABLE` / `OINTERFACESWITCH` / `OMOVE2HEAP` / `OCFUNC` /
  `OGETG` / `OGETCALLERSP` / `ODYNAMICTYPE` —— 与 sbcl 的 `jump-table` / `vop-jumper`
  同一条界线（**后端可以有自己的节点，不许倒灌进契约**）。
- **剩下约 21 格语句 + 5 格名字/字面量** → 约 **14 格**骨架节点（§3.2 那张表）。

合计：**151 → 约 25**。差的那 126 格里，**55 格是类型特化**、**17 格是后端**、
**23 格是内建**。三条各对应契约里的一问（`carry` / `lower` / `primitive`），
**一格都不需要新节点**。

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  assign / func-decl        → bind
  block / closure           → region
  if / switch / type-switch → branch
  for / range               → loop-region
  call                      → indirect-call（+ dispatch 当接收者是接口）
  select-field              → record（+ layout）
  index / slice-expr        → array, dict, ptr
  composite-lit             → record, array, dict
  make / new                → （allocates 效应）
  defer                     → scope-exit
  go                        → task-queue
  send / recv / select      → channel（+ suspends 效应）
  panic / recover           → （may-early-exit 效应）+ scope-exit
  interface（makeface/dotinter）→ dispatch
  type-param                → monomorphize
  builtin                   → primitive

attached-to（真依赖）
  struct tag                 → struct 的一格字段
  嵌入字段（embedded）        → struct（它是"字段 + 方法提升"两格附属）
  方向（<-chan / chan<-）     → chan-new
  multi-value                → call / assign
  dispatch（接口 vs 具体）     → call / select-field
  conv 的"哪种表示"           → conv（= backend.carry 的答案）
  OPAREN                     → 一格表达式（只影响渲染）
  zero-init                  → 一格声明
  lazy（&& / ||）             → binop 的第二个入端口
```

**这一节要证明的三句话：**

1. **删掉 `interface`，`struct` 不崩。** Go 里 `struct` 不要求任何接口存在；
   反过来接口要的是"有方法集"这格能力，方法挂在**具名类型**上（不必是 struct）。
   —— 于是 `dispatch` 与 `record` 是两格**独立**能力，删一格另一格照旧。
2. **删掉所有具名类型，`record` 还在** —— 匿名 struct（`struct{a int}`）合法，
   Go 的规格明文允许。这是"删光类型 class 只算空类"在一门**静态类型**语言上的版本：
   连 go 都不需要"先有类型层再有结构"。
3. **`type-param` 是附属，不是骨架。** 删掉泛型，`func-decl` 与 `struct` 一个字不用改
   （Go 1.17 就是那门语言）。它挂在声明上，落法是一台单态化机器
   （与 mojo 的 `parameter`、cpp 的 `template` 同一台）。

## 五、优先级和顺序

1. **`multi-value`** —— 排第一，与 lua 那份规格第 1 项**同一格**。go 这边更细：
   `x, ok = m[k]` / `v, ok = <-c` / `x, ok = i.(T)` 三种"值 + 有没有"是
   **同一个形状**（IR 里就是 `OAS2MAPR`/`OAS2RECV`/`OAS2DOTTYPE` 三格特化）。
   两门语言一起把"多出端口"定下来。
2. **`scope-exit`（`defer`）** —— 与 sbcl 的 `cleanup`、lua 的 `<close>` 三门对账。
   go 的 `defer` 多一格"实参当场求值"，正好把那台机器的端口语义压满。
3. **`conv`（12 格塌 1 格）** —— 这一步是**契约的第一次真验收**：
   同一格 `conv` 节点，C 后端答"memcpy 或什么都不做"、js 答"包一层"、
   wasm 答"线性内存里搬"。三种答案不改节点 ⇒ §3.4 那条结论成立。
4. **`allocates` 效应 + `region`** —— `make`/`new`/`closure` 三样。
   这一步顺带回答 sbcl 那份留下的未决问题（`enclose` 是节点还是效应，
   `ext/sbcl/SPEC.md` §六第 4 条）：go 这边**没有** `enclose` 那样的节点，
   闭包分配是 `OCLOSURE` 的性质。**两门语言的证据合起来才够下结论。**
5. **`dispatch`（interface）** —— 与 mojo 的 trait、cpp 的 virtual 三个提供者。
   go 的结构式判定是一次**查询**，不进图（§3.1 第 2 条）——
   这一条要在实现时守住，不然求解器会漏进节点里。
6. **并发四节点（`spawn` / `chan-new` / `chan-send` / `chan-recv`）** ——
   与 lua 的协程、chez 的 `call/cc` 共用续延机器。go 是这一族的主语料。
   `select` 不给节点（§3.3）。
7. **`monomorphize`（type-param）** —— 最后，与 mojo / cpp 一起。
   它是**已有的机器**（ADR-0025 那台单态化），不是新东西。

## 六、明说的不足（不猜）

1. **语法侧还欠 251 份，三类已分好**（`go.grammar` 尾巴）：128 份
   `too many concurrent parses`（集中在机器生成的巨型文件，`rewriteAMD64.go` 11 万行）、
   26 份是 Go 自己的错误用例（已进 `bench.json` 的 `invalid`，量出来 25+4）、
   剩下是零散形状（`+0x1p-1022` 那种带正号的十六进制浮点）。
2. **内存模型完全没读**（`go_mem.html`）。它规定 happens-before，
   而我们的 `effect` 边只表达"同一效应域内的次序" —— **跨 goroutine 的次序在图上
   现在没有表达方式**。这是这份规格发现的最大一个空洞，比任何节点问题都要紧。
   记账，不猜答案。
3. **`unsafe` 那六格没定**（`OUNSAFEADD` / `OUNSAFESLICE` / `OUNSAFESTRING` …）。
   它们是 `ptr` 那格能力的**上限**，且与 `node-graph-contract.md` §8
   （信息保留到 native）直接相关。等 cpp 的规格一起看。
4. **`range over func`（Go 1.23 的迭代器）没进 §3.2 那格 `range`**：
   它把 `range` 变成"调一格接受 yield 函数的函数"，与 `suspends` 有关系但不确定是哪一格。
   语法侧已收，语义侧记账。
5. **`init()` 与包级初始化次序**（规格 Package initialization）没读。
   它是一格"由依赖算出来的次序"，与 ADR-0033 §2.3 的拓扑序**可能是同一台机器**——
   值得回来看，但现在不猜。
6. **对齐与 `unsafe.Sizeof`** 属于 `layout` 能力的细节，与 freebasic / cpp 一起看。
