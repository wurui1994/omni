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
  是两条规矩）、`round(x, n)`、`int("42")` / `float("2.5")`（串转数要走借来的
  `pystrtod`）、`tuple()`（没有元组这一档）。

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

* **表上那几格"找"与"改"，以及 `in` 落在表上**。方言里表那一族只有
  `anew` / `aget` / `aset` / `apush` / `alen` / `apop` —— 所以
  `v in xs`、`.index(v)`、`.count(v)`、`.reverse()`、`.extend(ys)`、`.clear()`、
  `.insert(i, v)`、`.remove(v)`、`.pop(i)` 全是**现场发一趟循环**。
  改原表的那几格在 python 里交 `None`，所以只当语句用（`LIST_MUT` 那张表）；
  当表达式用会当场说清。比法与 `==` 同一条（`cmpEq` —— 元素是箱子时按标签分派），
  所以异质的表也走得通。串上顺带补了 `.ljust` / `.rjust` / `.zfill`。
  判据：`ext/python/examples/listmut.py` 三条腿与 python3 逐字节相同。
  几条口径是拿 python3 比出来的：`insert` 的下标**夹到 `[0, len]`**（超了就是追加）、
  `index` 找不到是 ValueError（这儿 `(fail …)`）、`zfill` 够宽了原样不截。

* **`(slower S)`** —— 方言加一格，与 `(supper S)` 完全对称（只动 ASCII 的 A-Z，
  两个函数只差那一对常量）。落在七处：`sexpr/lower.js`、`lower/sx.js` 的 `SX_ARITY` 与
  构造器、`lower/ty-of.js`、`backend-c` / `backend-js`（含 prelude 的 `$str_lower`）/
  `interp`（`asciiLower`）/ `backend-llvm` 的符号表、`runtime/omni_str.c` 的
  `omni_str_lower`。判据：`tests/sexpr/cases/57-slower.sx` 三条腿逐字节相同。
  python 的 `.lower()` 接到它上面。

  **顺带量出来一处会答错的地方（不是"还没接"）**：`.upper()` / `.lower()` 在
  **非 ASCII 上与 python 不一样** —— `"äöü".upper()` 我们交 `äöü`（python 交 `ÄÖÜ`）、
  `"Straße".upper()` 我们交 `STRAßE`（python 交 `STRASSE`，长度还变了）。
  `.upper()` 这一处是**早就在的**，这一刀只是把它照出来。
  根因是方言那两格定成 ASCII-only —— 而那正是它们四条腿能是同一个函数的前提
  （`tolower` 看 locale、JS 的 `toLowerCase()` 是 Unicode 的）。
  要对得上得借 `Objects/unicodeobject.c` 的大小写映射表（§一 的借用名单里本来就有它）。
  在那之前**只有 ASCII 那一档是对的**，`listmut.py` 里只钉 ASCII。

* **`(dkeys D)` —— 走一遍字典的键**。方言加一格：交**所有的键**，一格 `(arr K)`，
  次序是**插入序**（与 python 3.7+ 的 dict 同一条）。`for k in d` / `d.keys()` /
  `d.values()` / `for k, v in d.items()` / `print(d)` / `str(d)` 都落在它上头。
  判据：`tests/sexpr/cases/58-dkeys.sx` 四条腿（run / run-c / interp / interp --mir）
  逐字节相同；`ext/python/examples/dictwalk.py` 三条腿与 python3 逐字节相同。

  查过之后的落法比原先估的小得多：**js 与解释两条腿一行转换都不用** —— 那边 `arr` 与
  `list` 同是一个裸 JS 数组（`$anew` 回 `[]`、`arrNew` 回 `[]`），所以 `keys_arr`
  与 `keys` 逐字同一句。只有 **C 那条腿要抄一遍**：`omni_arr_*` 是
  `{len, cap, items}`、list 是 `{items, len, cap}`，**字段顺序不同**，指针一转类型
  `len` 就读到 `items` 上去了。于是 `backend-c` 的 `containerDefine` 逐字典生成一个
  `static <字典>_keysarr`，里头调运行时那个 `_keys`（死格的跳过逻辑留在它那儿，
  共享宏一个字不动）再抄进 `omni_arr_*`。原先记的两条出路（给方言加 `list` 那一档 /
  在 OIR 里插一格转换节点）都不用走。

  `.values()` 没给方言加算子：它是键表的一个推论（`builtins.js` 的 `valuesList`
  现场发一趟循环，逐个 `dget`）。`.items()` 只在 `for k, v in d.items():` 里接
  （走 `pairIter` 那条路，与 `enumerate` / `zip` 同一格下标循环）——
  当值用要有元组，这一层没有元组那一档。

  **明说的不足**（两条，都拿 python3 比出来的）：
  `d.keys()` 在 python 里是个**视图**（`dict_keys([...])`，改字典之后跟着变、
  `print` 出来带那层壳），我们交的是抄出来的一张表 —— `list(d.keys())` 那种写法
  两边逐字相同，裸 `print(d.keys())` 不同。另一条是同一个作用域里**同一个名字**
  当两张键类型不同的字典的循环变量：那个名字会合成 dyn（ADR-0008），而方言的
  `dget` 的键要静态对上，于是报「dget 的键要是 string，这里是 dynamic」——
  各起一个名字就行（`dictwalk.py` 里就是这么写的）。

* **`(ddel D K)` —— 字典删一格**。答的是**原先在不在**（不是语句，与 `dset` 那一格
  不同）：`del d[k]` 与 `d.pop(k)` 在 python 里键不在都是 KeyError，那一格布尔是真要
  拿去判的。来路与 `dkeys` 同一条 —— 运行时那个 `_remove` 连墓碑（`idx[h] = -1`）
  与小表那条没有索引的路都写好了，`remove` 这格内建三条腿也都认，缺的只是方言的开口。

  python 那一侧接上四种写法：`del d[k]`（键不在报 `KeyError: 'z'`，与 python 末行同形）、
  `del xs[i]`（表那一格没有新算子，往前挪一格再 `apop`，与 `.pop(i)` 同一条）、
  `d.pop(k)` / `d.pop(k, 默认值)`（`dictPopOf` —— `dget` 必须排在 `ddel` 前面，
  删过就读不到了）、`d.clear()`（走一遍抄出来的键表逐个 `ddel`；python 里它交 None，
  所以只当语句用）。一句删几格（`del d["a"], xs[0]`）也走得通。

  判据：`tests/sexpr/cases/59-ddel.sx` 四条腿逐字节相同（那一份专门钉"删过再加，
  键的次序还是插入序" —— 删只灭 `live[i]`、不挪 `keys[]`）；
  `ext/python/examples/dictdel.py` 三条腿与 python3 逐字节相同。

  **明说的不足**：`del 名字` 不接 —— 那要有"这一格还绑着没有"这一层，而方言里一格
  变量就是一格槽位，没有那一档（猜一个，比如置零值，会让后面读到的东西看着像对的）。
  `del xs[1:3]` 也没接。  两条错的路（KeyError / 越界）只保证**会当场炸**，
  那句话与 python 的 traceback 不逐字相同。

* **推导式**（`[e for x in xs if p]` / `{k: v for …}` / `(e for x in xs)`）。
  **方言一格新算子都不加** —— `anew` / `apush` / `dnew` / `dset` 加一趟 `while` 就够，
  与 `builtins.js` 里 sum / sorted 那几格同一条办法。目标位收一格名字，或者两格名字配
  `enumerate` / `zip` / `d.items()`（与 `for` 语句那一侧同一份名单）。
  可迭代收表 / 串 / `range(…)` / 字典（字典先转键表）；`if` 从句可以挨着写几个；
  `for` 可以嵌套，后一格的可迭代能用前一格的目标。
  判据：`ext/python/examples/comprehensions.py` 三条腿与 python3 逐字节相同。

  **循环变量不漏到外头**这一条是自己挑出来做对的：python 3 里推导式有自己的作用域，
  办法是把那个名字在推导式里临时改成一格新名（ctx 上新增的 `alias`）**并单开一层作用域**，
  发完指回去。不改名的后果是真会答错 —— 外头的 `x` 与推导式里的 `x` 会被合成一格 dyn
  （ADR-0008），于是 `x = 99` 之后印出来的是表里最后那一格。
  单开那一层也是量出来的：**模块级那张表 `C.globals` 按 python 的原名存**
  （`lookup` 的兜底那一句用的是 `n` 而不是 `C.ref(n)`），只改 `ref` 的话
  `SEED = [x * 10 for x in BASE]` 写在模块级时 `x` 查不到，整条推导式答 null，
  `SEED` 那格全局就没声明（症状是 `.sx` 那侧报"未声明的变量 'SEED'"）。

  **明说的不足**：生成器表达式当成"立刻算完的一张表"（python 是懒的）——
  差别只在无穷的生成器（我们会挂住）与副作用的次序上露头，`sum(x * x for x in xs)`
  这类用法两边一样。集合推导式没接（方言里 `set` 那一族没开口）、
  `[*i for i in xs]`（PEP 798）没接、`async for` 没接。

* **表上的拼接与重复，加上剩下那几个内建**。`xs + ys` / `xs * n`（都是**新造一张表**，
  两边不动）、`reversed(xs)`、`repr(x)`、`hex` / `oct` / `bin`、`round(x, n)`、
  `sum(xs, start)`、带步长的切片（`s[::2]` / `s[::-1]`）。方言一格新算子都没加 ——
  `hex` 那一族落在早就有的 `(sbase E 进制)` 上，别的都是现场发一趟循环。
  判据：`ext/python/examples/listops.py` 三条腿与 python3 逐字节相同。

  **这一刀里唯一一处"从前会答错"的是 `round()`**：python 的 round 是**半数取偶**
  （`round(2.5)` 是 2、`round(-2.5)` 是 -2），而方言的 `(rmath "round")` 是 C 的
  "远离零"（交 3）。量出来之后用 floor / fmod 拼出半数取偶（`builtins.js` 的
  `bankRound`）——**没给方言加 `nearbyint`**：那要五条腿各写一遍，而 JS 的
  `Math.round` 也不是半数取偶。

  另外顺手补了一处**既有的**坑：`sliceOf` 从前把被切的那一格重复发了几遍
  （长度一次、取元素一次），被切的东西是表字面量时里头那格 `let` 就发了两次 ——
  `[1, 2, 3, 4][::2]` 报「'list81' 在这一层已经声明过了」。现在先把它钉成一格临时量。

  **明说的不足**：两参 `round` 我们走二进制的乘除、CPython 走十进制
  （`_Py_dg_dtoa`）—— `round(2.675, 2)` python 交 2.67、我们交 2.68。
  根子不在 `bankRound`（`2.675 * 100.0` 在双精度里真是 267.5，两边的一参 round 都把
  它舍成 268），而在"该不该先转十进制" —— 那是接 `libomnipy` 那一刀的事。
  负步长的切片只接两头都省掉的写法（`s[::-1]`）：带显式两头的那一族还要另一套夹法，
  猜一个会静默给出错的一段。`xs + []` 里那个空表字面量照旧要先有一格标注。

* **命名实参与多目标赋值**。`f(b=2, a=1)` / `Point(y=4, x=3)` / `sorted(xs, reverse=True)` /
  `print(…, sep=, end=)`，加上 `a, b = x, y`（含 `a, b = b, a` 那个交换）。
  判据：`ext/python/examples/kwargs.py` 三条腿与 python3 逐字节相同。

  **命名实参只是换个次序** —— 这一层没有"默认值"那一档（`def` 的形参带默认值当场报），
  所以按形参名字排回位置上就完事（`kwOrder`）。要紧的是**三处都要排**：
  建 IR 那一趟、问类型那一趟（`tyOfCall`）、以及**收单态化实例那一趟**
  （`collectInsts`）—— 漏掉最后一处的话按次序取的类型会错位，挑出来的实例是错的那一格。
  内建不走这条通路（各有各的规矩）：`print(sep=, end=)` 与 `sorted(reverse=)` 在
  各自那一处收；`sorted(reverse=…)` 只收 True / False 字面量（升序降序是两条循环，
  与 `range` 的步长同一条理由）。

  多目标赋值那一半发射侧本来就对（右边全算完再赋 —— `a, b = b, a` 靠的就是这一条），
  缺的是**绑定那一趟**：`bindTarget` 的元组那一支把整个右边的类型按到每一格名字上，
  而 `tyOfCst((tuple …))` 答 null，于是一格都没绑，落到 `.sx` 那侧报"未声明的变量 'a'"。
  现在两边同长时逐格对着绑。

  **明说的不足**：`*args` / `**kw`（形参与实参两侧都是）没接；形参带默认值没接；
  `sorted(key=…)` 没接（要有函数当值那一档）；元组本身还没有那一档，所以
  `t = (1, 2)` 与 `return a, b` 照旧报"还没接" —— 多目标赋值是把它**绕开**了
  （两边逐格对着走，中间不真造一格元组）。

* **改原容器的那几格、`for…else`、`isinstance`**。`xs.sort()` / `.sort(reverse=True)`
  （**就地**排，`sorted()` 才抄一份）、`d.update(other)`、`d.setdefault(k, v)`、
  `for…else` / `while…else`、`isinstance(x, T)`。方言一格新算子都没加。
  判据：`ext/python/examples/moreops.py` 三条腿与 python3 逐字节相同。

  `for…else` 那一支是"**没 break 就跑**"，不是"循环完就跑"。落法是一格布尔旗子：
  进循环前置 true，体里**属于这一层**的每个 `break` 前面补一句置 false，出来之后
  `if 旗子:`。"属于这一层"要紧 —— 递归进 `if` / `block` 那几层，**不进**嵌套的
  `for` / `while`（那里头的 break 跳的是里层那一圈）。

  `isinstance` 静态的那一档在**编译期**就答得出（这一层的类型是确定的），一格箱子那一档
  问 `(dtag …)`。`isinstance(True, int)` 照 python 交 True（bool 是 int 的子类）。

  **明说的不足**：`.sort(key=…)` 没接（同 `sorted`）；`isinstance` 的第二格收元组
  （`isinstance(x, (int, str))`）没接；`type(x)` 没接。

* **元组**。`(1, "a")` / `t[0]` / `a, b = t` / `return a, b` / 逐格比的 `==` /
  `len(t)` / `for a, b in ts` / `zip` / `enumerate` / `d.items()` 当值用 / 推导式里。
  判据：`ext/python/examples/tuples.py` 三条腿与 python3 逐字节相同。

  落法：**按形状生成一格记录** —— `(1, "a")` 的类型是 `Tup2_int_string`，字段 `_0` / `_1`。
  为什么不给标准 IR 加一档"元组"：元组就是定长、逐格各有自己类型的东西，那正是记录，
  而记录这一档从声明、字段读写到四条腿早就通了。引用语义（`cnew`）—— python 的元组
  不可改，"是不是同一份存储"观察不到。字段名是 `_0` / `_1`，而方言的字段是**名字**
  不是下标，所以 `t[0]` 的下标**要写成字面量**（python 代码里几乎总是；负的编译期折过去）。

  **量出来的三条**：
  1. `(1, 2) == (1, 2)` 原先会静默答 **False** —— 落成"是不是同一个句柄"了。现在逐格比
     （`cmpOne` 里那一支）。形状不同的两格元组 `==` 恒 False，与 python 同。
  2. `inferFields` 会把元组那几格记录的字段**抹成空**（它从标注与 `__init__` 认字段，
     元组两样都没有）—— 先报"类 Tup2_int_string 至少要有一个字段"，接着字段读回来的
     类型也跟着错（`a, b = t` 报"b 先装 string 后装 int"）。那一趟要跳过元组。
  3. 元组的声明是**建 IR 的时候**才登记的，所以 `pyToIR` 里"先摆声明再建体"的次序得
     反过来（先建体、再摆声明）—— 不然声明表看不见它们。

  **明说的不足**：空元组 `()` 不收（记录至少要一格字段）；切元组没接；
  下标不是字面量的 `t[i]` 不收；`zip` 只收两格。
  （`<` / `>` 与 `sorted()` 排元组当时也没接 —— 后面那一刀补上了，见下。）

* **f-string 的格式说明**（`:>10.3f` / `:05d` / `:^6` / `:x` / `:+.2f` / `:*^8`）。
  原先只接 `:.Nf`。现在收下那套微语言的一块：填充 + 对齐（`< > ^`）、符号
  （`+` / `-` / 空格）、`0`、宽度、`.精度`、类型（`d f s x X o b`）。
  方言一格新算子都没加 —— `sfix` / `sbase` / `supper` / `srep` / `ssub` 拼出来的。
  判据：`ext/python/examples/fstring.py` 三条腿与 python3 逐字节相同。

  几条口径是拿 python3 比出来的：**没写对齐时数右对齐、别的左对齐**；
  `:.N` 落在串上是**截到 N 个字符**（不是小数位）；`:^N` 的**余数放右边**；
  `:0N` 的零补在符号后面（`-1.5:08.2f` 是 `-0001.50`）；空的格式说明（`{7:}`）
  与没写是一回事。

  **明说没收的**（都当场报，不猜）：`#`（`0x` 前缀）、`,`（千分位）、`=`（符号后填充）、
  `e` / `g` / `%` / `n`、宽度或精度写成 `{}`（从实参来）。

* **串上剩下那一批方法，加上 `.copy()`**。`.title()` / `.capitalize()` / `.swapcase()`、
  `.strip(chars)` / `.lstrip(chars)` / `.rstrip(chars)`、`.isalpha()` / `.isdigit()` /
  `.isalnum()` / `.isspace()` / `.isupper()` / `.islower()`、`.rfind()` / `.index()` /
  `.rindex()`、`.removeprefix()` / `.removesuffix()`、`.center()`，以及表与字典的 `.copy()`。
  方言一格新算子都没加。判据：`ext/python/examples/strmethods.py` 三条腿与 python3 逐字节相同。

  **拿 python3 比出来的三条口径**（照着文档写会写错的）：
  - `.title()` 的边界是"前一格不是**字母**"，数字也算边界 —— `"a1b".title()` 是 `A1B`；
  - `.isupper()` 是"**有至少一格大写、而且没有小写**"，不是"每一格都大写" ——
    `"A1".isupper()` 是 True、`"1".isupper()` 是 False。`.isalpha()` 那一族反过来：
    每一格都要在类里、而且串非空；
  - **`str.center()` 与 f-string 的 `:^` 摆法不一样**：`'ab'.center(7,'*')` 是 `***ab**`
    （多的在左），`f"{'ab':*^7}"` 是 `**ab***`（多的在右）。

  **明说的不足**：只动 ASCII（同 `.upper()` / `.lower()`，要借 `unicodeobject.c`）；
  `.split()` 不带分隔符、`.split(sep, maxsplit)`、`.partition()`、`.format()`、
  `.encode()`、`.count(sub, start, end)` 那一族带范围的都还没接；
  `.center(w)` 的 w 要写成字面量。

* **`pow` / `list(…)` / `dict(…)` / `.split(sep, maxsplit)`**。
  判据：`ext/python/examples/builtins.py` 三条腿与 python3 逐字节相同。

  **顺带修了一处会答错的**：`list(xs)` 从前直接交**原表**（"先当同一格"），
  所以 `ys = list(xs); ys.append(v)` 把 xs 也改了 —— python 的 `list()` 是浅拷贝。
  现在抄一份。`list(串)` 拆成一格一个字符、`list(字典)` 交键表。

  `dict(一串两格的元组)` 走元组那一档（键重了后一格盖前一格）。`dict(a=1)` 那种
  命名实参没接。`type(x)` **明说不接** —— 这一层没有"类型当值"那一档，要判类型用
  `isinstance`；照 `type(x)` 交个串出来会让 `type(x) is int` 静默答错。

* **元组的字典序，以及"怎么比"递下去**。`(1, 2) < (1, 3)` / `<=` / `>` / `>=`、
  `min(ps)` / `max(ps)` / `min(a, b)`、`sorted(ps)` / `sorted(ps, reverse=True)` /
  `ps.sort()`。判据：`ext/python/examples/tuples.py` 三条腿与 python3 逐字节相同。

  字典序落成**一棵短路的纯表达式**，不发分支：
  `a < b` ⇒ `a0 < b0 || (a0 == b0 && (a1 < b1 || (a1 == b1 && …)))`；最后一格用算子
  本身（`<=` 只在那儿才允许"到底都相等也算真"），前面各格一律用严格的那一版。
  `||` / `&&` 本来就短路，所以"第一处不同的那一格说了算"是白来的。

  **顺带修了一处会答错的**：`min([(2, "b"), (1, "a")])` 从前答 `(2, 'b')` ——
  `pickList` / `sortedOf` / `sortStmts` 直接发的是方言的 `<`，落在记录上就是**比句柄**，
  三条腿各自答一个样（JS 那条腿两个对象比 `<` 恒假，于是留下第一格）。现在这三处都收一格
  `less(a, b)`，由 `expr.js` 递 `cmpOne('<', …)` 进来 —— 谁会比、怎么比只有一处说得清。
  排序之前先过 `needOrd`：有比法的就三类标量加**同形状的元组**，别的当场报，不静默答错。

  明说的不足：**形状不同**的两格元组比大小不收（python 是逐格比到第一处不同、都一样就
  短的那格小，而对上的两格类型不同那一处还会 TypeError）；链式比较里中间那一格要是元组
  字面量不收（那一格只算一遍，所以要求它是纯的）；`sorted(key=…)` 还是没接（要"函数当值"）。

* **`.partition()` / `.rpartition()` / `.count()` / `.replace(a, b, n)` / `.split()`**。
  判据：`ext/python/examples/strmethods.py` 三条腿与 python3 逐字节相同。

  `.partition()` 交**三格串的元组** —— 上一刀把元组落成记录之后这一格几乎是白来的
  （`tupleRec([STR, STR, STR])` 加 `sfind` / `rfindOf` / `ssub`）。量出来的两条：
  找不到分隔符时**两边站的位置不对称**（`partition` 交 `(s, '', '')`，`rpartition` 交
  `('', '', s)`）；而且**不能用三元** —— 这一层的三元两支都会算，`ssub(s, 0, -1)` 当场炸，
  所以三格先各落一格临时量、再发一句 `if`。

  `.count()` 数**不重叠**的那几段（`"aaa".count("aa")` 是 1），空的那一段数的是"位置数"
  （`"abc".count("")` 是 4）；`start` / `end` 按 python 的规矩折（负的加长度、再夹进
  `[0, len]`）。`.replace(a, b, n)` / `.split(sep, maxsplit)` 同一条办法：一格计数器，
  到数了就把 `hit` 摆成 -1，剩下的整段算最后一格。

  `.split()` 不带分隔符（或者 `.split(None)` / `.split(None, n)`）是**另一趟循环**，
  不是"找分隔符"：按连续空白切、首尾的空段不算（`" ".split()` 是空表，
  而 `" ".split(" ")` 是两格空串）。所以它要在带分隔符那一支**之前**拦。

  明说的不足：`.format()` 与 `.encode()` 还没接；`maxsplit` / `count` 要写成整数字面量
  （两种走法是两条循环，得在编译期定）。

* **比两张表 / 两格字典**（`==` / `!=` 逐格比，`<` / `<=` / `>` / `>=` 按字典序）。
  判据：`ext/python/examples/listops.py` 三条腿与 python3 逐字节相同。

  **又一处静默答错的**：`[1, 2] == [1, 2]` 从前答 **False** —— 方言里没有"比容器"这一族
  算子，落下去就是**比句柄**，与元组那一处同一个病。这三处（`listEqOf` / `listCmpOf` /
  `dictEqOf`）现场发一趟走一遍，比法还是那一格 `cmpOne` 递下去 —— 所以元素是箱子、
  元组、又一张表都自动对（量过 `[[1], [2]] == [[1], [2]]` 与 `[(1, 2)] == [(1, 2)]`）。

  表的字典序与元组那一棵树不同：长度要到运行时才知道，所以是循环加一格 `done` 顶着
  （方言里没有"从循环里带值出来"那一档，`break` 只管跳）。前缀一路相等时**长度说了算**，
  而且用的就是原来那个算子 —— `[1] < [1, 0]` 真、`[1, 2] <= [1, 2]` 真。

  字典只比相等：python 里字典没有大小之分（`d < e` 是 TypeError），所以那四格当场报。
  元素 / 值的类型对不上时 `==` 编译期就定成 False（`[1] == ["1"]`），而比大小当场报
  （python 会在第一处不同那里 TypeError）。

* **bool 当数用、`divmod()`、串上的挑与排**。
  判据：`ext/python/examples/numbers.py` 三条腿与 python3 逐字节相同。

  python 的 **bool 就是 int 的一种**（`True + True` 是 2、`2 ** True` 是 2），而方言里
  那是两档类型 —— 所以二元算术那一处见了 bool 就现折一格 `b ? 1 : 0`，`int(True)` 同。
  **位运算不折**：python 的 `True & True` 交的是 `True` 而不是 `1`，印出来不一样，
  那一格还是当场报（明说的不足）。顺带补了 `**` 的指数认 `True` / `False`
  为整数字面量 —— 不补的话 `2 ** True` 会交 `2.0`（折完就是"指数不是 num 词法"了）。

  `divmod(a, b)` 交一格两格的元组，取整与取模直接用 `//` / `%` 那两份
  （`floorDiv` / `pyMod`）—— python 的符号规矩不用再说一遍。

  `sorted("bca")` / `min("abc")` / `max("abc")` 走 `charsOf` 拆成字符表再交给原来那趟。

* **`str.format()`**。判据：`ext/python/examples/fstring.py` 三条腿与 python3 逐字节相同。

  模板**要是串字面量** —— 替换字段得在编译期拆开（每一格的说明各是一套代码，与 f-string
  同一条口径）。格式说明那一段**直接借 f-string 那一份 `fmtSpec`**：两处本来就是同一套
  规矩，各写一遍必然对不上。认的写法：`{}`（顺着数）、`{0}`（指名第几格）、`{!r}` / `{!s}`、
  `{:说明}`、`{{` / `}}`。

  明说的不足：按名字取（`{x}` / `.format(x=1)`）没接；说明里的宽度写成 `{}`（从实参来）
  没接 —— 与 f-string 欠的是同一批。`.encode()` 还是没接（要有 bytes 那一档）。

* **`int(串)` / `int(串, 进制)`**。判据：`ext/python/examples/builtins.py` 三条腿与
  python3 逐字节相同（错的那条另量：报的话与 CPython **逐字一样** ——
  `invalid literal for int() with base 10: '12x'`）。

  这一格**原先记成"要借 CPython 的 C"，那是记错了**：借 C 是为了浮点的"最短往返"
  （`dtoa`），而整数逐位乘加本来就是精确的。所以现场发一趟循环就够（`intOfStr`）。
  照 python 的规矩：两头空白许、`+` / `-` 许、数位之间的 `_` 许、`0x` / `0o` / `0b`
  前缀在进制对得上时吃掉（大小写都认）、一位有效数字都没有就 ValueError。

  `base` 要写成**编译期的字面量**（前缀与数位表都跟着它定），收 2..36；python 还许
  `base=0`（"看前缀猜"）那一档没接。超出 int64 的不管（要 bignum，见下面第 5 条）。

* **切元组**。判据：`ext/python/examples/tuples.py` 三条腿与 python3 逐字节相同。

  切元组是**编译期的事** —— 交出来的形状（几格、逐格什么类型）由三个边界定，所以三个
  边界都要写成字面量，算出下标清单后按新形状造一格记录。算哪几格照 python 自己那套
  `slice.indices` **抄**：负的加长度再夹住，而且**步长为负时两头的夹法与正的不一样**
  （`t[::-1]` 是从 `n-1` 到 `-1`，不是从 `n` 到 `0`）。
  同一份清单也给类型推断那一趟用（`tyOfCst` 的 `index` 那一支），不然 `u = t[1:]`
  在模块级推不出类型。

  明说的不足：切出来是**空的**那几刀不收（`t[5:]` 在 python 里是 `()`，而记录至少要有
  一格字段 —— 与空元组字面量同一个卡点）。

* **形参的默认值，以及"实参是局部变量也要收得到实例"**。
  判据：`ext/python/examples/kwargs.py` 三条腿与 python3 逐字节相同。

  默认值与命名实参**走同一处**（`kwOrder`）：命名的排回位置上，缺的那几格把 `def` 上那棵
  **默认值的原文树**补上去。这么办与单态化正好合得上 —— `f(1)` 与 `f(1, 5)` 补完都是两格
  实参，推出来是同一格实例。代价是默认值**只收字面量**：python 的默认值是 `def` 那一刻
  算一遍、以后共享同一格，`def f(xs=[])` 两次调用改的是同一张表，而展开就成了两张 ——
  字面量看不出区别，可变的差得是根本的，所以那一档当场报，不悄悄换语义。

  **顺带修了一处更大的**：`collectInsts` 原先是**平铺全树**扫调用点的，所以调用点上的
  局部变量在 `tyOfCst` 那儿答 null —— 于是 `x = 3` 之后 `dbl(x)` 报"`dbl(int)` 没有对得上
  的那一格（生成的是 (x)）"，`b = Box(3)` 之后 `b.area(2)` 报"对不上那一格的形参"。
  也就是说**实参只要是局部变量就不算**，而真的 python 代码里几乎全是局部变量。
  现在多走一趟：按每格函数实例 `push` 一层、绑上形参、`scanBinds` 走一遍体（与 `inferRet`
  同一条办法），再在那一层里扫里头的调用点。体里的名字一次全绑上（不按语句次序）——
  与推断跑三轮那条口径一致：宁可多收一格实例，也别漏。

  还量到一处读错：`(p (n a) (default e))` 里没写标注时**第二格就是 `(default …)` 本身**，
  照 `kids(p)[1]` 读会把默认值当标注（`annotTok`）。

  明说的不足：`*args` / `**kw` / 只能按名字给的那一档（`def f(*, c=3)`）还没接；
  两个类有同名方法而默认值不同时，那一处不补（`calleeSig` 回 `null`，退回从前的行为）。

### 下一刀，按顺序

1. **箱子里的函数拆出来调**（`(asfn …)` 那一格 —— 于是 `f = g` 之后 `f()` 走得通，
   与 lua 的元表同一条路）。`asfn` 要多给一格签名（箱子里只记着"这是函数"），
   所以 adapter 得先知道那一格该是什么签名。
2. **方言的字段收 dyn**（`src/core/sexpr/lower.js` 的字段白名单里没有它）。
   量到的地方：`Point(3, 4)` 与 `Point(1.5, 2.5)` 混着造 —— 类**不按实参单态化**
   （一格 `(class …)` 只有一份字段表），所以字段该退到 dyn，而那一层当场拒。
   现在 adapter 在自己这一侧报清楚并让人加标注；`sizeOf(dynamic) = 24` 已经有了，
   剩下的是 `structLayout` / 零值 / 四条腿各自的字段读写要一起验。
3. **字典的键收 dyn**。键那一侧现在只收 int 与 string（`(dict K V) 的键只能是 int 或
   string`），所以"同一个循环变量走两张键类型不同的字典"那一条挡在这儿。
   删那一格已经开了（`ddel`，见上）。
4. **把借来的那份 `libomnipy` 接到语言里**。现在 `str(float)` 已经与 CPython 逐字节相同了
   （走我们自己那三份 `py_repr`），所以这一刀**不再是正确性问题**，而是"借来的那一半要
   真用上"：接上之后浮点格式化只有一份实现（CPython 的），三条腿不必各守一份。
   卡点还在：`cabi` 的类型词只有 `i32 i64 f64 ptr void`，**出串那一格怎么过**得先定
   （回 `ptr` 再转 `string`，还是给方言加一格算子），而且 `ccall` 在 JS 那条腿上要 N-API
   扩展（ADR-0038）—— 也就是说接上之后 `omni run` / `--mode js` 会退档，得先想清这一点。
5. **再借两格**：`Objects/longobject.c`（大整数 —— 现在的 int 是 64 位，python 的没有上界）
   与 `Modules/_sre/`（正则）。这两格比浮点那一格耦合深，得先有"借来的东西怎么持有对象"
   那一层。
6. **`try` / `with` / `match` / 生成器 / 闭包 / 装饰器** —— adapter 现在对它们当场报
   "还没接"，不猜。

## 三、口径

- 版本钉在参考树上（现在 3.16.0a0），不钉本机装的那个 python。那棵树里已经有
  PEP 810 的 `lazy import`（标准库 71 份在用）、PEP 798 的 `[*i for i in xs]`、
  PEP 758 的 `except A, B:` —— 本机的 3.13 没有这些。
- 软关键字（`match` / `case` / `type` / `lazy`）进关键字表，再从语法里的 `sname`
  那一条当普通名字放回去。理由与代价写在 `python.grammar` 的关键字段。
- 语法**收得比 python 宽**几处（海象出现在语句位、match 的模式借表达式语法）。
  "解析不是校验" —— 那几格由 adapter 判并当场报，不由语法判。
