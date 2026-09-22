# 语言实验室（Lab 模式）

Omni Studio 的第四种模式。Omni 是一个语言平台（27 份语法文件、14 门语言、从词法到原生
二进制的全管线），而 Studio 到现在只有"用语言"的界面——没有**做语言**的界面。
Lab 补的是这一格。

> **语言实验室不是语法实验室。** 语法只是入口。语言的真正形状在语义层——
> 求值规则、类型规则、绑定规则、作用域规则、控制流规则、模块规则。
> Lab 要让这些规则**看得见**。

> _"Programs must be written for people to read, and only incidentally for machines to execute."_
> — Abelson & Sussman, SICP, 前言

## 0. 一句话

Lab 模式 = **语法编辑器 + 实时解析 + AST 可视化 + 管线探针 + 示例 REPL**——
让你在浏览器里从零写一门语言、实时看到它的每一层中间产物。

## 1. 为什么现在做

三件事凑在一起了：

1. **机制已经齐了**。`readGrammar` → `buildTable` → `glrParse` 整条链可 import、
   `omni glr-table` 与 `omni glr` 两个 CLI 动词把它露给脚本。
   `ext/tiny` 证明"写一门语言"只要四份文件、不到 300 行。
2. **展示 / IDE / 控制台三个模式做完了**。第四个模式用同一套版面机制加，
   不需要重写一行。
3. **这件事的对象不同**。前三个模式面向"写程序的人"；Lab 面向"做语言的人"，
   包括学生、PL 研究者、和我们自己——27 份 `.grammar` 文件里的每一条规则
   都应该有一种办法实时验证。

## 2. 设计原则

从 SICP、Racket、和我们自己踩过的坑里提取六条：

1. **所见即所得的语义**（SICP §4：元循环求值器）。改一条语法规则，立刻看到那条
   规则是不是有歧义、它解析出的树长什么样、降级后的核心方言是什么。不是"改→保存→
   命令行跑→看报错"——那是今天做语言的方式，延迟太长。
2. **管线是透明的**（Racket 的 macro stepper / DrRacket 的 Check Syntax）。
   从源码到运行，中间的每一层（词法→语法表→AST→OIR→MIR→SX→JS/C/Native）
   都可以停下来看。**每一层带语义标注**——不只是文本，还有类型、作用域、绑定点。
   这不只是教学——我们自己调 MIR 优化（mem2reg、尾返回内联）
   时最需要的就是"某一行对应到哪条 MIR 指令"。
3. **冲突是一等公民**（yacc/bison 的教训）。传统工具链里，shift/reduce 冲突是一行
   吓人的警告，初学者看不懂也不知道怎么修。Lab 要把每一条冲突**可视化**：
   在哪个状态、由哪两条规则引起、可以加什么优先级消除。
4. **增量实验**（Racket 的 `#lang` + PLT Redex 的 reduction semantics）。
   能从一门 5 行的算术语言开始，一条规则一条规则地加。`extends` 机制（
   我们的语法 DSL 已经有）让你在已有语言上做方言实验而不是从零写。
5. **判据是自带的**。每加一条规则、每改一种降级，旁边就有一组示例在跑。
   不是写完了再去加测试——测试就是界面的一部分。
   （这正是我们 `tests/cases` 那一千多份的精神：例子即判据。）
6. **语义层看得见**。语法只是入口——Lab 要展示求值规则（表达式怎么算）、
   类型规则（什么类型能加什么类型）、绑定规则（名字在哪一层声明、谁能看到它）、
   控制流规则（break 从哪一层出、defer 何时执行）、模块规则（import 做了什么）。
   管线面板的每一层带**语义标注**（类型、作用域深度、绑定点），不只是文本。
   Lab 还有一个"规则"面板，展示当前语言**生效的语义规则**（从 `sexpr/lower.js`
   在处理 `.sx` 时构建的内部表里序列化出来——不是手写的文档）。

## 3. 版面

```
┌──────────────────────────────────────────────────────────────┐
│ [展示] [IDE] [控制台] [▶ 实验室]                              │
├─────────────────────┬────────────────────────────────────────┤
│                     │  ┌─ 检查面板 ─────────────────────┐   │
│  语法编辑器          │  │ [表] [树] [管线] [示例]         │   │
│  (.grammar)         │  │                                │   │
│                     │  │  （按选中的 tab 切内容）         │   │
│  ─ ─ ─ ─ ─ ─ ─ ─   │  │                                │   │
│  示例源码            │  │                                │   │
│  （用这门语言写的）   │  │                                │   │
│                     │  │                                │   │
│                     │  └────────────────────────────────┘   │
└─────────────────────┴────────────────────────────────────────┘
```

**左栏**（编辑区）上下切两格：

- **上**：语法编辑器——编辑 `.grammar` 文件（S-expression 语法高亮）。
  这里的"文件"可以是项目里真有的 27 份之一，也可以是 scratch（新建）。
- **下**：示例源码——用上面那门语言写的一小段代码。每次上面或下面改了，
  右边实时更新。

**右栏**（检查面板）四个 tab：

### 3.1 表（Table）

`buildTable` 的产出：

- **状态数 / 记号数 / 非终结符数 / 冲突数** 四个数字，大字号，一眼看完。
- **冲突清单**（若有）：每一条冲突是一行卡片——
  - 状态编号
  - 涉及的两条规则（高亮到产生式）
  - 冲突类型（shift/reduce 或 reduce/reduce）
  - 建议：可以加 `(prec ...)` 消除吗？
  
  零冲突时这里是一格绿色的 ✓。

- **规则表**：所有产生式的紧凑列表（编号、LHS → RHS、优先级、关联性）。
  点一条规则高亮它在语法编辑器里的位置。

### 3.2 树（Tree）

示例源码的解析结果，两种视图切换：

- **树形**（默认）：把 `glrParse` 的结果画成嵌套的方块。
  `{kind:'list', tag, children}` 展成纵向嵌套，
  `{kind:'atom'}` 与 `{kind:'string'}` 是叶子。
  鼠标悬浮在节点上 → 示例源码里对应的字符范围高亮。
  鼠标悬浮在源码上 → 树里对应的节点高亮。**双向联动**。

- **S-expression**：解析树的文本表示（与 `omni glr` 的输出相同），
  带语法高亮。可复制。

错误时：红字写在树区域顶部，指向出错的位置。词法错误与语法错误区分开。

### 3.3 管线（Pipeline）

从源码到产物的**逐层 emit**。只在语法能编译（不只是解析）时激活——
也就是说，需要 lowering。对于项目里已注册的语言，管线面板显示：

```
源码 → [AST] → [OIR] → [MIR] → [SX] → [JS] → [C]
```

每一层是一个可点的节点。选中时右边显示那一层的文本输出
（即 `omni emit <format> <file>` 的结果）。层与层之间用 `→` 连接。

对于 scratch 语法（还没有 lowering 的），这一栏灰掉并提示
"写一份 `lower.js` 让它亮起来"。

### 3.4 示例（Examples）

一组可编辑的 `(输入, 期望输出)` 对——**内联的判据**。

- 每一行：`源码片段` → `期望的解析结果 / 降级输出 / 运行输出`。
- 绿勾 = 匹配，红叉 = 不匹配（展开看 diff）。
- "＋"按钮加一组。
- 这就是 Lab 里的 TDD 循环：写一条规则、加一组期望、看它变绿。

## 4. 交互

### 4.1 实时更新

与 IDE 模式同一条纪律：**防抖 250ms + 序号丢旧**。改语法或改示例后：

1. 重新 `readGrammar` → `buildTable`（纯计算，不走网络）。
2. 如果示例栏有内容，`glrParse`（也是纯计算）。
3. 表 tab 与树 tab 刷新。
4. 管线 tab 走 `/api/emit`（走网络，只在选中时触发）。

步骤 1-3 全在浏览器里跑（`readGrammar` / `buildTable` / `glrParse` 是纯函数，
不碰 node API）。步骤 4 走 serve 的热工人。

### 4.2 语法模板

新建时提供三个模板：

- **算术**（`tests/glr/grammars/expr.grammar`）：最简——token/prec/lex/rule，
  15 行，零冲突。
- **命令式**（`ext/tiny` 的骨架）：let/print/if/while + 公共节点库。
- **空白**：只有 `(grammar scratch (tokens) (start S) (lex …) (rule S …))`。

模板不是文件——它们内联在代码里，点一下填进编辑器。

### 4.3 加载项目语法

Lab 的左上角有一个下拉选择器：列出项目里所有 `.grammar` 文件
（27 份：11 ext + 3 frontend + 13 test）。选一份就加载到编辑器，
示例栏清空（或加载对应的 `tests/` 下的例子）。

这是 Lab 最实用的功能之一：**用 Lab 调试项目自己的语法**。
改一条 go 的规则、输入一行 go 代码、看 AST 有没有变——
不用退出 Studio 去命令行。

### 4.4 快捷键

| 键 | 行为 |
|---|---|
| `Cmd/Ctrl+Enter` | 强制刷新（跳过防抖，立即更新全部面板）|
| `Cmd/Ctrl+1/2/3/4` | 切检查面板的 tab（表/树/管线/示例） |
| `Cmd/Ctrl+\` | 聚焦在语法编辑器与示例编辑器之间切换 |

### 4.5 单体 HTML

Lab 模式在单体 HTML 里**完全可用**（步骤 1-3 不走网络）。
管线 tab 灰掉（需要 serve）。这是一个重要的设计约束——
它意味着 `readGrammar` / `buildTable` / `glrParse` 必须保持纯函数，
不能有 node 依赖。它们今天已经是纯的。

## 5. 服务端

### 5.1 新端点

不需要新端点。Lab 用的全是已有的：

- `readGrammar` / `buildTable` / `glrParse`：前端直接 import（它们是纯函数）。
- `/api/emit`：管线面板的逐层输出（已有）。
- `/api/run`：示例面板的运行输出（已有）。

### 5.2 前端需要的模块

Lab 模式需要在浏览器里跑语法表构建和解析。这些模块今天在 `src/core/glr/` 下：

```
grammar.js   — readGrammar（读 S-expr → 语法对象）
table.js     — buildTable（语法对象 → LALR 表，含冲突报告）
parse.js     — glrParse（表 + 源码 → 解析树）
```

它们不碰 `native.js`（纯计算），所以能直接进浏览器。
需要的前置是 `src/core/sexpr/read.js`（S-expression 读取器，也是纯的）。

单体 HTML 那份打包脚本（`tools/bundle-studio.mjs`）把这几份追加进依赖图就行。

## 6. 从编程语言发展中提取的设计教训

这些教训直接影响了 Lab 的功能选择。

### 6.1 SICP 与元循环（1985）

SICP 第四章的元循环求值器证明了一件事：**一门语言的核心语义可以在一页纸上写完**。
它从 `eval` / `apply` 两个函数出发，逐步加上赋值（环境模型）、惰性求值、
非确定性计算（`amb`）、逻辑编程。每一步都是**在已有求值器上的增量改动**。

Lab 的设计照搬了这个原则：`extends` 机制让你在任何语言上加一条规则，
而不是从零开始。`ext/tiny` 的 `extend(commonLang, { nodes: [...] })`
就是元循环加一层的工程实现。

### 6.2 Racket 与 `#lang`（2010–）

Racket 的 `#lang` 做到了"语言是库"——一份文件的第一行决定它用什么语法、
什么语义。DrRacket 的 macro stepper 让学生看到宏展开的每一步。

Lab 的管线面板是同一个想法的静态版本：不是看宏展开，
而是看从源码到目标码的每一层变换。区别是 Racket 的变换发生在运行期
（宏是程序的一部分），我们的变换发生在编译期——但"让中间产物可见"
这条纪律是一样的。

### 6.3 冲突的可视化（yacc/bison 的教训，1975–）

yacc 的 `-v` 输出是业内公认最难读的报告之一。学生看到
"3 shift/reduce conflicts"就放弃了。现代工具（tree-sitter、ANTLR 4）
选择换算法来避免冲突（GLR、LL(*)），但代价是错误更难理解。

我们的 GLR 解析器**接受冲突**（多条规约路径并行走完再选最好的），
但这不意味着冲突无害——每一条冲突都是潜在的歧义。Lab 的表面板把冲突
变成可点击的、可理解的卡片，这是 yacc `-v` 从没做到的事。

### 6.4 PLT Redex（2004–）

Reduction semantics（`-->` 规则 + `term` 模式）把语义变成了可执行的规范。
Lab 的示例面板是同一条路的极简版本：`输入 → 期望输出` 就是一条归约规则的
具象化。区别是 Redex 的规则是形式化的（Racket 的 pattern language），
而我们的判据是具象的（字符串比较）——但"改一条规则、看一组结果"的
交互循环是一样的。

### 6.5 Language Workbenches（MPS、Spoofax、Xtext，2006–）

JetBrains MPS 把"语言工作台"推到了极致：投射编辑、类型系统规范、
生成器模板。代价是学习曲线陡峭、项目结构重。Spoofax / Xtext 走 DSL 路线，
但绑定 Eclipse / IntelliJ。

Lab 故意不走这条路：

- **不做投射编辑**。语法就是文本，`textarea` 就够。
- **不做类型规范 DSL**。类型检查写在 `check.js` / `lower.js` 里，
  是普通的 JavaScript。
- **不绑 IDE**。Lab 在浏览器里跑，零依赖。

选择的理由：Language Workbench 解决的是"大团队做工业语言"的问题；
Lab 解决的是"一个人坐下来、从零开始、三分钟看到第一棵解析树"的问题。
后者的约束是**启动成本为零**。

### 6.6 tree-sitter（2018–）

tree-sitter 把增量解析 + 错误恢复做到了工业级。它的语法用 JavaScript DSL
写（不是 BNF），生成 C 代码。

我们的 `.grammar` 是 S-expression（比 JavaScript DSL 更简单、可序列化），
表在运行期构建（不生成 C）。这意味着 Lab 可以**实时重建表**——改一条规则、
250ms 后看到新表。tree-sitter 做不到这一点（每次改语法要重新生成 + 编译 C）。

## 7. 附录：从 Omni 自身开发中提取的教训

### 7.1 语法 DSL 的演化

`.grammar` 文件从最初只有 `tokens` / `prec` / `lex` / `rule` 四节，
到现在有 `extends`（方言继承）、`auto-semi`（Go/Nim/V 的自动分号）、
`indent` / `dedent`（Python/Nim 的布局规则）、`not-after` / `after`
（上下文敏感词法）、`declares-type` / `needs-type`（类型名与标识符的区分，
C/C++ 那道著名的墙）。

每一格都是被**真实语言逼出来的**：

| 特性 | 逼出它的语言 | 问题 |
|---|---|---|
| `auto-semi` | Go, V, Nim | 这三门语言都没有分号但语法是分号分隔的 |
| `indent` / `dedent` | Nim, Mojo | Python 风格的布局规则 |
| `not-after` | Go | `/` 在 `x/` 后面是除号不是正则开头 |
| `declares-type` | Go, C++ | `T(x)` 是构造还是调用？取决于 T 是不是类型 |
| `extends` | gsl-shell | Lua 的方言，只加几条规则 |

Lab 让你**看到**这些特性的效果：开一份 Go 语法，改掉 `auto-semi`，
看解析结果怎么崩。

### 7.2 GLR 的代价与收益

`buildTable` 构建 LALR(1) 表；有冲突的格子不报错，而是记下来让
`glrParse` 走多条路径。收益是**语法可以有歧义**（C 的 `T * x` 那道墙
用声明表而不是两套语法解决）。代价是 GLR 那一趟比纯 LR 慢
（我们量过：Go 语法 1500 行源码 15ms vs LR 的 3ms，见 ADR-0035 的账）。

Lab 的表面板报冲突数——零冲突意味着 GLR 退化成 LR、没有额外开销。
这是学生（和我们自己）优化语法的第一个信号。

### 7.3 核心方言是枢纽

所有语言最终降级到同一份核心方言（`.sx`）。这意味着一门新语言
**不需要写后端**——写一份 `lower.js` 把 AST 翻成 S-expression，
五条后端（JS/C/Native/Interp/Interp-MIR）自动接上。
`ext/tiny` 的 `lower.js` 是 80 行——那就是一门语言到"能跑"的全部工作量。

Lab 的管线面板让这条路径可见：从 AST 到 SX 那一步是 `lower.js` 做的，
从 SX 往后是核心编译器做的。学生能看到"我只需要写到这一步"。

### 7.4 四条腿的差分判据

`tests/cases` 里一千多份例子，每一份跑四条腿（JS / C / Interp / Interp-MIR），
要求 stdout **逐字节相同**。这条纪律抓到过：

- `pow(-8, 1/3)` 在 JS 和 C 上行为不同（NaN vs 真值）
- `round(-2.5)` 在 JS 和 C 上行为不同（-2 vs -3）
- 函数型变量默认实参语义在两条腿上发散
- 透明层合成的量化误差

Lab 的示例面板继承这个精神：一组输入、多条路径、结果必须一致。

### 7.5 27 份语法 = 27 个活教材

项目里已有的 27 份 `.grammar` 文件覆盖了大部分语言范式：

- **表达式语言**：`expr.grammar`（15 行，纯算术）
- **命令式**：`mini.grammar`、`tiny`（C 风格控制流）
- **系统语言**：`go.grammar`、`cpp.grammar`、`vlang.grammar`
- **脚本语言**：`lua.grammar`、`awk.grammar`、`nim.grammar`、`mojo.grammar`
- **图形语言**：`asy.grammar`、`glsl.grammar`
- **Lisp 系**：`chez.grammar`、`sbcl.grammar`
- **自研前端**：`jnc.grammar`（Omni 主语言）
- **测试语法**：`dangling.grammar`（悬挂 else）、`typename.grammar`（类型名墙）、
  `indent.grammar`（布局规则）、`lookahead.grammar`

Lab 把它们变成可互动的教材——不用 clone 仓库、不用装工具链，
打开浏览器就能拆解每一门语言的语法。

## 8. 实现

### 8.1 碰的文件

1. **`src/studio/index.html`**：seg 里加 `<button data-mode="lab">实验室</button>`
   + `<section class="lab" id="lab">` 整个版面。

2. **`src/studio/studio.css`**：
   - `.lab { display: none; }`
   - `[data-mode="lab"] .shell { grid-template-columns: 1fr 1fr; }`
   - `[data-mode="lab"] .shell > .pane { display: none; }`
   - `[data-mode="lab"] .lab { display: grid; ... }`
   - 窄屏一条。

3. **`src/studio/studio.js`**：
   - `setMode` 白名单加 `'lab'`。
   - `initLab()` 一次性初始化（懒加载 grammar/table/parse 模块）。
   - Lab 的事件接线：两个 textarea（语法 + 示例）的 input → 防抖 → 刷新。
   - 四个 tab 的切换（表/树/管线/示例）。
   - `labRefresh()`：重建表 + 重解析 + 刷新当前面板。

4. **`src/studio/render.js`**：
   - `formatConflict(conflict)` → 冲突卡片的 HTML。
   - `formatRules(rules)` → 规则表的 HTML。
   - `treeToHtml(node)` → 解析树的嵌套 HTML。
   - `treeToSexpr(node)` → 解析树的 S-expression 文本。
   都是纯函数，不碰 DOM。

5. **`src/studio/gallery.js`**：不动（Lab 不上首页卡片）。

### 8.2 语法/表/解析模块的前端引入

serve 模式：`/api/emit` 已经能给管线面板的逐层输出。
`readGrammar` / `buildTable` / `glrParse` 作为 ES module 直接 import——
`studio.js` 已经能 import `src/core/` 下的纯函数模块（`render.js` 就是这样做的）。

单体 HTML：打包脚本追加这三份到依赖图。

### 8.3 分片

1. **版面 + 表面板**：加 HTML/CSS、接 `readGrammar` + `buildTable`、
   冲突卡片 + 规则表。最小验收：加载 `expr.grammar`，看到"0 冲突、8 条规则"。

2. **树面板**：接 `glrParse`，画嵌套方块，双向高亮联动。
   最小验收：输入 `1 + 2 * 3`，看到正确的优先级树。

3. **管线面板**：接 `/api/emit`，逐层节点。
   最小验收：加载 `jnc.grammar`，输入一行 omni 代码，看到 AST → OIR → SX → JS。

4. **示例面板**：输入/期望对、绿勾/红叉。
   最小验收：写一条 `1+2` → `(add (real 1.0) (real 2.0))`，看到绿勾。

5. **判据**：`tests/studio` 加 Lab 模式的判据（至少四格：
   空语法报错、expr 零冲突、树形状、管线层数）。

### 8.4 不做的事

- **不做语法补全 / LSP**（textarea 够用，与其余三个模式同一条纪律）。
- **不做 lowering 编辑器**（那是 JS 文件，在 IDE 模式里改）。
- **不做运行期调试器**（Lab 的重点是语言的静态结构：语法 + 中间产物）。
- **不做协作编辑**（第一刀只有本地）。
- **不做 `#lang` 式的运行期切换**（我们的切换在编译期，由文件后缀决定）。

## 9. 判据

| 轴 | 怎么量 |
|---|---|
| 表面板 | `readGrammar` + `buildTable` 在浏览器里跑通；`expr.grammar` 报 0 冲突 8 规则 |
| 树面板 | `glrParse` 在浏览器里跑通；`1+2*3` 的树形状匹配快照 |
| 联动 | 改一条规则 → 250ms 内表与树刷新（防抖，与 IDE 同一条计时） |
| 管线 | 已注册语言的 emit 逐层输出与 CLI `omni emit` 逐字节相同 |
| 冲突 | `dangling.grammar` 报出 shift/reduce 冲突且卡片可读 |
| 单体 | 表/树两个面板在单体 HTML 里可用（不走网络） |
| 示例 | 输入/期望对的绿勾/红叉与 `glrParse` 实际输出一致 |

## 10. 参考

- Abelson, Sussman, *Structure and Interpretation of Computer Programs* (1985), 特别是 §4 (元循环求值器) 与 §5 (寄存器机器)
- Felleisen 等, *How to Design Programs* (2001, 2018), §IV (抽象与语言层次)
- Flatt, *Composable and compilable macros* (ICFP 2002), Racket 的 `#lang` 设计
- Findler, *PLT Redex* (2004–), 可执行的归约语义
- DeRemer & Pennello, *Efficient Computation of LALR(1) Look-Ahead Sets* (TOPLAS 1982)
- Tomita, *Efficient Parsing for Natural Language* (1985), GLR 算法
- Bruggeman, Waddell, Dybvig, *Representing Control in the Presence of First-Class Continuations* (PLDI 1996)
- tree-sitter, https://tree-sitter.github.io/ (2018–), 增量解析
- JetBrains MPS, https://www.jetbrains.com/mps/ (2006–), 投射编辑
- Spoofax, https://spoofax.dev/ (2010–), 语言工作台
- Omni ADR-0035: GLR 加速与冲突报告
- Omni ADR-0037: 方言继承（gsl-shell extends lua）
- Omni `ext/tiny/`: 最小语言模板（4 份文件，~300 行）
- Omni `tests/glr/`: 语法 DSL 的判据集（27 份 .grammar + 快照）
