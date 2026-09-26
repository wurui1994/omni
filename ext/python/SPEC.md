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
- **`adapter/`（CST → 标准 IR）+ 在 `langs.js` 登记** —— `omni run x.py` 通了。
  这一门**一个类型标注都不必写**：形参从标注或调用点推、返回类型从函数体的 `return` 推、
  模块级变量从初值推，整个扫三轮，三轮之后还推不出来的当场报（口径在
  `adapter/index.js` 文件头）。python 与 C 分道的每一处都按 python 的口径落：
  `/` 永远出浮点、`//` 向下取整、`%` 的符号跟着除数、`str + 非串`当场报、
  负下标与切片两头夹到 `[0, len]`、`print(a, b)` 一行空格连、`str(True)` 是 `True`、
  `str(4.0)` 是 `4.0`、`str([1, 4])` 是 `[1, 4]`、`math.floor` 交 int。
- **方言加一格 `(srepr E)`** —— 往返无损的 real 文本。三条腿的实现
  （`omni_repr_real` / `$repr_real` / `reprReal`）本来就在，缺的只是方言这个口；
  python 的 `str(float)` / `repr(float)` 走 `%.6g` 的话每一处浮点输出都差一截。
- **`tests/python/run.js`** —— 外部尺子：同一份 .py，我们跑一遍、本机 `python3` 跑一遍，
  **stdout 逐字节相同**才算过。两条腿都量（解释器 + `--mode js`）。
  现在 4 份例子 × 2 条腿 = **8 绿 0 红**（尺子 Python 3.14.7）。

### 下一刀，按顺序

1. **单态化**。现在同一格形参在两处调用里装不同的东西就当场报（`add(2,3)` 与
   `add(1.5,2.5)`）—— python 的鸭子类型撞上方言的静态类型。出路是按实参类型生成
   `add_int` / `add_real`，这也是往后 `class` 与容器泛型的地基。
2. **`class`**。落成方言的 `(class …)` + `<类型>_<方法>`（mojo 那一门的形状），
   `self` 是第一格实参。
3. **f-string 的内部结构**（PEP 701）。这要在 `lex.js` 里加一格通用能力：
   一个记号里嵌一段要再解析的文本。现在整份 f-string 是一个 STRING，8 份语料因此没过。
4. **`ext/python/build.js` + `rt/gen-pyconfig.js`** —— 借 CPython 的 C 那一半。
   起点只要两格：`dtoa.c`（浮点转串 —— `srepr` 与 CPython 还差指数形式的门槛，
   `1e15` 我们出 `1e+15`、CPython 出 `1000000000000000.0`）与 `longobject.c`
   （大整数 —— 现在的 int 是 64 位，python 的没有上界）。
   `pyconfig.h` 按 `pyconfig.h.in` 一行一行真探一遍，照 `gen-rconfig.js` 那五类分
   （`HAVE_*_H` 真编、`HAVE_DECL_*` 回 0/1、`HAVE_<FUNC>` 真链、`SIZEOF_*` 真跑、
   其余进一张显式的表），**表里没有又落不进四类的名字当场报** —— R 那一门的账里，
   这一条挡住过四个静默答错的坑。
5. **`try` / `with` / `match` / 生成器 / 闭包 / 装饰器** —— adapter 现在对它们当场报
   "还没接"，不猜。

## 三、口径

- 版本钉在参考树上（现在 3.16.0a0），不钉本机装的那个 python。那棵树里已经有
  PEP 810 的 `lazy import`（标准库 71 份在用）、PEP 798 的 `[*i for i in xs]`、
  PEP 758 的 `except A, B:` —— 本机的 3.13 没有这些。
- 软关键字（`match` / `case` / `type` / `lazy`）进关键字表，再从语法里的 `sname`
  那一条当普通名字放回去。理由与代价写在 `python.grammar` 的关键字段。
- 语法**收得比 python 宽**几处（海象出现在语句位、match 的模式借表达式语法）。
  "解析不是校验" —— 那几格由 adapter 判并当场报，不由语法判。
