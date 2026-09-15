# chez —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇（节点 / 骨架 / 附属 / 能力）见
`docs/design/node-graph-contract.md` 与 ADR-0033。

## 一、为了什么

**chez 进来压的是一件别的语言压不出来的事：语法与语义可以完全分开，而且分开之后核心小得
能装进一张表。**

- 语法那一侧：`ext/chez/chez.grammar` **12 条产生式**，只到 datum 层。`if` / `lambda` /
  `define` 一个都不在语法里 —— 它们是宏与特殊形式，属于求值那一层。
- 语义那一侧：Chez 自己的编译器把整个 Scheme 展开成一份 **24 行的核心语言 `Lsrc`**
  （`s/base-lang.ss:238-265`）。这就是用户说的"一张表就能放心"的那张表 —— **它是别人量好的，
  不是我们想的**。

于是 chez 在这个项目里的角色是**节点清单的第一把尺子**：如果我们数出来的骨架节点，
在 chez 这一门上比 `Lsrc` 那张表多出一大截，那多出来的部分就要被质问。反过来，
`Lsrc` 有而我们没有的，是明账。

第二格独有的东西：**宏 = 用户可写的特性**。ADR-0033 §7 已经点出来 ——
Chez 的 `syntax-rules` / `syntax-case` 恰好就是这份架子里的规则引擎本身。
chez 是唯一能验证"消去规则这套机制够不够表达真实语言的宏"的语料。

## 二、需要什么内容

- **官方规格**：R6RS（Chez 的基准，`#!r6rs` 那格 directive 就是它）、R7RS（对照用）。
  Chez 自己的文档在参考树里：`ChezScheme/csug/*.stex` —— 与节点有关的是
  `binding.stex`（绑定形式）、`control.stex`（控制，含 `call/cc` 与 engine）、
  `objects.stex`（对象与记录）、`threads.stex`（线程）、`foreign.stex`（外部调用）、
  `syntax.stex`（宏）、`smgmt.stex`（存储管理 / GC）。
- **参考实现里真正要读的两处**（不是全树）：
  - `s/base-lang.ss:219-267` —— `Lsrc` 与 `Ltype`。**核心语言的全部形式就这一段。**
  - `s/prims.ss` / `s/library.ss` —— 哪些东西**不是**核心形式而是原语（`pr`）。
    判据式的一条证据：`call/cc` 定义在 `s/prims.ss:569`，**它不在 `Lsrc` 里**。
- **语料与现状**：`ext/chez/bench.json` = ChezScheme 树里的 `.ss` / `.sls`。
  量出来的覆盖率 **135/135（100%）**，0 冲突，12 条产生式。
  —— 语法这一半在 chez 上**已经做满**，这份规格是往语义那一侧走的第一步。

## 三、原子化特性表

四栏：`特性 · 一句话 · 要的能力 · 出处`。能力名的定义见 ADR-0033 §5
（"至少两个提供者才配叫能力"）。

### 3.1 读取器那一层（已实现，语法侧）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `datum` | 源文本是一棵嵌套的表，不是语句序列 | `sexpr-read` | chez.grammar:104-153 |
| `abbrev` | `'x` `` `x `` `,x` `,@x` `#'x` 是两元素表的缩写，**不在语法里展开** | `sexpr-read` | chez.grammar:143-153 |
| `datum-label` | `#0=(a . #0#)` 环形结构 | `graph-literal` | chez.grammar:81-82,122-123 |
| `datum-comment` | `#;` 注掉**下一棵树** —— 词法办不到，所以它在语法里 | `sexpr-read` | chez.grammar:111 |
| `vector-family` | `#(…)` `#vu8(…)` `#vfx(…)` `#vfl(…)` 四种同构字面量 | `array` | chez.grammar:134-137 |
| `record-datum` | `#[类型名 字段…]` 记录字面量 | `record` | chez.grammar:139 |
| `box-datum` | `#&x` 一格可变的存储 | `cell` | chez.grammar:152 |
| `numeric-tower` | `#x1f` `1/2` `+inf.0` `#i#x10…` —— 精确性与进制各一格前缀 | `number-tower` | chez.grammar:52-57 |

### 3.2 核心形式（语义侧，**照 `Lsrc` 抄**，一格不多）

`Lsrc` 的 `Expr` 一共 **24 种形式**（:239-263）。按骨架 / 附属分开：**骨架 17 种，
附属 7 种**（附属那 7 种见 §3.3）。骨架那 17 种归并成下面 **11 族**：

| 特性 | 一句话 | 能力 | 出处（`s/base-lang.ss`） |
| --- | --- | --- | --- |
| `pr` | 原语引用。**`call/cc` / `car` / `+` 全在这一格**，不是形式 | `primitive` | :239, `s/prims.ss` |
| `ref` | 取一格绑定的值 | `bind` | :241 |
| `quote` | 一格常量 | `const` | :242 |
| `if` | 两支，**只算一支** | `branch`（入端口 `lazy`） | :243 |
| `seq` | 两格按序，前一格的值扔掉 | —（该是 `effect` 边，不是节点，见下） | :244 |
| `set!` | 写一格绑定 | `bind` + `writes` 效应 | :245 |
| `case-lambda` | **函数只有这一种形式** —— 定长与变长都是它的一条 clause | `callable` | :247 |
| `letrec` / `letrec*` | 一组互递归绑定；`*` 那格多一条"按序初始化" | `bind` + `region` | :248-249 |
| `call` | 调一格函数值。**`f(x)` 与原语调用同一格** | `indirect-call` | :250 |
| `record` 族（5 种） | `record-type` / `record-cd` / `record` / `record-ref` / `record-set!` | `record` + `layout` | :251-257 |
| `foreign` / `fcallable` | 出去 / 进来：约定 + 参数类型 + 返回类型 | `foreign-call` | :259-260 |

三条要立刻记下的账，都是这张表**教给节点清单**的：

1. **`seq` 在我们这儿不该是节点。** Chez 需要它，是因为项（term）表达不了次序；
   ADR-0033 §3.3 的 `effect` 边正是它的替代物，而 G2 明文禁止特性规则里出现 `seq`。
   **这是这份规格给出的第一个"少一个节点"的证据。**
2. **函数只有 `case-lambda` 一格。** 定长函数是它的特例。这一条直接影响十门语言的
   `fn` 节点该怎么声明：**元数分派是 `callable` 的一格附属，不是新节点**（go 的
   `multi-return`、lua 的变参、awk 的可省参数都会落到这儿）。
3. **`call/cc` 不在核心语言里**（`s/prims.ss:569`）。也就是说 Chez 自己**没有**把续延
   做成一格形式，它做成了运行时的原语 + 栈的表示。我们的选择相反（ADR-0033 §3.5 第 3 条：
   `suspends` 效应 + 切段），所以这一格是**我们与参考实现刻意不同**的地方，
   要在实现里记一笔：判据是行为一致，不是结构一致。

### 3.3 附属节点（`Lsrc` 的另外 7 种形式，加两格别的 sort）

这一节是"骨架 vs 附属"最干净的实例 —— **Chez 自己就把这两类写在同一张表里，而且
删掉这几行，`Lsrc` 仍是一门完整的语言**：

| 特性 | 挂在谁身上 | 一句话 | 出处 |
| --- | --- | --- | --- |
| `pariah` | 所在的那一段 | "这条路很少走" —— 给布局器的提示 | :246 |
| `profile` | 一格源位置 | 采样计数点 | :261 |
| `cte-optimization-loc` | 一格 `Expr` | 编译期优化信息挂在一格 box 上 | :258 |
| `immutable-list` | 一格 `Expr` | "这格表字面量不可变" | :253 |
| `immutable-vector` | 一格 `Expr` | 同上，向量版 | :254 |
| `moi` | 当前那格函数 | "我是谁"（报错用） | :240 |
| `cpvalid-defer` | 一格 `Expr` | 某一遍内部用的包装 | :263 |
| `preinfo` | `call` / `case-lambda` | 源位置 + 名字 + 一串标志（能不能内联、会不会返回、是否单值）。**它是 terminal，不是 `Expr`** | :222,247,250 |
| `clause` | `case-lambda` | 一条形参表 + 元数 + 体。**它是另一格 sort（`CaseLambdaClause`）** | :264-265 |

判据对上了：这 7 格**出端口只被一个宿主消费，且没有自己的 `region`** ——
正是 `node-graph-contract.md` §2.1 那条判据的形状。删 `profile`，图照样连着；
删 `call`，挂在它上面的 `preinfo` 无处可挂。**依赖只有这一种。**

## 四、分层 · 组合 · 依赖

只许两种关系：`requires cap` 与 `attached-to 宿主`。

```
requires（骨架 → 能力，无方向性依赖，只有能力名）
  pr                 → primitive
  ref / set!         → bind
  letrec / letrec*   → bind, region
  if                 → branch
  case-lambda        → callable
  call               → indirect-call
  record 族          → record, layout
  foreign/fcallable  → foreign-call
  vector-family      → array
  box-datum          → cell
  numeric-tower      → number-tower
  datum-label        → graph-literal

attached-to（真依赖，删宿主必须连带删）
  preinfo   → call, case-lambda
  clause    → case-lambda
  pariah / profile / cte-optimization-loc / immutable-* / moi / cpvalid-defer → 各自的宿主
```

**这一节要证明的三句话（chez 上全部成立）：**

1. **删光所有类型，`record` 还在。** `Lsrc` 里没有类型层 —— `Ltype`（:229）只在
   `foreign` 那两格出现，是**外部调用的签名**，不是语言的类型系统。
   于是"删掉一个类型，class 崩不崩"在 chez 上有最干脆的答案：Scheme 连类型都没有，
   记录照样是记录。**假依赖 `type→expr→stmt→func→class` 在这门语言上直接不成立。**
2. **没有 `expr` 这个语法类。** 语法只有 `program` / `data` / `datum` / `list` / `abbrev`
   五格（chez.grammar），`Expr` 是 `Lsrc` 那一侧的概念。
   —— `sort` 是节点声明的一栏，不是语言必须有的语法概念。
3. **`seq` 不是依赖，是次序。** 见 §3.2 第 1 条。

## 五、优先级和顺序

按"能压出公共机器的先做"：

1. **`bind` + `region`**（`ref` / `set!` / `letrec*`）—— 十门语言全要，且它是
   ADR-0029 那张作用域图的直接消费者。chez 上最干净：没有类型、没有可见性修饰，
   `letrec*` 就是一格 region + 一组绑定。
2. **`callable` + `indirect-call`**（`case-lambda` / `clause` / `call`）——
   顺手把"元数分派是附属不是节点"这条钉下来（§3.2 第 2 条）。
3. **`branch`**（`if` 的 `lazy` 入端口）—— 这是 `lazy` 求值语义的最小验证场。
4. **`record` 族** —— 五格一起，验 `layout` 能力与"删光类型不影响 record"（§4 第 1 句）。
5. **`const` / `array` / `cell` / `number-tower`** —— 字面量那一摊，附带 `sx` 序列化。
6. **`foreign` / `fcallable`** —— 与 `node-graph-contract.md` §8（信息保留到 native）
   同一格。chez 的 `(conv* …)` + 参数类型表是那一节最现成的语料。
7. **`macro`（消去规则引擎自身）** —— 排最后，因为它要的是前六格都稳。
   这一格做成了，`syntax-rules` 就是"用户可写的特性"，是这份架子最重的一次验证。
8. **`call/cc`** —— 刻意排在 `macro` 之后：它落在 `suspends` 那台公共续延机器上
   （与 go 的 channel、mojo 的 await、freebasic 的 gosub 同一台），
   所以它该在**有第二门语言一起验**的时候做，不该在 chez 上单独做。

## 六、明说的不足（不猜）

1. **语法侧四笔已记在 `chez.grammar:21-25`**：`#\x41;` 那种带分号的转义值、`1+`
   这类"数字开头的符号"会切成两格、`#{gensym}` / `#[record]` 内部不细分、
   `|\x41;|` 的转义留在记号文本里。四笔都是**值那一层**的账，不是语法的账。
2. **括号不较真**：`(` 与 `[` 在我们的语法里等价，不检查配对（chez.grammar:127-128）。
   R6RS 要求配对。收益只是一句更准的错话，代价是语法里每种括号写两遍 —— 现在不换。
3. **`Lsrc` 之上那一层没读完**：从 datum 到 `Lsrc` 之间是 `s/syntax.ss`（10559 行）
   那台展开器。这份规格**只抄了它的输出**（`Lsrc`），没有抄它本身。
   宏那一格（§5 第 7 项）真做的时候要回来补这一节。
4. **线程与 engine 没进表**：`csug/threads.stex` 那一族（`fork-thread` / mutex /
   condition）与 engine（可抢占的定量执行）都还没读。它们会落到
   `node-graph-contract.md` §7 的第 2/3 层，**不会新增节点**——这是预期，不是结论。
5. **数值塔只到词法**：`1/2` 与 `+inf.0` 切得对，但"精确有理数怎么算"是 `number-tower`
   能力的提供者的事，chez 这一门会把这格能力顶到最难（bignum / ratnum / flonum 四层）。
   现在只记账，不开工。
