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
  **stdout 逐字节相同**才算过。**三条腿都量**（`omni run` 走解释器、`--mode js` 发 JS、
  `omni build` 发 C 再编）—— 浮点转串这些格子在三条腿上各有一份实现，只量一条等于只量了
  三分之一。现在 6 份例子 × 3 条腿 = **18 绿 0 红**（尺子 Python 3.14.7）。
- **单态化** —— 一个 python 函数按**实参类型的元组**生成几格实例
  （`add(2,3)` 与 `add(1.5,2.5)` 与 `add("a","b")` 落成三格 `add__int_int` /
  `add__float_float` / `add__str_str`；只有一格实例时不加后缀）。这是 python 的鸭子类型
  撞上方言静态类型的出路，也是往后 `class` 与容器泛型的地基。判据是 `examples/generic.py`。
- **`(srepr E)` 换成 python 自己那条排版规则** —— 从前它借的是 Omni 的 `repr(x)`
  （`%.{15,16,17}g` 的门槛跟着有效位数走），于是 `1e15` 印成 `1e+15` 而 CPython 印
  `1000000000000000.0`。现在三条腿各有一份 `py_repr`（`omni_pyrepr_real` /
  `$pyrepr_real` / `pyReprReal`）：数字取最短往返，**定点当且仅当 `-4 < decpt <= 16`**
  —— 与 `Python/pystrtod.c` 的 `format_float_short` 同一条。判据是
  `examples/floatrepr.py`（10 的幂从 1e-11 扫到 1e19，三条腿都逐字节相同）。
- **借 CPython 的 C 那一半开工了**（`ext/python/build.js` + `rt/`）。第一批借的是
  `Python/dtoa.c`（David Gay 的正确舍入转换，2841 行）与 `Python/pystrtod.c`
  （CPython 的 repr 排版规则，1286 行）—— 两份**一个字都不改**。我们只加三格：
  * `rt/shim/Python.h` —— 垫一层地板。那两份 `.c` 真正用到的 Python API 是**量出来的**
    （`grep -o '\b_\?Py[A-Za-z_]*\b'`）：`PyMem_Malloc` / `PyMem_Free`、
    `PyInterpreterState`（只为了 `->dtoa`）、`PyStatus`、`PyErr_*`、几个字符宏。
    凡是 CPython 自己有的都走它（`Py_DTSF_*` 用它的公开头、`_PY_SHORT_FLOAT_REPR` 用它的
    `pycore_pymath.h`）。
  * `rt/gen-pyconf.js` —— 探本机。名单是**算出来的**：`pyconfig.h.in` 能定义 727 个宏，
    这几份源码真读到 6 个（两格 double 字节序、`WORDS_BIGENDIAN`、`X87_DOUBLE_ROUNDING`、
    两格 gcc 内联汇编）。探法照 CPython 的 `configure.ac`（注明行号），
    **算出来的名字里有一个不认得怎么探的就当场报**。
  * `rt/gen-pyshim.js` —— 把 `struct Bigint` / `struct _dtoa_state` 从 CPython 自己那份头里
    **原样切出来**（手抄会与那棵树分叉，症状是运行期越界）。
  判据：`tests/python/rt.js` —— `repr(float)` 与本机 `python3` 在 **2035 个数**上逐字节相同
  （35 格手挑的边界 + 2000 格定死的伪随机位模式扫描）。
  顺带这是 `src/core/build/`（那台 JS 写的 ninja）的第二个生产调用者（第一个是 R 的运行时）。

* **推不出类型就退到 dyn**（`ext/python/adapter/dyn.js`）。这一刀改的是一个**错结论** ——
  原先这一门写着「方言是静态类型，所以推不出来的地方必须当场报，要一格标注」。不对：
  * 方言那一侧早就有真动态那一族（`(dyn E)` / `(dtag E)` / `(as* E)`，钉在
    `tests/sexpr/cases/48-dyn.sx`，四条腿已通），C 侧是 `omni_dyn` 那个带标签的 24 字节胖值；
  * **JS 整门语言跑的就是这条道**（ADR-0011 决策 1：「JS 的每个值都是 `dynamic`，
    不给 JS 做类型推断」），而 js→C 是自举主干 —— 动态性比 python 强的东西早就编到 C 了；
  * 口径按 ADR-0008：**异质 ⇒ 统一降为 dynamic**，一条规则，不做联合类型。
  缺的只是"标准 IR 那一层没写下这一族" —— 所以 `src/core/lower/sx.js` 的 `SX_ARITY` 补了
  `dyn` / `dtag` / `as*` 八格、`ty-of.js` 加了 `DYN` 与它们的类型、`ty.js` 的 `zeroOf` 加了
  dyn 那一格零值。C 那条腿上 `(arr dyn)` 另外要两处：`hir/types.js` 的
  `sizeOf(dynamic) = 24`（量出来的）与 `arrIsBlob` 收 dynamic（值语义的聚合，与 vec 同桶）。
  这一门于是退得下去的有这几处：**异质的表**（`[1, "two", 3.5, True]` → `(arr dyn)`）、
  **异质的字典**（`{"name": "omni", "port": 8080}` → `(dict string dyn)`）、
  **换类型的变量**（`x = 1` 之后 `x = "s"`）、**交不同东西的函数**（一支 return 数一支 return 串）、
  **`None`**（标签是 `"null"` 的那一格 —— 于是"可能没有值"这一族不必写 `Optional[int]`）、
  **箱子上的算术与比较**（`+ - * / // % **`、五格位运算与那六个比较，按 `(dtag …)`
  两边各问一次；`**` 的"指数是不是负数"在**运行期**问一次 —— 静态那一侧靠的是
  "指数是非负整数字面量"，箱子上没有那个信息）。
  判据：`ext/python/examples/` 的 `dynlist.py` / `dynvar.py` / `dyndict.py` / `none.py`
  三条腿与 python3 逐字节相同；`tests/sexpr/cases/55-dyn-arr.sx` 钉住 `(arr dyn)` 本身。
  **推得出来仍然优先**：单态化、标注、三轮推断一格没动 —— dyn 只在真的合不成一格时才用
  （箱子上的加减乘除要按标签分派，比静态那条路贵）。
  顺带钉出并修掉的两处真错：
  * `(dnull)` 之前**方言这一面写不出来** —— `DynNull` 那个 OIR 节点四条腿本来就都认
    （backend-c 的 `omni_dyn_null()`、backend-js 与 interp 的 `null`、MIR 的常量），
    缺的只是源码里的写法。补一格 `(dnull)`，`None` 与 dyn 的零值就都有着落了。
  * **函数体里赋一个名字就是造一格局部**（python 的规矩）—— 原先绑定那一趟用的是
    `lookup`（会一路看到模块级那张表），于是函数里的 `v` 撞上模块级同名的 `v` 时
    局部那一格根本不生成，`set` 打到模块级去了。改成 `lookupHere`，
    并让绑定那一趟也认 `global x`（不然 `control.py` 的 `global TICKS` 反过来坏掉）。
  明说的不足：表与记录**装不进**箱子
  （`DYN_BOXABLE` 只有 int / real / bool / string / 函数 / `(dict string dyn)`）；
  箱子里装着函数或字典时印出来的是标签本身，不是 python 的 `<function f at 0x…>`；
  `None < None` 这几个在 python 里是 TypeError，这儿答 False；
  算术碰上不该碰的标签（`"a" - 1`）是**运行期错误**而不是异常 —— 报出来比算个假数字好。

* **`class`**（`declareClasses` / `inferFields` + `expr.js` 的 `attr` / `newRecord` / `methodOf`）。
  落成方言的 `(class …)`（**引用语义** —— 两个名字指同一格）+ 方法降成
  `<类名>_<方法名>` 的普通函数，`self` 是第一格实参（mojo 那一门同一个落点）。
  字段从**类级标注**与 `__init__` 顶层那几句 `self.x = …` 认；方法按接收者类型挑实例，
  走的是单态化那张表（与自由函数同一条路）。
  判据：`ext/python/examples/classes.py` 三条腿与 python3 逐字节相同。
  明说的不足：**类不按实参单态化**（一格 `(class …)` 只有一份字段表）——
  `Point(3, 4)` 与 `Point(1.5, 2.5)` 混着造时字段该退到 dyn，而方言的字段还不收 dyn，
  所以 adapter 在自己这一侧报清楚并让人加一格标注（`x: float`）。
  继承、类方法 / 静态方法、`__init__` 之外造字段、`if` 里才出现的字段都还没接。

* **f-string 的替换字段**（`ext/python/adapter/fstring.js` + `drive.js` 递进来的 `parseExpr`）。
  整份 f-string 在词法那一层仍旧是**一个记号** —— 这套 GLR 的词法器是一张 DFA，
  没有起始条件也没有栈（`src/core/glr/lex.js:27-29`、`:56-61`；`(indent …)` 是它唯一
  一格有栈的东西，而且是显式声明的）。所以**不走 PEP 701 那条**（发
  FSTRING_START / MIDDLE / END 三族记号），走的是 jnc 那一门的先例：
  「整块当一格记号、要用时用**同一张 LR 表**再解析一遍」（`src/core/lang/jnc.js:87-119`
  的注把理由写全了）。`drive.js` 于是多递一格 `parseExpr(裹好的源码)`；
  怎么裹、怎么从树里挖出那一棵是各门语言自己的事（python 裹成 `(…)` 一句表达式语句）。
  接了的：`{expr}`、`{expr!r}` / `{expr!s}`、`{expr:.Nf}`、`{{` 与 `}}`，
  以及"字段里有引号"（`f"{d['k']}"` —— 切字段时整段跳过引号串）。
  判据：`ext/python/examples/fstring.py` 三条腿与 python3 逐字节相同。
  **单态化那一趟也要看见它们**：`f"{twice(n)}"` 里那次调用躺在 STRING 记号里，
  `allNodes` 走不到 —— 所以推断之前先把那几段解析出来挂在 `C.fstrTrees` 上
  （量到的原话：`twice(int)` 没有对得上的那一格）。
  明说的不足：别的格式说明（`:>10`、`:,`、`:x` —— `Python/formatter_unicode.c`
  那一整套微语言）、`{x=}` 自文档、`!a`，以及**里外同一种引号**（`f"{d["k"]}"`，
  PEP 701 放开的那一格 —— 那是词法层的事，语料里 8 份卡在这儿）。

* **走一遍容器的那几个内建与串方法**（`ext/python/adapter/builtins.js`）。方言里没有
  "聚合"这一族算子，可它有 `while` / `aget` / `apush` / `sfind` / `ssub` —— 所以这几格
  全是**现场发一趟循环**（与 `expr.js` 里 `listRepr`"表转串"同一条办法），
  **三条腿一行没改就通**。
  接了的：`sum` / `min(xs)` / `max(xs)` / `min(a,b,c)` / `sorted` / `any` / `all` /
  `list(range(…))`，串上的 `.join` / `.split(sep)` / `.strip` / `.lstrip` / `.rstrip` /
  `.replace` / `.startswith` / `.endswith`，字典上的 `.get(k)` / `.get(k, 默认值)`。
  为什么不往方言里加算子：这几个是**python 自己的规矩**（`sum([])` 是 `0`、
  `"a,,b".split(",")` 的空段算一格、`.strip()` 去哪几个空白字符），不是汇聚层该知道的 ——
  加进去就要替十几门语言各自的差别背账。
  两处顺带钉出来的：
  * **`d.get(k)` 交的是一格箱子**（dyn），不是值的类型 —— 键不在时 python 交 `None`，
    而**方言的 `dget` 在键不在时交零值**（量到过：`d.get("z")` 印出个 `0` 来）。
    所以要先问一句 `dhas`，有就装箱、没有就 `(dnull)`。`.get(k, 默认值)` 则把
    "值的类型"与"默认值的类型"合成一格（一样就是它，不一样两边都装箱）。
  * **`xs = []` 之后 `xs.append(v)`** —— python 里最常见的那一格写法。空表自己答不出
    元素类型，所以绑定那一趟从 `xs.append(v)` 认（`arr<v 的类型>`），
    赋值那一句再按认出来的类型造一格空的。语句是按次序扫的，够用。
  判据：`ext/python/examples/builtins.py` 三条腿与 python3 逐字节相同（29 行）。
  明说的不足：`.split()` 不带分隔符那一档（按连续空白切、首尾空段不算 —— 与带分隔符
  是两条规矩）、`.lower()`（方言只有 `supper`，要一格对称的 `slower`）、
  `round(x, n)`、`int("42")` / `float("2.5")`（串转数要走借来的 `pystrtod`）、
  `tuple()`（没有元组这一档）。

* **`for i, v in enumerate(xs)` 与 `for a, b in zip(a, b)`**。python 里这两个交的是
  **一串元组**，而这一层没有元组这一档 —— 可这两种写法落下去都只是**一格下标循环**
  （enumerate 的第一格就是下标，zip 是两张表同一个下标），所以不必先有元组。
  `zip` 走到**短的那一张**为止；`enumerate(xs, start)` 的第一格是 `下标 + start`；
  两个都收表与串。判据在 `builtins.py` 尾部。
  别的拆包（`for k, v in d.items()`、三格以上的目标）还没接 ——
  前者卡在"走一遍字典的键"那一格上（见下）。

* **老式的 `%` 格式化**（`ext/python/adapter/percent.js` + `expr.js` 的 `percentOf`）。
  python 这一族照的是 C 的 printf，而**方言里那几格串算子本来就是 C 的那几个转换** ——
  `sfix` = `%.*f`、`ssci` = `%.*e`、`sgen` = `%.*g`、`sbase` = `%x` / `%o`（小写，
  要大写裹一层 `supper`）。所以 adapter 不自己算数字的文本，只管切格式串、挑算子、补宽度。
  接了的：`%s %r %d %i %f %e %g %x %X %o %%`，标志 `-` / `0` / `+`，宽度与精度
  （写成数字的那一档）。`0` 补零**补在符号后头**（`"%05d" % -12` 是 `-0012`，
  不是 `00-12` —— 这一条是拿 python3 比出来的）。
  判据：`ext/python/examples/percent.py` 三条腿与 python3 逐字节相同（26 行）。
  明说的不足：**格式串要是编译期的字面量**（转换字母决定发哪一格算子；运行期的格式串要
  一台运行期的格式化机器 —— 那是 CPython 的 `unicodeobject.c` 里那一大段）；
  `*`（宽度从实参来）、`#`、`%(名字)s` 那一族没接。

### 下一刀，按顺序

1. **箱子里的函数拆出来调**（`(asfn …)` 那一格 —— 于是 `f = g` 之后 `f()` 走得通，
   与 lua 的元表同一条路）。`asfn` 要多给一格签名（箱子里只记着"这是函数"），
   所以 adapter 得先知道那一格该是什么签名。
2. **方言的字段收 dyn**（`src/core/sexpr/lower.js` 的字段白名单里没有它）。
   量到的地方：`Point(3, 4)` 与 `Point(1.5, 2.5)` 混着造 —— 类**不按实参单态化**
   （一格 `(class …)` 只有一份字段表），所以字段该退到 dyn，而那一层当场拒。
   现在 adapter 在自己这一侧报清楚并让人加标注；`sizeOf(dynamic) = 24` 已经有了，
   剩下的是 `structLayout` / 零值 / 四条腿各自的字段读写要一起验。
4. **走一遍字典的键**（`for k in d` / `d.keys()` / `print(d)` 全卡在这一格）。
   查过一遍，缺口的位置很具体：**运行时那一半早就有**
   （`omni_container.h:215` 的 `NAME##_keys`，而且 `sexpr/lower.js:321-323` 每登记一格
   `(dict K V)` 都顺手登记 `listType(k)`，**就是为了让生成的 C 里 `keys()` 编得过**），
   `keys` 这格 Builtin 在 backend-c / backend-js / interp 三条腿上也都认。
   卡的是**类型**：`_keys` 交出来的是 `list<K>`，而方言里只有 `(arr T)` 这一档，
   `list` 这个词根本没有。两条出路都要先定下来：
   给方言加 `list` 那一档（两种数组会把整层搞乱），还是让 `(dkeys D)` 交 `(arr K)`
   并在 OIR 里插一格 list→arr 的转换节点（现在没有这样的节点）。
   这一格不接，`print(dict)` 与 `for k in d` 就都还报"还没接"。
5. **把借来的那份 `libomnipy` 接到语言里**。现在 `str(float)` 已经与 CPython 逐字节相同了
   （走我们自己那三份 `py_repr`），所以这一刀**不再是正确性问题**，而是"借来的那一半要
   真用上"：接上之后浮点格式化只有一份实现（CPython 的），三条腿不必各守一份。
   卡点还在：`cabi` 的类型词只有 `i32 i64 f64 ptr void`，**出串那一格怎么过**得先定
   （回 `ptr` 再转 `string`，还是给方言加一格算子），而且 `ccall` 在 JS 那条腿上要 N-API
   扩展（ADR-0038）—— 也就是说接上之后 `omni run` / `--mode js` 会退档，得先想清这一点。
6. **再借两格**：`Objects/longobject.c`（大整数 —— 现在的 int 是 64 位，python 的没有上界）
   与 `Modules/_sre/`（正则）。这两格比浮点那一格耦合深，得先有"借来的东西怎么持有对象"
   那一层。
7. **`try` / `with` / `match` / 生成器 / 闭包 / 装饰器** —— adapter 现在对它们当场报
   "还没接"，不猜。

## 三、口径

- 版本钉在参考树上（现在 3.16.0a0），不钉本机装的那个 python。那棵树里已经有
  PEP 810 的 `lazy import`（标准库 71 份在用）、PEP 798 的 `[*i for i in xs]`、
  PEP 758 的 `except A, B:` —— 本机的 3.13 没有这些。
- 软关键字（`match` / `case` / `type` / `lazy`）进关键字表，再从语法里的 `sname`
  那一条当普通名字放回去。理由与代价写在 `python.grammar` 的关键字段。
- 语法**收得比 python 宽**几处（海象出现在语句位、match 的模式借表达式语法）。
  "解析不是校验" —— 那几格由 adapter 判并当场报，不由语法判。
