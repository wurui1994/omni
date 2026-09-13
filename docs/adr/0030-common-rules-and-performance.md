# ADR-0030：跨语言公共规则层、`.lua` 接进驱动、规则化的性能账

日期：2026-09-13　状态：**进行中**（第 1 节已量、第 4 节已定形、第 2/3 节待做）

## 起因

`ext/lua` 那一轮把"节点规则 + 组合规则"验通了（见 `ext/lua/DESIGN.md`：四把尺子、
生成 412 格分歧 0、语料 112/112、公式子语言 176/176、两条腿 106 一致 3 记账 0 分歧）。
接着有三件事压上来，都不是"再多收一门语言"能解决的：

1. **还没接进驱动**：`omni run bench/fib.lua` 说"不认识 fib.lua 这种扩展名"。
   语言各自一格 `plugins/omni-lang-<名字>`，`.lua` 还没有那一格。
2. **jancy 那边要按同一套重写**：`src/core/frontend-jnc/lower.js` 15.5k 行是个单体。
   旧的改名 `lower_legacy.js` 留着当尺子/回退，新的按规则化重写。
3. **我现在写的还是"单体"**：`ext/lua` 与 `ext/gsl-shell` 各有自己的一份表，可**表达式那一层
   大部分语言是一样的**（数、名字、二元/前缀算符、括号、调用、下标…）。公共规则该抽出来，
   细粒度组合往后做。另外：读表的驱动器有解释开销，**性能得量出来**再谈。

## 1. 性能：量出来的（`node ext/lua/tests/bench.js`）

语料 = gsl-shell 的 112 个 `.lua`，794 KB / 27,587 行。取 3 轮最快的一轮。

- 词法 `lex`：**30 ms**（25.7 MB/s、4.55 M 记号/s、916 k 行/s）
- 语法 `parse`（含词法）：**112 ms**（6.95 MB/s、247 k 行/s）
- 写回 `render`：**29 ms**（26.8 MB/s）
- 降级 `lower`：**18 ms**（43.4 MB/s）
- 外面那把尺子 `luajit -b`（它自己的词法 + 语法 + 生成字节码，C 写的，含进程启动）：
  **3 ms**（237 MB/s）

也就是说：**读表的解析器比 LuaJIT 手写那棵递归下降慢约 34 倍**（6.95 vs 237 MB/s）。
这个差距里有三笔，得分开算：

- **宿主差**：JS vs C。同类工作 5~15 倍是常态，这一笔与"规则化"无关。
- **解释开销**：`matchSyn` 每一步都在读 `syn` 数组、`SIMPLE` 挨个试候选、有序选择要回溯。
  证据：语法比词法慢 3.7 倍，而词法做的字符级活儿更多 —— 慢的不是"看字符"，是"查表 + 试候选"。
- **对象分配**：每个节点一个字面对象、形状随节点种类变（隐藏类不稳定）。

**结论：规则化不必付解释开销 —— 表是可以编译的。** 四条（都从表里**算**出来，不手写分支）：

1. **FIRST 集索引**：由 `syn` 自动算出"哪个记号能引导哪几个节点"，`stat()`/`simple()`
   直接查表拿唯一候选；回溯只留给真歧义（`for-num` vs `for-in`、`call-stat` vs `assign`）。
2. **`syn` 预编译成闭包链**：加载期把每个节点的 `syn` 编成一串"匹配一步"的闭包
   （partial evaluation）。数据一个字不改，解释开销挪到加载期。
3. **记号流列式化**：`kind` 编成小整数、`value` 走 interned 表 —— 比较变整数比较。
4. **AST 节点同形**：一种节点一个构造函数（隐藏类稳定），别每处 `{kind, …}` 字面量。

判据：`parse` 从 6.95 MB/s 提到 **≥ 20 MB/s**（与我们自己的词法同一档），
且四把尺子的结论**一格不变**（这四条都不改语言的规则，只改怎么执行它）。

搬进 SDK 前后又量了两轮：`parse` 6.1~7.2 MB/s、`lex` 18.5~26 MB/s、`render` 15~26 MB/s ——
**噪声比跨模块调用的代价大**，所以"搬出去会不会变慢"这一问的答案是：量不出来。
往后做那四条优化时，得先把量法收紧（同一进程内多轮、丢掉最差的、分别计时），
不然 20 MB/s 那个判据落不到实处。

## 2. 跨语言公共规则层（**已落地**：机制归 SDK，表归扩展）

现在 `ext/lua` 里有两类东西混在一起：

- **与语言无关的机器**：`syn` 的词汇（`h`/`l`/`nm`/`w`/`opt`/`rep`）、`lang.js` 的派生索引与
  `extend`、`parse.js` 的五台机器、`render.js`、`tokens.js` 的规则驱动扫描器
- **某门语言的表**：Lua 的关键字/算符/35 个节点、gsl-shell 的增量、公式子语言的三张表

搬完了（四把尺子一格没变，行数正好一半一半：机制 1085 行 / 表 1118 行）。
契约那一份写给外人看：`docs/EXTENSIONS.md`。落点：

- `src/core/frontend-engine/syntax.js` ← `syn` 词汇 + 洞的类别代数（`SUBCLASS`/`fits`/`membersOf`）
- `src/core/frontend-engine/lexrules.js` ← 记号规则驱动器 + 通用规则件（`reRule`/`nameRule`/…）
- `src/core/frontend-engine/parse-driver.js` ← 五台机器（`matchSyn`/`hole`/`exp`/`suffixed`/`choose`）
- `src/core/frontend-engine/render.js` ← 写回器
- `src/core/frontend-engine/bind.js` ← 作用域配方 + 上下文规则的走一遍（读 `lang.scope`/`lang.ctx`）
- `src/core/frontend-engine/arity.js` ← 元数契约（读 `lang.yields`）
- **还没做**：`common-nodes.js` 那格**公共节点库**（`number` `string` `name` `binop` `prefix`
  `paren` `call` `index` `block` `if` `while` `return` `break` `assign`…）。现在 Lua 与公式子语言
  各写了一遍这些节点 —— 该抽成一份默认表，语言用 `extend(commonLang, delta)` 取用。
  这是第 2 节剩下的那一格，也是"细粒度组合"真正开始的地方。

一句要写在前面的话：**公共不是"求交集"，是"给一份默认值"**。Lua 的 `^` 右结合、公式子语言的
`^` 左结合、Lua 的 `=` 是赋值、公式里的 `=` 是比较 —— 公共库给默认，语言用 `replaces` 改；
改了几格就是这门语言"离公共有多远"的一个可读数字。

## 3. jancy 按规则化重写（待做）

- `src/core/frontend-jnc/lower.js` → **`lower_legacy.js`**（15.5k 行，一个字不改，
  留着当回退与"对照的尺子"）
- 新的 `src/lang/jnc/`（已经有 `features/` 与 `syntax.js`）补齐四张表：
  `nodes.js`（`syn` + 洞的类别）、`scope.js`（配方 + CTX）、`values.js`、`lower.js`（每节点一小步）
- 驱动器**共用第 2 节搬出来的那几份** —— 于是"jancy 与 Lua 差在哪"是两张表的差，不是两个单体
- 尺子照旧、期望不许改：位置矩阵 594 格（`tests/lib/jnc-matrix.js --check` 要 0 分歧）、
  语料板 3426 对（`tests/lib/jnc-sweep.js` 不许变差）、`tests/jnc/run.js` 的 350 例
  （`run-jit == run`）。**先跑通旧的做基线，再一族一族搬**（一族 = 一张表的一片，
  比如"字段族"、"属性族"），每搬一族两把尺子都要复量。

## 4. 扩展的机制（本轮做）：核心给机制，扩展自述

**先记一笔更正。** 第一版我是这么接的：`src/core/lang/lua.js` 一格外壳、`lang/builtin.js`
的声明表加一行、`src/plugin/lang-lua.js` 一个入口。跑通了，但**方向错了** ——
`ext/` 存在的理由是我们要当 SDK：后面会有别人写他们自己的语言。那么"我们认识 lua"这件事
就不该写进核心，因为**别人的语言不可能进我们的表**。核心该给的是机制，扩展该做的是自述。

于是那三处退回去了，改成一条通用的路：`src/core/ext.js`（119 行，一个语言名字都没有）。

### 约定（这就是那份契约）

1. **一格扩展 = 一个目录**。目录里有 `omni-ext.json` —— **数据，不是代码**。
   于是核心"知道有这么一门语言"这件事**不必装它的任何代码**。
2. 自述说清四样：

```json
{
  "name": "lua",
  "version": "0.1.0",
  "doc": "一句话说自己是什么",
  "entry": "omni-lang.js",
  "register": "registerLuaExt",
  "provides": { "exts": [".lua"], "caps": ["lua.toSx"] }
}
```

   `provides` 里四栏（`exts` / `runnerExts` / `caps` / `targets`）至少要有一栏非空；
   校验不过当场报**哪一格不对** —— 别人写扩展时，那几句话就是他们的编译器。
3. **真被问到那一格时才装**（`omni run x.lua` 问 `.lua`），走的是内建那几门同一条迟装路
   （`plugin.js` 的 `declareProvider`）。所以**注册表这一层看不出谁是内建、谁是扩展**；
   装完没登记声称的那一格照样当场响错（`resolvePending` 那一句）。

### 三个位置

- 搜索路径：`OMNI_EXT_PATH`（`:` 分隔）优先，否则按**布局**找一串候选根
  （`<安装位置>/ext`、往上一到三层的 `ext/`、`$PWD/ext`）再加 `~/.omni/ext`。
  写死"往上两层"是错的 —— `installDir()` 在源码腿上指 `src/core/host`、编出来的腿上指产物目录，
  层数不一样（第一次就踩了这一格，量出来是空的）。
- 装法**由宿主注入**：`declareExts(load, api)` 的 `load(dir, entry)` 由调用方给。
  源码腿在 `lang/builtin.js`（那份文件本来就是唯一允许用 `createRequire` 的）里传 `require`；
  编出来的腿将来传插件加载器（自述里再加一格 `"plugin": "omni-lang-lua"`）。
  于是"怎么装"不是 `ext.js` 的知识，`ext.js` 只管"约定与声明"。
- **内建先声明、扩展后声明**：同一个后缀两边都认时内建赢（先声明先命中）。
  这条得写下来 —— 它决定了别人不能悄悄顶掉我们的语言。

### 扩展这一侧长什么样（`ext/lua` 就是样板）

```
ext/lua/omni-ext.json   自述（数据）
ext/lua/omni-lang.js    入口：registerLuaExt(api) 里调 api.registerCap / api.registerLang
ext/lua/*.js            这门语言自己的表与驱动器
```

方向是**单向**的：扩展 `import` 核心（`../../src/core/…` 那几行就是 SDK 面：
`source/diag.js`、`host/native.js`、`host/path.js`、`sexpr/lower.js` —— 只有四样，
都是"每门语言都要"的东西），核心一个字都不认识 lua。
`grep -rn lua src/` 除了 `ext.js` 注释里的举例之外没有别的（`mir/ir.js` 里那几处 LuaJIT
是早先引它的实现当出处，与这件事无关）。

### 验收（量过的）

- `node src/core/cli.js run bench/fib.lua` → `196418` / `999794999321`，
  与 `luajit bench/fib.lua` **逐字相同**（fib 递归 + 2M 次数值 `for` + `%` + `print`）
- `omni run x.py` 那句拒绝里现在列着 `js / wat / sx / asy / jnc / glsl / lua` ——
  最后那一门是**扩展自己报的名**
- 端到端时间：`luajit` 7 ms vs `omni run`（第一刀降级 + 核心方言解释）0.14 s，
  其中 node 起进程 ~0.04 s、前端 ~0.02 s，剩下的是解释器。编译腿（`omni build`）没量。
- 既有的腿没动：`tests/sexpr` 与 `tests/glsl` 全绿，`omni emit sx tests/jnc/...` 照旧。

**没做的**：编出来的核心那条腿上扩展还装不进来（要 `"plugin"` 那一格 + 把扩展编成
`omni-lang-<名字>.dylib` 的构建约定）。这是下一格。
