# python —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。正本是参考树 `~/Documents/Lang/reference/cpython`
（`OMNI_REF_DIR` / `CPYTHON_SRC` 可以改），现在是 **3.16.0a0**。

## 一、这一门怎么摆：解析与执行归我们，运行时借 CPython 的 C

这是这门语言唯一的架构决定，其余全从它推出来。

**借的那一半（CPython 的 C）**：那些"位对位才算对"而且重写要一年的东西。

- 浮点转串（`Python/dtoa.c` + `Objects/floatobject.c` 的 `float_repr`）—— `repr(0.1)`
  印 `0.1` 而不是 `0.1000000000000000055`，靠的是最短往返那套算法。
- 大整数（`Objects/longobject.c`）—— python 的 `int` 没有上界，`2**1000` 得真算。
- 串与编码（`Objects/unicodeobject.c`、`Objects/stringlib/`、`Modules/_codecs*`）——
  大小写映射、`str.format` 的格式微语言（`Python/formatter_unicode.c`）、各国编码表。
- 哈希（`Python/pyhash.c` 的 siphash）—— `hash()` 的值与字典/集合的迭代次序由它定。
- 正则（`Modules/_sre/`）—— 这一格是 python 语义的一大块，重写等于重写一个引擎。
- 数学与随机（`Modules/mathmodule.c`、`_randommodule.c` 的 MT19937）—— 与 R 那一门
  同一个道理：随便换一条发生器，同一份程序就答不出同一个数。

**不借的那一半（这是"解析和执行走我们"那句话的具体内容）**：

- `Parser/`（PEG 解析器、`pegen.c`、tokenizer）—— 语法走 `python.grammar` + 这套 GLR。
- `Python/compile.c` / `flowgraph.c` / `codegen.c`（出 CPython 字节码的那一串）。
- `Python/ceval.c`（字节码解释器）—— 执行走标准 IR → `src/core/lower/` → MIR → 各后端。
- `Python/import.c` 那套 import 机器 —— 模块解析归驱动层（`drive.js` 的 `imports` 那一格）。

也就是说：**一份 .py 进来，出去的是我们的 MIR**，跑在 JS 腿或 C 腿上；遇到
`repr(1.1)` / `int` 溢出 / `re.match` 这类格子，调的是我们自己编出来的那份
`libomniPy`（CPython 的 C，我们的 ninja 编）。不起 `python3`、不 `dlopen` 本机的
`libpython`、不走它的字节码 —— 那样就成了"套壳 CPython"，一格语义都学不到。

R 那一门（ADR-0045/0046/0047，`r-lang` 分支）已经把这条路走通过一遍：`ext/r/build.js`
编 nmath、`ext/r/build-libR.js` 编整份 libR，两份都用 `src/core/build/api.js`
那台 JS 写的 ninja，产物落 `.omni-cache/`。python 这一门照同一个形状办，差别只在
"借哪几份 .c" 与 "`pyconfig.h` 怎么生"（对应 R 的 `gen-rconfig.js`）。

## 二、进度

### 已落地

- **`python.grammar`** —— 照 `Grammar/python.gram`（PEG）+ `Grammar/Tokens` +
  `Parser/lexer/` 复刻。`cpython/Lib` 下 2063 份 .py **读下来 2054 份（99.6%）**。
  一路的账、每一处偏离 PEG 的理由、还欠的 9 份都写在那份语法的文件头与末尾。
- **`src/core/glr/lex.js` 加两个字符类** `ualpha` / `ualnum` —— 标识符许 Unicode
  （PEP 3131），口径照 CPython 的词法（"码点 >= 128 就算"，不查 XID 表）。
  这是通用的一格，别的语言（js / go / nim）也用得上。

### 下一刀，按顺序

1. **`ext/python/adapter/`** —— CST → 标准 IR，照 `ext/mojo/adapter/` 的形状分
   `index.js`（语句）+ `expr.js`（表达式）。同一刀里在 `src/core/lower/langs.js`
   加一行 `['python', {grammar: …, toIR: pyToIR, imports: pyImports, exts: ['py']}]`。
   先只接"能跑起来"的那一小片（模块级函数、int/float/str、list/dict、for/while/if、
   print），再按语料扩 —— 与 R 那一门一样，一格一格拿真程序扫。
2. **f-string 的内部结构**（PEP 701）。这要在 `lex.js` 里加一格通用能力：
   一个记号里嵌一段要再解析的文本。现在整份 f-string 是一个 STRING，8 份语料因此没过。
3. **`ext/python/build.js` + `rt/gen-pyconfig.js`** —— 借 CPython 的 C 那一半。
   起点只要两格：`dtoa.c`（浮点转串）与 `longobject.c`（大整数），因为这两格是
   "答得对不对"最先撞上的墙。`pyconfig.h` 按 `pyconfig.h.in` 一行一行真探一遍，
   照 `gen-rconfig.js` 那五类分（`HAVE_*_H` 真编、`HAVE_DECL_*` 回 0/1、
   `HAVE_<FUNC>` 真链、`SIZEOF_*` 真跑、其余进一张显式的表），**表里没有又落不进
   四类的名字当场报** —— R 那一门的账里，这一条挡住过四个静默答错的坑。
4. **尺子**：`tests/python/oracle.js` —— 每一份例子拿本机 `python3` 跑一遍，
   两边**逐字节**比 stdout。R 那门的 `tests/r/oracle.js` 是同一个形状。

## 三、口径

- 版本钉在参考树上（现在 3.16.0a0），不钉本机装的那个 python。那棵树里已经有
  PEP 810 的 `lazy import`（标准库 71 份在用）、PEP 798 的 `[*i for i in xs]`、
  PEP 758 的 `except A, B:` —— 本机的 3.13 没有这些。
- 软关键字（`match` / `case` / `type` / `lazy`）进关键字表，再从语法里的 `sname`
  那一条当普通名字放回去。理由与代价写在 `python.grammar` 的关键字段。
- 语法**收得比 python 宽**几处（海象出现在语句位、match 的模式借表达式语法）。
  "解析不是校验" —— 那几格由 adapter 判并当场报，不由语法判。
