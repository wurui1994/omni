# cpp —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

**这一门排最后，理由在 §一末。** 语法侧现在只有 **16/351**，是十门里最低的 ——
但规格照写：规格问的是"这门语言要什么"，不是"我们收了多少"。

## 一、为了什么

**cpp 进来是当**上界**用的：几乎每一格能力，它都给出最难的那个提供者。**

一条一条对：`record`（多重继承 + 虚基类）、`dispatch`（虚表 + RTTI + 多重继承下的
this 调整）、`scope-exit`（RAII，**没有 GC 兜底**）、`monomorphize`（模板两阶段 +
SFINAE + 偏特化）、`may-early-exit`（异常 + 栈展开）、`ptr`（指针算术 + 引用 +
右值引用）、`raw-union`、`text-stage`（预处理）、`stage`（`constexpr` / `consteval` /
`if constexpr`）、`suspends`（`co_await` / `co_yield` / `co_return`）、
`overload`（**ADL + 重载决议**，十门里最复杂的一台择优器）。

**它独有的、别的九门都给不了的一格：`value category`（值类别）。**
C++ 把"一个表达式的结果是什么"分成 lvalue / xvalue / prvalue 三类
（外加 glvalue / rvalue 两个并集），而且**这套分类直接决定"能不能取址、能不能移动、
要不要物化临时量"**。

ADR-0033 §3.2 的入端口有四种求值语义（`value` 要值 / `lvalue` 要位置 /
`lazy` 可能不算 / `name` 只要名字），§3.5 第 2 条列了临时量物化的四条判据。
**C++ 的值类别就是那两格的完整版**：prvalue 的"物化"（materialization）
在标准里是一个有名字的操作。**这门语言是那两格设计的唯一权威对照。**

**为什么排最后**：它对每一格能力都是上界，所以先做它等于把每台机器都按最难的做一遍；
而按 ADR-0033 §9 的路子，机器要先在最便宜的语料上跑通（chez 135/135、
go 8114/8218），再上压测。**顺序错了会把成本翻几倍。**

## 二、需要什么内容

- **官方规格**：C++ 标准工作草案（N4XXX 系列）。与节点有关的章节，按重要性：
  - **[basic.lval] 值类别** —— §一那一格。
  - **[expr] 表达式**（含 [expr.call] 求值次序、[expr.prim.lambda]）。
  - **[class] 类**（含 [class.mi] 多重继承、[class.virtual]、[class.ctor]/[class.dtor]）。
  - **[temp] 模板**（两阶段查名、[temp.deduct] 推导、[temp.spec] 特化）。
  - **[over] 重载决议**（+ [basic.lookup.argdep] ADL）。
  - **[except] 异常**、**[dcl.init] 初始化**（十几种形式）、
    **[expr.const] 常量表达式**、**[dcl.attr] 属性**、**[coroutine]**。
  - **[cpp] 预处理** —— 与 freebasic 的 `#define` 同一格 `text-stage`。
- **参考树里的材料**：
  - **`cpp-grammars/`** —— 这是个宝库：`c++11/14/17/20/23.ebnf` 五份标准语法的机读版，
    加上 `c99/c11/c17/c23.ebnf`（C 那条线）、`cfront1/2/3.ebnf`（**C++ 最早三版的语法** ——
    可以看这门语言是怎么长起来的）、`g++-3.3.6.ebnf`、`elsa-cc.gr.ebnf`、
    `open-watcom-v2.ebnf`、`cppfront.ebnf` / `carbon-lang.ebnf`（两门"C++ 的继任者"）。
    我们的 `.ebnf` 导入器（`src/core/glr/ebnf.js`）能直接建表，所以**这些都是现成的尺子**。
  - `tinycc`（C 那条线的小实现）、`asymptote`（语料，523 份真实 `.cc`）。
- **我们自己量出来的**：`cpp.grammar` 430 条产生式，文件头那三条**结构性**限制
  （不是"少写了几条产生式"，是这门语言的性质）：
  1. **C++ 的语法定义在预处理之后的记号流上** —— 宏生成的声明我们收不住。
  2. **"声明还是表达式"要符号表**（`T * x;`）—— 缺的不是产生式，
     是**驱动器能回问一句"这个名字是类型吗"**（与 nim 那份的"列号谓词"同一类缺口，
     都在 `driver.js` 那一层）。
  3. **`<` `>` 既是模板括号又是比较** —— 同上。
- **语料与现状**：asymptote 树里的 `.cc`。量出来 **16/351** ——
  原因就是上面三条，不是产生式不够。

## 三、原子化特性表

### 3.1 值类别与初始化（这一门的第一格独有物）

| 特性 | 一句话 | 对应五栏的哪一格 | 出处 |
| --- | --- | --- | --- |
| lvalue | 有身份、不可移动 | 入端口 `lvalue`（要位置） | [basic.lval] |
| xvalue | 有身份、可移动 | 入端口 `consume` + `lvalue` | [basic.lval] |
| prvalue | 无身份、可移动；**用到才物化** | 入端口 `value`，**且物化是显式的一步** | [basic.lval] |
| 临时量物化 | prvalue → xvalue 的那一步有名字 | **= ADR-0033 §3.5 第 2 条** | [conv.rval] |
| 生命期延长 | 绑到 `const&` 的临时量活到引用结束 | `lifetime: borrows(k)` **+ 一条延长规则** | [class.temporary] |
| 移动语义 | `T&&` / `std::move` / 移动构造 | 入端口 `consume` | [class.copy] |
| 拷贝省略 / RVO | **标准规定的**省略（C++17 起 prvalue 不产生拷贝） | 调度器的一格优化，**不是语言特性** | [class.copy.elision] |
| 十几种初始化 | 默认 / 值 / 直接 / 拷贝 / 列表 / 聚合 / 委托 … | 一格 `init` 节点 + **附属：哪一种** | [dcl.init] |

**三条要写进契约的结论：**

1. **"临时量物化"必须是图上显式的一步。** C++ 给了它一个名字与一条规则
   —— 我们的调度器已经在做这件事（ADR-0033 §3.5 第 2 条的四条判据），
   但**判据要与 C++ 的对齐**：C++ 的四种触发（取址、绑引用、调成员、访问成员）
   与我们的四条（被 effect 边隔开、用两次以上、跨早退、`owns` 遇 `borrow`）
   **不是同一组** —— 这一格要在实现时逐条对，不是"差不多"。
2. **生命期延长是 `lifetime` 栏的第五种情况。** mojo 给了四种
   （`owns`/`borrows`/`static`/`untracked`，见 `ext/mojo/SPEC.md` §3.1 第 2 条），
   C++ 的"临时量绑到 const& 就活到引用结束"是第五种：
   **借的一方能改变被借者的寿命**。这与 mojo 的第三条规则
   （"若有引用存在，延长所有者的寿命"）是同一件事的两种说法 ——
   **两门语言合起来，这一格才算有据。**
3. **拷贝省略不是语言特性，是调度器的事。** C++17 把它写进标准正是因为
   "不省略就得写拷贝构造" —— 在我们这儿，prvalue 直接接到消费者的入端口上，
   本来就没有那次拷贝。**这一格的正确做法是什么都不做。**

### 3.2 模板与编译期（第二格独有物）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `template` | 类 / 函数 / 变量 / 别名模板 | `monomorphize` | [temp] |
| 两阶段查名 | 模板定义时查非依赖名，实例化时查依赖名 | `monomorphize` + **一格"依赖名"规则** | [temp.res] |
| 模板实参推导 | 从实参反推模板参数 | **一格求解器**（不是节点） | [temp.deduct] |
| 偏特化 / 全特化 | 按模式挑一个定义 | `overload` 的另一种用法 | [temp.spec] |
| SFINAE / `requires` | 替换失败不算错 / 概念约束 | 同上（择优器的侧条件） | [temp.deduct] / [temp.constr] |
| `constexpr` / `consteval` | 编译期求值 / 必须编译期 | `stage` | [expr.const] |
| `if constexpr` | 编译期分支（**不取的那支不实例化**） | `stage` + `branch` | [stmt.if] |
| 变参模板 / 折叠表达式 | `Ts...` / `(args + ...)` | `monomorphize` 的附属 | [temp.variadic] |
| 预处理 | `#define` / `#include` / `#if` / `#pragma` | **`text-stage`（不进图）** | [cpp] |

**`text-stage` 现在可以定了**：两个提供者（freebasic 的 `#define`/`#macro`、
cpp 的预处理），过 ADR-0033 §5 的门槛。**它是能力，而且明确不进图** ——
它在读树之前就消掉了（`ext/freebasic/SPEC.md` §3.4 已经写下这条口径）。

**`constexpr` 与 `graph.eval` 是同一件事**（与 mojo 的 comptime 同结论，
`ext/mojo/SPEC.md` §五第 6 项）：编译期求值就是拿同一张图跑同一台 eval。
C++ 这边最能压这一条 —— `constexpr` 函数里几乎整门语言都能用。

### 3.3 类、派发、异常（上界那一族）

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `class` / `struct` | 字段 + 访问控制 + 成员函数 | `record` + `layout` | [class] |
| 多重继承 / 虚基类 | 一格对象里有多个基类子对象；虚基类只有一份 | **`layout` 最难的提供者** | [class.mi] |
| `virtual` / RTTI | 虚表 + `dynamic_cast` + `typeid` | `dispatch` + **一格运行期类型信息** | [class.virtual] |
| 抽象类 / 纯虚 | 不能实例化 | `dispatch` 的附属 | [class.abstract] |
| 构造 / 析构 / RAII | 构造次序、析构逆序、成员初始化表 | `scope-exit`（**没有 GC 兜底**） | [class.ctor]/[class.dtor] |
| 五法则（拷贝/移动/析构） | 拷贝构造 / 拷贝赋值 / 移动构造 / 移动赋值 / 析构 | `lifetime` 栏的动作表 | [class.copy] |
| 运算符重载 | 含 `operator()`/`[]`/`->`/转换算符/`<=>` | `overload`（已落） | [over.oper] |
| ADL | 按实参的命名空间找函数 | **一格求解器** | [basic.lookup.argdep] |
| 重载决议 | 转换序列的偏序 + 模板 vs 非模板 | 同上，**十门里最复杂** | [over.match] |
| 异常 | `throw` / `try` / `catch` / `noexcept` / 栈展开 | `may-early-exit` + `scope-exit` | [except] |
| `raw-union` | 无标记共用体（+ 活跃成员的规矩） | **`raw-union` 第二个提供者** | [class.union] |
| 引用 / 右值引用 | `T&` / `T&&`（**不是指针**） | `ptr` + `lifetime` | [dcl.ref] |
| 指针算术 / `void*` | 按元素宽度走 / 无类型 | `ptr` | [expr.add] |
| lambda + 捕获 | `[x, &y](){}` —— 捕获方式写在语法里 | `callable` + `region` + `lifetime` | [expr.prim.lambda] |
| 协程 | `co_await` / `co_yield` / `co_return` + promise 类型 | `suspends` | [coroutine] |
| 属性 | `[[nodiscard]]` / `[[likely]]` / … | **附属节点** | [dcl.attr] |
| 模块 | `import` / `export module`（C++20） | 与 `text-stage` 对立的一格 | [module] |

**两条要记下的：**

1. **`raw-union` 与 `text-stage` 各得第二个提供者**（另一家都是 freebasic）。
   这两格能力的身份到此成立 —— **而且两家都不是"现代"语言**，
   说明能力清单不该只看新语言。
2. **lambda 的捕获方式写在语法里**（`[x]` 按值 / `[&y]` 按引用 / `[=]` / `[&]` /
   `[this]` / `[x = expr]`）。这是十门里**唯一**把 `lifetime` 栏的
   `borrow` / `consume` 写在**闭包**上的语言（别的语言写在形参上）。
   go 的闭包一律按引用捕获、lua 的 upvalue 也是 —— **cpp 定这一格的上界。**

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  class / struct            → record, layout
  多重继承 / 虚基类           → layout（最难的提供者）
  virtual / dynamic_cast     → dispatch（+ 运行期类型信息）
  ctor / dtor / RAII         → scope-exit
  运算符重载 / ADL / 重载决议   → overload（+ 两个求解器）
  template / if constexpr    → monomorphize, stage
  constexpr / consteval      → stage（= graph.eval）
  throw / try / catch        → （may-early-exit 效应）+ scope-exit
  union                      → raw-union
  引用 / 右值引用 / 指针算术    → ptr
  lambda                     → callable, region
  co_await / co_yield        → suspends
  预处理                      → text-stage（**不进图**）
  模块                        → 一格独立的名字来源

attached-to（真依赖）
  值类别（lvalue/xvalue/prvalue） → 一条 value 边（= 入端口的求值语义）
  初始化的十几种形式             → 一格 init
  cv 限定（const/volatile）      → 一格类型
  访问控制（public/protected/private） → 一格成员（只检查）
  [[attributes]]                → 任何声明 / 语句
  noexcept                      → 一格 callable 的效应签名
  lambda 的捕获表                → 一格 lambda（= lifetime 栏）
  模板实参推导 / SFINAE           → **不是节点，是求解器的侧条件**
  拷贝省略                       → **什么都不是**（调度器的事）
```

**这一节要证明的三句话：**

1. **删掉异常，`scope-exit` 不崩**（`-fno-exceptions` 就是那门语言，而且真有人用）。
   与 sbcl / nim 的同一条结论第三次独立成立。
2. **删掉模板，类还在**（那是 C with classes，即 `cfront1.ebnf` 那门语言 ——
   **参考树里有它的语法**）。这是 ADR-0033 §4 那条可删除测试最漂亮的对照物：
   `cpp-grammars/` 里的 `cfront1/2/3.ebnf` 就是"这门语言删掉后来那些特性之后的样子"，
   **而且是可执行的**（我们的 `.ebnf` 导入器能直接建表）。
3. **值类别不是类型系统的一部分。** 一个表达式的类型与它的值类别是**两栏**
   （标准明文分开写）。—— 又一次说明"类型"在图上不是一层：
   它是端口的 sort，而值类别是**边的性质**。

## 五、优先级和顺序

**总原则：cpp 的每一格都排在同一格能力的第二/第三个提供者之后。** 具体：

1. **值类别 → 入端口求值语义 + 临时量物化判据**（§3.1）—— 这是 cpp
   **唯一该排在前面**的一格，因为它是那两格设计的权威对照，而且**不需要**
   先收得动 C++ 的语法（可以拿标准文本对账）。产出：四条物化判据逐条与
   [conv.rval]/[class.temporary] 对齐，对不上的每一处记一笔。
2. **生命期延长（`lifetime` 第五种情况）** —— 与 mojo 的第三条规则合起来定
   （§3.1 第 2 条）。
3. **`raw-union` / `text-stage` 两格能力定身份** —— 与 freebasic 对账，
   两家齐了就写进能力清单。
4. **`scope-exit` 的上界：RAII 没有 GC 兜底** —— 排在 sbcl/nim/go/lua/V/mojo/freebasic
   七家之后当压测。
5. **`stage` 的上界：`constexpr`** —— 与 mojo 的 comptime、nim 的 `template`、
   chez 的宏合起来验"编译期求值 = 同一台 eval"。
6. **`overload` 的上界：ADL + 重载决议** —— 这是**求解器**，不是节点
   （ADR-0033 §10 明写保留求解器）。做的时候只需回答一件事：
   规则里怎么以"副作用自由的查询"形式调它。
7. **`layout` 的上界：多重继承 + 虚基类** —— 与 freebasic 的 `Extends`、
   go 的嵌入合起来。
8. **协程** —— 与 go/lua/chez/nim/freebasic 那台续延机器一起，cpp 定上界
   （它的 promise 类型让用户能定制挂起行为 —— **那正是"suspends 效应可被处理"
   的意思**，ADR-0033 §8 借 Koka 那一条）。
9. **语法侧的三条结构性限制** —— 与语义侧并行推，但**它们要的是 `driver.js` 那层的
   机制**（"回问一句这个名字是类型吗"），不是这份规格能解决的。

## 六、明说的不足（不猜）

1. **语法侧 16/351**，三条原因已写在 `cpp.grammar` 文件头，而且都是**机制欠账**：
   不做预处理、判不了"声明还是表达式"、判不了 `<`/`>`。
   后两条要的是同一格机制：**驱动器在归约时能问一句"这个名字登记成类型了吗"**。
   与 nim 的"列号谓词"是同一类（都在 `driver.js`）——
   **两门语言指向同一格缺口，这比任何一门自己的欠账都值钱。**
2. **模块（C++20）与预处理的关系没读**。模块是为了替掉 `#include`，
   它在图上可能是"另一格名字来源"（ADR-0029 的作用域图那一层），
   而不是 `text-stage`。不猜。
3. **`volatile` 与内存序（`std::atomic`、memory_order）没读**。
   与 go 的 `go_mem.html`（`ext/go/SPEC.md` §六第 2 条）是**同一笔账**：
   **跨线程的次序在我们的图上现在没有表达方式。** 两门语言指到同一处，
   这笔账该单独立 ADR。
4. **异常的 ABI（栈展开表、`__cxa_*`）没读**。它决定 `may-early-exit`
   在 native 后端上的落法，与 `node-graph-contract.md` §10（wasm 的 asyncify /
   exception 提案）一起看。
5. **`dynamic_cast` / `typeid` 要运行期类型信息**，这是 `dispatch` 之外的一格东西
   （go 的类型 switch、V 的 sumtype 也要）。要不要单列一格能力
   （`runtime-type`）没定 —— 等第三个提供者。
6. **十几种初始化形式**（§3.1 末）只归成"一格 `init` + 附属"。
   这是**目前的判断**，没有量过；真做的时候要按 [dcl.init] 逐条看哪几种
   在图上真的不同。
7. **`asymptote` 那 523 份语料只用了 `.cc`**。`.h` 与模板密集的头文件没进语料，
   所以现在这 16/351 的分子分母都偏保守。
