# awk —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

## 一、为了什么

**awk 进来压的是 pipeline 那一问，而且它压的是最狠的一种：整个程序就是一条流水线。**

一份 awk 程序不是"从 main 开始",是一张**模式—动作表** + 一台**隐式主循环**：
读一条记录 → 切成字段 → 拿每条模式过一遍 → 匹配上的动作跑一遍 → 下一条。
`node-graph-contract.md` §9(a) 说"语言里的管道不给新节点，它是若干节点 + 一条效应链" ——
awk 是那句话的极端考题：**这台主循环本身要不要一格节点？**

这份规格给的答案是**要，一格 `record-loop`，而且只有它一格**。理由在 §3.2 第 1 条。

另外三格 awk 独有的压力：

1. **值只有一种，但它同时是串和数**（POSIX 的 `strnum`）。未初始化的变量既是 `""` 又是 `0`，
   `"10" < "9"` 与 `10 < 9` 结果不同 —— 比较的语义**取决于两边的来历**。
   这是 `truthiness` 那格能力之外的第二格"不产生代码但改语义"的附属。
2. **复合结构只有关联数组**（比 lua 还少：lua 的 table 至少能当数组，awk 的下标一律转成串
   —— `a[1]` 与 `a["1"]` 是同一格）。
3. **函数没有局部变量**，只有形参（多写几个形参当局部量是公认写法）。
   `region` 那一栏在这门语言上是**空的** —— 这是"删掉一格东西图还连得起来"的极端证据。

## 二、需要什么内容

- **官方规格**：**POSIX.1（IEEE Std 1003.1）的 awk 一节** —— 语法、算子优先级、
  `strnum` 那套比较规则、内建变量表（`NR` / `NF` / `FS` / `OFS` / `RS` / `ORS` / `SUBSEP` …）、
  `getline` 的六种形状、`printf` 的转换说明。**一张表就能放心** —— awk 的规格比 lua 还短。
- **参考实现**：gawk 那棵树只当**语料**用。`ext/awk/bench.json` 与 `awk.grammar:4-8`
  写着这条纪律：**语法照 POSIX 那份公开语法写，刻意不从 gawk 的 `awkgram.y` 派生**
  （那份是 GPLv3，本仓库是 MIT）。这份规格照同一条线：**不抄 gawk 的内部结构**，
  只用它的 `.awk` 语料量对错。
- **我们自己量出来的两份材料**（比任何文档都贵）：
  - `awk.grammar:426-460` 那条曲线 —— 八刀，从 33/702 到 625/702，每刀一个数字。
    两句结论：降冲突的不是建表器（LALR 值 34 处），是把歧义从"靠优先级压"改成"写进语法"
    （级联 + 右递归两刀值 513 处）；只有空白能分的事一定在词法层（`f(x)` vs `f (x)` 值 102 份）。
  - `bench.json` 的 `invalid` 那两格与 `invalidDoc` —— 为什么只有两份算坏例
    （拿 gawk 的 `.ok` 文件逐个对过 57 份没过的）。
- **语料与现状**：gawk 树里的 `.awk`，量出来 **645/700（92%）**，坏例 2 份单列。
  `awk.grammar` 165 条产生式 / 346 状态。

## 三、原子化特性表

### 3.1 记录与字段（这一门的心脏）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `record-loop` | 隐式主循环：读一条记录、切字段、过模式表 | `record-loop`（新，见 §3.2） | POSIX "Overall Program Structure" |
| `pattern-action` | `模式 { 动作 }`；模式可以是表达式、`/re/`、`范围1,范围2`、`BEGIN`、`END` | `record-loop` 的一格附属 | awk.grammar 的 `item` 那一族 |
| `field` | `$0` 整条、`$i` 第 i 格。**`$i = x` 会重建 `$0`，`$0 = x` 会重切字段** | `field-view` | awk.grammar:403 |
| `NF-assign` | 给 `NF` 赋值会截断/扩展 `$0` | `field-view` | POSIX 内建变量一节 |
| `builtin-var` | `NR`/`NF`/`FS`/`OFS`/`RS`/`ORS`/`SUBSEP`/`RSTART`/`RLENGTH`/`FILENAME` | `bind`（全局，且**部分是双向的**） | POSIX 内建变量表 |
| `getline` | 六种形状：光身、`getline v`、`getline < f`、`getline v < f`、`cmd \| getline`、`cmd \| getline v` | `record-loop` + `suspends`? | awk.grammar:415-420 |
| `print-redirect` | `print > f`、`print >> f`、`print \| cmd`；`printf` 同 | 外部 IO（`reads`/`writes` 效应） | awk.grammar 的 print 那一段 |
| `coprocess` | gawk 的 `\|&` 双向管道 | `suspends` + 外部 IO | awk.grammar（已收，语料 12 份那一批） |

**`field-view` 是这门语言送给节点清单的一格新东西。** 它不是数组下标：
`$0` 与 `$1..$NF` 是**同一格存储的两种视图**，改一边另一边跟着变。
在五栏声明里它的形状是：一格 `lvalue` 入端口 + `reads`/`writes` 同时挂在**同一格存储**上。
—— 十门语言里只有 awk 一家要，所以按 ADR-0033 §5 的纪律它**不是能力**，
是 awk 的内部事；但它是一格**真节点**（`field` / `field-set`），因为图上要看得见那条依赖。

### 3.2 主循环到底是一格节点还是一条效应链

这是这份规格唯一一处需要下判断的地方，把两种写法都摆出来：

**写法 A（不给节点）**：主循环降成 `loop-region` + `branch` 一串。
代价：每份 awk 程序的降级都要把"读记录 / 切字段 / 过模式表 / `next` / `nextfile` / `exit`"
这五件事各拼一遍 —— 而它们**在所有 awk 程序里一模一样**。这正是
`node-graph-contract.md` §4 判高级节点的那条标准（"不给节点就要在每门语言的降级里各写一遍"）。

**写法 B（给一格 `record-loop`）**：一格骨架节点，端口三格
（输入源 / 模式—动作表 / 输出流），效应 `reads writes`，
`next` / `nextfile` 落在 `may-early-exit`，`exit` 落在"跳到 END 段"。

**结论：B。** 但要付 §4 那条规矩的账 —— 它必须有一条消去规则，右手边只用
`loop-region` + `branch` + 外部 IO，而且**那条规则只写一遍**。
于是任何后端不认识 `record-loop` 都不影响正确性。

**提供者只有 awk 一家，所以 `record-loop` 不算能力。** 它是"高级节点"那一类
（§4 的第二条判据"提供者 ≥ 2 门语言"没过）—— **这是十份规格里第一处例外**，
理由写死在这儿：它换来的是"整门语言的降级少写五件事"，而不是一门语言的一格糖。
如果后面 sed / perl 那一档不进来，这一格永远只有一个提供者，那它就是 awk 的内部事，
**放在 `ext/awk/` 底下，不进公共节点清单。**

### 3.3 值、算子、语句

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `strnum` | 一格值同时是串与数；比较看两边的**来历**（字段/getline/ARGV 来的是 strnum） | `truthiness` + `numeric-string`（附属） | POSIX 比较规则一节 |
| `uninit` | 未初始化 = `""` = `0`，且**取用即存在**（`a[i]` 一读就建） | `nullable` | POSIX |
| `array` | 只有关联数组；下标一律转串（多下标用 `SUBSEP` 连） | `dict` | awk.grammar:402 |
| `subs`（`a[i][j]`） | gawk 的数组的数组 | `dict` | awk.grammar（已收） |
| `in` / `delete` | 成员测试（含 `(i,j) in a`）、删一格或整张 | `dict` | awk.grammar:406 |
| `concat` | **连接没有算符** —— 两个表达式挨着就是连接 | `bytes` | 级联里的 `cat` 那一级 |
| `dyn-regex` | `x ~ y` 里的 `y` 是**运行期**编译的正则 | `regex` | POSIX |
| `re-literal` | `/re/` 字面量；单独出现时等于 `$0 ~ /re/` | `regex` | awk.grammar:400 |
| `typed-regex` | gawk 的 `@/re/` —— 把正则当值 | `regex` | awk.grammar:411 |
| `func` | 用户函数；**数组按引用传、标量按值传** | `callable` | awk.grammar |
| `icall` | gawk 的 `@f(…)` 间接调用 | `indirect-call` | awk.grammar:412 |
| `next` / `nextfile` / `exit` | 三种跳出主循环的方式 | `may-early-exit` 效应 | awk.grammar |
| `switch` | gawk 的 switch | `branch` | awk.grammar（已收） |
| `do-while` / `while` / `for` / `for-in` | 四种循环 | `loop-region` | awk.grammar |

三条要记下的：

1. **`concat` 没有算符**，所以它在语法上是"两个表达式挨着"，在图上是一格普通的
   二元节点。这一格是"语法难 ≠ 节点多"的最干净例子：它值了 awk 语法侧一整刀
   （`awk.grammar:432` 那条级联），但**节点清单上它只是一格 `bytes` 算子**。
2. **`strnum` 是附属**：它不产生代码，只改 `cmp` 那个节点的解释 —— 与 lua 的
   `truthiness` 同一族（挂在节点上、不产生代码、每门语言答案不同）。
   `numeric-string` 这格附属**必须跟着值走**（"来历"是值的性质），
   所以它不是挂在节点上，是**挂在一条 `value` 边上** —— 与 sbcl 的 `cast`
   （挂在 `lvar` 上）同一个位置。**两门语言独立指向同一个结论。**
3. **数组按引用传、标量按值传**：一格 `callable` 上的附属（每个形参一格
   `borrow` / `consume` 的差别）—— 正是 ADR-0033 §3.2 `lifetime` 那栏的内容，
   不新增节点。

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  record-loop           → record-loop（只有 awk 一家，见 §3.2 的例外说明）
  field / field-set     → field-view（同上，awk 内部）
  array / in / delete   → dict
  concat                → bytes
  re-literal / dyn-regex → regex
  func / icall          → callable, indirect-call
  while/for/do/for-in   → loop-region, branch
  switch / if           → branch（+ truthiness）
  print / printf / getline → 外部 IO（reads/writes 效应）
  coprocess（|&）        → suspends, 外部 IO

attached-to（真依赖）
  pattern-action        → record-loop
  BEGIN / END           → record-loop（它们是模式表里的两格特例）
  strnum / numeric-string → 一条 value 边（值的"来历"）
  truthiness            → branch
  builtin-var 的双向性   → bind（NF/$0 那一对）
  形参的按引用/按值      → callable（lifetime 栏）
```

**这一节要证明的三句话：**

1. **`region` 那一栏可以是空的。** awk 的函数没有局部变量，`{}` 也不开新作用域 ——
   全部名字是全局的（形参除外）。所以"删掉 `region`，图还连得起来吗"在这门语言上
   **是肯定的**：awk 就是那门没有 `region` 的语言。
   —— 这是十份规格里对"假依赖"最强的一击：连**作用域**都不是必需的。
2. **删光类型，`dict` 还在。** awk 连类型概念都没有（`strnum` 是值的来历，不是类型）。
3. **`BEGIN` / `END` 不是骨架。** 它们是模式表里的两格特例（"在第一条记录之前 / 最后一条
   之后匹配"）。删掉它们，`record-loop` 一个字不用改。而删掉 `record-loop`，
   它们无处可挂 —— 附属的标准形状。

## 五、优先级和顺序

1. **`field-view` + `record-loop`** —— 排第一，但**只在 `ext/awk/` 里做**。
   它是"一门语言可以有自己的节点，只要有一条消去规则"这条纪律的第一次落地
   （`node-graph-contract.md` §4）。做成了它，就证明了公共节点清单**不必**为每门语言的
   独有形状让步。
2. **`dict`** —— 与 lua 的 `table` 对账（那边一个提供者答三格能力，这边只答一格）。
   `dict` 得到第二个提供者，能力身份成立。
3. **`nullable` + `uninit`（取用即存在）** —— 这一格与 lua 的 `nil`、go 的零值三门对账。
   awk 最激进（读一格就建一格），所以它定上界。
4. **`strnum` 那格边上的附属** —— 与 sbcl 的 `cast` 同一个挂点（§3.3 第 2 条）。
   两门语言独立指向同一结论，是最便宜的一次验证。
5. **外部 IO（`print` 重定向 / `getline`）** —— 与 `node-graph-contract.md` §8 的
   `net` 那一格同一族（图上只有签名 + 效应，走 `host/native.js` 那道封闭 ABI）。
6. **`regex`** —— 排这么后是因为它对图没有新要求（一格带 `reads` 的调用），
   但对**方言承载力**（ADR-0031）有：正则引擎是方言要不要自带的一格大账。
7. **`coprocess`（`|&`）** —— 最后。它落在 `suspends`，与 go 的 channel 一起做。

## 六、明说的不足（不猜）

1. **语法侧三笔已记在 `awk.grammar:20-26`**：`print a > b` 一律当重定向、
   正则里的计数区间 `{n,m}` 不收（**词法 DSL 的边界，不是语法的**）、
   空语句与 `for (print 9; 0;)` 不收。
2. **645/700，剩下 55 份**：`awk.grammar:457-460` 写着最大的一类只有 6 份。
   坏例已经单列（2 份，`bench.json` 的 `invalid`）。
3. **`getline` 到底要不要 `suspends` 没定**（§3.1 那格能力栏写着问号）。
   `cmd | getline` 要等外部进程出一行 —— 在 native 上是阻塞读，在 js/wasm 上
   **只能是挂起**。所以它可能是 `suspends` 的一个提供者，也可能是"阻塞的外部调用"
   这一格。**这一条要等 wasm 后端的答卷（§10 那一步）才有答案**，现在不猜。
4. **`printf` 的转换说明没进表**：它是一格格式串的运行期解释，不是语言结构。
   但它与 `node-graph-contract.md` §5.2 里提到的 `$fN` 临时量那笔账有关
   （jnc 那边的 printf 中间量），做临时量物化的时候要回来看一眼。
5. **本地化与多字节**（`FS` 的字符类、`length` 数的是字节还是字符）完全没读。
   gawk 与 POSIX 在这一格有差别，语料里有几份专门测它。记账，不猜。
6. **`SUBSEP` 拼多下标**是 awk 把多维数组做成一维的办法。它意味着
   `a[i,j]` 与 `a[i SUBSEP j]` **是同一格** —— 这一条在图上是一次显式的串拼接，
   不是 `dict` 的多键支持。别把它并进 go 的 map。
