# mojo —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

**这门语言还在变**（`mojo/docs/nightly-changelog.md` 每晚一改），没有冻结的规格。
下面凡是引手册的都注明文件；凡是量出来的都写明。

## 一、为了什么

**mojo 进来压的是 `lifetime` 那一栏 —— 十门里唯一一门把"这格值归谁、活多久"
写成语言的第一等公民的。** 而它给出的三条规则，与 ADR-0033 §3.5 第 4 条
（"释放点 = 图上最后一次可达使用 + 所在 region"）**几乎逐字对应**：

> - Every value has only one owner at a time.
> - When the lifetime of the owner ends, Mojo destroys the value.
> - **If there are existing references to a value, Mojo extends the lifetime of the owner.**
>
> —— `mojo/docs/manual/values/ownership.mdx:26-33`

第三条正是"最后一次可达使用"那句话的用户视角说法。**这一门是那条判据唯一的外部背书。**

第二格独有的东西：**origin（来源）是一格可以写在类型里的值**。
`mojo/docs/manual/values/lifetimes.mdx` 说 origin 回答两个问题（这格数据归谁、还活着吗），
并且**编译期就消掉，运行期不存在**。类型里能写出来的 origin 有一族：
`ImmOrigin` / `MutOrigin` / `ImmStaticOrigin` / `MutUntrackedOrigin` /
`ImmUnsafeAnyOrigin` / `MutUnsafeAnyOrigin`，外加 `__origin_of(x)`。
—— ADR-0033 §3.2 的 `lifetime` 栏写的是 `owns` / `borrows(in-port k)` / `static`
三格，**mojo 证明这三格够用但要加一格"不追踪"**（`Untracked` / `UnsafeAny`
是给 FFI 与裸指针留的口子，正是 `node-graph-contract.md` §8 那一节的内容）。

第三格：**编译期参数与运行期参数是两套括号**（`fn f[T: Trait, n: Int](x: T)`）。
这是 `monomorphize` 那格能力最干净的语法 —— 比 cpp 的模板与 go 的类型参数都清楚，
因为"哪些是编译期"写在括号上，不用推断。

## 二、需要什么内容

- **文档**：`mojo/docs/manual/` 全篇。与节点有关的，按重要性：
  - **`values/ownership.mdx`** —— 三条规则 + 五种实参约定（§3.1）。
  - **`values/lifetimes.mdx`** —— origin 那一族。
  - **`lifecycle/{index,initialization,life,death}.mdx`** —— `__init__` / `__deinit__`
    与"值的一生"。量了一遍：这四份里 `__deinit__` 出现 47 次、`__init__` 41 次
    —— **这门语言的重心在生死两头**，不在算法。
  - `parameters/`、`generics.mdx`、`traits.mdx` —— 编译期与派发。
  - `structs/`、`types.mdx`、`values/value-semantics.mdx` —— 数据。
  - `errors.mdx`（`raises` + `try`）、`control-flow.mdx`、`operators.mdx`。
  - `c-ffi.mdx`、`pointers/` —— 直通 `node-graph-contract.md` §8。
- **`mojo/proposals/`**（约 40 份设计提案）—— **这是这门语言最好的材料**：
  每份提案都是"为什么这么设计 + 备选方案"，比手册有用。
  与我们有关的几份：`deinit-arg-convention.md`、`copyable-refines-movable.md`、
  `collection-literal-design.md`、`comptime-expr.md`、`c-abi-proposal.md`、
  `inferred-parameters.md`。
- **语料与现状**：`modular/mojo/stdlib` 下的 `.mojo`（602 份）。
  量出来 **570/602（95%）** —— 十门里第三高。
  （`max/` 与 `KGEN/` 下另有三千份，其中 `mblack` 那批是格式化器的测试数据，
  故意写得古怪，不算语料 —— 见 `ext/mojo/bench.json`。）

## 三、原子化特性表

### 3.1 所有权与生命期（这一门的心脏）

| 特性 | 一句话 | 对应五栏的哪一格 | 出处 |
| --- | --- | --- | --- |
| 默认实参（不可变引用） | 不写约定就是**只读借** | 入端口 `borrow`，只读 | ownership.mdx:121 |
| `mut` 实参 | 可写借 | 入端口 `borrow`，可写 | ownership.mdx:169 |
| `var` / `^`（transfer） | **夺** —— 调用方交出所有权 | 入端口 `consume` | ownership.mdx:279 |
| `out` 实参 | 出参：函数负责初始化它 | **出端口**（不是入端口） | ownership.mdx:51 |
| `ref` 实参 / 返回 | 带 origin 的引用，可参数化 | `lifetime: borrows(in-port k)` | lifetimes.mdx |
| `ref x = list[0]` 绑定 | 引用绑定（不复制） | 一条 `value` 边 + `borrow` | ownership.mdx:35-50 |
| 实参互斥（exclusivity） | 同一格值不许同时可写借与别的借 | **检查**，不产生代码 | ownership.mdx:234 |
| `__init__` / `__deinit__` | 生 / 死两个钩子 | `scope-exit` 的动作 | lifecycle/*.mdx |
| origin 一族 | `ImmOrigin` / `MutOrigin` / `*Static*` / `*Untracked*` / `*UnsafeAny*` | `lifetime` 栏的取值集 | lifetimes.mdx |
| `__origin_of(x)` | 取一格值的 origin 当类型参数用 | 把 `lifetime` 提到类型层 | lifetimes.mdx |

**两条要立刻写进契约的结论：**

1. **`out` 是出端口，不是入端口。** 一门语言的"出参"在图上不该建模成"可写的入端口" ——
   否则调度器算不出"它在这一点之前没有值"。ADR-0033 §3.2 说"多出端口是常态"，
   mojo 的 `out` 是它的第三个用例（前两个：错误出端口 by V、多返回值 by go/lua）。
2. **`lifetime` 栏要加一格 `untracked`。** 三格（`owns`/`borrows`/`static`）
   在纯 mojo 代码里够用，但 FFI 与裸指针必须有一格"我不管"——
   mojo 自己就设了 `MutUntrackedOrigin` / `*UnsafeAnyOrigin` 两族。
   **不加这一格的后果是：所有 C 互操作都得撒谎说自己 `owns` 或 `borrows`。**

### 3.2 编译期（第二格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `[…]` 参数表 | **编译期参数**与运行期实参分两套括号 | `monomorphize` | parameters/ |
| `alias` | 编译期常量（含类型别名） | `const` + `stage` | manual |
| `@parameter` | 装饰器：把 `if` / `for` 变成编译期的 | `stage` | metaprogramming/ |
| `@always_inline` / `@register_passable` / `@value` | 装饰器：内联 / 寄存器传递 / 自动生成生命期方法 | **附属** | manual + proposals |
| trait bound | `[T: Copyable & Movable]` | `dispatch` + `monomorphize` | traits.mdx |
| `Copyable` / `Movable` 那套 refine 关系 | trait 之间的偏序 | `dispatch` 的一格附属 | proposals/copyable-refines-movable.md |
| SIMD | `SIMD[DType.float32, 4]` —— **宽度是编译期参数** | 方言的向量那一格 | manual |
| comptime 表达式 | 编译期求值（那台解释器） | `stage` | proposals/comptime-expr.md |

**`@value` 这一格要单独说**：它自动生成 `__init__` / `__copyinit__` 那一族。
也就是说 mojo 自己承认"生命期方法多数时候是样板" —— 与我们
"释放点算出来、动作由提供者填"（ADR-0033 §3.5 第 4 条）是同一个判断：
**样板该由机器生成，不该由人写。**

### 3.3 其余（骨架）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `struct` | 值语义、字段、方法；**没有继承** | `record` + `layout` | structs/ |
| `trait` | 方法集 + refine 偏序 | `dispatch` | traits.mdx |
| `fn` / `def` | 严格 / 宽松两种函数（`def` 允许隐式 raises 与动态） | `callable` | functions/ |
| `raises` / `try` / `except` | 错误：声明在签名上（与 nim 的 `raises` 同形） | `may-early-exit` 效应 | errors.mdx |
| `with` | 上下文管理器（`__enter__` / `__exit__`） | `region` + `scope-exit` | manual |
| `async fn` / `await` | 协程 | `suspends` + `task-queue` | manual |
| `if` / `while` / `for` | 控制流（`for` 走迭代器协议） | `branch` / `loop-region` | control-flow.mdx |
| `UnsafePointer` / `Pointer` | 带 origin 的指针 vs 裸指针 | `ptr` | pointers/ |
| `external_call` / C FFI | 直接调 C | `foreign-call` | c-ffi.mdx |
| Python 互操作 | 运行期嵌一个 CPython | **不进图**：整块当外部调用 | python/ |
| MLIR 内建 | `__mlir_op.*` —— 直接写 MLIR 算子 | **不进图**：后端的事 | stdlib 里到处是 |

**`__mlir_op.*` 那一格是这门语言给我们的一个意外礼物**：mojo 的标准库里
最底层的东西是直接写 MLIR 算子的。这说明**它自己就走"语言→图→后端算子"这条路**，
而且承认底层要有一个"直通后端"的口子。我们的对应物是
`node-graph-contract.md` §6 的 `backend.lower` —— 但**我们的口子只对后端开，不对用户开**。
这一条差别要记住：mojo 让用户写 MLIR，我们不让用户写 sx。

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  fn / def               → callable
  struct                 → record, layout
  trait                  → dispatch
  with                   → region, scope-exit
  __init__ / __deinit__  → scope-exit（动作侧）
  if / while / for        → branch, loop-region
  raises / try            → （may-early-exit 效应）
  async fn / await        → suspends, task-queue
  UnsafePointer           → ptr
  external_call           → foreign-call
  [参数表] / alias / @parameter → stage, monomorphize
  SIMD                    → 方言的向量那一格

attached-to（真依赖）
  实参约定（默认/mut/var/^/out/ref） → 一格 callable 的形参（= lifetime 栏）
  origin（Imm/Mut/Static/Untracked/UnsafeAny） → 一格引用类型
  exclusivity 检查        → 一格 callable（只检查，不产生代码）
  @value / @always_inline / @register_passable → 一格 struct 或 fn
  trait bound / refine 偏序 → 一格参数表
  raises                  → 一格 callable 的签名
```

**这一节要证明的三句话：**

1. **mojo 没有继承，`dispatch` 照样成立。** `struct` 不能继承，派发全靠 `trait`。
   —— 于是"`record` 与 `dispatch` 是两格独立能力"这条（go 那份 §四第 1 条）
   在 mojo 上更强：这门语言**根本没有**"类继承"这个概念，
   而 `dispatch` 一格不少。**cpp 那份规格要拿这一条当对照。**
2. **删掉所有权检查，语言还在。** exclusivity 与 origin 检查都是编译期检查，
   不产生代码（ADR-0033 §7 已把 mojo 的 ownership 列为"检查型特性"）。
   删掉之后 mojo 变成"手动小心的 C++" —— 能编、能跑。
   **这是"检查是一格不产生代码的特性"最干净的实例。**
3. **`alias`（编译期常量）不依赖类型层。** `alias x = 4` 与 `alias T = Int` 同一格语法。
   —— 又一次说明"类型"在图上不是一层，是**某些端口的 sort**。

## 五、优先级和顺序

1. **`lifetime` 栏的四格取值**（`owns` / `borrows(k)` / `static` / **`untracked`**）——
   排第一，产出就是 §3.1 那两条结论写进契约。mojo 是唯一能验这一格的语料。
2. **`out` 是出端口**（§3.1 第 1 条）—— 与 go 的多返回值、V 的错误出端口三家
   一起把"多出端口"那格定死。
3. **`scope-exit` 的动作侧**：`__deinit__` 与 `with`（`__exit__`）——
   与 nim 的七个钩子对账（`ext/nim/SPEC.md` §3.2）。
   **两门语言的钩子表能不能对上，是这台机器做成没做成的判据。**
4. **`monomorphize`**（`[…]` 参数表 + `alias` + `@parameter`）——
   mojo 的语法最清楚（编译期与运行期分两套括号），所以**先在 mojo 上做**，
   再去接 go 的 type-param 与 cpp 的 template。ADR-0025 那台单态化机器已经有了。
5. **`dispatch`（trait）** —— 与 go 的 interface 对账。mojo 的 refine 偏序
   （`Copyable` refines `Movable`）多一格"trait 之间有序" —— 那是附属。
6. **`stage`（comptime）** —— 与 nim 的 `when`/`template`、V 的 `$if` 三门。
   mojo 有一台真的编译期解释器（`proposals/comptime-expr.md`），
   这与我们"`graph.eval` 就是默认解释器"（`node-graph-contract.md` §5）是同一件事 ——
   **编译期求值与运行期求值共用一台 eval**，这一条要在这一步验。
7. **`ptr` + FFI**（`UnsafePointer` / `external_call` / MLIR 口子）—— 最后，
   与 cpp 一起做。这一格是 §8（信息保留到 native）的主语料。

## 六、明说的不足（不猜）

1. **语法侧 570/602，欠 32 份**。没有逐份分类，所以不说原因。
2. **这门语言在变**：`__copyinit__` / `__moveinit__` 这些名字在不同版本里换过
   （当前手册的 lifecycle 四份里只见 `__init__` 与 `__deinit__`，各 41 / 47 次）。
   **所以这份规格的判据必须是语料 + 当前手册，不是我记得的写法。**
   实现每一格前重新 grep 一遍手册。
3. **`def` 与 `fn` 的差别没量清**：`def` 允许隐式 `raises`、允许动态类型。
   它可能意味着"同一门语言里两套效应默认值" —— 如果是，那是效应栏的一个新情况。
   记账。
4. **Python 互操作整块不进图**（§3.3）。这是个决定，不是不足；写在这儿是因为
   它与 V 的 `sql`、gsl-shell 的"字符串里的 DSL"是同一类问题：
   **宿主语言里嵌另一门语言**。三处都记了账，以后要一起看。
5. **SIMD 的宽度是编译期参数**，落到方言要一格向量类型（ADR-0031 那份承载力清单）。
   与 freebasic / cpp 的对齐那一格一起看。
6. **`@register_passable` / `@register_passable("trivial")`** 是"这格值按值放在寄存器里"
   的声明。它是 `backend.carry` 那一问的**用户可写版本** —— 也就是说 mojo 允许
   用户干预表示。我们的契约里这一问只由后端答（§6）。**这个差别要写进 ADR，
   不要偷偷放开。**
