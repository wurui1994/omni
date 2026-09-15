# freebasic —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

**这门语言的"规格"是它的手册（fbc 的 wiki / `fbdoc`）加上编译器本身**，没有标准文本。
下面凡是引参考实现的都给文件行号；凡是量出来的都写明。

## 一、为了什么

**freebasic 进来压三件事，全是别的九门给不了的。**

1. **`properties`（属性）第二个提供者。** `Property Get` / `Property Set` 是 BASIC 的
   一等语法。ADR-0033 §2.2 拿 `property` 当"能力而非依赖"的例子
   （"`property` 要的是 `record` 与 `callable`，**不是** `class`"），
   但那一格在 jnc 之外**一直只有一个提供者** —— freebasic 是第二个。
   按 §5 那条"至少两个提供者才配叫能力"的纪律，**这一门决定 `property` 到底算不算能力**。
2. **`gosub` / `goto` / `On Error` —— 结构化控制流之外的跳转。**
   ADR-0033 §7 已经点出：`gosub` 落到"一格状态机，与 `await` 切段同一份机器"。
   十门里只有这一门有真正的**任意跳转 + 返回**（`gosub` 会记返回点，
   参考实现专门有一份 `src/compiler/ast-gosub.bas`）。
   **它是那台续延机器的下限压测**：连"没有函数边界的返回"都能落，别的才算稳。
3. **定宽整数与三种字符串 —— 方言承载力那笔账的主语料。**
   `Byte`/`UByte`/`Short`/`Integer`/`LongInt`/`Single`/`Double` 是**定宽**的，
   字符串有 `String`（变长）/ `ZString`（C 串）/ `WString`（宽串）/ 定长三种。
   ADR-0031 那场"方言该不该有整数宽度"的争论，ADR-0033 §2.4 说有机械答案
   （"看规则右手边必须提到什么"）—— **freebasic 是那道题的出题人**。

第四格顺手的：**语句形状的语言，原子基本全共用**（ADR-0033 §7 的原话）。
这一门是"语法差得最远、节点差得最少"的证明。

## 二、需要什么内容

- **文档**：fbc 的手册（`fbc/doc/` 里是构建 wiki 的工具链，正文在线上）。
  与节点有关的章节：Variable Declarations（`Dim`/`Redim`/`Common`/`Shared`/`Static`）、
  User Defined Types（`Type`/`Union`/`Enum`/`Extends`）、
  Procedures（`Sub`/`Function`/`Byref`/`Byval`/`Overload`/`Cdecl`/`Stdcall`）、
  Object 那一族（`Constructor`/`Destructor`/`Property`/`Virtual`/`Abstract`/`Operator`），
  Control Flow（含 `Gosub`/`Return`/`On Error`/`Resume`）、
  Preprocessor（`#define`/`#macro`/`#include`/`#if`）。
- **参考实现里要读的三处**：
  - `src/compiler/ast.bi:12-75` —— **45 格 `AST_NODECLASS`**（含哨兵）。
    几处特别要看：`SCOPEBEGIN`/`SCOPEEND`/`SCOPE_BREAK`（**region 三件套**）、
    **`TYPEINI*` 七格**（初始化：`TYPEINI` / `_PAD` / `_ASSIGN` / `_CTORCALL` /
    `_CTORLIST` / `_SCOPEINI` / `_SCOPEEND`）、`BOUNDCHK`/`PTRCHK`（检查）、
    `MACRO`、`JMPTB`、`LOOP`（一格包装节点）。
  - `src/compiler/ast-gosub.bas` —— `gosub` 怎么落（§一第 2 条）。
  - `src/compiler/ast-node-conv.bas` + 隐式转换那张表 —— §3.3。
- **我们自己量出来的**（这一门的账最贵）：`freebasic.grammar` 411 条产生式 /
  269 处冲突，尾巴上那份"冲突排名"实验记录。**两条一般教训**已写在那儿：
  - **冲突排名指的是"往哪儿看"，不是"改哪一行"**：第 2 名（`function` 开头是例程头
    还是表达式）是真歧义，挪位置**冲突数一点没动、语料一份没变**；
    第 3 名（`.field` 摆在受限链的底上）挪一次值 **+80 份**。
  - `:` 有双重身份（语句分隔符 / 标签与段标记），**得在词法层分开**。
- **语料与现状**：fbc 树里的 `.bas` / `.bi`。量出来 **1063/1722（62%）**。
  最大一类是 53 份 `too many concurrent parses`（`:` 那一格已经动过一刀 —— 见 freebasic.grammar 尾巴第五刀）。
  **这门是十门里最难收的**，原因不在语法规模，在于 BASIC 有一大批**自带词序的语句**
  （`line … ,(x,y)-(x,y),c,bf`、`print #f, using "…";`、`get`/`put`/`draw`/`screen`/
  `window`/`view`/`palette`/`input`）—— 每条都是一小套自己的语法。

## 三、原子化特性表

### 3.1 属性与 OOP（第一格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `Property Get/Set` | 取存成对的成员 | **`property`（这一门是第二个提供者）** | 手册 Object |
| `Type … Extends` | 单继承 | `layout` 的一个提供者 | 手册 |
| `Virtual` / `Abstract` | 虚方法 / 纯虚 | `dispatch` | 手册 |
| `Constructor` / `Destructor` | 生 / 死 | `scope-exit`（动作侧） | `TYPEINI_CTORCALL` |
| `Operator` 重载 | 含 `Let` / `Cast` / `For`…`Next` 的重载 | `overload`（已有的择优器） | 手册 |
| `Declare` + `Overload` | 重载集 | `overload` | 手册 |
| `Type` / `Union` | 记录 / 共用体（**可嵌套**） | `record` + `layout` + `tagged-union`? | 手册 |
| `Field = n` / `Align` | 字段对齐 | `layout` 的一格附属 | 手册 |
| `Base()` / `Cast` | 调基类 / 显式转换 | `layout` / `conv` | 手册 |

**`property` 那一格现在可以定了**：两个提供者（jnc 的 `property`、freebasic 的
`Property Get/Set`），过 ADR-0033 §5 的门槛。**它是能力，不是某门语言的内部事。**
它要的是 `record` + `callable`，与 `class` 无关 —— 而 freebasic 的属性可以挂在
`Type` 上（不是 `Class`，这门语言没有 `class` 关键字），**这就把那条"不是 class"
从道理变成了语料**。

`Union` 那格能力标着问号：BASIC 的 `Union` 是**无标记**的（C 式），
而 nim 的 object 变体、V 的 sumtype 是**带标记**的。
按判据这是两格能力（`raw-union` / `tagged-union`），不是一格 —— cpp 那份会给
`raw-union` 第二个提供者。

### 3.2 跳转与控制流（第二格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `Goto` / 标签 | 任意跳转（函数内） | `may-early-exit` + **一格状态机** | 手册 |
| `Gosub` / `Return` | **跳过去、记返回点、跳回来** —— 没有函数边界 | **续延机器的下限** | `ast-gosub.bas` |
| `On Error` / `Resume` | 错误跳转（含 `Resume Next`） | `may-early-exit` | 手册 |
| `Exit For/Do/While/Sub/Function` | 带层数的跳出 | `may-early-exit` | 手册 |
| `Continue For/Do/While` | 带层数的继续 | `loop-region` | 手册 |
| `Select Case` | 分支，支持 `Case 1 To 5` / `Case Is > 3` | `branch` | 手册 |
| `For … Next Step` | 计数循环（步长可负、可 `Each`） | `loop-region` | 手册 |
| `Do … Loop` 六种写法 | `While`/`Until` × 头/尾 | `loop-region` | 手册 |
| `Scope … End Scope` | **显式的域** | `region` | `SCOPEBEGIN`/`SCOPEEND` |
| `With … End With` | 隐式成员：`.field` | **附属**（挂在 `with` 的宿主上） | 我们量出的 +80 份那一格 |

**`Scope` 那一格值得单独记**：这门语言把"开一格域"做成了**显式语句**，
而参考实现里对应三格节点（`SCOPEBEGIN` / `SCOPEEND` / `SCOPE_BREAK`）。
ADR-0033 §3.3 的 `region` 边正是这三格的一般化 —— **别人也需要"跳出域"这一格
（`SCOPE_BREAK`），说明 region 的出口不止一个，早退要能跨它。**
这一条要写进 `scope-exit` 那台机器的端口设计。

### 3.3 表示与转换（第三格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| 定宽整数 | `Byte`…`LongInt` 六格 + 无符号版 | **方言必须有"按宽度读写"** | 手册 Types |
| `Single` / `Double` | 两格浮点 | 同上 | 手册 |
| `String` / `ZString` / `WString` / 定长串 | **四种字符串表示** | `bytes` 的四个提供者 | 手册 |
| 隐式转换 | 一张**偏序表**（BASIC 转得比 C 还宽） | `conv` + 一格偏序表 | `ast-node-conv.bas` |
| 指针 + **指针算术** | `p + 1` 按元素宽度走 | `ptr`（**比 go 强**） | `AST_OPOPT_LPTRARITH` |
| `Any Ptr` | 无类型指针 | `ptr` 的 `untracked` 那一格 | 手册 |
| `Extern "C"` / `Cdecl` / `Stdcall` | 三种调用约定 | `foreign-call` | 手册 |
| `Varargs` | C 式变长实参 | `foreign-call` 的附属 | 手册 |
| 数组 | 定长 / **变长（`Redim`）** / 多维 / 自定义下界 | `array`（+ 一格"下界"附属） | `NIDXARRAY` |
| `BoundChk` / `PtrChk` | 越界 / 空指针检查（可开关） | **不产生语义的检查节点** | `ast.bi` |

**这一栏就是 ADR-0031 那笔账的答案来源。** 按 ADR-0033 §2.4 的机械判据
（"看规则右手边必须提到什么"）：freebasic 的 `Byte`/`Short`/`LongInt` 与
`ZString` 的降级规则**必须**提到"按宽度读写内存"，所以**方言必须有那一格**。
—— 这不是设计选择，是量出来的结论。**这份规格的最大产出就是这一句。**

### 3.4 预处理（与"宏"不是一回事）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `#define` / `#macro` | **记号级**替换（不是 AST 级） | `text-stage` | 手册 Preprocessor |
| `#include` / `#inclib` | 文本包含 | `text-stage` | 手册 |
| `#if` / `#ifdef` / `#else` | 条件编译（我们已收成 `pp-head`） | `text-stage` | freebasic.grammar 的 `pp-head` |
| `__FB_*__` 那一族 | 内建宏 | `text-stage` | 手册 |

**这一格必须与 nim / chez 的宏分开。** nim 的 `macro` 在 166 格 AST 上重写、
chez 的 `syntax-rules` 在 datum 上重写 —— 那些是 `stage`（编译期规则引擎，
= 我们的消去规则本身）。而 `#define` 是**记号流上的替换**，它可以造出
"半个表达式"（`#define BEGIN {`）。
**结论：`text-stage` 与 `stage` 是两格能力，且 `text-stage` 不该进图** ——
它在读树之前就消掉了，图上看不见。cpp 那份会给它第二个提供者，届时这一格
才算能力（现在两家：freebasic 与 cpp）。

### 3.5 自带词序的语句（这一门最大的量）

`Print` / `Print Using` / `Input` / `Line Input` / `Open` / `Close` / `Get` / `Put` /
`Draw` / `Screen` / `Window` / `View` / `Palette` / `Line` / `Circle` / `Paint` /
`Data` / `Read` / `Restore` / `Poke` / `Peek` …

**这一批在图上是什么：一格 `primitive`（= chez 的 `pr`、go 的 23 格内建）
外加外部 IO 的效应。零个新节点。**
它们的量全在**语法侧**（每条一小套词序），这正是这门语言覆盖率只有 60% 的原因。
—— **"语法难 ≠ 节点多"在这一门上是 1722 份语料级别的证据。**

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  Dim / Redim / Common / Shared / Static → bind（Redim 另要 array）
  Sub / Function / Declare      → callable（+ overload）
  Type / Union                  → record, layout（Union 要 raw-union）
  Property Get/Set              → property（→ record + callable）
  Virtual / Abstract            → dispatch
  Constructor / Destructor      → scope-exit
  Operator 重载                  → overload
  Select Case / If              → branch
  For / Do / While              → loop-region
  Scope / With                  → region
  Goto / Gosub / On Error / Exit → （may-early-exit 效应）+ 一格状态机
  指针 / 指针算术 / Any Ptr       → ptr
  Extern "C" / Cdecl / Varargs   → foreign-call
  定宽整数 / ZString / WString    → **方言的"按宽度读写"**
  自带词序的语句                  → primitive + 外部 IO

attached-to（真依赖）
  With 块里的 `.field`     → with 的宿主（我们量出 +80 份的那一格）
  Field = n / Align       → 一格 Type
  数组的下界               → 一格数组声明
  Byref / Byval           → 一格形参（= lifetime 栏的 borrow / consume）
  Cdecl / Stdcall / Overload → 一格例程声明
  BoundChk / PtrChk       → 一格下标或解引用（只检查）
  #define / #macro        → **不进图**（读树之前就消掉了）
```

**这一节要证明的三句话：**

1. **这门语言没有 `class`，`property` 与 `dispatch` 照样成立。**
   `Property` 挂在 `Type`（记录）上，`Virtual` 也挂在 `Type` 上。
   —— ADR-0033 §2.2 那句"`property` 要的不是 `class`"，在这一门上是**语料**，
   不是道理。与 mojo 那份"没有继承，`dispatch` 照样成立"（`ext/mojo/SPEC.md` §四第 1 条）
   合起来，**"class"这个概念在节点清单上彻底不存在了**。
2. **删掉所有 OOP，语言还完整。** freebasic 有 `-lang qb` / `fblite` / `fb` 三种方言，
   前两种基本没有 OOP —— **参考实现自己就提供了"删掉一族特性之后的完整语言"**，
   这是 ADR-0033 §4 那条可删除测试的现成对照物。
3. **`Scope` 证明 region 的出口不止一个。** `SCOPE_BREAK` 那格节点存在，
   说明"从域中间跳出去"是常态，`region` 边要能被早退跨过（§3.2 末）。

## 五、优先级和顺序

1. **方言的"按宽度读写"**（§3.3）—— 排第一，因为它是**唯一一格会改方言定义**的结论，
   而方言定义越晚改越贵（ADR-0031）。产出：一句话写进 ADR-0031 ——
   定宽整数与 `ZString` 的降级规则必须提到它，所以方言得有。
2. **`property`（两个提供者，能力身份成立）** —— 这一步是 ADR-0033 §5
   那条纪律的第一次**判定**（之前所有能力都是"看起来有两家"，这一格是数出来的）。
3. **`scope-exit` 的端口设计**：`Constructor`/`Destructor` + `Scope`/`SCOPE_BREAK`
   —— 与 nim 的七个钩子、mojo 的 `__deinit__`、sbcl 的 `cleanup`、go 的 `defer`、
   lua 的 `<close>`、V 的 `lock` **七家**对账。这台机器的语料到这儿就齐了。
4. **续延机器的下限：`Gosub`** —— 排在 go 的 channel / chez 的 `call/cc` 之后，
   **专门当压测**：如果那台机器收不下"没有函数边界的返回"，就是切段的粒度不对。
5. **`conv` 与隐式转换偏序表** —— 与 go 的 assignability/convertibility 两张表、
   cpp 的转换序列三家对账。**freebasic 转得最宽**，所以它定上界。
6. **`ptr` + 指针算术** —— 比 go 强（go 没有指针算术），与 cpp 同一档。
   这一格与 `node-graph-contract.md` §8 直接相关，和 cpp 一起做。
7. **`text-stage`（预处理）** —— 最后，且**明确不进图**（§3.4）。
   与 cpp 一起做，两家合起来这格能力才成立。

## 六、明说的不足（不猜）

1. **语法侧还欠 685 份**，三类都量了位置：53 份 `too many concurrent parses`
   （根是 `stmt -> simples term` 与 `simples -> simples ":" simple` 让 `a : b`
   有两棵树 —— **要动就得在词法层把 `:` 分成两种记号**）、48 份 `Line Input s` /
   `Option NoKeyword Int`（`line` 与 `input` 还不是关键字）、25 份 `Type<T>.root`
   与 `..field` 双点隐式成员。
   还有 35 份卡在"例程头里名字后面跟裸名字"（`freebasic.grammar` 尾巴记着
   试过一手、退回来了）。
2. **自带词序的语句只收了一部分**（§3.5）。收全它们不难，就是量大 ——
   这是明账，不是难题。
3. **三种方言（`-lang fb` / `fblite` / `qb`）的差别没读**。它对 ADR-0033 §4
   那条可删除测试**特别有价值**（§四第 2 条），但现在没量。
4. **`On Error` / `Resume Next` 的语义没读清**。`Resume Next` 是"从出错那句的下一句继续"
   —— 这要求错误点之后的**续延**能被存住，与 `suspends` 那格效应很像但不是同一件事。
   记账。
5. **`Operator For`…`Next` 重载**（自定义迭代）没读。它可能与 go 的 `range over func`、
   mojo 的迭代器协议同一格。不猜。
6. **`Union` 是无标记的**（§3.1 末），所以它与 `tagged-union` 是两格能力。
   这一条要等 cpp 那份给 `raw-union` 第二个提供者才能定。
7. **`Asm` 块**不进图（与 V 的 `AsmStmt`、mojo 的 `__mlir_op` 同一类：后端的事）。
