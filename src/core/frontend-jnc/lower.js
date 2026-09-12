// Omni stage0 — jancy 前端：jnc 语法树 -> 核心 S 表达式方言（ADR-0016 分步 7）
//
// ## 这一份存在的理由与 asy 那一份相同
//
// 语法那一半是数据（`jnc.grammar`，从七份 `.llk` 转写，那份文件的头里写着 12 处 resolver
// 各自的处置）。这里只做**类型定向**的那一半：jancy 的 `*p` 是"解引用"还是"乘法"、
// `p[i]` 是指针下标还是数组下标、`p - q` 是指针差还是整数减法 —— 每一条都要先知道
// 子表达式的类型，而类型是符号表的事，动作模板里没有符号表。
//
// 出来的仍然是核心方言文本，所以五条腿一条都不知道 jancy 存在。
//
// ## 这一路**没有 oracle**（ADR-0016）
//
// jancy 的 `jnc` 要 LLVM + axl 才编得出来。所以期望输出由我们自己写在 tests/jnc/ 里，
// 每一条注明出处（引哪一份文档、哪一个 `.llk` 规则、哪一份语料）。这与 asy 那条线是
// 两条不同的纪律 —— 那边"每一条都要量"，这边"每一条都要有出处"。
//
// ## 第一刀的边界（都是**刻意**的，不是漏的）
//
// 收：**定宽有符号整数** `char` / `short` / `int` / `long` / `intptr`（8 / 16 / 32 / 64 位，
// 见下面「定宽整数」那一段）、`double`（-> real）、`bool`、`void`、
// `struct`（值语义，降成方言的 `(struct …)`）、函数（含递归、形参、返回值）、
// 局部量与赋值、`+ - * / %` 与比较、`&& || !`、一元 `- ~`、`++ --`（前后缀都收，
// 但只作为语句/for 的步进）、复合赋值 `+= -= *= /= %=`（位运算与移位那五个
// `&= |= ^= <<= >>=` 是第三十五刀）、`? :`、if/else、while、
// do-while、C 式 for、`switch`（贯穿、中间的 default、每组一层作用域，第三十六刀）、
// break/continue/return、**真值化**（`if (n)` / `if (p)` /
// `!n` / `n && m` —— jancy 把整数与指针当条件用，这一层照它办）、
// **指针那一族**（这一刀的主题）：`T*` -> `(ptr T)`、`T thin*` -> `(tptr T)`、
// `new T[n]` -> `(pnew …)`、`*p` 读写、`p[i]` 读写（= `*(p + i)`，jancy 的下标
// 本来就是这个语义）、`p + i` / `p - i` / `p++`、`p - q`（指针差，按元素）、
// `p == q` 与 `p == null`、`p->f` 与 `(*p).f` 读写、`unsafe { … }`、
// `(int thin*)p`（fat 转 thin，-> `(pthin p)`）、`&x` / `&*p` / `&p[i]` / `&p->f`
// （取地址；局部量按 jancy 自己的办法提到堆上，见 addrOf 那一段）、**定长数组**
// `int a[3]` / `int a[] = { … }` / `int c[2];`（下标读写、花括号初值、退化成指针，
// 见 tArr 与 localDeclCurly 那两段）、**多维数组** `int a[3][4]` / `int d[2][2][2]`
// （一格里躺的是**一整块**的地址 `(ptr (blk T N))`，`a[i]` 是块里的第 i 格、它自己又是一块，
// 退化成 `T*` 是方言的一句 `(pelem …)`；声明符的方括号从右往左套，见 tyText 与 declarator）、
// **数组的地址** `&a` / `(*&a)[i]` / `*&a`（一个字都不用发 —— 那一格里放的就是块地址，
// 见 addrOf 开头那一段；`int(*pa)[3]` 这种声明**jancy 自己的语法里就没有**，见边界表）、
// **数组是按值的一整块**（`int b[3] = a;` / `c = a` / `void f(int v[3])` / `int g() [3]` /
// `int rows[2][3] = { a, b }` —— 这一条上 jancy **不是 C**：形参不退化成 `T*`，抄一份由
// copyArr 逐格做，出处见 copyVal 那一段）、
// **数组字段**（`int m_v[4]` / `int m_grid[2][3]` / `b->m_v[i]` / `Box c = b` 深抄 /
// 字段那一块退化成 `int*` —— 又是方言长出来的一格：字段类型那张白名单收了 `(blk T N)`，
// 见 fieldText 与 sexpr/lower.js 的 structDec）、**模块级变量**（`int g = 5;` / `static int g;` /
// `int t[3] = { … }`，降成方言的 `(global …)` 加 `(main …)` 开头的几句赋值，见 globalDecl）、
// **值语义的结构体**（`S s;` / `S t = s;` / `t = s` / `s.f` / `s.in.y` / `&s` / `S a[3]` /
// 结构体的模块级变量 —— 每格是一段自己的 `pnew` 内存，抄一份由 copyAgg 逐字段做）、
// **结构体按值传与按值回**（`void f(S v)` / `S g()` / `S t = g()` / `t = g()` / `g().f` ——
// 抄的那一下在**被调**那一侧，见 fnDef 的形参前奏那一段）、
// **花括号初值**（`int a[] = { 1, 2, 3 }` / `int b[10] = { ,, 3, 4,,, 7 }` /
// `Point p = { 10, m_z = 30 }` / `Box b = { 7, { 1, 2 } }` / `p = { , 200, 300 }` ——
// 位置项、命名项、空项、嵌套四种，声明与赋值两处，见 curlyPlan）、
// **不看顺序的名字**（调后面定义的函数、互相递归、模块级变量的初值调后面的函数 ——
// 签名在 run 里先过一遍，见 fnSig）、
// **指针的地址**（`int**` / `int***` / `&p` / `**pp` / `*pp = q` / `new int*[n]` /
// 把 `&p` 当出参传 —— 这一格是**方言**长出来的：fat 指针自己现在落得进内存，见
// hir/types.js 的 ptrTargetOk 与 sizeOf；这一层只有 liftable 多收了两种）、
// **结构体的指针字段**（`Node* m_next` / `n->next->val` / `&c[i]` / 链表 ——
// 又是方言长出来的一格：字段类型那张白名单收了指针，而 `Node*` 要在 Node 自己的体里
// 查得着，所以这一层的结构体名字也"先坐下、字段后填"，见 typeName）、
// **字段的类型不看声明顺序**（`struct Seg { Point m_a; }` 写在 `struct Point` 之前 ——
// 这一层一个字没改，是**方言**撤掉了一条自己立的规矩：内嵌只拒"按值绕回自己"，
// 见 sexpr/lower.js 的 cutValueCycles；jancy 那侧的出处是 `Type::prepareLayout`
// 按需算布局、撞回来才报 `can't calculate layout of '%s' due to recursion`）、
// **对模块级变量取地址**（`&g` / `&gp` / `&t` / `&s` —— 标量那一格被 `&` 过就发成
// `(ptr T)`、值躺在一段 pnew 出来的内存里，与第九刀对局部量做的是同一件事；数组与结构体
// 那一格里本来就放着块地址。方言一个字没改，见 declareGlobal 与 addrOf）、
// **`new T { … }`**（那几条语句抬成一个函数、项的值当实参在调用方求，于是它仍旧是一个
// 表达式，`while` 的条件那种惰性位置上也成立，见 newCurly）、
// **`.` 与 `->` 是同一个算符**（`point2.m_x` 里的 point2 是 `Point*` ——
// samples/jnc/84_CurlyInitializers.jnc:66；读、写、右值上的 `.` 三处都收，见 structBehind）。
//
// ## 纪律：**jancy 不向方言妥协**
//
// 遇到"jancy 有、方言没有"的东西，动的是**方言**，不是这门语言。这一刀里因此长出了
// 两条核心形式：`(sel c a b)`（条件表达式，惰性）与 `(peq p q)`（指针相等）。理由写在
// sexpr/lower.js 那两处。真值化不用动方言 —— 那本来就是 jancy 侧的一次隐式转换，
// 这一层把它显式写出来（`n != 0` / `!pisnull p`）就对了。定宽整数也是这一类：位宽是
// 这一层的账，回卷是三条已有算符的合成，方言一个字都不用改。取地址与定长数组也一样 ——
// 前者照 jancy 自己的办法把局部量提到堆上，后者就是一段 `pnew` 出来的内存，两刀方言都没动。
// 结构体那两刀（值语义、按值传与按值回）也在同一条上：一格结构体就是一段 `pnew` 的内存，
// 「抄一份」是逐字段的 pload/pstore，而按值传把那一下挪到被调那一侧就不用动调用约定。
// **第十六刀、第十七刀与第二十二刀是真的动了方言**：`int**` 要 fat 指针自己能落进内存、
// `Node* m_next` 要指针能躺在结构体的字段里、`int m_v[4]` 要**一整块**能内嵌在字段里，
// 那都是布局那一层的事，这一层拆不开 —— 于是 `ptrTargetOk`
// 放行了指针、`sizeOf` 上多了 24 与 8 两格、字段类型那张白名单收了两种指针与 `(blk T N)`，
// 五条腿各加一格读写与一格零值。这几条正是这份纪律说的"动方言"。
//
// 还没长出来、因此**当场报错**的（每一条都记着该怎么长，不是"不收"）：
//   - printf 的**转换字符**那一族只剩 `%p`（要"印地址"这件事本身，而这一层刻意不印裸地址）
//     与 `%zd` 那一族的长度修饰。`%e` / `%E` 是第三十刀、`%g` / `%G` 是第三十一刀、
//     `%u` 是第三十二刀，都落地了。标志（五个都齐了 —— `-` `0` `+` 空格 `#`，第二十九刀）、
//     宽度、精度（含 `*` / `.*`）也都收完了。三处 C 的**未定义行为**是另一种拒（没有可对的
//     答案，不是欠着）：`%c` 上的精度、不是有符号转换上的 `+` / 空格、`%d` / `%s` / `%c`
//     上的 `#`。
//   - `unsigned` 也落地了，分两刀：8 / 16 / 32 位是第三十三刀（回卷变成 `x & M`，
//     不摊符号位），64 位是第六十一刀（那一格没有更宽的可借，所以
//     `/` `%` `>>` 与四个大小比较换成方言里无符号那一版，见 uOp / realOf）。
//   - 数组那一族里**两条不是我们欠的**：**不同型**数组之间的赋值（长度不一样、或元素是同宽的
//     另一种整数）—— `Cast_Array::llvmCast` 里写着未实现，而同型的那些走的是 `castOperator` 里
//     `opType->isEqual(type)` 那条恒等捷径，所以是通的（第二十一刀，见 copyVal）；
//     `int(*pa)[3]` 这种声明 —— **jancy 自己的语法里就没有**带括号的声明符分组
//     （`jnc_ct_Declarator.llk:402` 的 `declarator_prefix` 只有 `'*' type_modifier*`），
//     所以 `T(*)[N]` 在 jancy 里是个说不出名字的类型，`&a` 只能就地用
//     （见 `cases/19-addr-array.jnc`）。
//   - 模块级变量那一族里剩下的一条：`threadlocal`（要线程本地存储 —— 这一层没有线程；
//     文档自己还给它记了"不能有初值、不能是聚合"两条限制）。`&g` 第二十四刀收了、`static`
//     的**局部量**第二十六刀收了（一格模块级的槽加一道 once 闸门，见 staticLocal）；只有
//     **string** 的模块级变量还取不到地址（liftable 那条，见 `bad/addr-global.jnc`）。
//   - `new T { … }` 里剩下的一条：`new T[n] { … }`。jancy 的语法把个数**折进类型名**里
//     （`new_operator_type : type_name_impl<&type, &elementCount>`，jnc_ct_Expr.llk:726），
//     所以那一行在它那边是过的；我们的语法把 `new T[n]` 与 `new T curly` 分成了两条产生式，
//     合不到一起。而且它到底写哪一格也量不出来（`new_operator_curly_initializer` 是先
//     `*p` 再套花括号，元素个数 >1 时那一格只是第一格）—— 语义没量清的不硬接。
//   - 花括号初值里剩下的两条：`[i] = v`（那一条在**我们的**语法里，jancy 的项只有位置与名字
//     两种，所以它是当场报错的那类）、`char buffer[] = { 10, 20, "null-terminated", … }`
//     （decl_curly.rst 最后那一段：char 数组里可以混字面量 —— 要"一格一个字节"的存储宽度，
//     与下面那处刻意留下的差别是同一格）。
//   - `printf` 之外的标准库（`std.*`、`io.*`、`gc.*`）
//   - 二进制字面量 `0x"61 62"`、`__FILE__` 那族预定义宏、多行字面量、正则 switch。
//     **相邻字面量的拼接**（`"a" "b"`）是第五十四刀（见 litFold）、**格式化字面量**
//     `$"…"` 是第六十四刀（见 fmtLit）；混着拼（`"a" $"b"`）与 `$!` 还不收。
//   - **形参的默认值**第七十七刀收了（见 withDefaults）：签名上记住那几个默认值的语法节点，
//     调用点少给的那几格换成它们、走与写出来的实参同一条路。两条界：只收**末尾**那几个
//     （jancy 还允许 `f(1,,3)` 那种空槽，我们的语法没有它），以及默认值的**形状**限死在
//     字面量 / `true` / `false` / `null` / 限定写法的枚举成员与它们的运算上 —— 因为我们在
//     调用点按调用点的作用域降它，而 jancy 按声明处的命名空间（ParseContext.cpp:32-38）。
//   - union / property / reactor / 事件 / 多播 / 协程。`enum` 是第三十九刀、`class` 是第
//     五十二刀、`construct` 与 `static construct` 是第五十三刀、**单继承**是第五十六刀
//     （一条链在方言里共用一格 `(struct …)`，见 classLayout）、**虚派发**是第五十七刀
//     （`virtual`/`override`/`abstract`：对象头那一格 `$tag` 是动态类型，每个虚方法一段按
//     标签挑实现的函数，见 dispatch）、**多个基类**与 `basetype1..9` 是第九十四刀
//     （一整块继承图共用一格结构体）；类那一族剩下的是共享基类各一份实例、
//     拿结构体当基类、下转、同名方法上再写一遍 `virtual`、
//     `destruct`（GC 不定时，disposable.rst:17 —— `opaque class` 里没有体的那一格第九十三刀
//     收下了）、`get` / `set`、构造的重载、内嵌的类字段与静态字段。
//   - 函数指针（`R function* p(形参)`）第五十五刀收了 —— 落到方言的函数值那一格
//     （`(fnty …)` / `(fnref …)` / `(mkclo …)` / `(callfn …)`），`c.foo` 捕的就是那个对象。
//     剩下的三条：函数指针的**字段**（方言的结构体字段放不下函数值 —— 第五十七刀的虚派发因此
//     换成了一格整数标签）、`function**` 与它的数组、`~()` 的部分应用。
//     空的那一格（`= null` / 不写初值 / `if (p)` / `p == null`）第一百七十五刀收了：方言那一侧
//     `(null (fnty …))` 后来长出来了，先前那句"方言的函数值没有空值"是过期的账。
//   - 异常里 `errorcode` 那一半是第五十八刀（自动传播 + `try`：见 propagate 与 jncErrText），
//     `try { … }` 与 `catch:` 是第五十九刀（出错那一跳落成一圈一次性循环的 `brk`：见 escape
//     与 catchBlock）；剩下的是 `finally:`（要一张路由表，连 `return` 也得先绕过去）、`throw`，
//     加传播插不进去的那两个位置（惰性那几支与循环的条件，见 EC_HOIST 与 ecLazy）。
//     import 是第六十刀（`import "x.jnc"` 摊成同一个模块里的顶层条目：见 impAdd 与
//     impDrain；`.jncx` 那一支是永久边界）。`assert` 是第四十九刀、`namespace` 是第五十一刀。
//
// **一处刻意留下的差别**：`sizeof` / `offsetof` 意义上的**存储**宽度。四种位宽在方言里
// 都占一个 64 位的槽（`char*` 与 `int*` 是同一个方言类型），所以 `new char[n]` 占 8n 字节、
// `struct { char c; int i; }` 是 16 字节、`char a[3]` 是 24 字节。这一格从**语义**上看不见
// （指针算术按元素走、数组下标也按元素走，而 `sizeof` / `offsetof` / `countof` 都不收），
// 所以它不在上面那份名单里；要真接 `sizeof` 才要动。
//
// ## printf 怎么降
//
// jancy 的 `printf` 就是它的打印口（`test/jnc/*.jnc` 里到处是它），语义是 C 的那一套：
// **不补换行**。这一层按 `\n` 把格式串切成若干段，带换行的段发 `(print …)`（它自带换行），
// 末尾不带换行的那段发 `(write …)`。两者在每条腿上共用同一个输出缓冲区，所以交替调用
// 顺序不会乱。收 `%d` / `%i` / `%f` / `%s` / `%c` / `%x` / `%X` / `%o` / `%%`，标志 `-` `0`、
// 宽度与精度（十进制常量或 `*` / `.*` —— 从实参来，第二十七刀）；`%d` 与 `%x` 也收 bool
// （jancy 的 bool 底下是 int8，印 1 / 0）。
//
// **"语义是 C 的那一套"这句话有一等的出处**：jancy 的 printf 不是自己写的格式化器 ——
// `jnc_std_StdLib.cpp:733` 一句 `sl::formatString_va(formatString, va)`，那一路
// （axl_sl_StringDetails.h:390/401）就是 **C 库的 `vsnprintf`**。所以 `cc -O0` 的孪生程序
// 不是"近似"，是同一份实现；printf 这一族的期望输出全是这么定的。
//
// 宽度那一格与 C 的 printf **逐字节相同**（含 `%05d` 印负数是 `-0042` 这一条 —— 零补在
// 符号后面）。精度分三路：`%f` 是小数位数、整数是"**至少**几位数字"（而且一写精度 `0` 标志
// 就作废）、`%s` 是"**最多**几个字符"（第二十七刀，见 precInt / precStr）。`*` 那一格的实参
// 排在值**前面**，只求一次（落成局部量，见 starArg）。
//
// 五个标志都收（第二十九刀补上 `+` / 空格 / `#`）。这一族真正的难处是**前缀与补零的先后**：
// C 里 `0` 补的零排在前缀**后面**（`%+05d` 是 `+0042`、`%#08x` 是 `0x0000ff`），而前缀的长度
// 不定（符号一个字符、`0x` 两个）。所以从第二十九刀起 piece 分成"前缀 + 主体"两段拿着，
// padTo 收两个参数。
//
// `%f` 是 C 的 `%.6f`（**默认精度 6**），走方言第八刀长出来的 `(sfix E N)`。它不是"把这个
// 数印出来"—— 第八刀之前这一格降成 `tostr`（`%.6g`），于是 `printf("%f", 1.5)` 印 `1.5`
// 而 C 印 `1.500000`。舍入定的是 C 那一边（就近取偶），理由写在 sexpr/lower.js 的 `sfix` 处。
//
// `%e` / `%E` 是同一族的另一格（第三十刀），走方言新长的 `(ssci E N)`（C 的 `%.Ne`）。
// 大写照 `%X` 那条分工走 `(supper …)`。这一格独有的难处有两处：**进位能把指数顶上去**
//（`%.2e` 的 `9.999` 是 `1.00e+01`）在方言那一层解决；`#` 要把小数点插在 `e` **前面**
//（`%#.0e` 的 1.5 是 `2.e+00`），在这一层解决。
//
// `%g` / `%G` 是这一族的最后一格（第三十一刀），走 `(sgen E N)` / `(sgenk E N)`
//（C 的 `%.Ng` / `%#.Ng`）。这一格的 `#` **不在这一层**：它改的是"去不去尾随零"，
// 那是排版本身的一部分，所以方言给了两个算子，frontend 只按有没有 `#` 挑一个。
//
// `%x` / `%X` / `%o` 靠方言第七刀长出来的 `(sbase E 进制)` 与 `(supper S)`。这一格真正的
// 难处不是"印十六进制"，是**多少位**：C 把实参当 unsigned 读，位数是**默认实参提升之后**
// 那一格，所以 `char d = -56; printf("%x", d)` 是 `ffffffc8` 而不是 `c8`。定宽整数
// （第六刀）在这里第一次真正被用到 —— 掩到 `promo(位宽)` 位再交给 `sbase`。
import { isList, isAtom, isStr, head } from '../sexpr/read.js';
import { OmniError } from '../source/diag.js';

const JNC_NOPE = 'jancy 前端第一刀还不收';

/**
 * 一格签名：`{params, ret, defs}`（第七十七刀）。
 *
 * `defs` 是每一格形参的**默认值节点**（没写就是 null），一个都没有时整格是 null ——
 * 绝大多数函数没有默认值，那时这一格连数组都不建。它与 `params` 一样长，所以方法上
 * 第 0 格是 `this`（永远没有默认值）。
 */
function sigOf(ps, ret) {
  const defs = ps.map((p) => p.def ?? null);
  return { params: ps.map((p) => p.type), ret, defs: defs.some((d) => d !== null) ? defs : null };
}


/* ---------------------------------------------------------------- 类型
 * 这一层的类型就是核心方言那几个，外加"这是个指针"。刻意不建自己的一套类型系统：
 * 方言那一层已经有 ptrTargetOk / sizeOf / structLayout（布局由那一层定死，见 ADR-0016），
 * 这里只要能说出"它是什么"就够。
 */
/* ## 定宽整数（ADR-0016 第六刀）
 *
 * jancy 的整数是**定宽有符号**的：`char` 8 位、`short` 16、`int` 32、`long` / `intptr` 64
 * （Lexer.rl 的关键字表 + Type.cpp 的 TypeKind_Int8..Int64）。方言只有一个 64 位的 int，
 * 所以位宽是**这一层的概念**：存储一律用方言的 int，而每个值都保持在它那一格的范围里
 * （**符号扩展后的规范形**），窄格的运算之后补一次回卷。
 *
 * 为什么这样够：只要两个操作数都是规范形，`% & | ^ >> == <` 的结果**天然**还在范围里，
 * 只有 `+ - * / <<` 与一元 `-` 会溢出。于是回卷只发生在这五处加上"赋值到更窄的一格"。
 * 回卷本身不要方言长新形式 —— 它是三条已有算符的合成（掩、异或、减），跟 `~x` -> `x ^ -1`
 * 与真值化同一类：**jancy 侧的一次隐式动作，这一层把它显式写出来**。
 *
 * 与 C 一致的两条规矩也在这儿：**整型提升**（比 32 位窄的先提到 32 位，所以
 * `char*char` 不会在 8 位里溢出）与**常用算术转换**（两边取较宽的那一格）。
 */
const INT_WS = [8, 16, 32, 64];
const INTS = new Map();
for (const w of INT_WS) for (const u of [false, true]) INTS.set(`${w}${u ? 'u' : ''}`, { k: 'int', w, u });
/** 一格整数类型。`u` 是无符号（第三十三刀）—— 位宽与符号性合起来才是一格。 */
const mkInt = (w, u = false) => INTS.get(`${w}${u ? 'u' : ''}`);
const J_I8 = mkInt(8);
const J_I16 = mkInt(16);
const J_I32 = mkInt(32);
const J_I64 = mkInt(64);
const J_U32 = mkInt(32, true);
const J_U64 = mkInt(64, true);
const J_REAL = { k: 'real' };
const J_BOOL = { k: 'bool' };
const J_VOID = { k: 'void' };
const J_STR = { k: 'string' };
/** 一格多播（第七十三刀）：`multicast (T…)` / `event (T…)` —— 处理函数一律回 void。
 *  属性的 `m_onChanged` 是不带实参的那一种（`StdType_SimpleMulticast`）。 */
const mcTy = (params = []) => ({ k: 'mc', params });
const J_MC = mcTy();
/** 通知那一格助手在方言里的名字（按签名一格，见 emitMcFire）。 */
const MC_FIRE = 'jnc$mc_fire';
/**
 * `variant_t`（第一百一十三刀）。它在这一层是**一格合成的结构体** ——
 * `(struct jnc$variant ($t int) ($n int) ($r real) ($s string))`：`$t` 是标签，
 * 剩下三格是载荷（整数 / 实数 / 字符串各一格，不重叠 —— 重叠要 union，而那省下来的
 * 16 字节买不到任何可观测的东西）。
 *
 * 为什么是结构体而不是方言的新一格：这一层的结构体已经有整套"变量里放地址、赋值逐字段抄、
 * 形参抄一份"的落法（第十二 / 十三刀），而 variant 要的正是这些。方言一个字不用改 ——
 * 前置（`string` 能落进内存）由 ADR-0026 补齐了。
 *
 * 标签的取值。0 是**空**（`variant_t v = null` 与刚 pnew 出来那一格都是它 —— 方言保证零值），
 * 所以"没装东西"不用额外一位。
 */
const VARIANT = 'jnc$variant';

/* 扩展库对每个模块都隐式 import 的那几份声明（第一百九十九刀，见 libImports）：
   std 库两份（jnc_std_StdLib.cpp:930-931）、sys 库一份（jnc_sys_SysLib.cpp:218）。 */
const LIB_IMPORTS = ['std_globals.jnc', 'std_Error.jnc', 'sys_globals.jnc'];
const V_NULL = 0;
const V_INT = 1;
const V_REAL = 2;
const V_BOOL = 3;
const V_STR = 4;
const isVar = (t) => t !== null && t !== undefined && t.k === 'struct' && t.name === VARIANT;
/* 泛型实例化套多深就算停不下来（第一百一十九刀）。语料里量到的最深是 3 层
   （`Iterator<RbTreeNode<K,V> >` 落在 `MapImpl<…>` 的基类表里那一串），8 是它的两倍多 ——
   宁可把闸门放宽一点：这一格挡的是**发散**（`struct L<T> { L<L<T> > m_v; }` 每层实参都长一圈、
   名字每次都是新的，光靠"同一份实参不重复造"停不下来），不是挡人写深。 */
const TMPL_DEPTH = 8;
/* 一个 f64 写成方言的 `(real …)` 收得下的样子。`String(x)` 给的形状
   （`1` / `-0.5` / `1e-7` / `1e+21`）正好都在 realLit 那条正则里；`Infinity`/`NaN`
   到不了这儿（`evalCConst` 那侧已经拦掉）。整数值补一个 `.0` 只是为了读的人一眼
   看出这是 real —— 方言两种都收。 */
const jncRealText = (x) => (x === Math.floor(x) && x > -1e15 && x < 1e15 ? `${x}.0` : `${x}`);
/* C_ABI 的那几个词与 jnc 类型的对法（ADR-0022 的 J4d）。实参那一侧：`ptr` 不在表里 ——
   它收的东西不止一种（整数句柄、jnc 的指针、字符串），由 `ccallSite` 单独判。
   返回那一侧：`ptr` 就是一格 64 位的地址值（与 `.sx` 里手写 `(let win int (ccall …))`
   同形），`cstr` 也一样 —— 那是一个**地址**，把它当 jnc 字符串是错的。 */
const CABI_WANT = new Map([
  ['i32', J_I32], ['i64', J_I64], ['bool', J_BOOL],
  ['f32', J_REAL], ['f64', J_REAL], ['cstr', J_STR],
]);
const CABI_RET = new Map([
  ['void', J_VOID], ['i32', J_I32], ['i64', J_I64], ['bool', J_BOOL],
  ['f32', J_REAL], ['f64', J_REAL], ['ptr', J_I64], ['cstr', J_I64],
]);
const tPtr = (t) => ({ k: 'ptr', target: t });
const tThin = (t) => ({ k: 'tptr', target: t });
/**
 * 定长数组（ADR-0016 第十刀）。jancy 照抄 C/C++ 的模型：**定长**、长度写在声明符上
 * （decl_simple.rst："Jancy adopts C/C++ model: `int a[10][20]`"）。存储用方言的
 * `(pnew (ptr T) (int N))` —— 一段长度 N 的堆内存，范围就在那个 fat 指针里，于是
 * `a[i]` 的越界检查是方言本来就有的那一条（type_ptr_data.rst："Range is checked on
 * both array accesses and pointer dereferences"）。
 */
const tArr = (t, n) => ({ k: 'arr', el: t, n });

/**
 * 函数指针（第五十五刀）。jancy 写成 `R function* p(形参)` —— `function` 是**类型修饰符**
 * （在语法里落进 specs 的 mods 那一格，`function` 是 mods 关键字，jnc.grammar:264），
 * 那个 `*` 是"指针"这件事本身，形参表挂在声明符的后缀上（`fn-suffix`）。
 *
 * 它落到方言的**函数值**那一格（`(fnty (T…) R)`，见 tests/sexpr/cases/15-fnvalues.sx）：
 * 一格里放的是 ADR-0010 那个 `{fp, c_*}`，也就是 jancy 说的 fat function pointer ——
 * "a pointer to the function and a closure object"（type_ptr_function.rst）。两边是同一个
 * 模型，所以 `= foo` 是 `(fnref foo)`、`= c.foo` 是一格捕获了 `c` 的闭包、`p(…)` 是
 * `(callfn …)`。`function thin*` 是**不带**闭包的那一种，方言这一格里装得下它（thin 是
 * fat 的一个特例：捕获为空），所以两者在这一层是同一格，差的只有诊断里的名字。
 */
const tFn = (params, ret, thin = false) => ({ k: 'fnptr', params, ret, thin });
/* 一格**函数类型**本身（第八十二刀）。只有 `typedef R F(实参…);` 起的那种名字是这一格 ——
 * jancy 那边它是 `TypeKind_Function`，而"函数类型的变量"是不成立的，能用的只有 `F*`
 * （`getFunctionPtrType`，jnc_ct_DeclTypeCalc.cpp:483-491 与 674-685）。所以这一格在
 * ptrsTy 里碰到第一个 `*` 就变成 fnptr，一个 `*` 都不带的用法当场拒。 */
const tFnTy = (params, ret) => ({ k: 'fnty0', params, ret });
const isFn = (t) => t.k === 'fnptr';
/* `pickOverload` 的一格哨兵（第一百八十七刀）：**带体的那几条都不合，可宿主面那张表里有**。
 * 回一个名字（字符串）那一格里放不下这个意思，所以给它一个不可能与真名字撞的值。
 * 只有把 `hostOk` 开着的调用方才拿得到它 —— 拿到就去 `protoHostRetry` 那儿再挑一次。 */
const HOST_PICK = '\u0000host';

const isInt = (t) => t.k === 'int';
const isArr = (t) => t.k === 'arr';
const jncIsStruct = (t) => t.k === 'struct';
/**
 * 类（第五十二刀）。**一格类类型就是一条引用** —— jancy 的类"只能经引用到达"
 * （type_class.rst:19），而 `C*` 在它那边不是"再套一层数据指针"：`calcPtrType` 对
 * `TypeKind_Class` 走的是 `getClassPtrType`（jnc_ct_DeclTypeCalc.cpp:226-229），
 * 也就是 `C` 与 `C*` **同一个表示**。所以这一层把两者落成同一格 `{k:'class', name}`，
 * 在方言里就是 `(ptr C)` —— 类的字段表与结构体的存在同一张 `this.structs` 里，于是
 * `pfield` / `pload` / `pstore` 那一整套一个字都不用改。
 *
 * `own` 记的是"源码里写的是**不带 `*`** 的那一种"，也就是 jancy 说的"声明类变量就是造一个
 * 对象"（01_Classes.jnc:90-94）。它只影响三件事：声明那一处要不要 `pnew`、能不能赋值
 * （type_class.rst:19 那句 "You cannot assign varibles or fields of class types"）、
 * 以及形参/返回/数组元素上 jancy 自己拒的那三条。同型判定不看它。
 */
const isClass = (t) => t.k === 'class';
const tClass = (name, own) => ({ k: 'class', name, own });
/** 一格枚举（第三十九刀）。`base` 是它的基整数类型，值按那一格的规范形存。 */
const jncIsEnum = (t) => t.k === 'enum';

/** 报错里显示的名字（第五十一刀）：内部用 `$` 连命名空间，源码里写的是点。 */
const shown = (n) => n.replace(/\$/g, '.');

/**
 * agg 的那个关键字是"类"吗（第五十二刀；`opaque class` 是第六十六刀加进来的）。
 *
 * jancy 那边这两个词落在**同一个调用**上：`opaque_class_specifier` 的动作是
 * `createClassType(…, ClassTypeFlag_Opaque)`，而 `class_specifier` 是同一个
 * `createClassType` 少那个标记；体也是同一条 `derivable_type_member_block`
 * （NamedTypeSpecifier.llk:199-215）。所以"opaque"不是另一种类型，是类上的一位。
 */
const aggCls = (k) => k === 'class' || k === 'opaque class';

/** 诊断里叫它什么（第二百一十三刀起 union 也是一格带名字的类型，别都说成"结构体"）。 */
const aggWord = (k, cls) => (cls ? '类' : k === 'union' ? '联合' : '结构体');

/** `(type-decl (agg class …))` 里的那个 agg 吗（第五十二刀）。 */
function isClassAgg(n) {
  return isList(n) && head(n) === 'agg'
    && aggCls(isAtom(n.items[1]) ? n.items[1].value : null);
}

/** 结构体体里那格**匿名 union** 吗（第二百三十刀）：它不是一格嵌套类型，是这张字段表里
 *  几格共用一个偏移的写法（第一百一十刀），所以提不得。 */
function isAnonUnionAgg(n) {
  if (!isList(n) || head(n) !== 'agg') return false;
  const k = isAtom(n.items[1]) ? n.items[1].value : null;
  return k === 'union' && isList(n.items[2]) && head(n.items[2]) === 'anon';
}

/** 体里那些方法要**提到顶层**的 agg 吗（第一百〇一刀把 struct 也算进来了）。
 *  jancy 的 struct 也是一层命名空间、也能有方法（`type_struct.rst` 的 Methods 一节）。 */
function isHoistAgg(n) {
  if (!isList(n) || head(n) !== 'agg') return false;
  const k = isAtom(n.items[1]) ? n.items[1].value : null;
  return aggCls(k) || k === 'struct';
}

/**
 * 属性 `[ … ]` **收下不看**（第一百〇八刀）。语法上它把一格声明裹起来
 * （`jnc.grammar:221` 的 `(attributed 属性 声明)`，枚举成员那一支在 `:354`），剥掉那层壳
 * 就是原来那格声明。语料里 66 处、25 份文件，全是元数据：`[ ungroup ]`、
 * `[ displayName = "PDU" ]`、`[ formatFunc = formatIpAddress ]`、`[ structType = typeof(X) ]`。
 *
 * **为什么"收下不看"在这里不会给错答案**：属性的值在 jancy 那边是给**反射**读的
 * （`decl.findAttributeValue("formatFunc")`，log_RepresentStruct.jnc:24/96 那种）。这一层压根
 * 没有反射 —— 那几个 `findAttributeValue` 现在报的是"没有这个函数"，将来要落反射，**必须连
 * 属性的值一起落**，不能只补个空壳回 null（那才是安静的错答案）。这一条记在这儿当锁。
 */
const unattr = (n) => (isList(n) && head(n) === 'attributed' ? n.items[2] : n);

/**
 * 相邻字面量的拼接（第五十四刀）。jancy 的 `literal` 是 `literal_atom+`（语法那处的注释
 * 记着这条），也就是 C 的"相邻字符串字面量拼在一起"——而这件事在**编译期**做完：拼出来的
 * 还是一格字面量（literals.rst:90 那句 "all literal kinds can be concatenated and combined.
 * If the combination does not include formatting literals, then the result is a statically
 * allocated const char array"）。
 *
 * 折得动就回那一串字符；里面有格式化字面量、二进制字面量或 `__FILE__` 那族预定义宏时回 null
 * —— 那三种各是一格自己的边界，理由见 litWhy。
 */
function litFold(n) {
  if (isStr(n)) return n.value;
  if (!isList(n) || head(n) !== 'concat') return null;
  const a = litFold(n.items[1]);
  if (a === null) return null;
  const b = litFold(n.items[2]);
  return b === null ? null : a + b;
}

/**
 * 格式化字面量里没写 spec 时，按**静态类型**挑的那个转换字母（Parser.cpp:3670-3691）。
 * 整数 ≤4 字节 `d` / `u`、64 位 `lld` / `llu`、浮点 `f`、字符串 `s`；别的回 null（jancy
 * 那儿也是一句 "don't know how to format"）。bool 在 jancy 那边同时带 Integer 标记
 *（ControlFlowMgr_Eh.cpp:260 那句 "bool or not integer" 反着说了这件事），一字节，所以是 `d`。
 */
function fmtDefault(t) {
  if (t === J_REAL) return 'f';
  if (t === J_STR) return 's';
  if (t === J_BOOL) return 'd';
  const b = jncIsEnum(t) ? t.base : t;
  if (isInt(b)) return b.w <= 32 ? (b.u ? 'u' : 'd') : (b.u ? 'llu' : 'lld');
  return null;
}

/** spec 与默认字母并起来（prepareFormatString，CoreLib.cpp:702-723）：没写就是 `%` 加默认；
 *  写了但开头不是 `%` 就补一个；末尾不是字母时把默认那个字母接上（`8` -> `%8d`）。 */
function fmtMergeSpec(spec, dflt) {
  if (spec === null) return `%${dflt}`;
  const s = spec.startsWith('%') ? spec : `%${spec}`;
  return /[A-Za-z]$/.test(s) ? s : s + dflt;
}

/**
 * `$(…)` / `%(…)` 那一格的范围（Lexer.rl:132 的 lit_fmt_opener 收 `(` 与 `{` 两种）。
 * 顶层第一个 `;` 后面是 spec（Lexer.rl:455 的 onSemicolon 切到 lit_fmt_expr_spec）。
 * 回 null 表示括号没配上。
 */
function fmtSplitSite(s, open) {
  const closer = s[open] === '(' ? ')' : '}';
  let depth = 0;
  let semi = -1;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') {
      depth--;
      if (depth === 0) {
        if (c !== closer) return null;
        const spec = semi < 0 ? null : s.slice(semi + 1, i).trim();
        return {
          body: semi < 0 ? s.slice(open + 1, i) : s.slice(open + 1, semi),
          spec: spec === null || spec === '' ? null : spec,
          end: i + 1,
        };
      }
    } else if (c === ';' && depth === 1 && semi < 0) semi = i;
  }
  return null;
}

/** 这段树是一格格式化字面量吗（`(fmt …)`，或者它带上了实参表的 `(call (fmt …) …)`）。 */
function fmtNode(n) {
  if (isList(n) && head(n) === 'fmt') return { tok: n.items[1], args: null };
  if (isList(n) && head(n) === 'call' && isList(n.items[1]) && head(n.items[1]) === 'fmt') {
    return { tok: n.items[1].items[1], args: n.items[2] };
  }
  return null;
}

/** 这段树里显式调了**第几格**基类的 construct（第五十六刀 + 第九十四刀）。没调的那几格自动
 *  补一句 —— jancy 也是这么做的（`callBaseTypeConstructors` 只补源码没显式调的那些）。
 *  回的是一格序号的集合（`basetype` 不带序号算第 1 格）。 */
function baseCtorCalls(n, out = new Set()) {
  if (!isList(n)) return out;
  if (head(n) === 'call') {
    const c = n.items[1];
    if (isList(c) && head(c) === 'field' && isList(c.items[1])
      && head(c.items[1]) === 'basetype'
      && (isAtom(c.items[2]) || isStr(c.items[2])) && c.items[2].value === 'construct') {
      const bt = c.items[1];
      out.add(isAtom(bt.items[1]) ? Number(bt.items[1].value) : 1);
    }
  }
  for (const it of n.items) baseCtorCalls(it, out);
  return out;
}

/** 声明符的核心是个**特殊成员**吗（第五十二刀）：`construct` / `destruct` /
 *  `static construct` / 属性的 `get` `set`。是就回那个关键字，不是回 null。
 *  这几种在语法里是自己一格（`special` / `accessor`，jnc.grammar 的 special 规则）。
 *
 *  算符重载（第一百三十刀）也从这儿回：`(operator :=)` -> `'operator :='`。语法上它也是
 *  自己一格，落法与特殊成员同一条路（提到顶层、`this` 当第一个形参），只是**名字**由
 *  fnSig0 拼成 `Owner$op$assign` 那种，调用点按算符去找它。
 *
 *  后缀那一族（第一百三十一刀）在语法里是**另一个头**（`(postfix-operator ++)`，
 *  jnc.grammar:431）—— 回的话里把那个词留着：`'postfix operator ++'`。留着是因为它与前缀
 *  是**两个函数**（jancy 的 stdt_Iterator.jnc:36-54 四个都写了），名字得分得开。 */
function specialCore(dcl) {
  if (!isList(dcl) || head(dcl) !== 'dcl') return null;
  let core = dcl.items[2];
  if (isList(core) && head(core) === 'qualified-special') core = core.items[2];
  if (!isList(core)) return null;
  const h = head(core);
  if (h === 'operator' || h === 'postfix-operator') {
    const a = core.items[1];
    /* 转换算符（第一百三十九刀）：`operator bool ()` 在语法上是 `(cast-op specs ptrs)`——
       目标类型那一格是一整棵说明符，不是一个词。语料里这一族只有 `bool` 一种
       （`it ? … : …` 里那个 `it` 走的就是它，stdt_Map.jnc:117），所以只把 `bool` 认出来；
       别的形状回一句认得出的话（`operator (转换)`），让 declarator 那儿明说不收。 */
    if (isList(a) && head(a) === 'cast-op') {
      const sp = a.items[1];
      const t0 = isList(sp) ? sp.items[1] : null;
      const np = isList(a.items[2]) ? a.items[2].items.length - 1 : 0;
      const nm = isAtom(t0) || isStr(t0) ? t0.value : null;
      return np === 0 && nm === 'bool' ? 'operator bool' : 'operator (转换)';
    }
    /* 剩下两种也是自己一格节点（`operator ()` 是 `(call-op)`、`operator []` 是 `(index-op)`）。
       两个都还不收，可**话要说出是哪一个** —— 先前它们与 cast-op 一起印成 `operator ?`，
       榜上那一行谁看了都不知道说的是什么（第一百三十八刀刚记过这一条：榜上的名字是拦路那一句
       话，不是那件事的名字）。`operator ()` 的原样在 stdt_Operator.jnc:97。 */
    if (isList(a) && head(a) === 'call-op') return 'operator ()';
    if (isList(a) && head(a) === 'index-op') return 'operator []';
    const op = isStr(a) || isAtom(a) ? a.value : '?';
    return `${h === 'operator' ? '' : 'postfix '}operator ${op}`;
  }
  if (h !== 'special' && h !== 'accessor') return null;
  return isStr(core.items[1]) || isAtom(core.items[1]) ? core.items[1].value : h;
}

/** 这一格特殊名是**算符重载**吗（第一百三十一刀）—— 前缀与后缀两种头都算。先前四处各写着
 *  `sk.startsWith('operator ')`，后缀那一种的话头上多了个词，四处会一齐认不出来。 */
const isOpSpecial = (sk) => sk !== null
  && (sk.startsWith('operator ') || sk.startsWith('postfix operator '));

/** 这一层认得的算符重载，以及各自拼出来的名字后缀。名字里带 `$` —— 标识符里写不出这个字，
 *  所以撞不上用户自己的函数（第五十二刀起类的方法就是这么拼的）。 */
const OP_NAME = new Map([
  ['operator :=', 'assign'],
  ['operator ++', 'inc'],
  ['operator --', 'dec'],
  ['postfix operator ++', 'inc$post'],
  ['postfix operator --', 'dec$post'],
  ['operator *', 'mul'],
  ['operator ->', 'arrow'],
  /* 调用算符（第二百〇二刀）：`obj(…)`。语料里它全长在 `stdt` 那几个函子上
     （`struct Eq<T> { static bool operator () (T a, T b) }`，stdt_Operator.jnc:19-25）。 */
  ['operator ()', 'call'],
  ['operator bool', 'bool'],
  ['operator ==', 'eq'],
  ['operator !=', 'ne'],
  /* 复合赋值那一族（第一百五十二刀）。jancy 那边它们是**各自独立**的算符（不是"`+` 再赋一次"）
     —— `std.StringBuilder` 的 `operator += (string_t)` 就是"往后接一段"，与 `operator +` 无关。
     语料里出现的只有 `+=`（std_String.jnc:60-70 三条），其余几个一并列上是因为判据完全一样，
     少列一个就会在那一格上报"算符重载 '…'"这句笼统的话。 */
  ['operator +=', 'addAssign'],
  ['operator -=', 'subAssign'],
  ['operator *=', 'mulAssign'],
  ['operator /=', 'divAssign'],
  ['operator %=', 'modAssign'],
  ['operator &=', 'andAssign'],
  ['operator |=', 'orAssign'],
  ['operator ^=', 'xorAssign'],
  ['operator <<=', 'shlAssign'],
  ['operator >>=', 'shrAssign'],
]);

/** 复合赋值算符：源码里那个算符（`+=`）-> OP_NAME 里的键（第一百五十二刀）。 */
const COMPOUND_OPS = new Set(['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

/** 这个声明符是**属性的**取/存吗（第六十九刀）：`m_v.get()` 名字写在前面（语法上那是
 *  `qualified-special`），而类体里裸写的 `int get(int i)` / `void set(int i, int v)` 是
 *  **下标算符**（test90.jnc:12-24 里 `c[10] = 100` 走的就是它）—— 那一格见 bareAccessor。 */
function accessorNamed(dcl) {
  if (!isList(dcl) || head(dcl) !== 'dcl') return false;
  const core = dcl.items[2];
  if (!isList(core) || head(core) !== 'qualified-special') return false;
  const sk = specialCore(dcl);
  return sk === 'get' || sk === 'set';
}

/** 类 / 结构体体里**裸写**的 `get` / `set` 吗（第一百三十八刀）：那是**下标算符**。
 *  jancy 里 `c[10] = 100` 走的是 `set`、`c[10]` 走的是 `get`（test90.jnc:12-24）——
 *  语料里这一族的形状只有一种：`variant_t get(size_t index)` 加 `bool errorcode set(…)`
 *  （std_Array.jnc:26/31、std_Buffer、std_HashTable、std_RbTree 各一对）。
 *  与属性那一族分得开的就是这一格：名字**没**写在前面（不是 `qualified-special`）。 */
function bareAccessor(dcl) {
  if (!isList(dcl) || head(dcl) !== 'dcl') return false;
  const core = dcl.items[2];
  if (!isList(core) || head(core) !== 'accessor') return false;
  const sk = specialCore(dcl);
  return sk === 'get' || sk === 'set';
}

/**
 * 数组退化成指针。jancy 的 `int* p = a;`（type_ptr_data.rst:31）就是它 —— 数组这一格里躺的
 * 是**一整块**的地址（`(ptr (blk T N))`，第十九刀），所以退化是方言的一句 `(pelem …)`：
 * 地址与范围一个字都不动，变的只有"接下来 padd 一步跨多少"。多维数组退一层就是一行。
 */
function decay(v) {
  if (v === null || !isArr(v.type)) return v;
  return { code: `(pelem ${v.code})`, type: tPtr(v.type.el) };
}


/** 整型提升：比 32 位窄的一律先提到 32 位（C 的规矩，jancy 同）。 */
const promo = (w) => (w < 32 ? 32 : w);

/**
 * 算术里一格整数**提升之后**是什么（第三十三刀）。出处是 jancy 自己的那张表
 * （`jnc_ct_UnOp_Arithmetic.cpp:23`）：
 *
 *   Int8 / Int8_u / Int16 / Int16_u / Int32 -> Int32；Int32_u -> Int32_u；
 *   Int64 -> Int64；Int64_u -> Int64_u
 *
 * 也就是 C 的整型提升一字不差：窄于 32 位的（有符号无符号都算）都提到**有符号 32 位**，
 * 因为 32 位有符号装得下它们所有的值。
 */
const arith = (t) => (t.w < 32 ? J_I32 : t);

/**
 * 两格整数一起算时结果是哪一格（常用算术转换）。jancy 的做法是**取 TypeKind 大的那个**
 * 再过一遍上面那张表（`jnc_ct_UnOp_Arithmetic.h:38`），而 TypeKind 的顺序正好是
 * Int8 < Int8_u < Int16 < Int16_u < Int32 < Int32_u < Int64 < Int64_u ——
 * 也就是先比位宽、同宽时无符号大。量下来这与 C 的常用算术转换在这几格上是同一个答案。
 */
const kindIdx = (t) => t.w * 2 + (t.u ? 1 : 0);
const common = (a, b) => arith(kindIdx(a) >= kindIdx(b) ? a : b);

/**
 * 落到 64 位无符号那一格上时要换成无符号版的那七个算子（第六十一刀）。
 * 剩下的一个都不换：`+ - * & | ^ <<` 在补码下两种解释的位一模一样，`== !=` 比的也是位。
 */
const U_BINOPS = new Set(['/', '%', '>>', '<', '<=', '>', '>=']);

/**
 * 算子选择的**唯一一处**：中间那一格落到 64 位无符号上时换成 u 版。二元表达式与复合赋值
 * 都走它 —— 分成两处写过一次，结果 `q /= three` 发的是有符号除法（`-1 / 3` 给 0）。
 * 窄的那几格不换：intConv 已经把它们掩成非负数，有符号的算子算出来就是对的。
 */
const uOp = (op, rt) => (rt.u && rt.w >= 64 && U_BINOPS.has(op) ? `u${op}` : op);

/**
 * 整数 -> real（第六十一刀把它抽出来的）。64 位无符号那一格要走方言的 `torealu`
 * （位当无符号 64 位读），不然 `double d = (uint64_t)-1` 会印出 -1 而不是 1.8e19。
 * 窄的那几格不用：它们的规范形已经是非负数了，`toreal` 就是对的。
 */
const realOf = (code, t) => `(${t.u && t.w >= 64 ? 'torealu' : 'toreal'} ${code})`;


/**
 * 回卷到 w 位。**有符号**是 `(x & M) ^ S - S`（掩到 w 位、再把最高位当符号位摊开）；
 * **无符号**就只有掩那一步（第三十三刀）—— 也就是那一刀记下的"回卷变成 `x & M`
 * （不摊符号位）"。
 *
 * 64 位有符号就是方言的 int 本身，一个字都不用发。64 位**无符号**也是那一格 ——
 * 位一模一样，只是读法不同（第六十一刀）：所以这儿照样不发字，而"读法不同"那一半由
 * 算子承担（`u/` `u%` `u>>` 与四个 `u<` 类比较，见 uOp）。
 *
 * 两条腿上都成立：JS 那侧 int 是 BigInt（`-1n & 255n === 255n`），C 那侧是补码的
 * `int64_t`（`(-1LL) & 255 == 255`）—— 同一串算符给同一个数。
 */
function wrapTo(code, w, u = false) {
  if (w >= 64) return code;
  const s = 1n << BigInt(w - 1);
  if (u) return `(bin "&" ${code} (int ${s * 2n - 1n}))`;
  return `(bin "-" (bin "^" (bin "&" ${code} (int ${s * 2n - 1n})) (int ${s})) (int ${s}))`;
}

/**
 * 编译期的回卷（第三十九刀）：拿一个 BigInt 落到某一格整数的规范形里。与 wrapTo 是同一条
 * 算法，只是那个发代码、这个当场算 —— 枚举成员的值在编译期就定下来了。
 */
function wrapVal(v, t) {
  if (t.w >= 64) return BigInt.asIntN(64, v);
  return t.u ? BigInt.asUintN(t.w, v) : BigInt.asIntN(t.w, v);
}

/**
 * 类型 -> 核心方言的写法。**四种位宽都写成 `int`** —— 存储就是方言那一个 int。
 *
 * 定长数组是**一整块**（第十九刀）：`int a[3]` -> `(ptr (blk int 3))`，而不是"一条指向 3 格
 * int 的指针"。差别有两处要紧：`&a` 就是那一格本身（不用另开一格），而多维数组
 * `int a[10][20]` 的元素是 `int[20]`，只有"块的块"说得出来。退化成 `T*` 由 decay 发一句
 * `(pelem …)`（地址与范围都不动，只换类型）。
 */
/**
 * 一条继承链在方言里的**那一格结构体**的名字（第五十六刀）。整条链共用一格：字段是链上所有
 * 类的并集，于是 `D*` 与 `B*` 落成同一个方言类型 —— 上转不用发一个字，方言也不用长出"指针的
 * 重解释"。没有基类也没有派生类的类就是它自己。
 *
 * 它是模块级的一格是因为 `tyText` 这一族是纯函数（这份文件里的类型辅助都在类外），而"哪条链"
 * 是**这一次降级**才知道的事 —— 所以 lowerJnc 每次进来先清空它，classLayout 那一遍填。
 */
const CLS_ROOT = new Map();
const clsRoot = (name) => (CLS_ROOT.has(name) ? CLS_ROOT.get(name) : name);

function tyText(t) {
  // `T(*)[N]`（第二十刀）：指向一整块的指针，在方言里与那块自己是**同一个写法** ——
  // 都是 `(ptr (blk T N))`。差别只在这一层的类型上（`padd` 一步跨一整块还是一格元素）。
  if (t.k === 'ptr' && t.target.k === 'arr') return `(ptr ${blkText(t.target)})`;
  if (t.k === 'ptr') return `(ptr ${tyText(t.target)})`;
  if (t.k === 'tptr') return `(tptr ${tyText(t.target)})`;
  if (t.k === 'arr') return `(ptr ${blkText(t)})`;
  if (t.k === 'struct') return t.name;
  // 类是一条引用（第五十二刀）：那一格里放的是对象那段内存的地址，字段表与结构体同一张。
  // 一整条继承链共用一格结构体（第五十六刀，见 clsRoot）。
  if (t.k === 'class') return `(ptr ${clsRoot(t.name)})`;
  // 函数指针就是方言的函数值那一格（第五十五刀）：`(fnty (形参…) 返回)`。
  if (t.k === 'fnptr') return `(fnty (${t.params.map(slotText).join(' ')}) ${slotText(t.ret)})`;
  if (t.k === 'int') return 'int';
  /* 多播（第七十三刀）：jancy 的 `multicast ()` 是一格类，里头是"一串函数指针 + 个数"
   * （`jnc_Multicast`，include/jnc_RuntimeStructs.h:169-181）。方言里现成的形状就是
   * **元素是函数值的数组**：加一个订阅是 `apush`、通知是照 `alen` 走一遍 `callfn`，
   * 顺序与 jancy 的 `McSnapshot.call` 一样（从 0 往上，jnc_ct_MulticastClassType.cpp:64-94）。 */
  if (t.k === 'mc') return `(arr (fnty (${t.params.map(slotText).join(' ')}) void))`;
  // 枚举在方言里就是它的基整数（第三十九刀）—— 四种位宽在方言里都是 `int`，所以这儿也是
  if (t.k === 'enum') return 'int';
  return t.k;
}

/** 数组类型的**块**写法（`(blk T N)`）：元素本身是数组时递归下去（多维）。 */
function blkText(t) {
  const el = t.el.k === 'arr' ? blkText(t.el) : tyText(t.el);
  return `(blk ${el} ${t.n})`;
}

/**
 * 一格**存储**的方言类型（第十二刀）。与 tyText 的差别只在结构体上：结构体作为**字段**
 * 写成 `S`（那是 `(struct S …)` 里的写法），而作为一个变量/元素时它是**一段内存**，所以
 * 那一格里放的是 `(ptr S)`。jancy 的 struct 是 POD 值类型，值语义由"每格自己一段内存 +
 * 赋值时逐字段抄"给出（见 copyAgg），方言一个字都不用改。
 */
function slotText(t) {
  return t.k === 'struct' ? `(ptr ${t.name})` : tyText(t);
}

/**
 * 一格**字段**的方言类型（第二十二刀）。与 slotText 正好相反的两处：
 * 结构体字段是 `S`（内嵌）、数组字段是 `(blk T N)`（也是内嵌，那 N 格就躺在父对象里）。
 * 一格数组**变量**里放的是块地址（`(ptr (blk T N))`，见 tyText），字段不是。
 */
function fieldText(t) {
  return t.k === 'arr' ? blkText(t) : tyText(t);
}

/**
 * 发 `(struct …)` 那一串字段（第一百一十刀）：`uni` 相同的那**一串**括成一格 `(union …)`。
 *
 * 这一层的字段表是**摊平**的（union 的成员就在里头，所以查名一处都不用改），"它们共用一段
 * 字节"这件事只在发给方言的那一句里体现 —— 方言那边从 ADR-0027 起认这个形状。
 */
function unionGroups(fields) {
  const out = [];
  let i = 0;
  while (i < fields.length) {
    const g = fields[i].uni;
    if (g === undefined) {
      out.push(`(${fields[i].name} ${fieldText(fields[i].type)})`);
      i += 1;
      continue;
    }
    const ms = [];
    while (i < fields.length && fields[i].uni === g) {
      ms.push(`(${fields[i].name} ${fieldText(fields[i].type)})`);
      i += 1;
    }
    out.push(`(union ${ms.join(' ')})`);
  }
  return out;
}

/** 给人看的写法（诊断里用）。跟 jancy 自己的拼法一致：`int*` / `int thin*` / `char`。 */
const INT_NAMES = new Map([[8, 'char'], [16, 'short'], [32, 'int'], [64, 'long']]);

/**
 * 整数类型的**别名**（第三十三刀）。照 type_primitive.rst:25-40 那张表抄，一个不多一个不少。
 * jancy 的语料里这几个到处是（`uint_t` / `size_t` / `dword_t`），拒了等于拒掉半份语料。
 */
const INT_ALIASES = new Map([
  ['int8_t', { w: 8, u: false }], ['utf8_t', { w: 8, u: false }],
  ['uint8_t', { w: 8, u: true }], ['uchar_t', { w: 8, u: true }], ['byte_t', { w: 8, u: true }],
  ['int16_t', { w: 16, u: false }], ['utf16_t', { w: 16, u: false }],
  ['uint16_t', { w: 16, u: true }], ['ushort_t', { w: 16, u: true }], ['word_t', { w: 16, u: true }],
  ['int32_t', { w: 32, u: false }], ['utf32_t', { w: 32, u: false }],
  ['uint32_t', { w: 32, u: true }], ['uint_t', { w: 32, u: true }], ['dword_t', { w: 32, u: true }],
  ['int64_t', { w: 64, u: false }],
  ['uint64_t', { w: 64, u: true }], ['ulong_t', { w: 64, u: true }], ['qword_t', { w: 64, u: true }],
  /* 这五格（第九十刀）文档那份清单里**没有**（type_primitive.rst:25-40 只列到 `intptr`），
   * 出处是源码那张表：`TypeMgr::setupStdTypedefArray`（jnc_ct_TypeMgr.cpp:1758-1783）——
   * `intptr_t` / `uintptr_t` 是 `TypeKind_IntPtr` / `_u`（这一层的指针是 8 字节，所以 64 位），
   * 而 `utf8_t` / `utf16_t` / `utf32_t` 是**有符号**的 Int8 / Int16 / Int32（同处 :1766/:1771/:1776，
   * 不是无符号 —— 照源码抄）。语料里 69 处：intptr_t 31、utf32_t 14、uintptr_t 13、utf16_t 10、
   * utf8_t 1。 */
  ['intptr_t', { w: 64, u: false }], ['uintptr_t', { w: 64, u: true }],
]);
function tyName(t) {
  if (t.k === 'ptr' && t.target.k === 'arr') return `${tyName(t.target.el)}(*)[${t.target.n}]`;
  if (t.k === 'ptr') return `${tyName(t.target)}*`;
  if (t.k === 'tptr') return `${tyName(t.target)} thin*`;
  if (t.k === 'arr') return `${tyName(t.el)}[${t.n === null ? '' : t.n}]`;
  // 命名类型的名字内部带 `$` 前缀（第五十一刀），报错里换回点 —— 那是源码里写的样子。
  // variant 那一格是**合成的**（第一百一十三刀），内部名字 `jnc$variant` 源码里写不出来，
  // 所以按源码里的拼法报。
  if (t.k === 'struct' && t.name === VARIANT) return 'variant_t';
  if (t.k === 'struct') return shown(t.name);
  // 类（第五十二刀）：不带 `*` 写出来的那一种就是 jancy 的 "class value"，带 `*` 的是它的
  // 类指针 —— jancy 自己的诊断里两者也是这么分的（`C` 与 `C*`）。
  if (t.k === 'class') return `${shown(t.name)}${t.own === true ? '' : '*'}`;
  // 函数指针（第五十五刀）：照 jancy 自己写出来的样子拼，`thin` 是不带闭包的那一种。
  if (t.k === 'fnptr') {
    return `${tyName(t.ret)} function${t.thin ? ' thin*' : '*'}(${t.params.map(tyName).join(', ')})`;
  }
  if (t.k === 'int') return `${t.u ? 'unsigned ' : ''}${INT_NAMES.get(t.w)}`;
  // 多播（第七十三刀）：`event m_e(int x)` 那一种带实参（第七十四刀）。
  if (t.k === 'mc') return `multicast (${t.params.map(tyName).join(', ')})`;
  if (t.k === 'enum') return shown(t.name);
  return t.k;
}

function sameTy(a, b) {
  if (a.k !== b.k) return false;
  if (a.k === 'ptr' || a.k === 'tptr') return sameTy(a.target, b.target);
  if (a.k === 'arr') return a.n === b.n && sameTy(a.el, b.el);
  if (a.k === 'struct') return a.name === b.name;
  // 类的同型只看名字：`C` 与 `C*` 在 jancy 那边是同一个表示（第五十二刀），`own` 记的只是
  // 源码里写没写 `*`，它管的是"要不要造对象"，不是类型的身份。
  if (a.k === 'class') return a.name === b.name;
  // 函数指针的同型看签名（第五十五刀）：形参一一同型、返回同型。`thin` 不看 —— 在这一层
  // fat 与 thin 落在方言的同一格里（thin 就是捕获为空的那一种），jancy 那边 thin 也是
  // 能隐式转成 fat 的（type_ptr_function.rst 的 "thin function pointers ... can be
  // converted to fat"）。
  if (a.k === 'fnptr') {
    if (a.params.length !== b.params.length) return false;
    for (let i = 0; i < a.params.length; i++) if (!sameTy(a.params[i], b.params[i])) return false;
    return sameTy(a.ret, b.ret);
  }
  // 多播的同型看那一串实参（第七十四刀）：处理函数一律回 void，所以只有这一串。
  if (a.k === 'mc') {
    if (a.params.length !== b.params.length) return false;
    for (let i = 0; i < a.params.length; i++) if (!sameTy(a.params[i], b.params[i])) return false;
    return true;
  }
  if (a.k === 'int') return a.w === b.w && !a.u === !b.u;
  if (a.k === 'enum') return a.name === b.name;
  return true;
}

/**
 * 隐式的整数转换（赋值、初值、实参、返回、`int` 之间的强制转换都走它）。
 *
 * 加宽不发一个字 —— 规范形里"8 位的 -1"与"64 位的 -1"是同一个数。变窄要回卷。
 *
 * **换符号性也要回卷**（第三十三刀）：同宽的两格里同一串位是两个不同的数
 * （`(int)-56` 与 `(unsigned int)4294967240`），所以那一格也得按目标那一侧重新规范化。
 * 加宽到有符号那一格例外 —— 无符号的规范形本来就是非负数，装进更宽的有符号格里不变。
 */
function intConv(v, to) {
  if (v.type.w === to.w && !v.type.u === !to.u) return v;
  const wider = to.w > v.type.w;
  if (wider && !to.u) return { code: v.code, type: to };
  if (wider && v.type.u) return { code: v.code, type: to };
  return { code: wrapTo(v.code, to.w, to.u), type: to };
}

const jncIsPtr = (t) => t.k === 'ptr' || t.k === 'tptr';

/** `.` 的左边落在哪个结构体上。jancy 里 `.` 与 `->` 是同一个算符（第二十五刀，
 *  samples/jnc/84_CurlyInitializers.jnc:66 那句 `point2.m_x` 的 point2 是 `Point*`），
 *  所以结构体那一格与"指到结构体的指针"都算 —— 两者的 code 都是那一段内存的地址。 */
function structBehind(t) {
  if (jncIsStruct(t)) return t;
  // 类那一格里放的**就是**对象那段内存的地址（第五十二刀），与"指到结构体的指针"同一档 ——
  // 所以 `c.m_x` 与 `p.m_x` 落在同一句 `pfield` 上，字段表也是同一张（this.structs）。
  if (isClass(t)) return { k: 'struct', name: t.name };
  if (jncIsPtr(t) && jncIsStruct(t.target)) return t.target;
  return null;
}

/** `.` 的左边是这几种形状时走左值那条路（它们本身可写）；别的当右值求一次值。
 *  `this` 也在里面（第五十二刀）：它是方法的第一个形参，本身就是一格。 */
const LV_SHAPES = new Set(['name', 'field', 'index', 'ptr-field', 'indirect', 'this']);

/** `T* … property p` 里，最后一个 `*` 后面那一组词里**这一层认得的**那几个（第七十二刀）。
 *  取自 jancy 那张 `TypeModifierMaskKind_Property`（jnc_ct_Decl.h:75-85）：属性这条声明能带
 *  的就是那一张表。别的词落在那儿明说不收 —— 免得"提上来"变成"悄悄丢掉"。 */
/** 可变性那一族（第六十七刀）：jancy 把它们归进同一个互斥组（Decl.cpp:96 的
 *  antiModifierTable）。`autoconst` 是**主拼法**，`cmut` / `constif` 是 legacy 别名
 *  （Lexer.rl:216-218 那三行的注释写着 "legacy code support"）。这一层没有可变性检查，
 *  所以五个词落地是同一件事：收下、不看。 */
const MUT_MODS = new Set(['const', 'readonly', 'cmut', 'autoconst', 'constif']);

const PROP_TAIL_MODS = new Set(['property', 'autoget', 'bindable', 'const', 'readonly', 'cmut',
  'autoconst', 'constif', 'errorcode']);

/** 这条语句是 `名字:` 那种标签吗（第五十九刀）。语法上 `catch:` / `finally:` / `nestedscope:`
 *  都发成 `(label "名字")`，见 jnc.grammar 那三条。 */
function isLabel(n, name) {
  if (!isList(n) || head(n) !== 'label') return false;
  const a = n.items[1];
  return (isStr(a) || isAtom(a)) && a.value === name;
}

/** 哪几种语句开"errorcode 传播"的落点（第五十八刀，见 stmt）：条件在这条语句里**只求一遍**
 *  的那些。循环那三种（while / do / for）不在里面 —— 它们的条件每一圈重求一次，把那次调用
 *  抬到循环之前就只检一次，是错的。 */
const EC_HOIST = new Set(['var-decl', 'var-decl-curly', 'expr-stmt', 'return', 'if', 'switch', 'assert']);

/** 零值的**方言文本**。jancy 保证"用户代码碰到之前每一格都是零"（type_ptr_data.rst），所以
 *  没写初值的局部量这里显式发一个零 —— 方言的 `(let …)` 要一个初值。
 *
 *  名字里带 Text 不是啰嗦：`interp/builtin.js` 里有个同名的 `zeroOf` 造的是**运行期的值**，
 *  而自举那一遍要求模块级的名字全局唯一，两个 `zeroOf` 撞在一起会让 `tests/mir` 整条轴红。 */
/**
 * jancy 全局 CRT 里**字符那一族**的判据（第一百七十六刀）。一格名字对一格方言表达式，
 * 形参叫 `c`。范围全按 **ASCII** 写死 —— 为什么不叫 C 库的同名函数、以及这条与 jancy 的
 * Unicode 版在 ≥128 上的分岔，见 `crtCall` 的注释与 ADR-0016 第一百七十六刀那一节。
 */
const CRT_RANGE = (lo, hi) => `(bin "&&" (bin ">=" (var c) (int ${lo})) (bin "<=" (var c) (int ${hi})))`;
const CRT_DIGIT = CRT_RANGE(48, 57);
const CRT_UPPER = CRT_RANGE(65, 90);
const CRT_LOWER = CRT_RANGE(97, 122);
const CRT_ALPHA = `(bin "||" ${CRT_UPPER} ${CRT_LOWER})`;
const CRT_ALNUM = `(bin "||" ${CRT_ALPHA} ${CRT_DIGIT})`;
const CRT_PRINT = CRT_RANGE(32, 126);
const CRT_CHAR = new Map([
  ['isdigit', { ret: J_BOOL, body: CRT_DIGIT }],
  ['isupper', { ret: J_BOOL, body: CRT_UPPER }],
  ['islower', { ret: J_BOOL, body: CRT_LOWER }],
  ['isalpha', { ret: J_BOOL, body: CRT_ALPHA }],
  ['isalnum', { ret: J_BOOL, body: CRT_ALNUM }],
  ['isprint', { ret: J_BOOL, body: CRT_PRINT }],
  // 空白那几格照 C 的定义：空格与 \t \n \v \f \r（9..13）。
  ['isspace', { ret: J_BOOL, body: `(bin "||" (bin "==" (var c) (int 32)) ${CRT_RANGE(9, 13)})` }],
  // 标点 = 印得出来、又不是字母数字、又不是空格（C 的定义就是这么写的）。
  ['ispunct', { ret: J_BOOL, body: `(bin "&&" ${CRT_PRINT} (un "!" (bin "||" ${CRT_ALNUM} (bin "==" (var c) (int 32)))))` }],
  ['toupper', { ret: mkInt(32, true), body: `(sel ${CRT_LOWER} (bin "-" (var c) (int 32)) (var c))` }],
  ['tolower', { ret: mkInt(32, true), body: `(sel ${CRT_UPPER} (bin "+" (var c) (int 32)) (var c))` }],
]);

function zeroText(t) {
  if (t.k === 'int') return '(int 0)';
  if (t.k === 'real') return '(real 0.0)';
  if (t.k === 'bool') return '(bool false)';
  if (t.k === 'string') return '(str "")';
  if (t.k === 'ptr' || t.k === 'tptr') return `(pnull ${tyText(t)})`;
  // 类指针的零值是空引用（第五十二刀）：`C* p;` 那一格出来是 null，要 `new C` 才有对象。
  if (t.k === 'class') return `(pnull (ptr ${clsRoot(t.name)}))`;
  /* 函数值的零值就是**空的那一格**（第一百七十五刀）：`(null (fnty …))`。jancy 那边
     `void function* p;` 出来的也是零、调它是运行期的 "null function pointer" 错 ——
     方言那一侧 `NullFn` 与它逐条对得上（`callfn` 到空值上是运行期错，
     tests/llvm/three-way/21_null_fn_call.omni 那一份量的就是它）。 */
  if (t.k === 'fnptr') return `(null ${tyText(t)})`;
  return null;
}

/**
 * `errorcode` 那一格的**出错值**（第五十八刀，exceptions.rst:17："Intuitive defaults are
 * assumed: `false` for bools, `-1` for integers and `null` for pointers"）。
 *
 * 无符号整数上的 -1 就是那一格全 1（这一层的整数一律以回卷后的样子存着，所以这儿直接写
 * 那个数）。别的类型（void / real / 结构体 / 数组 / 函数指针）jancy 没给默认值，回 null。
 */
function jncErrText(t) {
  if (t.k === 'bool') return '(bool false)';
  if (t.k === 'int') return `(int ${t.u ? (1n << BigInt(t.w)) - 1n : -1n})`;
  if (t.k === 'ptr' || t.k === 'tptr') return `(pnull ${tyText(t)})`;
  if (t.k === 'class') return `(pnull (ptr ${clsRoot(t.name)}))`;
  // 枚举在 jancy 的那张表里带 Integer 位（jnc_Type.cpp:107-111），所以它的出错值走整数那一条
  // —— 按基整数那一格的 -1。方言里枚举本来就发成 int（tyText 那处），于是文本一模一样。
  if (t.k === 'enum' && t.base !== undefined && t.base !== null) return jncErrText(t.base);
  return null;
}

/**
 * 「这一次调用出错了吗」（第五十八刀）。jancy 的 `checkErrorCode` 算的是一格**指示值**：
 * bool 与"不是纯整数"的那些（指针）拿返回值自己当条件，纯整数则先比一次 `!= -1`，
 * 然后指示值为**假**时才跳去抛（jnc_ct_ControlFlowMgr_Eh.cpp:258-268）。所以这儿就是它的
 * 反面 —— 指针那一支用 `pisnull`（方言里没有指针相等，跟 null 比只有这一个算子）。
 */
function errTest(code, t) {
  if (t.k === 'bool') return `(un "!" ${code})`;
  if (t.k === 'ptr' || t.k === 'tptr' || t.k === 'class') return `(pisnull ${code})`;
  const ev = jncErrText(t);
  return ev === null ? null : `(bin "==" ${code} ${ev})`;
}

/**
 * jancy 认哪些类型当错误码：`isErrorCodeType`（jnc_ct_Type.h:635-639）问的是那张
 * flagTable 里的 `ErrorCode` 位（jnc_Type.cpp:29-181）—— bool、int8..int64（有无符号
 * 都算）、枚举、变体、字符串，以及数据 / 类 / 函数 / 属性指针。`void` 那一行整个是 0，
 * `float` / `double` 那两行只有 `Fp|Nullable|Numeric` —— 它们**当不了**错误码，写上
 * `errorcode` 在 jancy 那边就是一条硬错（jnc_ct_FunctionType.cpp:180-181）。
 */
function errCodeOk(t) {
  return t.k === 'bool' || t.k === 'int' || t.k === 'enum' || t.k === 'string'
    || t.k === 'ptr' || t.k === 'tptr' || t.k === 'class' || t.k === 'fnptr';
}

/** jnc 语法树 -> 核心方言文本。 */
export function lowerJnc(tree, diags, opts) {
  const L = new JncLower(diags, opts === undefined ? {} : opts);
  // 继承链那张表是模块级的（见 CLS_ROOT），所以每次降级先清空 —— 同一个进程里 sx 与 run
  // 会连着降两遍同一份源码，上一遍的链不能漏到下一遍。
  CLS_ROOT.clear();
  return L.run(tree);
}

class JncLower {
  constructor(diags, opts) {
    this.diags = diags;
    this.opts = opts;
    this.decls = [];        // 顶层：struct 与 fn 的文本
    this.structs = new Map();  // 名字 -> [{name, type}]
    this.fns = new Map();      // 名字 -> {params: [type], ret}
    this.scopes = [];          // 局部量：名字 -> 类型
    this.unsafe = false;       // 在 (unsafe …) 里面
    this.mainBody = null;      // `int main()` 的体（降成方言的 `(main …)`）
    this.retTy = J_VOID;       // 当前函数的返回类型
    // 循环栈（第四十一刀）。每进一层"可跳的东西"压一格：真循环是 `sw: false`，switch 摊出来
    // 的那圈合成循环是 `sw: true`。`break N` 数**全部**（jancy 把 switch 也算一层，
    // cflow_switch.rst:37），`continue N` 只数真循环 —— 与 C 一致。`step` 记着这一层是不是
    // 带步进的 for（那格的 continue 还接不了，见 stmt）。
    this.loops = [];
    // 正在解体的那个枚举（第四十八刀）。只有它非 null 时，编译期求值才认光一个名字 ——
    // 那是同一个枚举里已经定下的成员（`Bridged = Opened + 1`）。
    this.constEnum = null;
    this.aliases = new Map();  // typedef 起的类型名 -> 解出来的那一格（第三十八刀）
    this.enums = new Map();    // 枚举名 -> { base, members: Map(名字 -> BigInt) }（第三十九刀）
    /* 无名枚举（第九十六刀）：那一格声明的节点 -> 给它编的名字（`$anon<序号>`）。按节点记 ——
       名字那一遍与体那一遍要拿到同一个。 */
    this.anonEnum = new Map();
    /* `pragma(ExposedEnums, true)` 开着时声明的那些**带名字的**枚举（第二百一十六刀）：
       按节点记，enumName / enumDecl 那两遍把它们当"无名那一种"待（成员漏到外面那层）。 */
    this.exposedEnums = new Set();
    /* 命名空间的名字（第二百一十七刀）：`using namespace X;` 要先认出 X 是一层命名空间。
       nsFlat 那一遍每开一层就记一格（嵌套写法的每一层都记）。 */
    this.nsNames = new Set();
    /* `using namespace X;` 那几张表（第二百一十七刀）：`{ in, ns, node }` ——
       `in` 是它写在哪一层（''是顶层，顶层那一张对整份源码有效），`ns` 是它指的那一层。
       resolve 里那条链找不着时才看这几张，所以它只会**多认**名字、不会改已经认得的那些。 */
    this.usingNs = [];
    // 两张 using 表里都有同一个名字（第二百一十七刀）：jancy 那边报歧义，这儿攒着 run 末尾报。
    this.usingAmbig = new Map();
    /* 无名枚举**漏到外面那层命名空间**的那些成员（第九十六刀，jancy 那边叫 exposed）：
       外面看到的那个名字 -> { en, mn }。查名时在"未声明的变量"之前多问这一张。 */
    this.exposedMems = new Map();
    this.tmp = 0;              // 生成名字的计数（do-while 的那格标志）
    this.lifted = new Set();   // 这个函数里被取过地址的局部量名（ADR-0016 第九刀）
    this.globals = new Map();  // 模块级变量：名字 -> 类型（第十一刀）
    this.globalCells = [];     // 模块级变量里"要一段自己的内存"的那些 pnew，跑在初值之前
    this.globalInit = [];      // 模块级变量的初值语句，按声明序，跑在 main 的体之前
    this.gTaken = new Set();   // 这份源码里被 `&` 取过地址的名字（第二十四刀：全局那一半）
    this.gLifted = new Set();  // 因此被提到一格内存里的**模块级**标量名
    this.alias = new Map();    // 名字 -> 方言里的名字（结构体形参那一份拷贝，第十三刀）
    this.sigs = new Map();     // 函数定义的节点 -> 它的签名（第十五刀，run 里先过一遍）
    this.mainSeen = false;     // `int main()` 见过了（查重要在签名那一遍就做）
    // 命名空间（第五十一刀）。`this.ns` 是当前所在的那一格，内部一律用 `$` 连 —— 点不是
    // 方言里合法的标识符字符，而上面那五张表的键**同时**就是方言里的名字。报错时换回点
    // （`shown`），那才是源码里写的样子。
    this.ns = '';
    // import（第六十刀）。`find(spec, from)` 还回来一格规范化好的路径或者 null，
    // `parse(path)` 还回来那个文件的语法树 —— 两个都由 cli.js 给（降级这一层不碰文件系统）。
    // `unit` 是入口文件自己那一格，一开始就记进 `impSeen`：jancy 的 parseFile 也是拿
    // `m_filePathSet` 拦重复的，而入口文件就在那张表里（jnc_ct_Module.cpp:390-392），
    // 所以 `import` 到自己身上是一句空话，不会把整份源码再摊一遍。
    this.impFind = opts.find === undefined ? null : opts.find;
    this.impParse = opts.parse === undefined ? null : opts.parse;
    /* `import "libfoo.dylib" with "foo.h"` 的那一半（ADR-0022 的 J4d）：
       `decls(spec, from)` 回 `{decls, skipped, consts, constSkipped}`（`cap('c.declsOf')`
       那一格）或者 `null`。与 `find`/`parse` 同一种带法 —— 这一层不碰文件系统。 */
    this.impDecls = opts.decls === undefined ? null : opts.decls;
    /* `with "h.h"` 收进来的那些外部符号名（ADR-0022 的 J4d）。调用点在 `ccallSite` 那儿
       发 `(ccall …)`，签名从 `cabiSigs` 来。这张名字表留着是给**诊断**用的：一个名字在
       表里而签名对不上时，说的是"实参不对"而不是"没有这个函数"。 */
    this.cabiNames = new Set();
    /* 名字 -> `{ ret, params }`（C_ABI 的那几个词）。调用点靠它发 `(ccall …)`：
       实参按声明检查、返回类型按声明给 —— 都不是猜的。 */
    this.cabiSigs = new Map();
    /* `with "h.h"` 收进来的**常量**（宏与枚举常量，ADR-0022 的 J4d）。用 `with` 的
       全部理由就在这儿：`GL_COLOR_BUFFER_BIT` 在 C 里是 `#define`，不是函数 ——
       头文件是那个名字的唯一出处，没有这一格，一个 OpenGL 程序只能把 `16384` 抄进源码。
       名字 -> `{ kind: 'int'|'real'|'str', value }`；用到的地方（`case 'name'`）当场
       变成一格字面量，所以它们不占运行期的任何东西。 */
    this.cconsts = new Map();
    /* `import "libfoo.dylib" as g`（**没有** `with`）里那个 `g`。一个类型都不知道 ——
       调用点按实参推一份签名出来，并且报一条 warning。 */
    this.cLibNs = new Set();

    // 格式化字面量里 `$(…)` 那一段要再解析一遍（第六十四刀）。没给就当没有那一格。
    this.parseExpr = opts.parseExpr === undefined ? null : opts.parseExpr;
    // 要不要入口（第六十五刀）：跑的那几条腿要，`omni sx` 只降不跑，不要。
    this.needEntry = opts.needEntry !== false;
    // `-I` 那张目录表（第六十二刀）。找文件这件事全在 cli.js 的 find 里，这一层只拿它
    // **报错时说清在哪儿找过**，所以存的是表本身而不是一个数。
    this.impDirs = opts.dirs === undefined ? [] : opts.dirs;
    this.unit = opts.unit === undefined ? null : opts.unit;
    this.impSeen = new Set(this.unit === null ? [] : [this.unit]);
    this.impQ = [];                     // 待办：{node, spec, from}
    this.impFrom = this.unit;           // 正在摊的是哪个文件（import 的"来处"）
    // 类（第五十二刀）。字段表与结构体共用 `this.structs` —— 类在方言里就是一格 `(struct …)`
    // 加"变量里放地址"，所以 `pfield` 那一整套原样可用。`classes` 记的是"这个名字是类"，
    // `methods` 是"这个函数是某个类的方法"（名字 -> 类名），`selfClass` 是正在降的方法属于谁。
    this.classes = new Set();
    // 属性（第六十八刀）。名字 -> {type, cls, cst, idx, get, set}：`cls` 是它属于哪个类
    // （顶层的属性是 null），`cst` 是"只有取"（`T const property p`），`idx` 是**下标**那一串
    // 类型（第七十刀的索引属性，空数组就是普通属性）。
    this.props = new Map();
    // 类体里那些成员属性的待办（第六十九刀）：{it, ns}。类体是在 typeDecl 那一遍看的，而
    // 属性的名字要坐在**签名那一遍之前** —— 于是那一遍只把它们记下来，登记与顶层那一格
    // 合在同一处（见 run 里属性那一遍）。
    this.propPend = [];
    // 成员属性的**裸名**（第六十九刀）。`obj.p` 那一处要在"把左边当值算"之前问一句"右边这个
    // 名字有没有可能是属性" —— 与 methodNames（第五十五刀）同一个用处：没这一格就得为每一次
    // 取字段都把左边算一遍。
    this.propNames = new Set();
    // `autoget` 属性（第七十一刀）：那格**编译器生成的存储**要落地。顶层的落成一格模块级
    // 变量、成员的落成类里的一格字段 —— 名字都是 `<属性全名>$m_value`（源码里写的是
    // `m_value`，prop_autoget.rst:26）。这张单子攒的是"要发的那一格 + 要合成的取值器"，
    // 发出去的时机排在 gTaken 数完之后（那一问决定顶层那一格要不要提到自己的内存里）。
    this.autoProps = [];
    // `bindable` 属性（第七十三刀）：那格**编译器生成的事件**要落地 —— 一格模块级的
    // `(arr (fnty () void))`，名字是 `<属性全名>$m_onChanged`（源码里写的是 `m_onChanged`，
    // prop_bindable.rst:23-29）。发的时机与 autoProps 同一处。
    this.bindProps = [];
    // 那格"照单子挨个叫一遍"的助手：签名 -> 名字（一种签名一格）。
    this.mcFires = new Map();
    /* 完整声明式的属性里，体内那格字段与那格事件的**名字**（第七十六刀）：属性全名 ->
       `{store, onch}`。改写出来的简单声明式记不住它们（写的人叫它 `m_x` / `m_e`，而默认是
       `m_value` / `m_onChanged`），所以在改写那一遍记一笔，autoStore / bindStore 照它拼。 */
    this.propMemName = new Map();
    /* 属性的全名 -> `{onch}`：那格 onChanged **不生成**、就用外层已经有的那格成员
       （`bindable alias 新名字 = m_onChanged;`，第一百五十八刀）。出处见 fullPropMember 里
       那段注（jnc_ct_Parser.cpp:1354 那句 `prop->setOnChanged(alias)`）。 */
    this.propAlias = new Map();
    // 取/存那两个函数的名字 -> 属性的全名（第七十一刀）。函数体降下来时靠它把 `this.ns`
    // 再往里挪一层：属性在 jancy 那边**本来就是一层命名空间**（prop_full.rst:15）。
    this.propOf = new Map();
    // 正在降的这个函数是某格成员 autoget 属性的存值器时，这儿放那格字段的**真名**
    // （`m_p$m_value`）—— selfField 拿它把源码里的 `m_value` 换过去。
    this.selfProp = null;
    // `opaque class` 的名字（第六十六刀）。见 typeName 那处的注释：这一层不读它。
    this.opaques = new Set();
    // 宿主那边的成员（第六十六刀）：`hostFns` 是方法的裸名 -> 类名，`hostCtors` 是
    // "construct 在宿主那边"的类名。两者都只在**按名字查不着**之后才问，见 callName。
    /* 名字 -> **一组**主人（第一百六十八刀把它从"一格"改成"一组"）：同一个方法名可以在好几个
       `opaque class` 上各声明一条（`setOptions` 在 `ui.FlagProperty` 与 `ui.EnumProperty` 上都有，
       ui_PropertyGrid.jnc:145/334）。先前这儿只记一格 —— 后声明的盖掉前面的，于是
       `enumProp.setOptions(…)` 会按**另一个类**那一条去查型、发的还是那个类的符号，
       是个静默的错答案（逐份榜上 88 处）。 */
    this.hostFns = new Map();
    /* 那些方法的**签名**（`类名$方法名` -> `{owner, ret, params}`，jnc 类型）。调用点靠它
       发 `(cabi Owner_method …)` 与 `(ccall Owner_method self …)`（ADR-0022 的 J4b 最后一步）。 */
    this.hostSigs = new Map();
    this.hostCtors = new Set();

    /* 那些 `opaque class` 里 `construct` 的**形参类型**（第一百六十二刀）：`new C(…)` 据此发
       `(ccall C_construct self …)` —— 与方法（J4b）、属性的取/存（第一百六十刀）同一条约定。 */
    /* 宿主面那几格 construct 的签名（第一百六十二刀；第二百〇七刀改成一格一族）：
       类名 -> `[{params, defs}, …]`（默认值那一格是第一百九十一刀）。同名好几条 ctor
       jancy 明写收（type_class.rst:63），挑哪一条与顶层那几条原型共用 hostPickSigs。 */
    this.hostCtorSigs = new Map();
    /* 属性全名 -> `{get, set}`：那两个取/存**只有原型、没有体**（`opaque class` 里那种，
       ui_PropertyGrid.jnc:78-88）。体在宿主的 C/C++ 那边，所以读写落成
       `(ccall Owner_get_prop self)` / `(ccall Owner_set_prop self v)` —— 与方法那一格
       （ADR-0022 的 J4b）同一条路，第一百六十刀。 */
    this.propHostAcc = new Map();
    /* 类 / 结构体体里**只有原型**的方法（第一百四十七刀）：裸名 -> 那几个主人的名字。
       与 hostFns 分开是因为**那些类没写 `opaque`** —— 不能替它们认下"实现在宿主的 C/C++ 那边"
       这件事（那会凭空发一格 `(ccall …)`）。这一格只用来把调用点那句话说对：
       "没有这个函数"是**认错人**（那个名字明明声明过），第九十二刀给顶层原型定的说法照抄过来。 */
    this.protoMethods = new Map();
    /* 那些只有原型的方法**收几个实参**（第一百六十六刀）：键是 `类$方法`，值是那几条原型的
       实参个数。第一百五十刀那句话只说得出"同名的还有只有原型的"，说不出"合得上的就是它" ——
       有了这张表，调用点给的个数正好是其中一条时就能把话说定（那才是真拦路的东西）。
       只记**个数**、不记类型：类型要走 formalList，那一遍会自己发诊断，而这一格只想把话说对，
       不想因为记账多报一句。 */
    this.protoArity = new Map();

    /* 那些类里 `construct` **只有原型**的（第一百四十八刀）：与 protoMethods 同一笔账，
       单独一格是因为构造走的不是按名字查那条路（`ctors` / `ctorArgs` / `ctorCall`）。 */
    this.protoCtors = new Set();
    /* 顶层**只有原型**的函数（第一百五十一刀）：`size_t errorcode receive(void* p, size_t size,
       uint_t timeout = -1);`（ias.jnc:43）—— 那一遍（globalDecl）排在函数体那一遍之前，
       所以调用点问得着。用处与 protoMethods 一样：调它报的不该是"没有这个函数"。 */
    /* 声明那一句自己没成（类型认不出来那一族）、于是名字**没登记上**的那几格（第二百三十五刀）：
       后面每一处用到它都跟着报一句"未声明的变量"，那是认错人 —— 声明明明写着，是那一句先没成。
       记在这儿，好在查名那两处说准。 */
    this.badNames = new Set();
    this.protoFns = new Set();
    /* 顶层那些只有原型的函数的签名（第一百八十五刀）：名字 -> `{ret, params, defs}`。
       调用点据此发 `(ccall <全名把 $ 换成 _> …)` —— 与类里那些（hostSigs）同一条约定。 */
    this.hostTopSigs = new Map();
    /* `basetype.construct(…)` 那一格的基类名（第一百九十二刀）：baseTarget 回哨兵时把它记在这儿，
       调用点那一步取走就用完（同一次调用里一来一回，不跨语句）。 */
    this.baseHostCtor = null;
    this.methods = new Map();
    this.methodNames = new Set();
    this.selfClass = null;
    this.nsExtra = null;
    // 构造（第五十三刀）。`ctors` 是类名 -> {name, params}（那一格是实例构造，方言里的名字是
    // `C$construct`），`sctors` 是类名 -> 静态构造的方言名。静态构造**在实例构造的开头调、
    // 只调一次**（jnc_ct_Parser.cpp:3005-3009 那四句的第二句 + MemberBlock 里那个
    // `ModuleItemFlag_Constructed` 闸门），所以要一格模块级的 bool。
    this.ctors = new Map();
    /** 赋值算符（第一百三十刀）：主人 -> `{name, param, ret}`。赋值那一处按左边的类型来这儿找。 */
    this.opAssign = new Map();
    /* 复合赋值算符（第一百五十二刀）：`主人$算符` -> `{name, param, ret}`。与 opAssign 分开一格
       是因为一格主人身上这十个算符各自都能有一条，键里得带上是哪一个。 */
    this.opCompound = new Map();
    /* 自增自减那一族的算符重载（第一百三十一刀）：拼好的名字进这一格。只用记"在不在" ——
       调用点（`it++;` 那条语句）自己按主人的类型把名字拼回来。 */
    this.opIncDec = new Set();
    /* 取值那两个算符（第一百三十四刀）：`Owner$op$mul` / `Owner$op$arrow` -> { name, ret }。
       这一族的调用点在**求值**那条路上，所以要记住回的是什么类型（`*it` 整格的类型就是它）。 */
    this.opUnary = new Map();
    /* 下标算符（第一百三十八刀）：owner -> { get: {name, sub, val}, set: {…} }。
       类 / 结构体体里**裸写**的 `get` / `set` 就是它（`c[i]` / `c[i] = v` 走这两格）。 */
    this.opIndex = new Map();
    /* 类型名 -> 它那格调用算符（第二百〇二刀）：`{name, stat, ret, params, defs}`。
       `params` 里含 `this` 那一格（静态的没有）。 */
    this.opCalls = new Map();
    /* `dylib X { … }` 摊平之后那一层命名空间的全名（第二百〇三刀）：里头那些原型的 C 符号名
       是**成员名**本身，不是"全名把 `$` 换成 `_`"。 */
    this.dylibNs = new Set();
    /* 相等算符（第一百四十刀）：`Owner$op$eq` / `$op$ne` -> { name, param }。
       语料里的原样是 std_Guid.jnc:80/84 —— `bool operator == (Guid const* op) thin const`。 */
    this.opCmp = new Map();
    /* 枚举成员的值**算不出来时先记着**（第一百四十一刀）：初值可能引用**后面才声明的**枚举
       （`Start = ui.StdColor.PastelPurple`，log_Representation.jnc:74 —— 而 ui_Color.jnc 排在
       它后面）。jancy 那边是"先把名字都声明下来、再算值"的两遍，这一层是一遍，所以这儿留一格
       重试的名单：这一遍走完再来几轮，跑到不动点。`enumRetry` 为真的那一遍才报。 */
    this.enumTodo = [];
    this.enumRetry = false;
    this.sctors = new Map();
    this.gates = new Map();     // 类名 -> 那道"静态构造跑过了"的模块级 bool
    // 方法名 -> 它那段闭包 thunk（第五十五刀）。`c.foo` 当值用时捕的是对象，一个方法一段。
    this.clos = new Map();
    // 单继承（第五十六刀）：类名 -> 基类的全名 / 类名 -> 这条链的**根**。方言里一整条链
    // 共用**一格** `(struct 根 …)`（字段是整条链的并集），所以 `D*` 与 `B*` 是同一个方言
    // 类型 —— 上转一个字都不用发，也不需要方言长出指针的重解释。
    this.bases = new Map();
    /* 多继承（第九十四刀）：类名 -> 第二格起的那些基类。第一格照旧待在 `this.bases` 里 ——
     * 它是"链"那条脊梁（构造顺序、basetype 不带序号时指谁都按它）。第二格起的这些在这一层
     * 与第一格是**同一格待遇**：名字查得着、上转装得进、根合成同一格结构体。jancy 那句
     * "multiple instances of shared bases"（type_class.rst:171-174）这一层做不到 ——
     * 一条链一格结构体，同一个基类出现两次只有一份，所以那一种当场拒（见 classLayout）。 */
    this.mixins = new Map();
    this.roots = new Map();
    this.ownFields = new Map();   // 类名 -> 它自己那几格字段（基类的不算）
    this.pendingCls = [];         // 类的 `(struct …)` 推迟到整条链都知道了再发
    this.synthSC = new Set();     // 只有静态构造、那一个实例构造是合成出来的类
    /* 字段的默认值（第七十八刀）。类名 -> `[{ name, type, expr, node }]`。
     * jancy 那边**没有**单独的预构造：初值是挂在 `Field` 上的一串 token（jnc_ct_Field.h:21-42），
     * 由 `MemberBlock::initializeFields`（MemberBlock.cpp:141-182）在**构造函数里面**重放 ——
     * 要么在合成出来的默认构造里（DerivableType.cpp:909-927），要么插在用户写的 `construct`
     * 开头、基类构造之后（Parser.cpp:2997-3010）。所以它们是构造体里的普通代码，能引用
     * `this`、别的字段、方法、全局量 —— 这一层照做：把它们降成 `construct` 开头的几条赋值。
     * `synthFI` 是"有初值但没写 construct、那一个由我们合成"的类：签名那一遍先把它登记进
     * `ctors`（`C1 a;` / `new C1` 才接得上），**体推迟到函数体那一遍之后再发** ——
     * 初值里可以引用模块级变量，而那些在签名那一遍还没登记。 */
    this.fieldInits = new Map();
    this.synthFI = new Set();
    /* 类里那些**类型是类的值**的字段（第一百六十一刀）：`ui.Menu m_menu;` —— jancy 那边它是
       **内嵌**的对象（`ClassType::m_classFieldArray`，jnc_ct_ClassType.cpp:360-371；父对象的
       构造里逐格 `initialize` 出来，MemberBlock::initializeFields，jnc_ct_MemberBlock.cpp:141-179）。
       这一层的类值本来就是"一格地址 + 一次 pnew"（局部量那一格从第五十二刀起就是这么落的），
       所以字段照原样是一格地址，父对象的构造开头把它造出来、写 `$tag`、调它的 construct。
       结构体那一侧 jancy 直接报错（`class '…' cannot be a struct member`，
       jnc_ct_StructType.cpp:303-307），这一层照它报。 */
    this.embFields = new Map();
    /* 类里的事件那几格字段（第八十三刀）。类名 -> `[{ name, type }]`。
     * 那一格在方言里是一格数组的句柄（多播的处理函数单子），所以**造对象的时候要把单子
     * 建起来**：`(pstore (pfield (var $this) m_e) (anew (arr …) (int 0)))`。
     * 发那几行的地方与字段默认值同一处（fnDef 的 pre 与 emitFieldInitCtors）—— 排在
     * 源码写的字段初值**之前**，因为初值里可以引用这格事件（`m_e += h` 那种）。 */
    this.evtFields = new Map();
    /* 那几格事件字段的**名字**（第八十三刀）。mcRef 拿它做一次便宜的预筛：对着任何 `a.b`
       都去求左边那个对象会多发诊断，所以先按名字问一句"这可能是事件吗"。 */
    this.evtNames = new Set();
    /* reactor（第八十五刀）：全名 -> `{full, cls, on, body, node}`。
     * `cls` 非 null 的那些是类的成员（语料里 49/49 都是这一种：类里写 `reactor m_uiReactor;`、
     * 体写在类外 `reactor Cls.m_uiReactor { … }`），`on` 是"跑没跑"那一格的名字
     * （成员是类里的一格 bool 字段，顶层是一格模块级 bool）。`body` 是那个 compound 节点，
     * 声明与体分两处时由后面那一遍补上。 */
    this.reactors = new Map();
    /* 那些 reactor 成员的**短名**：`s.m_uiReactor.start()` 这种调用要先按名字便宜地筛一次
       （与 evtNames 同一条理由）。 */
    this.rctNames = new Set();
    /* 类体里**就带着体**的那些 reactor（第九十五刀）：`reactor m_r { … }` 写在类里。按节点记，
       因为那一格 fn-def 同时也待在被提到顶层的那一批里（nsFlat），reactorBody 那一遍要认得
       出"这一格已经当成员登记过了"。 */
    this.rctInline = new Set();
    /* 写在**原型**上的形参默认值（第一百刀）：`类名$方法名#元数` -> 那几格默认值的语法节点。
       jancy 的默认值是挂在 `FunctionArg` 上的（`hasInitializer`），而"体写在类外"那种放法里
       它只出现在类体里那句原型上 —— 体外那个定义不必再写一遍（ui_PropertyGrid.jnc:233-245
       就是这个形状）。签名那一遍看的是定义，所以这一格要单独记着、之后并进签名。 */
    this.protoDefs = new Map();
    /* 那些要等签名那一遍才办得了的 alias（第八十七刀）：目标是函数 / 方法的那些。 */
    this.aliasPend = [];
    /* 目标是**字段路径**的 alias（第一百〇四刀）：`alias m_head = m_list.m_head;`
       （stdt_Map.jnc:85）。别名全名 -> { path: ['m_list','m_head'], type }。
       它落不成"一格既有的东西"（类型别名进 aliases、方法别名发转手函数），要的是查名那一步
       多一层展开：`(pfield (pfield 基 m_list) m_head)`。展开点两处 —— 裸名字（selfPathLv）
       与 `obj.别名`（memberOf）。 */
    this.aliasPath = new Map();
    /* 位域（第一百一十二刀）。`uint8_t m_a : 4;` —— 它**不是一格字段**：同一格存储里的几位。
       全名（`结构体$成员`）-> { path, type, off, cnt, bw }：
         path 是从那格结构体的基走到**存储那一格**的一串 pfield（普通字段是 `['$b0']`，
              匿名 union 里再套的匿名 struct 里那些是 `['$s0','$b0']`），
         type 是**声明写的**那格整数类型（读出来的值是它 —— 有符号的要补符号位），
         off/cnt 是它在存储里的位偏移与位数，bw 是存储那一格的位宽（声明类型的宽度）。
       读是 `(存储 >> off) & 掩码`（有符号再补符号位），写是**读-改-写** —— 两处都在
       read / store 里，于是 `=`、`++`、复合赋值一条都不用单独接。 */
    this.bitPath = new Map();
    /* `bigendian` 的字段（第一百二十六刀）：`类$字段` -> `{type, w}`。存储是一格普通整数，
       读写各套一次字节序反转 —— 与位域那张表同一个位置、同一种用法。 */
    this.bePath = new Map();
    /* 哪些结构体里有位域。只有一处用：花括号初值那一遍拦住它们（见 curlyMember）——
       那儿是按"第几格字段"数的，而位域不占自己的格子，数下去就是个静默的错答案。 */
    this.bitAggs = new Set();
    /** 已经发出去的 variant 装箱 / 拆箱助手（第一百一十三刀）—— 一格一次。 */
    this.varFns = new Set();
    /* 类型是**函数指针的字段**的名字（第一百一十七刀）。只有一处用：`c.m_f(…)` 这种
       "从一格函数指针字段上调"要与"调一个方法"分得开。放一张名字表而不是就地去问，是因为
       就地问要先求左边那个值、而求值会发诊断 —— 那会给真的"没有这个函数"多发一条。
       与 `methodNames` / `propNames` 是同一个办法。 */
    this.fnFieldNames = new Set();
    /* 泛型（ADR-0025 的 S2）。全名 -> `{full, ns, params: [参数名…], agg}` ——
       泛型声明**不产出类型**，只记在这儿；类型是实例化那一步才造的（S3）。 */
    this.templates = new Map();
    /** 结构体的名字 -> `{node, ns}`（第一百二十五刀）：基类那张字段表要按声明去找，而
        顶层不保证先声明后使用 —— 碰上还没摊开的基类就地先摊，靠的是这张表。 */
    this.structNodes = new Map();
    /** 已经摊开过的结构体（同一格别摊两遍 —— 那会把 `(struct …)` 发两条）。 */
    this.laidStructs = new Set();
    /** 正在摊的那几格（基类绕回自己时当场拒，不然递归不停）。 */
    this.layingStructs = new Set();
    /* 结构体 -> 它的直接基类那几格（第一百二十五刀）。这一刀**只做布局**，上转（`D*` 装进
       `B*`）还不收：与类那一侧不同，一条结构体继承链在方言里是**几格不同的结构体**（不能像
       classLayout 那样合成一格 —— 结构体的字节布局是可观测的，语料里全是协议头，合起来
       `Point` 就跟 `Point3D` 一样大了），而方言的指针没有类型重解释那一格。界记在
       `bad/structbase-up`。这张表先留着：那一刀要用它判前缀关系。 */
    this.structSuper = new Map();
    /** 已经合成过的实例名（按实参签名 memoise，与 jancy 的 `m_instanceMap` 同一个办法）。 */
    this.tmplInsts = new Set();
    /* 实例名 -> 那个泛型**声明处**的那一层命名空间（第一百三十二刀）。实例名是
       `模板名$实参键` 拼的，里头那个 `$` 不是一层命名空间 —— 查名往外退的时候要
       整块跳过去，见 resolve。 */
    this.instNs = new Map();
    /* 基类那一层的名字表（第一百三十七刀）：类 / 结构体的全名 -> { ns, 源码里写的基类名字 }。
       在 aggHoist 那一遍记（typeDecl 太晚，见那处注），解成全名留到 baseResolve。 */
    this.aggBases = new Map();
    /** baseResolve 自己要用 resolve 解基类名字 —— 一道闸门，别让它绕回来。 */
    this.inBase = false;
    /* 实参带 `*` 时给那一格指针类型合成的 typedef 名（第一百二十刀）。替换只在 type-spec
       那一层 —— 所以带 `*` 的实参先**起个名字**，再拿这个名字当一格普通类型名替进去。 */
    this.tmplPtrs = new Set();
    /* 函数重载（第七十九刀）。基名（第一条那个方言名）-> 那一族所有方言名，第 0 格就是基名。
     * 第二条起的方言名是 `<基名>$o<元数>` —— jancy 那边判合法只看**实参那一串的签名**
     * （`FunctionType::getArgSignature`，jnc_ct_FunctionType.h:289-326：返回类型与
     * `errorcode` 都不算），调用点按各实参 CastKind 里最差的那个排序挑
     * （`FunctionTypeOverload::chooseOverload`，jnc_ct_FunctionTypeOverload.cpp:44-91）。
     * 这一层先只做**按实参个数**分得开的那一半（语料 159 组里 92 组），同元的说还不收。 */
    this.overloads = new Map();
    // 虚派发（第五十七刀）。`virt` 是方言里那个方法名 -> 'virtual' | 'override' | 'abstract'，
    // `tags` 是类名 -> 那个类的整数标签（根那一格结构体里的 `$tag` 存的就是它，对象一造出来
    // 就写死）。`disp` 记着按标签分派的那段函数，一个（根, 方法名）一段。
    this.virt = new Map();
    this.tags = new Map();
    this.disp = new Map();
    // errorcode（第五十八刀）。`errFns` 是方言里那个函数名 -> 它的出错值文本，`curErr` 是
    // 正在降的这个函数自己的出错值（不是 errorcode 的函数为 null），`shield` 是 `try` 的层数
    // —— 在 `try` 底下调 errorcode 的函数不传播（exceptions.rst:40）。
    this.errFns = new Map();
    this.curErr = null;
    this.shield = 0;
    // 传播那两句插在哪儿：`ecOut` 是"这条语句之前"那一叠（null = 这个位置插不进语句，于是
    // 见到 errorcode 的调用就明说不收），`ecPad` 是那一叠的缩进，`ecSeq` 给临时格子编号。
    this.ecOut = null;
    this.ecPad = '';
    this.ecSeq = 0;
    // 出错往哪儿跳（第五十九刀）。空着就是"回到调用方"（`ret` 我自己的出错值）；非空时栈顶那一
    // 格说的是"跳到这一格作用域的出口" —— `try { … }` 与 `catch:` 都落成一圈**一次性循环**加
    // 一句 `brk`，而 `catch:` 那一格还带一格标志（跳出来是因为出错，还是正常走到底）。
    this.guards = [];
  }

  /**
   * 类没写 construct 时合成一个。两种理由，合起来只有一格函数：
   *   - 派生类（第五十六刀）：它做的事是把基类那一个调一遍。
   *   - 有字段默认值（第七十八刀）：那几条赋值要有地方待着。
   *
   * 这一遍只**登记**（`ctors` / `fns` / `methods`）——`C1 a;` 与 `new C1` 从那张表接。
   * 只有基类那一句的，体当场就发得出来；带字段初值的推迟到 emitFieldInitCtors
   * （初值里可以引用模块级变量，那些在这一遍还没登记）。
   */
  synthCtors() {
    const depth = (c) => {
      let d = 0;
      for (const b of this.dirBases(c)) d = Math.max(d, depth(b) + 1);
      return d;
    };
    const order = this.pendingCls.slice().sort((a, b) => depth(a.name) - depth(b.name));
    for (const { name, node } of order) {
      /* 基类的构造要**逐格都调**（第九十四刀）：jancy 那句就是复数的
         `callBaseTypeConstructors`（jnc_ct_Parser.cpp:3005）。单继承时这一串只有一格，
         与第五十六刀那时一个字不差。 */
      const bcs = this.dirBases(name)
        .map((b) => ({ cls: b, c: this.ctors.get(b) }))
        .filter((x) => x.c !== undefined);
      const hasFI = this.fieldInits.has(name) || this.evtFields.has(name)
        || this.embFields.has(name);
      if (this.ctors.has(name)) {
        // 自己写了 construct：字段初值由 fnDef 插到它开头；基类那一个由
        // `basetype.construct(…)` 显式调，没写就在 fnDef 那处自动补一句（与 jancy 的
        // callBaseTypeConstructors 同）。只有 static construct 的那一种上面已经合成过一个
        // 空的了，那一个不会调基类 —— 明说不收。
        if (bcs.length > 0 && this.synthSC.has(name)) {
          this.nope(node, `${shown(name)} 只有 static construct 而基类 ${shown(bcs[0].cls)} 有 construct`
            + '（合成出来的那一个还要把基类的构造调一遍）');
        }
        continue;
      }
      if (bcs.length === 0 && !hasFI) continue;   // 没有基类构造、也没有初值：不用有构造
      const need = bcs.find((x) => x.c.params.length > 0);
      if (need !== undefined) {
        this.err(node, `${shown(name)} 没有 construct，而基类 ${shown(need.cls)} 的 construct 要 `
          + `${need.c.params.length} 个实参 —— 得自己写一个 construct 并在里面调 basetype.construct(…)`);
        continue;
      }
      const full = `${name}$construct`;
      const self = tClass(name, false);
      this.fns.set(full, { params: [self], ret: J_VOID });
      this.methods.set(full, name);
      this.ctors.set(name, { name: full, params: [], synth: true });
      if (hasFI) { this.synthFI.add(name); continue; }
      const calls = bcs.map((x) => `    (expr (call ${x.c.name} (var $this)))`).join('\n');
      this.decls.push(`  (fn ${full} (($this ${slotText(self)})) void\n${calls})`);
    }
  }

  /**
   * 结构体里那几格**字段自己的构造**那几行（第一百二十九刀）。
   *
   * 只管结构体：类那一侧的字段还不收类类型（那一条界另有一句话），而结构体的字段是**内嵌**的，
   * 所以"外面那一格构造了、里面那一格没构造"就是静默的错答案。
   *
   * 要实参的那一种补不出来 —— 与基类那一条（第九十四刀）同一条口径：明说，不猜。
   */
  memCtorLines(name, pad) {
    if (this.classes.has(name)) return [];
    const out = [];
    for (const f of this.structs.get(name) ?? []) {
      if (!jncIsStruct(f.type)) continue;
      const c = this.ctors.get(f.type.name);
      if (c === undefined) continue;
      if (c.params.length > 0) {
        this.err(null, `${shown(name)} 里的字段 '${f.name}' 的类型 ${shown(f.type.name)} 的 `
          + `construct 要 ${c.params.length} 个实参 —— 内嵌的那一格补不出来`);
        continue;
      }
      out.push(`${pad}(expr (call ${c.name} (pfield (var $this) ${f.name})))`);
    }
    return out;
  }

  /**
   * 结构体的**合成构造**（第一百二十九刀）：自己没写 `construct`、可字段里有带构造的结构体时，
   * 给它合成一个 —— 不然那几格字段永远不会被构造（静默的错答案）。
   *
   * 与类那一侧的 `synthCtors` 是一对；这儿要按"字段依赖"跑到不动点：`A` 里有 `B`、`B` 里有 `C`，
   * 那么 C 的先有、B 的才补得出来。一遍最多补一格，所以最多跑字段深度那么多遍。
   */
  synthStructCtors() {
    for (let pass = 0; pass < 16; pass++) {
      let added = false;
      for (const [name, fs] of this.structs) {
        if (this.classes.has(name) || this.ctors.has(name)) continue;
        const mem = fs.filter((f) => jncIsStruct(f.type) && this.ctors.has(f.type.name));
        if (mem.length === 0) continue;
        const full = `${name}$construct`;
        if (this.fns.has(full)) continue;
        const self = { k: 'struct', name };
        this.fns.set(full, { params: [self], ret: J_VOID });
        this.methods.set(full, name);
        this.ctors.set(name, { name: full, params: [], synth: true });
        const calls = this.memCtorLines(name, '    ').join('\n');
        this.decls.push(`  (fn ${full} (($this ${slotText(self)})) void\n${calls})`);
        added = true;
      }
      if (!added) break;
    }
  }

  /**
   * `operator :=` 的签名（第一百三十刀）。落法与方法一模一样 —— 一个自由函数、`this` 当第一个
   * 形参，名字拼成 `Owner$op$assign`；调用点（赋值那一处）按**左边那一格的类型**去 `opAssign`
   * 里找它。
   *
   * 只收**一个**形参、一格 owner 上只收**一个** `operator :=`：jancy 那边多个是按实参类型挑
   * （重载决议），那与第八十刀的同元重载是同一笔账 —— 明说不收第二个，不猜。
   */
  /**
   * 复合赋值算符的签名（第一百五十二刀）：`operator += (string_t s)` 那一族。
   *
   * 落法与 `operator :=`（第一百三十刀）一模一样 —— 一个自由函数、`this` 当第一个形参，名字拼成
   * `Owner$op$addAssign`。判据也照抄那一处的三条，理由同：只收一个形参、一格主人身上一个算符
   * 只收一条（多条要按实参类型挑，那与第八十刀是同一笔账），只能是类或结构体的成员。
   *
   * 与 `operator +` 分得开这一点是**语义**上的：jancy 那边复合赋值是各自独立的算符，不是"先 `+`
   * 再赋一次"。语料里 `std.String.operator += (string_t)` 干的是 `append(string)`，
   * 而那个类连 `operator +` 都没有 —— 拿"+ 再赋"去凑就是另一件事。
   */
  /**
   * 一族同名算符里按**右边那一格的类型**挑一条（第二百四十二刀）。规矩与属性存值器的重载
   * （第一百八十一刀）逐条一样、话也照那三句：问不出右边的类型的明说不收（第八十刀那条
   * "绝不猜"），一条都合不上的报错，同分的明说分不出来。
   *
   * @returns `{ name, param, ret }`，或 null（已经报过错）
   */
  opPick(n, label, rec, valNode) {
    if (rec.sets === undefined || rec.sets.length <= 1) return rec;
    const ct = this.cheapTy(valNode);
    if (ct === null) {
      return this.nope(n, `'${label}' 有 ${rec.sets.length} 条，而右边的类型这一层还得先降一遍`
        + '才知道（要按实参类型挑，见 ADR-0016 第八十刀）');
    }
    let best = -1;
    let bestScore = 0;
    let tie = false;
    for (let i = 0; i < rec.sets.length; i++) {
      const sc = this.argCost(ct.ty, rec.sets[i], ct.lit);
      if (sc === 0) continue;
      if (sc === bestScore) tie = true;
      if (sc > bestScore) { bestScore = sc; best = i; tie = false; }
    }
    if (best === -1) {
      return this.err(n, `'${label}' 那 ${rec.sets.length} 条`
        + `（${rec.sets.map(tyName).join(' / ')}）没有一条收得下 ${tyName(ct.ty)}`);
    }
    if (tie) {
      return this.nope(n, `'${label}' 的那几条在这一句上分不出来`
        + `（${tyName(ct.ty)} 对两条一样合得上）`);
    }
    return { name: rec.names[best], param: rec.sets[best], ret: rec.rets[best] };
  }

  opCompoundSig(n, info, ps, op) {
    const owner = info.name === ''
      ? (this.structs.has(this.ns) ? this.ns : null)
      : this.resolve(info.name, (k) => this.structs.has(k));
    if (owner === null) {
      return this.err(n, `'operator ${op}' 只能是类或结构体的成员（写在体里）`);
    }
    if (ps.length !== 1) {
      return this.nope(n, `'operator ${op}' 收 ${ps.length} 个形参（这一层只收一个）`);
    }
    const full = `${owner}$op$${OP_NAME.get(`operator ${op}`)}`;
    /* 一格主人身上**好几条**同一个算符（第二百四十二刀）：量出来语料里就是它 ——
       `std.StringBuilder` 上三条 `operator +=`（收 `string` / `char const*` / 一格字符），
       逐份榜上 31 对。先前这儿一见 `fns.has(full)` 就说"第二个…要按实参类型挑" ——
       可"按实参类型挑"这一层早就有（第八十刀那套 `argCost`，属性的存值器第一百八十一刀就是
       照它做的）。欠的只是**名字**与**那张表**：改名照第七十九刀那条（第二条起加 `$o2`），
       表里从"一条"改成"一族"。签名一样的那种才是重定义，当场报。 */
    const key = `${owner}$${op}`;
    const prev = this.opCompound.get(key);
    let mine = full;
    if (prev !== undefined) {
      if (prev.sets.some((t) => sameTy(t, ps[0].type))) {
        return this.err(n, `${shown(owner)} 上两个 'operator ${op}' 收的实参类型一样`
          + `（${tyName(ps[0].type)}）`);
      }
      mine = `${full}$o${prev.sets.length + 1}`;
    }
    info.name = mine;
    const self = this.classes.has(owner) ? tClass(owner, false) : { k: 'struct', name: owner };
    ps.unshift({ name: 'this', type: self, formals: null, def: null });
    this.methods.set(mine, owner);
    if (prev === undefined) {
      this.opCompound.set(key, {
        name: mine, param: ps[1].type, ret: info.type,
        sets: [ps[1].type], names: [mine], rets: [info.type],
      });
    } else {
      prev.sets.push(ps[1].type);
      prev.names.push(mine);
      prev.rets.push(info.type);
    }
    this.fns.set(mine, sigOf(ps, info.type));
    return { info, ps, isMain: false };
  }

  opAssignSig(n, info, ps) {
    const owner = info.name === ''
      ? (this.structs.has(this.ns) ? this.ns : null)
      : this.resolve(info.name, (k) => this.structs.has(k));
    if (owner === null) {
      return this.err(n, "'operator :=' 只能是类或结构体的成员（写在体里）");
    }
    if (ps.length !== 1) {
      return this.nope(n, `'operator :=' 收 ${ps.length} 个形参（这一层只收一个）`);
    }
    const full = `${owner}$op$assign`;
    // 好几条 `operator :=`（第二百四十二刀）：与上面那一格逐条一样
    const prevA = this.opAssign.get(owner);
    let mineA = full;
    if (prevA !== undefined) {
      if (prevA.sets.some((t) => sameTy(t, ps[0].type))) {
        return this.err(n, `${shown(owner)} 上两个 'operator :=' 收的实参类型一样`
          + `（${tyName(ps[0].type)}）`);
      }
      mineA = `${full}$o${prevA.sets.length + 1}`;
    }
    info.name = mineA;
    const self = this.classes.has(owner) ? tClass(owner, false) : { k: 'struct', name: owner };
    ps.unshift({ name: 'this', type: self, formals: null, def: null });
    this.methods.set(mineA, owner);
    if (prevA === undefined) {
      this.opAssign.set(owner, {
        name: mineA, param: ps[1].type, ret: info.type,
        sets: [ps[1].type], names: [mineA], rets: [info.type],
      });
    } else {
      prevA.sets.push(ps[1].type);
      prevA.names.push(mineA);
      prevA.rets.push(info.type);
    }
    this.fns.set(mineA, sigOf(ps, info.type));
    return { info, ps, isMain: false };
  }

  /**
   * 零元的成员算符的签名：`operator ++` / `operator --`（含 postfix，第一百三十一刀），
   * 以及取值那两个 `operator *` / `operator ->`（第一百三十四刀）。
   *
   * 语料里前一族的原样在 stdt_Iterator.jnc:36-54 —— 四个都写着，前缀回**新**值、后缀回
   * **旧**值；后一族在同一份的 :28-34，两个都回那格指针。落法与 `operator :=` 同一条
   * （自由函数、`this` 当第一个形参），名字拼成 `Owner$op$inc` / `$op$dec` /
   * `$op$inc$post` / `$op$dec$post` / `$op$mul` / `$op$arrow`。
   *
   * 一个字都不收形参：jancy 那边这几个本来就是零元（C++ 里 postfix 那个假的 `int` 形参在
   * jancy 是靠 `postfix` 这个词分的，不是靠形参，jnc.grammar:431）。
   *
   * 两族的差别只在**调用点**：`++` 那一族落在语句上，`*` / `->` 落在求值那条路上，所以
   * 后者还要把"回的是什么类型"记住（`opUnary`）—— `*it` 整格的类型就是它。
   */
  opIncSig(n, info, ps) {
    const suffix = OP_NAME.get(info.special);
    const owner = info.name === ''
      ? (this.structs.has(this.ns) ? this.ns : null)
      : this.resolve(info.name, (k) => this.structs.has(k));
    if (owner === null) {
      return this.err(n, `'${info.special}' 只能是类或结构体的成员（写在体里）`);
    }
    if (ps.length !== 0) {
      return this.err(n, `'${info.special}' 不收形参（这一族在 jancy 里是零元，`
        + 'postfix 那一个也靠 `postfix` 这个词分，不靠形参）');
    }
    const full = `${owner}$op$${suffix}`;
    if (this.fns.has(full)) {
      return this.err(n, `${shown(owner)} 的第二个 '${info.special}'`);
    }
    /* 取值那两个要回**一格指针**：`*it` / `it->m_x` 接下来那一步走的是这一层原有的
       "指针取字段"那条路，回别的东西那条路就接不上（jancy 那边 `operator *` 回什么都行，
       接下来那一步按回的类型再算一遍 —— 那要一整套"重载之后再解析"的路，明说不收）。 */
    if ((suffix === 'mul' || suffix === 'arrow') && !jncIsPtr(info.type)) {
      return this.nope(n, `'${info.special}' 回 ${tyName(info.type)}（这一层要它回一格指针：`
        + '接下来那一步走的是"指针取字段"那条路）');
    }
    /* 转换算符（第一百三十九刀）要回 bool：这一层只收 `operator bool`，而它落的地方是
       "当条件用"那一处（truthy）—— 回别的类型那儿接不上。 */
    if (suffix === 'bool' && info.type !== J_BOOL) {
      return this.err(n, `'operator bool' 回 ${tyName(info.type)}，不是 bool`);
    }
    info.name = full;
    const self = this.classes.has(owner) ? tClass(owner, false) : { k: 'struct', name: owner };
    ps.unshift({ name: 'this', type: self, formals: null, def: null });
    this.methods.set(full, owner);
    if (suffix === 'mul' || suffix === 'arrow' || suffix === 'bool') {
      this.opUnary.set(full, { name: full, ret: info.type });
    } else this.opIncDec.add(full);
    this.fns.set(full, sigOf(ps, info.type));
    return { info, ps, isMain: false };
  }

  /**
   * 取值那两个算符的调用点（第一百三十四刀）：`v` 是左边那一格算出来的值，回的是"算符调完之后
   * 那一格值"（一格指针），认不出来就回 undefined 让原来那条路照旧报。
   *
   * `which` 是 `'arrow'` 或 `'mul'`。**先找问的那一个、没写就用另一个**：这一层从第十九刀起
   * 就把 `(*p).f` 与 `p->f` 收在同一条路上（普通指针上两者同义，fieldLv 收到的节点一模一样），
   * 所以重载也只有一个选择点。jancy 那边 `(*x).f` 严格走 `operator *`—— 这一格记成账
   * （ADR-0016 第一百三十四刀）：语料里那两个算符回的是同一格 `m_p`，所以看不出差别。
   */
  opUnaryCall(v, which) {
    if (v === null || !(isClass(v.type) || jncIsStruct(v.type))) return undefined;
    const a = this.opUnary.get(`${v.type.name}$op$${which}`);
    const b = this.opUnary.get(`${v.type.name}$op$${which === 'arrow' ? 'mul' : 'arrow'}`);
    const op = a ?? b;
    if (op === undefined) return undefined;
    return { code: `(call ${op.name} ${v.code})`, type: op.ret };
  }

  /**
   * **下标算符**的签名（第一百三十八刀）：类 / 结构体体里**裸写**的 `get` / `set`。
   *
   * jancy 里 `c[10]` 走 `get`、`c[10] = 100` 走 `set`（test90.jnc:12-24）。语料里这一族的形状
   * 只有一种（std_Array.jnc:26/31、std_Buffer、std_HashTable、std_RbTree 各一对）：
   *
   *     variant_t get(size_t index) const { … }
   *     bool errorcode set(size_t index, variant_t v) { … }
   *
   * 落法与前四族算符同一条（自由函数、`this` 当第一个形参），名字拼成
   * `Owner$op$index$get` / `Owner$op$index$set`。
   *
   * 三条界：下标只收**一个**（语料里全是一个）；一格 owner 上只收一个 `get` 与一个 `set`
   * （重载要按实参类型挑，与第八十刀同一笔账）；`set` 上写着的 `errorcode` 照第五十八刀那条
   * 老路登记 —— 漏了它那个词就被悄悄丢掉，调用点于是不再检查错误码。
   */
  opIndexSig(n, info, ps) {
    const owner = this.structs.has(this.ns) ? this.ns : null;
    if (owner === null) {
      return this.err(n, `裸写的 '${info.special}' 是下标算符（'c[i]' 走它）—— `
        + '只能是类或结构体的成员');
    }
    const isGet = info.special === 'get';
    const want = isGet ? 1 : 2;
    if (ps.length !== want) {
      return this.nope(n, `下标算符 '${info.special}' 收 ${ps.length} 个形参（这一层只收 `
        + `${want} 个：${isGet ? '一个下标' : '一个下标加一个值'}）`);
    }
    const full = `${owner}$op$index$${info.special}`;
    if (this.fns.has(full)) {
      return this.nope(n, `${shown(owner)} 的第二个下标 '${info.special}'（要按实参类型挑，见第八十刀）`);
    }
    info.name = full;
    const self = this.classes.has(owner) ? tClass(owner, false) : { k: 'struct', name: owner };
    ps.unshift({ name: 'this', type: self, formals: null, def: null });
    this.methods.set(full, owner);
    const e = this.opIndex.get(owner) ?? {};
    e[info.special] = {
      name: full, sub: ps[1].type, val: isGet ? info.type : ps[2].type, ret: info.type,
    };
    this.opIndex.set(owner, e);
    this.fns.set(full, sigOf(ps, info.type));
    // errorcode（第五十八刀）：`bool errorcode set(…)` 是语料里的原样，那个词不能吞
    if (info.sp.errc && this.errcReg(n, full, info.type) === null) return null;
    return { info, ps, isMain: false };
  }

  /** 下标算符那一格的账本（第一百三十八刀）：左边那格的类型上有没有它。 */
  opIndexOf(t) {    if (t === null || t === undefined || !(isClass(t) || jncIsStruct(t))) return undefined;
    /* 基类上写的那一格也算（第二百〇九刀）：语料里的原样是 `std.StringHashTable` ——
       它的下标算符（那对 `get` / `set`，std_HashTable.jnc:96-105）写在基类 `std.HashTable` 上。
       先前只问了自己那一格，于是 `t[key]` 落到"下标要一个指针"那句上 —— 指着别处。
       与方法查名同一条路（baseWalk，一条继承链从里往外走）。 */
    for (const cur of this.baseWalk(t.name)) {
      const e = this.opIndex.get(cur);
      if (e !== undefined) return e;
    }
    return undefined;
  }

  /**
   * 调一次下标算符（第一百三十八刀）。读写两侧共用这一处 —— 差别只有"末尾多不多一个值"。
   *
   * `base` 是已经算好的左边那一格，`vNode` 非 null 就是写那一侧（`c[i] = v` 里的 v）。
   * 下标按**算符那一格形参**的类型求值（`want` 给对了字面量才落得对，与第一百三十刀同一条）。
   * `errorcode` 走 `propagate` —— 语料里 `set` 全是 `bool errorcode`，这一句漏了那个词就被
   * 悄悄吞掉、调用点从此不再检查错误码。
   */
  opIndexCall(n, op, base, vNode) {
    const i = this.expr(n.items[2], op.sub);
    if (i === null) return null;
    const parts = [base.code, i.code];
    if (vNode !== null) {
      let v = this.expr(vNode, op.val);
      if (v === null) return null;
      if (isInt(v.type) && isInt(op.val)) v = intConv(v, op.val);
      if (!this.assignOk(v.type, op.val)) {
        return this.err(n, `下标赋值两边不同型：这一格收 ${tyName(op.val)}，`
          + `右边是 ${tyName(v.type)}`);
      }
      parts.push(v.code);
    }
    const code = `(call ${op.name}${parts.map((p) => ` ${p}`).join('')})`;
    if (this.errFns.has(op.name)) return this.propagate(n, code, op.ret, shown(op.name));
    return { code, type: op.ret };
  }

  /**
   * **相等算符**的签名（第一百四十刀）：`operator ==` / `operator !=`。
   *
   * 语料里的原样在 std_Guid.jnc:80/84 —— `bool operator == (Guid const* op) thin const`：
   * 一个形参、回 bool，而那个形参是**指向同一格结构体的指针**（不是那格值本身）。
   *
   * 落法与前几族同一条（自由函数、`this` 当第一个形参），名字拼成 `Owner$op$eq` / `$op$ne`。
   * 回的必须是 bool —— 这一族落的地方是二元比较那一处，回别的东西那儿接不上。
   *
   * `==` 与 `!=` **各自登记、互不代替**：只写了 `==` 而源码写 `!=` 时不替它取反
   * （jancy 那边也是各挑各的重载；语料里 std_Guid 两个都写了）。
   */
  /**
   * **调用算符**的签名（第二百〇二刀）：`operator ()` —— `obj(…)` 走它。
   *
   * 语料里的原样是 `stdt` 那几个函子：`struct Eq<T> { static bool operator () (T a, T b) { … } }`
   * （stdt_Operator.jnc:19-25）、`struct HashString { static size_t operator () (string_t key) }`
   * （同上:97）。调用点是 `m_hash(key)`（stdt_HashTable.jnc:101）—— 左边是一格**值**，它的类型
   * 上有这个算符。
   *
   * 落法与前几族同一条：一个自由函数、名字拼成 `Owner$op$call`。`static` 的那一格没有 `this`
   * （第二百〇一刀）。形参个数与类型都由写的人定 —— 这一格与下标算符不同，jancy 没有限制。
   *
   * 一个类型只收**一格** `operator ()`：第二个要按实参类型挑，那是第八十刀那套机器，还没接。
   */
  opCallSig(n, info, ps) {
    const owner = info.name === ''
      ? (this.classes.has(this.ns) || this.structs.has(this.ns) ? this.ns : null)
      : this.resolve(info.name, (k) => this.classes.has(k) || this.structs.has(k));
    if (owner === null) {
      return this.err(n, "'operator ()' 只能是类或结构体的成员（`obj(…)` 走它）");
    }
    const full = `${owner}$op$call`;
    if (this.fns.has(full)) {
      return this.nope(n, `${shown(owner)} 的第二个 'operator ()'（要按实参类型挑，见第八十刀）`);
    }
    info.name = full;
    const stat = info.sp.stat === true;
    if (!stat) {
      ps.unshift({ name: 'this', type: this.selfTy(owner), formals: null, def: null });
      this.methods.set(full, owner);
    }
    const defs = ps.map((p) => p.def ?? null);
    this.opCalls.set(owner, {
      name: full,
      stat,
      ret: info.type,
      params: ps.map((p) => p.type),
      defs: defs.some((d) => d !== null) ? defs : null,
    });
    this.fns.set(full, sigOf(ps, info.type));
    // errorcode（第五十八刀）：这一族也可能带它，那个词不能吞
    if (info.sp.errc && this.errcReg(n, full, info.type) === null) return null;
    return { info, ps, isMain: false };
  }

  /** 左边那一格的类型上有没有调用算符（第二百〇二刀）。**一个字都不发** —— 与 cheapTy 同一条
   *  规矩：问得准才回，问不出就回 undefined，调用方接着走它自己那条路。 */
  opCallOf(callee) {
    if (this.opCalls.size === 0) return undefined;
    const t = this.cheapTy(callee);
    if (t === null || t.lit) return undefined;
    const ty = jncIsPtr(t.ty) ? t.ty.target : t.ty;
    if (!isClass(ty) && !jncIsStruct(ty)) return undefined;
    return this.opCalls.get(ty.name);
  }

  /** 调一次调用算符（第二百〇二刀）：`obj(…)` -> `(call Owner$op$call obj 实参…)`。
   *  静态的那一格不传对象（也**不求值**左边 —— 那儿只是个类型上的名字，jancy 也一样）。 */
  opCallSite(n, oc, callee) {
    const args0 = this.flat(n.items[2]);
    const want = oc.stat ? oc.params : oc.params.slice(1);
    const defs = oc.defs === null ? null : (oc.stat ? oc.defs : oc.defs.slice(1));
    const args = defs === null ? args0 : this.withDefaults(args0, want, defs, null);
    if (args === null) return null;
    if (args.length !== want.length) {
      return this.err(n, `'operator ()' 要 ${want.length} 个实参，这里给了 ${args0.length} 个`);
    }
    const parts = [];
    if (!oc.stat) {
      const bv = this.baseVal(callee);
      if (bv === null) return null;
      parts.push(bv.code);
    }
    for (let i = 0; i < args.length; i++) {
      let v = this.expr(args[i], want[i]);
      if (v === null) return null;
      if (isInt(v.type) && isInt(want[i])) v = intConv(v, want[i]);
      if (!this.assignOk(v.type, want[i])) {
        return this.err(args[i], `'operator ()' 的第 ${i + 1} 个实参要 ${tyName(want[i])}，`
          + `这里是 ${tyName(v.type)}`);
      }
      parts.push(v.code);
    }
    const code = `(call ${oc.name}${parts.map((p) => ` ${p}`).join('')})`;
    if (this.errFns.has(oc.name)) return this.propagate(n, code, oc.ret, shown(oc.name));
    return { code, type: oc.ret };
  }

  opCmpSig(n, info, ps) {
    const suffix = OP_NAME.get(info.special);
    const owner = info.name === ''
      ? (this.structs.has(this.ns) ? this.ns : null)
      : this.resolve(info.name, (k) => this.structs.has(k));
    if (owner === null) {
      return this.err(n, `'${info.special}' 只能是类或结构体的成员（写在体里）`);
    }
    if (ps.length !== 1) {
      return this.nope(n, `'${info.special}' 收 ${ps.length} 个形参（这一层只收一个）`);
    }
    if (info.type !== J_BOOL) {
      return this.err(n, `'${info.special}' 回 ${tyName(info.type)}，不是 bool`);
    }
    const full = `${owner}$op$${suffix}`;
    if (this.fns.has(full)) {
      return this.nope(n, `${shown(owner)} 的第二个 '${info.special}'（要按实参类型挑，见第八十刀）`);
    }
    info.name = full;
    const self = this.classes.has(owner) ? tClass(owner, false) : { k: 'struct', name: owner };
    ps.unshift({ name: 'this', type: self, formals: null, def: null });
    this.methods.set(full, owner);
    this.opCmp.set(full, { name: full, param: ps[1].type });
    this.fns.set(full, sigOf(ps, info.type));
    return { info, ps, isMain: false };
  }

  /**
   * 二元比较那一处问一句"有没有重载"（第一百四十刀）。认不出来回 undefined，让原来那条路照旧。
   *
   * 右边那一格的类型对得上形参就成。语料里的形参是 `Guid const*` 而写出来的是
   * `a == b`（两边都是 Guid 值）—— 这一层结构体那一格里放的**就是地址**（第十二刀），
   * 所以那格值的 code 拿去当指针传是对的；要放开的只是类型那一问：形参是指针、
   * 而它指的正是右边那格结构体时也算对得上。
   */
  opCmpCall(n, op, a, b) {
    const t = op.param;
    const ok = this.assignOk(b.type, t)
      || (jncIsPtr(t) && jncIsStruct(b.type) && sameTy(t.target, b.type));
    if (!ok) {
      return this.err(n, `'${op.name.endsWith('$eq') ? '==' : '!='}' 右边是 ${tyName(b.type)}，`
        + `而那个算符收 ${tyName(t)}`);
    }
    return { code: `(call ${op.name} ${a.code} ${b.code})`, type: J_BOOL };
  }

  /**
   * 类里那几格事件的**建单子**那几行（第八十三刀）。
   *
   * 一格事件在方言里就是一格数组的句柄（多播的处理函数单子，第七十三刀）。对象刚造出来时
   * 那一格是零（`pnew` 出来的内存是零），读它会报 `null reference` —— 所以构造里第一件事
   * 就是把单子建起来。排在源码写的字段初值**之前**：初值里可以写 `m_e += h`。
   */
  evtInitLines(cls, pad) {
    const list = this.evtFields.get(cls);
    if (list === undefined) return [];
    return list.map((e) => `${pad}(pstore (pfield (var $this) ${e.name}) `
      + `(anew ${tyText(e.type)} (int 0)))`);
  }

  /**
   * 内嵌的类字段那几格**造出来**的语句（第一百六十一刀）：一格字段三句 ——
   * `pnew` 出那一块、写 `$tag`（虚派发那一格标签，第五十七刀）、调它的 `construct`。
   *
   * 排在事件那几行（evtInitLines）之后、源码写的字段初值之前：初值里可以写 `m_menu.addItem(…)`，
   * 那时那格对象得已经在。顺序与 jancy 一致 —— 它也是"字段逐格 initialize"排在构造体之前
   * （jnc_ct_Parser.cpp:3002-3009 那条链）。
   */
  embInitLines(cls, pad) {
    const list = this.embFields.get(cls);
    if (list === undefined) return [];
    const out = [];
    for (const f of list) {
      const ad = `(pfield (var $this) ${f.name})`;
      out.push(`${pad}(pstore ${ad} (pnew (ptr ${clsRoot(f.cls)}) (int 1)))`);
      const tg = this.tagStore(f.node, f.cls, `(pload ${ad})`, pad);
      if (tg === null) continue;                    // 报过错了
      out.push(tg);
      if (this.ctorCall(f.node, f.cls, `(pload ${ad})`, null, pad, out) === null) continue;
    }
    return out;
  }

  /**
   * 一个类那几格字段默认值，降成 `construct` 开头的几条语句（第七十八刀）。
   *
   * 落法是**合成语句、走原来那条路**：`int m_x = 5;` 变成 `m_x = 5;` 这条赋值语句的 AST，
   * 再交给 stmt 降 —— 于是"裸字段名补 this"（selfField）、类型检查、结构体的按格拷贝、
   * 花括号初值（`Point m_p = { 1, 2 };`）、属性字段的赋值全是原来那一套，一处逻辑都没有
   * 第二份。字段名在类这一层查得着，所以拼的就是源码里写的那个名字。
   *
   * 调用方负责摆好上下文（this.ns / selfClass / alias 的 this / scopes）：用户自己写了
   * construct 的那种由 fnDef 摆（那儿本来就摆好了），合成的那种由 emitFieldInitCtors 摆。
   */
  fieldInitLines(cls, ind) {
    const list = this.fieldInits.get(cls);
    if (list === undefined) return [];
    const out = [];
    for (const f of list) {
      const sp = f.node.span;
      const at = (v) => ({ kind: 'atom', value: v, span: sp });
      const lhs = { kind: 'list', span: sp, items: [at('name'), at(f.name)] };
      const asg = {
        kind: 'list',
        span: sp,
        items: [at('assign'), { kind: 'string', value: '=', span: sp }, lhs, f.expr],
      };
      const lines = this.stmt({ kind: 'list', span: sp, items: [at('expr-stmt'), asg] }, ind);
      if (lines === null) continue;                 // 已经报过错了
      for (const l of lines) out.push(l);
    }
    return out;
  }

  /**
   * 合成出来的那些 construct 的**体**（第七十八刀）：类里有字段默认值、却没写 construct。
   *
   * 排在函数体那一遍之后 —— 初值里可以引用模块级变量和别的函数，那些前面几遍才登记完。
   * 顺序照 jancy（jnc_ct_Parser.cpp:3005-3009）：基类构造 → 静态构造 → 字段初值。
   */
  emitFieldInitCtors() {
    for (const cls of this.synthFI) {
      const pre = [];
      // 基类的构造逐格都调（第九十四刀）—— 单继承时这一串只有一格。
      for (const b of this.dirBases(cls)) {
        const bc = this.ctors.get(b);
        if (bc !== undefined) pre.push(`    (expr (call ${bc.name} (var $this)))`);
      }
      if (this.sctors.has(cls)) for (const l of this.gateLines(cls, '    ')) pre.push(l);
      for (const l of this.evtInitLines(cls, '    ')) pre.push(l);
      for (const l of this.embInitLines(cls, '    ')) pre.push(l);
      const saveNs = this.ns;
      const saveSelf = this.selfClass;
      const savePr = this.selfProp;
      const saveAlias = this.alias;
      const saveLifted = this.lifted;
      const saveErr = this.curErr;
      const saveRet = this.retTy;
      this.scopes = [new Map()];
      this.ns = cls;
      this.selfClass = cls;
      this.selfProp = null;
      this.alias = new Map([['this', '$this']]);
      this.lifted = new Set();
      this.curErr = null;
      this.retTy = J_VOID;
      this.shield = 0;
      this.guards = [];
      const lines = this.fieldInitLines(cls, 4);
      this.ns = saveNs;
      this.selfClass = saveSelf;
      this.selfProp = savePr;
      this.alias = saveAlias;
      this.lifted = saveLifted;
      this.curErr = saveErr;
      this.retTy = saveRet;
      this.scopes = [];
      const self = tClass(cls, false);
      this.decls.push(`  (fn ${cls}$construct (($this ${slotText(self)})) void\n`
        + `${[...pre, ...lines].join('\n')})`);
    }
  }

  /**
   * 那几格 reactor 的体（第八十五刀）。排在函数体那一遍之后 —— 反应里能引用模块级变量、
   * 属性与别的函数，那些到这一步才全登记完（与 emitFieldInitCtors 同一条理由）。
   *
   * 一格 reactor 落成三样东西：
   *   - 一格 bool（跑没跑）：类的成员是类里的一格字段，顶层是一格模块级变量；
   *   - **一条顶层语句一格反应函数**（与 jancy 的 reactionIdx 同一条：每条 reactive_expression
   *     进一次 `enterReactiveExpression`，jnc_ct_Expr.llk:179-185 / jnc_ct_Module.h:885-896），
   *     体外面套一道 `if (跑没跑)` 的闸门；
   *   - `start` / `stop`：start 先把订阅挂上（静态超集，见 rctReads）、再把所有反应跑一遍；
   *     stop 只把 bool 关掉 —— 这一层的多播还摘不掉（`+=` 不回 cookie，第七十三刀那条边界），
   *     所以订阅还挂着，只是不干活了。**记账**：jancy 的 stop 是真摘掉。
   */
  emitReactors() {
    for (const r of this.reactors.values()) {
      if (r.body === null) {
        this.err(r.node, `reactor '${shown(r.full)}' 声明了却没有体`
          + '（体写在类外：`reactor 类名.名字 { … }`）');
        continue;
      }
      const self = r.cls === null ? null : tClass(r.cls, false);
      const selfDecl = self === null ? '' : `($this ${slotText(self)})`;
      const selfArg = self === null ? '' : ' (var $this)';
      const onRd = self === null ? `(var ${r.on})` : `(pload (pfield (var $this) ${r.on}))`;
      if (self === null) this.decls.push(`  (global ${r.on} bool)`);
      const saveNs = this.ns;
      const saveSelf = this.selfClass;
      const savePr = this.selfProp;
      const saveAlias = this.alias;
      const saveLifted = this.lifted;
      const saveErr = this.curErr;
      const saveRet = this.retTy;
      this.scopes = [new Map()];
      this.ns = r.cls === null ? '' : r.cls;
      this.selfClass = r.cls;
      this.selfProp = null;
      this.alias = r.cls === null ? new Map() : new Map([['this', '$this']]);
      this.lifted = new Set();
      this.curErr = null;
      this.retTy = J_VOID;
      this.shield = 0;
      this.guards = [];
      const binds = [];
      const runs = [];
      let k = 0;
      for (const s of this.flat(r.body.items[1])) {
        if (isList(s) && head(s) === 'onevent') {
          this.rctOnEvent(r, s, k, binds, self, onRd);
          k++;
          continue;
        }
        const rn = `${r.full}$r${k}`;
        k++;
        const lines = this.stmt(s, 8);
        if (lines === null) continue;
        this.decls.push(`  (fn ${rn} (${selfDecl}) void\n    (if ${onRd}\n      (do\n`
          + `${lines.join('\n')})))`);
        const sig = { params: self === null ? [] : [self], ret: J_VOID };
        this.fns.set(rn, sig);
        if (r.cls !== null) this.methods.set(rn, r.cls);
        const clo = self === null
          ? `(fnref ${rn})` : `(mkclo ${this.methodThunk(rn, r.cls, sig)} (var $this))`;
        const reads = [];
        this.rctReads(s, reads);
        for (const p of reads) {
          /* 对象那一段里带下标或调用的读（语料 582 处里 79 处）明说不收：这一层是**在 start
             那一刻**把订阅挂上去的，而 `m_actionTable[ActionId.Connect].m_text` 里那一格对象
             要等下标算出来才知道 —— 绑的是那一刻算出来的那一格，后来换了就绑错了。
             jancy 没这个问题：它每跑一遍重收一次依赖。 */
          if (this.rctDyn(p)) {
            this.nope(p, 'reactor 的反应里经下标 / 调用读一格 bindable 属性（这一层的订阅是在'
              + ' start 那一刻绑的，那时算出来的对象与后来不一定是同一格）');
            continue;
          }
          const mc = this.mcRef(this.mkL(p.span, this.mkA(p.span, 'bindingof'), p));
          if (mc === null || mc === undefined) continue;
          binds.push(`    (apush ${mc.code} ${clo})`);
        }
        runs.push(`    (expr (call ${rn}${selfArg}))`);
      }
      this.ns = saveNs;
      this.selfClass = saveSelf;
      this.selfProp = savePr;
      this.alias = saveAlias;
      this.lifted = saveLifted;
      this.curErr = saveErr;
      this.retTy = saveRet;
      this.scopes = [];
      /* 绑定只挂一次（`bound` 那一格，成员的那一格在**对象里**），而"跑一遍"每次 start 都做
         —— restart（语料 2 处，注释写的是 "need to re-bind"）在这一层就是"再跑一遍"：
         依赖是静态的，重绑是空操作。 */
      const bd = r.cls === null ? `${r.full}$bound` : r.bound;
      const bdRd = self === null ? `(var ${bd})` : `(pload (pfield (var $this) ${bd}))`;
      const bdSet = self === null
        ? `(set ${bd} (bool true))` : `(pstore (pfield (var $this) ${bd}) (bool true))`;
      if (self === null) this.decls.push(`  (global ${bd} bool)`);
      const onSet = (v) => (self === null
        ? `(set ${r.on} (bool ${v}))` : `(pstore (pfield (var $this) ${r.on}) (bool ${v}))`);
      this.decls.push(`  (fn ${r.full}$start (${selfDecl}) void\n`
        + `    (if (un "!" ${bdRd})\n      (do\n        ${bdSet}\n`
        + `${binds.map((b) => `    ${b}`).join('\n')}))\n`
        + `    ${onSet(true)}\n${runs.join('\n')})`);
      this.decls.push(`  (fn ${r.full}$stop (${selfDecl}) void\n    ${onSet(false)})`);
      this.fns.set(`${r.full}$start`, { params: self === null ? [] : [self], ret: J_VOID });
      this.fns.set(`${r.full}$stop`, { params: self === null ? [] : [self], ret: J_VOID });
      if (r.cls !== null) {
        this.methods.set(`${r.full}$start`, r.cls);
        this.methods.set(`${r.full}$stop`, r.cls);
      }
    }
  }

  /**
   * 一格 reactor 的 onevent（第八十五刀）：`onevent (事件…)(形参…) { 体 }`。
   *
   * 与反应不同 —— 它订阅的是**写出来的**那几格事件（samples/jnc/41_OnEventStmt.jnc:35-59：
   * 一格 `bindingof(…)`、几格凑一串、或者一格普通事件名），所以不用收依赖。闸门同反应：
   * stop 之后不干活。
   */
  rctOnEvent(r, s, k, binds, self, onRd) {
    const hn = `${r.full}$e${k}`;
    const ps = this.formalList(s.items[2]);
    if (ps === null) return;
    const decl = [self === null ? null : `($this ${slotText(self)})`]
      .concat(ps.map((p) => `(${p.name} ${slotText(p.type)})`)).filter((x) => x !== null);
    this.scopes.push(new Map());
    for (const p of ps) this.push(p.name, p.type);
    const body = this.block(s.items[3], 8);
    this.scopes.pop();
    if (body === null) return;
    this.decls.push(`  (fn ${hn} (${decl.join(' ')}) void\n    (if ${onRd}\n      (do\n${body})))`);
    const sig = { params: (self === null ? [] : [self]).concat(ps.map((p) => p.type)), ret: J_VOID };
    this.fns.set(hn, sig);
    if (r.cls !== null) this.methods.set(hn, r.cls);
    const clo = self === null
      ? `(fnref ${hn})` : `(mkclo ${this.methodThunk(hn, r.cls, sig)} (var $this))`;
    const want = ps.map((p) => p.type);
    /* 一对括号里的**一串**事件（第二百〇五刀）：`onevent (bindingof(g_ip4),
       bindingof(g_routerIp4))() { … }`（41_OnEventStmt.jnc:45 —— 同一个处理函数挂到好几格事件上）。
       语法给的是 `(events-list <expr-list>)`（jnc.grammar:601），比单个那条
       （`(events <expr>)`）多包了一层，所以要多摊一次 —— 先前那一层没摊，于是拿整个 expr-list
       去 mcRef，报的是"onevent 里头要是一格事件"，指着别处。 */
    const evNode = s.items[1];
    const evList = isList(evNode) && head(evNode) === 'events-list'
      ? this.flat(evNode.items[1]) : this.flat(evNode);
    for (const e of evList) {
      const mc = this.mcRef(e);
      if (mc === null) continue;
      if (mc === undefined) { this.err(e, 'onevent 里头要是一格事件（或 `bindingof(属性)`）'); continue; }
      if (mc.type.params.length !== want.length
        || mc.type.params.some((t, i) => !sameTy(t, want[i]))) {
        this.err(e, `onevent 的形参与这格事件对不上：事件是 ${tyName(mc.type)}`);
        continue;
      }
      binds.push(`    (apush ${mc.code} ${clo})`);
    }
  }

  /**
   * 一格 reactor 的**体**（第八十五刀）：`reactor Cls.m_r { … }` 与顶层 `reactor g_r { … }`。
   *
   * 语法上它就是一格 fn-def —— `(specs (no-type) (mods … "reactor"))` + 声明符 + compound
   * （量过 /tmp 的探针：语法一个字没改）。所以这一问排在签名那一遍**之前**，收下了回 true，
   * 那一遍与 topItem 都跳过它（不然它会被登记成一格返回 void 的函数）。
   *
   * 名字带限定的（`Cls.m_r`，语料 49/49）要在类里先声明过；不带的就是顶层那一格。
   */
  /** 这一格 specs 上写着 `reactor` 吗（第八十五刀 / 第九十五刀两处都要问）。 */
  rctSpecs(sp) {
    if (!isList(sp) || head(sp) !== 'specs') return false;
    return [...this.flat(sp.items[2]), ...this.flat(sp.items[3])]
      .filter((x) => isAtom(x)).map((x) => x.value).includes('reactor');
  }

  /** 一格 reactor 声明符上那个**不带前缀**的名字（第九十五刀）。认不出回 null。 */
  rctDeclName(d) {
    const core = isList(d) ? d.items[2] : null;
    if (!isList(core) || head(core) === 'qualified') return null;
    return this.qname(core);
  }

  reactorBody(n) {
    if (!isList(n) || head(n) !== 'fn-def') return false;
    if (!this.rctSpecs(n.items[1])) return false;
    /* 类体里就带体的那一种（第九十五刀）已经在 typeDecl 那一遍登记过了（`this.rctInline`
       是按节点记的）—— 这儿只要认下"它是一格 reactor 的体"，别再当顶层那一格登记一遍。 */
    if (this.rctInline.has(n)) return true;
    const d = n.items[2];
    const core = isList(d) ? d.items[2] : null;
    if (!isList(core)) { this.err(n, 'reactor 的名字认不出来'); return true; }
    if (head(core) === 'qualified') {
      const cls = this.declOwner(d);
      const nm = isAtom(core.items[2]) ? core.items[2].value : this.qname(core.items[2]);
      if (cls === null || nm === null) {
        this.err(n, 'reactor 的体写在类外时，前面那一格要是一个类（`reactor 类名.名字 { … }`）');
        return true;
      }
      const r = this.reactors.get(`${cls}$${nm}`);
      if (r === undefined) {
        this.err(n, `${shown(cls)} 里没有见到 reactor '${nm}' 的声明（类里要先写一句 `
          + `\`reactor ${nm};\`；也可能是那个类的体里前面有一条还不收的 —— 那时整格类都没登记）`);
        return true;
      }
      if (r.body !== null) { this.err(n, `reactor '${shown(r.full)}' 有两个体`); return true; }
      r.body = n.items[3];
      return true;
    }
    const nm = this.qname(core);
    if (nm === null) { this.err(n, 'reactor 的名字认不出来'); return true; }
    const full = this.qual(nm);
    if (this.reactors.has(full)) { this.err(n, `reactor '${shown(full)}' 声明了两次`); return true; }
    this.reactors.set(full, { full, cls: null, on: `${full}$on`, body: n.items[3], node: n });
    return true;
  }

  /**
   * 一条反应里**读到**的那些 bindable 属性（第八十五刀）：往 out 里攒它们的语法节点。
   *
   * jancy 是**运行期**收依赖的：读一格 bindable 属性时顺手 `addOnChangedBinding(reactionIdx,
   * onChanged)`（`OperatorMgr::prepareOperandType` 那一支，jnc_ct_OperatorMgr.cpp:1441-1457
   * -> `addReactorBinding`，jnc_ct_OperatorMgr_Property.cpp:409-428），所以每跑一遍就重收
   * 一次，分支变了依赖跟着变。这一层第一刀做**静态的超集**：把这条语句里所有读位置上的
   * bindable 属性都算依赖，start 那一刻绑一次。差别记在 ADR 里 —— 多跑，不会漏跑。
   *
   * 只看"读"：赋值的左边那一格是**写**（jancy 那边靠 `OpFlag_KeepPropertyRef` 分的，同一处
   * 1441 行那个 if），可左边的下标与实参里头照旧是读，所以那两处还要往里走。
   */
  rctReads(n, out, read = true) {
    if (!isList(n)) return;
    const h = head(n);
    if (h === 'assign' && n.items.length >= 4) {
      this.rctReads(n.items[2], out, false);
      this.rctReads(n.items[3], out, true);
      return;
    }
    if (read && (h === 'name' || h === 'field')) {
      const pn = this.propTarget(n);
      if (pn !== undefined && pn !== null) {
        const pi = this.props.get(pn.pn);
        if (pi !== undefined && pi.onch !== null) { out.push(n); return; }
      }
    }
    // 左边那一格是写，可它里头的下标 / 实参照旧是读 —— 所以 field 的对象那一半也要往里走。
    for (let i = 1; i < n.items.length; i++) {
      this.rctReads(n.items[i], out, read || h === 'index' || h === 'call' || h === 'args');
    }
  }

  /** 这条读里那格**对象**是算出来的吗（第八十五刀）：链上有下标或调用就算。 */
  rctDyn(n) {
    if (!isList(n)) return false;
    const h = head(n);
    if (h === 'index' || h === 'call') return true;
    if (h === 'field' || h === 'ptr-field') return this.rctDyn(n.items[1]);
    return false;
  }

  /** 当前命名空间下的全名（第五十一刀）。写的名字里带点（`struct a.S`）也一并换成 `$`。 */
  qual(name) {
    const k = name.replace(/\./g, '$');
    return this.ns === '' ? k : `${this.ns}$${k}`;
  }

  /**
   * 从里往外找一个名字。jancy 的查名就是"从当前命名空间一层层往外退到全局"
   * （`NamespaceMgr::findItem` 那一族），所以 `namespace a` 里写 `S` 先看 `a.S`、
   * 再看全局的 `S`。`nm` 是**源码里写的**名字，可能带点（`a.S`）。
   *
   * 往外退那一步（第一百三十二刀）**不能只按 `$` 掐**：泛型的实例名是
   * `Box$Node` 那样拼出来的（`模板名$实参键`，见 tinstOne），里头那个 `$` 不是一层
   * 命名空间。照 `$` 退一层会退成 `Box`，于是在实例体里写 `Node` 找到的是
   * `Box$Node` —— **实例它自己**。所以实例名要当**一个整体**，退的时候直接跳到那个
   * 泛型声明处的那一层去（`instNs`）。
   */
  resolve(nm, has) {
    const k = nm.replace(/\./g, '$');
    let p = this.ns;
    for (;;) {
      const full = p === '' ? k : `${p}$${k}`;
      if (has(full)) return full;
      if (p === '') break;
      const j = this.instNs.get(p);
      if (j !== undefined && j !== p) { p = j; continue; }
      const i = p.lastIndexOf('$');
      p = i < 0 ? '' : p.slice(0, i);
    }
    // 体外写的方法（第五十二刀）：它的**签名**也在那个类那一层里查 —— `S1 C.foo()` 里的
    // S1 就是 `C.S1`（test97.jnc:15）。这一格只在 fnSig 那一遍非 null，而且**只管查名**，
    // 不影响登记用的 `qual`（那一处要的是源码里写的 `C.foo`，不能再叠一次前缀）。
    if (this.nsExtra !== null) {
      const full = `${this.nsExtra}$${k}`;
      if (has(full)) return full;
    }
    // 往外退到底还没找着，最后再顺着**基类那一层**上去找一遍（第一百三十七刀）
    const b = this.baseResolve(k, has);
    if (b !== null) return b;
    /* `using namespace X;`（第二百一十七刀）。jancy 的查名次序是"当前那条链先、using 表后"
       （Namespace::findItemTraverse -> UsingSet，jnc_ct_Parser.cpp:987 那句 addNamespace 就是
       往那张表里塞），所以这一问排在最后 —— 它只会**多认**名字，不会把已经认得的那些换掉。
       两张表里都有同一个名字时 jancy 报歧义：这儿先按第一张算，同时把这一格记下来，
       run 末尾照实报（悄悄按第一张算是骗人）。 */
    for (const u of this.usingNs) {
      if (!(u.in === '' || this.ns === u.in || this.ns.startsWith(`${u.in}$`))) continue;
      const full = `${u.ns}$${k}`;
      if (!has(full)) continue;
      for (const u2 of this.usingNs) {
        if (u2 === u || u2.ns === u.ns) continue;
        if (!(u2.in === '' || this.ns === u2.in || this.ns.startsWith(`${u2.in}$`))) continue;
        if (has(`${u2.ns}$${k}`)) this.usingAmbig.set(k, u.node);
      }
      return full;
    }
    return null;
  }

  /**
   * `using namespace X;`（第二百一十七刀）。语料里 4 份文件 6 处：
   * `using namespace stdt;`（unit_stdt_Array.jnc:5 那一族四份）与 test41.jnc:29/34。
   *
   * jancy 那儿它往**当前那层命名空间**的 using 表里塞一格（`nspace->m_usingSet.addNamespace`，
   * jnc_ct_Parser.cpp:987），查名时那条链找不着才看这张表。所以这一层的落法就是同一句话：
   * 记下"写在哪一层（`in`）、指向哪一层（`ns`）"，resolve 那条链走完再看它们（见 resolve 末尾）。
   *
   * 这一遍排在 typeName 之前 —— `using namespace stdt;` 之后那些声明里写的正是 `Array<int>`
   * 这种裸名字，类型名那一遍就要认得。
   *
   * **界写清**：写在**函数体里**的那一格（test41.jnc:29）还不收 —— 它的作用域是那个块，
   * 要一张跟着 `scopes` 一起进出的表，是自己一刀（见 bad/using-namespace-stmt.jnc）。
   */
  usingScan(items) {
    const save = this.ns;
    for (const e of items) {
      const it = e.it;
      if (!isList(it) || head(it) !== 'using-namespace') continue;
      this.ns = e.ns;
      const nm = this.qname(it.items[1]);
      if (nm === null) { this.err(it, '认不出的命名空间名字'); continue; }
      const t = this.resolve(nm, (k) => this.nsNames.has(k));
      if (t === null) { this.err(it, `没有这个命名空间：'${nm}'`); continue; }
      this.usingNs.push({ in: e.ns, ns: t, node: it });
    }
    this.ns = save;
  }

  /**
   * 顺着基类链找一个名字（第一百三十七刀）。`class D0: B0 { X m_v; }` 里那个 `X` 可能是
   * 基类的成员 typedef —— jancy 那边类**同时是一层命名空间**，而派生类那一层是接在基类
   * 那一层上的（`ClassType` 派生自 `Namespace`，查名沿 `m_baseTypeList` 上溯）。
   *
   * 排在 `resolve` 的最后：自己那几层先查完，才轮到基类。多格基类按**声明顺序** BFS ——
   * 与第九十四刀 mixins 那处同一条口径（第一格先）。
   *
   * 基类的名字解成全名要在**这时候**做（aggHoist 那一遍类还没登记上），所以这儿会回头调
   * `resolve` —— `inBase` 是那道闸门：解基类名字的时候不再往基类上走，免得绕回来。
   */
  baseResolve(k, has) {
    if (this.inBase || this.aggBases.size === 0) return null;
    let p = this.ns;
    for (;;) {
      const q = [p];
      const seen = new Set();
      while (q.length > 0) {
        const cur = q.shift();
        if (seen.has(cur)) continue;                 // 环（第一百二十八刀那道闸门管的是布局）
        seen.add(cur);
        const e = this.aggBases.get(cur);
        if (e === undefined) continue;
        for (const bn of e.names) {
          const saveNs = this.ns;
          const saveIn = this.inBase;
          this.ns = e.ns;
          this.inBase = true;
          const b = this.resolve(bn, (x) => this.classes.has(x) || this.structs.has(x));
          this.ns = saveNs;
          this.inBase = saveIn;
          if (b === null) continue;
          const full = `${b}$${k}`;
          if (has(full)) return full;
          q.push(b);
        }
      }
      if (p === '') return null;
      const j = this.instNs.get(p);
      if (j !== undefined && j !== p) { p = j; continue; }
      const i = p.lastIndexOf('$');
      p = i < 0 ? '' : p.slice(0, i);
    }
  }

  err(node, msg) {
    this.diags.error(node === null || node === undefined ? null : node.span, msg);
    return null;
  }

  nope(node, what) {
    return this.err(node, `${JNC_NOPE}：${what}`);
  }

  /** 一条**警告**（不停下）。`import … with "h"` 里跳过的那些声明走这条，见 `impWith`。 */
  warn(node, msg) {
    this.diags.warn(node === null || node === undefined ? null : node.span, msg);
    return null;
  }

  /** `(H)` / `(H X)` / `(H-add PREV X)` 三种形状摊成一条平的列表（与 asy 那份同一个套路） */
  flat(node) {
    if (!isList(node)) return [];
    const h = head(node);
    if (h !== null && h.endsWith('-add')) {
      return [...this.flat(node.items[1]), node.items[2]];
    }
    return node.items.slice(1);
  }

  /**
   * `A a(x, y);` 里那对括号（第一百〇三刀）：语法上它与"带形参表的声明符"长得一模一样
   * （C++ 那个 most vexing parse），语义上是**造一个局部对象、把 `(x, y)` 当构造实参**
   * （`ui.Action action(icon, text);`，test/ioninja/api/doc_Plugin.jnc:80，语料 69 对）。
   *
   * 判据：每一格都是**无名形参**（`(formal-anon specs ptrs)` —— 语法上 `x` 只有"类型"没有
   * 名字）、`ptrs` 空、`specs` 两侧的 mods 都空、而那一格 type-spec 归约出来的正是一格
   * `(name <ID>)`。凑齐了就把那几格**原样**当实参用 —— `(name <ID>)` 在表达式那一侧本来就是
   * 一个名字，一个节点都不用新造（试落第一趟栽在这儿：造了 `(name (name X))`，`qname` 要的是
   * `items[1]` 是 atom，于是答 null、下游 `resolve` 拿它去 replace 就崩了）。
   *
   * 内建类型关键字（`int` 那些）归约出来不是 `(name …)`、限定名是 `(qualified …)` ——
   * 两种都回 null，那时它当形参表看，由调用方报。
   */
  ctorArgsOf(fs) {
    const out = [];
    for (const f of this.flat(fs)) {
      if (!isList(f) || head(f) !== 'formal-anon') return null;
      const sp = f.items[1];
      const pt = f.items[2];
      if (!isList(sp) || head(sp) !== 'specs') return null;
      if (isList(pt) && this.flat(pt).length > 0) return null;
      if (this.flat(sp.items[2]).length > 0 || this.flat(sp.items[3]).length > 0) return null;
      const ts = sp.items[1];
      if (!isList(ts) || head(ts) !== 'name' || !isAtom(ts.items[1])) return null;
      out.push(ts);
    }
    if (out.length === 0) return null;
    return this.mkL(fs.span, this.mkA(fs.span, 'args'), ...out);
  }

  /** 一格局部量进作用域。`dname` 是它在方言里的名字 —— 只有 `static` 的局部量不一样
   *  （第二十六刀：那一格是模块级的，名字带上函数名），所以默认就是它自己。 */
  push(name, type, dname) {
    this.scopes[this.scopes.length - 1].set(name, {
      t: type,
      d: dname === undefined ? name : dname,
      s: dname !== undefined,
    });
  }

  /** 名字的类型 + "它那一格是模块级的吗" + 它在方言里叫什么。方言里两者的读写形式相同
   *  （`(var …)` / `(set …)`），分开是因为"提到一格内存里"那件事两边的落法不一样：
   *  局部量提的是另一格 `x$c`（第九刀），模块级的是**它自己**发成 `(ptr T)`
   *  （第二十四刀，见 declareGlobal）。`static` 的局部量走的是模块级那一条，
   *  只是名字不同（第二十六刀）。 */
  lookupRef(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const e = this.scopes[i].get(name);
      if (e !== undefined) return { type: e.t, global: e.s, dname: e.d };
    }
    // 模块级那一格从里往外找（第五十一刀）：`namespace a` 里写 `g` 先看 `a.g`。
    const gk = this.resolve(name, (k) => this.globals.has(k));
    if (gk === null) return null;
    return { type: this.globals.get(gk), global: true, dname: gk };
  }

  lookup(name) {
    const r = this.lookupRef(name);
    return r === null ? null : r.type;
  }

  /** 方法体里裸写的字段名（第五十二刀）。jancy 的类是一层命名空间，方法体里 `m_x` 就是
   *  `this.m_x` —— 局部量与形参先查（那是里层的作用域），查不着才问这一格。 */
  selfField(name) {
    if (this.selfClass === null) return null;
    const fs = this.structs.get(this.selfClass);
    if (fs === undefined) return null;
    // 成员属性的存/取值器体里那些**编译器生成物的名字**（第七十一 / 八十四刀）：
    // `m_value`（prop_autoget.rst:26）与 `m_onChanged`（prop_bindable.rst:23-29）——
    // 源码里写的是这两个名字，而类里那两格叫 `<属性全名>$m_value` / `…$m_onChanged`。
    // 换名的表由 fnDef 摆（selfProp：源码里的名字 -> 字段名）。回的是**字段自己**，
    // 所以下游一律拿 `f.name` 发 pfield，不能再用源码里写的那个名字。
    const key = this.selfProp !== null && this.selfProp.has(name)
      ? this.selfProp.get(name) : name;
    const f = fs.find((x) => x.name === key);
    return f === undefined ? null : f;
  }

  /** 方法体里**裸写**一格字段路径别名（第一百〇四刀）：`m_head` -> `this.m_list.m_head`。
   *  与 memberOf 那一处是同一张表、同一种叠法，只是基那一格是 `$this`。 */
  selfPathLv(nm) {
    if (this.selfClass === null) return null;
    const ap = this.aliasPath.get(`${this.selfClass}$${nm}`);
    if (ap === undefined) return null;
    let code = '(var $this)';
    for (const s of ap.path) code = `(pfield ${code} ${s})`;
    return {
      kind: jncIsStruct(ap.type) || isArr(ap.type) ? 'agg' : 'ptr',
      code,
      type: ap.type,
    };
  }

  /** 一格位域当左值（第一百一十二刀）。`code` 走到**存储那一格**，`off` / `cnt` / `bw` 说的是
   *  哪几位 —— 读写在 bitsRead / bitsStore 里，所以 `=`、`++`、`&=` 一条都不用单独接。 */
  bitsLv(bp, baseCode) {
    let code = baseCode;
    for (const s of bp.path) code = `(pfield ${code} ${s})`;
    return { kind: 'bits', code, type: bp.type, off: bp.off, cnt: bp.cnt, bw: bp.bw };
  }

  /** 方法体里**裸写**一格位域（第一百一十二刀）：`m_flag` 就是 `this.m_flag`。
   *  与 selfPathLv 同一条路 —— 结构体从第一百〇一刀起也有方法，所以这一处是真会走到的。 */
  selfBitLv(nm) {
    if (this.selfClass === null) return null;
    const bp = this.bitPath.get(`${this.selfClass}$${nm}`);
    if (bp === undefined) return null;
    return this.bitsLv(bp, '(var $this)');
  }

  /** 一格 bigendian 字段当左值（第一百二十六刀）：`path` 与 aliasPath 那张表同一种叠法 ——
   *  匿名 union 里再套匿名 struct 时它是两段（`$s0` / 字段名）。 */
  beLv(bep, baseCode) {
    let code = baseCode;
    for (const s of bep.path) code = `(pfield ${code} ${s})`;
    return { kind: 'be', code, type: bep.type, w: bep.w };
  }

  /** 方法体里**裸写**一格 bigendian 字段（第一百二十六刀）：与 selfBitLv 同一条路。 */
  selfBeLv(nm) {
    if (this.selfClass === null) return null;
    const bep = this.bePath.get(`${this.selfClass}$${nm}`);
    if (bep === undefined) return null;
    return this.beLv(bep, '(var $this)');
  }

  /* ---------------------------------------------------------- 取地址（第九刀）
   *
   * jancy 的做法照抄：**被 fat 取过地址的局部量提到 GC 堆上**（type_ptr_data.rst 里那句
   * "any local taken fat address of, is being lifted to GC heap"）。方言的局部量是 SSA 里
   * 的一个值、没有地址，而 `(pnew (ptr T) (int 1))` 出来的那一格**有**。所以：
   *
   *   int x = 1;  int* p = &x;      ->    (let x$c (ptr int) (pnew (ptr int) (int 1)))
   *                                      (pstore (var x$c) (int 1))
   *                                      (let p (ptr int) (var x$c))
   *
   * 之后对 x 的读写全走那一格（`(pload (var x$c))` / `(pstore (var x$c) …)`），于是
   * `*p = 5` 与 `x` 看到的是同一个字 —— 别名是真的，不是模拟出来的。方言一个字没改。
   *
   * 判定是**函数级、按名字**的保守判定：一个名字在这个函数里任何地方被 `&` 过，这个函数里
   * 所有同名局部量都提。多提一格堆上的空间，换掉"要先做作用域分析才知道提哪个"——
   * 语义上不会错（提与不提对不取地址的用法**没有可观测差别**）。
   *
   * **模块级的那一半是第二十四刀**，同一套办法、同一份 collectAddrTaken：只是那一遍在
   * `run()` 里对**整份源码**数一次（`&g` 出现在函数体里，而 `(global …)` 要在那之前发），
   * 而"那一格"不用另起名字 —— 全局自己发成 `(ptr T)` 就是那一格（见 declareGlobal）。
   * 保守的代价也一样：同名的局部量会把全局也带上，多一次 pnew，没有可观测差别。
   */
  collectAddrTaken(node, out, retPtr = false) {
    if (!isList(node)) return;
    if (head(node) === 'addr') {
      const t = node.items[1];
      if (isList(t) && head(t) === 'name' && isAtom(t.items[1])) out.add(t.items[1].value);
    }
    /* 结构体左值回成指针那一格（第一百六十七刀）：`return entry;` 与 `return &entry;` 一样是
       "地址逃出去了"，所以这一遍也得把它算进来 —— 不然那格量还躺在原地，回出去的地址指着
       一段马上就不属于它的内存。这一问**只在返回类型是数据指针的函数里**问，而且宁可多提
       一格（多提只是多一次 pnew，漏提是错答案）。 */
    if (retPtr && head(node) === 'return' && isList(node.items[1])
      && head(node.items[1]) === 'name' && isAtom(node.items[1].items[1])) {
      out.add(node.items[1].items[1].value);
    }
    for (const it of node.items) this.collectAddrTaken(it, out, retPtr);
  }

  /** 提上去的那一格在方言里的名字。`$` 不在 jancy 的标识符里，所以撞不上用户的名字。 */
  cellName(name) { return `${name}$c`; }

  /** 这个 jancy 名字在方言里叫什么。只有结构体形参不一样：它在函数开头被抄进了另一格
   *  （第十三刀），从那以后所有对它的读写都走那一格。 */
  dialectName(name) {
    const a = this.alias.get(name);
    return a === undefined ? name : a;
  }

  /**
   * 结构体的**值语义**：逐字段抄一遍（第十二刀）。
   *
   * jancy 的 struct 是 POD 值类型，所以 `t = s` 是"抄一份"而不是"共享同一段"。这一层的
   * 结构体变量各是一段自己的 `pnew` 内存，于是"抄一份"就是把每个字段搬过去 —— 嵌套的
   * 结构体字段递归下去，别的字段是一句 `(pstore (pfield 目标 f) (pload (pfield 源 f)))`。
   *
   * 为什么不用一条"整块搬"的方言形式：那要 `pload` / `pstore` 能搬多个字，而这一层能自己
   * 把它拆开 —— 与回卷、真值化同一类，jancy 侧的一次隐式动作在这一层显式写出来。
   */
  /**
   * 抄之前先把源头钉住（第十三刀）。`copyAgg` 会把源头的地址写进每个字段一次，所以源头
   * 只能是"求一次值就够"的东西。`(var x)` 本来就是；`(call f)` 不是 —— 直接塞进去会把
   * 那次调用发 N 遍。所以别的形状先落进一格临时量。
   */
  aggSource(code, slotTy, pad, out) {
    if (/^\(var [^ ()]+\)$/.test(code)) return code;
    const t = `$s${this.tmp++}`;
    out.push(`${pad}(let ${t} ${slotTy} ${code})`);
    return `(var ${t})`;
  }

  /**
   * 抄一格：结构体逐字段、数组逐格、别的就是一句 `pstore` + `pload`（第二十一刀）。
   *
   * 数组这一支也是**值语义**的，与结构体同一个道理 —— jancy 那边它不是 C：
   * `createFormalArg`（jnc_ct_Parser.cpp:2507）不做 C 那种"形参退化成 `T*`"，形参的类型
   * 就还是 `T[N]`；`t = s` 走 `storeDataRef` -> `castOperator`，那儿 `Cast_Array` 带着
   * `OpFlag_LoadArrayRef`（CastOp_Array.h:26），于是先把**整块**载出来，接着
   * `opType->isEqual(type)` 那条恒等捷径（OperatorMgr.cpp:527）直接把载出来的值交出去 ——
   * 所以同型数组之间是抄一份。`Cast_Array::llvmCast` 那句"未实现"只挡**不同型**的那些
   * （长度不一样、或元素是同宽的另一种整数）。
   */
  copyVal(dstCode, srcCode, type, pad, out, seen = new Set()) {
    if (jncIsStruct(type)) return this.copyAgg(dstCode, srcCode, type.name, pad, out, seen);
    if (isArr(type)) return this.copyArr(dstCode, srcCode, type, pad, out, seen);
    out.push(`${pad}(pstore ${dstCode} (pload ${srcCode}))`);
    return out;
  }

  /** 逐格抄一整块。长度是编译期的字面量，所以这里就地展开（与 copyAgg 逐字段同一形状）。 */
  copyArr(dstCode, srcCode, type, pad, out, seen = new Set()) {
    const d0 = `(pelem ${dstCode})`;
    const s0 = `(pelem ${srcCode})`;
    for (let i = 0; i < type.n; i++) {
      const d = i === 0 ? d0 : `(padd ${d0} (int ${i}))`;
      const s = i === 0 ? s0 : `(padd ${s0} (int ${i}))`;
      if (this.copyVal(d, s, type.el, pad, out, seen) === null) return null;
    }
    return out;
  }

  /**
   * 逐字段抄一格结构体。`seen` 是**环的闸门**（第一百二十八刀）：一格结构体按值套到自己
   * 里头本来就不是一个有大小的类型，可这一对函数先前顺着字段类型直接递归、一句拦的话都没有
   * —— 泛型落地之后语料里真出现了那个形状（`stdt_RbTree.jnc:51` 把泛型自己的名字当类型实参
   * 传），于是这儿**爆栈**：`RangeError: Maximum call stack size exceeded`，不说话、也带不出
   * 位置。**崩是最坏的一种答案**，所以这一格宁可多一句 err 也不能少这个 Set。
   */
  copyAgg(dstCode, srcCode, name, pad, out, seen = new Set()) {
    const fs = this.structs.get(name);
    if (fs === undefined) return this.err(null, `内部错误：没有结构体 '${name}'`);
    if (seen.has(name)) {
      return this.err(null, `结构体 '${shown(name)}' 按值套到了自己里头 —— 这样的类型没有大小`
        + '（拷一份会无穷递归）');
    }
    const inner = new Set(seen);
    inner.add(name);
    for (const f of fs) {
      const d = `(pfield ${dstCode} ${f.name})`;
      const s = `(pfield ${srcCode} ${f.name})`;
      if (this.copyVal(d, s, f.type, pad, out, inner) === null) return null;
    }
    return out;
  }

  /* ------------------------------------------------ 花括号初值（第十四刀） */

  /**
   * 一格里能写多少 —— 花括号初值的**一份引擎**。声明、赋值都走它，数组与结构体也都走它。
   *
   * 语义逐条照 jancy 的 `CurlyInitializer`（jnc_ct_Parser.cpp:3312..3395）：
   *   - 一个游标 `idx`，从 0 起。位置项写 `idx` 那一格，然后 `idx++`
   *     （prepareCurlyInitializerIndexedItem + assignCurlyInitializerItem）。
   *   - 空项（`{ ,, 3 }` 里那些空的）**只挪游标、不写那一格**（skipCurlyInitializerItem
   *     里只有一句 `m_index++`）。声明那一处那格刚 pnew 出来是零；赋值那一处**保留原值** ——
   *     `point = { , 200, 300 }` 之后 `m_x` 还是上一次那个数（84_CurlyInitializers.jnc:61）。
   *   - 命名项 `f = v` 把游标设成 -1，之后**不能再写位置项**（prepareCurlyInitializerIndexedItem
   *     那句 "indexed-based initializer cannot be used after named-based initializer"）。
   *   - 一项本身可以再是一对花括号（嵌套的结构体字段、结构体数组的元素）。
   *   - 一项都没写是错（curly_initializer 那句 "empty curly initializer"）。
   *
   * 分两步（这一份出单子、curlyEmit 写）是因为声明那一处目标那格的 `(let …)` 必须发在**所有
   * 初值之后**：`int a[2] = { a, 1 }` 里右边那个 a 指的是外层那个（见 opts.shadow）。
   */
  curlyPlan(curly, type, pad, out, opts, steps, plan) {
    if (!isList(curly) || head(curly) !== 'curly') { this.err(curly, '认不出的花括号初值'); return null; }
    let idx = 0;
    let count = 0;
    for (const it of this.flat(curly.items[1])) {
      const ih = isList(it) ? head(it) : null;
      if (ih === 'skip-item') { if (idx !== -1) idx++; continue; }
      if (ih === 'indexed-item') { this.nope(it, '花括号初值里的 `[i] = …`（jancy 的项只有位置与名字两种）'); return null; }
      const named = ih === 'named-item';
      if (!named && idx === -1) {
        this.err(it, '命名项之后不能再写位置项（jancy 那句 "indexed-based initializer '
          + 'cannot be used after named-based initializer"）');
        return null;
      }
      const m = named
        ? this.curlyMember(it, type, -1, isAtom(it.items[1]) ? it.items[1].value : null)
        : this.curlyMember(it, type, idx, null);
      if (m === null) return null;
      idx = named ? -1 : idx + 1;
      const val = named ? it.items[2] : it;
      const sub = steps.concat([m.step]);
      if (isList(val) && head(val) === 'curly') {
        if (!jncIsStruct(m.type) && !isArr(m.type)) {
          this.err(val, `这一项是一对花括号，而它对着的是 ${tyName(m.type)}`);
          return null;
        }
        if (this.curlyPlan(val, m.type, pad, out, opts, sub, plan) === null) return null;
        count++;
        continue;
      }
      const code = opts.val(val, m.type);
      if (code === null) return null;
      count++;
      // 这一项本身是一整格聚合（结构体，或者一整块数组）时它是"抄一份"，所以源头先钉住。
      if (jncIsStruct(m.type) || isArr(m.type)) {
        plan.push({ steps: sub, code: this.aggSource(code, slotText(m.type), pad, out), agg: m.type });
        continue;
      }
      plan.push({ steps: sub, code: this.pin(code, m.type, opts.shadow, pad, out), agg: null });
    }
    if (count === 0) { this.err(curly, '空的花括号初值（jancy 那句 "empty curly initializer"）'); return null; }
    return plan;
  }

  /** 游标（或名字）落在哪一格：回一步"怎么走到它"与那一格的类型。 */
  curlyMember(node, type, idx, name) {
    if (jncIsStruct(type)) {
      /* 带位域的结构体上还不收花括号初值（第一百一十二刀）。这一遍是**按第几格字段**数的
         （`fs[idx]`），而位域不占自己的格子 —— 数下去写的是整格存储，是个静默的错答案。
         按名字写的那一种也一起拦：要接它得让 curlyEmit 那张单子也认得"哪几位"。 */
      if (this.bitAggs.has(type.name)) {
        return this.nope(node, `${shown(type.name)} 里有位域，它的花括号初值 ——`
          + '（这一遍是按第几格字段数的，而位域不占自己的格子）');
      }
      const fs = this.structs.get(type.name);
      if (fs === undefined) return this.err(node, `内部错误：没有结构体 '${type.name}'`);
      const f = name === null ? fs[idx] : fs.find((x) => x.name === name);
      if (f === undefined) {
        return name === null
          ? this.err(node, `第 ${idx + 1} 项越过了 ${type.name} 的 ${fs.length} 个字段`)
          : this.err(node, `${shown(type.name)} 没有字段 '${name}'`);
      }
      return { step: { f: f.name }, type: f.type };
    }
    if (name !== null) return this.err(node, `数组上的命名项 '${name} = …'（名字是结构体字段才有的）`);
    if (idx >= type.n) return this.err(node, `第 ${idx + 1} 项越过了数组的 ${type.n} 格`);
    return { step: { i: idx }, type: type.el };
  }

  /** 单子上的一条条写下去。地址是"目标 + 几步"折出来的，所以同一张单子换个目标也成立。 */
  curlyEmit(plan, targetCode, pad, out) {
    for (const w of plan) {
      // 一格数组是**一整块**（第十九刀），所以下标那一步要先 `(pelem …)` 退成元素指针
      // 再 `padd` —— 与 decay 那一句是同一件事，只是这里的地址是折出来的。
      const addr = w.steps.reduce(
        (acc, s) => (s.f === undefined ? `(padd (pelem ${acc}) (int ${s.i}))` : `(pfield ${acc} ${s.f})`),
        targetCode,
      );
      if (w.agg !== null) {
        if (this.copyVal(addr, w.code, w.agg, pad, out) === null) return null;
        continue;
      }
      out.push(`${pad}(pstore ${addr} ${w.code})`);
    }
    return out;
  }

  /**
   * 只在初值里提到了**目标那个名字**时才钉一格临时。声明那一处目标的 `(let …)` 发在初值
   * 之后，可它一旦发出来就把外层同名的那个遮住了 —— `int a[2] = { a, 1 }` 里的 a 要的是外层。
   * 名字在这一层一律降成 `(var 名字)`，所以这一句判得准（字段名是 `(pfield … a)`，不会误判）。
   */
  pin(code, type, shadow, pad, out) {
    if (shadow === null || !code.includes(`(var ${shadow})`)) return code;
    const t = `$c${this.tmp++}`;
    out.push(`${pad}(let ${t} ${tyText(type)} ${code})`);
    return `(var ${t})`;
  }

  /**
   * `[]` 的长度。**不是项数**：jancy 数的是**非空**项（getAutoSizeArrayElementCount_curly，
   * jnc_ct_OperatorMgr_New.cpp:454 —— 那个循环只在见过非空项之后才 `elementCount++`）。
   * 所以 `int a[] = { 1, , 3 }` 在 jancy 那边是**两格**，而写值的游标会走到第三格 ——
   * 它自己那两半在这一处对不上。这一层照它数长度，越界那一下当场报错（curlyMember）。
   */
  curlyLen(curly) {
    let n = 0;
    for (const it of this.flat(curly.items[1])) if (!(isList(it) && head(it) === 'skip-item')) n++;
    return n;
  }

  /** 花括号初值目标的类型：数组的 `[]` 在这儿数出长度，别的类型在这儿被拒。 */
  curlyType(n, info, curly) {
    if (isArr(info.type)) {
      if (info.type.n !== null) return info.type;
      const len = this.curlyLen(curly);
      if (len < 1) return this.err(n, `'${info.name}[]' 的花括号初值里没有非空项，数不出长度`);
      return tArr(info.type.el, len);
    }
    if (jncIsStruct(info.type)) return info.type;
    return this.nope(n, `${tyName(info.type)} 的花括号初始化（只有数组与结构体是一段能按格子写的内存）`);
  }

  /** 一个初值/一项的值：降、整数隐式转、比类型。回 code。 */
  initValue(node, want) {
    let v = this.expr(node, want);
    if (v === null) return null;
    if (isInt(v.type) && isInt(want)) v = intConv(v, want);
    if (!this.assignOk(v.type, want)) return this.err(node, `这一项是 ${tyName(v.type)}，而它对着的是 ${tyName(want)}`);
    return v.code;
  }

  /**
   * 能提上去吗。方言的 `(ptr T)` 的 T 收 int / real / bool、结构体，与**指针自己**
   * （hir/types.js 的 ptrTargetOk，第十六刀那一格）。结构体本来就是一段内存了
   * （第十二刀：那一格名字里放的就是地址，`&s` 不发一个字），所以走这一条的是三种标量
   * 加两种指针 —— `&p` 于是与 `&x` 同一条路：把 p 提到一格 `(pnew (ptr (ptr int)) …)` 上。
   */
  liftable(t) { return isInt(t) || t === J_REAL || t === J_BOOL || jncIsPtr(t) || jncIsEnum(t) || isClass(t); }

  /**
   * `namespace a { … }` 摊平（第五十一刀）。命名空间在 jancy 那边只是**名字的作用域** ——
   * 它不生成任何东西，而且同名的可以重开、内容合并（`NamespaceMgr::openNamespace` 找得到
   * 就复用那一格）。摊成一串 `{ns, it}` 之后，重开与合并自然成立：两段都往同一个前缀底下
   * 登记。嵌套照原样接下去（`a` 里的 `b` 是 `a$b`）。
   */
  nsFlat(tree, ns, out) {
    for (const it0 of this.flat(tree)) {
      const it = unattr(it0);          // 属性收下不看（第一百〇八刀）
      if (isList(it) && (head(it) === 'import' || head(it) === 'import-as')) {
        this.impAdd(it);
        continue;
      }
      /* `dylib X { … }`（第二百〇三刀）：jancy 里它是"一个动态库里那些函数的声明表"——
         块里全是**只有原型**的函数，体在那个库里，调用点写 `X.f(…)`（那个名字只是一层
         命名空间）。语料里的原样是 `dylib JLinkLib { int stdcall JLINK_GetSN(); … }`
         （io_JLink.jnc:208）。
         这一层的落法：与 `namespace` 一样摊平，于是块里那些原型走的正是第一百八十五刀
         那条路（只有原型的顶层函数 -> `(cabi …)` + `(ccall …)`）。**只差符号名**：
         jancy 是按**成员名**去那个库里查符号的（`JLINK_GetSN`，不带块名），所以那一格
         记成 `sym`，不走"全名把 `$` 换成 `_`"那条默认规则。
         `stdcall` 那个词照旧忽略 —— 方言的目标是 arm64 与 x86-64，那上面它与 cdecl
         本来就是同一套 ABI（见 specs 那一处的注）。 */
      if (isList(it) && head(it) === 'dylib') {
        const dn = this.qname(it.items[1]);
        if (dn === null) { this.err(it, '认不出的 dylib 名字'); continue; }
        const dk = dn.replace(/\./g, '$');
        const dfull = ns === '' ? dk : `${ns}$${dk}`;
        this.dylibNs.add(dfull);
        this.nsFlat(it.items[2], dfull, out);
        continue;
      }
      if (isList(it) && head(it) === 'namespace') {
        const nm = this.qname(it.items[1]);
        if (nm === null) { this.err(it, '认不出的命名空间名字'); continue; }
        const k = nm.replace(/\./g, '$');
        const full = ns === '' ? k : `${ns}$${k}`;
        // 名字记一格（第二百一十七刀）：`using namespace X;` 要先认出 X 是一层命名空间。
        // 嵌套写法 `namespace a.b { … }` 的每一层都记（`a` 与 `a$b`）—— jancy 那边它们
        // 各是一格 Namespace（openNamespace 一层一层开）。
        let at = ns;
        for (const part of k.split('$')) {
          at = at === '' ? part : `${at}$${part}`;
          this.nsNames.add(at);
        }
        this.nsFlat(it.items[2], full, out);
        continue;
      }
      out.push({ ns, it });
      // 类体里的方法与嵌套类型**提到顶层**（第五十二刀），见 aggHoist。
      if (isList(it) && head(it) === 'type-decl' && isHoistAgg(it.items[1])) {
        this.aggHoist(it.items[1], ns, out);
      }
    }
    return out;
  }

  /**
   * 类体里的方法与嵌套类型提到顶层（第五十二刀）。**类同时是一层命名空间**
   * （jancy 的 `ClassType` 派生自 `Namespace`），而"体内写"与"体外写"（`void C.foo() {}`）
   * 在它那边是同一件事、任选其一（type_class.rst:41-59）。所以体内那些当成"命名空间是这个
   * 类"的顶层条目摊出来 —— 名字于是与体外写法落在同一格（`C$foo`），签名那一遍与函数体
   * 那一遍都不用再认"我在类里面"。嵌套类型走的是同一条（`class C { struct S {…} }` 里的 S
   * 就是 `C.S`，与第五十一刀里 namespace 中的类型一模一样）。
   */
  aggHoist(agg, ns, out) {
    const cn = this.qname(agg.items[2]);
    if (cn === null) return;                          // 名字认不出来，那一遍会报
    const k = cn.replace(/\./g, '$');
    const inner = ns === '' ? k : `${ns}$${k}`;
    /* 基类那一层的名字表（第一百三十七刀）：`class D0: B0 { X m_v; }` 里那个 `X` 可能是
       **基类的成员 typedef**（`class B0 { typedef int X; }`）。查名要走得上去，而这一表必须在
       **这一遍**记 —— `this.bases` 是 typeDecl 那一遍才填的，而 typedef 与类型名那两遍都排在
       typeDecl 之前，那时问 `this.bases` 什么都没有。
       记的是**源码里写的**基类名字加当时那一层命名空间：解成全名要等类都登记上，所以那一步
       留到查名的时候做（见 baseResolve）。 */
    const bns = [];
    for (const b of this.flat(agg.items[3])) {
      const bn = this.qname(b);
      if (bn !== null) bns.push(bn);
    }
    if (bns.length > 0) this.aggBases.set(inner, { ns, names: bns });
    for (const m0 of this.flat(agg.items[4])) {
      const m = unattr(m0);            // 属性收下不看（第一百〇八刀）
      if (!isList(m)) continue;
      const h = head(m);
      // 特殊成员里 `construct` 与 `static construct` **也提**（第五十三刀）：它们与普通方法
      // 一样就是"类那一层里的一格函数"，只是名字由 fnSig0 拼成 `C$construct`，而体外写法
      //（`C.construct() { … }`）本来就是顶层的一条 —— 两条路于是又落在同一格上。
      // 属性的取/存从第六十九刀起也在提上去的那一批里：写在类体里的 `int p.get() { … }`
      //（test42.jnc:27）与写在类外的 `int C.p.get() { … }`（test150.jnc:16）同理是一格函数，
      // 名字由 propSig 拼成 `C$p$get`。**名字得写在前面** —— 裸写的 `get` 是下标运算符
      //（见 accessorNamed）。剩下那些（`destruct`）不提，由 typeDecl 就地报。
      /* 结构体那一侧（第一百〇一刀）只提**方法**：`construct` / `destruct` 与嵌套类型都由
         typeDecl 就地报（那儿的话更准），提上来只会让同一件事报两遍。 */
      const isCls = isClassAgg(agg);
      if (h === 'fn-def') {
        const sk = specialCore(m.items[2]);
        /* `construct` 从第一百二十九刀起**结构体那一侧也提** —— 它与普通方法落法一样
           （一个自由函数、`this` 当第一个形参），只是名字由 fnSig0 拼成 `S$construct`。
           `static construct` 仍旧只在类那一侧：那一格要一道 once 闸门，是另一笔账。 */
        if (sk === null || accessorNamed(m.items[2]) || bareAccessor(m.items[2])
          || sk === 'construct' || isOpSpecial(sk)
          || (isCls && sk === 'static construct')) {
          out.push({ ns: inner, it: m });
        }
        continue;
      }
      /* 嵌套类型**结构体那一侧也提**（第二百三十刀）：jancy 的 `StructType` 与 `ClassType` 一样
         派生自 `Namespace`（type_struct.rst 的 Methods / Nested types 那两节），方法从第一百〇一刀
         起、typedef 从第一百二十四刀起就都提了 —— 嵌套类型是同一条，只是先前欠着。语料里的原样是
         `struct OutputReport { enum { ReportSize = 32 } … uchar_t m_padding[ReportSize - 1]; }`
         （test/ioninja/samples/ErgoDox/ErgoDoxHid.jnc:51-66）。
         **匿名 union 不提**：它不是"一格嵌套类型"，是这张字段表里几格共用一个偏移的写法
         （第一百一十刀），由结构体那一遍就地摊平。 */
      if (h === 'type-decl' && (isCls || !isAnonUnionAgg(m.items[1]))) {
        out.push({ ns: inner, it: m });
        if (isHoistAgg(m.items[1])) this.aggHoist(m.items[1], inner, out);
      }
      /* 类体里的 `typedef`（第一百〇六刀）：与嵌套类型走同一条路 —— 提到顶层那一批里，
         命名空间是这个类，于是 typedefDecl 里那句 `qual(info.name)` 拼出来的正是
         `C$Name`，类体内外查名都对得上。语料里最要紧的一格是**函数类型**的：
         `typedef string_t FormatFunc(uint64_t value);`（ui_InformationGrid.jnc:52），
         紧接着下一行就是 `FormatFunc* m_formatFunc;`。
         **结构体那一侧也提**（第一百二十四刀）：这一格与第一百〇一刀那个决定不冲突 ——
         那一条说的是 `construct` / `destruct` / 嵌套类型"提上来会报两遍"，而 typedef 不报，
         它只是**起一个名字**；结构体的名字早就是一层命名空间了（方法从第一百〇一刀起就提在
         `S$m` 上）。语料里是 `struct RbTreeNodeBase { typedef P EntryPtr; … }`
         （stdt_RbTree.jnc:20）那一族。 */
      if (h === 'typedef') out.push({ ns: inner, it: m });
    }
  }

  /**
   * 三遍走顶层（第十一刀）。jancy 的命名空间成员**不看声明顺序** —— 所以命名类型与模块级
   * 变量都得在函数体降级之前就成型，不然 `int f() { return g; }` 写在 `int g = 1;` 上面
   * 就会报"未声明"，而 jancy 那边它是对的。
   *
   * 第三遍里函数仍然是**按源码顺序**降的，所以"调用后面定义的函数"照旧不收 —— 那一条
   * 与这一刀无关，单独记在上面那份名单里。
   *
   * 每一遍都先把 `this.ns` 摆到那一条所在的命名空间上（第五十一刀）：登记用 `qual`、
   * 查名用 `resolve`，两边看的都是这一格。
   */
  run(tree) {
    let items = this.nsFlat(tree, '', []);
    // 扩展库那几份**隐式 import**（第一百九十九刀）：排在自己写的那些 import 前头，
    // 因为 jancy 那边它们是"模块一开张就在"的（见 libImports）。
    this.libImports(tree);
    // 被 import 的文件在这儿续到同一份名单后面（第六十刀）—— 一定要**在下面那些遍之前**：
    // 它们的类型名、签名、模块级变量与这个文件的是平权的一堆，不是"外面的库"。
    this.impDrain(items);
    // 完整声明式的属性改写成简单声明式加两个函数（第七十五刀）—— 排在最前面：底下每一遍
    // 看的都是改写之后的名单，属性那一整套一个字都不用动。
    items = this.expandFullProps(items);
    /* 泛型的单态化（ADR-0025 的 S2/S3）排在这儿：泛型声明**不能让下面那一遍 typeName 看见**
       （它不产出类型），而它合成出来的那些实例底下每一遍都要看见。与 expandExtensions
       正好是一对（那一个要查得着目标类型，所以在 typeName 之后）。 */
    items = this.expandTemplates(items);
    /* 顶层的 pragma（第二百一十六刀）排在这儿：它按**声明序**改后面那些声明的编译配置，
       而 `ExposedEnums` 管的正是"枚举的成员往哪一层登记"—— 所以必须在 typeName 之前。 */
    this.pragmaScan(items);
    /* `using namespace X;`（第二百一十七刀）与 pragma 同一处理由排在这儿：`using namespace
       stdt;` 之后那些声明里写的是 `Array<int>` 这种裸名字，类型名那一遍就要认得。 */
    this.usingScan(items);
    // 类型的名字先坐下（第十七刀）：`Node* m_next` 要在自己的体里查得着 Node。
    for (const e of items) {
      this.ns = e.ns;
      if (isList(e.it) && head(e.it) === 'type-decl') this.typeName(e.it.items[1]);
    }
    /* `extension T: Base { … }`（第一百〇七刀）排在这儿：它要**查得着目标类型**，所以必须在
       名字坐下之后；而它摊出来的那些条目底下每一遍都要看见，所以又必须在体、签名之前。 */
    items = this.expandExtensions(items);
    /* 完整声明式的属性**再来一遍**（第一百五十九刀）：泛型摊出来的那些实例（expandTemplates）
       与 `extension T: Base { … }` 摊出来的那些成员（就上面这一句）里也有属性，而它们是在上面
       那一遍之后才出现的 —— 语料里最常见的一格是
       `extension HidUsagePageEnumStrings: HidUsagePage { string_t const property m_enumString { return …; } }`
       （src/jnc_ext/jnc_io_hid/jnc/io_HidDb.jnc:35）。改写过的那些落不到这一遍上：取/存两个
       函数的名字是 `qualified-special`，`fullProp` 头一句 `qname(core)` 就回 null。 */
    items = this.expandFullProps(items);

    // typedef 排在"结构体的名字坐下"之后、"结构体的体解出来"之前（第三十八刀）：这样别名可以
    // 引结构体的名字，结构体的字段也可以用别名。
    for (const e of items) {
      this.ns = e.ns;
      if (isList(e.it) && head(e.it) === 'typedef') this.typedefDecl(e.it);
      /* 顶层的 alias（第八十七刀）排在同一遍里、同一条理由：它起的名字后面的声明要用得上。
         `alias` 在语法里是一格 var-decl，所以先问一句 specs 里有没有它。 */
      else if (isList(e.it) && head(e.it) === 'var-decl' && this.hasMod(e.it.items[1], 'alias')) {
        for (const d of this.flat(e.it.items[2])) this.aliasDecl(d, null);
      }
    }
    /* 枚举的体排在结构体 / 类的体**之前**（第二百二十九刀）：字段的数组长度可以是一格枚举成员
       （`ui.Action* m_actionTable[ActionId._Count]`，ioninja 那一族每份三行、榜上 47 处）。
       那个枚举嵌在同一个类的体里，而嵌套类型是**跟在**外层那一格后面提上来的（aggHoist），
       于是先前这一遍轮到类的字段时它的成员表还是空的 —— 报出来的"数组长度不是能在编译期算出来
       的整数"是**认错人**：算得出来，只是问早了。jancy 那边这件事由 `ensureLayout` 按需拉起
       （`ArrayType::calcLayout` 先 `parseConstIntegerExpression`，jnc_ct_ArrayType.cpp:175），
       这一层没有那套按需机制，就把两遍分开排 —— 枚举成员的值算不到结构体的布局上去
       （能进 constInt 的只有字面量、别的枚举成员与常量折叠），所以这个次序是稳的。 */
    const isEnumDecl = (e) => isList(e.it) && head(e.it) === 'type-decl'
      && isList(e.it.items[1]) && head(e.it.items[1]) === 'enum';
    for (const e of items) {
      this.ns = e.ns;
      if (isEnumDecl(e)) this.typeDecl(e.it.items[1]);
    }
    /* 枚举成员的值算不出来的那几格再来几轮（第一百四十一刀）：初值引用**后面才声明的**枚举时
       上面那一遍必然算不出来（那时它的成员表还没填）。一轮解开一层，跑到不动点；一轮下来一格
       都没解开就说明剩下的是真的算不出来（或者引用成环），那时再走一遍、这回报出来。
       轮数天然有界：每一轮要么少一格，要么就是最后那一遍。 */
    for (;;) {
      const todo = this.enumTodo;
      if (todo.length === 0) break;
      this.enumTodo = [];
      for (const t of todo) { this.ns = t.ns; this.enumDecl(t.n); }
      if (this.enumTodo.length === 0) break;
      if (this.enumTodo.length >= todo.length) {
        this.enumRetry = true;
        const rest = this.enumTodo;
        this.enumTodo = [];
        for (const t of rest) { this.ns = t.ns; this.enumDecl(t.n); }
        this.enumRetry = false;
        break;
      }
    }
    // 结构体 / 类的体（上面那段注说了为什么排在枚举之后，第二百二十九刀）
    for (const e of items) {
      this.ns = e.ns;
      if (isList(e.it) && head(e.it) === 'type-decl' && !isEnumDecl(e)) {
        this.typeDecl(e.it.items[1]);
      }
    }
    // 属性的名字先坐下（第六十八刀）：取/存两个函数的签名要抄它的类型，而那两个函数在
    // 下面那一遍里就得成型 —— 模块级变量那一遍（globalDecl）排在签名之后，来不及。
    //
    // 这两遍排在 classLayout **之前**（第七十一刀挪上来的）：`autoget` 的成员属性要往类里
    // 加一格字段，而那一格得赶在"整条链的结构体发出去"之前进 ownFields。往上挪是安全的 ——
    // 这两遍只查名字（类名在 typeName 那一遍就坐下了）、不发一行 decls。
    for (const e of items) {
      if (!isList(e.it) || head(e.it) !== 'var-decl') continue;
      if (!this.propMod(e.it.items[1], e.it.items[2])) continue;
      this.ns = e.ns;
      this.propName(e.it);
    }
    // 类体里那些成员属性（第六十九刀）：上面那一遍（typeDecl）把它们攒在 propPend 里，登记
    // 走的是同一份代码 —— 那时 `ns` 是类名，于是 `qual` 拼出来就是 `C$p`。
    for (const e of this.propPend) {
      this.ns = e.ns;
      this.propName(e.it);
    }
    // 类的那几格结构体在这儿才发（第五十六刀）：一整条继承链共用一格，而"谁派生了我"要等
    // 所有 type-decl 都过完才知道。排在签名那一遍之前 —— 方法的形参里有类指针。
    this.classLayout();
    /* reactor 的体（第八十五刀）：语法上它是一格 fn-def，所以要在签名那一遍**之前**把它
       挑出来 —— 不然会被登记成一格返回 void 的函数。挑出来的记在 rctBodies 上，下面两遍
       （签名、topItem）都跳过它。 */
    const rctBodies = new Set();
    for (const e of items) {
      if (!isList(e.it) || head(e.it) !== 'fn-def') continue;
      this.ns = e.ns;
      if (this.reactorBody(e.it)) rctBodies.add(e.it);
    }
    // 签名先过一遍（第十五刀）：jancy 的命名空间不看顺序，所以"后面定义的函数"要在
    // 模块级变量的初值与所有函数体之前就查得着。
    for (const e of items) {
      if (!isList(e.it) || head(e.it) !== 'fn-def' || rctBodies.has(e.it)) continue;
      this.ns = e.ns;
      const s = this.fnSig(e.it);
      if (s !== null) this.sigs.set(e.it, s);
    }
    /* 原型上那几格默认值并进签名（第一百刀）：签名这一遍看的是**定义**，而"类里写原型、
       体写在类外"那种放法里默认值只出现在原型上。 */
    this.mergeProtoDefs();
    // `override` 那几条规矩（第五十七刀）：基类的方法这时才都在表里。
    this.vtCheck();
    /* 目标是函数 / 方法的那些 alias（第八十七刀）：签名这时候才全在表里。 */
    this.emitAliases();
    // 静态构造那道闸门（第五十三刀）。jancy 的静态构造是**从实例构造的开头调的、只调一次**
    // （`Parser::finalizeConstructor` 那四句里的第二句 `callStaticConstructor`，
    // jnc_ct_Parser.cpp:3005-3009；"只一次"是 `MemberBlock::callStaticConstructor` 里
    // 那个 `ModuleItemFlag_Constructed` 标志）—— 落法就是一格模块级的 bool 加一道 `if`。
    // 类**只有**静态构造、没有实例构造时 jancy 自己会合成一个（`DerivableType::
    // createDefaultMethods`），不然那段代码永远跑不着；这儿照做。
    for (const cls of this.sctors.keys()) {
      const gate = `${cls}$construct$static$1`;
      this.decls.push(`  (global ${gate} bool)`);
      this.gates.set(cls, gate);
      if (this.ctors.has(cls)) continue;
      const full = `${cls}$construct`;
      const self = tClass(cls, false);
      this.fns.set(full, { params: [self], ret: J_VOID });
      this.methods.set(full, cls);
      this.ctors.set(cls, { name: full, params: [], synth: true });
      this.synthSC.add(cls);
      /* 这个类还带着字段默认值或者事件（第七十八 / 八十三刀）：那就把体交给
         emitFieldInitCtors —— 它会先发闸门那几行、再建事件的单子、再发字段初值。
         两处各发一格 `(fn C$construct …)` 就重名了。 */
      if (this.fieldInits.has(cls) || this.evtFields.has(cls)
        || this.embFields.has(cls)) { this.synthFI.add(cls); continue; }
      this.decls.push(`  (fn ${full} (($this ${slotText(self)})) void\n`
        + `${this.gateLines(cls, '    ').join('\n')})`);
    }
    // 派生类没写 construct（第五十六刀）。jancy 那边合成的那一个要**把基类的构造调一遍**
    // （`DerivableType::createDefaultMethods` 里 `createDefaultConstructor` 的那条链），
    // 不合成就等于 `D d;` 悄悄跳过了基类的构造 —— 那是骗人。按深度从上往下走，所以基类
    // 那一个（可能也是合成的）已经在表里了。
    this.synthCtors();
    /* 结构体那一侧的合成构造（第一百二十九刀）：自己没写 construct、可字段里有带构造的结构体时
       给它合成一个 —— 排在 synthCtors 之后、函数体那一遍之前（体那一遍要按 ctors 发那几句）。 */
    this.synthStructCtors();
    // `&` 过谁先数一遍（第二十四刀）：模块级的标量被取过地址时，那一格要提到一段**自己的
    // 内存**里去（与第九刀对局部量做的是同一件事）。这一问必须在 `(global …)` 发出去之前
    // 答完 —— 而 `&g` 出现在函数体里，也就是后面那一遍。数的是整份源码里所有 `&名字`，
    // 所以同名的局部量会把全局也带上：**多提一格不影响语义**（读写照旧走那一格），只是多一次 pnew。
    for (const e of items) this.collectAddrTaken(e.it, this.gTaken);
    // `autoget` 那格生成的存储与合成的取值器（第七十一刀）。排在这儿是两件事凑到一起：
    // gTaken 刚数完 —— 顶层那一格要不要提到"自己的一段内存"里去，由源码里有没有 `&m_value`
    // 说（与第二十四刀对普通模块级变量的判定同一条）；而"取值器写没写"是上面签名那一遍答完的
    // （pi.get）—— 写了就用写的那个，没写才合成，那正是 prop_autoget.rst:17 的两半：
    // "access the data variable/field directly if possible, or automatically generate a getter"。
    for (const a of this.autoProps) {
      const pi = this.props.get(a.full);
      if (pi === undefined) continue;              // 属性那一格登记时就报过错了
      const g = `${a.full}$get`;
      if (a.cls === null) {
        /* `autoget alias` 那一种（第一百五十八刀）：那格存储是外层已经声明过的一格 ——
           这儿一个字都不发，只往下走去合成取值器。 */
        if (a.alias === true) {
          if (pi.get) continue;
          const rd0 = this.gLifted.has(a.name) ? `(pload (var ${a.name}))` : `(var ${a.name})`;
          this.decls.push(`  (fn ${g} () ${slotText(a.type)}\n    (ret ${rd0}))`);
          this.fns.set(g, { params: [], ret: a.type });
          pi.get = true;
          continue;
        }
        // 顶层的那一格就是一格模块级变量。`&` 数的是**源码里写的**名字，而源码里写的是
        // `m_value`（prop_autoget.rst:26），所以两个名字都问一遍 —— 与 declareGlobal 同。
        /* `variant_t` 那一格要**真开一段内存**（第一百七十八刀）：它的槽类型本来就是
           `(ptr jnc$variant)`（这一层的 variant 值是一格地址），不开一段就是个空指针，
           存值器里那句 `m_value = x` 当场空指针。与一格普通的顶层 `variant_t g;` 走的是
           同一条（declareGlobal 那儿也是 `(global …)` + globalCells 里一句 `pnew`）。 */
        if (isVar(a.type)) {
          const vt = slotText(a.type);
          this.decls.push(`  (global ${a.name} ${vt})`);
          this.globalCells.push(`    (set ${a.name} (pnew ${vt} (int 1)))`);
          if (!pi.get) {
            this.decls.push(`  (fn ${g} () ${vt}\n    (ret (var ${a.name})))`);
            this.fns.set(g, { params: [], ret: a.type });
            pi.get = true;
          }
          continue;
        }
        if ((this.gTaken.has(a.name) || this.gTaken.has('m_value')) && this.liftable(a.type)) {
          this.gLifted.add(a.name);
          const pt = `(ptr ${tyText(a.type)})`;
          this.decls.push(`  (global ${a.name} ${pt})`);
          this.globalCells.push(`    (set ${a.name} (pnew ${pt} (int 1)))`);
        } else {
          this.decls.push(`  (global ${a.name} ${slotText(a.type)})`);
        }
        /* 那格字段的就地初值（第一百八十刀）：与一格普通的 `int g = 5;` 走同一条
           （globalValue + globalInit）。排在这儿而不是下面 —— 下面那句 `if (pi.get) continue`
           管的是"取值器要不要发"，与初值没关系。 */
        if (a.init !== undefined && a.init !== null) {
          const iv = this.globalValue(a.init, a.type);
          if (iv !== null) {
            this.globalInit.push(this.gLifted.has(a.name)
              ? `    (pstore (var ${a.name}) ${iv})`
              : `    (set ${a.name} ${iv})`);
          }
        }
        if (pi.get) continue;
        const rd = this.gLifted.has(a.name) ? `(pload (var ${a.name}))` : `(var ${a.name})`;
        this.decls.push(`  (fn ${g} () ${slotText(a.type)}\n    (ret ${rd}))`);
        this.fns.set(g, { params: [], ret: a.type });
        pi.get = true;
        /* bindable data（第七十三刀后一半）：存值器也是编译器生成的 ——
         * `if (m_value != x) { m_value = x; m_onChanged(); }`
         * （`Property::compileAutoSetter`，jnc_ct_Property.cpp:788-822 那三句 getPropertyAutoGet
         * / BinOpKind_Ne / fireOnChanged）。那个 `!=` 就是"同值不通知"的出处，也是
         * samples/jnc/34_BindableProperties.jnc:128-129 那两句的判据。 */
        if (pi.bdata === true && !pi.set) {
          const s = `${a.full}$set`;
          const st = this.gLifted.has(a.name)
            ? `(pstore (var ${a.name}) (var x))` : `(set ${a.name} (var x))`;
          this.decls.push(`  (fn ${s} ((x ${slotText(a.type)})) void\n`
            + `    (if (bin "!=" ${rd} (var x)) (do\n`
            + `      ${st}\n`
            + `      (expr (call ${this.mcFire(J_MC)} (var ${pi.onch}))))))`);
          this.fns.set(s, { params: [a.type], ret: J_VOID });
          pi.set = true;
        }
        continue;
      }
      /* 体在宿主那边的那一种（第二百三十一刀）：`int autoget property m_minValue;` 写在一格
         成员**全都**只有声明的类里（ui_PropertyGrid.jnc:56 那一族）。jancy 的 `autoget` 只生成
         **取值器**（`PropertyFlag_AutoSet` 只给 `bindable T x;` 那种 bindable data ——
         jnc_ct_DeclTypeCalc.cpp:164 是唯一给它的地方），所以存值器的体一定写在别处
         （prop_simple.rst:29）。整个模块里都没有，那就是在宿主的 C/C++ 里 —— 与只有原型的方法
         （第一百八十三刀）同一句话。
         这时**取值器也要走宿主**：不然读的是这一层那格生成的存储，而写去了宿主，两边各说各话
         （jancy 那边靠 `JNC_MAP_AUTOGET_PROPERTY` 把字段的偏移登记给宿主，两边是同一块字节；
         这一层没有那套登记，于是让宿主自己拿着那格存储 —— 就是 opaque 那笔账）。
         所以这儿一个字都不合成，读与写都落到 hostProp 上去。
         那格已经进了 ownFields 的存储留着不用（几个字节的空位，不是错话）。
         `bindable` 的**不**走这条：宿主那边的存值器点不着这一层那格 `m_onChanged`，反应器绑上去
         就永远不响 —— 那是另一笔账，下面 propSet 那句话里说清。 */
      if (pi.bdata !== true && !this.fns.has(`${a.full}$set`)
        && (pi.onch === null || pi.onch === undefined)
        && this.classes.has(a.cls)) {
        continue;
      }
      // 成员的那一格已经跟着整条链那格结构体发出去了（propName 那一遍在 classLayout 之前往
      // ownFields 里加的），所以这儿只剩合成那两个函数。
      const self = tClass(a.cls, false);
      const ad = `(pfield (var $this) ${a.name})`;
      /* 取值器读出来的那一格：普通标量是 `(pload …)`，`variant_t` 是**那一格的地址本身**
         （第一百七十八刀 —— 这一层的 variant 值就是一格地址，第一百七十三刀那条）。 */
      const rdm = isVar(a.type) ? ad : `(pload ${ad})`;
      if (!pi.get) {
        this.decls.push(`  (fn ${g} (($this ${slotText(self)})) ${slotText(a.type)}\n`
          + `    (ret ${rdm}))`);
        this.fns.set(g, { params: [self], ret: a.type });
        this.methods.set(g, a.cls);
        pi.get = true;
      }
      /* 成员上的 bindable data（第八十四刀）：与顶层那一格同一个体，只是那两格生成物都在
         对象里 —— 存储是 `(pfield (var $this) …$m_value)`，通知的那格单子是
         `(pload (pfield (var $this) …$m_onChanged))`（第八十三刀那条路）。实参的顺序与
         propSet 发的那一句对上：对象在前、值在后。 */
      if (pi.bdata === true && !pi.set) {
        const s = `${a.full}$set`;
        this.decls.push(`  (fn ${s} (($this ${slotText(self)}) (x ${slotText(a.type)})) void\n`
          + `    (if (bin "!=" (pload ${ad}) (var x)) (do\n`
          + `      (pstore ${ad} (var x))\n`
          + `      (expr (call ${this.mcFire(J_MC)} `
          + `(pload (pfield (var $this) ${pi.onch})))))))`);
        this.fns.set(s, { params: [self, a.type], ret: J_VOID });
        this.methods.set(s, a.cls);
        pi.set = true;
      }
    }
    /* `bindable` 那格生成的事件（第七十三刀）：一格模块级的"函数值数组"，出来是空的。
     * 与 autoget 那一格不同，它**不用问 gTaken** —— 事件不是标量，`&m_onChanged` 在 jancy
     * 那边也取不到一格可算术的地址（那是个类引用）。 */
    for (const b of this.bindProps) {
      this.decls.push(`  (global ${b.name} ${tyText(J_MC)})`);
      this.globalCells.push(`    (set ${b.name} (anew ${tyText(J_MC)} (int 0)))`);
    }
    for (const e of items) {
      if (!isList(e.it)) continue;
      this.ns = e.ns;
      const h = head(e.it);
      if (h === 'var-decl') this.globalDecl(e.it);
      else if (h === 'var-decl-curly') this.globalDeclCurly(e.it);
    }
    for (const e of items) {
      if (isList(e.it)) {
        const h = head(e.it);
        if (h === 'type-decl' || h === 'var-decl' || h === 'var-decl-curly') continue;
        if (rctBodies.has(e.it)) continue;              // reactor 的体（第八十五刀）另走一处
      }
      this.ns = e.ns;
      this.topItem(e.it);
    }
    this.ns = '';
    /* 合成出来的那些 construct 的体（第七十八刀）。排在这儿而不是签名那一遍：字段初值里
       可以引用模块级变量与别的函数，那些到这一步才全登记完。 */
    this.emitFieldInitCtors();
    /* reactor 的那几段（第八十五刀）：同一条理由 —— 反应里能引用模块级变量、属性与函数。 */
    this.emitReactors();
    /* 两张 using 表里都有同一个名字（第二百一十七刀）：jancy 那边这是歧义，报出来。
       上面那一路先按第一张算了 —— 那不是"选一个"，是为了让别的诊断照常出来；这一句让整份
       源码照实报错，所以那个选择传不到产物里去。 */
    for (const [k, node] of this.usingAmbig) {
      this.err(node, `'${shown(k.replace(/\$/g, '.'))}' 在两层 using 的命名空间里都有 —— `
        + 'jancy 那边这是歧义（要写全名）');
    }
    // 没有 `main` 的那种源码（第六十五刀）。语料 662 份里 408 份是这种 —— 它们是**库模块**，
    // 本来就不该有入口（jancy 那边 `jancy foo.jnc` 找不到 main 才报错，可 `jnc_ct` 把它当
    // 模块编译是成立的）。所以"要不要入口"由**调用方**说：`omni sx` 只要一份降下来的文本，
    // 不要入口；五条腿要跑，那就必须有。
    if (this.mainBody === null && this.needEntry) {
      this.diags.error(null, 'jancy 的入口是 `int main()`，这份源码里没有');
      return '';
    }
    const parts = ['(module'];
    for (const d of this.decls) parts.push(d);
    // 模块级变量的初值跑在 main 的体**之前**：jancy 的 module.construct 就是这个顺序
    // （先把所有 static 零初始化，再按声明序跑各自的 initializer，然后才是用户代码）。
    // 零初始化那一半方言自己做（(global …) 出来就是零），这里发的是"要一段自己的内存"的
    // 那些 pnew（globalCells）加初值（globalInit）——**两阶段**，pnew 全排在初值之前
    // （第二十四刀）：初值里调的函数可能读到别的全局，那时候它该看见零，而不是空指针。
    const body = this.globalCells.length === 0 && this.globalInit.length === 0
      ? this.mainBody
      : `${[...this.globalCells, ...this.globalInit].join('\n')}\n${this.mainBody}`;
    // 库模块（没有 main）也发一格 `(main …)`：方言的整程序要它（sexpr/lower.js:779），
    // 而里头只剩模块级变量那段序幕 —— jancy 的 module.construct 对库模块也是要跑的。
    parts.push(`  (main\n${this.mainBody === null
      ? [...this.globalCells, ...this.globalInit].join('\n')
      : body})`);
    parts.push(')');
    return `${parts.join('\n')}\n`;
  }

  /* -------------------------------------------------------------- 顶层 */

  /**
   * 顶层的 `pragma(名字, 值)`（第二百一十六刀）。语料里 25 份文件、32 处，词只有三个：
   * `Alignment`（19 处）、`ExposedEnums`（4）、`ThinPointers`（2）。
   *
   * jancy 那儿一条 pragma 改的是**从这一句往后**那些声明的编译配置（`PragmaConfig`，
   * jnc_ct_PragmaMgr.cpp:47-90），所以它必须在**按声明序**走的一遍里收 —— 这一遍就是它。
   * 排在 typeName 之前：`ExposedEnums` 管的正是枚举的名字往哪一层登记。
   *
   * 逐词的账：
   *
   *   - `Alignment`（`pragma(Alignment, 1)`，io_SocketAddress.jnc:193 那一族的协议头）——
   *     它只动 `m_fieldAlignment`，也就是字段之间**填多少字节的空**
   *     （jnc_ct_PragmaMgr.cpp:69-78）。方言这一层没有字节布局：一格就是 8 个字节，
   *     字段之间本来就没有"空"这回事。所以**收下不看**，而且这不是"少做一件事"——
   *     能看出对齐差别的每一条路（`sizeof`、`offsetof`、`string_t.m_p`、按字节走的指针）
   *     这一层本来就全是拒的，所以忽略它**不可能**给出错答案。
   *     **代价明写**：哪天方言认了字节布局，这个词要跟 `sizeof` / `offsetof` 一起落。
   *   - `ExposedEnums`（`pragma(ExposedEnums, true)`，81_Enums.jnc:54）—— 它让后面那些
   *     **带名字的**枚举也把成员漏到外面那层（`EnumTypeFlag_Exposed` ->
   *     `exposeEnumConsts`，jnc_ct_Parser.cpp:2732-2734）。这一格这一层早就有：无名枚举
   *     就是这么做的（第九十六刀的 `exposedMems`）。所以这个词是**真落的**：把开着 pragma
   *     时声明的枚举节点记一笔，enumName / enumDecl 那两遍把它当"无名那一种"待。
   *   - `ThinPointers` —— 它把后面每一格 `*` 都当 `thin` 写（`m_pointerModifiers`，
   *     Declarator.llk:405）。收下不看**会给错答案**：thin 指针在这一层是一个字、fat 是
   *     三个字（ADR-0024），而"转成 thin 要写在 unsafe 里"那条界（第几刀那堵
   *     `bad/thin-outside-unsafe`）正是靠这个区别立的。所以照旧拦着，话说清。
   *   - `Regex*` 那九个 —— 它们配的是 regex switch 那台 DFA（第二百一十四刀那两条）。
   */
  pragmaScan(items) {
    const saveNs = this.ns;
    let exposed = false;
    for (const e of items) {
      const it = e.it;
      if (!isList(it)) continue;
      if (head(it) !== 'pragma') {
        if (exposed && head(it) === 'type-decl' && isList(it.items[1]) && head(it.items[1]) === 'enum') {
          this.exposedEnums.add(it.items[1]);
        }
        continue;
      }
      this.ns = e.ns;
      const args = this.flat(it.items[1]);
      const nm = args.length > 0 && isList(args[0]) && head(args[0]) === 'name' && isAtom(args[0].items[1])
        ? args[0].items[1].value : null;
      if (nm === null) { this.err(it, '认不出的 pragma 名字'); continue; }
      const v = args.length > 1 ? this.pragmaVal(args[1]) : { k: 'bool', v: true };
      if (nm === 'Alignment') continue;                   // 收下不看，理由见上面那段注
      if (nm === 'ExposedEnums') {
        if (v === null) { this.err(it, `pragma 'ExposedEnums' 的值认不出来（收 true / false / default）`); continue; }
        // `default` 那一格是"回到默认"，而 ExposedEnums 的默认是关着的
        // （PragmaConfig 的 m_enumFlags 一开张就是 0，jnc_ct_PragmaMgr.cpp:84-85）。
        exposed = v.k === 'default' ? false : v.v === true;
        continue;
      }
      if (nm === 'ThinPointers') {
        this.nope(it, "pragma 'ThinPointers' —— 它把后面每一格 `*` 都当 `thin` 写"
          + '（m_pointerModifiers，Declarator.llk:405）。收下不看会给错答案：thin 指针在这一层'
          + '是一个字、fat 是三个字（ADR-0024），"转成 thin 要写在 `unsafe { … }` 里"那条界'
          + '正是靠这个区别立的');
        continue;
      }
      if (nm.startsWith('Regex')) {
        this.nope(it, `pragma '${nm}' —— 它配的是 regex switch 那台 DFA，而那件事还没落下来`);
        continue;
      }
      this.nope(it, `pragma '${nm}'（这一层认得 Alignment 与 ExposedEnums）`);
    }
    this.ns = saveNs;
  }

  /** 一格 pragma 的实参：`default` / `true` / `false` / 一个整数。认不出来回 null。 */
  pragmaVal(v) {
    if (isAtom(v)) {
      const n = Number(v.value);
      return Number.isFinite(n) ? { k: 'num', v: n } : null;
    }
    if (!isList(v)) return null;
    const h = head(v);
    if (h === 'pragma-default') return { k: 'default' };
    if (h === 'true') return { k: 'bool', v: true };
    if (h === 'false') return { k: 'bool', v: false };
    return null;
  }

  topItem(item) {
    if (!isList(item)) return this.err(item, '认不出的顶层条目');
    const h = head(item);
    if (h === 'empty-stmt') return null;            // 光一个分号
    if (h === 'fn-def') return this.fnDef(item);
    if (h === 'typedef') return null;               // 已经在前面那一遍收过了（第三十八刀）
    if (h === 'pragma') return null;                // pragmaScan 那一遍收过了（第二百一十六刀）
    if (h === 'using-namespace') return null;       // usingScan 那一遍收过了（第二百一十七刀）
    return this.nope(item, `顶层的 '${h}'`);
  }

  /**
   * `typedef int myint;`（第三十八刀）。jancy 的 `typedef` 是个**存储类**
   * （DeclarationSpecifier.llk:83 那条动作就是 `$.m_storageKind = StorageKind_Typedef`），
   * 所以它后面跟的是普通的声明符串 —— `typedef int* pint, box[3];` 一次起两个名字，
   * 而指针与数组那几层照常由声明符带。
   *
   * 别名**不是新类型**：`myint` 与 `int` 同型，因为存进表里的就是解出来的那一格，
   * `sameTy` 看到的两边一模一样。
   */
  typedefDecl(item) {
    const sp = this.specs(item.items[1]);
    if (sp === null) return null;
    for (const d of this.flat(item.items[2])) {
      if (isList(d) && (head(d) === 'init' || head(d) === 'ref-init')) {
        this.err(d, 'typedef 上不能写初值');
        continue;
      }
      const info = this.declarator(d, sp);
      if (info === null) continue;
      /* 函数类型的 typedef（第八十二刀）：`typedef string_t FormatFunc(void const* p);` ——
       * 语料里这种名字一律当**函数指针**用（`FormatFunc* m_format;`）。
       * jancy 那边这条 typedef 起的是一格 `TypeKind_Function`（声明符上的函数后缀由
       * `DeclTypeCalc` 的 `getFunctionType` 接，jnc_ct_DeclTypeCalc.cpp:170-197），
       * 而函数类型的**变量**不成立，能用的只有 `F*`（getFunctionPtrType，同文件 674-685）。
       * 所以这儿存的是 fnty0 那一格，`*` 由 ptrsTy 加。 */
      if (info.formals !== null) {
        const ps = this.formalList(info.formals);
        if (ps === null) continue;
        const an0 = this.qual(info.name);
        if (INT_ALIASES.has(info.name) || this.structs.has(an0) || this.aliases.has(an0)) {
          this.err(d, `类型名 '${shown(an0)}' 重复定义`);
          continue;
        }
        this.aliases.set(an0, tFnTy(ps.map((p) => p.type), info.type));
        continue;
      }
      const an = this.qual(info.name);
      if (INT_ALIASES.has(info.name) || this.structs.has(an) || this.aliases.has(an)) {
        this.err(d, `类型名 '${shown(an)}' 重复定义`);
        continue;
      }
      this.aliases.set(an, info.type);
    }
    return null;
  }

  /**
   * `alias 名字 = 目标;`（第八十七刀）。jancy 那边 `alias` 与 `typedef` 同族，是**存储类**，
   * 一条 alias 就是"另起一个名字指同一格东西"。语料里 55 处，三种收、一种不收：
   *
   *   - 类型别名：`alias State = iox.SshChannel.State;`（SshChannelSession.jnc:24），
   *     顶层的 `alias ModbusStreamRoles = jnc.global.ModbusStreamRoles;`（ModbusDispatchCode.jnc:42）；
   *   - 方法别名：`alias dispose = close;`（test61.jnc:25、io_WebSocket.jnc:123）——
   *     那是 disposable 那个 duck-typed 模式的一半（disposable.rst 那句 "usually aliased to
   *     an actual release method such as close"）；`alias toString = getString;` 同一种；
   *   - **字段路径**别名：`alias m_head = m_list.m_head;`（stdt_Map.jnc:85）—— 还不收，
   *     那一格要的是"名字 -> 一串取字段"的重写，与前两种不是一回事。
   *
   * 语法上它是一格 `var-decl`，那一条 dcls 是 `(init (dcl … (name 别名)) 目标)`。
   *
   * 分两趟：类型那一支当场就办得了（类型名那一遍在前面），而**函数/方法**那一支要等签名
   * 那一遍过完才知道目标的签名 —— 那些先记在 aliasPend 上，由 emitAliases 收尾。
   */
  /** 方法上那格 `this` 的类型（第一百〇一刀 / 第一百〇二刀）：类是一条引用，结构体那一格里
   *  放的**本来就是地址**（第十二刀），所以直接用它自己。 */
  selfTy(o) {
    return this.classes.has(o) ? tClass(o, false) : { k: 'struct', name: o };
  }

  aliasDecl(d, cls, late = false) {
    if (!isList(d) || head(d) !== 'init') {
      this.nope(d, 'alias 那一句只收 `alias 名字 = 目标;`');
      return;
    }
    const dcl = d.items[1];
    const name = isList(dcl) ? this.qname(dcl.items[2]) : null;
    if (name === null || name.includes('.')) { this.err(d, 'alias 起的名字得是一个普通名字'); return; }
    const tgt = this.dotted(d.items[2]);
    if (tgt === null) { this.nope(d, 'alias 的目标只收一个名字或点串'); return; }
    const full = cls === null ? this.qual(name) : `${cls}$${name}`;
    // 目标是一格类型：与 typedef 起的名字落在同一张表里（别名不是新类型，见 typedefDecl）。
    const ty = this.typeOfName(tgt);
    if (ty !== null) {
      if (this.aliases.has(full) || this.structs.has(full)) {
        this.err(d, `类型名 '${shown(full)}' 重复定义`);
        return;
      }
      this.aliases.set(full, ty);
      return;
    }
    if (!late) { this.aliasPend.push({ cls, d, ns: this.ns }); return; }
    /* 目标是一格函数或方法：发一格**转手的**，签名照抄 —— 比"调用点查一张别名表"简单，
       而且虚方法、重载、当函数值用那几处一处都不用改。 */
    const m = cls === null
      ? this.resolve(tgt, (k) => this.fns.has(k) && !this.methods.has(k))
      : this.findMethod(cls, tgt);
    if (m !== null) {
      const sig = this.fns.get(m);
      if (this.fns.has(full)) { this.err(d, `'${shown(full)}' 声明了两次`); return; }
      const ps = cls === null ? sig.params : sig.params.slice(1);
      const decl = (cls === null ? [] : [`($this ${slotText(this.selfTy(cls))})`])
        .concat(ps.map((t, i) => `($a${i} ${slotText(t)})`)).join(' ');
      const as = ps.map((t, i) => ` (var $a${i})`).join('');
      const call = `(call ${m}${cls === null ? '' : ' (var $this)'}${as})`;
      this.decls.push(`  (fn ${full} (${decl}) ${slotText(sig.ret)}\n`
        + `    ${sig.ret === J_VOID ? `(expr ${call})` : `(ret ${call})`})`);
      this.fns.set(full, {
        params: cls === null ? [...ps] : [this.selfTy(cls), ...ps], ret: sig.ret,
      });
      // `obj.名字()` 那一处先按名字便宜地筛一次（methodNames，第五十五刀）—— 别名也要进那张表。
      if (cls !== null) { this.methods.set(full, cls); this.methodNames.add(name); }
      return;
    }
    /* 目标是这个类里一格**只有原型**的方法（第二百〇六刀）：体在宿主那边（第一百八十三刀），
       所以别名**不发转手函数** —— 把同一份签名按目标的符号名再登记一格就是了。语料里的原样是
       `alias dispose = hide;`（ui_Dialog.jnc:126 —— `hide` 是那个 `opaque class` 上只有原型的
       一格方法）。转手函数在这儿发不出来：那要一句 `(ccall …)`，而 `(ccall …)` 只有原生腿上
       才有（ADR-0014 的第 4 条决定），发了就把这份模块钉死在一条腿上。 */
    if (cls !== null && !tgt.includes('.')) {
      const hs = this.hostSigs.get(`${cls}$${tgt}`);
      if (hs !== undefined && hs.length > 0) {
        if (this.hostSigs.has(`${cls}$${name}`)) { this.err(d, `'${shown(full)}' 声明了两次`); return; }
        const hf = this.hostFns.get(name);
        if (hf === undefined) this.hostFns.set(name, new Set([cls]));
        else hf.add(cls);
        const base = cls.replace(/\$/g, '_');
        this.hostSigs.set(`${cls}$${name}`, hs.map((one, i) => ({
          ...one,
          sym: `${base}_${tgt}${i > 0 ? `_o${i + 1}` : ''}`,
        })));
        /* **不**进 methodNames：那张表是"这个名字是一格带体的方法"用的（第五十五刀），
           进了它 `d.dispose()` 会先落到 memberFn 那儿、报"Dlg 没有方法 'dispose'"——
           量出来的。宿主面那条路按 hostFns 认名字，那一格就够。 */
        return;
      }
    }
    /* 目标是一格**字段路径**（第一百〇四刀）：`alias m_head = m_list.m_head;`。逐段在字段表里
       解得开就记成一串取字段 —— `this.structs` 对类与结构体都有那张表，而类字段那一格里放的
       也是地址，所以叠 `pfield` 时不用管中间那一格是类还是结构体。 */
    if (cls !== null && tgt.includes('.')) {
      const path = [];
      let ty = { k: 'struct', name: cls };
      let ok = true;
      for (const s of tgt.split('.')) {
        const on = ty !== null && (ty.k === 'struct' || ty.k === 'class') ? ty.name : null;
        const fs = on === null ? undefined : this.structs.get(on);
        const f = fs === undefined ? undefined : fs.find((x) => x.name === s);
        if (f === undefined) { ok = false; break; }
        path.push(s);
        ty = f.type;
      }
      if (ok) { this.aliasPath.set(full, { path, type: ty }); return; }
    }
    this.nope(d, `alias '${name}' 的目标 '${tgt}'（收的是一格类型名、一格函数、这个类里的`
      + '一格方法、或者这个类 / 结构体里逐段解得开的一串字段）');
  }

  /** 那些要等签名的 alias（第八十七刀）：排在签名那一遍之后。 */
  emitAliases() {
    const saveNs = this.ns;
    for (const p of this.aliasPend) {
      this.ns = p.ns;
      this.aliasDecl(p.d, p.cls, true);
    }
    this.ns = saveNs;
  }

  /** 一个写出来的名字指的是哪一格类型（第八十七刀抽出来的，与 specs 里那一串同一条）。 */
  typeOfName(nm) {
    const c = this.resolve(nm, (k) => this.classes.has(k));
    if (c !== null) return tClass(c, true);
    const s = this.resolve(nm, (k) => this.structs.has(k));
    if (s !== null) return { k: 'struct', name: s };
    const e = this.resolve(nm, (k) => this.enums.has(k));
    if (e !== null) {
      const en = this.enums.get(e);
      return { k: 'enum', name: e, base: en.base, bits: en.bits === true };
    }
    const a = this.resolve(nm, (k) => this.aliases.has(k));
    if (a !== null) return this.aliases.get(a);
    return null;
  }

  /** 这张 mods 表里有这个词吗（第八十七刀）：与 propMod 同一个用途 —— 白问一次、不发诊断。 */
  hasMod(n, word) {
    if (!isList(n) || head(n) !== 'specs') return false;
    for (const m of [...this.flat(n.items[2]), ...this.flat(n.items[3])]) {
      if (isAtom(m) && m.value === word) return true;
    }
    return false;
  }

  /**
   * 这张 mods 表里有 `property` 吗（第六十八刀）。**不发一条诊断** —— 属性那一遍排在
   * 签名之前、而模块级变量那一遍在签名之后，两遍都要看同一条 var-decl，所以"是不是属性"
   * 这一问得先能白问一次。
   */
  propMod(n, dcls = null) {
    if (isList(n) && head(n) === 'specs') {
      for (const m of [...this.flat(n.items[2]), ...this.flat(n.items[3])]) {
        // 光写 `bindable` 也是一格属性（bindable data，第七十三刀）—— 那种写法整格由编译器
        // 生成，所以这一问要连它一起认，否则 globalDecl 会把它当一格普通的模块级变量。
        if (isAtom(m) && (m.value === 'property' || m.value === 'bindable')) return true;
      }
    }
    // 星号后面那一边（第七十二刀）：`Icon* property m_icon;` 的 property 在声明符里 ——
    // 那也是一格属性，见 tailMods 那处。所以这一问要把每个声明符的最后一组也过一遍。
    if (dcls !== null) {
      for (const d of this.flat(dcls)) {
        if (this.tailMods(d).includes('property')) return true;
      }
    }
    return false;
  }

  /** 造一格节点（第七十五刀改写属性时要）：span 借现成那一格，诊断照旧指得到源码上。 */
  mkL(span, ...items) { return { kind: 'list', items, span }; }

  /**
   * 声明符里那一串 `*` 的**最后一组**去掉几个词（第一百八十二刀）。
   *
   * 为什么要它：`void const* const property m_end { … }` 这一格里 `property` 落在**星号后面**
   * 那一组（`tailMods` 认的就是它，第七十二刀），而改写属性时 `keep()` 只洗了说明符表。
   * 不洗这一组的话，改写出来的那格 getter 的声明符上还留着 `property` —— 于是
   *   ① 第二遍 `expandFullProps`（第一百五十九刀）把它又认成一格完整声明式的属性；
   *   ② 最后由 `fnSig0` 报一句"完整声明式的属性（… 那对花括号开的是一层命名空间）"。
   * 榜上那 70 处就是它（判据 `jnc_DynamicLayout.jnc:91`）—— 也就是说那一行**不是**"这个特性
   * 没做"，是改写留下的一撮词把自己的产物又拦了一遍。
   *
   * 与 `ptrsTy` 的 `dropTail` 是同一条口径：最后一组的词已经被这条声明吃掉了，不该再当指针的
   * 修饰符看第二遍。体那一格在语法里是**左递归的一串**，所以拼新的一格要回到最里头那格表头
   * （与 `aggPropRw` 同一个坑）。
   */
  dropPropTail(ptrs, words) {
    const groups = this.flat(ptrs);
    if (groups.length === 0) return ptrs;
    let base = ptrs;
    while (isList(base) && head(base) !== null && head(base).endsWith('-add')) base = base.items[1];
    const h0 = isList(base) ? base.items[0] : this.mkA(ptrs.span, 'ptrs');
    const last = groups[groups.length - 1];
    /* 一组里的元素**自己可能还是一格列表**（`tailMods` / `ptrsTy` 都是 flat 两层才拿到那几个词），
       所以这儿也摊两层再筛，拼回去是"表头 + 那几个词"。 */
    const kept = this.flat(last).flatMap((m) => this.flat(m))
      .filter((x) => !(isAtom(x) && words.has(x.value)));
    const nl = isList(last)
      ? { kind: 'list', span: last.span, items: [last.items[0], ...kept] }
      : last;
    return {
      kind: 'list',
      span: ptrs.span,
      items: [h0, ...groups.slice(0, -1), nl],
    };
  }

  mkA(span, value) { return { kind: 'atom', value, span }; }

  /**
   * 完整声明式的属性（第七十五刀）→ **改写成**简单声明式加两个体外的函数。
   *
   * `property g_p { int get() { … } void set(int x) { … } }` 与
   *
   *     int property g_p;
   *     int g_p.get() { … }
   *     void g_p.set(int x) { … }
   *
   * 在 jancy 那边是同一件事：那对花括号开的是**一层命名空间**（prop_full.rst:15），取/存两个
   * 函数写在里面还是写在外面都行。所以这一刀不动属性那一整套（第六十八到七十二刀），只在名单
   * 成型之前做一次改写 —— 语料里 86 处 `property NAME { … }` 就是这个形状（`uint_t get() { … }`
   * 加 `void set(uint_t value) { … }`，UdpDispatch.jnc:11-29）。
   *
   * 改写不动的两种当场说清：体里写字段（`autoget int m_x;` 那半，prop_full.rst:34 那句
   * "implicitly makes property autoget"）、以及存值器的**重载**（`set(int)` 与 `set(double)`
   * 两个，要重载决议）。
   */
  /**
   * `extension T: Base { … }` 与 `using extension T;`（第一百〇七刀）。
   *
   * jancy 那边 extension 给一格**已有的类型**添成员（`extension ComboBoxHistory: ComboBox
   * { … }`，ui_History.jnc:16），要写 `using extension ui.ComboBoxHistory;` 才把那些名字引进
   * 当前作用域（语料里 40 份插件都写着这一句，SshChannelSession.jnc:18）。
   *
   * 落法与第五十二刀那条一模一样：**体里的方法就是"体外写的那个目标类型的成员"**。所以这儿
   * 只把它们摊成"命名空间 = 目标类型"的顶层条目 —— 名字于是拼成 `ui$ComboBox$addToHistory`，
   * `this` 那一格由 fnSig0 按 owner 挑，签名那一遍与函数体那一遍一个字都不用改。
   *
   * **记一笔偏差**：`using extension` 这一层**收下不看** —— extension 的方法一律直接长在目标
   * 类型上，不管有没有写那一句。jancy 那边不写就查不着。这是**放宽**（能编的更多），不是把
   * 答案算错；代价是"同名 extension 撞车"这一层看不见。语料里 46 份文件一共就一格 extension
   * 被引用，撞不上。
   *
   * 目标类型要查得着：所以这一遍排在 typeName 之后（run 里那处注释）。查不着、或者体里有方法
   * 以外的东西，当场说清。
   */
  expandExtensions(items) {
    const out = [];
    for (const e of items) {
      if (!isList(e.it)) { out.push(e); continue; }
      const h = head(e.it);
      if (h === 'using-extension') continue;               // 收下不看，见上面那段
      if (h !== 'extension') { out.push(e); continue; }
      this.ns = e.ns;
      const bs = this.flat(e.it.items[2]).map((b) => this.qname(b)).filter((x) => x !== null);
      if (bs.length !== 1) {
        this.nope(e.it, 'extension 后面那个目标类型（要正好一个）');
        continue;
      }
      const tgt = this.resolve(bs[0], (k) => this.classes.has(k) || this.structs.has(k));
      if (tgt === null) {
        this.err(e.it, `没有这个类型：'${bs[0]}'`);
        continue;
      }
      for (const m of this.flat(e.it.items[3])) {
        if (isList(m) && head(m) === 'fn-def') { out.push({ ns: tgt, it: m }); continue; }
        this.nope(m, 'extension 体里除带体的方法以外的成员');
      }
    }
    return out;
  }

  /**
   * 匿名 union 体里那几格成员（第一百一十刀）。只收**普通字段** —— 方法、嵌套类型、属性、
   * 默认值那些在 union 里都说不清"是谁的"（几格成员共用同一段字节）。
   *
   * 成员的类型只收整数 / 实数 / 布尔 / 枚举 / 另一个结构体：那几种的零值是全零位、旁边也没有
   * 别的表。指针（fat 是三个字）、string 与句柄（旁边挂着表，ADR-0024 / ADR-0026）重叠之后
   * 说不清那张表上的东西归谁 —— 与方言那一层 `(union …)` 划的界一字不差（ADR-0027）。
   *
   * `bs` 不是 null 时这一层的体是个**匿名 struct**（第一百一十二刀），位域可以并进来；
   * union 体**自己**那一层传 null —— 那儿每格成员都从偏移 0 起，"连着的几格挤一格存储"
   * 这句话在那儿不成立（jancy 的 UnionType 也不走 layoutBitField）。
   */
  unionMembers(ag, cls, owner, gidx, min = 2, bs = null) {
    const out = [];
    let sidx = 0;
    for (const m0 of this.flat(ag.items[4])) {
      const m = unattr(m0);
      if (isList(m) && head(m) === 'empty-stmt') continue;
      /* union 里再套一格**匿名 struct**（第一百一十一刀）：C 的老写法 —— 一格 union 里几组
         字段轮流用同一段字节（`io_win_DeviceMonitorNotify.jnc:175/184`）。落法：给那一组合成
         一格真结构体（名字 `<外层>$u<N>$s<M>`）当 union 的一格成员，再把它里头每一格的名字
         登记成"一串取字段"—— 就是第一百〇四刀那张 `aliasPath` 表（`hdr.m_a` ->
         `(pfield (pfield p $s0) m_a)`）。于是源码里直接写 `hdr.m_a` 照旧解得开。 */
      if (isList(m) && head(m) === 'type-decl') {
        const inner = m.items[1];
        const ik = isList(inner) && head(inner) === 'agg' && isAtom(inner.items[1])
          ? inner.items[1].value : null;
        const ianon = ik !== null && isList(inner.items[2]) && head(inner.items[2]) === 'anon';
        if (ik !== 'struct' || !ianon) {
          this.nope(m, 'union 体里除字段与匿名 struct 以外的成员');
          return null;
        }
        const ibs = { last: null };                 // 里头那一组自己的位域分组（第一百一十二刀）
        const sf = this.unionMembers(inner, cls, owner, gidx, 1, ibs);   // 里头那一组：一格也行
        if (sf === null) return null;
        const sname = `${owner}$u${gidx}$s${sidx}`;
        const mem = `$s${sidx}`;
        sidx += 1;
        /* 位域那几格**不是**这格结构体的字段（它们是某一格 `$b<N>` 里的几位），所以既不进
           this.structs、也不进发出去的那一句 —— 它们走 bitPath。 */
        const real = sf.filter((f) => f.bit === undefined);
        this.structs.set(sname, real);
        this.decls.push(`  (struct ${sname} ${real.map((f) => `(${f.name} ${fieldText(f.type)})`).join(' ')})`);
        for (const f of sf) {
          const key = `${owner}$${f.name}`;
          if (this.aliasPath.has(key) || this.bitPath.has(key)) {
            this.nope(m, `union 里两组都有 '${f.name}' —— 那两个名字在外层撞车了`);
            return null;
          }
          if (f.bit !== undefined) {
            // 外层写 `hdr.m_a` 时的那一串：先进这一组（`$s0`）、再落到存储那一格（`$b0`）
            this.bitPath.set(key, {
              path: [mem, f.bit.slot], type: f.type, off: f.bit.off, cnt: f.bit.cnt, bw: f.bit.bw,
            });
            // 里层那格结构体自己也认得它（`hdr.$s0` 这个名字源码里写不出来，可路子要通）
            this.bitPath.set(`${sname}$${f.name}`, {
              path: [f.bit.slot], type: f.type, off: f.bit.off, cnt: f.bit.cnt, bw: f.bit.bw,
            });
            this.bitAggs.add(sname);
            continue;
          }
          /* 匿名 struct 里的 bigendian 成员（第一百二十六刀）：路是两段（先进这一组、再落到
             字段那一格）。里层那格结构体自己也登记一份 —— 与位域那两句同一个理由：
             `hdr.$s0` 这个名字源码里写不出来，可路子要通。 */
          if (f.be !== undefined) {
            this.bePath.set(key, { path: [mem, f.name], type: f.type, w: f.be.w });
            this.bePath.set(`${sname}$${f.name}`, { path: [f.name], type: f.type, w: f.be.w });
            continue;
          }
          this.aliasPath.set(key, { path: [mem, f.name], type: f.type });
        }
        out.push({ name: mem, type: { k: 'struct', name: sname } });
        continue;
      }
      if (!isList(m) || head(m) !== 'var-decl') {
        this.nope(m, 'union 体里除字段与匿名 struct 以外的成员');
        return null;
      }
      const sp = this.specs(m.items[1], cls);
      if (sp === null) return null;
      for (const d of this.flat(m.items[2])) {
        const info = this.declarator(d, sp, m.items[1], cls, bs !== null);
        if (info === null) return null;
        const t = info.type;
        /* 这一组里的位域（第一百一十二刀）：`io_UsbTransfer.jnc:63-71` 那一格 —— 一格 union 里
           一半是整字节、另一半是同一段字节上的几位。存储那一格进 out（它是真字段），位域
           自己带着 `bit` 一起回给调用方去登记 bitPath。 */
        /* 判"是不是位域"要问**正面**（是个数），不能问 `!== null`（第一百一十七刀量出来的一个
           洞）：declarator 有三个出口，函数指针那一个与特殊成员那一个先前不带 `bits` 字段，
           于是 `undefined !== null` 成立 —— `int function* m_op(int, int)` 会被当成位域。
           三个出口现在都写了 `bits: null`，这一句再问正面，两头都堵上。 */
        if (typeof info.bits === 'number') {
          if (!isInt(t)) {
            this.nope(d, `位域 '${info.name}' 的类型是 ${tyName(t)}（位域只在整数上 ——`
              + ' jancy 那边它的宽度就是 `getSize() * 8`）');
            return null;
          }
          const sl = this.bitSlot(bs, out, t, info.bits, d);
          if (sl === null) return null;
          out.push({ name: info.name, type: t, bit: sl });
          continue;
        }
        if (!(isInt(t) || t === J_REAL || t === J_BOOL || jncIsEnum(t) || jncIsStruct(t))) {
          this.nope(d, `union 里的成员 '${info.name}'（只收整数 / 实数 / 布尔 / 枚举 /`
            + ' 另一个结构体 —— 指针、string 与数组那几种旁边还挂着表，重叠之后说不清归谁）');
          return null;
        }
        if (bs !== null) bs.last = null;      // 普通字段隔在中间就断开上一组位域
        /* union 里的 bigendian 成员（第一百二十六刀）：协议头那一族正是"同一段字节，一半按
           大端读、一半按字节看"。直接挂在这一层的名字上（union 的成员在外层那张字段表里是
           **摊平**的，所以路只有一段）；套在匿名 struct 里的那一种由上面那一支带着 `be`
           回给调用方，路是两段。 */
        if (sp.be === true) {
          const t1 = jncIsEnum(t) ? t.base : t;
          if (!isInt(t1) || (t1.w !== 16 && t1.w !== 32 && t1.w !== 64)) {
            this.nope(d, `bigendian 的字段 '${info.name}' 的类型是 ${tyName(t)}`
              + '（字节序只在 16 / 32 / 64 位的整数与枚举上说得清）');
            return null;
          }
          if (bs === null) this.bePath.set(`${owner}$${info.name}`, { path: [info.name], type: t, w: t1.w });
          out.push({ name: info.name, type: t, be: { w: t1.w } });
          continue;
        }
        out.push({ name: info.name, type: t });
      }
    }
    if (out.length < min) {
      this.nope(ag, 'union 里只有一格成员（一格就直接当字段写）');
      return null;
    }
    return out;
  }

  /**
   * 位域的**分组**（第一百一十二刀）。一句话：几格连着的、声明类型**一模一样**的位域挤在
   * 同一格存储里；挤不下（或者中间隔了个普通字段、或者换了个类型）就新开一格。
   *
   * 规矩逐条照 jancy 自己那一遍（`StructType::layoutBitField`，jnc_ct_StructType.cpp:346-399）：
   *   - `baseBitCount = 声明类型的字节数 * 8` —— 所以 `uint8_t` 那一组只有 8 位，写到第 9 位
   *     就新开一格。**位数超过它是错**（jancy 那句 "type of bit field too small for
   *     number of bits"）；
   *   - 能并进上一格的条件是三条同时成立：上一格也是位域、`getType()->isEqual()`（这一层就是
   *     sameTy —— 位宽与符号性都要一样）、并且 `lastBitOffset + bitCount <= baseBitCount`；
   *   - 并不进去就新开一格，位偏移从 0 起。
   * 大端那一支（`PtrTypeFlag_BigEndian`）不用管：`bigendian` 这个词在这一层是**拦着**的
   * （见 specs 那处第一百〇九刀的清单），所以带它的字段一格都到不了这儿。
   *
   * 存储那一格在方言里就是**一格普通的整数字段**（名字 `$b<N>`，源码里写不出来）。它的类型
   * 记成**无符号**的那一格：读要先逻辑右移，而 `int64` 那一格上有符号右移会把高位的别人家的
   * 位抹成符号位 —— 那是错答案。声明写的符号性在 bitPath 的 `type` 上，补符号位那一步用它。
   */
  bitSlot(bs, fields, st, cnt, node) {
    const w = st.w;
    if (cnt > w) {
      this.err(node, `位域要 ${cnt} 位，而 ${tyName(st)} 只有 ${w} 位（jancy 那句 `
        + '"type of bit field too small for number of bits"）');
      return null;
    }
    const lb = bs.last;
    if (lb !== null && sameTy(lb.type, st) && lb.next + cnt <= w) {
      const off = lb.next;
      lb.next += cnt;
      return { slot: lb.slot, off, cnt, bw: w };
    }
    const slot = `$b${fields.length}`;
    fields.push({ name: slot, type: mkInt(w, true) });
    bs.last = { slot, type: st, next: cnt };
    return { slot, off: 0, cnt, bw: w };
  }

  /**
   * 泛型（ADR-0025 的 S2 + S3）—— 单态化那一遍。
   *
   * 排在 `expandFullProps` 之后、"类型的名字先坐下"（typeName）之前：与第一百〇七刀的
   * `expandExtensions` 正好是一对 —— 那一个要**查得着**目标类型所以排在 typeName 之后，
   * 泛型声明**不能让 typeName 看见**（它不产出类型）所以排在之前。
   *
   * 两件事：
   *   A. 名字是 `tinst` 的 `type-decl` 摘出名单，记进 `this.templates`；
   *   B. 工作队列扫剩下的名单找 `tinst` 用点：每格用点换成一格普通的类型名
   *      （`Box$int`），同时按实参签名 memoise 地合成一格 `type-decl` 追加回名单 ——
   *      新加的那几格再扫一遍，跑到不动点（嵌套实例化靠这一步自然解开）。
   *
   * 替换只在 **type-spec 那一层**（ADR-0025 里定的判据）：实参只收不带 `*` 的一格
   * type-spec。带 `*` 的（`Array<Bucket*>`）与实参本身是一格实例化的（`Iterator<Node<int> >`）
   * 明说不收 —— 那两格各是一笔单独的账，混进来会变成静默的错答案。
   */
  expandTemplates(items) {
    const out = [];
    for (const e of items) {
      const it = unattr(e.it);
      const ag = isList(it) && head(it) === 'type-decl' ? it.items[1] : null;
      let nm = isList(ag) && head(ag) === 'agg' ? ag.items[2] : null;
      /* 泛型的 **typedef**（第一百二十三刀）：`typedef IteratorImpl<…> Iterator<T>;`
         —— 名字那一格是声明符里的 `tinst`。语料里 10 处（stdt_Iterator 4、stdt_Map 4、
         stdt_BoxList 2），全是"给一长串实例化起个短名字"。它与泛型的类走同一套记账，
         只是实例化那一步合成出来的是一条 typedef 而不是一格 type-decl。 */
      let td = null;
      if (nm === null && isList(it) && head(it) === 'typedef') {
        const ds = this.flat(it.items[2]);
        const core = ds.length === 1 && isList(ds[0]) ? ds[0].items[2] : null;
        if (isList(core) && head(core) === 'tinst') { nm = core; td = { it, dcl: ds[0] }; }
        else if (ds.length > 1 && ds.some((d) => isList(d) && isList(d.items[2]) && head(d.items[2]) === 'tinst')) {
          this.nope(it, '一条 typedef 里既有泛型的名字又有别的名字');
          continue;
        }
      }
      if (nm === null || !isList(nm) || head(nm) !== 'tinst') { out.push(e); continue; }
      const full = this.tmplName(e.ns, nm.items[1]);
      if (full === null) continue;
      const ps = this.tmplParams(nm.items[2]);
      if (ps === null) continue;
      if (this.templates.has(full)) { this.err(nm, `泛型 '${shown(full)}' 声明了两次`); continue; }
      this.templates.set(full, { full, ns: e.ns, params: ps, agg: ag, td, outer: [] });
    }
    /* A2：泛型的成员**写在体外**（第一百三十五刀）—— `T Box<T>.fetch() { … }`。
       声明符的核心是 `(qualified (tinst (name Box) …) fetch)`，最左那一格是 `tinst`。
       这样的条目先前**原样留在名单里**：里头那个 `T` 谁也没绑过，于是它照字面降了下去，
       报出来是一片"没有这个类型：'T'"（`--group std` 榜首 134 处里的大半）。
       改法与体内那些成员同一条：摘出来记在那格泛型上，等实例化的时候**跟着实例一起替换
       出来**（见 tinstOne 末尾那一段）。 */
    const rest = [];
    for (const e of out) {
      const tm = this.tmplOuter(e);
      if (tm === undefined) { rest.push(e); continue; }
      tm.outer.push(e.it);
    }
    out.length = 0;
    for (const e of rest) out.push(e);
    // B：工作队列。`i` 之前的都扫过了，合成出来的追加在后面，于是循环自然跑到不动点。
    // `tdepth` 是这一条**属于第几层实例**（顶层名单是 0）—— 递归的闸门看的就是它，见 tinstOne。
    // `done` 的那几条是 `tinstOne` 自己就地扫完了的（合成出来的那一格与它提上来的方法）：
    // 再扫一遍不会有新结果，只会把里头那句没解开的诊断**报第二遍**。
    for (let i = 0; i < out.length; i++) {
      if (out[i].done === true) continue;
      const d = out[i].tdepth ?? 0;
      out[i] = { ns: out[i].ns, tdepth: d, it: this.tinstRewrite(out[i].it, out[i].ns, out, d) };
    }
    return out;
  }

  /**
   * 这一条是**写在体外的泛型成员**吗（第一百三十五刀）：`T Box<T>.fetch() { … }` /
   * `void Box<T>.put(T v);`。是就回那格泛型的账本，不是回 undefined。
   *
   * 认法：声明符的核心是一串 `qualified`，一层层往左剥到底 —— 最左那一格是 `tinst`、
   * 而且那个名字在 `this.templates` 里，这一条就是那格泛型的成员。剥到底是因为
   * `Box<T>.Inner.f` 这种写法左边还能再套（语料里没有，可判据要写得住）。
   */
  tmplOuter(e) {
    const it = unattr(e.it);
    if (!isList(it)) return undefined;
    const h = head(it);
    if (h !== 'fn-def' && h !== 'fn-proto') return undefined;
    const dcl = it.items[2];
    if (!isList(dcl) || head(dcl) !== 'dcl') return undefined;
    let c = dcl.items[2];
    while (isList(c) && (head(c) === 'qualified' || head(c) === 'qualified-special')) c = c.items[1];
    if (!isList(c) || head(c) !== 'tinst') return undefined;
    const full = this.tmplName(e.ns, c.items[1]);
    return full === null ? undefined : this.templates.get(full);
  }

  /** 泛型的全名（声明那一处）：与别的类型名同一条 —— 命名空间用 `$` 连。 */
  tmplName(ns, q) {    const n = this.qname(q);
    if (n === null) return this.nope(q, '认不出的泛型名字');
    return ns === '' ? n : `${ns}$${n}`;
  }

  /**
   * 参数表：`<T, K, V>` 里那几格必须是**裸名字**（那就是参数）。回
   * `[{name, def}]` —— `def` 是默认类型那一格 `type-name`（第一百二十二刀），没写就是 null。
   *
   * 带默认值的必须**排在后面**（与 C++ / jancy 同一条）：不然"给了 2 个实参"落到哪几格上
   * 就没有唯一答案。
   */
  tmplParams(targs) {
    const out = [];
    let seenDef = false;
    for (const t of this.flat(targs)) {
      if (!isList(t) || head(t) !== 'targ') return this.nope(t, '认不出的泛型参数');
      const def = t.items[2] ?? null;
      if (def === null && seenDef) {
        this.err(t, '泛型的参数表里带默认类型的那几格必须排在后面');
        return null;
      }
      if (def !== null) seenDef = true;
      const sp = this.tmplSpec(t.items[1]);
      if (sp === null) return null;
      if (!isList(sp) || head(sp) !== 'name' || !isAtom(sp.items[1])) {
        return this.nope(t, '泛型的参数不是一个裸名字');
      }
      out.push({ name: sp.items[1].value, def });
    }
    return out.length === 0 ? this.nope(targs, '泛型的参数表是空的') : out;
  }

  /** 一格 `targ` 里那格 **type-spec**（ADR-0025 定的替换层次）。`*` 与修饰符那两格由 tinstOne 接。 */
  tmplSpec(tn, allowMods = false) {
    if (!isList(tn) || head(tn) !== 'type-name') return this.nope(tn, '认不出的泛型实参');
    const sp = tn.items[1];
    if (!isList(sp) || head(sp) !== 'specs') return this.nope(tn, '认不出的泛型实参');
    if (!allowMods && this.tmplMods(sp).length > 0) {
      // 参数表那一侧：`<T const>` 这种先不收 —— 参数名上挂修饰符的意思要单独想
      return this.nope(tn, '泛型的参数上带修饰符');
    }
    /* 实参本身是一格实例化（`Iter<Node<int> >`）也从这儿原样回去 —— 那一格 `tinst`
       由 `tinstOne` **先解里层**（第一百一十九刀）。参数表那一侧不受影响：`tmplParams`
       接着就要求这一格是裸名字。 */
    return sp.items[1];
  }

  /** 一格 `specs` 上那两格修饰符表里的词（`int const` -> `['const']`）。 */
  tmplMods(sp) {
    const out = [];
    for (const m of [...this.flat(sp.items[2]), ...this.flat(sp.items[3] ?? sp.items[2])]) {
      if (isAtom(m)) out.push(m.value);
      else if (isList(m) && isAtom(m.items[0])) out.push(m.items[0].value);
    }
    return out;
  }

  /** 一格 `(name X)`。 */
  tmplNameNode(v, span) {
    return { kind: 'list', span, items: [{ kind: 'atom', value: 'name', span }, { kind: 'atom', value: v, span }] };
  }

  /**
   * 给带 `*` 的实参起名字那一条（第一百二十刀）：合成
   * `typedef <spec><ptrs> <alias>;` —— 形状照解析出来的那一份抄
   * （`(typedef (specs …) (dcls (dcl (ptrs…) (name …) (suffixes) (no-ctor))))`）。
   * `specs` 上那两格修饰符表直接借实参那一处的（`tmplSpec` 已经查过它们是空的）。
   */
  tmplPtrDef(spec, tn, alias) {
    const sp = tn.span;
    const mk = (h, ...rest) => ({ kind: 'list', span: sp, items: [{ kind: 'atom', value: h, span: sp }, ...rest] });
    const specs0 = tn.items[1];
    const specs = mk('specs', spec, specs0.items[2], specs0.items[3] ?? specs0.items[2]);
    const dcl = mk('dcl', tn.items[2], this.tmplNameNode(alias, sp), mk('suffixes'), mk('no-ctor'));
    return mk('typedef', specs, mk('dcls', dcl));
  }

  /** 实参那格 type-spec 拼进实例名里的那一段。 */
  tmplKey(spec) {
    if (isAtom(spec)) return spec.value;
    const q = this.qname(spec);
    return q === null ? null : q.replace(/\$/g, '_');
  }

  /**
   * 把一格节点里所有**认得出的** `tinst` 换成普通类型名，顺手把要用到的实例合成出来
   * 追加进 `out`。回一格新节点（树是纯的 —— read.js 出来的节点上降级过程一个字段都不写，
   * 所以抄一份是完整的替换，见 ADR-0025）。
   */
  tinstRewrite(n, ns, out, depth = 0) {
    if (!isList(n)) return n;
    if (head(n) === 'tinst') {
      const inst = this.tinstOne(n, ns, out, depth);
      if (inst !== null) return { kind: 'list', span: n.span, items: [{ kind: 'atom', value: 'name', span: n.span }, { kind: 'atom', value: inst, span: n.span }] };
      // 认不出来（不是泛型、或者实参这一层不收）：原样留着，下游那句诊断会说清
      return n;
    }
    const items = n.items.map((x) => this.tinstRewrite(x, ns, out, depth));
    /* 一格也没换的时候**回原来那颗节点** —— 不是无谓的省事：类体里那格 `reactor` / `fn-def`
       与被 aggHoist 提到顶层的那一格是**同一个对象**，reactorBody 那一遍靠这条身份认领它
       （见第八十二刀）。无条件抄一份会把那条身份切断，报出来是"reactor 'Inl.m_r' 声明了两次"
       —— 泛型这一遍扫的是**每一个**文件，所以这一句护着的是所有不带泛型的写法。 */
    if (items.every((x, i) => x === n.items[i])) return n;
    return { kind: 'list', span: n.span, items };
  }

  /**
   * 一格用点：解出实例名，没造过就造一格 `type-decl` 追加进 out。回实例名或 null。
   *
   * `depth` 是**这一格是第几层实例**（顶层名单上的用点是 0）。实参本身是一格实例化
   * （`Iterator<Node<int> >`，第一百一十九刀）就在这儿**先解里层**：里层解出 `Node$int`，
   * 拿它当一格普通类型名替进去，外层的名字于是拼成 `Iterator$Node_int`。
   *
   * 闸门（`TMPL_DEPTH`）看的正是 `depth`：`struct L<T> { L<L<T> > m_v; }` 这种每实例化一层
   * 实参就长一层，光靠"同一份实参不重复造"停不下来 —— 名字每次都是新的。
   */
  tinstOne(n, ns, out, depth = 0) {
    const base = this.qname(n.items[1]);
    if (base === null) return null;
    const save = this.ns;
    this.ns = ns;
    const full = this.resolve(base, (k) => this.templates.has(k));
    this.ns = save;
    if (full === null) return null;
    if (depth > TMPL_DEPTH) {
      this.err(n, `泛型 '${shown(full)}' 套得太深（${TMPL_DEPTH} 层往上）—— 实例化停不下来`);
      return null;
    }
    const tm = this.templates.get(full);
    const specs = [];
    const keys = [];
    for (const t of this.flat(n.items[2])) {
      if (!isList(t) || head(t) !== 'targ') return null;
      const r = this.tinstArg(t.items[1], ns, out, depth);
      if (r === null) return null;
      specs.push(r.spec);
      keys.push(r.key);
    }
    /* 默认类型参数（第一百二十二刀）：给的实参不够时，拿声明处那几格默认 `targ` 补上。
       补的时候要用**已经绑定的**那几格替换 —— 语料里那两处正是
       `class HashTable<K, V, H, E = Eq<K> >`（stdt_HashTable.jnc:46）与
       `class RbTree<K, V, C = stdt.Lt<K> >`（stdt_RbTree.jnc:51）：默认值本身是一格
       **实例化**，而且引的是前面那一格参数。所以 map 得边填边长，然后把补出来的那一格
       当成一格普通实参走同一条路（`tinstArg` 里 tinst / `*` / 修饰符那三支都用得上）。 */
    const req = tm.params.filter((p) => p.def === null).length;
    if (specs.length < req || specs.length > tm.params.length) {
      const want = req === tm.params.length ? `${req}` : `${req}~${tm.params.length}`;
      this.err(n, `泛型 '${shown(full)}' 要 ${want} 个实参，这里给了 ${specs.length} 个`);
      return null;
    }
    const bound = new Map();
    for (let i = 0; i < specs.length; i++) bound.set(tm.params[i].name, specs[i]);
    for (let i = specs.length; i < tm.params.length; i++) {
      const r = this.tinstArg(this.tmplSubst(tm.params[i].def, bound), ns, out, depth);
      if (r === null) return null;
      specs.push(r.spec);
      keys.push(r.key);
      bound.set(tm.params[i].name, r.spec);
    }
    const inst = `${full}$${keys.join('$')}`;
    if (this.tmplInsts.has(inst)) return inst;
    this.tmplInsts.add(inst);
    // 这一格实例名往外退的时候直接跳回泛型声明处那一层（第一百三十二刀，见 resolve）
    this.instNs.set(inst, tm.ns);
    // 参数名 -> 实参那格 type-spec
    const map = new Map();
    for (let i = 0; i < tm.params.length; i++) map.set(tm.params[i].name, specs[i]);
    /* 泛型的 typedef（第一百二十三刀）：合成出来的是**一条 typedef**，不是一格 type-decl ——
       所以没有体、也不用 aggHoist。名字那一格换成实例名，别的（specs / ptrs / suffixes）
       替换完照抄；specs 里那一串 `IteratorImpl<…>` 由 tinstRewrite 接着解。 */
    if (tm.td !== null && tm.td !== undefined) {
      const sp1 = n.span;
      const mk = (h, ...rest) => ({ kind: 'list', span: sp1, items: [{ kind: 'atom', value: h, span: sp1 }, ...rest] });
      const d0 = tm.td.dcl;
      const td = mk('typedef', this.tmplSubst(tm.td.it.items[1], map),
        mk('dcls', mk('dcl', this.tmplSubst(d0.items[1], map), this.tmplNameNode(inst, sp1),
          this.tmplSubst(d0.items[3], map), d0.items[4])));
      out.push({ ns: '', done: true, it: this.tinstRewrite(td, tm.ns, out, depth + 1) });
      return inst;
    }
    const ag = this.tmplSubst(tm.agg, map);
    // 名字那一格换成实例名（`(tinst …)` -> `(name Box$int)`）
    const sp0 = ag.items[2].span;
    ag.items[2] = { kind: 'list', span: sp0, items: [{ kind: 'atom', value: 'name', span: sp0 }, { kind: 'atom', value: inst, span: sp0 }] };
    /* 合成那一格的命名空间取**空** —— 实例名里已经把泛型的命名空间连进去了（`stdt$Array$int`），
       再套一层就成了 `stdt$stdt$Array$int`。 */
    const at = out.length;
    const decl = this.tinstRewrite({ kind: 'list', span: ag.span, items: [{ kind: 'atom', value: 'type-decl', span: ag.span }, ag] }, tm.ns, out, depth + 1);
    out.push({ ns: '', tdepth: depth + 1, it: decl });
    /* 体里的方法要**跟着提到顶层**：手写的 `struct` / `class` 是在 run() 最开头那一遍
       （nsFlat -> aggHoist）提的，而这一格是那一遍之后才合成出来的，不补这一句它体里的
       `T get() { … }` 就没人认领 —— 报出来是"没有这个函数：'b.get'"。命名空间同上取空，
       aggHoist 自己会把实例名接成 `Box$int$get`。 */
    if (isHoistAgg(decl.items[1])) this.aggHoist(decl.items[1], '', out);
    /* 写在**体外**的那些成员（第一百三十五刀）：`T Box<T>.fetch() { … }` 与体内写的
       `T fetch() { … }` 在 jancy 那边是同一件事、任选其一（type_class.rst:41-59，第五十二刀
       就是按这一句办的）。所以这儿跟着实例一起替换出来一份 —— `tmplSubst` 把声明符里那格
       `(tinst Box (targ T))` 的 `T` 也换成实参，于是 `tinstRewrite` 自然把它解成**当前这格
       实例名**（`tmplInsts` 已经 memoise，不会重造），名字于是落成 `Box$int$fetch`，
       与 aggHoist 提上来的那一批一模一样。命名空间取空，同上。 */
    for (const o of tm.outer) {
      out.push({ ns: '', done: true, it: this.tinstRewrite(this.tmplSubst(o, map), tm.ns, out, depth + 1) });
    }
    // 这几条（合成的那一格 + 它提上来的方法）已经就地扫完了 —— 队列别再扫一遍，见 expandTemplates
    for (let k = at; k < out.length; k++) out[k].done = true;
    return inst;
  }

  /**
   * 一格实参（一颗 `type-name`）解成 `{spec, key}`：`spec` 是替换用的那格 type-spec，
   * `key` 是拼进实例名里的那一段。三支特殊形状都在这儿：
   *   - 实参本身是一格实例化（第一百一十九刀）—— 先解里层；
   *   - 实参带 `*`（第一百二十刀）、带修饰符（第一百二十一刀）—— 先给那一格类型起个名字。
   * 默认类型参数补出来的那一格走的也是这儿（第一百二十二刀）。
   */
  tinstArg(tn, ns, out, depth) {
    let sp = this.tmplSpec(tn, true);
    if (sp === null) return null;
    let key;
    if (isList(sp) && head(sp) === 'tinst') {
      const inner = this.tinstOne(sp, ns, out, depth + 1);
      if (inner === null) return null;
      key = inner.replace(/\$/g, '_');
      sp = this.tmplNameNode(inner, sp.span);
    } else {
      key = this.tmplKey(sp);
      if (key === null) return null;
      /* 实参写的是**一格泛型自己的名字、一个实参都没带**（`BinTreeNodeBase<RbTreeNode, K, V, …>`，
         stdt_RbTree.jnc:51）：jancy 那边这是"晚一点再绑"的写法（那个名字在实例化的上下文里
         指的是**外层正在造的那一格**）。这一层没有那条路，而按字面替进去会造出一格**按值套回
         自己**的结构体 —— 那就是第一百二十八刀量到的那个崩的来源。明说不收。 */
      if (isList(sp) && head(sp) === 'name') {
        const q = this.qname(sp);
        const save2 = this.ns;
        this.ns = ns;
        const isT = q !== null && this.resolve(q, (k) => this.templates.has(k)) !== null;
        this.ns = save2;
        if (isT) {
          return this.nope(tn, `泛型的实参 '${q}' 是一格泛型自己的名字、一个实参都没带`
            + '（jancy 那边它指"外层正在造的那一格"，这一层还没有那条路）');
        }
      }
    }
    /* 替换只在 type-spec 那一层 —— 所以带 `*` / 带修饰符的实参先合成一格
       `typedef Bucket* jnc$tp$Bucket_p;`（或 `typedef int const* jnc$tp$int_const_p;`），
       再拿这个名字替进去。语言里"给类型起名字"本来就是 typedef 那一格，不用新造机制；
       合成的那一条排在名单里，`run()` 的 typedef 那一遍（typeName 之后、typeDecl 之前）
       照常收它。修饰符要**记进名字** —— `Box<int const*>` 与 `Box<int*>` 不是同一个类型，
       名字不分开就成了静默的错答案。 */
    const np = isList(tn) ? this.flat(tn.items[2]).length : 0;
    const mods = isList(tn) && isList(tn.items[1]) ? this.tmplMods(tn.items[1]) : [];
    if (np > 0 || mods.length > 0) {
      /* 这个别名的名字**照用户写的那样拼**（`T*`、`int const*`）—— 内部名（`jnc$tp$…`）
         看着规矩，可它会**漏进诊断**：`stdt_Iterator.jnc:74` 那种泛型 typedef 里 `T` 是没绑上的，
         下游那句于是印成"没有这个类型：'jnc$tp$T_p'"，用户根本不认得那是什么。名字里带 `*`
         不碍事 —— typedef 名只活在这一层的名字表里，从不落进降出来的 .sx。
         实例名那一段仍然用 `_p` / `_const` 那套（那是要当标识符用的）。 */
      const alias = `${key}${mods.map((w) => ` ${w}`).join('')}${'*'.repeat(np)}`;
      key = `${key}${mods.map((w) => `_${w}`).join('')}${'_p'.repeat(np)}`;
      if (!this.tmplPtrs.has(alias)) {
        this.tmplPtrs.add(alias);
        out.push({ ns: '', done: true, it: this.tmplPtrDef(sp, tn, alias) });
      }
      sp = this.tmplNameNode(alias, tn.span);
    }
    return { spec: sp, key };
  }

  /** 抄一份、把 `(name 参数名)` 换成实参那格 type-spec。 */
  tmplSubst(n, map) {
    if (!isList(n)) return n;
    if (head(n) === 'name' && isAtom(n.items[1]) && map.has(n.items[1].value)) {
      return map.get(n.items[1].value);
    }
    return { kind: 'list', span: n.span, items: n.items.map((x) => this.tmplSubst(x, map)) };
  }

  /**
   * 完整声明式的属性改写（第七十五刀）。**两处都要换**（第一百五十八刀）：
   *
   * 写在**类体里**的那一格（`opaque class EnumProperty { property m_value { … } }`，
   * ui_PropertyGrid.jnc:78）在第五十二刀那一遍已经被 aggHoist 抄进了"提上来"这一批，可类
   * 自己那格体**没动** —— 而字段表、属性表、`propPend` 都是 typeDecl 顺着体走出来的。只换
   * 提上来那一批的话，类体里剩下的还是原来那格带体的属性，于是体里那格 `autoget` 字段被当成
   * 类的一格普通字段（报"`autoget` 只能写在属性上"），存值器又找不着属性（报"没有这个属性"）。
   *
   * 所以这一遍分三步：先把每一条改写好记成一张表；再顺着 type-decl 把类体里那一格换成改写出
   * 来的**那条简单声明式**（属性表由 typeDecl 那一遍从体里认）；最后按这张表出新的名单 ——
   * 类里那一格只留**取/存两个函数**（那一条声明已经在体里了，两处都留会报"声明了两次"）。
   */
  expandFullProps(items) {
    /* 兄弟成员那张表（第一百五十八刀）：`autoget alias m_value = m_classValue;` 要从**目标那格
       成员**抄类型（jancy 那边是 `setAutoGetValue(alias)` 到 `Property::finalize` 里
       `alias->getTargetItem()` 再 `item->getItemType()`，jnc_ct_Property.cpp:484-491、170），
       而这一遍排在最前面、类型一个都还没解出来 —— 所以抄的是**那格声明的说明符**。 */
    const sibs = new Map();
    for (const e of items) {
      const it = e.it;
      if (!isList(it) || head(it) !== 'type-decl') continue;
      const agg = it.items[1];
      if (!isList(agg) || !isList(agg.items[4])) continue;
      const ms = this.flat(agg.items[4]).map((x) => unattr(x));
      for (const m of ms) sibs.set(m, ms);
    }
    const rw = new Map();                 // 原来那格 fn-def -> 改写出来的那几条
    for (const e of items) {
      const it = e.it;
      if (!isList(it) || head(it) !== 'fn-def') continue;
      const dcl = it.items[2];
      if (!this.propMod(it.items[1]) && !this.tailMods(dcl).includes('property')) continue;
      // `this.qual()` 要当时那一层命名空间（体内那两格的名字要按全名记账）
      const saveNs = this.ns;
      this.ns = e.ns;
      const ex = this.fullProp(it, sibs.get(it) ?? items.map((x) => x.it));
      this.ns = saveNs;
      // 说不通的照原样留着：`fnSig0` 那条诊断照旧发，理由不会因为这一刀变模糊。
      if (ex !== null) rw.set(it, ex);
    }
    if (rw.size === 0) return items;
    /* 类体里那一格就地换掉。**倒着走**：嵌套的类型自己那一格 type-deel 在名单里排在外面
       那一格后头，倒着走于是外面那格拿得到已经换好的那一份。 */
    const nodeMap = new Map();            // 原来那格 type-decl -> 换好的那一格
    const inCls = new Set();              // 是类体里那一格（提上来这一批里只留两个函数）
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i].it;
      if (!isList(it) || head(it) !== 'type-decl') continue;
      const nn = this.aggPropRw(it, rw, nodeMap, inCls);
      if (nn !== it) nodeMap.set(it, nn);
    }
    const out = [];
    for (const e of items) {
      const it = e.it;
      const nn = nodeMap.get(it);
      if (nn !== undefined) { out.push({ ...e, it: nn }); continue; }
      const ex = rw.get(it);
      if (ex === undefined) { out.push(e); continue; }
      for (const x of ex) {
        if (inCls.has(it) && isList(x) && head(x) === 'var-decl') continue;
        out.push({ it: x, ns: e.ns });
      }
    }
    return out;
  }

  /**
   * 一格 type-decl 里那些完整声明式的属性就地换掉（第一百五十八刀）。原来那格**不动**（提
   * 上来那一批里还引着它、`rw` 那张表的键也是它），回的是一格新的 type-decl；一格都没换的
   * 回原来那格。
   */
  aggPropRw(td, rw, nodeMap, inCls) {
    const agg = td.items[1];
    if (!isList(agg) || !isList(agg.items[4])) return td;
    const ms = [];
    let hit = false;
    for (const m0 of this.flat(agg.items[4])) {
      const m = unattr(m0);
      const ex = rw.get(m);
      if (ex !== undefined) {
        hit = true;
        inCls.add(m);
        // 类体里留下的是**那条声明**（简单声明式的属性）；取/存两个函数走提上来那一批。
        for (const x of ex) if (isList(x) && head(x) === 'var-decl') ms.push(x);
        continue;
      }
      const nn = nodeMap.get(m);
      if (nn !== undefined) { hit = true; ms.push(nn); continue; }
      ms.push(m0);
    }
    if (!hit) return td;
    /* 体那一格在语法里是**左递归的一串**（`… -add` 那种，见 flat）：拼新的一格得回到最里头
       那一格的表头，不然 flat 只认得出头两条。 */
    const mems = agg.items[4];
    let base = mems;
    while (isList(base) && head(base) !== null && head(base).endsWith('-add')) base = base.items[1];
    const h0 = isList(base) ? base.items[0] : this.mkA(mems.span, 'members');
    const nb = { kind: 'list', span: mems.span, items: [h0, ...ms] };
    const na = { kind: 'list', span: agg.span, items: agg.items.map((x, i) => (i === 4 ? nb : x)) };
    return { kind: 'list', span: td.span, items: td.items.map((x, i) => (i === 1 ? na : x)) };
  }

  /** 一格完整声明式的属性 -> 三条（声明 + 取 + 存）。**报过错的回空表**（那一条就此丢掉，
   *  免得 fnSig0 再报一遍同一件事）；压根不是这个形状的回 null（照原样留着）。 */
  fullProp(it, sibs = []) {
    const dcl = it.items[2];
    const body = it.items[3];
    if (!isList(dcl) || head(dcl) !== 'dcl') return null;
    const core = dcl.items[2];
    const nm = this.qname(core);
    if (nm === null) return null;                    // 特殊名（get / construct…）不是这一格
    if (!isList(body) || head(body) !== 'compound') return null;
    if (this.flat(dcl.items[3]).length > 0) {
      this.nope(it, `完整声明式的属性 '${nm}' 的名字后面还挂着东西（形参或下标）`);
      return [];
    }
    const accs = [];
    let fld = null;                    // 体里那格 autoget 字段（prop_full.rst:34）
    let evt = null;                    // 体里那格 bindable 事件（同处，34_BindableProperties.jnc:55）
    /* 体里**直接就是取值器的体**（第一百五十七刀）：`string_t const property m_string { return …; }`
       （std_String.jnc:26）。jancy 的属性体里可以直接写语句 —— 那时整格体就是 get 的体，
       `const` 说的是"没有存值器"。判据：体里一条都不是"成员声明"（`var-decl` 或者带
       `(accessor …)` 的 `fn-def`），而体又非空。语料里 81 份文件压在这一格上。 */
    const bodyItems = this.flat(body.items[1]);
    /* "成员声明"怎么认（第一百五十七刀量出来的一格坑）：不能只看"是不是 `var-decl`" ——
       取值器体里的**局部量**（`int t = m_twice;`）也是 `var-decl`，那么一句就把整格体判成了
       成员表。按 prop_full.rst:34 那句话认才对：体里的成员声明就是**带 `autoget` 的字段**与
       **带 `bindable` 的事件**，也就是说明符里必有那几个词之一。 */
    const memMods = new Set(['autoget', 'bindable', 'event', 'multicast', 'alias']);
    /* 只有原型的取/存（第一百六十刀）也算"成员声明"：`property m_value { int get(); void set(int); }`
       整格体不是取值器的体 —— 那两条是**声明**，体在宿主那边。漏了这一句的话 `whole` 会判成真，
       于是这两条被当成取值器体里的两格局部量（报的是"局部量上的形参表"）。 */
    const protoAcc = (m) => {
      const ds0 = this.flat(m.items[2]);
      return ds0.length === 1 && bareAccessor(ds0[0]);
    };
    const isPropMember = (m) => isList(m) && ((head(m) === 'var-decl'
      && ([...this.flat(m.items[1].items[2]), ...this.flat(m.items[1].items[3])]
        .some((x) => isAtom(x) && memMods.has(x.value)) || protoAcc(m)))
      || (head(m) === 'fn-def' && isList(m.items[2]) && isList(m.items[2].items[2])
        && head(m.items[2].items[2]) === 'accessor'));
    const whole = bodyItems.length > 0 && !bodyItems.some(isPropMember);
    const hostAcc = { get: false, set: false };
    for (const m of whole ? [] : bodyItems) {
      if (isList(m) && head(m) === 'var-decl') {
        /* 体里那格**只有原型、没有体**的取/存（第一百六十刀）：`void set(variant_t value);`
           / `string_t get();`（ui_PropertyGrid.jnc:80/86/91）。语法上它是一格 var-decl，
           声明符的芯是裸写的 `get` / `set`（`bareAccessor`）—— 在类体里那是**下标算符**
           （第一百三十八刀），可在**属性体里**它就是这格属性的取/存（prop_full.rst:15 那对
           花括号开的是一层命名空间）。没有体的意思是"实现在别处"：`opaque class` 里就是
           宿主的 C/C++（opaque.rst:15-29），读写于是走 `(ccall …)`。 */
        const ds0 = this.flat(m.items[2]);
        const d0 = ds0.length === 1 ? ds0[0] : null;
        if (d0 !== null && bareAccessor(d0)) {
          const k0 = specialCore(d0);
          /* 只有原型的第二个 `set`（第一百八十一刀）：也是**收**的 —— 体写在外面
             （`void g_prop.set(double x) { … }`，prop_full.rst:37 那句 out-of-line）。
             `get` 照旧只许一个。 */
          if (k0 !== 'set' && (accs.some((a) => a.kind === k0) || hostAcc[k0] === true)) {
            this.nope(m, `完整声明式的属性 '${nm}' 里两个 ${k0}（要重载决议）`);
            return [];
          }
          hostAcc[k0] = true;
          accs.push({ kind: k0, node: m, proto: true, sp: m.items[1], ptrs: d0.items[1] });
          continue;
        }
        const r = this.fullPropMember(nm, m, sibs);
        if (r === null) return [];
        if (r.kind === 'field') {
          if (fld !== null) { this.nope(m, `完整声明式的属性 '${nm}' 里两格字段`); return []; }
          fld = r;
        } else {
          if (evt !== null) { this.nope(m, `完整声明式的属性 '${nm}' 里两格事件`); return []; }
          evt = r;
        }
        continue;
      }
      const md = isList(m) && head(m) === 'fn-def' ? m.items[2] : null;
      const mc = md === null ? null : md.items[2];
      // `(accessor "get")` 里那一格是**串**（语法里写的是带引号的字面量），与 isLabel 那处同理。
      const av = isList(mc) && head(mc) === 'accessor' ? mc.items[1] : null;
      const kind = av !== null && (isAtom(av) || isStr(av)) ? av.value : null;
      if (kind === null) {
        this.nope(m, `完整声明式的属性 '${nm}' 体里的这一条 —— 只收带体的 get / set 与`
          + '`autoget` 的字段 / `bindable` 的事件（prop_full.rst:34）');
        return [];
      }
      /* 存值器的重载（第一百八十一刀）：jancy 明写支持（prop_full.rst:15 的 "overloaded
         setters"），所以体里的第二个 `set` 是**收**的 —— 挑哪一条在写属性那一处按右边的
         类型排。`get` 照旧只许一个（prop.rst:15 那句 "a single getter"）。 */
      if (kind !== 'set' && accs.some((a) => a.kind === kind)) {
        this.nope(m, `完整声明式的属性 '${nm}' 里两个 ${kind}（要重载决议）`);
        return [];
      }
      accs.push({ kind, node: m });
    }
    const g = accs.find((a) => a.kind === 'get');
    /* 类型的出处有两个：写了取值器就抄它的返回类型，没写就抄体里那格 autoget 字段
     * （那时取值器由编译器生成 —— prop_autoget.rst:17 的两半）。两个都没有就说不通。
     * 不带 `autoget` 的普通字段**不算**一个出处（第一百七十九刀）：那格字段是属性自己的存储，
     * 类型仍旧是取值器的返回类型。 */
    const fldT = fld !== null && fld.plain !== true ? fld : null;
    if (!whole && g === undefined && fldT === null) {
      this.nope(it, `完整声明式的属性 '${nm}' 里既没有 get 也没有 autoget 的字段 ——`
        + '属性的类型没处抄');
      return [];
    }
    /* 体里直接就是取值器的体那一种（第一百五十七刀）：类型抄**属性自己**那一格说明符 ——
       `string_t const property m_string { … }` 里 `string_t` 既是属性的类型、也是 get 的返回
       类型。`property` / `const` 两个词要从 get 那一份说明符里摘掉：留着 `property` 会让下游
       把这个函数当成又一格属性声明，留着 `const` 是给函数写了个没意思的词。 */
    const sp0 = body.span;
    const mods0 = new Set(['property', 'const']);
    const keep = (lst) => this.mkL(lst !== undefined && lst !== null ? lst.span : sp0,
      this.mkA(sp0, 'mods'),
      ...this.flat(lst).filter((x) => !(isAtom(x) && mods0.has(x.value))));
    const src = whole ? { sp: it.items[1], ptrs: dcl.items[1] }
      : (fldT !== null ? fldT
        : (g.proto === true ? { sp: g.sp, ptrs: g.ptrs }
          : { sp: g.node.items[1], ptrs: g.node.items[2].items[1] }));
    const extra = [];
    if (fld !== null) extra.push('autoget');
    if (evt !== null) extra.push('bindable');
    /* 体里那两格的**名字**是写的人定的（`m_x` / `m_e`，不是默认的 `m_value` / `m_onChanged`）。
     * 改写出来的简单声明式记不住它们，所以在这儿记一笔 —— autoStore / bindStore 按它拼那格
     * 生成物的名字，于是存值器体里裸写的 `m_x` 由属性那层命名空间直接查得着。 */
    const full = this.qual(nm);
    if (fld !== null || evt !== null) {
      this.propMemName.set(full, {
        store: fld === null ? null : fld.name,
        onch: evt === null ? null : evt.name,
        // 那格字段的**就地初值**（第一百八十刀）：autoStore 那一步把它带到生成的那格存储上。
        init: fld === null || fld.init === undefined ? null : fld.init,
      });
    }
    /* 那条 alias 说的是"这一格不生成、就用外层那格成员"（第一百五十八刀）：记一笔，autoStore /
       bindStore 那两步照它走 —— 属性这一层里那个新名字（`m_onPropChanged` / `m_value`）与外层
       那格是同一格，所以 propMemName 上记的仍是这个新名字（存值器体里裸写它，靠 ren 那张表
       换过去）。 */
    if ((evt !== null && evt.target !== undefined)
      || (fld !== null && fld.target !== undefined)) {
      this.propAlias.set(full, {
        store: fld !== null && fld.target !== undefined ? fld.target : null,
        onch: evt !== null && evt.target !== undefined ? evt.target : null,
      });
    }
    /* 取值器的返回类型上那个 `const` **不是**属性的 `const`（第二百二十七刀）。原样：
         property g_prop { char const* get(); void set(int); }
       （jnc_sample_01_export_c/script.jnc:29-33）—— 那个 `const` 说的是"指到的字节不许改"，
       而属性能不能写按 jancy 的规矩只看一件事：**有没有存值器**（prop.rst:17 那句
       "If a property has no setters then it is a const property"）。这儿的类型是从取值器那份
       说明符抄来的（上面 `src` 那三支），`const` 就跟着抄进了改写出来的简单声明式，于是
       `pi.cst` 为真、写它当场被拒 —— 那是**拒错了**，jancy 收这一句。
       所以：体里有存值器（自己写的或者只有原型的那种）时，把抄过来那份说明符上的 `const`
       摘掉。`whole` 那一支不摘 —— 那儿 `src.sp` 是**属性自己**那份说明符
       （`string_t const property m_string { … }`），那个 `const` 正是"没有存值器"的意思。 */
    const hasSet = accs.some((a) => a.kind === 'set') || hostAcc.set === true;
    const dropConst = (sp) => (isList(sp) && head(sp) === 'specs'
      ? this.mkL(sp.span, this.mkA(sp.span, 'specs'), sp.items[1],
        this.mkL(sp.span, this.mkA(sp.span, 'mods'),
          ...this.flat(sp.items[2]).filter((x) => !(isAtom(x) && x.value === 'const'))),
        this.mkL(sp.span, this.mkA(sp.span, 'mods'),
          ...this.flat(sp.items[3]).filter((x) => !(isAtom(x) && x.value === 'const'))))
      : sp);
    const out = [this.propDeclOf(!whole && hasSet ? dropConst(src.sp) : src.sp, src.ptrs, core, extra)];
    if (whole) {
      // 那一格 get：名字是 `属性名.get`（qualified-special），形参表空着，体就是属性那个体。
      const acc = this.mkL(sp0, this.mkA(sp0, 'accessor'), this.mkA(sp0, 'get'));
      const qs = this.mkL(sp0, this.mkA(sp0, 'qualified-special'), core, acc);
      const sfx = this.mkL(sp0, this.mkA(sp0, 'suffixes'),
        this.mkL(sp0, this.mkA(sp0, 'fn-suffix'), this.mkL(sp0, this.mkA(sp0, 'formals'))));
      const gsp = this.mkL(sp0, this.mkA(sp0, 'specs'), it.items[1].items[1],
        keep(it.items[1].items[2]), keep(it.items[1].items[3]));
      out.push(this.mkL(sp0, this.mkA(sp0, 'fn-def'), gsp,
        this.mkL(sp0, this.mkA(sp0, 'dcl'), this.dropPropTail(dcl.items[1], mods0), qs, sfx, dcl.items[4]),
        body));
      return out;
    }
    /* 只有原型的那几格记一笔（第一百六十刀）：它们**不出函数** —— 体在宿主那边，读写落成
       `(ccall …)`（见 propGet / propSet 那两处的宿主面分支）。 */
    if (hostAcc.get || hostAcc.set) this.propHostAcc.set(full, hostAcc);
    for (const a of accs) {
      if (a.proto === true) continue;            // 没有体，发不出函数
      const ad = a.node.items[2];
      const qs = this.mkL(ad.span, this.mkA(ad.span, 'qualified-special'), core, ad.items[2]);
      out.push(this.mkL(a.node.span, this.mkA(a.node.span, 'fn-def'), a.node.items[1],
        this.mkL(ad.span, this.mkA(ad.span, 'dcl'), ad.items[1], qs, ad.items[3], ad.items[4]),
        a.node.items[3]));
    }
    return out;
  }

  /**
   * 完整声明式的属性体里的一条**声明**（第七十六刀）：只有两种。
   *
   *   - `autoget int m_x;` —— 那格编译器生成的存储，名字是写的人定的（默认才叫 `m_value`，
   *     prop_autoget.rst:26）。它反过来给整格属性加上 `autoget`（prop_full.rst:34 那句
   *     "'autoget' field implicitly makes property 'autoget'"）。
   *   - `bindable event m_e();` —— 那格事件，同理给整格属性加上 `bindable`
   *     （samples/jnc/34_BindableProperties.jnc:52-55）。
   *
   * 回 `{kind, name, sp, ptrs}`；说不通时**自己报**并回 null。
   */
  /**
   * 同一层里名字叫 `nm` 的那格**声明**（第一百五十八刀）：回 `{sp, ptrs}` —— 说明符与那一串
   * `*`，也就是"这格的类型是怎么写的"。`autoget alias` 抄的就是它（jancy 那边抄的是解出来的
   * 类型，这一遍排在类型之前，所以抄的是写法；两者在同一层里是一回事）。
   */
  sibDecl(sibs, nm) {
    for (const m of sibs) {
      if (!isList(m) || head(m) !== 'var-decl') continue;
      if (this.hasMod(m.items[1], 'alias')) continue;
      for (const d0 of this.flat(m.items[2])) {
        const d = isList(d0) && head(d0) === 'init' ? d0.items[1] : d0;
        if (!isList(d) || head(d) !== 'dcl') continue;
        if (this.qname(d.items[2]) !== nm) continue;
        if (this.flat(d.items[3]).length > 0) return null;   // 带形参表/下标的不是一格字段
        return { sp: m.items[1], ptrs: d.items[1] };
      }
    }
    return null;
  }

  fullPropMember(nm, m, sibs = []) {
    const sp = m.items[1];
    const mods = [...this.flat(sp.items[2]), ...this.flat(sp.items[3])]
      .filter((x) => isAtom(x)).map((x) => x.value);
    const ds = this.flat(m.items[2]);
    /* `bindable alias m_onPropChanged = m_onChanged;`（ui_PropertyGrid.jnc:81 那三处）与
       `autoget alias m_value = m_classValue;`（test/jnc/test89.jnc:14-15）。**方向与头一遍
       猜的正相反**：出处是 `Parser::declareAlias`（jnc_ct_Parser.cpp:1346-1365）——

           Alias* alias = createAlias(name, &declarator->m_initializer);
           if (nspace->getNamespaceKind() == NamespaceKind_Property) {
             if (ptrTypeFlags & PtrTypeFlag_Bindable) prop->setOnChanged(alias);
             else if (ptrTypeFlags & PtrTypeFlag_AutoGet) prop->setAutoGetValue(alias);
           }

       等号**右边**那格才是真东西（外层命名空间里已经有的那格成员），左边只是属性这一层里给它
       起的另一个名字。所以 `bindable`/`autoget` 这两个词在这儿的意思是"这格属性的事件/存储
       **不生成**，就用它"（`Property::finalize` 里 `alias->getTargetItem()` 再 setOnChanged /
       setAutoGetValue 一遍，jnc_ct_Property.cpp:484-500）。`alias doesn't need a type`
       （jnc_ct_Parser.cpp:1341）—— 所以类型要从目标那格成员抄（同处 170：`item->getItemType()`）。 */
    if (mods.includes('alias')) {
      const ini = ds.length === 1 && isList(ds[0]) && head(ds[0]) === 'init' ? ds[0] : null;
      const an = ini === null ? null : this.qname(ini.items[1].items[2]);
      const tg = ini === null ? null : this.qname(ini.items[2]);
      const bnd = mods.includes('bindable');
      const agt = mods.includes('autoget');
      if (an === null || tg === null) {
        this.nope(m, `完整声明式的属性 '${nm}' 里那条 alias 的写法（只收`
          + ' `bindable alias 新名字 = 外层那格事件;` 与 `autoget alias 新名字 = 外层那格字段;`）');
        return null;
      }
      if (!bnd && !agt) {
        this.nope(m, `完整声明式的属性 '${nm}' 里那条 alias 上既没有 'bindable' 也没有`
          + " 'autoget'（属性体里的 alias 只有这两种意思，jnc_ct_Parser.cpp:1354-1361）");
        return null;
      }
      if (bnd) return { kind: 'event', name: an, target: tg, sp, ptrs: ini.items[1].items[1] };
      /* autoget 那一种：类型抄目标那格声明的**说明符**。目标要在同一层里找得着 —— 找不着的
         明说不收，而不是猜一个类型（那会是个静默的错答案）。 */
      const t0 = this.sibDecl(sibs, tg);
      if (t0 === null) {
        this.nope(m, `完整声明式的属性 '${nm}' 里那条 autoget alias 指着的 '${tg}' ——`
          + ' 这一层只收指着同一层里一格写明了类型的字段的那一种');
        return null;
      }
      return { kind: 'field', name: an, target: tg, sp: t0.sp, ptrs: t0.ptrs };
    }
    if (ds.length !== 1 || !isList(ds[0]) || (head(ds[0]) !== 'dcl' && head(ds[0]) !== 'init')) {
      this.nope(m, `完整声明式的属性 '${nm}' 体里的这一条（一条声明只收一格）`);
      return null;
    }
    /* 带**就地初值**的字段（第一百八十刀）：`int m_x = 5;` —— jancy 的例子第一行就是它
       （prop_full.rst:18）。语法上那是一格 `init`，里头包着声明符与初值。 */
    const ini0 = head(ds[0]) === 'init' ? ds[0] : null;
    const d = ini0 === null ? ds[0] : ini0.items[1];
    if (!isList(d) || head(d) !== 'dcl') {
      this.nope(m, `完整声明式的属性 '${nm}' 体里的这一条（一条声明只收一格）`);
      return null;
    }
    const name = this.qname(d.items[2]);
    if (name === null || name.includes('.')) {
      this.nope(m, `完整声明式的属性 '${nm}' 体里这一条的名字`);
      return null;
    }
    if (mods.includes('event') || mods.includes('multicast')) {
      // 事件那一格的实参表要是空的：属性的 `onChanged` 在 jancy 那边就是 `multicast ()`
      // （`StdType_SimpleMulticast`，jnc_ct_TypeMgr.cpp:195-197）。
      const sfx = this.flat(d.items[3]);
      const ps = sfx.length === 1 && head(sfx[0]) === 'fn-suffix' ? this.flat(sfx[0].items[1]) : null;
      if (ps === null || ps.length > 0) {
        this.nope(m, `完整声明式的属性 '${nm}' 里的事件 '${name}' 带着实参（属性的那一格是`
          + ' `multicast ()`）');
        return null;
      }
      return { kind: 'event', name, sp, ptrs: d.items[1] };
    }
    if (mods.includes('autoget')) return { kind: 'field', name, sp, ptrs: d.items[1] };
    /* **不带 `autoget` 的普通字段**（第一百七十九刀）。jancy 收它，而且文档里写得很直白：
       "A full property declaration looks a lot like a declaration for a class. It implicitly opens
       a namespace and allows for overloaded setters, **member fields**, helper methods,
       constructors/destructors etc."（prop_full.rst:15-16，例子就是 `int m_x = 5;`）。
       所以先前那句"字段要写 `autoget`"是**我们自己多加的一条**，不是 jancy 的规矩。

       落法用现成的那条路：这一格与 autoget 那格存储**在这一层是同一件东西**（属性那层命名空间里
       的一格存储，名字由写的人定，存值器体里裸写它）。差别只有两处，都在调用方那儿处理：
         - 属性的**类型**照旧从 `get` 抄，不从这格字段抄（jancy 那边类型是取值器的返回类型；
           `autoget` 那一种才反过来 —— 它没有手写的取值器）；
         - 所以体里没有 `get` 的话这一格说不通（类型没处抄），那一句在调用方。 */
    if (mods.length === 0) {
      return {
        kind: 'field', name, sp, ptrs: d.items[1], plain: true,
        init: ini0 === null ? null : ini0.items[2],
      };
    }
    this.nope(m, `完整声明式的属性 '${nm}' 体里的这一条 —— 字段要写 \`autoget\`、事件要写`
      + ' `bindable event`（prop_full.rst:34）');
    return null;
  }

  /**
   * 那条简单声明式（第七十五刀）：类型抄取值器的 —— 说明符照抄，`*` 那一串也照抄
   * （`log.Writer* get()` 的属性是 `log.Writer* property m_x`）。`property` 这个词落在哪儿按
   * 第七十二刀那条规矩：没有 `*` 就进说明符表的后一组，有 `*` 就跟在**最后一个** `*` 后面。
   */
  propDeclOf(gsp, gptrs, core, extra = []) {
    const sp = this.mkL(gsp.span, ...gsp.items);
    const ptrs = this.mkL(gptrs.span, ...gptrs.items);
    const words = ['property', ...extra];
    /* 那几个词要**摊平了再拼**（第一百五十八刀量出来的一格坑）：说明符里那串词在语法里是
       左递归的一串（`(mods-add (mods) autoget)`，见 flat），照原样往 items 后面接的话
       flat 只认得出头两条 —— 接上去的 `property` 就这么没了。写 `autoget int m_x;`（词在
       类型前面）时那一格是空的 `(mods)`，所以第七十五刀起这一格一直是对的；`int autoget m_x;`
       （ui_PropertyGrid.jnc:79 那种，词在类型后面）才踩得着。 */
    const flatMods = (lst, extras) => this.mkL(lst.span, this.mkA(lst.span, 'mods'),
      ...this.flat(lst), ...extras.map((w) => this.mkA(lst.span, w)));
    if (ptrs.items.length === 1) {
      sp.items[3] = flatMods(sp.items[3], words);
    } else {
      const last = ptrs.items[ptrs.items.length - 1];
      ptrs.items[ptrs.items.length - 1] = this.mkL(last.span, last.items[0],
        flatMods(last.items[1], words));
    }
    const d = this.mkL(core.span, this.mkA(core.span, 'dcl'), ptrs, core,
      this.mkL(core.span, this.mkA(core.span, 'suffixes')),
      this.mkL(core.span, this.mkA(core.span, 'no-ctor')));
    return this.mkL(core.span, this.mkA(core.span, 'var-decl'), sp,
      this.mkL(core.span, this.mkA(core.span, 'dcls'), d));
  }

  /**
   * 属性的名字先坐下（第六十八刀）。
   *
   * jancy 的属性是"看起来像字段、读写时其实在调函数"的一格：读走 **getter**，写走
   * **setter**，setter 可以没有（那就是 const 属性，prop.rst:15-17）。简单声明式
   * （prop_simple.rst:19）在源码里只有一个词 `property`，取/存两个函数的体写在别处：
   * `int g_p.get() { … }` 与 `g_p.set(int x) { … }`。
   *
   * 这一遍**必须排在签名那一遍之前**：那两个函数的签名（回什么、收什么）是从属性的类型
   * 抄来的，而模块级变量那一遍（globalDecl）在签名之后跑，来不及。
   */
  propName(n) {
    // 这儿要 `allowVirt`（第六十九刀）：`errorcode` 与 `virtual` 写在属性上 jancy 都收，
    // 所以不能让 specs 拿"只能写在函数上"把它们挡掉 —— 那句话对属性是**认错了人**。
    // 收下来之后就地拒，理由说清楚。
    const sp = this.specs(n.items[1], true);
    if (sp === null) return null;
    for (const d of this.flat(n.items[2])) {
      if (isList(d) && head(d) === 'init') { this.nope(d, '属性的初值'); continue; }
      const info = this.declarator(d, sp, n.items[1], true);
      if (info === null) continue;
      // 那几个词可能写在星号的**后面**（第七十二刀），所以这三条问的是声明符自己那份袋子。
      const dsp = info.sp;
      if (!dsp.prop) {
        this.nope(d, '同一条声明里属性与普通的一格混着写（`T* property a, b;`）');
        continue;
      }
      if (dsp.stat) { this.nope(d, '`static` 写在属性上'); continue; }
      /* `errorcode` 写在**属性那条声明**上（第二百三十九刀）：**收下不看**。
         先前这儿写的是"那一位落在取/存那两个函数上，而这一层的 errorcode 是按函数名记的 ——
         还接不上"，那句话**猜错了 jancy**。翻它的源码：

           TypeModifierMaskKind_Property = … | TypeModifier_ErrorCode | …   // jnc_ct_Decl.h:75-85
           …
           uint_t typeFlags = 0;
           if (m_typeModifiers & TypeModifier_Const)    typeFlags |= PropertyTypeFlag_Const;
           if (m_typeModifiers & TypeModifier_Bindable) typeFlags |= PropertyTypeFlag_Bindable;
           …
           m_typeModifiers &= ~TypeModifierMaskKind_Property;   // jnc_ct_DeclTypeCalc.cpp:566
                                                                // getPropertyType，558-569

         也就是说：属性类型上**只有** `Const` 与 `Bindable` 两位，`errorcode` 那一位进了
         Property 那张 mask、然后被那一句**清掉** —— 而 `FunctionTypeFlag_ErrorCode` 只在
         `getFunctionType` 里加（同文件:499-500）。**jancy 自己就把属性上这一位丢掉了**，
         它对取/存两个函数一点影响都没有。所以这一层收下不看，与 `const` / `readonly` / `thin`
         写在指针上那一条（第六十七刀）是同一件事：不是"还接不上"，是那一位在那儿本来就没意思。

         取值器**自己**带的那一位照旧有效（`int errorcode get();` 走的是 getFunctionType）——
         这一刀只放过写在属性那条声明上的。 */
      if (dsp.virt !== null) { this.nope(d, `'${dsp.virt}' 写在属性上`); continue; }
      // 声明符上带形参表的是**索引属性**（第七十刀）：`int property g_p(size_t i);` ——
      // 那一串不是"函数的形参"，是**下标**（prop_indexed.rst:15：属性带数组语义，下标的类型
      // 与含义都由写的人定）。取/存两个函数各在前面多这一串，读写落成
      // `(call p$get i)` / `(call p$set i v)`。
      let idx = [];
      if (info.formals !== null) {
        const ips = this.formalList(info.formals);
        if (ips === null) continue;
        idx = ips.map((p) => p.type);
      }
      const full = this.qual(info.name);
      if (this.props.has(full)) { this.err(d, `属性 '${shown(full)}' 声明了两次`); continue; }
      // 类的成员属性（第六十九刀）：`qual` 已经把类名拼在前面了（类体里那一批是 propPend
      // 送过来的，那时 ns 就是这个类），所以这儿只要问"前一格是不是类"。`cls` 非 null 的
      // 那些取/存两个函数多一格 `this`（见 propSig），读写时那一格从对象或 `this` 来。
      const cut = full.lastIndexOf('$');
      const owner = cut < 0 ? null : full.slice(0, cut);
      /* 结构体也算（第一百九十八刀）：那一格里放的本来就是地址，`this` 那一格由 selfTy 挑。 */
      const cls = owner !== null && (this.classes.has(owner) || this.structs.has(owner))
        ? owner : null;
      if (cls !== null) this.propNames.add(full.slice(cut + 1));
      /* `autoget` / `bindable` 在结构体上还不收：前者要生成一格**字段**、后者要生成一格事件，
         而这一遍排在字段表定下来之后（typeDecl 那一遍已经走完），插不进去了；事件那一格结构体
         本来也不收（第八十三刀）。 */
      const structOwner = cls !== null && !this.classes.has(cls);
      if (structOwner && (dsp.agt || dsp.bnd)) {
        this.nope(d, `结构体的成员属性 '${info.name}' 上的 `
          + `'${dsp.agt ? 'autoget' : 'bindable'}'（那一格要往结构体里加一格字段 / 一格事件，`
          + '而属性这一遍排在字段表定下来之后）');
        continue;
      }
      // `autoget`（第七十一刀）：这一格的取值器**不用写** —— 编译器生成一格存储，读属性就是
      // 读那一格（prop_autoget.rst:15-17）。简单声明式里存值器的体拿 `m_value` 称呼它
      //（同处:26）。与索引属性互斥，那是同一份文档最后一句（:47）。
      const store = dsp.agt ? this.autoStore(d, full, cls, info.type, idx) : null;
      if (dsp.agt && store === null) continue;
      // `bindable`（第七十三刀）：编译器生成一格事件，名字是 `m_onChanged`。
      const onch = dsp.bnd ? this.bindStore(d, full, cls) : null;
      if (dsp.bnd && onch === null) continue;
      this.props.set(full, {
        type: info.type, cls, cst: dsp.cst, idx, get: false, set: false, store, onch,
        bdata: dsp.bdata === true,
      });
    }
    return null;
  }

  /**
   * `autoget` 那格生成的存储（第七十一刀）。回它在**方言里**的名字，接不上时发诊断回 null。
   *
   * 两种落法，都叫 `<属性全名>$m_value`（`$` 不在 jancy 的标识符里，所以撞不上源码里的名字，
   * 而同一个类里两格 autoget 属性各带一格自己的存储，不会挤在一起）：
   *   - 顶层的属性 -> 一格模块级变量。真发出去要等 gTaken 数完（`&m_value` 决定它要不要
   *     提到自己那一段内存里去），所以这儿只登记类型、发的那一步记在 autoProps 上。
   *   - 类的成员属性 -> 类自己那张字段表里加一格。这一遍排在 classLayout 之前，于是它跟着
   *     整条链那格结构体一起发出去。
   */
  autoStore(d, full, cls, t, idx) {
    /* `autoget alias 新名字 = 外层那格字段;`（第一百五十八刀）：那时**一格都不生成** ——
       属性的存储就是外层已经有的那格成员（jnc_ct_Property.cpp:167-194 那一支：目标是 Alias 时
       先放过，`finalize` 里再拿 `getTargetItem()` 重来一遍，取值器照旧是编译器生成的
       AutoGetter，只是读的是那一格）。所以这儿只回那格的名字，字段表不动。 */
    const al = this.propAlias.get(full);
    if (al !== undefined && al.store !== null && al.store !== undefined) {
      if (idx.length > 0) {
        return this.err(d, `'${shown(full)}' 上 autoget 与下标不能一起写`
          + '（prop_autoget.rst:47 那句 mutually exclusive）');
      }
      if (cls === null) {
        const gt = this.globals.get(al.store);
        if (gt === undefined) {
          return this.nope(d, `'${shown(full)}' 那条 autoget alias 指着的 '${al.store}' ——`
            + ' 这一层只收指着同一层里一格已经声明过的变量的那一种');
        }
        if (!sameTy(gt, t)) {
          return this.err(d, `'${shown(full)}' 那条 autoget alias 指着的 '${al.store}' 是`
            + ` ${tyName(gt)}，属性说的是 ${tyName(t)}`);
        }
        return al.store;
      }
      const fs0 = this.ownFields.get(cls);
      const f0 = fs0 === undefined ? undefined : fs0.find((f) => f.name === al.store);
      if (f0 === undefined) {
        return this.nope(d, `'${shown(full)}' 那条 autoget alias 指着的 '${al.store}' ——`
          + ` 这一层只收指着 '${shown(cls)}' 自己那张字段表里一格字段的那一种`);
      }
      if (!sameTy(f0.type, t)) {
        return this.err(d, `'${shown(full)}' 那条 autoget alias 指着的 '${al.store}' 是`
            + ` ${tyName(f0.type)}，属性说的是 ${tyName(t)}`);
      }
      /* 取值器照旧是编译器生成的那一格（jancy 那边 `setAutoGetValue` 里 createFunction<AutoGetter>，
         jnc_ct_Property.cpp:187）—— 只是读的是外层那格成员，所以这一条也要进 autoProps；
         `alias: true` 是给发那一步看的：那一格存储**已经有人声明了**，不能再发一遍。 */
      this.autoProps.push({ full, name: al.store, cls, type: t, alias: true });
      return al.store;
    }

    // 「Autoget and indexed property modifiers are mutually exclusive」（prop_autoget.rst:47）。
    if (idx.length > 0) {
      return this.err(d, `'${shown(full)}' 上 autoget 与下标不能一起写`
        + '（prop_autoget.rst:47 那句 mutually exclusive）');
    }
    if (t === J_VOID) return this.err(d, `'${shown(full)}' 的类型是 void`);
    // 生成的那一格是"一格存储"，所以它落得进内存才行：结构体与数组要抄一份才能读写（那时
    // 合成的取值器不是一句 `ret`）、类**值**在 jancy 那边是内嵌的对象、函数值方言的结构体
    // 字段放不下（见 typeDecl 里字段那三条同样的话）。这几种明说不收。
    /* `variant_t` 是例外（第一百七十八刀）：它虽然是一格结构体，可**这一层的 variant 值本来
       就是一格地址**（第一百七十三刀量出来的那条 —— `varBox` 那几格出来的类型是
       `jnc$variant*`）。所以那格存储就是一格普通的 variant 字段（`(m_value jnc$variant)`，
       与手写的那种一模一样），读出来是"那一格的地址"，合成的取值器仍旧是一句 `ret`。 */
    if ((jncIsStruct(t) && !isVar(t)) || isArr(t) || isFn(t) || (isClass(t) && t.own === true)) {
      return this.nope(d, `类型是 ${tyName(t)} 的 autoget 属性 —— 编译器要生成的那一格存储`
        + '得是能一句读完的一格');
    }
    // 完整声明式里那格字段的名字是写的人定的（第七十六刀）；简单声明式里它就叫 `m_value`
    // （prop_autoget.rst:26）。
    const mem = this.propMemName.get(full);
    const name = `${full}$${mem !== undefined && mem.store !== null ? mem.store : 'm_value'}`;
    /* 那格字段的**就地初值**（第一百八十刀）。两种落法与"那格存储在哪儿"是一对：
         - 顶层的属性 -> 生成的是一格模块级变量，初值排进 `globalInit`（发的那一步在 autoProps 里，
           与一格普通的 `int g = 5;` 走同一条 `globalValue`）；
         - 成员属性 -> 生成的是类里的一格字段，初值排进 `fieldInits` —— 也就是**字段默认值**那条
           现成的路（第七十八刀）：合成的 construct 由它决定要不要发，所以这一笔必须在这儿记，
           不能等到发的那一步（那时 synthFI 早就算完了）。 */
    const ini = mem !== undefined && mem.init !== undefined ? mem.init : null;
    if (cls === null) {
      if (this.globals.has(name)) return this.err(d, `模块级变量 '${shown(name)}' 声明了两次`);
      this.globals.set(name, t);
      this.autoProps.push({ full, name, cls: null, type: t, init: ini });
      return name;
    }
    const fs = this.ownFields.get(cls);
    if (fs === undefined) return this.err(d, `'${shown(cls)}' 的字段表还没有 —— autoget 那一格加不进去`);
    fs.push({ name, type: t });
    if (ini !== null) {
      const list = this.fieldInits.get(cls);
      const one = { name, expr: ini, node: ini };
      if (list === undefined) this.fieldInits.set(cls, [one]);
      else list.push(one);
    }
    this.autoProps.push({ full, name, cls, type: t });
    return name;
  }

  /**
   * `bindable` 那格生成的事件（第七十三刀）。回它在**方言里**的名字，接不上时发诊断回 null。
   *
   * 名字是 `<属性全名>$m_onChanged`：源码里写的就是 `m_onChanged`
   * （prop_bindable.rst:23-29 那句 "name of compiler-generated event is 'm_onChanged'"），
   * 而属性在 jancy 那边**本来就是一层命名空间**（prop_full.rst:15）—— 存值器的体降下来时
   * `this.ns` 已经挪进了属性那一层（见 propNs），所以**顶层**属性里裸写的 `m_onChanged`
   * 由 resolve 直接找到那一格；成员属性那一格是类里的字段，换名的活儿在 selfField 里
   * （靠 fnDef 摆的那张 selfProp 表，与 `m_value` 同一条）。
   *
   * 两种落法（与 autoStore 的两种是一对）：
   *   - 顶层的属性 -> 一格模块级变量，出来是一格空单子（发的那一步记在 bindProps 上）。
   *   - 类的成员属性 -> 类自己那张字段表里加一格（第八十四刀）。jancy 那边这一格**就是**
   *     类里的一格字段（`Property::createOnChanged` 的头一支，jnc_ct_Property.cpp:131-134：
   *     `m_parentType` 非空就 `createField`），而第八十三刀已经把"类里的一格多播字段"整条
   *     路走通了 —— 建单子那几行由 evtInitLines 发在构造的开头，所以这儿只要把字段加进去。
   */
  bindStore(d, full, cls) {
    /* `bindable alias 新名字 = 外层那格事件;`（第一百五十八刀）：那时**一格都不生成** ——
       属性的 onChanged 就是外层已经有的那格成员（jnc_ct_Parser.cpp:1354 `setOnChanged(alias)`）。
       所以这儿只把那格的名字回上去，字段表与 bindProps 都不动（那格事件自己那份建单子的活儿
       早由类体/模块那一遍发过了）。 */
    const al = this.propAlias.get(full);
    if (al !== undefined && al.onch !== null) {
      if (cls === null) {
        const gt = this.globals.get(al.onch);
        if (gt === undefined || gt.k !== 'mc') {
          return this.nope(d, `'${shown(full)}' 那条 alias 指着的 '${al.onch}' ——`
            + ' 这一层只收指着同一层里一格已经声明过的事件的那一种');
        }
        return al.onch;
      }
      const fs0 = this.ownFields.get(cls);
      const f0 = fs0 === undefined ? undefined : fs0.find((f) => f.name === al.onch);
      if (f0 === undefined || f0.type.k !== 'mc') {
        return this.nope(d, `'${shown(full)}' 那条 alias 指着的 '${al.onch}' ——`
          + ` 这一层只收指着 '${shown(cls)}' 自己那张字段表里一格事件的那一种`);
      }
      return al.onch;
    }
    // 完整声明式里那格事件的名字是写的人定的（第七十六刀，jancy 那边记在
    // `PropertyType::m_bindableEventName` 上）；简单声明式里它就叫 `m_onChanged`。
    const mem = this.propMemName.get(full);
    const name = `${full}$${mem !== undefined && mem.onch !== null ? mem.onch : 'm_onChanged'}`;
    if (cls === null) {
      if (this.globals.has(name)) return this.err(d, `模块级变量 '${shown(name)}' 声明了两次`);
      this.globals.set(name, J_MC);
      this.bindProps.push({ full, name });
      return name;
    }
    const fs = this.ownFields.get(cls);
    if (fs === undefined) {
      return this.err(d, `'${shown(cls)}' 的字段表还没有 —— bindable 那一格加不进去`);
    }
    fs.push({ name, type: J_MC });
    /* 建单子那张表（第八十三刀那一份）：typeDecl 那一遍已经 set 过了（类体里写的 `event`
       字段），所以这儿是**往里加**而不是盖掉 —— 这一遍（propName）排在 typeDecl 之后、
       synthCtors 之前，于是"这个类要不要一格合成的 construct"也能看见新加的这一格。 */
    let ev = this.evtFields.get(cls);
    if (ev === undefined) { ev = []; this.evtFields.set(cls, ev); }
    ev.push({ name, type: J_MC });
    return name;
  }

  /**
   * 通知那一格（第七十三刀，第七十四刀按签名分）：照单子从头到尾叫一遍，回那一格助手的名字。
   * 一种签名一格（名字里带签名，模块级的名字要全局唯一 —— 见第五十九刀那处）。
   *
   * 顺序与 jancy 一样是**加进来的顺序**（`McSnapshot.call` 从下标 0 往上走，
   * jnc_ct_MulticastClassType.cpp:64-94）。jancy 那边先取一份快照再叫，为的是"叫的过程中
   * 有人加/减"不会乱；这一层直接走那格数组，所以每一圈都重问一次 `alen` —— 叫的过程中
   * 加进来的会被叫到。这是**可观测的差别**，记成账：真要快照就得先抄一份数组。
   */
  mcFire(t) {
    const at = tyText(t);
    const had = this.mcFires.get(at);
    if (had !== undefined) return had;
    const sig = t.params.map((p) => tyText(p).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    const name = sig.length === 0 ? MC_FIRE : `${MC_FIRE}$${sig.join('$')}`;
    const ps = t.params.map((p, i) => ` ($a${i} ${slotText(p)})`).join('');
    const as = t.params.map((p, i) => ` (var $a${i})`).join('');
    this.decls.push(`  (fn ${name} ((m ${at})${ps}) void\n`
      + '    (let i int (int 0))\n'
      + '    (while (bin "<" (var i) (alen (var m))) (do\n'
      + `      (expr (callfn (aget (var m) (var i))${as}))\n`
      + '      (set i (bin "+" (var i) (int 1))))))');
    this.fns.set(name, { params: [t, ...t.params], ret: J_VOID });
    this.mcFires.set(at, name);
    return name;
  }

  /**
   * `variant_t` 那一格结构体（第一百一十三刀）—— 第一次用到才登记。
   * 顺带把装箱 / 拆箱那几格助手一起发出去：它们是**函数**而不是内联的几句，为的是让装箱在
   * 表达式里就地成立（`expr` 这一层回的是一格值，没有能挂语句的地方）。
   */
  variantTy() {
    if (!this.structs.has(VARIANT)) {
      this.structs.set(VARIANT, [
        { name: '$t', type: J_I32 },
        { name: '$n', type: J_I64 },
        { name: '$r', type: J_REAL },
        { name: '$s', type: J_STR },
      ]);
      this.decls.push(`  (struct ${VARIANT} ($t int) ($n int) ($r real) ($s string))`);
    }
    return { k: 'struct', name: VARIANT };
  }

  /**
   * 装箱那一格助手：`(call jnc$var$<种> 值)` 回一格新的 variant。
   * `fld` 是载荷落在哪一格、`tag` 是标签、`ty` 是那一格的方言类型文本。
   */
  varBox(kind, tag, fld, ty) {
    const name = `jnc$var$${kind}`;
    if (this.varFns.has(name)) return name;
    const vt = `(ptr ${VARIANT})`;
    const set = fld === null ? '' : `\n    (pstore (pfield (var v) ${fld}) (var x))`;
    this.decls.push(`  (fn ${name} (${fld === null ? '' : `(x ${ty})`}) ${vt}\n`
      + `    (let v ${vt} (pnew ${vt} (int 1)))\n`
      + `    (pstore (pfield (var v) $t) (int ${tag}))${set}\n`
      + '    (ret (var v)))');
    this.varFns.add(name);
    return name;
  }

  /**
   * 拆箱那一格助手：标签对不上就 `(fail …)`（与 assert 落到同一格，第四十九刀）。
   * jancy 那边拆箱失败也是运行期的事（`variant_t` 的强转走 `CastOp_Variant`），所以这一层
   * 不在编译期拒 —— 拒了就把"转手一格 variant"这个压倒性的用法一起拒掉了。
   */
  varUnbox(kind, tag, fld, ty, what) {
    const name = `jnc$var$to$${kind}`;
    if (this.varFns.has(name)) return name;
    const vt = `(ptr ${VARIANT})`;
    this.decls.push(`  (fn ${name} ((v ${vt})) ${ty}\n`
      + `    (if (bin "!=" (pload (pfield (var v) $t)) (int ${tag})) (do\n`
      + `      (fail (str ${JSON.stringify(`variant_t 里装的不是${what}`)}))))\n`
      + `    (ret (pload (pfield (var v) ${fld}))))`);
    this.varFns.add(name);
    return name;
  }

  /** 一格值装进 variant：回新的 `{code,type}`，装不进去回 null（调用方自己报）。 */
  varBoxOf(v) {
    if (isVar(v.type)) return v;
    this.variantTy();
    if (isInt(v.type)) {
      return { code: `(call ${this.varBox('i', V_INT, '$n', 'int')} ${intConv(v, J_I64).code})`, type: this.variantTy() };
    }
    if (jncIsEnum(v.type)) {
      const b = intConv({ code: v.code, type: v.type.base }, J_I64);
      return { code: `(call ${this.varBox('i', V_INT, '$n', 'int')} ${b.code})`, type: this.variantTy() };
    }
    if (v.type === J_BOOL) {
      return { code: `(call ${this.varBox('b', V_BOOL, '$n', 'int')} (sel ${v.code} (int 1) (int 0)))`, type: this.variantTy() };
    }
    if (v.type === J_REAL) {
      return { code: `(call ${this.varBox('r', V_REAL, '$r', 'real')} ${v.code})`, type: this.variantTy() };
    }
    if (v.type === J_STR) {
      return { code: `(call ${this.varBox('s', V_STR, '$s', 'string')} ${v.code})`, type: this.variantTy() };
    }
    return null;
  }

  /** variant 拆成一格有类型的值。拆不出来回 null（调用方自己报）。 */
  varUnboxTo(v, want) {
    if (isInt(want)) {
      const g = `(call ${this.varUnbox('i', V_INT, '$n', 'int', '一格整数')} ${v.code})`;
      return intConv({ code: g, type: J_I64 }, want);
    }
    if (want === J_BOOL) {
      const g = `(call ${this.varUnbox('b', V_BOOL, '$n', 'int', '一格布尔')} ${v.code})`;
      return { code: `(bin "!=" ${g} (int 0))`, type: J_BOOL };
    }
    if (want === J_REAL) {
      return { code: `(call ${this.varUnbox('r', V_REAL, '$r', 'real', '一个实数')} ${v.code})`, type: J_REAL };
    }
    if (want === J_STR) {
      return { code: `(call ${this.varUnbox('s', V_STR, '$s', 'string', '一格字符串')} ${v.code})`, type: J_STR };
    }
    return null;
  }

  /**
   * 赋值当**表达式**（第一百一十四刀）：`return m_currentIndex = insertItem(…)`。
   * jancy 里赋值是表达式（值就是**存进去的那个值**，不是回头再读一次），这一层的赋值只在语句
   * 位置成立。落法与装箱那几格助手同一个办法 —— 一格生成的函数：
   *
   *   (fn jnc$asgn$int ((p (ptr int)) (x int)) int (pstore (var p) (var x)) (ret (var x)))
   *
   * 于是 `(call jnc$asgn$int 地址 值)` 在表达式里就地成立，`expr` 这一层不用能挂语句。
   *
   * 左边**只收一格内存**（lvalue 的 `ptr`）：字段、指针指到的那一格、被取过地址的局部量、
   * 模块级变量。SSA 里的局部量（`var`）不行 —— 那一格没有地址，助手写不进去。语料里 14 处
   * 逐处看过，左边全是字段路径或指针（`m_currentIndex`、`m_p.m_value`、`p = p0 = next`），
   * 一处都不是 SSA 局部量，所以这条界不挡任何真写法。
   */
  asgnExpr(n) {
    const op = isStr(n.items[1]) ? n.items[1].value : null;
    if (op !== '=') return this.nope(n, `表达式里的复合赋值 '${op}'`);
    /* 花括号初值、属性、事件、索引属性那几条在语句那一侧是**分岔出去**的（curlyEmit /
       propSet / mcAssign）—— 表达式位置上还不收：它们要发的是一次调用或一串写，
       而"整条表达式的值"在那几种上说不清是哪一个。 */
    if (isList(n.items[3]) && head(n.items[3]) === 'curly') {
      return this.nope(n, '表达式里右边是一对花括号的赋值');
    }
    /* 属性当左边（第一百一十五刀）：那不是往一格内存里写，是**调存值器**。这两问要排在
       lvalue 之前 —— 属性没有"可写的那一格"，lvalue 会去查变量、报"未声明"或者第六十九刀
       那句"属性不是一格内存"。与语句那一侧（propSet）是同一条路，只多一件事：整条表达式的值
       要由一格包装函数给出来（见 psetFn）。 */
    const pt = this.propRef(n.items[2]);
    if (pt !== null) return this.asgnProp(n, pt, null);
    const lhs = n.items[2];
    if (isList(lhs) && head(lhs) === 'field' && isAtom(lhs.items[2])
      && this.propNames.has(lhs.items[2].value)) {
      const pm = this.propMember(lhs, lhs.items[2].value);
      if (pm === null) return null;
      if (pm !== undefined) return this.asgnProp(n, pm.pn, pm.self);
    }
    const lv = this.lvalue(n.items[2]);
    if (lv === null) return null;
    if (lv.kind !== 'ptr') {
      return this.nope(n, `表达式里给这一格赋值（左边要是一格**内存** —— 字段、指针指到的那一格、`
        + `被取过地址的局部量；这里是 ${lv.kind === 'agg' ? '一整格结构体或数组' : (lv.kind === 'bits' ? '一格位域' : 'SSA 里的一格局部量')}）`);
    }
    let v = this.expr(n.items[3], lv.type);
    if (v === null) return null;
    // 与语句那一侧一字不差：整数之间是隐式收窄，别的要同型。
    if (isInt(lv.type) && isInt(v.type)) v = intConv(v, lv.type);
    if (!this.assignOk(v.type, lv.type)) {
      return this.err(n, `赋值两边不同型：左是 ${tyName(lv.type)}，右是 ${tyName(v.type)}`);
    }
    return { code: `(call ${this.asgnFn(lv.type)} ${lv.code} ${v.code})`, type: lv.type };
  }

  /** 上面那一格助手，按方言类型一格（`int` 那一格四种位宽共用 —— 存进去的位一样）。 */
  asgnFn(t) {
    const ty = tyText(t);
    const key = ty.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const name = `jnc$asgn$${key}`;
    if (this.varFns.has(name)) return name;
    this.decls.push(`  (fn ${name} ((p (ptr ${ty})) (x ${ty})) ${ty}\n`
      + '    (pstore (var p) (var x))\n'
      + '    (ret (var x)))');
    this.varFns.add(name);
    return name;
  }

  /**
   * 表达式里给**属性**赋值（第一百一十五刀）：`return m_currentIndex = insertItem(…)` 里的
   * `m_currentIndex` 就是一格属性（`ui_ComboBox.jnc:74`）。第一百一十四刀量出来：那一行
   * 111 对里 80 对压在这儿。
   *
   * 落法与上一刀同一个办法，只是包装的东西不同 —— 存值器回的是 void，所以包一层：
   *
   *   (fn jnc$pset$C_m_p ((s (ptr C)) (x int)) int (expr (call C$m_p$set (var s) (var x))) (ret (var x)))
   *
   * "整条表达式的值是**存进去的那个值**"这一条与普通赋值一字不差（jancy 那边 `m_p = v` 的值
   * 就是 v，不是回头再调一次取值器 —— 那会把有副作用的取值器多调一次）。
   */
  asgnProp(n, pn, self) {
    const pi = this.props.get(pn);
    if (pi.cst) {
      return this.err(n, `'${shown(pn)}' 是 const 属性（声明里写了 const，prop.rst:17），写不了`);
    }
    const s = `${pn}$set`;
    // 索引属性还不收：那几格下标也要进包装函数的形参表，而个数是按属性变的。
    if (pi.idx.length > 0) {
      return this.nope(n, `表达式里给索引属性 '${shown(pn)}' 赋值`);
    }
    /* 存值器在宿主那边（第一百九十三刀）：`opaque class` 里那格属性一个体都没写，
       读写落成 `(ccall Owner_set_p self v)`（第一百六十刀）。这一处要的是**表达式**，
       所以让 hostProp 包一层 —— 与下面那格 psetFn 一模一样的形状，只是里头是 ccall。
       语料里的原样是 `return m_currentIndex = insertItem(index, text, data)`
       （ui_ComboBox.jnc:74，那格属性是 `size_t bindable autoget property`）。 */
    if (!this.fns.has(s)) {
      const hv = this.hostProp(n, pn, pi, self, 'set', { node: n.items[3], pad: '', expr: true });
      if (hv !== undefined) return hv;
      return this.nope(n, `写属性 '${shown(pn)}' —— 它的存值器没有定义`
        + '（简单声明式的体写在别处：`p.set(T x) { … }`，prop_simple.rst:29）');
    }
    const sf = this.propSelf(n, pn, pi, self);
    if (sf === null) return null;
    let v = this.expr(n.items[3], pi.type);
    if (v === null) return null;
    if (isInt(v.type) && isInt(pi.type)) v = intConv(v, pi.type);
    if (!sameTy(v.type, pi.type)) {
      return this.err(n, `属性 '${shown(pn)}' 是 ${tyName(pi.type)}，`
        + `这儿给的是 ${tyName(v.type)}`);
    }
    const w = this.psetFn(pn, s, pi);
    if (w === null) return this.nope(n, `表达式里给属性 '${shown(pn)}' 赋值（它的存值器`
      + '的形参表不是这一层认得的 `[this?, 值]`）');
    return { code: `(call ${w}${sf} ${v.code})`, type: pi.type };
  }

  /** 上面那一格包装函数，一个属性一格。 */
  psetFn(pn, s, pi) {
    const name = `jnc$pset$${pn.replace(/[^A-Za-z0-9]+/g, '_')}`;
    if (this.varFns.has(name)) return name;
    const sig = this.fns.get(s);
    // 存值器的形参表是 `[this?, 值]`（propSig 那一处拼的）。对不上就不发这一格 ——
    // 那说明属性那一族又长出了这一层没跟上的形状，宁可让调用方报"还不收"。
    const hasSelf = pi.cls !== null;
    if (sig.params.length !== (hasSelf ? 2 : 1)) return null;
    const vt = slotText(pi.type);
    const ps = hasSelf ? `($s ${slotText(sig.params[0])}) (x ${vt})` : `(x ${vt})`;
    const as = hasSelf ? ' (var $s) (var x)' : ' (var x)';
    this.decls.push(`  (fn ${name} (${ps}) ${vt}\n`
      + `    (expr (call ${s}${as}))\n`
      + '    (ret (var x)))');
    this.varFns.add(name);
    return name;
  }

  /**
   * 模块级变量（第十一刀）。降成方言的 `(global 名字 类型)` 加 `(main …)` 开头的一句赋值。
   *
   * 存储类照 decl_storage.rst：**不写就是 static**（"If storage specifier is omitted, then
   * global variables get assigned static storage class"），所以写出来的 `static` 与不写是
   * 同一件事，这里照收。
   *
   * 零初始化不用发：方言的 `(global …)` 出来就是零（sexpr/lower.js 第二十四刀），而 jancy
   * 那边 module.construct 的第一件事正是把所有 static 零初始化。
   */
  globalDecl(n) {
    // 属性那一条在前面那一遍（propName）已经登记过了（第六十八刀）—— 它不是一格内存。
    if (this.propMod(n.items[1], n.items[2])) return null;
    // alias 也在前面那一遍（与 typedef 同一处，第八十七刀）——它也不是一格内存。
    if (this.hasMod(n.items[1], 'alias')) return null;
    /* 顶层这一遍也要认得函数上那几个词（第一百四十九刀）：`size_t errorcode transmit(…);`
       （ias.jnc:30）是一条**函数原型**，`errorcode` 正写在函数上 —— 先前这儿按"不是函数位置"
       调 specs，于是报"'errorcode' 只能写在函数上"，那是认错人（一起编那张榜上 5 处）。
       改成收下来往上传，再在下面按**这条声明符到底有没有形参表**分开说：
         - 有形参表 -> 它是函数，那几个词写得对（原型那一支照旧，见下面第九十二刀那一段）；
         - 没有形参表 -> 那才是"写在一格变量上"，那时候原来那两句话都是对的。 */
    const sp = this.specs(n.items[1], true);
    if (sp === null) return null;
    for (const d of this.flat(n.items[2])) {
      const dh = isList(d) ? head(d) : null;
      let dcl = d;
      let initNode = null;
      if (dh === 'init') { dcl = d.items[1]; initNode = d.items[2]; }
      else if (dh === 'ref-init') { this.nope(d, '引用初始化（`:=`）'); continue; }
      const info = this.declarator(dcl, sp);
      if (info === null) continue;
      /* 顶层的事件（第七十四刀）：`event m_onDone(int code);` —— 一格模块级的"处理函数单子"。
       * 带实参那一串写在**声明符的括号里**，所以这一问必须排在"顶层的函数原型"那条之前 ——
       * 否则 `event m_e()` 会被当成一条函数原型拒掉。 */
      if (sp.evt === true) {
        const ps = info.formals === null ? [] : this.formalList(info.formals);
        if (ps === null) continue;
        if (initNode !== null) { this.nope(dcl, '事件的初值'); continue; }
        const nm = this.qual(info.name);
        if (this.globals.has(nm)) { this.err(dcl, `模块级变量 '${shown(nm)}' 声明了两次`); continue; }
        const t = mcTy(ps.map((p) => p.type));
        this.globals.set(nm, t);
        this.decls.push(`  (global ${nm} ${tyText(t)})`);
        this.globalCells.push(`    (set ${nm} (anew ${tyText(t)} (int 0)))`);
        continue;
      }
      /* 那几个**只对函数有意思**的词写在一格变量上（第一百四十九刀把这一问从 specs 挪到这儿）：
         没有形参表就是一格变量，那时原来那两句话是对的；有形参表的落到下面那两支上。 */
      if (info.formals === null && !sp.fnptr) {
        if (sp.errc) { this.err(dcl, "'errorcode' 只能写在函数上（exceptions.rst:17）"); continue; }
        if (sp.virt !== null) {
          this.err(dcl, `'${sp.virt}' 只能写在类的方法上（type_class.rst:178）`);
          continue;
        }
      }
      /* 顶层的函数原型（第九十二刀）：`void foo(int x);` —— 声明在前、定义在后那种 C++ 式的
         写法。签名那一遍（fnSig）排在这一遍**之前**，所以"这个名字有没有带体的定义"这时候
         问得出来：
           - 有定义 -> 这条原型是多余的一句，跳过它（jancy 那边也只是把两份签名对一下）；
           - 没有定义 -> 那就是"实现在别处"（宿主的 C/C++、或者 import 不着的模块），
             这一层接不上，说清是这一种，而不是笼统的"只收带体的定义"。
         签名对不上时当场报 —— 悄悄按其中一份算是骗人。 */
      if (info.formals !== null) {
        const fn = this.qual(info.name);
        const have = this.fns.get(fn);
        if (have === undefined) {
          /* 顶层那格只有原型的函数（第一百五十一刀钉的界，第一百八十五刀兑掉）：与类里那些
             （第一百八十三 / 一百八十四刀）是同一条 —— 体在宿主那边。符号名就是这条声明的
             **全名**把 `$` 换成 `_`（`doc.sessionDispatch` -> `doc_sessionDispatch`，
             与 `Owner_method` 那条规则是同一条：全名换字符）。签名记下来，调用点据此发
             `(ccall …)`。 */
          this.protoFns.add(fn);
          const ps0 = this.formalList(info.formals, true);
          if (ps0 !== null) {
            const ds0 = ps0.map((p) => p.def ?? null);
            const sg0 = {
              ret: info.type,
              params: ps0.map((p) => p.type),
              defs: ds0.some((d) => d !== null) ? ds0 : null,
              variadic: ps0.variadic === true,
              // `dylib X { … }` 里那些（第二百〇三刀）：符号名是成员名本身
              sym: this.dylibNs.has(this.ns) ? info.name : null,
            };
            /* 同名好几条原型（第一百九十四刀）：`long strtol(string_t, size_t*, int)` 与
               `long strtol(char const*, char const**, int)`（std_globals.jnc:461/467）——
               jancy 那边是 `JNC_MAP_FUNCTION_Q` 后面跟一条 `JNC_MAP_OVERLOAD`
               （jnc_std_StdLib.cpp:825-826 的 `std.setError` 就是这个形状）。先前这张表按名字
               存**一条**，第二条把第一条盖掉了 —— 那是"悄悄按其中一条算"，调用点于是拿
               `char const*` 那条去对一格 `string_t`，报的话指着实参。改成一格一族，
               挑哪一条与类里那几条原型共用 `hostPickSigs`（第一百八十六刀那套）。
               签名一模一样的当同一条（import 到两遍那种），不然会平手。 */
            const prev0 = this.hostTopSigs.get(fn);
            const same0 = (a, b) => a.params.length === b.params.length
              && a.params.every((t, i) => sameTy(t, b.params[i])) && sameTy(a.ret, b.ret)
              && (a.variadic === true) === (b.variadic === true);
            if (prev0 === undefined) this.hostTopSigs.set(fn, [sg0]);
            else if (!prev0.some((s) => same0(s, sg0))) prev0.push(sg0);
          }
          continue;
        }
        const ps = this.formalList(info.formals);
        if (ps === null) continue;
        const same = have.params.length === ps.length
          && have.params.every((t, i) => sameTy(t, ps[i].type)) && sameTy(have.ret, info.type);
        if (!same) {
          /* 对不上，可这个名字是**一族重载**（第一百四十九刀）：那这条原型多半配的是族里另一条，
             拿其中一条去对本来就是错的。语料里 `size_t errorcode transmit(void const*, size_t);`
             与 `size_t errorcode transmit(string_t) { … }`（ias.jnc:30 与 :35）就是这个形状。
             真拦路的是第一百四十四刀记下的那条：**只有原型的重载不进候选**。 */
          if (this.overloads.has(fn)) {
            this.nope(dcl, `原型 '${shown(fn)}' 是同名那一族里的一条 —— 只有原型的重载这一层`
              + '还没有收进候选（见 ADR-0016 第一百四十四刀那一段）');
            continue;
          }
          /* **形参不一样**就不是"签名对不上"（第二百〇八刀）：那是同名那一族里的**另一条**，
             它的体在宿主那边。类里那一格第一百八十六刀已经收了（方言名 `Owner$m` 与 C 符号
             `Owner_m` 是两个字符串，不撞），可**顶层**这一格撞名：体在宿主的那一条，它的方言名
             就是那个 C 符号（`(cabi transmit …)`），而带体的那一条在方言里也叫 `transmit`。
             一个模块里同一个名字放不下两格 —— 那是方言那一层的界，不是这份源码写错了。
             真正"签名对不上"的只有一种：形参一模一样、只有返回类型不同（jancy 那句
             "conflicting return types"）。 */
          const sameArgs = have.params.length === ps.length
            && have.params.every((t, i) => sameTy(t, ps[i].type));
          if (!sameArgs) {
            /* 第二百三十六刀把第二百〇八刀那句话兑掉了。那一刀说的是"顶层这一格两边在方言里会撞
               同一个名字"—— **认错人**：撞的是"发出去的那个符号"，而这两条根本不发同一个东西。
               带体的那一条发的是方言的 `(fn transmit …)`；体在宿主的那一条**一个函数都不发**，
               它只是在 `(cabi transmit …)` 上声明一句、调用点发 `(ccall transmit …)`。
               一个是定义、一个是声明，方言那一层本来就分得开（`emit sx` 上两行各一句）。
               所以这儿要做的只是**把这条原型的签名记下来**，与第一百九十四刀那一族同一张表
               （`hostTopSigs` 一格一族）；调用点按个数 / 类型对不上时再按那张表挑一次
               （`hostTopRetry`，与类里那一格 `protoHostRetry` 是同一条路）。
               语料里的原样就是 `size_t errorcode transmit(void const*, size_t);` 与
               `size_t errorcode transmit(string_t) { … }`（ias.jnc:30 与 :35）。 */
            const dsA = ps.map((p) => p.def ?? null);
            const sgA = {
              ret: info.type,
              params: ps.map((p) => p.type),
              defs: dsA.some((d) => d !== null) ? dsA : null,
              variadic: false,
              // 符号名照第一百八十五刀那条：全名把 `$` 换成 `_`（带体那条不占这个字符串）
              sym: this.dylibNs.has(this.ns) ? info.name : fn.replace(/\$/g, '_'),
            };
            const prevA = this.hostTopSigs.get(fn);
            const sameA = (a, b) => a.params.length === b.params.length
              && a.params.every((t, i) => sameTy(t, b.params[i])) && sameTy(a.ret, b.ret);
            if (prevA === undefined) this.hostTopSigs.set(fn, [sgA]);
            else if (!prevA.some((x) => sameA(x, sgA))) prevA.push(sgA);
            continue;
          }
          this.err(dcl, `原型 '${shown(fn)}' 与它那个定义只有返回类型不同（jancy 那句 `
            + '"conflicting return types"）');
        }
        continue;
      }
      // 声明符尾巴上的构造实参只有类的变量收得下（第五十三刀，与局部量同一条）。
      if (info.ctor !== null && !(isClass(info.type) && info.type.own === true)) {
        this.err(dcl, `'${info.name}' 不是类的变量，后面挂不了构造实参`);
        continue;
      }
      // 命名空间里的模块级变量（第五十一刀）：名字带上前缀，而那个带前缀的名字**同时**就是
      // 方言里那一格的名字（`$` 是合法标识符字符，点不是）。从这一句起 info.name 一律是全名。
      info.name = this.qual(info.name);
      if (isArr(info.type)) {
        if (info.type.n === null) { this.err(dcl, `'${info.name}[]' 的长度得从花括号初值数出来`); continue; }
        if (this.declareGlobal(dcl, info) === null) continue;
        const at = tyText(info.type);
        this.globalCells.push(`    (set ${info.name} (pnew ${at} (int 1)))`);
        // `int t[3] = s;` 与结构体那一支一样是抄一份（第二十一刀）。
        if (initNode !== null) {
          const v = this.globalValue(initNode, info.type);
          if (v === null) continue;
          const src = this.aggSource(v, slotText(info.type), '    ', this.globalInit);
          this.copyArr(`(var ${info.name})`, src, info.type, '    ', this.globalInit);
        }
        continue;
      }
      if (this.declareGlobal(dcl, info) === null) continue;
      // 模块级的类变量（第五十二刀）：jancy 那边它是**静态分配**的（"class variables of
      // global scope are allocated statically"，type_class.rst 的 Construction 一节），
      // 而这一层的"造对象"是一句 pnew —— 排在 globalCells 那一段，也就是所有初值之前。
      if (isClass(info.type) && info.type.own === true) {
        if (this.gLifted.has(info.name)) {
          this.nope(dcl, `对模块级的类变量取地址（&${shown(info.name)}）—— 那要一格 \`C**\``);
          continue;
        }
        if (initNode !== null) {
          this.err(initNode, `'${shown(info.name)}' 是类的变量，赋不了值（type_class.rst:19 那句 `
            + '"You cannot assign varibles or fields of class types"）');
          continue;
        }
        this.globalCells.push(`    (set ${info.name} (pnew ${tyText(info.type)} (int 1)))`);
        // 动态类型那一格（第五十七刀）：与 pnew 挨着，排在所有构造之前。
        const tg = this.tagStore(dcl, info.type.name, `(var ${info.name})`, '    ');
        if (tg === null) continue;
        this.globalCells.push(tg);
        // 构造排在 globalInit 那一段（第五十三刀）：所有 pnew 先做完，构造里读到别的模块级
        // 变量时它才不是空指针 —— 与第二十四刀那条"两阶段"是同一个理由。实参在**模块作用域**
        // 里求（没有局部量、没有取地址、不在 unsafe 里），与 globalValue 那一处同一条。
        const saveScopes = this.scopes;
        const saveLifted = this.lifted;
        const saveUnsafe = this.unsafe;
        this.scopes = [];
        this.lifted = new Set();
        this.unsafe = false;
        const ok = this.ctorCall(dcl, info.type.name, `(var ${info.name})`, info.ctor, '    ',
          this.globalInit);
        this.scopes = saveScopes;
        this.lifted = saveLifted;
        this.unsafe = saveUnsafe;
        if (ok === null) continue;                 // 报过错了
        continue;
      }
      // 结构体的模块级变量：与局部量一样先开一格自己的内存，再（有初值的话）逐字段抄。
      if (jncIsStruct(info.type)) {
        const st = slotText(info.type);
        this.globalCells.push(`    (set ${info.name} (pnew ${st} (int 1)))`);
        if (initNode !== null) {
          const v = this.globalValue(initNode, info.type);
          if (v === null) continue;
          const src = this.aggSource(v, st, '    ', this.globalInit);
          this.copyAgg(`(var ${info.name})`, src, info.type.name, '    ', this.globalInit);
        }
        continue;
      }
      if (initNode === null) continue;              // 零初始化，方言已经做了
      const v = this.globalValue(initNode, info.type);
      if (v === null) continue;
      // 提到一格内存里去的那些（第二十四刀）写的是那一格，不是全局本身
      this.globalInit.push(this.gLifted.has(info.name)
        ? `    (pstore (var ${info.name}) ${v})`
        : `    (set ${info.name} ${v})`);
    }
    return null;
  }

  /** `int g[3] = { 1, 2, 3 };` / `Point g = { 1, m_z = 3 };` 在顶层。与局部量同一份引擎。 */
  globalDeclCurly(n) {
    const sp = this.specs(n.items[1]);
    if (sp === null) return null;
    const dcl = n.items[2];
    const info = this.declarator(dcl, sp);
    if (info === null) return null;
    if (info.formals !== null) return this.nope(dcl, '函数上的花括号初始化');
    info.name = this.qual(info.name);            // 第五十一刀，与 globalDecl 同一条
    const curly = n.items[3];
    if (!isList(curly) || head(curly) !== 'curly') return this.err(n, '认不出的花括号初始化');
    const t = this.curlyType(n, info, curly);
    if (t === null) return null;
    if (this.declareGlobal(dcl, { name: info.name, type: t }) === null) return null;
    // 数组也是**一格**了（第十九刀）：那一格里躺的是一整块的地址，所以个数一律是 1。
    const st = slotText(t);
    this.globalCells.push(`    (set ${info.name} (pnew ${st} (int 1)))`);
    // 全局这一侧不用 shadow：那一格是 `(global …)`，没有"初值之后才发 let"这回事。
    const plan = this.curlyPlan(curly, t, '    ', this.globalInit, {
      shadow: null,
      val: (node, want) => this.globalValue(node, want, true),
    }, [], []);
    if (plan === null) return null;
    this.curlyEmit(plan, `(var ${info.name})`, '    ', this.globalInit);
    return null;
  }

  /** 一格全局的登记：查重、挡下方言落不了地的类型，再发 `(global …)`。
   *
   *  被 `&` 取过地址的**标量**全局在这儿改形状（第二十四刀）：那一格发成 `(ptr T)`，
   *  真正的值躺在 `(pnew (ptr T) (int 1))` 出来的一格里 —— 与第九刀对局部量做的是同一件事，
   *  方言一个字没改（指针类型的全局五条腿本来就都收）。聚合与数组不走这儿：它们那一格里
   *  放的**本来就是**一段内存的地址，`&g` 就是它自己。 */
  declareGlobal(dcl, info) {
    if (this.globals.has(info.name)) return this.err(dcl, `模块级变量 '${shown(info.name)}' 声明了两次`);
    if (info.type === J_VOID) return this.err(dcl, `'${shown(info.name)}' 的类型是 void`);
    this.globals.set(info.name, info.type);
    // `&` 数的是**源码里写的**名字（函数体里写的是不带前缀的），所以两个都问一遍 ——
    // 多提一格对不取地址的用法没有可观测差别（第二十四刀那段注释里的同一条理由）。
    const bare = info.name.slice(info.name.lastIndexOf('$') + 1);
    if ((this.gTaken.has(info.name) || this.gTaken.has(bare)) && this.liftable(info.type)) {
      this.gLifted.add(info.name);
      const pt = `(ptr ${tyText(info.type)})`;
      this.decls.push(`  (global ${info.name} ${pt})`);
      this.globalCells.push(`    (set ${info.name} (pnew ${pt} (int 1)))`);
      return info;
    }
    this.decls.push(`  (global ${info.name} ${slotText(info.type)})`);
    return info;
  }

  /**
   * 模块级变量的初值。它在**模块作用域**里求：没有局部量、没有被取地址的名字、没有
   * 返回类型，所以那三样先清空再降 —— 不然会读到上一个函数留下的状态。
   */
  globalValue(node, want, isElem) {
    const saveScopes = this.scopes;
    const saveLifted = this.lifted;
    const saveRet = this.retTy;
    const saveUnsafe = this.unsafe;
    this.scopes = [];
    this.lifted = new Set();
    this.retTy = J_VOID;
    this.unsafe = false;
    let v = this.expr(node, want);
    this.scopes = saveScopes;
    this.lifted = saveLifted;
    this.retTy = saveRet;
    this.unsafe = saveUnsafe;
    if (v === null) return null;
    if (isInt(v.type) && isInt(want)) v = intConv(v, want);
    if (!this.assignOk(v.type, want)) {
      this.err(node, isElem === true
        ? `这一项是 ${tyName(v.type)}，而元素是 ${tyName(want)}`
        : `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(want)}`);
      return null;
    }
    return v.code;
  }

  /** `struct S { … }`。jancy 的 struct 是**值**类型（POD），所以降成方言的 `(struct …)`
   *  而不是 `(class …)` —— 与 asy 那边恰好相反（asy 的 struct 是引用类型，量过）。
   *
   *  名字与字段分成两遍（第十七刀）：`Node* m_next` 要在 Node 自己的体里就查得着
   *  Node。所以先把每个名字连着一个**空的**字段数组坐下（typeName），再原地填 ——
   *  memberOf 是在函数体降级的时候才查这张表的，那时候早填完了。 */
  /**
   * `E.M` —— 枚举成员（第三十九刀）。左边不是"某个枚举的名字"时返回 `undefined`，那就是普通的
   * 字段访问，交给 lvalue 那一支。同名的变量优先当变量看（那样才轮不到这条）。
   */
  /** 无名枚举漏到外面那层的一格成员（第九十六刀）：裸名字查得着就回那一格字面量。 */
  exposedLit(nm) {
    const k = this.resolve(nm, (x) => this.exposedMems.has(x));
    if (k === null) return null;
    const { en, mn } = this.exposedMems.get(k);
    const info = this.enums.get(en);
    if (info === undefined || !info.members.has(mn)) return null;
    return {
      code: `(int ${info.members.get(mn)})`,
      type: { k: 'enum', name: en, base: info.base, bits: info.bits === true },
    };
  }

  /**
   * `'a'` / `'\xa1\xb2\xc3\xd4'` —— 单引号那一格是个**整数**（第九十七刀）。
   *
   * jancy 的词法直接把它做成 `TokenKind_Integer`：头一个字节**最重**、最多 8 个字节，
   * 多出来的截掉（jnc_ct_Lexer.cpp:186-197）：
   *
   *   uint64_t result = 0; uint_t shift = 8 * (length - 1);
   *   for (; p < end; p++, shift -= 8) result |= *(uchar_t*)p << shift;
   *
   * 所以 `'a'` 是 97，`'ab'` 是 0x6162，`'\xa1\xb2\xc3\xd4'` 是 0xa1b2c3d4。类型走的是
   * 与别的整数字面量同一条（装得下就 int、装不下就 long，见 intLit）—— 那句"装不下"正是
   * `0xa1b2c3d4` 这一格：它是 long，赋进 32 位的枚举成员时按那一格回卷。
   *
   * 转义在词法那一遍就解开了（glr/lex.js 的 scanString），所以这儿看到的是解好的那串。
   * 怎么数字节：`\xa1` 这种转义要的是**一个字节**（jancy 那边它就是源码里那一个字节），
   * 所以每一格码位 < 256 时按 latin1 数；真有非 ASCII 的字符写在引号里时按 UTF-8 数
   * （jancy 那边源码就是 UTF-8 的字节流）。
   */
  charLit(n) {
    const s = isStr(n.items[1]) || isAtom(n.items[1]) ? n.items[1].value : null;
    if (s === null) return this.err(n, '认不出的字符字面量');
    if (s === '') return this.err(n, "空的字符字面量（`''`）");
    const cps = [...s].map((c) => c.codePointAt(0));
    const raw = cps.every((c) => c < 256);
    const bytes = [];
    for (const cp of cps) {
      if (raw || cp < 0x80) { bytes.push(cp); continue; }
      // UTF-8 手写一遍（这一层自举时没有 Buffer）
      if (cp < 0x800) { bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); continue; }
      if (cp < 0x10000) {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        continue;
      }
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    let v = 0n;
    for (const b of bytes.slice(0, 8)) v = (v << 8n) | BigInt(b);
    return this.intLit(n, v);
  }

  enumMember(n, ob, mem) {
    // 左边可以是**限定名**（`a.Color`，第五十一刀）：那在表达式里是一串 `field`。
    if (!isList(ob) || (head(ob) !== 'name' && head(ob) !== 'field')) return undefined;
    const en0 = this.dotted(ob);
    if (en0 === null) return undefined;
    let en = this.resolve(en0, (k) => this.enums.has(k));
    /* 名字是一格 alias / typedef 起的（第八十七刀）：`alias Hue = Color;` 之后 `Hue.Green`
       与 `Color.Green` 是同一格。别名表里存的是解出来的那一格类型，所以问它的 name。 */
    if (en === null) {
      const a = this.resolve(en0, (k) => this.aliases.has(k));
      const t = a === null ? null : this.aliases.get(a);
      if (t !== null && t !== undefined && t.k === 'enum' && this.enums.has(t.name)) en = t.name;
    }
    if (en === null) return undefined;
    if (this.lookupRef(en0) !== null) return undefined;
    const info = this.enums.get(en);
    const mn = isAtom(mem) ? mem.value : this.qname(mem);
    if (mn === null || !info.members.has(mn)) {
      /* 正在算某个枚举成员的初值、而且还是第一遍（第一百四十一刀）：**别报**。那个枚举可能
         排在后面、成员表还没填 —— 报出来就是"枚举 B 里没有 P"，一句指着别处的话。
         回 undefined 让 constInt 算不出来，由 enumDecl 那儿记进重试名单。 */
      if (this.constEnum !== null && !this.enumRetry) return undefined;
      /* 名字**在**，只是它的值这一层算不出来（第二百三十四刀）：
         `ReadMode = SerialReadMode.WaitFirstChar`（SerialSession.jnc:26 —— 引的是另一个模块里
         的枚举，逐份口径那笔账）。那一句已经报过一次了（`枚举成员的值算不出来`），这儿再说
         "里没有它"是**认错人**，而且把一件事记成两笔。所以指回那一句。 */
      if (mn !== null && info.unvalued !== undefined && info.unvalued.has(mn)) {
        return this.nope(n, `枚举 '${shown(en)}' 的 '${mn}' 声明是在的，可它的值这一层算不出来`
          + '（上面那一句已经报过）—— 名字在、值不在，所以这儿用不上它');
      }
      return this.err(n, `枚举 '${shown(en)}' 里没有 '${mn}'`);
    }
    return {
      code: `(int ${info.members.get(mn)})`,
      type: { k: 'enum', name: en, base: info.base, bits: info.bits === true },
    };
  }

  /**
   * `flags.ReadOnly` —— 从一格**值**上问成员（第四十七刀）。左边不是"枚举类型的变量"时返回
   * `undefined`，那就是普通的字段访问。
   *
   * jancy 那边这一条是 `getEnumTypeMember`：查到成员之后**发一次二元运算** ——
   * `bitflag` 枚举发 `BinOpKind_BwAnd`、普通枚举发 `BinOpKind_Eq`
   * （jnc_ct_OperatorMgr_Member.cpp:592-618）。所以：
   *
   *   flags.ReadOnly   ->  flags & FileFlags.ReadOnly    （bitflag：那一位在不在，结果是枚举）
   *   state.Idle       ->  state == State.Idle           （普通枚举：是不是它，结果是 bool）
   *
   * 逼出它的是语料 test55.jnc:22 的 `if (flags.ReadOnly)` —— 配上"枚举能当条件用"
   * （truthy 那一处）刚好读成"这一位置上了吗"。
   *
   * 只收左边是**一个名字**的形状：那一步查表是纯的（`lookupRef`，不发一个字）。
   * `f().Flag` 这类要先求值才知道类型的形状还不收 —— 见 bad/enum-val-member-call.jnc。
   */
  enumValueMember(n, ob, mem) {
    if (!isList(ob) || head(ob) !== 'name') return undefined;
    const nm = this.qname(ob);
    if (nm === null) return undefined;
    const r = this.lookupRef(nm);
    if (r === null || !jncIsEnum(r.type)) return undefined;
    const info = this.enums.get(r.type.name);
    if (info === undefined) return undefined;
    const mn = isAtom(mem) ? mem.value : this.qname(mem);
    if (mn === null || !info.members.has(mn)) {
      /* 名字**在**，只是它的值这一层算不出来（第二百三十四刀）：`ReadMode = SerialReadMode.WaitFirstChar`
         那一族（SerialSession.jnc:26 —— 引的是另一个模块里的枚举，逐份口径那笔账）。那一句
         已经报过一次了（`枚举成员的值算不出来`），这儿再说"里没有它"就是**认错人**、而且是
         把一件事记成两笔。所以指回那一句。 */
      if (mn !== null && info.unvalued !== undefined && info.unvalued.has(mn)) {
        return this.nope(n, `枚举 '${r.type.name}' 的 '${mn}' 声明是在的，可它的值这一层`
          + '算不出来（上面那一句已经报过）—— 名字在、值不在，所以这儿用不上它');
      }
      return this.err(n, `枚举 '${r.type.name}' 里没有 '${mn}'`);
    }
    const v = this.expr(ob, null);
    if (v === null) return null;
    const k = `(int ${info.members.get(mn)})`;
    if (r.type.bits === true) return { code: `(bin "&" ${v.code} ${k})`, type: r.type };
    return { code: `(bin "==" ${v.code} ${k})`, type: J_BOOL };
  }

  typeName(n) {
    if (!isList(n)) return null;
    if (head(n) === 'enum') return this.enumName(n);
    if (head(n) !== 'agg') return null;                    // 下面那一遍报
    const key = isAtom(n.items[1]) ? n.items[1].value : null;
    const cls0 = aggCls(key);
    if (key !== 'struct' && key !== 'union' && !cls0) return null;
    const nm0 = this.qname(n.items[2]);
    if (nm0 === null) return null;
    const name = this.qual(nm0);
    if (this.structs.has(name)) {
      return this.err(n, `${aggWord(key, cls0)} '${shown(name)}' 声明了两次`);
    }
    this.structs.set(name, []);
    /* 结构体的基类（第一百二十五刀）要**按声明去找基类那张字段表**，而顶层的 type-decl
       不保证先声明后使用 —— 所以这一遍顺手把节点连当时那一层命名空间记下来，
       typeDecl 那一遍碰上基类还没摊开时就地把它先摊了（见 structBaseFields）。 */
    if (!cls0) this.structNodes.set(name, { node: n, ns: this.ns });
    // 类的名字另记一格（第五十二刀）：字段表与结构体共用，可"变量里放地址还是放那段内存"
    // 两者相反，所以类型那一格要分得清。
    if (cls0) this.classes.add(name);
    // `opaque class` 再记一格（第六十六刀）：这一层不读它 —— 那一位管的是"体外还有多少
    // 字节"与"能不能 new / 能不能被继承"，两者都要宿主登记的 OpaqueClassTypeInfo 才知道
    // （StructType.cpp:203-227）。记下来是为了那一天有宿主面时，规矩有地方落。
    if (key === 'opaque class') this.opaques.add(name);
    return null;
  }

  /**
   * 枚举的名字先坐下（与结构体同一条理由：字段与别名要在体解出来之前查得着这个名字）。
   * `bitflag enum` 是同一格上的一个开关（第四十七刀）：取值序列换成 1/2/4/8，`|` `&` `^`
   * 的结果类型另有规矩，还有"0 可以隐式赋进去"（type_enum.rst:66-73）。
   */
  enumName(n) {
    const key = isAtom(n.items[1]) ? n.items[1].value : null;
    if (key !== 'enum' && key !== 'bitflag enum') { this.nope(n, `'${key}'`); return null; }
    const name = this.enumSelfName(n);
    if (name === null) return this.err(n, '认不出的枚举名字');
    if (this.enums.has(name) || this.structs.has(name)) {
      return this.err(n, `类型名 '${shown(name)}' 重复定义`);
    }
    this.enums.set(name, {
      base: J_I32, members: new Map(), bits: key === 'bitflag enum',
      /* 值算不出来、于是没进 `members` 的那几格成员（第二百三十四刀）：名字**declared 过**，
         所以后面用到它时那句"枚举里没有它"是认错人。记在这儿，好在那一处说准。 */
      unvalued: new Set(),
      /* 成员漏到外面那层的两种（第九十六刀 + 第二百一十六刀）：无名的那一种天生如此
         （jancy: "unnamed enums imply 'exposed' anyway"，jnc_ct_EnumType.cpp:410），
         带名字的那一种要 `pragma(ExposedEnums, true)` 开着才是。 */
      anon: this.anonEnum.has(n) || this.exposedEnums.has(n),
    });
    return null;
  }

  /**
   * 一格枚举声明的名字（第九十六刀）。语法树里无名的那一种是 `(enum key (anon) …)`
   * （jnc.grammar 的 enum 规则第二条）—— jancy 那边它**隐含 exposed**：
   *
   *   if (name.isEmpty()) { flags |= EnumTypeFlag_Exposed; … }   // Parser.cpp:2587-2589
   *   flags &= ~EnumTypeFlag_Exposed; // unnamed enums imply 'exposed' anyway
   *                                                             // EnumType.cpp:409-411
   *
   * 也就是成员直接坐在**外面那层命名空间**里（`Namespace.cpp:736` 那句注也在说这件事：
   * "exposed enum, not unnamed"）。这一层给它编一个碰不到的名字（`$anon<序号>`，`$` 不在
   * jancy 的标识符里），成员照旧记在那一格枚举上、类型也还是那一格枚举 —— 只是**另外**
   * 记一张"裸名字 -> 那一格成员"的表（exposedMems），查名时多问一次。
   */
  enumSelfName(n) {
    const nm1 = this.qname(n.items[2]);
    if (nm1 !== null) return this.qual(nm1);
    const a = n.items[2];
    if (!isList(a) || head(a) !== 'anon') return null;
    const had = this.anonEnum.get(n);
    if (had !== undefined) return had;
    const made = this.qual(`$anon${this.anonEnum.size + 1}`);
    this.anonEnum.set(n, made);
    return made;
  }

  /**
   * 枚举的体（第三十九刀）。三条规矩，出处都在 type_enum.rst：
   *   - **成员带命名空间**（17 行）：只能写 `Color.Red`，不往父命名空间里漏。
   *   - **可以指定基类型**（21 行那个例子 `enum IcmpType: uint8_t`）。不写时是 32 位有符号。
   *   - **自动取值** 0、1、2……；写了显式值之后从那个值接着数。
   * 值按基类型那一格回卷（与别处同一个 wrapTo），所以存进表里的就是规范形。
   */
  enumDecl(n) {
    const name = this.enumSelfName(n);
    if (name === null) return null;
    const info = this.enums.get(name);
    if (info === undefined || info.members.size > 0) return null;   // 上一遍报过重复了
    const bn = n.items[3];
    if (!(isList(bn) && head(bn) === 'no-base')) {
      const sp = this.specs(bn);
      if (sp === null) return null;
      // 底类型是**另一个枚举**在 jancy 那边是合法的：`EnumType::isBaseType` 的第一句就是
      // `m_baseType->getTypeKind() != TypeKind_Enum` 的快速退出（jnc_ct_EnumType.cpp:106-121），
      // 而"到基枚举"是那一族里唯一的**隐式**转换（jnc_ct_CastOp_Int.cpp:307）。这一层没做，
      // 所以这里得说"还不收"而不是"你写错了"（第五十刀改的）。
      if (jncIsEnum(sp.type)) {
        this.nope(bn, `枚举的底类型是另一个枚举（${tyName(sp.type)}）—— 要枚举之间的基类链`);
        return null;
      }
      if (!isInt(sp.type)) { this.err(bn, `枚举的基类型要是整数，这里是 ${tyName(sp.type)}`); return null; }
      info.base = sp.type;
    }
    let next = info.bits ? 1n : 0n;
    for (const m0 of this.flat(n.items[4])) {
      const m = unattr(m0);            // 属性收下不看（第一百〇八刀）
      if (!isList(m) || head(m) !== 'enum-item') { this.err(m, '认不出的枚举成员'); continue; }
      const mn = isAtom(m.items[1]) ? m.items[1].value : this.qname(m.items[1]);
      if (mn === null) { this.err(m, '认不出的枚举成员名字'); continue; }
      if (info.members.has(mn)) { this.err(m, `枚举 '${shown(name)}' 里 '${mn}' 出现了两次`); continue; }
      /* 自动取值真要用上一格算出来的那个数时，才问一句"它还装得下吗"（第一百四十二刀）：
         上一格已经是最高位（`0x8000000000000000`）的话，"再往上一位"就出了这一格的宽度。
         jancy 那边这一步是 `2 << getHiBitIdx64(value)`，移出去之后是 0 —— 那是把两个成员
         悄悄取成同一个值。宁可明说。 */
      if (m.items[2] === undefined && info.bits) {
        const bw0 = info.base !== undefined && info.base.w !== undefined ? info.base.w : 32;
        if (next >= (1n << BigInt(bw0))) {
          this.nope(m, `bitflag enum '${shown(name)}' 里 '${mn}' 的自动取值超出了 ${bw0} 位`
            + '（上一格已经是最高位，"再往上一位"就没了）');
          continue;
        }
      }
      if (m.items[2] !== undefined) {
        this.constEnum = info;
        const k = this.constInt(m.items[2]);
        this.constEnum = null;
        if (k === null) {
          /* 算不出来（第一百四十一刀）：**先别报**。初值可能引用后面才声明的枚举，那时它的
             成员表还没填。整格枚举退回去（成员表清空、无名枚举漏出去的那几个名字也撤掉），
             记进重试名单，等这一遍走完再来一轮。`enumRetry` 那一遍才真报。 */
          if (!this.enumRetry) {
            info.members.clear();
            for (const [k2, v2] of [...this.exposedMems]) {
              if (v2.en === name) this.exposedMems.delete(k2);
            }
            this.enumTodo.push({ n, ns: this.ns });
            return null;
          }
          this.nope(m.items[2], '枚举成员的值算不出来（要一个编译期整数常量）');
          info.unvalued.add(mn);          // 第二百三十四刀：名字在，只是没值
          continue;
        }
        next = k;
      }
      info.members.set(mn, wrapVal(next, info.base));
      /* 无名枚举的成员漏到外面那层（第九十六刀）。撞了名就当场说清 —— jancy 那边这一格是
         `addItem` 失败，报的是重名。 */
      if (info.anon === true) {
        const outer = this.qual(mn);
        if (this.exposedMems.has(outer)) {
          this.err(m, `无名枚举的成员 '${mn}' 与外面那层已经有的一格同名`);
        } else this.exposedMems.set(outer, { en: name, mn });
      }
      if (!info.bits) { next += 1n; continue; }
      // `bitflag enum` 的下一格（第四十七刀）。照抄 `calcBitflagEnumConstValues`
      // （jnc_ct_EnumType.cpp:286-306）那一句：`value = value ? 2 << getHiBitIdx64(value) : 1`
      // —— **不是**乘二，是"最高位再往上一位"。所以显式写了 `0x20` 之后下一个是 `0x40`，
      // 而显式写了 `0x30`（两个位）之后下一个也是 `0x40`。
      /* bitflag 的下一格按**无符号那一面**算（第一百四十二刀）。
         `Foldable = 0x8000000000000000`（log_RecordCode.jnc:18）在 64 位那一格里存的就是最高位，
         按 signed 看是负数 —— 而 jancy 的 `getHiBitIdx64` 收的是 `uint64_t`，它从来没见过负数。
         先前这一层按 signed 判负、当场拒，可那样的成员**根本不需要下一个值**（它常常就是最后
         一个）：拒它是把"下一个算不出来"记到了"这一个"头上。
         所以这儿只算，不判；算出来超出这一格的宽度也先不报 —— 等真有下一个成员要用它的时候
         再报（见循环开头那一问）。 */
      const bw = info.base !== undefined && info.base.w !== undefined ? info.base.w : 32;
      const uv = next < 0n ? next + (1n << BigInt(bw)) : next;
      next = uv === 0n ? 1n : 2n ** BigInt(uv.toString(2).length);
    }
    return null;
  }

  /**
   * 还收不下的特殊成员（第五十三刀）。`construct` 与 `static construct` 这一刀收了，剩下两格：
   *
   *   - `destruct`：jancy 自己的文档就说它在 GC 世界里**不是确定时机**的 —— "the destructor
   *     is called by the garbage collector at an unspecified moment"（disposable.rst:17，
   *     那一节讲的正是"要确定时机就用 `dispose` / `nestedscope`"）。所以它不是"把析构调上"
   *     那么一句话的事：要么先有 GC，要么就是在骗人。
   *   - `get` / `set`：属性那一整套（`property` / `bindable` / `autoget`），另一刀。
   */
  specialNope(n, sk) {
    if (sk === 'destruct') {
      return this.nope(n, "'destruct' —— jancy 那边它是 GC 在**不确定的时刻**调的"
        + '（disposable.rst:17），要确定时机得先有 dispose/nestedscope 那一套');
    }
    return this.nope(n, `'${sk}'（要属性那一套：property / bindable / autoget）`);
  }

  typeDecl(n) {
    if (isList(n) && head(n) === 'enum') return this.enumDecl(n);
    if (!isList(n) || head(n) !== 'agg') return this.nope(n, '带体的命名类型（只收 struct、class 与 enum）');
    const key = isAtom(n.items[1]) ? n.items[1].value : null;
    const cls = aggCls(key);
    if (key !== 'struct' && key !== 'union' && !cls) return this.nope(n, `'${key}'（只收 struct、union 与 class）`);
    const nm3 = this.qname(n.items[2]);
    if (nm3 === null) return this.err(n, `认不出的${aggWord(key, cls)}名字`);
    const name = this.qual(nm3);
    // 已经就地摊过了（第一百二十五刀：谁把它当基类，谁就先把它摊了）—— 别摊第二遍
    if (!cls && this.laidStructs.has(name)) return null;
    /* 顶层**带名字**的 union（第二百一十三刀）。语料里只有 5 处声明
       （io_SocketAddress.jnc:97 / :154 / :403、SerialTapPro.jnc:64、test19.jnc:27），
       可 `io.SocketAddress` 一个名字就在 95 份文件里当类型用 —— 先前它落在
       `'union'（只收 struct 与 class）` 那句上，于是那 95 份连带报 `没有这个类型`。

       落法就是把第一百一十刀那一套**整格**借过来：这一层的字段表是摊平的，"它们共用一段
       字节"只体现在发出去的那一句里（`uni` 相同的一串括成 `(union …)`，ADR-0027）。所以带
       名字的 union 就是"一格结构体，它的全部字段是同一组 union" —— unionMembers 那一遍
       连 bigendian 成员（Address_ip4 的 `bigendian uint32_t m_i32`）、套在里头的匿名 struct
       与那组里的位域（SerialTapProBits 的 `uint16_t m_dataBits : 8`）都已经会接。

       jancy 那边 `UnionType` 也是从 `StructType` 派下来的（jnc_ct_UnionType.h），差的只是
       calcLayout 里每格字段的偏移都是 0 —— 与这儿一句话。

       基类先不收：jancy 那句 "it's ok to inherit from structs and even unions"
       （type_class.rst:218）说的是**拿 union 当基类**，"union 自己有基类"语料里一处都没有。 */
    if (key === 'union') {
      if (this.flat(n.items[3]).length > 0) return this.nope(n, 'union 自己带基类');
      const uf = this.structs.get(name);
      if (uf === undefined || uf.length > 0) return null;   // 上一遍已经报过重复了
      const saveNs0 = this.ns;
      this.ns = name;                                       // 体里裸写的名字从这一层查起（第一百二十四刀）
      const ms = this.unionMembers(n, false, name, 0);
      this.ns = saveNs0;
      if (ms === null) return null;
      for (const mm of ms) uf.push({ name: mm.name, type: mm.type, uni: 'u0' });
      this.laidStructs.add(name);
      this.decls.push(`  (struct ${name} ${unionGroups(uf).join(' ')})`);
      return null;
    }
    const bases = this.flat(n.items[3]);
    // 基类（第五十六刀 + 第九十四刀）。jancy 的模型是**多继承**（type_class.rst:171-174：
    // "a simple multiple inheritance model (multiple instances of shared bases -- if any)"）。
    // 第五十六刀只接单继承；第九十四刀把"多个基类"这一格收下了 —— 第一格是链的脊梁，第二格起
    // 在这一层与第一格同待遇（见 mixins 那处的注）。剩下两格还没收：**共享基类各一份实例**
    // （一条链一格结构体，同一个基类只有一份 —— classLayout 那儿当场拒），以及结构体当基类
    // （同一处:218 那句 "it's ok to inherit from structs and even unions"，那要"结构体也能
    // 当一层基类"，是自己一格）。
    let preBase = null;                  // 基类那几格字段（第一百二十五刀），下面 fields 拿到手再排进去
    if (bases.length > 0 && !cls) {
      /* 结构体的基类（第一百二十五刀）：jancy 收它（type_class.rst:218 那句 "it's ok to
         inherit from structs and even unions"），而在这一层它是**纯布局**的一件事 ——
         基类那几格字段排在前面，自己的排在后面。`pfield` 按名字找，名字都在同一张表里，
         所以上转（`Base* b = &d` 那种写法）不需要任何一条新指令：`D` 的前缀本来就是 `B`。
         语料里 50 处声明（22 份文件），`struct Point3D: Point` / `struct termios2: termios` /
         Modbus 那一族全是这个形状 —— 纯数据、只继承字段。 */
      preBase = this.structBases(n, name, bases);
      if (preBase === null) return null;
    }
    let base = null;
    const extra = [];
    for (let i = 0; cls && i < bases.length; i++) {
      const bn = this.qname(bases[i]);
      if (bn === null) { this.nope(bases[i], '认不出的基类名字'); continue; }
      const b = this.resolve(bn, (k) => this.classes.has(k));
      if (b === null) {
        if (this.resolve(bn, (k) => this.structs.has(k)) !== null) {
          this.nope(bases[i], `拿结构体 '${bn}' 当基类（jancy 收它，type_class.rst:218）`);
          continue;
        }
        this.err(bases[i], `没有这个基类：'${bn}'`);
        continue;
      }
      if (b === name) { this.err(bases[i], `'${shown(name)}' 拿自己当基类`); continue; }
      if (base === null) base = b;
      else if (b === base || extra.includes(b)) {
        this.err(bases[i], `'${shown(name)}' 的基类里 '${shown(b)}' 写了两遍`);
      } else extra.push(b);
    }
    const fields = this.structs.get(name);
    if (fields === undefined || fields.length > 0) return null;   // 上一遍已经报过重复了
    // 基类那几格排在最前面（第一百二十五刀）—— 顺序就是布局，所以这一句得在自己的字段之前
    if (preBase !== null) for (const f of preBase) fields.push({ ...f });
    const inits = [];                    // 带默认值的那几格（第七十八刀）
    const evts = [];                     // 事件那几格（第八十三刀）—— 造对象时要建单子
    const bs = { last: null };           // 位域分组的游标（第一百一十二刀，见 bitSlot）
    // 类体里查名从**这个类**这一层起（第五十二刀）：嵌套类型在 nsFlat 那一遍登记成了 `C.S`，
    // 而字段与方法原型写的是裸名字 `S`（test97.jnc:8）。
    /* **结构体也一样**（第一百二十四刀）：体里的 `typedef` 从这一刀起也提到顶层、名字记成
       `S$Num`，那么体里裸写的 `Num` 就得从 `S` 这一层查起。这一句不等于"结构体全面变成一层
       命名空间"—— 嵌套类型、带名字的 union 那几条界各自的 nope 都还在原处，这儿只是把
       **查名的起点**与"名字已经记在哪一层"对齐了（方法从第一百〇一刀起就记在 `S$m` 上，
       所以起点本来就该是这一层，先前是欠着的）。 */
    const saveNs = this.ns;
    this.ns = name;
    for (const m0 of this.flat(n.items[4])) {
      const m = unattr(m0);            // 属性收下不看（第一百〇八刀）
      if (isList(m) && head(m) === 'empty-stmt') continue;
      // 访问控制（第五十二刀）。jancy 只有 public 与 protected 两种，**默认 public**
      // （type_class.rst:23-27），两种写法（C++ 式的 `public:` 与 Java 式的前缀）都收。
      // 这一层不做可见性检查 —— 那是"拒得更严"，不影响能跑的程序的行为。
      if (isList(m) && head(m) === 'access') continue;
      // 嵌套类型（`class C { struct S { … } }`）在 nsFlat 那一遍已经提到顶层了（名字是
      // `C.S`），这儿跳过。结构体里的嵌套类型照旧不收 —— 那要先有"结构体也是一层命名空间"。
      if (isList(m) && head(m) === 'type-decl') {
        /* 结构体里的**匿名 union**（第一百一十刀）：语法上它是一格 agg —— key 是 `union`、
           名字是 `(anon)`。方言那一层从 ADR-0027 起认 `(union (名字 类型) …)`（几格成员共用
           同一个偏移），所以这儿把成员摊出来、当**一格字段**放进去就完了。
           语料里的出处：`io_DeviceMonitorNotify.jnc:59` 那一族协议头（同一块字节按两个名字读）。
           带名字的 union 与类里的 union 照旧不收：前者要"结构体也是一层命名空间"，
           后者方言那边本来就只给结构体（类是引用、字段在堆上那一格里）。 */
        const ag = m.items[1];
        const ak = isList(ag) && head(ag) === 'agg' && isAtom(ag.items[1]) ? ag.items[1].value : null;
        const anon = ak !== null && isList(ag.items[2]) && head(ag.items[2]) === 'anon';
        if (ak === 'union' && anon && !cls) {
          const ms = this.unionMembers(ag, cls, name, fields.length);
          if (ms !== null) {
            /* 成员**摊平**进这张字段表 —— 这一层查名（memberOf / 字段的默认值那几处）看的就是
               它，所以 `hdr.m_pid` 一处都不用改。"它们是一格 union" 记在 `uni` 上，只在发
               `(struct …)` 那一句时用来把这一串括回去（见下面拼 fs 那一处）。 */
            const gid = `u${fields.length}`;
            bs.last = null;              // 一格 union 隔在中间就断开上一组位域
            for (const mm of ms) fields.push({ name: mm.name, type: mm.type, uni: gid });
          }
          continue;
        }
        // 别的嵌套类型（结构体那一侧也算，第二百三十刀）在 nsFlat 那一遍已经提到顶层了
        continue;
      }
      // 体内写的方法（`void foo() { … }`）在 nsFlat 那一遍已经提到顶层了，这儿跳过 ——
      // `construct` / `static construct` 从第五十三刀起也在提上去的那一批里。剩下那些特殊
      // 成员没提，就地报。
      if (isList(m) && head(m) === 'fn-def') {
        /* 结构体里的方法（第一百〇一刀）：jancy 的 struct 也是一层命名空间、也能有方法。
           这一层落得下来是因为**结构体那一格里放的就是地址**（第十二刀）—— 所以 `this` 就是
           那一格值本身，与类那条路（第五十二刀）落法完全一样：一个自由函数，`this` 当第一个
           形参。体已经由 aggHoist 提到顶层了，这儿跳过。 */
        if (!cls) {
          const sk0 = specialCore(m.items[2]);
          /* `construct` 从第一百二十九刀起收了（体由 aggHoist 提到顶层，与普通方法同一条路），
             所以这儿只拦剩下的那几个。裸写的 `get` / `set` 是**下标算符**那一族
             （第一百三十八刀收了，见 bareAccessor）—— 名字写在前面的 `p.get()` 是属性的取值器，
             那一格照旧提上去。 */
          if (sk0 !== null && sk0 !== 'construct' && !isOpSpecial(sk0)
            && !bareAccessor(m.items[2])
            && !accessorNamed(m.items[2])) {
            this.nope(m, `结构体里的 '${sk0}'`);
          }
          continue;
        }
        /* 类体里**就带着体**的 reactor（第九十五刀）：`reactor m_r { … }`。语料里的惯用法是
           "类里声明、体写在类外"（49/49），可 test16.jnc 这种写法 jancy 也收 —— 那时这一格
           fn-def 既在类体里、又被 nsFlat 提到了顶层，先前只有顶层那一遍看见它，于是登记成了
           `cls: null` 的一格顶层 reactor：体里裸写的字段名从此接不上 this（报"未声明的变量"）。
           在这儿登记才对：两格 bool 字段要赶在 classLayout 之前进 ownFields。 */
        if (this.rctSpecs(m.items[1])) {
          const nm = this.rctDeclName(m.items[2]);
          if (nm === null) { this.err(m, 'reactor 的名字认不出来'); continue; }
          const full = `${name}$${nm}`;
          if (this.reactors.has(full)) { this.err(m, `reactor '${shown(full)}' 声明了两次`); continue; }
          const on = `${full}$on`;
          const bound = `${full}$bound`;
          fields.push({ name: on, type: J_BOOL });
          fields.push({ name: bound, type: J_BOOL });
          this.reactors.set(full, {
            full, cls: name, on, bound, body: m.items[3], node: m,
          });
          this.rctNames.add(nm);
          this.rctInline.add(m);
          continue;
        }
        const sk = specialCore(m.items[2]);
        if (sk !== null && sk !== 'construct' && sk !== 'static construct'
          && !isOpSpecial(sk)                       // 算符重载（第一百三十刀）由 fnSig0 那一遍办
          && !bareAccessor(m.items[2])              // 下标算符（第一百三十八刀）同上
          && !accessorNamed(m.items[2])) this.specialNope(m, sk);
        continue;
      }
      // 体内只写原型、体外补上（`void C.foo();` + `void C.foo() { … }`）—— 两种放法
      // jancy 都收（type_class.rst:41-59）。原型这边一个字都不用发：签名那一遍看的是
      // 体外那个定义。`construct` 的原型同理（体在类外，第五十三刀）。
      if (isList(m) && head(m) === 'fn-proto') {
        const sk = specialCore(m.items[2]);
        if (sk === 'construct' || sk === 'static construct') {
          /* 只有原型的 `construct`（第六十六刀；第一百八十三刀把 `opaque` 那道闸门去掉、
             第一百八十四刀这一格跟上）：体在宿主那边，`new C(…)` 落成
             "造一格 + 写 $tag + `(ccall C_construct self …)`"。理由与方法那一格逐条一样 ——
             `opaque` 说的是布局、不是"体在哪儿"，而"没有体"在 jancy 里不是编译期错误。 */
          if (cls && sk === 'construct') {
            this.hostCtors.add(name);
            /* 形参类型也记下来（第一百六十二刀）：`new C(…)` 据此发 `(ccall C_construct …)`。
               形参表在声明符的后缀里（`(fn-suffix (formals …))`），与 hostSigs 那一格同一遍。 */
            const sfx0 = this.flat(m.items[2].items[3])
              .find((x) => isList(x) && head(x) === 'fn-suffix');
            const hps0 = sfx0 === undefined ? null : this.formalList(sfx0.items[1]);
            if (hps0 !== null) {
              /* 同名好几条 `construct`（第二百〇七刀）：`ui.ComboBox` 上两条 ——
                 `construct();` 与 `construct(ComboItem const* itemArray, size_t count);`
                 （ui_ComboBox.jnc:38/40）。jancy 明写 ctor 可以重载（type_class.rst:63）。
                 先前这张表按名字存**一条**，后一条把前一条盖掉了，于是 `new ComboBox` 报
                 "要 2 个实参，这里给了 0 个"—— 那是"悄悄按其中一条算"，与第一百九十四刀
                 顶层原型那一格是同一笔。改成一格一族，挑哪一条与那儿共用 hostPickSigs。
                 符号名第二条起加 `_o2`（与第一百八十六刀那条规则一样）。 */
              const ds1 = hps0.map((p) => p.def ?? null);
              const one1 = {
                params: hps0.map((p) => p.type),
                defs: ds1.some((d) => d !== null) ? ds1 : null,
              };
              const prevC = this.hostCtorSigs.get(name);
              const sameC = (a, b) => a.params.length === b.params.length
                && a.params.every((t, i) => sameTy(t, b.params[i]));
              if (prevC === undefined) this.hostCtorSigs.set(name, [one1]);
              else if (!prevC.some((x) => sameC(x, one1))) prevC.push(one1);
              /* 原型上那几格默认值也在里头（第一百九十一刀，与方法那一处第一百六十九刀同一条）：
                 `construct(HashFunc thin* h = null, IsEqualFunc thin* e = null);`
                 （std_HashTable.jnc:75-78）—— `new std.HashTable` 一个实参都不给是对的。 */
            }
            /* 那张"只有原型的 construct"表照旧记着（第一百四十八刀）：别处还靠它说话，
               而体外真写了定义时上面这几格用不上（`ctors` 那时有它，几处都先问那张表）。 */
            this.protoCtors.add(name);
          }
          continue;
        }
        /* `opaque class` 里那格**没有体**的 `destruct();`（第九十三刀）：它跟这个类里别的
           原型是同一种东西 —— 体在宿主的 C/C++ 里（opaque.rst:15-29）。所以这一层这儿
           一个字都发不出来，也**不该**发：调它的是 GC，而且是"不确定的时刻"
           （disposable.rst:17）。这一层没有 GC，那个时刻永远不到 —— 收下这一句、不落任何
           代码，是**少做一件本来也看不见时刻的事**，不是把它算错。带体的 destruct 照旧拦
           （specialNope）：那一格是真墙。 */
        if (cls && key === 'opaque class' && sk === 'destruct') continue;
        if (sk === null) this.nope(m, '类里的特殊成员声明');
        else this.specialNope(m, sk);
        continue;
      }
      /* 类体里的 `typedef`（第一百〇六刀）：aggHoist 已经把它提到顶层那一批里、命名空间
         记的是这个类，类型名那一遍会办。这儿跳过就好 —— **结构体那一侧从第一百二十四刀起
         也一样**（结构体的名字早就是一层命名空间了，方法就提在 `S$m` 上）。 */
      if (isList(m) && head(m) === 'typedef') continue;
      /* `friend X;`（第二百四十刀）：**收下不看**。jancy 那边它只往那一格 `m_friendSet` 里
         添个名字（`Parser::addFriends`，jnc_ct_Parser.cpp:997-1010），而那张表只有一个用处 ——
         `FriendSet::isFriend`（jnc_ct_Template.h:150）在**访问检查**那一步问它。这一层**不做
         可见性检查**（第五十二刀立的口径：那是"拒得更严"，不影响能跑的程序的行为），所以
         `public:` / `protected:` 那两个词收下不看，`friend` 是同一件事、同一条理由。
         语料里的原样是 `friend BinTreeBase;` / `friend BinTreeVisitRemoveImpl;`
         （src/jnc_ext/jnc_std/jnc/stdt_BinTree.jnc:22-23，另有 stdt_HashTable / stdt_RbTree）。 */
      /* 类 / 结构体上的**静态**字段带花括号初值（第二百四十一刀）：
         `static string_t const m_stateStringTable[] = { … }`（SerialSession.jnc 那一族）、
         `static int m_table[] = { … }` —— 上一刀量出来那句兜底话剩下的就是它，21 处。
         第二百一十五刀已经把"静态字段 = 命名空间里的一格模块级变量"这条路铺好了，可它接在
         `var-decl` 那一支上，而带花括号初值的那一种在语法上是**另一个 head**（`var-decl-curly`），
         于是落到了兜底话上 —— 那是**欠着的**，不是划的界。顶层那一遍现成就有 `globalDeclCurly`
         （第二十四刀那条路：长度从花括号里数出来、初值一格一格抄），而类体这一遍 `this.ns`
         已经是这个类（第一百二十四刀），交给它就是了 —— 一个字节的新机器都不用造。
         元素类型收不收由**已经在那儿的门**说（`string 的数组` 那笔 ADR-0026 的账照旧自己报）。
         **非静态**的那一种（`string_t m_statusTextTable[] = { … }`，量到 4 处）留着：那要在
         构造里一格一格填，是另一笔账。 */
      if (isList(m) && head(m) === 'var-decl-curly') {
        const csp = this.specs(m.items[1], cls, [], true);
        if (csp !== null && csp.stat) { this.globalDeclCurly(m); continue; }
      }
      if (isList(m) && head(m) === 'friend') continue;
      if (!isList(m) || head(m) !== 'var-decl') {
        this.nope(m, `${cls ? '类' : '结构体'}里除字段以外的成员`);
        continue;
      }
      /* `errcOk` 给 true（第一百九十六刀）：`errorcode` 说的是返回值那件事，结构体的方法上
         也写得（std_Guid.jnc:94）—— 写在**字段**上的由下面那一问拦。 */
      const sp = this.specs(m.items[1], cls, [], true);
      if (sp === null) continue;
      // 成员属性（第六十九刀）：它**不是一格字段** —— 不在这儿把它挑出来就会被当成一格普通
      // 内存，那是"悄悄换了意思"。登记留给下面那一格（run 里属性那一遍，排在签名之前），
      // 这儿只把节点连当时的 ns（就是这个类）攒起来。这一问走 propMod 而不是 `sp.prop`：
      // 那个词也可能写在星号后面（第七十二刀，`Icon* property m_icon;`）。
      if (this.propMod(m.items[1], m.items[2])) {
        /* 结构体的成员属性（第一百九十八刀）：先前这儿一律拒，理由写的是"类才是一层命名空间，
           而取/存那两个函数要从那一层查过来"—— 那句话第一百二十四刀起就不成立了（结构体的名字
           早就是一层命名空间，方法提在 `S$m` 上）。语料里的原样是
           `struct Error { string_t const property m_description thin; }`（std_Error.jnc:75），
           取值器在 jancy 的 C++ 那边（`JNC_MAP_CONST_PROPERTY("m_description",
           Error::getDescription)`，jnc_std_Error.cpp:30）—— 与第一百九十七刀那格方法同一条路。
           登记走的是与类一模一样的那一份（propPend -> propName），`this` 那一格由 selfTy 挑。 */
        // `virtual` / `errorcode` 写在属性上那两条不在这儿拦 —— 与顶层那一格合在 propName 里，
        // 一处一句（见那儿的注释）。
        this.propPend.push({ it: m, ns: this.ns });
        continue;
      }
      /* 类 / 结构体上的**静态字段**（第二百一十五刀）：`static int m_table[10];`
         （01_Classes.jnc:22）、`static int m_staticField = 2;`（03_Storage.jnc）、
         `static char const DefaultCipherSet[] = "ALL";`（ui_SslPropertySet.jnc）那一族，
         语料里 21 份文件。

         jancy 那儿它是**类那一格上的**变量、不在对象里（decl_storage.rst 讲的
         StorageKind_Static；`this` 用不着它）。而这一层早就有一格现成的东西正好是这个意思：
         **命名空间里的模块级变量**（第五十一刀）—— 名字带上前缀 `Owner$m_x`，那个带前缀的
         名字同时就是方言里那一格的名字。类体这一遍 `this.ns` 已经是这个类了（上面那句
         `this.ns = name`，第一百二十四刀），所以整条声明直接交给 globalDecl：
           - 前缀、查重、`(global …)`、取过地址就改形状那几件事全是它那一套（declareGlobal）；
           - 初值也是它那一套（globalCells 里一句 pnew、globalInit 里那几句抄）；
           - 方法体里裸写 `m_x` 走 lookupRef -> resolve（从里往外找 `Owner$m_x`），
             外面写 `Owner.m_x` 走的是同一个名字。
         一个字节的新机器都不用造。 */
      if (sp.stat) { this.globalDecl(m); continue; }
      for (const d0 of this.flat(m.items[2])) {
        /* 类与结构体里的 alias（第八十七刀；结构体那一格是第一百〇二刀 —— 方法既然收了，
           指着方法的别名跟着就成立，`this` 那一格由 selfTy 挑）。
           排在最前 —— 它那一条也长成 `(init …)`，落到下面就会被当成"字段的默认值"。
           类型那一支当场办（类型名那一遍在前面），函数那一支记下来等签名（见 aliasDecl）。 */
        if (sp.als === true) {
          this.aliasDecl(d0, name);
          continue;
        }
        /* 字段的默认值（第七十八刀）。语法形状：`int m_x = 5;` 是 `(init <dcl> <expr>)`
         * （items[1] 是声明符、items[2] 是那个表达式）。落法见构造函数那处 `fieldInitLines`
         * 与 this.fieldInits 的注释 —— 这里只把"哪个字段带什么表达式"记下来，一格都不发。
         *
         * 结构体的还不收：那一格在 jancy 那边也是构造里重放的（嵌套的结构体递归调），
         * 而这一层的结构体没有构造那条路 —— `S s;` 只是一格内存，没有可以插代码的地方。
         * 收下来却不发那几句赋值是个**静默的错答案**，所以明说。 */
        let d = d0;
        let dflt = null;
        if (isList(d0) && head(d0) === 'init') {
          if (!cls) { this.nope(d0, '结构体字段的默认值'); continue; }
          d = d0.items[1];
          dflt = d0.items[2];
        }
        const info = this.declarator(d, sp, null, false, !cls);
        if (info === null) continue;
        // 字段后面挂构造实参（`C1 m_a(10);`）—— jancy 那边它是"内嵌那一格的构造实参"，
        // 而内嵌本身这一层还不收（下面那条），所以这儿先明说，免得实参被悄悄丢掉。
        if (info.ctor !== null) { this.nope(d, '字段后面的构造实参'); continue; }
        /* 类里的事件（第八十三刀，第七十四刀留的账）：`event m_onDone(int code);` ——
         * jancy 那边它就是类里的**一格字段**（与 bindable 属性那格 `m_onChanged` 同一支，
         * jnc_ct_Property.cpp:131-134）。语料里 `event` 全是这个形状
         * （iox_HostNameResolver.jnc:42、iox_FpgaUploader.jnc:80）。
         *
         * 第七十四刀试过一次、退回来了：那时方言的**结构体字段**放不下"一格数组的句柄"
         * （`形参 $this：结构体 'Button' 里有落不进内存的字段`）。那堵墙由 ADR-0024 的
         * S1/S2 拆掉了（`sizeOf((arr T))` 现在是 8，JS 那一族用句柄表），所以这一格能落了。
         *
         * 这一问必须排在"声明符上带括号就是方法原型"那条**之前** —— 否则它会被悄悄登记成
         * 一格返回 void 的方法原型，整格事件就丢了。
         *
         * 结构体里的还不收：那一格要"造出来的时候把单子建起来"，而这一层的结构体没有构造
         * 那条路（与字段的默认值同一条理由，见 bad/fielddefault-struct.jnc）。 */
        if (sp.evt === true) {
          if (!cls) {
            this.nope(d, `结构体里的事件 '${info.name}'（那一格要在造出来的时候把单子建起来，`
              + '而这一层的结构体没有构造那条路）');
            continue;
          }
          const eps = info.formals === null ? [] : this.formalList(info.formals);
          if (eps === null) continue;
          const ety = mcTy(eps.map((p) => p.type));
          fields.push({ name: info.name, type: ety });
          evts.push({ name: info.name, type: ety });
          this.evtNames.add(info.name);
          continue;
        }
        /* 类里的 reactor 成员（第八十五刀）：`reactor m_uiReactor;` —— 语料里 49 处全是这个
         * 形状，体写在类外（`reactor Cls.m_uiReactor { … }`）。jancy 那边它是"一格 reactor
         * 类的字段"（`Parser::declareReactor`，jnc_ct_Parser.cpp:1897-1930 走的是
         * `declareData`）；这一层落成**一格 bool 字段**（跑没跑）+ 几个反应函数，
         * 名字与体由 emitReactors 发。这一问也要排在"带括号就是方法原型"之前。 */
        if (sp.rct === true) {
          if (!cls) {
            this.nope(d, `结构体里的 reactor '${info.name}'（jancy 自己也拒 —— `
              + "\"'%s' cannot contain reactor members\"，jnc_ct_Parser.cpp:1922）");
            continue;
          }
          if (info.formals !== null) {
            this.nope(d, `reactor '${info.name}' 的声明符上带括号（语料里 0 处，`
              + 'reactive.rst:38 那个带括号的写法是旧语法）');
            continue;
          }
          const on = `${name}$${info.name}$on`;
          const bound = `${name}$${info.name}$bound`;
          fields.push({ name: on, type: J_BOOL });
          /* 订阅挂没挂上那一格也是**每个对象自己**的（第八十五刀那一处量出来的：先前它是一格
             模块级 bool，于是第二个对象 start 的时候订阅被跳过、那格 reactor 从此不动）。 */
          fields.push({ name: bound, type: J_BOOL });
          this.reactors.set(`${name}$${info.name}`, {
            full: `${name}$${info.name}`, cls: name, on, bound, body: null, node: d,
          });
          this.rctNames.add(info.name);
          continue;
        }
        // 要在这儿记下来（第五十七刀）—— 体写在类外时那个词只出现在原型上。
        if (info.formals !== null) {
          /* 只有原型的方法记一格（第一百四十七刀）：**结构体那一支也记**，所以要排在下面那句
             `if (!cls) continue` 之前。体外真写了定义时这一格用不上 —— 调用点先按名字查，
             查着了就不问这里。 */
          const ps0 = this.protoMethods.get(info.name);
          if (ps0 === undefined) this.protoMethods.set(info.name, new Set([name]));
          else ps0.add(name);
          /* 收几个实参也记一笔（第一百六十六刀）：调用点给的个数正好是其中一条时，那句话就能从
             "同名的还有只有原型的"改成"合得上的那一条就是它"。 */
          const ak = `${name}$${info.name}`;
          const av = this.protoArity.get(ak);
          const an0 = this.flat(info.formals).length;
          if (av === undefined) this.protoArity.set(ak, new Set([an0]));
          else av.add(an0);
          /* 那些**没有体**的原型（第六十六刀 + ADR-0022 的 J4b；第一百八十三刀去掉 `opaque`
             那道闸门，第一百九十七刀去掉"得是个类"那道）：实现在宿主的 C/C++ 里。名字与**签名**
             都记下来：调用点据此发 `(ccall Owner_method self …)`。体外真写了定义时这一格用不上
             （调用那边先按名字查，查着了就不问这里）。

             **为什么结构体也算**：jancy 那边 `JNC_MAP_FUNCTION` 挂在 `JNC_BEGIN_TYPE_FUNCTION_MAP`
             上，那个宏对类与结构体是同一个（`struct Guid` 的三个方法就是这么映过去的 ——
             jnc_std_Guid.cpp:28-31 的 `isEqual` / `getString` / `parse`）。决定"体在宿主"的只有
             一件事：这个模块里没有那个体。`this` 那一格的类型由 selfTy 挑（结构体那一格里放的
             本来就是地址，第一百〇一刀）。

             **为什么不再看 `opaque`**（第一百八十三刀翻的那条线）：`opaque` 在 jancy 里说的是
             "这个类的**布局**对 jancy 不透明"（opaque.rst 整篇讲的都是字段与大小），它管的不是
             "方法的体在哪儿"。而"没有体的函数"在 jancy 里**不是编译期错误**（量过：它没有那条
             检查），所以我们照着同一个形状办，代价也照实记：写错名字的那种从"编译期一句诊断"
             变成"链接期找不着符号"（与 `(cabi …)` 那条路一样，ADR-0022 的 J4b 早就接受了这一笔）。 */
          {
            const hf = this.hostFns.get(info.name);
            if (hf === undefined) this.hostFns.set(info.name, new Set([name]));
            else hf.add(name);
            const hps = this.formalList(info.formals);
            if (hps !== null) {
              const hk = `${name}$${info.name}`;
              /* 同名两条原型（第一百六十四刀 -> 第一百七十一刀）：按**声明顺序**排成一串，
                 符号名头一条仍叫 `Owner_method`、之后的叫 `Owner_method_o2` / `_o3`…
                 （`$` 不是可移植的 C 标识符字符）。这是**我们自己的约定** —— jancy 那边没有
                 可照抄的推导规则：它的重载是宿主一条条 `JNC_MAP_OVERLOAD` 登记、名字由写
                 绑定的人定。 */
              const prev = this.hostSigs.get(hk);
              /* 原型上那几格默认值也记下来（第一百六十九刀）：`string_t readString(string_t name,
                 string_t defaultValue = null);`（doc_Storage.jnc:43-46）—— 调用点只给一个实参是
                 对的，而先前宿主面那条路只比个数、不补默认值，于是报"要 2 个实参，这里给了 1 个"
                 （逐份榜上 91 处）。与普通调用那一侧用的是同一份 withDefaults。 */
              const hdefs = hps.map((p) => p.def ?? null);
              const one = {
                owner: name,
                ret: info.type,
                params: hps.map((p) => p.type),
                defs: hdefs.some((d) => d !== null) ? hdefs : null,
              };
              if (prev === undefined) this.hostSigs.set(hk, [one]);
              else prev.push(one);
            }
          }
          // 结构体里的方法原型（第一百〇一刀）：签名由体外那个定义给，这儿一个字都不用发。
          if (!cls) continue;
          if (sp.virt !== null) this.methodProto(d, name, info, sp);
          /* 原型上那几格默认值（第一百刀）：只**照着语法树记**，不走 formalList ——
             那一遍会发诊断，而这一格的形参表马上还要由体外那个定义再过一遍。 */
          if (cls) {
            const fs2 = this.flat(info.formals);
            const dn2 = fs2.map((f) => (isList(f) && head(f) === 'formal'
              && f.items[3] !== undefined ? f.items[3] : null));
            if (dn2.some((x) => x !== null)) {
              this.protoDefs.set(`${name}$${info.name}#${fs2.length}`, dn2);
            }
          }
          continue;
        }
        // 字段上写不了那三个（第五十七刀）：它管的是"调哪一个方法"。
        if (sp.virt !== null) {
          this.err(d, `字段 '${info.name}' 上写不了 '${sp.virt}'（type_class.rst:178：`
            + '那三个词是方法上的）');
          continue;
        }
        /* `errorcode` 写在**字段**上（第一百九十六刀）：上面那一格给 specs 开了这个词，所以这一问
           挪到这儿 —— 与顶层那一格（第一百四十九刀那条"没有形参表就是一格变量"）是同一句话。 */
        if (sp.errc) {
          this.err(d, "'errorcode' 只能写在函数上（exceptions.rst:17）");
          continue;
        }
        // 类**值**的字段：jancy 那边它是**内嵌**的（对象在父对象那一块里就地造出来，
        // type_class.rst 的 Construction 一节：member class fields "allocate inside the
        // parent block"）。这一层的类变量里放的是地址，内嵌要连"父对象造出来时把它也造
        // 出来"一起接 —— 那是另一刀。类**指针**的字段不在这条里：那一格就是一条引用
        // （`Node* m_next`），与第十七刀那条自引用的结构体指针字段同一格。
        /* 类**值**的字段（第一百六十一刀）：jancy 那边它是**内嵌**的对象 ——
           `ClassType::calcLayout` 把它收进 `m_classFieldArray`（jnc_ct_ClassType.cpp:360-371），
           再由父对象的构造逐格造出来（`MemberBlock::initializeFields` 里
           `operatorMgr.initialize(fieldValue, …)`，jnc_ct_MemberBlock.cpp:158-179）。
           这一层的类值本来就是"一格地址 + 一次 pnew"（局部量那一格从第五十二刀起就这么落），
           所以字段照原样一格地址，造出来那三句（pnew / `$tag` / construct）由 embInitLines
           发在父对象构造的开头 —— 与事件那一格（第八十三刀）同一处、紧跟在它后面。
           结构体那一侧 jancy 直接报错（`class '…' cannot be a struct member`，
           jnc_ct_StructType.cpp:303-307），这一层照它报；类**指针**的字段不在这条里
           （`Node* m_next` 就是一条引用）。 */
        if (isClass(info.type) && info.type.own === true) {
          if (!cls) {
            this.err(d, `结构体 '${shown(name)}' 里放不下类 '${shown(info.type.name)}' 的一格值`
              + '（jancy 那边这一句就是错：`class … cannot be a struct member`，'
              + 'jnc_ct_StructType.cpp:303-307 —— 内嵌的对象只有类里才有）');
            continue;
          }
          if (dflt !== null) {
            this.err(d0, `'${info.name}' 是类的字段，赋不了值（type_class.rst:19 那句 `
              + '"You cannot assign varibles or fields of class types"）');
            continue;
          }
          if (info.type.name === name) {
            this.err(d, `类 '${shown(name)}' 里的字段 '${info.name}' 按值套回了自己 ——`
              + '内嵌的对象要在父对象里就地造出来，套回自己就没完了（要套自己得经一格指针）');
            continue;
          }
          fields.push({ name: info.name, type: info.type });
          const el = this.embFields.get(name);
          const rec = { name: info.name, cls: info.type.name, node: d };
          if (el === undefined) this.embFields.set(name, [rec]);
          else el.push(rec);
          continue;
        }
        // 数组字段（第二十二刀）：那 N 格是**真的内嵌**在结构体里的 —— 方言的字段类型
        // 这一刀收了 `(blk T N)`（撞的是与第十七刀同一张白名单）。所以这里的类型文本
        // 走 fieldText 而不是 tyText：一格数组**变量**里放的是块地址，一格数组**字段**
        // 里放的是那一块本身。
        if (isArr(info.type) && info.type.n === null) {
          this.err(d, `字段 '${info.name}[]' 的长度得写出来`);
          continue;
        }
        /* 函数指针的字段（第五十五刀留的账，第一百一十七刀收的）。这一格先前拦着，理由是
           "方言的结构体字段放不下 `(fnty …)`" —— 那道墙由 ADR-0028 拆了：函数值在四条腿上
           本来就是**一个字**（C 那边 `omni_fn` 是 `struct omni_closure_s *` 的 typedef、
           LLVM 那边是 `ptr`），所以 `sizeOf` 从 0 改成 8 之后两条原生腿一个字都没改。
           于是这一层什么都不用做：`fieldText((fnty …))` 本来就发得出来，读写走的是与别的字段
           同一条 `pfield` + `pload` / `pstore`。
           jancy 的 `function*` 是**胖的**（fp + 闭包），这一层的函数值是一个指针
           （ADR-0010:84-85）—— 在"能存能取能调"这几件可观测的事上两者一样，差别记在
           ADR-0016 那一节里。 */
        /* 位域（第一百一十二刀）：`uint8_t m_flag : 1;` —— 它**不占自己的格子**，是同一格
           存储里的几位，所以这儿一个字段都不 push，只登记 bitPath（读写落法见 read / store）。
           `class` 那一侧不收：那要"整条继承链共用一格结构体"（第五十六刀）里的 `$b<N>` 也按
           链合起来，而位偏移是按**本类体内的顺序**算出来的 —— 语料里类上一格位域都没有
           （13 份带位域的语料全是 struct），所以那一格留着当账记。 */
        /* 判"是不是位域"要问**正面**（是个数），不能问 `!== null`（第一百一十七刀量出来的一个
           洞）：declarator 有三个出口，函数指针那一个与特殊成员那一个先前不带 `bits` 字段，
           于是 `undefined !== null` 成立 —— `int function* m_op(int, int)` 会被当成位域。
           三个出口现在都写了 `bits: null`，这一句再问正面，两头都堵上。 */
        if (typeof info.bits === 'number') {
          if (!isInt(info.type)) {
            this.nope(d, `位域 '${info.name}' 的类型是 ${tyName(info.type)}（位域只在整数上 ——`
              + ' jancy 那边它的宽度就是 `getSize() * 8`）');
            continue;
          }
          if (dflt !== null) {
            this.nope(d0, `位域 '${info.name}' 的默认值`);
            continue;
          }
          const sl = this.bitSlot(bs, fields, info.type, info.bits, d);
          if (sl === null) continue;
          const key = `${name}$${info.name}`;
          if (this.bitPath.has(key)) { this.err(d, `字段 '${info.name}' 声明了两次`); continue; }
          this.bitPath.set(key, {
            path: [sl.slot], type: info.type, off: sl.off, cnt: sl.cnt, bw: sl.bw,
          });
          this.bitAggs.add(name);
          continue;
        }
        bs.last = null;                  // 普通字段隔在中间就断开上一组位域
        // 函数指针的字段（第一百一十七刀）：名字记一格，调用点据此把 `c.m_f(…)` 认成
        // "从一格函数指针上调"而不是"调一个方法"（见 callSite 那一支）。
        if (isFn(info.type)) this.fnFieldNames.add(info.name);
        /* `bigendian` 的字段（第一百二十六刀）：存储照旧是一格普通整数，**读写各套一次字节序
           反转**（bswapRead / bswapStore），路子记在 bePath 上 —— 与位域那一格同一个办法。
           收下不看是不行的：那会把数读错，是真的错答案（这正是第一百〇九刀把它留着的理由）。
           枚举也收：存的是它的基整数，反转那一步一模一样。 */
        if (sp.be === true) {
          const t0 = jncIsEnum(info.type) ? info.type.base : info.type;
          if (!isInt(t0) || (t0.w !== 16 && t0.w !== 32 && t0.w !== 64)) {
            this.nope(d, `bigendian 的字段 '${info.name}' 的类型是 ${tyName(info.type)}`
              + '（字节序只在 16 / 32 / 64 位的整数与枚举上说得清 —— 一个字节的没有序，'
              + '实数与聚合各是一笔单独的账）');
            continue;
          }
          this.bePath.set(`${name}$${info.name}`, { path: [info.name], type: info.type, w: t0.w });
        }
        fields.push({ name: info.name, type: info.type });
        // 带初值的那几格记下来（第七十八刀）。排在所有"这一格不收"之后 —— 不收的那些
        // 已经 continue 掉了，不会带着一条永远发不出来的初值往下走。
        if (dflt !== null) inits.push({ name: info.name, type: info.type, expr: dflt, node: d0 });
      }
    }
    this.ns = saveNs;
    /* 一格结构体按值**套回自己**（第一百二十八刀）：这样的类型没有大小。在**声明这一处**说清，
       比等到"拷一份"那一步（copyAgg）报准得多 —— 那儿只有类型名、没有位置。
       报完之后把那几格字段**摘掉**再往下走：留着它，这一层后面几处顺着字段走的路（逐字段拷、
       花括号初值）照样会绕不出来。 */
    for (let i = fields.length - 1; i >= 0; i--) {
      if (!this.structSelf(name, fields[i].type)) continue;
      this.err(n, `${cls ? '类' : '结构体'} '${shown(name)}' 里的字段 '${fields[i].name}' `
        + '按值套回了自己 —— 这样的类型没有大小（要套自己得经一格指针）');
      fields.splice(i, 1);
    }
    // 匿名 union 的成员在这张表里是**摊平**的，`uni` 相同的那一串在这儿括回成 `(union …)`
    // （第一百一十刀 / ADR-0027）。
    const fs = unionGroups(fields).join(' ');
    if (!cls) {
      this.laidStructs.add(name);
      this.decls.push(`  (struct ${name} ${fs})`);
      return null;
    }
    // 类在方言里**也是一格 `(struct …)`**（第五十二刀）：引用语义由"变量里放地址"给出，
    // 而不是方言的 `(class …)` —— 那一格的字段还不收 `(blk T N)`（tests/sexpr/cases/07-classes.sx
    // 记的那条边界），而类里有数组字段的语料不少。方言一个字没改。
    //
    // 发出去这一步推迟到 classLayout 那一遍（第五十六刀）：一整条继承链共用**一格**结构体，
    // 而"谁派生了我"要等所有 type-decl 都过完才知道（jancy 不要求先声明后使用）。
    this.bases.set(name, base);
    if (extra.length > 0) this.mixins.set(name, extra);
    this.ownFields.set(name, fields.slice());
    if (inits.length > 0) this.fieldInits.set(name, inits);
    if (evts.length > 0) this.evtFields.set(name, evts);
    this.pendingCls.push({ name, node: n });
    return null;
  }

  /**
   * 这格类型按值走下去够不够得着 `name` 自己（第一百二十八刀）。数组按元素走、结构体按字段走，
   * 指针**不走**（经指针套自己是链表那一族，本来就该收）。`seen` 拦住别的环，免得这一问自己
   * 也绕不出来。
   */
  structSelf(name, t, seen = new Set()) {
    if (isArr(t)) return this.structSelf(name, t.el, seen);
    if (!jncIsStruct(t)) return false;
    if (t.name === name) return true;
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    for (const f of this.structs.get(t.name) ?? []) {
      if (this.structSelf(name, f.type, seen)) return true;
    }
    return false;
  }

  /**
   * 结构体的基类那几格字段（第一百二十五刀）。回"排在自己字段前面的那一串"，或 null（报过了）。
   *
   * 这一层的结构体继承是**纯布局**：基类的字段排前面、自己的排后面。`pfield` 按名字找，
   * 名字都在同一张表里，所以上转不需要任何一条新指令 —— `D` 的前缀本来就是 `B`。
   * 类当基类不收（那要对象头与派发那一套）；同名的字段当场拒（悄悄合成一格是"改了意思"，
   * 与第九十四刀 mixins 那处同一条口径）。
   */
  structBases(n, name, bases) {
    const out = [];
    const seen = new Set();
    for (const b0 of bases) {
      const bn = this.qname(b0);
      if (bn === null) { this.nope(b0, '认不出的基类名字'); return null; }
      const b = this.resolve(bn, (k) => this.structs.has(k) && !this.classes.has(k));
      if (b === null) {
        if (this.resolve(bn, (k) => this.classes.has(k)) !== null) {
          return this.nope(b0, `结构体 '${shown(name)}' 拿类 '${bn}' 当基类`
            + '（类是引用语义、还带一格动态标签，摊进结构体里要先定"那个标签归谁"）');
        }
        this.err(b0, `没有这个基类：'${bn}'`);
        return null;
      }
      if (b === name) { this.err(b0, `'${shown(name)}' 拿自己当基类`); return null; }
      if (seen.has(b)) { this.err(b0, `'${shown(name)}' 的基类里 '${shown(b)}' 写了两遍`); return null; }
      seen.add(b);
      const bf = this.structLay(b, b0);
      if (bf === null) return null;      for (const f of bf) {
        if (out.some((x) => x.name === f.name)) {
          this.nope(b0, `'${shown(name)}' 的两格基类里都有字段 '${f.name}'`);
          return null;
        }
        out.push(f);
      }
    }
    // 上转（`D*` 装进 `B*`）按这张表判，见 assignOk
    this.structSuper.set(name, [...seen]);
    return out;
  }

  /**
   * 基类那一格还没摊开就**就地先摊**（顶层的 type-decl 不保证先声明后使用）。
   * 回它的字段表或 null。摊过的记进 `laidStructs`，正在摊的记进 `layingStructs` ——
   * 后者是环的闸门（`struct A: B` / `struct B: A` 不这么拦就递归不停）。
   */
  structLay(b, node) {
    if (this.layingStructs.has(b)) {
      this.err(node, `结构体 '${shown(b)}' 的基类链绕回了自己`);
      return null;
    }
    const ent = this.structNodes.get(b);
    if (ent !== undefined && !this.laidStructs.has(b)) {
      this.layingStructs.add(b);
      const save = this.ns;
      this.ns = ent.ns;
      this.typeDecl(ent.node);
      this.ns = save;
      this.layingStructs.delete(b);
    }
    /* 位域与匿名 union 在**基类**里的那两格先不收：它们的路子（bitPath / aliasPath）记的键是
       `基类$字段`，派生那一格按自己的名字去查，查不着 —— 收下来会读到错的位置，那是静默的
       错答案。要收得让那两张表跟着继承一起复制一份，是单独一笔账。 */
    if (this.bitAggs.has(b)) return this.nope(node, `基类 '${shown(b)}' 里有位域`);
    for (const k of this.aliasPath.keys()) {
      if (k.startsWith(`${b}$`)) return this.nope(node, `基类 '${shown(b)}' 里有匿名 union`);
    }
    return this.structs.get(b) ?? null;
  }

  /**
   * 一整条继承链落成方言里的**一格结构体**（第五十六刀）。
   *
   * 为什么是"一格"而不是"每个类一格 + 上转时重解释指针"：方言的指针没有类型重解释那一格
   * （`(pnew/pnull/pload/padd/psub/pisnull/pfield/pthin/pelem/peq)` 就这几个，见 sexpr/lower.js），
   * 而 jancy 的类只能经引用到达、`B* b = d;` 是它到处在用的写法。让整条链共用一格结构体
   * （字段是链上所有类的并集）之后，`D*` 与 `B*` **本来就是同一个方言类型** —— 上转发的是
   * 零条指令，方言一个字不用长。
   *
   * 代价说清：一格对象的大小是**整条链里最大那个**（同一条链上的兄弟类共用字段那几格）。
   * 这一层没有 `sizeof`（那条边界记在 bad/sizeof.jnc），所以这个差别从语义上看不见。
   *
   * 同名的字段：类型一样就共用那一格（兄弟类之间正是这样，与 union 同理 —— 一个对象同一时刻
   * 只是链上的一个类）；类型不一样就明说不收 —— 那要按类给字段改名，而 `pfield` 这一层到处
   * 用的是源码里的字段名。
   */
  classLayout() {
    /* 直接基类那一串（第九十四刀）：第一格 ++ 第二格起。下面这一遍全按它走 —— 单继承时它
       就是原来那条链，一个字的行为都没变。 */
    const dir = (c) => {
      const b = this.bases.get(c);
      const m = this.mixins.get(c);
      const out = b === null || b === undefined ? [] : [b];
      return m === undefined ? out : out.concat(m);
    };
    // 先把图走通：环要当场拒（不然下面那几个循环不停）
    for (const { name, node } of this.pendingCls) {
      const path = new Set();
      const walk = (c) => {
        if (path.has(c)) {
          this.err(node, `'${shown(name)}' 的基类链绕回了自己（经过 '${shown(c)}'）`);
          this.bases.set(c, null);
          this.mixins.delete(c);
          return true;
        }
        path.add(c);
        for (const b of dir(c)) if (walk(b)) return true;
        path.delete(c);
        return false;
      };
      walk(name);
    }
    /* 一个类的**所有**祖先，按"先深后广"排一遍（第九十四刀）。同一个祖先到得了两次就是
       jancy 那句 "multiple instances of shared bases" —— 这一层一条链一格结构体，两次只有
       一份，所以那一种当场拒，不能悄悄按一份算。 */
    const ancestors = (c, node) => {
      const seen = new Map();          // 祖先 -> 到过几次
      const walk = (x) => {
        for (const b of dir(x)) {
          seen.set(b, (seen.get(b) === undefined ? 0 : seen.get(b)) + 1);
          if (seen.get(b) > 1) continue;
          walk(b);
        }
      };
      walk(c);
      const dup = [...seen.entries()].filter(([, n2]) => n2 > 1).map(([k]) => k);
      if (dup.length > 0 && node !== undefined) {
        this.nope(node, `'${shown(c)}' 的基类里 '${shown(dup[0])}' 到得了两遍 —— jancy 那边`
          + '"共享基类各一份实例"（type_class.rst:171-174），而这一层一条链共用一格结构体，'
          + '两遍只有一份');
      }
      return [...seen.keys()];
    };
    /* 根：一整个"由继承连起来"的连通块共用一格结构体。第一格基类的根胜出 —— 单继承时这与
       原来那个"顺着 bases 一路往上"完全一样。 */
    const par = new Map();
    const find = (c) => {
      let r = c;
      while (par.get(r) !== undefined && par.get(r) !== r) r = par.get(r);
      return r;
    };
    for (const { name } of this.pendingCls) {
      const b = this.bases.get(name);
      if (b !== null && b !== undefined) {
        const rc = find(name);
        const rb = find(b);
        if (rc !== rb) par.set(rc, rb);
      }
      for (const m of this.mixins.get(name) === undefined ? [] : this.mixins.get(name)) {
        const rm = find(m);
        const rc = find(name);
        if (rm !== rc) par.set(rm, rc);
      }
    }
    const rootOf = (c) => find(c);
    // 每个类的**可见**字段表 = 所有祖先的 ++ 自己的（`this.structs` 那张表是这一层查名用的）
    const own = (c) => (this.ownFields.get(c) === undefined ? [] : this.ownFields.get(c));
    const chainFields = (c) => {
      const out = [];
      for (const a of ancestors(c).reverse()) for (const f of own(a)) out.push(f);
      for (const f of own(c)) out.push(f);
      return out;
    };
    for (const { name, node } of this.pendingCls) {
      const root = rootOf(name);
      this.roots.set(name, root);
      CLS_ROOT.set(name, root);
      if (this.mixins.has(name)) ancestors(name, node);   // 共享基类那一格在这儿拒
      this.structs.set(name, chainFields(name));
      // 动态类型那一格（第五十七刀）：标签从 1 起，0 是"这一格没写过"，撞不上任何一个类。
      this.tags.set(name, this.tags.size + 1);
    }
    /* 多个基类各自带字段（第九十四刀）：这一层一格对象只有一份那格字段，而 jancy 那边
       `D: B1, B2` 里 B1 与 B2 是**两块**，两边同名的字段是两格不同的内存。同名就当场拒 ——
       悄悄合成一格是"改了意思"。不同名的合得起来（与同一条链上的兄弟类同一条口径）。 */
    for (const { name, node } of this.pendingCls) {
      const ms = this.mixins.get(name);
      if (ms === undefined) continue;
      const seen = new Map();          // 字段名 -> 哪一格基类带来的
      const b0 = this.bases.get(name);
      const groups = (b0 === null || b0 === undefined ? [] : [b0]).concat(ms);
      for (const g of groups) {
        for (const f of [g, ...ancestors(g)].flatMap((a) => own(a))) {
          const had = seen.get(f.name);
          if (had !== undefined && had !== g) {
            this.err(node, `'${shown(name)}' 的两格基类（'${shown(had)}' 与 '${shown(g)}'）`
              + `都带一格叫 '${f.name}' 的字段 —— jancy 那边它们是两块不同的内存，`
              + '而这一层一格对象只有一份');
          }
          if (had === undefined) seen.set(f.name, g);
        }
      }
    }
    // 每条链一格结构体：字段按"根先、派生后"的顺序并起来
    const merged = new Map();          // 根 -> 字段数组
    for (const { name, node } of this.pendingCls) {
      const root = this.roots.get(name);
      if (!merged.has(root)) merged.set(root, []);
      const into = merged.get(root);
      for (const f of this.ownFields.get(name)) {
        const had = into.find((g) => g.name === f.name);
        if (had === undefined) { into.push(f); continue; }
        if (!sameTy(had.type, f.type)) {
          this.err(node, `'${shown(name)}' 的字段 '${f.name}' 与同一条继承链上那个同名字段`
            + `不同型（${tyName(had.type)} 与 ${tyName(f.type)}）—— 这一层一条链共用一格结构体`);
        }
      }
    }
    for (const [root, fields] of merged) {
      // 每条链头上那一格 `$tag`（第五十七刀）就是**对象头**：jancy 的类本来就有一格
      //（01_Classes.jnc:12-14："Actual user fields are preceded with a header containing
      // meta-data such as type, vtable pointer, root object pointer, GC-related flags"），
      // 而这一层的对象头里只需要"是哪个类"这一件事 —— 虚派发按它挑实现。它同时把
      // "一个字段都没有的类"（`class T {}`，test124.jnc:18 与 test151.jnc:21）那一格填上了：
      // 方言的结构体至少要一个字段。`$` 不在 jancy 的标识符里，源码里碰不到这一格。
    const fs = unionGroups(fields).join(' ');

      this.decls.push(`  (struct ${root} ($tag int)${fs === '' ? '' : ` ${fs}`})`);
    }
  }

  /** 这个类连它所有祖先，先广后深排一遍（第九十四刀）。查名那一族都按它走。 */
  baseWalk(cls) {
    const out = [];
    const seen = new Set();
    const q = [cls];
    while (q.length > 0) {
      const cur = q.shift();
      if (cur === null || cur === undefined || seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const b of this.dirBases(cur)) q.push(b);
    }
    return out;
  }

  /** 直接基类那一串（第九十四刀）：第一格 ++ 第二格起。查名与上转都按它走。 */
  dirBases(c) {
    const b = this.bases.get(c);
    const m = this.mixins.get(c);
    const out = b === null || b === undefined ? [] : [b];
    return m === undefined ? out : out.concat(m);
  }

  /** b 是 d 的（间接）基类吗（第五十六刀 + 第九十四刀）。上转要它，而上转发零条指令。 */
  isBase(b, d) {
    const seen = new Set([d]);
    const q = this.dirBases(d);
    while (q.length > 0) {
      const c = q.shift();
      if (c === b) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const x of this.dirBases(c)) q.push(x);
    }
    return false;
  }

  /** 从这个类起顺着基类找一个方法（第五十六刀 + 第九十四刀）：`d.val()` 里的 val 可以是
   *  基类的。回的是方言里那个名字（`Base$val`），找不着回 null。派生的遮住基类的 —— 按
   *  **先广后深**走（第一格基类先、第二格起在后），与 jancy 那条"先自己、再按序号往上"同序。 */
  findMethod(cls, mn) {
    for (const cur of this.baseWalk(cls)) {
      const full = `${cur}$${mn}`;
      if (this.fns.has(full)) return full;
    }
    return null;
  }

  /** 从这个类起顺着基类找一格属性（第六十九刀）：与 findMethod 同一条 —— 派生的遮住基类的。
   *  回的是 props 里那个名字（`Base$m_a`），找不着回 null。 */
  findProp(cls, pn) {
    for (const cur of this.baseWalk(cls)) {
      const full = `${cur}$${pn}`;
      if (this.props.has(full)) return full;
    }
    return null;
  }

  /**
   * 一格值装不装得进那一格（第五十六刀）。除了同型，还多一条：**上转** —— 派生类的引用装进
   * 基类那一格（`B* b = d;`、把 `D*` 当 `B*` 的实参传、`return d;`）。jancy 到处在用它，
   * 而在这一层它发的是**零条指令**：一条继承链共用一格方言结构体，两边本来就是同一个方言类型。
   *
   * 反过来（基类装进派生类）要**下转**，那得在运行期问"这个对象到底是哪个类"—— 要对象头里
   * 那一格类型信息，与虚派发是同一格，所以还不收（照旧报"类型不对"）。
   */
  assignOk(from, to) {
    if (sameTy(from, to)) return true;
    /* 任何数据指针**隐式**转成 `void*`（第一百九十刀）。不是我们定的，是 jancy 的转换表 ——
         // jnc_ct_CastOp_DataPtr.cpp:461-464
         if (dstDataType->getStdType() == StdType_AbstractData ||
             dstDataType->getTypeKind() == TypeKind_Void && canCastToPod)
           return constCastKind;              // <- 隐式那一档
       `canCastToPod` 是 `isSrcPod || isDstConst || 目标是 thin 指针`，而 `char` / `int` / 结构体
       在 jancy 那边都是 POD（类不是，可这一层的类根本不是数据指针，走不到这儿）。
       所以这一条与 C 的那一条一样：指到什么上的指针都能当 `void*` 用。
       逐份榜上 99 处 `'…' 的第 1 个实参要 void*，这里是 char*` 就是它 —— 那是一句 `E`
       （我们答错了，不是"还不收"）。 */
    if (jncIsPtr(from) && jncIsPtr(to) && to.target.k === 'void') return true;
    return isClass(from) && isClass(to) && this.isBase(to.name, from.name);
  }

  /* ------------------------------------------------ 虚派发（第五十七刀） */

  /**
   * 类体里的方法**原型**上写了 `virtual`/`override`/`abstract`（第五十七刀）。
   *
   * `abstract` 的那一个永远没有体（ModuleItem.h:690），所以它的签名只能从原型上来 ——
   * 登记进 `fns` 但**不发** `(fn …)`：调它一律经分派函数，而分派表里跳过它那一格
   * （能实例化的类必有实现，见 absLeft）。
   */
  methodProto(d, cls, info, sp) {
    const full = `${cls}$${info.name}`;
    this.virt.set(full, sp.virt);
    if (sp.virt !== 'abstract') return true;
    if (this.fns.has(full)) { this.err(d, `${shown(cls)} 已经有方法 '${info.name}' 了`); return null; }
    const ps = this.formalList(info.formals);
    if (ps === null) return null;
    this.fns.set(full, {
      params: [tClass(cls, false), ...ps.map((p) => p.type)],
      ret: info.type,
    });
    this.methods.set(full, cls);
    this.methodNames.add(info.name);
    // abstract 的那一个也要记 errorcode（第五十八刀）：调它走的是基类那条链上的这个原型，
    // 不记就从基类指针调时检不着。
    if (sp.errc && this.errcReg(d, full, info.type) === null) return null;
    return true;
  }

  /**
   * 把一个函数记进 errFns（第五十八刀）。出错值由**返回类型**定（exceptions.rst:17）；
   * 定不出来时分两种说法 —— jancy 认它当错误码而这一层还没定出出错值的（字符串、函数
   * 指针）是"还不收"，jancy 自己就不认的（void / real / 结构体 / 数组）是一条硬错。
   */
  errcReg(node, full, ty) {
    const ev = jncErrText(ty);
    if (ev === null) {
      if (errCodeOk(ty)) {
        return this.nope(node, `errorcode 的函数回 ${tyName(ty)}（jancy 那儿它算错误码，`
          + '可这一层还没定出它的出错值）');
      }
      return this.err(node, `'${shown(full)}' 回 ${tyName(ty)}，当不了错误码`
        + `（jnc_ct_FunctionType.cpp:180 那句 "'%s' cannot be used as error code"：只有 bool、`
        + '整数、枚举、字符串与各种指针带 ErrorCode 那一位）');
    }
    this.errFns.set(full, ev);
    return true;
  }

  /** 从这个类起沿链找"虚的那一个" —— 也就是虚表那一格里放着的（第五十七刀）。
   *  与 findMethod 差一条：**不是虚方法的同名方法不算**。jancy 那边没写 override 的同名方法
   *  只是遮住了名字，虚表那一格还是基类的，所以动态派发看的是这一条链。 */
  findVirt(cls, mn) {
    for (const cur of this.baseWalk(cls)) {
      const full = `${cur}$${mn}`;
      if (this.virt.has(full)) return full;
    }
    return null;
  }

  /**
   * `virtual`/`override` 那几条规矩（第五十七刀）。抄的是 jancy 自己那几句诊断
   * （jnc_ct_ClassType.cpp:507/568/573），排在签名那一遍之后 —— 基类的方法那时才都在表里。
   */
  vtCheck() {
    for (const [full, kind] of this.virt) {
      const owner = this.methods.get(full);
      if (owner === undefined) continue;               // 报过错了
      const mn = full.slice(owner.length + 1);
      // 基类里那一格（第九十四刀：多格基类就逐格问，第一格先）
      const inBases = (f) => {
        for (const b of this.dirBases(owner)) {
          const r = f(b);
          if (r !== null) return r;
        }
        return null;
      };
      const up = inBases((b) => this.findVirt(b, mn));
      if (kind === 'override') {
        if (up === null) {
          const shad = inBases((b) => this.findMethod(b, mn));
          this.err(null, `覆盖不了 '${shown(full)}'：${shad === null
            ? `基类里没有方法 '${mn}'`
            : `基类那个 '${mn}' 不是虚方法`}（jancy 那句 "cannot override '%s': method ${shad === null
            ? 'not found' : 'is not virtual'}"）`);
          continue;
        }
        const a = this.fns.get(up);
        const b = this.fns.get(full);
        if (a !== undefined && b !== undefined && !this.sameSig(a, b)) {
          this.err(null, `覆盖不了 '${shown(full)}'：签名与基类那个 '${mn}' 对不上（jancy 那句 `
            + '"cannot override \'%s\': method signature mismatch"）');
        }
        // errorcode 在 jancy 那边是**函数类型上**的一位，所以它也在"签名"里（第五十八刀）：
        // 两边不一致时从基类指针调过去检不检查就成了看运气。
        if (this.errFns.has(up) !== this.errFns.has(full)) {
          this.err(null, `覆盖不了 '${shown(full)}'：基类那个 '${mn}'${this.errFns.has(up)
            ? ' 是 errorcode，这一个不是' : ' 不是 errorcode，这一个是'}（errorcode 是函数`
            + '类型上的一位，也算签名的一部分）');
        }
        continue;
      }
      // `virtual` / `abstract` 开的是**新的一格**。基类那条链上已经有同名的虚方法时，
      // jancy 收不收、收了算哪一格，这一层没量出来 —— 明说不收，别猜。
      if (up !== null) {
        this.nope(null, `'${shown(full)}' 上写 '${kind}'，而基类那条链上已经有虚方法 '${mn}'`
          + '（覆盖它写 `override`）');
      }
    }
  }

  /**
   * 把原型上那几格默认值并进签名（第一百刀）。
   *
   * jancy 的默认值挂在 `FunctionArg` 上（`hasInitializer`），而"类里写原型、体写在类外"那种
   * 放法里它**只出现在原型上**——`ui_PropertyGrid.jnc:233-245` 就是这个形状：
   *
   *   GroupProperty* createGroupProperty(Property* parentProp = null, …, string_t name, …);
   *   GroupProperty* PropertyGrid.createGroupProperty(Property* parentProp, …) { … }
   *
   * 签名那一遍看的是**定义**，所以先前那几格默认值整个丢了 —— 于是同一份文件里
   * `createGroupProperty(,, name, toolTip)` 报"第 1 个实参是空的，而它那个形参没有默认值"。
   *
   * 排在签名那一遍之后（那时定义都在表里了）、重载决议之前。定义上自己写了默认值的**不动**
   * ——那时两处都有，按定义那一份算（jancy 那边两处都写会报重复，这一层不追这一格）。
   */
  mergeProtoDefs() {
    for (const [key, defs] of this.protoDefs) {
      const cut = key.lastIndexOf('#');
      const base = key.slice(0, cut);
      const want = Number(key.slice(cut + 1));
      const fam = this.overloads.get(base);
      const cands = fam === undefined ? [base] : fam;
      for (const full of cands) {
        const sig = this.fns.get(full);
        if (sig === undefined) continue;
        const self = this.methods.has(full) ? 1 : 0;
        if (sig.params.length - self !== want) continue;
        const had = sig.defs !== undefined && sig.defs !== null
          && sig.defs.some((d) => d !== null && d !== undefined);
        if (had) break;
        sig.defs = (self === 1 ? [null] : []).concat(defs);
        break;
      }
    }
  }

  /** 两个签名同型吗（`this` 那一格不算 —— 它天生不同型）。 */
  sameSig(a, b) {
    if (a.params.length !== b.params.length) return false;
    for (let i = 1; i < a.params.length; i++) {
      if (!sameTy(a.params[i], b.params[i])) return false;
    }
    return sameTy(a.ret, b.ret);
  }

  /**
   * 这个类造得出来吗（第五十七刀）。jancy 那句是 "abstract class '%s'"
   * （jnc_ct_ClassType.cpp:660）：虚表里还留着 abstract 那一格的类不能实例化。
   * 回的是"还没实现的那个方法名"，全实现了回 null。
   */
  absLeft(cls) {
    const seen = new Set();
    for (const cur of this.baseWalk(cls)) {
      for (const full of this.virt.keys()) {
        if (!full.startsWith(`${cur}$`)) continue;
        const mn = full.slice(cur.length + 1);
        if (mn.includes('$') || seen.has(mn)) continue;
        seen.add(mn);
        const impl = this.findVirt(cls, mn);
        if (impl !== null && this.virt.get(impl) === 'abstract') return mn;
      }
    }
    return null;
  }

  /** 造一格对象之前先把 `$tag` 写死（第五十七刀）：动态类型就是这一格整数。
   *  造不出来（还有 abstract 没实现）时报错，回 null。 */
  tagStore(node, cls, selfCode, pad) {
    const left = this.absLeft(cls);
    if (left !== null) {
      return this.err(node, `${shown(cls)} 造不出来：'${left}' 还是 abstract（jancy 那句 `
        + '"abstract class \'%s\'"）');
    }
    // 类的体没解出来时（上面某一条已经报过错）这张表里没有它 —— 别发一句坏文本出去。
    const tag = this.tags.get(cls);
    if (tag === undefined) return this.err(node, `${shown(cls)} 的类体没解出来，造不出对象`);
    return `${pad}(pstore (pfield ${selfCode} $tag) (int ${tag}))`;
  }

  /**
   * 按标签分派的那一段（第五十七刀）。一个（根, 方法名）一段，抬到模块级，`disp` 记着别发两遍。
   *
   * 为什么不是"对象里一格函数指针"（也就是真的虚表）：方言的结构体字段放不下函数值
   * （hir/types.js 的 structLayout 拒落不进内存的字段，见 bad/fnptr-field）。所以对象里放的是
   * 一格**整数**，虚表那一格换成一串 `if (tag == N) return D$foo(…)` —— 一格 int 加一个
   * switch，方言一个字都不用长。
   *
   * 表是**穷举**的：链上每个类各问一遍 findVirt，所以运行期不会走到"没有这一格"的分支。
   * 兜底那一格挑的是最靠根的那个实现 —— 也就是"没人覆盖时用基类的"。
   */
  dispatch(full) {
    const owner = this.methods.get(full);
    const mn = full.slice(owner.length + 1);
    const root = this.roots.get(owner) === undefined ? owner : this.roots.get(owner);
    // 键是**分派函数**的名字，不是某一个实现的：链上 Base$area / Derived$area 说的是同一格。
    const name = `${root}$$vd$${mn}`;
    const have = this.disp.get(name);
    if (have !== undefined) return have;
    const sig = this.fns.get(full);
    // 表：标签 -> 那个标签该调的实现。链上所有类都在里面（不只 owner 的子孙）。
    const rows = [];
    for (const cls of this.tags.keys()) {
      if (this.roots.get(cls) !== root) continue;
      const impl = this.findVirt(cls, mn);
      if (impl === null || this.virt.get(impl) === 'abstract') continue;
      rows.push({ tag: this.tags.get(cls), impl });
    }
    const fallback = this.findVirt(root, mn);
    const back = fallback !== null && this.virt.get(fallback) !== 'abstract'
      ? fallback : (rows.length > 0 ? rows[rows.length - 1].impl : null);
    if (back === null) {
      return this.err(null, `'${shown(full)}' 一个实现都没有（abstract 的方法要有类覆盖它）`);
    }
    this.disp.set(name, name);
    this.fns.set(name, sig);
    const ps = sig.params;
    const decl = ps.map((t, i) => `($a${i} ${slotText(t)})`).join(' ');
    const as = ps.map((t, i) => ` (var $a${i})`).join('');
    const call = (impl) => `(call ${impl}${as})`;
    const done = (impl) => (sig.ret === J_VOID
      ? `(do (expr ${call(impl)}) (ret))` : `(do (ret ${call(impl)}))`);
    const lines = [];
    for (const r of rows) {
      if (r.impl === back) continue;
      lines.push(`      (if (bin "==" (pload (pfield (var $a0) $tag)) (int ${r.tag}))`);
      lines.push(`        ${done(r.impl)})`);
    }
    lines.push(`      ${sig.ret === J_VOID ? `(expr ${call(back)})` : `(ret ${call(back)})`}`);
    this.decls.push(`  (fn ${name} (${decl}) ${slotText(sig.ret)}\n    (do\n${lines.join('\n')}))`);
    return name;
  }

  /* -------------------------------------------------------------- 类型与声明符 */

  qname(n) {
    if (!isList(n)) return null;
    if (head(n) === 'name' && isAtom(n.items[1])) return n.items[1].value;
    // 限定名 `a.b`（第五十一刀）：摊成点连的一串。声明位置上它是"往那个命名空间里放"
    // （jancy 收 `struct a.S { … }`），查名位置上它是"从那儿找"。
    if (head(n) === 'qualified') {
      const l = this.qname(n.items[1]);
      if (l === null || !isAtom(n.items[2])) return null;
      return `${l}.${n.items[2].value}`;
    }
    return null;
  }

  /** 表达式位置上的 `a.b.c` —— 那是一串 `field`，而它**可能**整体是个限定名（命名空间里的
   *  枚举/函数）。摊成点连的一串，摊不动就回 null（那就真是取字段）。（第五十一刀） */
  dotted(n) {
    if (!isList(n)) return null;
    const h = head(n);
    if (h === 'name' && isAtom(n.items[1])) return n.items[1].value;
    if (h === 'qualified' || h === 'field') {
      const l = this.dotted(n.items[1]);
      if (l === null) return null;
      const r = isAtom(n.items[2]) ? n.items[2].value : this.dotted(n.items[2]);
      return r === null ? null : `${l}.${r}`;
    }
    return null;
  }

  /** `(specs 类型说明符 前置修饰符 后置修饰符)` -> 类型 + `thin` 标记 + `stat` 标记。
   *  `thin` 在 jancy 里是**类型修饰符**（Lexer.rl:222），语法上落在说明符表里，
   *  所以它在这儿而不是在 `*` 那一侧。
   *
   *  `allowVirt` 只有方法那两处给 true（第五十七刀）：`virtual`/`override`/`abstract` 在
   *  语法里也落在这张表上，可它只对方法有意思 —— 别的位置默认报错，免得那个词被悄悄丢掉。
   *
   *  `errcOk` 从 `allowVirt` 上分出来（第一百九十六刀）：`errorcode` 说的是**返回值**这件事
   *  （exceptions.rst:17），与"是不是类的方法"无关 —— 结构体的方法上照样写得（语料里的原样是
   *  `struct Guid { bool errorcode parse(string_t string) thin; }`，std_Guid.jnc:94）。 */
  specs(n, allowVirt = false, extra = [], errcOk = allowVirt) {
    if (!isList(n) || head(n) !== 'specs') { this.err(n, '认不出的说明符表'); return null; }
    const mods = [...this.flat(n.items[2]), ...this.flat(n.items[3])]
      .map((m) => (isAtom(m) ? m.value : '?')).concat(extra);
    let thin = false;
    let stat = false;
    let uns = false;
    let be = false;                      // `bigendian`（第一百二十六刀）
    let fnptr = false;
    let virt = null;
    let errc = false;
    let prop = false;
    let cst = false;
    let agt = false;
    let bnd = false;
    let evt = false;
    let rct = false;
    let als = false;
    for (const m of mods) {
      if (m === 'thin') { thin = true; continue; }
      // `errorcode`（第五十八刀，exceptions.rst:17）：它说的是"这个函数的返回值就是错误码"。
      // 与 virtual 那三个同一处 —— 只有函数签名那两处认得它。
      if (m === 'errorcode') {
        if (!errcOk) {
          this.err(n, "'errorcode' 只能写在函数上（exceptions.rst:17）");
          return null;
        }
        errc = true;
        continue;
      }
      // 虚方法那三个（第五十七刀，type_class.rst:178："Virtual methods are declared using
      // keywords virtual, abstract, and override"）。它们在语法里也落在这张 mods 表里，
      // 所以在这儿收下来往上传 —— 认得它的只有方法那两处（fnSig0 与类体里的方法原型），
      // 别的位置（变量、形参、字段、强制转换的目标）由 noVirt 挡住。
      if (m === 'virtual' || m === 'override' || m === 'abstract') {
        if (!allowVirt) {
          this.err(n, `'${m}' 只能写在类的方法上（type_class.rst:178）`);
          return null;
        }
        if (virt !== null) { this.err(n, `'${virt}' 与 '${m}' 只能写一个`); return null; }
        virt = m;
        continue;
      }
      // `function`（第五十五刀）是**类型修饰符**，在语法里也落在这张表里（jnc.grammar 的
      // mods 那一格）。它说的是"这一格里放的不是数据的地址，是一个函数"——具体的签名要等
      // 声明符：形参表挂在名字后面的 `fn-suffix` 上，返回类型就是这儿的说明符。
      if (m === 'function') { fnptr = true; continue; }
      // 可变性那一族（第六十七刀）。jancy 自己把 `const` / `const?` / `autoconst` /
      // `readonly` 归进**同一个互斥组** `TypeModifierMaskKind_Const`（Decl.cpp:96 那张
      // antiModifierTable），`cmut` 是后来加的一格，作者的说明是"与 readonly 一样"
      //（internal/Required IDE Modifications.rst:21）。`readonly` 的意思是**双重修饰符**：
      // "自己人当它不存在，外人当它是 const"（dual_modifiers.rst:45-68）。
      // 这一层没有可变性检查，所以这三个词落地是同一件事：收下、不看。
      // **代价明写**：`c.m_readOnly = 20` 这种"从外面改只读字段"我们抓不出来，jancy 抓得出来
      //（dual_modifiers.rst:67 那句 "error: cannot assign to const-location"）。与第五十二刀
      // 不做可见性检查同一笔账 —— 拒得更松，不改变能跑的程序的行为。
      // `const` 那一位要往上传（第六十八刀）：`T const property p` 是**只有取的属性**
      // （prop.rst:17："If a property has no setters then it is a const property"）。
      if (MUT_MODS.has(m)) { if (m === 'const') cst = true; continue; }
      /* `volatile`（第八十六刀）也是**类型修饰符**（decl_advanced.rst:22 那张表里就有它），
       * 落地是指针类型上的一位 `PtrTypeFlag_Volatile`（jnc_ct_DeclTypeCalc.cpp:282-283），
       * 意思是"读它不许缓存"。语料里只有两处声明（`uint64_t readonly volatile
       * m_txTotalSize;` / `m_rxTotalSize`，api/log_Log.jnc:81-82），可 log_Log.jnc 被到处
       * import，于是它拦住的文件不少。
       *
       * 收下、**不看**，与 const / readonly 那一族同一条（那几个也是收下不看）。
       * 写在 `*` **后面**的那一个是同一位、同一笔账（第二百一十一刀，见 ptrsTy）。
       * **代价明写**：这一层没有线程、方言里也没有"这一格不许缓存"那一位，所以真有别人
       * （宿主的 C++ 那边）在改这一格时我们保证不了每次都重读 —— 那两格恰好正是宿主在写的
       * 计数器。等真有宿主面那一刀时，这一位要跟着落到方言里去。 */
      if (m === 'volatile') continue;
      // `property`（第六十八刀）是**类型修饰符**（Decl.cpp:35 那张表里的 TypeModifier_Property），
      // 所以它落在这张 mods 表里。它说的是"这一格不是一块内存，是一对函数（取/存）"——
      // 简单声明式（prop_simple.rst:19）就一个词，体写在别处：`T p.get() { … }` / `p.set(T x) { … }`。
      if (m === 'property') { prop = true; continue; }
      // `autoget`（第七十一刀，prop_autoget.rst:15-27）：它说的是"取值器不用写，编译器**生成
      // 一格存储**、读它就是读那一格"。简单声明式里那格存储的名字是 `m_value`（同一处:26 那句
      // "name of compiler-generated field is 'm_value'"）—— 存值器的体里就是这么写它的。
      if (m === 'autoget') { agt = true; continue; }
      /* `bindable`（第七十三刀，prop_bindable.rst）：它说的是"这一格属性变了要通知订阅的人"。
       * jancy 那边编译器给它生成一格事件，名字是 `m_onChanged`
       * （`Property::createOnChanged`，jnc_ct_Property.cpp:125-147，类型是
       * `StdType_SimpleMulticast` = `multicast ()`）—— 存值器的体里就是这么写它的。
       * 通知**是手写的**，除非整格属性都是编译器生成的（那种叫 bindable data，
       * samples/jnc/34_BindableProperties.jnc:15-17）。 */
      if (m === 'bindable') { bnd = true; continue; }
      /* `event` / `multicast`（第七十四刀）：都是**类型修饰符**（Lexer.rl:212-240），说的是
       * "这一格里放的是一串处理函数"。两者的差别只在**能不能从外面叫**：`event` 那一格
       * 只让加/减（`MulticastMethodFlag_InaccessibleViaEventPtr`，jnc_ct_TypeMgr.cpp:940-975），
       * `multicast` 连 `call` / `clear` / `setup` 都放出去。这一层没有可见性检查（与第五十二刀
       * 同一笔账），所以两个词落地是同一件事。处理函数一律回 void
       * （"Multicasts must return void"，同处:907-911）。 */
      if (m === 'event' || m === 'multicast') { evt = true; continue; }
      /* `reactor`（第八十五刀）：也是**类型修饰符** —— jancy 把它算成一格类型
       * （`TypeModifier_Reactor` -> `StdType_ReactorBase`，jnc_ct_DeclTypeCalc.cpp:165-168），
       * 于是 `reactor m_uiReactor;` 在它那边就是"一格 reactor 类的字段"
       * （`Parser::declareReactor`，jnc_ct_Parser.cpp:1897-1930）。这一层落成"一格 bool +
       * 几个反应函数"，见 emitReactors。 */
      if (m === 'reactor') { rct = true; continue; }
      /* `alias`（第八十七刀）：jancy 那边它是**存储类**（与 typedef 同一处，
       * DeclarationSpecifier.llk 那张表），语法上落进这张 mods 表。一条 alias 就是
       * "另起一个名字指同一格东西"，见 aliasDecl。 */
      if (m === 'alias') { als = true; continue; }
      // 访问控制的 **Java 式写法**（第六十七刀）。jancy 只有 public 与 protected 两种，
      // 两种写法都收：C++ 式的标签，和这一格"写在声明说明符里"（dual_modifiers.rst:22-24），
      // 而且**顶层的成员也能写**（同处:26 那句 "Global namespace members can also have
      // access specifiers just like named type members"）。标签那一半第五十二刀就是跳过的
      //（`access` 节点），这儿是同一件事的另一半。
      if (m === 'public' || m === 'protected') continue;
      // 存储类（decl_storage.rst）。模块级变量**默认**就是 static（"If storage specifier is
      // omitted, then global variables get assigned static storage class"），所以写出来
      // 也是同一件事；局部量上的 static 是另一回事，由 staticLocal / staticLocalCurly 落
      //（第二十六刀：一格模块级的槽加一道 once 闸门）。
      if (m === 'static') { stat = true; continue; }
      // threadlocal 要线程本地存储，而这一层没有线程。文档自己也说它有两条限制
      // （不能有初值、不能是聚合），接它得连那两条一起接。
      if (m === 'threadlocal') { this.nope(n, '`threadlocal`（要线程本地存储）'); return null; }
      // `unsigned` 是**类型修饰符**（decl_advanced.rst:22），所以它落在这张表里而不是
      // 说明符那一格上。第三十三刀把它接了：位宽与符号性合起来才是一格整数类型。
      if (m === 'unsigned') { uns = true; continue; }
      /* 第一百〇九刀：这一行诊断（`修饰符 '…'`）按真话拆开是 11 个词，只有下面这几个"收下
       * 不看"**不可能给出错答案**，逐词的理由：
       *
       *   - `cdecl` / `stdcall` / `thiscall` —— 调用约定。方言今天的目标是 arm64 与
       *     x86-64 SysV，这三者在那上面**本来就是同一套 ABI**（stdcall/thiscall 只在 32 位
       *     x86 上与 cdecl 不同）。所以忽略它不是"少做一件事"，是"这件事在这些目标上不存在"。
       *     **代价明写**：哪天真加 32 位 x86 Windows 目标，这三个词要原样拿回来落成真的约定；
       *   - `safe` —— 这一层默认就是安全的那一档（转 thin 指针要写 `unsafe { … }`，见第几刀
       *     那条 `bad/thin-outside-unsafe`），写出来与不写是同一件事；
       *   - `unsafe`（写在声明上的那种，不是 `unsafe { … }` 语句块）—— 忽略它只会让体里那些
       *     真需要 unsafe 的写法**照旧被拒**，也就是拒得更严，放不过错的东西；
       *   - `mutable` —— 它是 `const` 那一位的反面，而默认就是可写的（MUT_MODS 那一族里
       *     `const` / `readonly` 也是收下不看的），所以写出来与不写同一件事。
       *
       * 剩下那几个**刻意仍旧拦着**，理由各不相同 —— 第二百一十二刀把它们从"修饰符 '…'"这一句
       * 里拆出来，各自说自己那件事（见下面那四支）：`bigendian` 已经落成真的了（36 份 /
       * 212 处，收下不看会把数读错），`async`（31 份，协程）、`disposable`（6 份，要作用域出口
       * 的钩子）、`weak`（4 份，没有 GC 就永远不会变 null）、`indexed`（1 份，属性带下标形参）。 */
      if (m === 'cdecl' || m === 'stdcall' || m === 'thiscall') continue;
      if (m === 'safe' || m === 'unsafe' || m === 'mutable') continue;
      /* `bigendian`（第一百二十六刀）：这一格**不能收下不看** —— 那会把数读错，是真的错答案。
         所以它落成一位，由字段那一遍记进 `bePath`，读写各套一个字节序反转（bswapRead /
         bswapStore）。语料里 32 份文件、绝大多数是协议头上的 `bigendian uint16_t m_port;`。 */
      if (m === 'bigendian') { be = true; continue; }
      /* 第二百一十二刀：剩下那四个词按第一百四十九刀那条法**各说各的话** —— `修饰符 '…'` 这
       * 一行 42 份文件里其实是四件不同的事，一句话把它们盖成一件，看榜的人看不出该做哪个。
       * 拆开之后每一行指着一件真事（数字先前记在 ADR-0016 那份候选清单里，现在写进诊断本身）。 */
      if (m === 'weak') {
        /* `weak Foo* p`（samples 05/21/24/36）。jancy 那儿这个词换的是**指针的种类**：
           类指针走 ClassPtrKind_Weak、函数指针走 FunctionPtrKind_Weak、属性指针走
           PropertyPtrKind_Weak（jnc_ct_DeclTypeCalc.cpp:667 / :676 / :688）。弱指针不算
           一条引用，GC 把对象收了之后它自己变 null。这一层没有 GC，收下不看会让
           `if (p)` **永远为真** —— 那四份样例印的恰好就是"收完之后它成了 null"。 */
        this.nope(n, '`weak` 指针 —— jancy 那儿它是另一种指针（ClassPtrKind_Weak / '
          + 'FunctionPtrKind_Weak / PropertyPtrKind_Weak，jnc_ct_DeclTypeCalc.cpp:667/676/688），'
          + 'GC 收了对象之后它自己变 null；这一层没有 GC，收下不看会让 `if (p)` 永远为真');
        return null;
      }
      if (m === 'async') {
        /* `async void foo()`（io_FileStream.jnc:302、jnc_Promise.jnc:38 那一族，语料里最多的
           一个词）。jancy 那儿它**换掉返回类型**：写出来的那个挪去 m_asyncReturnType，函数真正
           回一格 `std.Promise*`（jnc_ct_TypeMgr.cpp:664-672），而体要拆成一台能在 await 处停下
           再接着跑的状态机。这不是一格修饰符的事。 */
        this.nope(n, '`async` 函数 —— jancy 那儿它换掉返回类型（写出来的那个挪去 '
          + 'm_asyncReturnType，函数真正回一格 `std.Promise*`，jnc_ct_TypeMgr.cpp:664-672），'
          + '体还要拆成一台能在 await 处停下再接着跑的状态机');
        return null;
      }
      if (m === 'disposable') {
        /* `disposable io.File f = …;`（53_Disposable.jnc:73、test61/63/78/87）。jancy 那儿它
           **只**能写在局部量上，而且那格类型得有 `dispose`（isDisposableType，
           jnc_ct_Type.cpp:844-850）；见到它就给这一格开一个
           `ScopeFlag_Disposable | ScopeFlag_FinallyAhead | ScopeFlag_Finalizable` 的作用域，
           出去的时候（正常出去与抛出去都算）调它的 dispose（jnc_ct_Parser.cpp:2050-2068）。
           时机是**确定的** —— 与那条 destruct 的账（GC 在不确定的时刻调）不是一件事 ——
           但要作用域出口那一套钩子，这一层还没有。 */
        this.nope(n, '`disposable` 的局部量 —— jancy 那儿它给这一格开一个可弃作用域、'
          + '出去的时候（正常出去与抛出去都算）调它的 `dispose`（jnc_ct_Parser.cpp:2050-2068），'
          + '要作用域出口那一套钩子');
        return null;
      }
      if (m === 'indexed') {
        /* `int indexed property m_a(size_t i)`（35_PropertyPtr.jnc:126，语料里就这一处）。
           jancy 那儿它让取/存那两个函数**带下标形参**（jnc_ct_DeclTypeCalc.cpp:565 与 :614），
           于是 `p[i]` 接的是属性那两个函数、而不是一格内存。忽略这个词就会把 `p[i]` 接到
           下标算符那条路上 —— 接错人。 */
        this.nope(n, '`indexed` 属性 —— jancy 那儿它让取/存那两个函数带下标形参'
          + '（jnc_ct_DeclTypeCalc.cpp:565 与 :614），于是 `p[i]` 接的是属性那两个函数、'
          + '不是一格内存');
        return null;
      }
      this.nope(n, `修饰符 '${m}'`);
      return null;

    }
    const ts = n.items[1];
    /* `event m_e(int x);` 的说明符里**没有类型**（jnc.grammar:263 那条注）：多播的处理函数
     * 一律回 void，所以那一格不用写。带实参那一串挂在声明符的括号里，由调用方（globalDecl /
     * 类的字段那一遍）从 formals 上读，这儿只把"这是一格事件"传上去。 */
    if (isList(ts) && head(ts) === 'no-type') {
      if (evt) return { type: J_MC, thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata: false, evt, rct, als, be };
      /* 说明符里一个类型都没写（第八十一刀）。语料里到处是：`override start() { … }`、
       * `abstract reset();`、`virtual decodeName(std.StringBuilder* s) {}` ——
       * `virtual` / `override` / `abstract` 在 jancy 那边是**存储说明符**，不是类型说明符
       * （jnc_ct_DeclarationSpecifier.llk:99-110），所以一条声明可以只有它们。
       *
       * 那时的类型是 **void**，规矩明写在 `Declarator::setTypeSpecifier`
       * （jnc_ct_Decl.cpp:217-234）：没有说明符就 `getPrimitiveType(TypeKind_Void)`；
       * 有说明符但没类型名时，光写了 `unsigned` / `bigendian` 的那一格才退回 `int`
       * （C 那条隐式 int 只剩这一格）。函数后缀接上去之后 `void` 就成了**返回类型**
       * （jnc_ct_DeclTypeCalc.cpp:170-197 的 `getFunctionType`）。
       *
       * 文档里一个字都没写这条（翻过 doc/language/rst，例子全写着返回类型），
       * 所以出处只能是源码。
       *
       * 没有函数后缀的那种（`virtual m_x;`）在 jancy 那边报的是 `illegal use of type 'void'`
       * （jnc_ct_Parser.cpp:1094-1136 的 `case TypeKind_Void`）—— 这一层由下游那几处
       * "字段/变量不能是 void" 接着，报的话也是同一件事。 */
      if (uns) return { type: mkInt(32, true), thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata: false, evt, rct, als, be };
      return { type: J_VOID, thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata: false, evt, rct, als, be };
    }
    let base = null;
    if (isAtom(ts)) {
      const s = ts.value;
      // 位宽照 jancy：char 8 / short 16 / int 32 / long 与 intptr 64。
      if (s === 'char') base = mkInt(8, uns);
      else if (s === 'short') base = mkInt(16, uns);
      else if (s === 'int') base = mkInt(32, uns);
      else if (s === 'long' || s === 'intptr') base = mkInt(64, uns);
      else if (s === 'double' || s === 'float') base = J_REAL;
      else if (s === 'bool') base = J_BOOL;
      else if (s === 'void') base = J_VOID;
      else { this.nope(ts, `类型 '${s}'`); return null; }
      // 光写 `unsigned` 不写类型在 C 里是 `unsigned int`；这一层的语法把它落成
      // `no-type`，上面已经挡了，所以这儿只会看到"修饰符 + 具体类型"。
      if (uns && !isInt(base)) { this.err(ts, `'${s}' 上写不了 unsigned`); return null; }
    } else {
      const nm = this.qname(ts);
      if (nm === null) { this.nope(ts, '这种类型说明符'); return null; }
      // 那一串别名照 type_primitive.rst:25-40 抄。写了别名再写 `unsigned` 是重复，
      // 但不冲突（`uint8_t` 本来就是无符号），所以照收。
      const alias = INT_ALIASES.get(nm);
      if (alias !== undefined) base = mkInt(alias.w, alias.u || uns);
      /* `size_t`（第九十一刀改对的）：jancy 那边它是 **`TypeKind_IntPtr_u`** ——
       * `jnc_TypeKind_SizeT = jnc_TypeKind_IntPtr_u`（include/jnc_Type.h:136），
       * 也就是"指针宽的**无符号**整数"。先前这儿写的是 J_I64（有符号），那是个真差别：
       * `size_t i = -1; i > 0` 在 jancy 那边是真、按有符号算是假；`/` `%` `>>` 也各差一格。
       * 这一层的指针是 8 字节，所以落成 64 位无符号。 */
      else if (nm === 'size_t') base = mkInt(64, true);
      else if (nm === 'string_t') base = J_STR;
      /* `variant_t`（第一百一十三刀）：这一层落成一格合成的结构体（见 VARIANT 那处注释）。
         排在命名类型之前 —— 语料里没人拿它当自己的类型名，而 jancy 那边它是个内建类型。 */
      else if (nm === 'variant_t') {
        if (uns) { this.err(ts, "'variant_t' 上写不了 unsigned"); return null; }
        base = this.variantTy();
      }
      // 命名类型从里往外找（第五十一刀）：`namespace a` 里写 `S` 先看 `a.S`、再看全局的。
      // 类要排在结构体前面（第五十二刀）：两者的字段表在同一张 `this.structs` 里，
      // 分得清的是 `this.classes`。
      else if (this.resolve(nm, (k) => this.classes.has(k)) !== null) {
        if (uns) { this.err(ts, `'${nm}' 是类，上面写不了 unsigned`); return null; }
        base = tClass(this.resolve(nm, (k) => this.classes.has(k)), true);
      }
      else if (this.resolve(nm, (k) => this.structs.has(k)) !== null) {
        base = { k: 'struct', name: this.resolve(nm, (k) => this.structs.has(k)) };
      }
      else if (this.resolve(nm, (k) => this.enums.has(k)) !== null) {
        const en = this.resolve(nm, (k) => this.enums.has(k));
        if (uns) { this.err(ts, `'${nm}' 是枚举，上面写不了 unsigned`); return null; }
        base = { k: 'enum', name: en, base: this.enums.get(en).base, bits: this.enums.get(en).bits === true };
      }
      else if (this.resolve(nm, (k) => this.aliases.has(k)) !== null) {
        // typedef 起的名字（第三十八刀）。别名里可能已经带着指针或数组那几层，所以直接拿
        // 解出来的那一格当 base —— 声明符后面再补的层照常叠上去（`pint* q` 是 `int**`）。
        if (uns) { this.err(ts, `'${nm}' 是 typedef 起的名字，上面写不了 unsigned`); return null; }
        base = this.aliases.get(this.resolve(nm, (k) => this.aliases.has(k)));
      }
      else { this.err(ts, `没有这个类型：'${nm}'`); return null; }
    }
    // `autoget` 只在属性上有意思（第七十一刀）：完整声明式里它写在属性体内那格字段上、
    // 「implicitly makes property 'autoget'」（prop_autoget.rst:34），而那种写法这一层还
    // 整个不收（见 fnSig0 开头那条）。所以到这儿还带着 agt 又没有 property 的，只能是
    // 写错了地方 —— 明说，不要让它一声不响地当成普通的一格。
    if (agt && !prop) {
      this.err(ts, '`autoget` 只能写在属性上（prop_autoget.rst:15；完整声明式里它写在'
        + '属性体内那格字段上，同处:34）');
      return null;
    }
    /* 光写 `bindable` 不写 `property` 是 **bindable data**（`int bindable g_data;`，
     * samples/jnc/34_BindableProperties.jnc:87-90）：整格属性都由编译器生成 —— 取值器读那格
     * 存储、存值器是 `if (m_value != x) { m_value = x; m_onChanged(); }`
     * （`Property::compileAutoSetter`，jnc_ct_Property.cpp:788-822）。所以这儿把它**补成
     * 一格 autoget 的属性**：那两个生成物正好是 autoget 的存储加上这一刀的存值器。
     * 写在别处（局部量、形参、字段）的 `bindable` 由那几处各自拦 —— 属性在函数体里本来就
     * 不收（bad/prop-ptr 那条）。 */
    let bdata = false;
    if (bnd && !prop) { prop = true; agt = true; bdata = true; }
    /* 写了类型的事件：只能是 `void`（"Multicasts must return void"，
     * jnc_ct_TypeMgr.cpp:907-911）。别的写法当场拒 —— 悄悄把返回值丢掉就是骗人。 */
    if (evt && base !== J_VOID) {
      this.err(ts, `多播的处理函数只能回 void（jancy 那句 "Multicasts must return void"），`
        + `这里写的是 ${tyName(base)}`);
      return null;
    }
    return { type: evt ? J_MC : base, thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata, evt, rct, als, be };
  }

  /**
   * `*` 那一族修饰符里，**最后一个 `*` 后面**那一组（第七十二刀）。
   *
   * jancy 的分法在 `Declarator::addPointerPrefix` 那三句里（jnc_ct_Decl.cpp:292-297）：
   * 见到一个 `*` 就把**到这儿为止攒着的**那些词搬进这个 `*` 自己的 prefix、然后把袋子清空。
   * 于是"写在 `*` 前面的词"修饰的是那一格指针，而"写在最后一个 `*` 后面的词"留在袋子里 ——
   * 那就是**这条声明**的词。`DeclTypeCalc::calcType` 把这两袋分开用：prefix 里带 property 的
   * 走 `getPropertyType` + `getPropertyPtrType`（**属性指针**，jnc_ct_DeclTypeCalc.cpp:80-85），
   * 而循环之后剩下那袋带 property 的走 `getPropertyType(type)`（**类型是那格指针的属性**，
   * 同文件:145-150）。所以 `int property* p` 与 `Icon* property p` 是两码事，差的只是那个词
   * 写在星号的哪一边。
   *
   * 这一层的树形状恰好是同一个分法：写在第一个 `*` 前面的词在 `(specs …)` 里，写在第 i 个
   * `*` 后面的词在第 i 组 `(ptr (mods …))` 里 —— 所以**最后一组**就是 jancy 那只剩下的袋子。
   */
  tailMods(d) {
    if (!isList(d) || head(d) !== 'dcl') return [];
    const groups = this.flat(d.items[1]);
    if (groups.length === 0) return [];
    const last = groups[groups.length - 1];
    return this.flat(last).flatMap((m) => this.flat(m)).map((m) => (isAtom(m) ? m.value : '?'));
  }

  /** 说明符表 + 一串 `*` -> 类型。`int thin*` 的 thin 管的是**最外层**那个 `*`
   *  （jancy 的 `int thin* p` 是"指向 int 的 thin 指针"）。
   *
   *  `dropTail` 是第七十二刀那一格：最后一组的词已经被 declarator 提成**这条声明**的词
   *  （见 tailMods），这儿就不能再当指针的修饰符看一遍。 */
  ptrsTy(sp, ptrsNode, node, dropTail = false) {
    let t = sp.type;
    const groups = this.flat(ptrsNode);
    if (groups.length === 0) {
      if (sp.thin) { this.nope(node, '`thin` 用在不是指针的类型上'); return null; }
      return t;
    }
    for (let i = 0; i < groups.length; i++) {
      const mods = dropTail && i === groups.length - 1 ? []
        : this.flat(groups[i]).flatMap((m) => this.flat(m)).map((m) => (isAtom(m) ? m.value : '?'));
      let thin = sp.thin && i === 0;
      for (const m of mods) {
        if (m === 'thin') { thin = true; continue; }
        // 可变性那一族在 `*` 后面也是同一格（第六十七刀）：`Type* readonly` / `Type* cmut`
        // 与 `Type* const` 在 jancy 那边落在同一个互斥组上（Decl.cpp:96 的
        // `TypeModifierMaskKind_Const`），这一层没有可变性检查，所以三个都是收下不看。
        // `volatile` **不在**那一组里（antiModifierTable 那一行是 0，它是自己的一位
        // `PtrTypeFlag_Volatile`，jnc_Type.h:220）—— 见下面那一段。
        if (MUT_MODS.has(m)) continue;
        /* `volatile` 写在 `*` 后面（第二百一十一刀）：`std.Error const* readonly volatile
           m_ioError;`（io_FileStream.jnc:172，语料里 15 份文件都是这一句）。
           这与说明符里那个 `volatile`（第八十六刀，`uint64_t readonly volatile
           m_txTotalSize;`）是**同一个词、同一位**：两处都只是往 ptrTypeFlags 上或一个
           `PtrTypeFlag_Volatile`（说明符那一侧 jnc_ct_Type.cpp:197-198 的
           getPtrTypeFlagsFromModifiers，星号那一侧 jnc_ct_DeclTypeCalc.cpp:282-283），
           而那一位在 jancy 里**只**决定生成的 load / store 带不带 volatile 标记
           （jnc_ct_OperatorMgr_DataRef.cpp:94 与 :208 那两个实参）—— 不改类型、不改布局、
           不改取哪一格。所以既然第八十六刀那一侧已经收下不看，这一侧拦着只是同一句话说了两遍。
           **代价与第八十六刀同一笔**：这一层没有线程，方言里也没有"这一格不许缓存"那一位，
           真有宿主那边在改这一格时保证不了每次重读；等宿主面那一刀落这一位时两处一起改。 */
        if (m === 'volatile') continue;
        /* 调用约定那三个词写在 `*` **后面**（第二百〇三刀）：`char const thin* stdcall f()`
           （io_JLink.jnc:218）。星号后面那一组词本来就归声明（第七十二刀），而这三个词在
           方言的目标（arm64 与 x86-64 SysV）上与 cdecl **本来就是同一套 ABI** ——
           与 specs 那一处（`cdecl` / `stdcall` / `thiscall` 那一段注）是同一句话，所以收下不看。 */
        if (m === 'cdecl' || m === 'stdcall' || m === 'thiscall') continue;
        this.nope(node, `指针后面的修饰符 '${m}'`);
        return null;
      }
      // 类上的**第一个** `*` 不加一层（第五十二刀）：jancy 的 `calcPtrType` 对 `TypeKind_Class`
      // 走 `getClassPtrType`（jnc_ct_DeclTypeCalc.cpp:226-229），`C` 与 `C*` 是同一个表示 ——
      // 差的只是"声明它要不要造一个对象"。第二个 `*` 才是真的数据指针（`C**`，test151.jnc:20）。
      if (isClass(t) && t.own === true) {
        if (thin) { this.nope(node, '`thin` 用在类指针上（类指针不是数据指针）'); return null; }
        t = tClass(t.name, false);
        continue;
      }
      /* 函数类型的 typedef 上那个 `*`（第八十二刀）：`FormatFunc* m_f;` —— 那一格是**函数
         指针**，不是"指向函数指针的指针"。jancy 同（getFunctionPtrType，
         jnc_ct_DeclTypeCalc.cpp:674-685）。第二个 `*` 就落到下面那句上，与 `function**`
         同一堵墙（那一格还不收）。 */
      if (t.k === 'fnty0') { t = tFn(t.params, t.ret, thin); continue; }
      t = thin ? tThin(t) : tPtr(t);
    }
    /* 一个 `*` 都没带的函数类型名（第八十二刀）：`FormatFunc f;` —— jancy 那边也不成立
       （函数类型的变量没有表示，能用的只有 `F*`）。当场说清，别让它悄悄落成一格别的东西。 */
    if (t !== null && t !== undefined && t.k === 'fnty0') {
      this.nope(node, '一格函数类型的变量（那是 typedef 起的函数类型名 —— 能用的只有 `名字*`）');
      return null;
    }
    return t;
  }

  specsTy(n) {
    const sp = this.specs(n);
    if (sp === null) return null;
    // `function` 写在没有声明符的地方（强制转换的目标、`new` 的类型）时形参表无处可挂 ——
    // 而 jancy 那边这一格正是"显式转换生成一段 thunk"（type_ptr_function.rst），
    // 那是自己一格（第五十五刀）。
    if (sp.fnptr) { this.nope(n, '没有形参表的 `function` 类型（强制转换成函数指针要生成 thunk）'); return null; }
    if (sp.thin) { this.nope(n, '`thin` 用在不是指针的类型上'); return null; }
    return sp.type;
  }

  /** `(dcl 前缀 核心 后缀 构造)` -> `{name, type, formals, ctor, special, sp}`。
   *  `formals` 不是 null 就说明这是个**函数**声明符（后缀里有一对括号）。
   *  `ctor` 不是 null 就说明名字后面挂着一串构造实参（`C1 c(100)` / `C1 g_a construct(1)`，
   *  type_class.rst:143-149）。`special` 不是 null 就说明核心是 `construct` /
   *  `static construct`，这时 `name` 是**类名那一半**（体外写法带着它，体内写法是空的）。
   *  `sp` 是**这一格声明符自己**的说明符袋子（第七十二刀）：`T* property p` 里那个 property
   *  写在星号后面，属于声明而不属于指针，所以袋子要按声明符补一次 —— 关心 prop / cst / agt
   *  的调用方一律读 `info.sp`，不要读自己那一份。
   *  `allowBits` 只有结构体的字段那两处开（第一百一十二刀）：位域后缀 `: 3` 在别处（局部量、
   *  形参、返回类型）照旧当场拒 —— 那几处 jancy 自己也不给写。开着的时候位数进 `info.bits`。 */
  declarator(d, sp, spNode = null, allowVirt = false, allowBits = false) {
    if (!isList(d) || head(d) !== 'dcl') return this.err(d, '认不出的声明符');
    // `T* … property p`（第七十二刀）：最后一个 `*` 后面那一组词是**这条声明**的词，不是那格
    // 指针的（三条引文都在 tailMods 那处）。这儿只把 property 那一族提上来，而且提的条件是
    // 那一组里真写着 `property` —— 于是 `int* thin p` 这类"指针的词写在后面"照旧拦着，不会被
    // 悄悄当成一格 thin 指针。
    const tail = this.tailMods(d);
    let dropTail = false;
    if (tail.includes('property') && spNode !== null) {
      // 属性这条声明能带的词就是 jancy 那张 `TypeModifierMaskKind_Property`
      //（jnc_ct_Decl.h:75-85：Property | ErrorCode | Const | ReadOnly | AutoGet | Bindable |
      // Indexed | BigEndian | Volatile | 调用约定）里这一层认得的那几个。
      const bad = tail.find((m) => !PROP_TAIL_MODS.has(m));
      if (bad !== undefined) return this.nope(d, `属性的声明里 '*' 后面的 '${bad}'`);
      const sp2 = this.specs(spNode, allowVirt, tail);
      if (sp2 === null) return null;
      sp = sp2;
      dropTail = true;
    }
    /* `errorcode` 写在星号后面（第一百三十三刀）：`ListEntry* errorcode add(variant_t data)`
       （std_List.jnc:146，语料里这个形状 9 处，std_List / std_HashTable / std_RbTree）。
       它与上面那个 `property` 是**同一条**（第七十二刀）：最后一个 `*` 后面那一组词是这条
       **声明**的词 —— `errorcode` 说的是"这个函数会传错误码回来"，与那格指针无关。
       只在这一组里除了 `errorcode` **全是可变性那几个词**时才提（那几个在指针上本来就是
       收下不看的，第六十七刀）；混着别的词就照旧走下面那条路让它当场报出来 ——
       悄悄把一个没认出来的词丢掉，那是改了意思。 */
    if (!dropTail && tail.includes('errorcode')
      && tail.every((m) => m === 'errorcode' || MUT_MODS.has(m))) {
      // 说明符那一格拿得到就照常重问（那样 `errorcode` 与说明符里别的词一起过一遍规矩）；
      // 拿不到的那几处（函数声明符那条路不传 spNode）就在袋子上补这一位 —— 两条路的结果
      // 一样，只是后一条问不着"这个词与那个词打不打架"。
      if (spNode !== null) {
        const sp2 = this.specs(spNode, allowVirt, tail);
        if (sp2 === null) return null;
        sp = sp2;
      } else if (!sp.errc) {
        sp = { ...sp, errc: true };
      }
      dropTail = true;
    }
    // `int property* p` 是**属性指针**（35_PropertyPtr.jnc:97-126）：那个词写在星号**前面**，
    // 于是它进的是那格 `*` 自己的 prefix，落出来是 `getPropertyPtrType`
    // （jnc_ct_DeclTypeCalc.cpp:80-85）—— 里头存的是"取/存两个函数 + 那个对象"，与一格普通
    // 指针两码事。第七十刀在函数体与形参那两处拦过它，可顶层与类体里当时漏着：那儿会把它
    // **悄悄登记成一格"类型是 int* 的属性"**。一处拦住，三处都对。
    if (sp.prop && !dropTail && this.flat(d.items[1]).length > 0) {
      return this.nope(d, '属性指针（`int property* p` —— 那一格里存的是"取/存两个函数 + '
        + '那个对象"，与一格普通指针两码事）');
    }
    // 声明符尾巴上的构造实参（第五十三刀）。jancy 为了躲开 `C1 a();` 的歧义把空实参那一种
    // 写成 `C1 a construct();`，带实参的两种写法都收（type_class.rst:125-149）。
    let ctor = null;
    if (isList(d.items[4]) && head(d.items[4]) !== 'no-ctor') {
      if (head(d.items[4]) !== 'ctor') return this.nope(d, `声明符尾巴上的 '${head(d.items[4])}'`);
      ctor = d.items[4].items[1];
    }
    // 特殊成员的声明符（第五十三刀）：`construct` / `static construct` 收，别的还不收 ——
    // 与类体里那一遍报的是同一句（顶层也写得出 `destruct()`，那是模块析构，test138.jnc:7）。
    const sk = specialCore(d);
    if (sk !== null) {
      // 属性的取/存（第六十八刀）：`int g_p.get()` / `g_p.set(int x)` —— 与 construct
      // 一样是"限定名 + 特殊名 + 一对括号"，只是取值器那一格有返回类型（从 sp 抄）。
      const acc = sk === 'get' || sk === 'set';
      /* 算符重载：第一百三十刀收了**赋值**那一个（`operator :=`），第一百三十一刀再收
         **自增自减**那四个（`operator ++` / `operator --` 与它们的 postfix 变体，语料里
         stdt_Iterator.jnc:36-54 四个都写着）。剩下那几个（`*` / `->` / `()` / `bool`）要在
         **求值**那条路上认（那一格取的是值，不是语句），是自己一刀 —— 明说，不混进来。 */
      const isOp = isOpSpecial(sk);
      if (isOp && !OP_NAME.has(sk)) return this.nope(d.items[2], `算符重载 '${sk}'`);
      if (!acc && !isOp && sk !== 'construct' && sk !== 'static construct') {
        return this.specialNope(d.items[2], sk);
      }
      const core = d.items[2];
      let owner = '';
      if (isList(core) && head(core) === 'qualified-special') {
        owner = this.qname(core.items[1]);
        if (owner === null) return this.nope(core, '认不出的限定名');
      }
      let formals0 = null;
      for (const s of this.flat(d.items[3])) {
        if (isList(s) && head(s) === 'fn-suffix') { formals0 = s.items[1]; continue; }
        // `construct() thin { … }`（第八十九刀，std_Guid.jnc:74）：形参表之后那格修饰符
        // 收下不看，与普通声明符那一处同一条。
        if (isList(s) && head(s) === 'post-modifier') continue;
        return this.nope(s, `${sk} 上的声明符后缀 '${isList(s) ? head(s) : '?'}'`);
      }
      if (formals0 === null) return this.err(d, `'${sk}' 后面要一对括号`);
      // 取值器的返回类型也要过那一串 `*`（第七十二刀）：`Icon* g_p.get()` 回的是 `Icon*`。
      // 先前这儿直接抄 `sp.type`，于是星号被吞掉 —— 类型是指针的属性因此永远对不上它自己的
      // 取值器（报的是"回的是 int，而属性是 int*"，认错了人）。
      let at = J_VOID;
      if (acc || isOp) {
        at = this.ptrsTy(sp, d.items[1], d, dropTail);
        if (at === null) return null;
      }
      return {
        name: owner,
        type: at,
        formals: formals0,
        ctor: null,
        special: sk,
        sp,
        bits: null,
      };
    }
    const name = this.qname(d.items[2]);
    if (name === null) return this.nope(d.items[2], '限定名或特殊名的声明符');
    // 函数指针（第五十五刀）：`function` 一出现，名字后面那对括号就不是"这是个函数声明"，
    // 而是**这一格的类型**的形参表 —— 所以它走自己那一支，不进下面的数组/函数后缀那套。
    if (sp.fnptr) return this.fnPtrDcl(d, sp, name, ctor);
    let t = this.ptrsTy(sp, d.items[1], d, dropTail);
    if (t === null) return null;
    let formals = null;
    // 数组后缀先攒着，出了循环再**从右往左**套（第十九刀）：`int a[10][20]` 的元素是
    // `int[20]`，所以里层是最后那个 `[20]`。从左往右叠会得到 `int[20][10]` —— 一维时
    // 看不出差别，多维就错了。
    const dims = [];
    let bits = null;
    for (const s of this.flat(d.items[3])) {
      const sh = isList(s) ? head(s) : null;
      if (sh === 'fn-suffix') {
        if (formals !== null) return this.nope(s, '返回函数的函数');
        formals = s.items[1];
        continue;
      }
      // `int a[3]` / `int a[]`（ADR-0016 第十刀）。长度**只认整数字面量** —— jancy 那边
      // 它是编译期常量表达式，我们没有常量折叠，所以先收最直的这一格。`[]` 的长度从花括号
      // 初值数出来，那要 localDeclCurly 才知道，所以这里先记成 n === null。
      if (sh === 'array-suffix') {
        // 类的数组 jancy 自己就拒（`getArrayType` 的 `TypeKind_Class` 那一支，
        // jnc_ct_DeclTypeCalc.cpp:384-390）—— 那不是"还不收"，是写错了（第五十二刀）。
        if (isClass(t) && t.own === true) {
          return this.err(s, `不能造类的数组（jancy 那句 "cannot create array of '${tyName(t)}'"）`);
        }
        // 枚举也进得来（第三十九刀）：它的 `tyText` 就是 `int`，一个字的标量，与 `int`
        // 的元素同一格；不同的只是名字与它带的成员表。
        /* **类指针**也进得来（第二百二十三刀）：这一层的类值就是一格地址（第五十二刀），
           一个字，与 `int` 的元素同一格 —— `(blk (ptr C) 3)` 方言本来就收。榜上这一族是
           `ui.Action*` 42 / `ui.Icon*` 40 / `ui.StatusPane*` 34 那几行（ioninja 的工具栏、
           图标、状态栏）。先前门上那句话（"要方言能把多个字的值当元素搬"）对 fat 数据指针、
           string 与函数值是对的，可**对类指针不对** —— 它多拦了一种。 */
        if (t.k !== 'int' && t !== J_REAL && t !== J_BOOL && !jncIsStruct(t) && !jncIsEnum(t)
          && !(isClass(t) && t.own === false)) {
          return this.nope(s, `${tyName(t)} 的数组 —— fat 数据指针是三个字、string 与函数值`
            + '旁边还挂着表（ADR-0024 / ADR-0026），那几种要方言能把多个字的值当元素搬'
            + '（与 &p 同一格）；一个字的那几种（整数 / 实数 / 布尔 / 枚举 / 类指针）与结构体'
            + '都收');
        }
        const cnt = s.items[1];
        if (isList(cnt) && head(cnt) === 'none') {
          // 只有**最外**那一维能是 `[]`（C 与 jancy 同）：里层的长度是元素的尺寸，数不出来。
          if (dims.length > 0) return this.err(s, '只有最外那一维能写成 `[]`，里层的长度省不掉');
          dims.push(null);
          continue;
        }
        // 长度走编译期求值（第四十八刀）：jancy 那边这一格就是 `parseConstIntegerExpression`
        //（`ArrayType::calcLayout`，jnc_ct_ArrayType.cpp:175），与枚举成员的值同一个入口。
        const kn = this.constInt(cnt);
        if (kn === null) {
          return this.nope(s, '数组长度不是能在编译期算出来的整数');
        }
        if (kn < 1n) return this.err(s, `数组长度要至少 1，这里是 ${kn}`);
        if (kn > 1000000n) return this.err(s, `数组长度最多 1000000，这里是 ${kn}`);
        const nn = Number(kn);
        dims.push(nn);
        continue;
      }
      /* 形参表之后的修饰符（第八十九刀）：`… ) const` / `const?` / `thin`
         （jancy 的 this_modifier_suffix，Declarator.llk:512-525）。它说的是"this 那一格"
         的可变性与胖瘦 —— 这一层没有可变性检查、也没有 thin 那格调用约定，所以收下不看，
         与说明符里的 `const` / `readonly` / `thin` 同一条。 */
      if (sh === 'post-modifier') continue;
      /* 位域（第一百一十二刀）：`uint8_t m_flag : 1;`（Declarator.llk:494-499）。
         位数在这一层就要是个**编译期整数** —— jancy 那边它是 `parseConstIntegerExpression`
         （Parser.cpp:2246 那一带），与数组长度、枚举成员的值同一个入口。
         `allowBits` 关着的地方（局部量、形参、返回类型、类的字段）照旧当场拒：那几处
         位域要么 jancy 自己也不给写，要么这一刀没落（类的那一格见 ADR-0016 那一节）。 */
      if (sh === 'bitfield') {
        if (!allowBits) {
          return this.nope(s, '这个位置上的位域（`: 位数` 只在结构体的字段上）');
        }
        if (bits !== null) return this.err(s, '一格字段上写了两个 `: 位数`');
        const kb = this.constInt(s.items[1]);
        if (kb === null) return this.nope(s, '位域的位数不是能在编译期算出来的整数');
        if (kb < 1n) return this.err(s, `位域的位数要至少 1，这里是 ${kb}`);
        bits = Number(kb);
        continue;
      }
      return this.nope(s, `声明符后缀 '${sh}'`);
    }
    for (let i = dims.length - 1; i >= 0; i--) t = tArr(t, dims[i]);
    /* 一个 `*` 都没带的函数类型名（第八十二刀）：`Binop f;` —— jancy 那边也不成立（函数类型
       的变量没有表示，能用的只有 `F*`）。拦在这一处是因为这儿是**所有**声明符的出口：
       局部量、模块级、字段、形参、返回类型都从这儿拿 type，漏一处就会把 fnty0 那一格
       当成一个真类型带下去（量过：那时下游报的是"fnty0 的局部量不写初值"）。
       `typedef` 自己那一处在它前面就分岔了（它要的正是这一格）。 */
    if (t !== null && t !== undefined && t.k === 'fnty0') {
      return this.nope(d, `一格函数类型的变量（'${name}' 的类型是 typedef 起的函数类型名 ——`
        + ' 能用的只有 `名字*`）');
    }
    return { name, type: t, formals, ctor, special: null, sp, bits };
  }

  /**
   * 函数指针那一格的声明符（第五十五刀）。`R function* p(形参)` 的三块分散在三处：
   * 返回类型在说明符里（`sp.type`）、`*` 在 `ptrs` 里、形参表是名字后面的 `fn-suffix`。
   * 拼起来就是一格 `tFn`，落到方言的 `(fnty …)`。
   *
   * `thin` 也从说明符里来（`function thin* p(int)`）：它在这一层只进类型的名字 ——
   * 方言那一格装得下两者（thin 就是捕获为空的 fat），而 jancy 自己也允许 thin 转成 fat。
   */
  fnPtrDcl(d, sp, name, ctor) {
    const stars = this.flat(d.items[1]);
    for (const g of stars) {
      const mods = this.flat(g).flatMap((m) => this.flat(m)).map((m) => (isAtom(m) ? m.value : '?'));
      for (const m of mods) {
        // 与 ptrsTy 那处同一族（第六十七刀）：可变性那三个词收下不看。
        if (MUT_MODS.has(m)) continue;
        // `weak` 是弱引用那一族（type_ptr_function.rst 的 "function weak*"）：它要 GC
        // 那一侧的弱引用语义，而这一层没有。
        return this.nope(d, `函数指针后面的修饰符 '${m}'`);
      }
    }
    if (stars.length === 0) {
      return this.err(d, `'${name}' 上写了 function 却没有 '*'（jancy 的函数指针写成 `
        + "'R function* p(…)'）");
    }
    // `function**` 是"指向函数指针的指针"（同一处文档里那个 `f5` 数组用的就是它）——
    // 那要方言能对函数值那一格取地址，与"函数指针的数组"是同一件事。
    if (stars.length > 1) return this.nope(d, '指向函数指针的指针（`function**`）');
    let formals = null;
    for (const s of this.flat(d.items[3])) {
      const sh = isList(s) ? head(s) : null;
      if (sh === 'fn-suffix') {
        if (formals !== null) return this.nope(s, '函数指针上的第二个形参表');
        formals = s.items[1];
        continue;
      }
      if (sh === 'array-suffix') return this.nope(s, '函数指针的数组（要方言能把函数值当元素搬）');
      return this.nope(s, `函数指针上的声明符后缀 '${sh}'`);
    }
    if (formals === null) return this.err(d, `'${name}' 是函数指针，后面要一对形参表`);
    const params = [];
    for (const f of this.flat(formals)) {
      const fh = isList(f) ? head(f) : null;
      if (fh === 'formals-varargs') return this.nope(f, '函数指针的可变形参');
      if (fh !== 'formal' && fh !== 'formal-anon') return this.nope(f, `函数指针的形参 '${fh}'`);
      const fsp = this.specs(f.items[1]);
      if (fsp === null) return null;
      // 无名形参（`int function* p(int, int)` 里那两个 int）在**类型**上是常态：类型只要
      // 签名，名字是被调那一头的事。所以这儿不像 fnSig0 那样拒它。
      let ft = null;
      if (fh === 'formal-anon') {
        ft = this.ptrsTy(fsp, f.items[2], f);
      } else {
        if (f.items[3] !== undefined) return this.nope(f, '函数指针形参的默认值');
        const fi = this.declarator(f.items[2], fsp);
        if (fi === null) return null;
        if (fi.formals !== null) return this.nope(f, '函数指针的形参又带形参表');
        ft = fi.type;
      }
      if (ft === null) return null;
      if (ft === J_VOID) continue;                 // `void` 的形参表就是"不带形参"（C 与 jancy 同）
      params.push(ft);
    }
    return {
      name, type: tFn(params, sp.type, sp.thin), formals: null, ctor, special: null, sp, bits: null,
    };
  }

  /* -------------------------------------------------------------- 函数 */

  /**
   * 签名那一半（第十五刀）。jancy 的命名空间成员**不看顺序** —— 后面定义的函数也调得着，
   * 所以所有签名要在**任何函数体之前**登记好（run 里那一遍）。这一份只算说明符、声明符与
   * 形参表，不碰函数体；结果按节点存进 `this.sigs`，`fnDef` 拿回去接着用（免得算两遍、
   * 也免得同一条诊断发两遍）。
   */
  fnSig(n) {
    // 体外写的方法（第五十二刀）：签名里的类型名也要在**那个类**那一层里查得着 ——
    // `S1 C.foo()` 的 S1 就是 `C.S1`（test97.jnc:15）。所以先把那一格摆好再解签名。
    // 用的是 nsExtra 而不是 ns：登记那一处要的是源码里写的 `C.foo`（qual 不能再叠前缀）。
    const saveExtra = this.nsExtra;
    this.nsExtra = this.declOwner(n.items[2]);
    const r = this.fnSig0(n);
    this.nsExtra = saveExtra;
    return r;
  }

  /** 这个声明符是"某个类的成员"吗（第五十二刀）：`C.foo` 里的 `C` 是类就回它的全名。
   *  `C.construct` 走的是另一个形状（`qualified-special`），不过问的是同一件事（第五十三刀）。 */
  declOwner(d) {
    if (!isList(d) || head(d) !== 'dcl') return null;
    const core = d.items[2];
    if (!isList(core)) return null;
    const ch = head(core);
    if (ch !== 'qualified' && ch !== 'qualified-special') return null;
    const left = this.qname(core.items[1]);
    if (left === null) return null;
    return this.resolve(left, (k) => this.classes.has(k));
  }

  /** 形参表 -> `{name, type, formals, def}` 一串（抽出来是因为方法**原型**也要问它：
   *  `abstract void foo(int x);` 永远没有体，签名只能从原型上来，第五十七刀）。
   *  `def` 是形参的默认值那一格的**语法节点**（第七十七刀），没写就是 null。
   *
   *  `vaOk` 是"这条声明收得下 `...` 吗"（第一百九十五刀）：**只有原型**的那种收得下 ——
   *  那一段在调用点按 C 的默认实参提升摆进 `(ccall …)` 里，与 `with "h.h"` 收来的那些
   *  变参声明是同一条路（`(cabi f R (T ...))`）。带体的收不下：体里读那一段要 `va_list`
   *  那一套，这一层没有。收下时回的那串上挂一格 `variadic`。 */
  formalList(formalsNode, vaOk = false) {
    let node = formalsNode;
    let va = false;
    if (isList(formalsNode) && head(formalsNode) === 'formals-varargs') {
      if (!vaOk) {
        return this.nope(formalsNode, '可变形参（只有原型的那种收得下 —— 带体的要 `va_list` 那一套）');
      }
      node = formalsNode.items[1];
      va = true;
    }
    const ps = [];
    if (va) ps.variadic = true;
    for (const f of this.flat(node)) {
      const fh = isList(f) ? head(f) : null;
      if (fh === 'formals-varargs') return this.nope(f, '可变形参');
      /* **无名形参**（第二百二十六刀）：`void foo(int);` —— jancy 收它（形参的名字只在体里
         有用，原型上根本用不着）。语料里的出处是 jancy 自己那两份导出样例
         （jnc_sample_01_export_c/script.jnc:19-21 的三条 `void foo(…);` 重载）。
         树上它是 `(formal-anon specs ptrs)`：没有声明符，所以类型就是"说明符 + 那串 `*`"。
         落法是给它编一个源码里写不出来的名字（`$a<序号>`，`$` 不在标识符里）—— 体里没法引用它，
         而这一层往下每一处要的都只是"第 i 格形参的类型"。 */
      if (fh === 'formal-anon') {
        const asp = this.specs(f.items[1]);
        if (asp === null) return null;
        if (asp.prop) return this.nope(f, '形参上的属性（属性指针要一格"属性指针"类型）');
        const at = this.ptrsTy(asp, f.items[2], f);
        if (at === null) return null;
        if (isArr(at) && at.n === null) {
          return this.err(f, `无名形参的长度省不掉（jancy 那句 "function cannot accept `
            + `auto-size array '${tyName(at)}' as an argument"）`);
        }
        if (isClass(at) && at.own === true) {
          return this.err(f, `无名形参的类型是类（jancy 那句 "function cannot accept `
            + `'${tyName(at)}' as an argument"）—— 类只能经引用传，写成 '${shown(at.name)}*'`);
        }
        ps.push({ name: `$a${ps.length}`, type: at, formals: null, bits: null, ctor: null, def: null });
        continue;
      }
      if (fh !== 'formal') return this.nope(f, `形参 '${fh}'`);
      const defNode = f.items[3] === undefined ? null : f.items[3];
      /* 默认值挂在**哪一格上都行**（第九十九刀）。先前这儿照 C++ 那条"只能挂末尾"拦着，
         理由写的是"中间那格空着调用点说不清"—— 那句在 jancy 上不成立：它检查默认值是
         **按位置一格一格**问的（`OperatorMgr_Call.cpp:421-435` 与 :447-460 那两段循环，
         报的是 "argument (%d) of '%s' has no default value"），而中间那一格空着怎么说，
         第八十八刀已经给出来了 —— `f(1,,3)`。所以这儿不该拦。 */
      const fsp = this.specs(f.items[1]);
      // 形参的类型认不出来时也把名字记下来（第二百三十五刀，与 localDecl 那一处同一条）
      if (fsp === null) { this.badDeclNames(f.items[2]); return null; }
      // 形参上的 `property`（第七十刀）：那是一格**属性指针**（`int property* p`，
      // 35_PropertyPtr.jnc:97-126）—— 里头存的是"取/存两个函数 + 那个对象"，与函数指针两码事。
      // 这一层没有那一格类型，而 `property` 这个词 specs 是收下的：不在这儿拦就会被悄悄
      // 降成一格普通指针。
      if (fsp.prop) return this.nope(f, '形参上的属性（属性指针要一格"属性指针"类型）');
      const fi = this.declarator(f.items[2], fsp);
      if (fi === null) return null;
      if (fi.formals !== null) return this.nope(f, '函数类型的形参');
      // 数组形参（第二十一刀）。jancy **不是 C**：`createFormalArg`（jnc_ct_Parser.cpp:2507）
      // 不做"形参退化成 `T*`"，形参的类型就还是 `T[N]`，传的是**一整块的一份拷贝**。
      // 它自己只拒长度省掉的那一种（同一处 2528 那句 "function cannot accept auto-size
      // array '%s' as an argument"，AutoSize 见 DeclTypeCalc.cpp:421）。
      if (isArr(fi.type) && fi.type.n === null) {
        return this.err(f, `形参 '${fi.name}' 的长度省不掉（jancy 那句 "function cannot accept `
          + `auto-size array '${tyName(fi.type)}' as an argument"）`);
      }
      // 类**值**当形参 jancy 自己就拒（`createFormalArg` 的 `TypeKind_Class` 那一支，
      // jnc_ct_Parser.cpp:2537-2545）：类只能经引用传，写法是 `C*`（第五十二刀）。
      if (isClass(fi.type) && fi.type.own === true) {
        return this.err(f, `形参 '${fi.name}' 的类型是类（jancy 那句 "function cannot accept `
          + `'${tyName(fi.type)}' as an argument"）—— 类只能经引用传，写成 '${shown(fi.type.name)}*'`);
      }
      ps.push({ ...fi, def: defNode });
    }
    return ps;
  }

  /**
   * 调用点补默认值（第七十七刀）：末尾少给的那几格换成声明里那几个默认值的**语法节点**，
   * 于是它们与写出来的实参走同一条路（同一份类型检查、同一句诊断）。
   *
   * 补的位置是**调用点**，和 C++ / jancy 同一头。这带来一个真问题：默认值里如果写了名字，
   * 查的是**调用点**的作用域，而不是声明那里的 —— 名字撞上调用方的局部量就会静静地取错。
   * 所以这一层给默认值划一条窄界（defShapeOk）：字面量、`true`/`false`/`null`、枚举成员，
   * 以及它们的一元/二元运算。语料量出来的形状正好在这条界里（null 124、0 114、1 59、
   * false 39、-1 33、true 31、0x01/0x02 那些、以及 `State.Opened` 那种枚举成员）。
   * 别的（调用、全局量、`sizeof`、字符串拼接…）当场说"还不收"，不猜。
   *
   * **空槽**（第八十八刀）：jancy 还允许 `f(1,,3)` / `f(,x)` —— 中间那一格空着就是"用它的
   * 默认值"（语法里是一条空产生式，落成 `(unbound)`；语料里的写法见 ui_SocketUi.jnc:107）。
   * 落法与末尾那几格**完全一样**：把 `(unbound)` 换成那个形参的默认值节点，同一条界、
   * 同一句诊断。所以这一处先扫一遍空槽、再补末尾。
   *
   * **第一百〇五刀**：老那条界（defShapeOk）照旧一个字不动 —— 过得了它的仍旧原样搬过去。
   * 过不了的再试一次"在**声明那一头**的作用域里当编译期整数折"（defConstNode）：折得动就把
   * 那一格换成**一格字面量**。于是名字根本没进调用点，上面那条"名字撞上调用方局部量"的隐患
   * 从源头没了 —— 换过去的是一个数，不是一个待查的名字。`defNs` 是那个函数全名去掉最后一段
   * （`ui$ToolBar$addSpacing` -> `ui$ToolBar`），resolve 从那儿往外退，正是声明处的查名顺序。
   */
  withDefaults(args, want, defs, defNs = null) {
    const out = args.slice();
    for (let i = 0; i < out.length; i++) {
      if (!isList(out[i]) || head(out[i]) !== 'unbound') continue;
      const d = defs === null || i >= want.length ? null : defs[i];
      if (d === null) {
        return this.err(out[i], `第 ${i + 1} 个实参是空的，而它那个形参没有默认值`);
      }
      const v = this.defArg(d, defNs);
      if (v === null) return null;
      out[i] = v;
    }
    if (defs === null || out.length >= want.length) return out;
    for (let i = out.length; i < want.length; i++) {
      const d = defs[i];
      if (d === null) break;              // 中间那格没有默认值：个数照旧对不上，由调用方报
      const v = this.defArg(d, defNs);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  }

  /** 一格默认值搬到调用点上：先过老那条界，再试折成字面量，都不成就是"还不收"。 */
  defArg(d, defNs) {
    if (this.defShapeOk(d)) return d;
    const lit = this.defConstNode(d, defNs);
    if (lit !== null) return lit;
    return this.nope(d, '这个形状的默认值（默认值是在调用点算的，所以只收字面量、'
      + '`true`/`false`/`null`、枚举成员、在声明那一头算得出来的编译期整数，与它们的运算）');
  }

  /**
   * 把一格默认值当**编译期整数**折（第一百〇五刀），折得动就造一格字面量节点顶上去。
   *
   * 折是在 `defNs`（声明那一头）里做的 —— 语料里最多的一种就是这个：
   * `void addSpacing(int size = Def_Spacing);`（ui_ToolBar.jnc:45，`Def_Spacing` 是
   * `opaque class ToolBar` 里那格**无名枚举**的成员，第九十六刀漏到类那一层），
   * 调用它的插件在别的命名空间里，按调用点查名一定查不着。
   *
   * 只走 constInt 这一条路 —— 它认字面量、字符字面量（第九十七刀）、枚举成员、无名枚举漏出来
   * 的那些（第九十六刀）以及它们的一元 / 二元运算，都是**真的编译期常量**，折出来一个数。
   * 折不动就返回 null，交回上面那句"还不收"。
   */
  defConstNode(d, defNs) {
    const save = this.ns;
    if (defNs !== null) this.ns = defNs;
    const k = this.constInt(d);
    this.ns = save;
    if (k === null) return null;
    const sp = d.span;
    const at = (v) => ({ kind: 'atom', value: v, span: sp });
    const lit = at(String(k < 0n ? -k : k));
    // 负数：字面量本身只收非负那一串（numLit 的 `^[0-9]+$`），减号照 jancy 一样在字面量之外
    return k < 0n
      ? { kind: 'list', span: sp, items: [at('unary'), { kind: 'string', value: '-', span: sp }, lit] }
      : lit;
  }


  /** 默认值里允许的形状。`(field (name E) A)` 只在 E 真是个枚举时算数 —— 同一个形状也可能是
   *  `obj.field`，那一格取的是调用方的局部量，正是这条界要拦的东西。 */
  defShapeOk(n) {
    if (!isList(n)) return true;                       // 字面量（数、字符）就是一格原子
    if (isStr(n)) return true;
    const h = head(n);
    if (h === 'true' || h === 'false' || h === 'null') return true;
    if (h === 'field') {
      const base = n.items[1];
      if (!isList(base) || head(base) !== 'name' || !isAtom(base.items[1])) return false;
      return this.resolve(base.items[1].value, (k) => this.enums.has(k)) !== null;
    }
    // 一元 / 二元：第一格是运算符（一份字符串），后面才是操作数
    if (h === 'unary' || h === 'binary') return n.items.slice(2).every((x) => this.defShapeOk(x));
    return false;
  }

  /**
   * 这条表达式整体是**一格属性的名字**吗（第六十八刀）。`g_p` 是一个 name，`cfg.level` 在
   * 语法那一层是一串 field —— 摊得动才算限定名，与 callName 里问"被调的是不是限定名"同一条。
   */
  propRef(n) {
    if (!isList(n)) return null;
    const h = head(n);
    if (h !== 'name' && h !== 'field') return null;
    const nm = this.dotted(n);
    if (nm === null) return null;
    return this.propBare(nm);
  }

  /** 方法体里裸写的属性名（第六十九刀）：先按命名空间从里往外查（类是一层命名空间，所以
   *  `C$m_a` 这一格 resolve 就找着了），查不着再沿**基类链**找一格 —— resolve 不走继承链，
   *  与 callName 里裸写方法名那一条（findMethod）是同一个形状。 */
  propBare(nm) {
    const q = this.resolve(nm, (k) => this.props.has(k));
    if (q !== null) return q;
    if (this.selfClass === null || nm.includes('.')) return null;
    return this.findProp(this.selfClass, nm);
  }

  /**
   * `obj.p` 里那个 p 是**成员属性**吗（第六十九刀）。是就把属性的全名与那格对象一起回；
   * 左边不是类、或者那条继承链上没有这个属性时回 undefined —— 那条路继续当"取字段"走，
   * 诊断留给那一处发。左边算不出来回 null。与第五十五刀的 methodRef 是同一个形状。
   */
  propMember(n, mn) {
    const ob = n.items[1];
    let bv = null;
    // `.` 的左边读出来那一格（第一百一十六刀抽成一处，属性走取值器）
    bv = this.baseVal(ob);
    if (bv === null) return null;
    /* 结构体也算（第一百九十八刀）：`S` 与 `S*` 两种写法都算 —— 这一层的结构体值那一格里
       放的**本来就是地址**（第十二刀），所以两边的 `bv.code` 是同一个东西，`.` 的左边写哪个
       都对得上（语料里的原样是 `getLastError().m_description`，std_Error.jnc:104 —— 左边是
       一格 `Error const*`）。 */
    const own = isClass(bv.type) || bv.type.k === 'struct' ? bv.type.name
      : (jncIsPtr(bv.type) && bv.type.target.k === 'struct' ? bv.type.target.name : null);
    if (own === null) return undefined;
    const pn = this.findProp(own, mn);
    if (pn === null) return undefined;
    return { pn, self: bv.code };
  }

  /**
   * 属性那两个函数的第一个实参（第六十九刀）：成员属性要一格对象。
   *
   * `obj.p` 那一处已经把对象算出来了，直接传进来；方法体里裸写属性名时补 `this` —— 与第
   * 五十二刀给 `foo()` 补 this 是同一条，基类的属性也算（一条继承链共用一格方言结构体，
   * 所以 `this` 那一格与基类那一格同型）。顶层的属性回空串。
   */
  propSelf(n, pn, pi, self) {
    if (pi.cls === null) return '';
    if (self !== null) return ` ${self}`;
    if (this.selfClass !== pi.cls && !this.isBase(pi.cls, this.selfClass)) {
      this.err(n, `'${shown(pn)}' 是 ${shown(pi.cls)} 的属性，要一个对象才读得着`);
      return null;
    }
    return ' (var $this)';
  }

  /**
   * 索引属性的下标（第七十刀）：`p[i][j]` 里那几格就是取/存两个函数最前面那几个实参
   * （prop_indexed.rst:15 —— 属性带数组语义，可下标的类型与含义都由写的人定，不一定是整数、
   * 也不一定真当索引用）。个数与类型照声明里那一串查，回一串能直接拼进 `(call …)` 的文本；
   * 不对就发一条诊断回 null。普通属性回空串。
   */
  propIndexArgs(n, pn, pi, subs) {
    if (subs.length !== pi.idx.length) {
      return this.err(n, pi.idx.length === 0
        ? `'${shown(pn)}' 不是索引属性，后面挂不了下标`
        : `索引属性 '${shown(pn)}' 要 ${pi.idx.length} 个下标，这里给了 ${subs.length} 个`);
    }
    let out = '';
    for (let i = 0; i < subs.length; i++) {
      let v = this.expr(subs[i], pi.idx[i]);
      if (v === null) return null;
      if (isInt(v.type) && isInt(pi.idx[i])) v = intConv(v, pi.idx[i]);
      if (!this.assignOk(v.type, pi.idx[i])) {
        return this.err(subs[i], `索引属性 '${shown(pn)}' 的第 ${i + 1} 个下标要 `
          + `${tyName(pi.idx[i])}，这里是 ${tyName(v.type)}`);
      }
      out += ` ${v.code}`;
    }
    return out;
  }

  /** `p[i][j]` 这条链的底与那几格下标（第七十刀）。语法上它是一串套起来的 `index`，
   *  最外那一层是**最后**一个下标，所以从外往里 unshift。 */
  indexChain(n) {
    const subs = [];
    let cur = n;
    while (isList(cur) && head(cur) === 'index') {
      subs.unshift(cur.items[2]);
      cur = cur.items[1];
    }
    return { base: cur, subs };
  }

  /** 那对方括号是**属性读出来那一格**的，不是属性自己的（第七十二刀）。属性没声明下标、
   *  而它的类型是一格指针时就是这样：`int* property g_buf;` 里 `g_buf[0]` 先调取值器拿到那格
   *  指针、再解引用 —— 与 `int* p; p[0]` 一模一样。所以这一问回真时两处索引钩子都让路，
   *  普通那条解引用的路接着走。没声明下标又不是指针的那些照旧报"不是索引属性"。 */
  propSubOnValue(pn) {
    const pi = this.props.get(pn);
    return pi !== undefined && pi.idx.length === 0 && jncIsPtr(pi.type);
  }

  /** `p[i…]` 的读（第七十刀）：索引属性那几格下标就是取值器的实参。不是属性回 undefined
   *  （那条路继续按"解引用"走），出错回 null。 */
  propIndexGet(n) {
    const ch = this.indexChain(n);
    const t = this.propTarget(ch.base);
    if (t === undefined) return undefined;
    if (t === null) return null;
    if (this.propSubOnValue(t.pn)) return undefined;
    return this.propGet(n, t.pn, t.self, ch.subs);
  }

  /** 这条 `p` / `a.p` / `obj.p` 是一格属性吗（第七十刀把两条路并成一处）：是就回
   *  `{pn, self}`，不是回 undefined，左边算不出来回 null。 */
  propTarget(n) {
    const q = this.propRef(n);
    if (q !== null) return { pn: q, self: null };
    if (isList(n) && head(n) === 'field' && isAtom(n.items[2])
      && this.propNames.has(n.items[2].value)) {
      return this.propMember(n, n.items[2].value);
    }
    return undefined;
  }

  /**
   * 这个表达式指的是一格**事件**吗（第七十三刀）。是就把它在方言里的读法回来，不是这种形状
   * 回 undefined，算不出来回 null（与 propTarget 同一个约定）。
   *
   * 两种写法：
   *   - `bindingof(p)`：属性那格 `m_onChanged`。jancy 把这个运算符直接落在
   *     `getPropertyOnChanged` 上（Expr.llk:898-901），不是 bindable 的属性它报
   *     `'…' has no bindable event`（jnc_ct_OperatorMgr_Property.cpp:390）—— 这儿照说。
   *   - 裸名字 `m_onChanged`：存值器体里就是这么写的。属性在 jancy 那边是一层命名空间
   *     （prop_full.rst:15），而这一层把属性的全名当前缀，所以普通的名字查找就找着了。
   */
  mcRef(n) {
    if (!isList(n)) return undefined;
    if (head(n) === 'bindingof') {
      /* 里头收 `p` / `obj.p` 两种形状 —— 与读写属性同一处判定（propTarget，第七十刀把两条路
         并成一处），所以成员属性的那格对象由它算出来。 */
      const t = this.propTarget(n.items[1]);
      if (t === undefined) return this.err(n, 'bindingof(…) 里头要是一格属性');
      if (t === null) return null;
      const pi = this.props.get(t.pn);
      if (pi === undefined || pi.onch === null) {
        return this.err(n, `属性 '${shown(t.pn)}' 上没有 bindable 事件`
          + '（jancy 那句 "has no bindable event"）—— 它的声明里没写 `bindable`');
      }
      if (pi.cls === null) {
        return { code: `(var ${pi.onch})`, store: (v) => `(set ${pi.onch} ${v})`, type: J_MC };
      }
      // 成员属性那一格是**类里的一格字段**（第八十四刀）：读写就是 pload / pstore，与第
      // 八十三刀的 `obj.m_e` 同一条。
      const sf = this.propSelf(n, t.pn, pi, t.self);
      if (sf === null) return null;
      const ad = `(pfield${sf} ${pi.onch})`;
      return { code: `(pload ${ad})`, store: (v) => `(pstore ${ad} ${v})`, type: J_MC };
    }
    if (head(n) === 'name' && isAtom(n.items[1])) {
      const nm = n.items[1].value;
      const r = this.lookupRef(nm);
      if (r !== null && r.type.k === 'mc') {
        return { code: `(var ${r.dname})`, store: (v) => `(set ${r.dname} ${v})`, type: r.type };
      }
      /* 方法体里**裸写**的事件字段（第八十三刀）：`m_e += h` 就是 `this.m_e += h` ——
         类是一层命名空间，与裸写普通字段名走同一条路（selfField）。局部量遮住它，
         所以这一问排在 lookupRef 之后。 */
      if (r === null) {
        const f = this.selfField(nm);
        if (f !== null && f.type.k === 'mc') {
          const ad = `(pfield (var $this) ${f.name})`;
          return {
            code: `(pload ${ad})`,
            store: (v) => `(pstore ${ad} ${v})`,
            type: f.type,
          };
        }
      }
    }
    /* `obj.m_e` / `p.m_e`（第八十三刀）：那一格是类里的一格字段，所以它的读写就是
       `(pload (pfield 对象 m_e))` / `(pstore …)`。先按**名字**便宜地问一句是不是事件字段，
       是了才去求左边那个对象 —— 不然对着任何 `a.b` 都跑一遍左值会多发诊断。 */
    if ((head(n) === 'field' || head(n) === 'ptr-field') && isAtom(n.items[2])
      && this.evtNames.has(n.items[2].value)) {
      const lv = this.lvalue(n);
      if (lv === null) return null;
      if (lv.type.k === 'mc') {
        return {
          code: `(pload ${lv.code})`,
          store: (v) => `(pstore ${lv.code} ${v})`,
          type: lv.type,
        };
      }
    }
    return undefined;
  }

  /**
   * 事件上的那几格运算（第七十三刀）。jancy 把它们做成多播类上的**运算符别名**
   * （jnc_ct_TypeMgr.cpp:968-973）：`:=`/`=` 是 setup（只留这一个）、`+=` 是 add、
   * `-=` 是 remove。
   *
   *   - `m = null` -> 清空（换一格空的单子上去）
   *   - `m = f` / `m := f` -> 只留这一个
   *   - `m += f` -> 加一个订阅
   *   - `m -= …` -> **不收**：jancy 那边 `-=` 收的是 `+=` 回来的那格 cookie
   *     （`MulticastMethodKind_Remove` 收 `handle`），这一层的 `+=` 还不回 cookie。
   */
  mcAssign(n, mc, op, rhs, pad) {
    if (op === '-=') {
      return this.nope(n, '事件上的 `-=`（jancy 那边收的是 `+=` 回来的那格 cookie，'
        + '这一层的 `+=` 还不回那一格）');
    }
    if (op !== '=' && op !== ':=' && op !== '+=') {
      this.err(n, `事件上写不了 '${op}'（只有 = / := / += 三格）`);
      return null;
    }
    const fresh = `${pad}${mc.store(`(anew ${tyText(mc.type)} (int 0))`)}`;
    if (isList(rhs) && head(rhs) === 'null') {
      if (op === '+=') { this.err(n, '`+= null` 加不了一个空的订阅'); return null; }
      return [fresh];
    }
    const want = tFn(mc.type.params, J_VOID);
    const v = this.expr(rhs, want);
    if (v === null) return null;
    if (v.type.k !== 'fnptr' || !sameTy(v.type, want)) {
      this.err(n, `事件上挂的得是一格 \`${tyName(want)}\`，这里是 ${tyName(v.type)}`);
      return null;
    }
    const add = `${pad}(apush ${mc.code} ${v.code})`;
    return op === '+=' ? [add] : [fresh, add];
  }

  /**
   * 读一格属性（第六十八刀）：就是调取值器。属性在源码里长得像变量，所以这一问挂在
   * "名字查不着变量"之后 —— 见 `case 'name'`。成员属性多传一格对象（第六十九刀）。
   */
  propGet(n, pn, self = null, subs = []) {
    const pi = this.props.get(pn);
    const g = `${pn}$get`;
    if (!this.fns.has(g)) {
      const hv = this.hostProp(n, pn, pi, self, 'get', null, subs);
      if (hv !== undefined) return hv;
      return this.nope(n, `读属性 '${shown(pn)}' —— 它的取值器没有定义`
        + '（简单声明式的体写在别处：`T p.get() { … }`，prop_simple.rst:25）');
    }
    const sf = this.propSelf(n, pn, pi, self);
    if (sf === null) return null;
    const ix = this.propIndexArgs(n, pn, pi, subs);
    if (ix === null) return null;
    return { code: `(call ${g}${sf}${ix})`, type: pi.type };
  }

  /**
   * 写一格属性（第六十八刀）：就是调存值器。
   *
   * 复合赋值（`p += 1`）还不收：jancy 那边它是"先读一次再写一次"，而这一层的赋值降成
   * 方言的一句 —— 两次调用摆不进去。const 属性（没有存值器）写不了，那是 prop.rst:17。
   */
  propSet(n, pn, op, valNode, pad, self = null, subs = []) {
    const pi = this.props.get(pn);
    if (op !== '=') {
      return this.nope(n, `属性上的复合赋值 '${op}'（jancy 那边是先读一次再写一次，`
        + '这一层的赋值只有一句）');
    }
    if (pi.cst) {
      return this.err(n, `'${shown(pn)}' 是 const 属性（声明里写了 const，prop.rst:17），写不了`);
    }
    const s = `${pn}$set`;
    if (!this.fns.has(s)) {
      const hv = this.hostProp(n, pn, pi, self, 'set', { node: valNode, pad }, subs);
      if (hv !== undefined) return hv;
      /* `bindable` 的那一种（第二百三十一刀）：体在宿主那边这件事已经答上了（同刀），拦路的是
         **通知**那一格 —— jancy 的存值器要点一下 `m_onChanged`（prop_bindable.rst:23-29），
         而宿主那边的存值器点不着这一层这格单子（它只拿到一个不透明的地址）。悄悄发出去的话
         反应器绑上来就永远不响，那是错话，所以在这儿说清是这一件事。 */
      if (pi.onch !== null && pi.onch !== undefined) {
        return this.nope(n, `写 bindable 属性 '${shown(pn)}' —— 它的存值器的体在宿主那边，`
          + '而宿主点不着这一层那格 `m_onChanged`（prop_bindable.rst:23-29 要存值器点一下它，'
          + '不然反应器绑上来永远不响）—— 要宿主能点，得先有"把那格单子递过去"那一套');
      }
      return this.nope(n, `写属性 '${shown(pn)}' —— 它的存值器没有定义`
        + '（简单声明式的体写在别处：`p.set(T x) { … }`，prop_simple.rst:29）');
    }
    /* 存值器的重载（第一百八十一刀）：按**右边的类型**挑一条，规矩与第八十刀那套 pickOverload
       逐条一样 —— 问不出右边的类型的明说不收（绝不猜），同分的也明说。挑出第 0 格就是那个
       不带后缀的名字。 */
    let sN = s;
    let want = pi.type;
    if (pi.sets !== undefined && pi.sets.length > 1) {
      const ct = this.cheapTy(valNode);
      if (ct === null) {
        return this.nope(n, `写属性 '${shown(pn)}' —— 它有 ${pi.sets.length} 格存值器，`
          + '而右边的类型这一层还得先降一遍才知道（重载要按类型挑，见 ADR-0016 第八十刀）');
      }
      let best = -1;
      let bestScore = 0;
      let tie = false;
      for (let i = 0; i < pi.sets.length; i++) {
        const sc = this.argCost(ct.ty, pi.sets[i], ct.lit);
        if (sc === 0) continue;
        if (sc === bestScore) tie = true;
        if (sc > bestScore) { bestScore = sc; best = i; tie = false; }
      }
      if (best === -1) {
        return this.err(n, `属性 '${shown(pn)}' 那 ${pi.sets.length} 格存值器`
          + `（${pi.sets.map(tyName).join(' / ')}）没有一格收得下 ${tyName(ct.ty)}`);
      }
      if (tie) {
        return this.nope(n, `属性 '${shown(pn)}' 的那几格存值器在这一句上分不出来`
          + `（${tyName(ct.ty)} 对两格一样合得上）`);
      }
      if (best > 0) {
        sN = `${pn}$set$o${best + 1}`;
        want = pi.sets[best];
      }
    }
    const sf = this.propSelf(n, pn, pi, self);
    if (sf === null) return null;
    const ix = this.propIndexArgs(n, pn, pi, subs);
    if (ix === null) return null;
    let v = this.expr(valNode, want);
    if (v === null) return null;
    if (isInt(v.type) && isInt(want)) v = intConv(v, want);
    if (!sameTy(v.type, want)) {
      return this.err(n, `属性 '${shown(pn)}' 是 ${tyName(want)}，`
        + `这儿给的是 ${tyName(v.type)}`);
    }
    return [`${pad}(expr (call ${sN}${sf}${ix} ${v.code}))`];
  }

  /**
   * 宿主面的取/存（第一百六十刀）。属性体里那格取/存**只有原型、没有体**时，实现在宿主的
   * C/C++ 那边（`opaque class`，opaque.rst:15-29）—— 与方法那一格（ADR-0022 的 J4b）同一条
   * 路：发 `(ccall Owner_get_prop self)` / `(ccall Owner_set_prop self v)`，符号名就是
   * "类名（`$` 换成 `_`）+ `_get_` / `_set_` + 属性名"。
   *
   * 回 `undefined` 表示"这一格不是宿主面的"（调用方接着发它自己那句诊断）；回 null 是报过错了。
   */
  hostProp(n, pn, pi, self, kind, val, subs = []) {
    /* 结构体那一支不看 `opaque`（第一百九十八刀）：那个词只写在类上，而结构体的成员属性
       一个体都没写时，体就在宿主那边（std_Error.jnc:75 那格 `m_description` 就是它）。
       判据写成"不是类"而不是"在 structs 表里"—— 那张表里**也有类**（classLayout 把每个类的
       方言结构体登在里头，量出来的：写成 `structs.has` 会把没写 `opaque` 的类一起放进来，
       `bad/prop-noset` 那道墙当场就倒了）。类那一侧照旧要 `opaque`（第一百六十刀那条口径）。 */
    /* 顶层那一格（第二百二十五刀）：`int property g_simpleProp;` 一个体都没写 ——
       与顶层那格只有原型的函数（第一百八十五刀）是同一句话：**实现在宿主那边**。语料里的出处
       就是 jancy 自己那两份导出样例（jnc_sample_01_export_c/script.jnc:27 与 02_export_cpp
       同处），它们要演示的正是"属性的取/存写在 C / C++ 里"。 */
    /* 没写 `opaque` 的类也算（第二百三十一刀）：`opaque` 说的是"布局不透明"，管的不是"体在哪儿"
       —— 方法那一侧第一百八十三刀就是这么定的，属性这一侧先前还留着第一百六十刀那条更严的口径
       （"类那一侧照旧要 opaque"），那是欠着的，不是划出来的界。语料里拦着的就是这一族：
       `int autoget property m_minValue;` 写在 `class IntProperty: Property { … }` 里
       （test/ioninja/api/ui_PropertyGrid.jnc:52-59，一个体都没写）。
       `bindable` 的照旧不走这条（见 autoProps 那一段注与 propSet 那句话）。 */
    if (pi === undefined) return undefined;
    /* `bindable` 的照旧拦在门外 —— 可只拦**新放进来的**这一种（没写 opaque 的类）。
       `opaque class` 里那一族从第一百六十刀起就走这条路，那笔账（宿主点不着 `m_onChanged`）
       是那一刀留下的，不是这一刀的；把它一并拦住会把 `ui.ComboBox` 那一族已经降得下来的
       4 份文件推回去（量出来的：lowered 162 -> 158）。 */
    if (pi.cls !== null && this.classes.has(pi.cls) && !this.opaques.has(pi.cls)
      && pi.onch !== null && pi.onch !== undefined) return undefined;
    /* 两种写法都算宿主面（第一百六十刀 + 第一百六十二刀）：
         - 完整声明式里那格**只有原型**的取/存（`property m_value { void set(variant_t); }`，
           ui_PropertyGrid.jnc:80）—— `propHostAcc` 上记着；
         - 简单声明式**一个体都没写**（`string_t const property m_name;`，同文件:22）——
           `opaque class` 里那就是"体在宿主那边"，与方法那一格（第六十六刀）一模一样：
           那个类的成员**全都**在宿主的 C/C++ 里（opaque.rst:15-29）。
       这一格进得来说明取/存那个函数确实没有定义（调用方那两处先问的就是 `fns`）。 */
    const ha = this.propHostAcc.get(pn);
    if (ha !== undefined && ha[kind] !== true && (ha.get || ha.set)) {
      /* 体里明写了另一半、这一半没写：那是"这格属性只有取值器 / 只有存值器"，不是宿主面。 */
      return undefined;
    }
    /* 符号名与那三格实参（ADR-0022 的 J4b）：主人那一格在前、`_get_` / `_set_` 夹在中间。
       顶层那一格没有主人，所以既没有 `self` 那个实参、名字也就是"命名空间前缀 + kind + 成员"
       —— `g_simpleProp` -> `get_g_simpleProp`、`doc.g_prop` -> `doc_get_g_prop`
       （与 `Owner_get_name` 是同一条规则，只是主人那一段空着）。 */
    const own = pi.cls === null ? pn.slice(0, Math.max(0, pn.lastIndexOf('$'))) : pi.cls;
    const sym = `${own === '' ? '' : `${own.replace(/\$/g, '_')}_`}${kind}_${pn.slice(pn.lastIndexOf('$') + 1)}`;
    const words = [];
    const parts = [];
    const slots = [];
    if (pi.cls !== null) {
      const sf = this.propSelf(n, pn, pi, self);
      if (sf === null) return null;
      words.push('ptr');
      parts.push(sf.trim());
      slots.push(slotText(tClass(pi.cls)));
    }
    /* 索引属性（第一百七十二刀）：那几格下标摆在 `self` 后头、值前头 —— 与这一层自己发的
       `(call p$get self i…)` / `(call p$set self i… v)` 同一个顺序（第七十刀）。
       下标的类型与含义都由写的人定（prop_indexed.rst:15），所以照旧逐个过 C_ABI 那张表。 */
    if (pi.idx.length > 0) {
      if (subs.length !== pi.idx.length) {
        return this.err(n, `索引属性 '${shown(pn)}' 要 ${pi.idx.length} 个下标，`
          + `这里给了 ${subs.length} 个`);
      }
      for (let i = 0; i < subs.length; i++) {
        const w = this.cabiWordOfJnc(pi.idx[i], false);
        if (w === null) {
          return this.nope(n, `索引属性 '${shown(pn)}' 的第 ${i + 1} 个下标的类型 `
            + `${tyName(pi.idx[i])}（落不进 C_ABI 的那几个词；体在宿主那边）`);
        }
        let iv = this.expr(subs[i], pi.idx[i]);
        if (iv === null) return null;
        if (isInt(iv.type) && isInt(pi.idx[i])) iv = intConv(iv, pi.idx[i]);
        if (!this.assignOk(iv.type, pi.idx[i])) {
          return this.err(subs[i], `索引属性 '${shown(pn)}' 的第 ${i + 1} 个下标要 `
            + `${tyName(pi.idx[i])}，这里是 ${tyName(iv.type)}`);
        }
        words.push(w);
        slots.push(slotText(pi.idx[i]));
        parts.push(iv.code);
      }
    }
    let rw = 'void';
    /* 读出来是一格 `variant_t`（第一百七十四刀）：缓冲区那格摆在最前面、被调的函数回 void ——
       与方法那一处（hostMethodCall）同一条，判据同一段 jancy 的调用约定（见 hostVretFn）。 */
    const vret = kind === 'get' && isVar(pi.type);
    if (kind === 'get') {
      rw = vret ? 'void' : this.cabiWordOfJnc(pi.type, true);
      if (rw === null) {
        return this.nope(n, `读属性 '${shown(pn)}' —— 它的类型 ${tyName(pi.type)} 落不进`
          + ' C_ABI 的那几个词（体在宿主那边）');
      }
    } else {
      const w = isVar(pi.type) ? 'ptr' : this.cabiWordOfJnc(pi.type, false);
      if (w === null) {
        return this.nope(n, `写属性 '${shown(pn)}' —— 它的类型 ${tyName(pi.type)} 落不进`
          + ' C_ABI 的那几个词（体在宿主那边）');
      }
      let v = this.expr(val.node, pi.type);
      if (v === null) return null;
      if (isInt(v.type) && isInt(pi.type)) v = intConv(v, pi.type);
      if (!this.assignOk(v.type, pi.type)) {
        return this.err(n, `属性 '${shown(pn)}' 是 ${tyName(pi.type)}，`
          + `这儿给的是 ${tyName(v.type)}`);
      }
      words.push(w);
      slots.push(isVar(pi.type) ? `(ptr ${VARIANT})` : slotText(pi.type));
      if (isVar(pi.type)) {
        const pv = this.hostVariantArg(val.node, v);
        if (pv === null) return null;
        parts.push(pv);
      } else parts.push(v.code);
    }
    if (!this.cabiNames.has(sym)) {
      const ws = vret ? ['ptr', ...words] : words;
      this.decls.push(`  (cabi ${sym} ${rw} (${ws.join(' ')}))`);
      this.cabiNames.add(sym);
      this.cabiSigs.set(sym, { ret: rw, params: ws, sym });
    }
    if (vret) {
      return { code: `(call ${this.hostVretFn(sym, slots)} ${parts.join(' ')})`, type: pi.type };
    }
    const call = `(ccall ${sym} ${parts.join(' ')})`;
    /* 表达式里的那一句（第一百九十三刀）：整条表达式的值是**存进去的那个值**（第一百一十五刀
       定的那一条），而 ccall 回的是 void —— 所以包一层，与 psetFn 同一个形状。 */
    if (kind === 'set' && val.expr === true) {
      return { code: `(call ${this.hpsetFn(sym, slots)} ${parts.join(' ')})`, type: pi.type };
    }
    return kind === 'get' ? { code: call, type: pi.type } : [`${val.pad}(expr ${call})`];
  }

  /** 上面那一格包装函数，一个宿主面存值器一格。回的是收进来的最后那一格 —— 存进去的值。 */
  hpsetFn(sym, slots) {
    const name = `jnc$hpset$${sym}`;
    if (this.varFns.has(name)) return name;
    const ps = slots.map((s, i) => `(a${i} ${s})`).join(' ');
    const as = slots.map((s, i) => `(var a${i})`).join(' ');
    const last = slots.length - 1;
    this.decls.push(`  (fn ${name} (${ps}) ${slots[last]}\n`
      + `    (expr (ccall ${sym} ${as}))\n`
      + `    (ret (var a${last})))`);
    this.varFns.add(name);
    return name;
  }

  /**
   * 属性的取/存那两个函数的签名（第六十八刀）。
   *
   * 名字这一层自己拼：`p$get` 与 `p$set`。类的成员属性多一格 `this`（与方法同一条，
   * 第五十二刀），于是 `obj.p` 读出来就是一句 `(call C$p$get obj)`。
   *
   * 规矩来自 prop.rst:15-17："Each property has a single getter and optionally one or more
   * setters" —— 取值器只有一个、回属性的类型；一个 setter 都没有的就是 **const 属性**。
   *
   * 存值器的**重载**（第一百八十一刀）：jancy 明写支持（prop_full.rst:15 的 "overloaded
   * setters"，例子里 `set(int x)` 与 `set(double x)` 各一格）。这一层的落法与别处的重载同一套：
   * 名字上加后缀（`p$set` / `p$set$o2` / …，与宿主面那条 `_o2` 是同一个主意），挑哪一条在
   * 写属性那一处按右边的类型排（`propSet` 里那段 argCost，与第八十刀的 pickOverload 同一套机器）。
   * 第一格存值器收的是**属性自己的类型**（那是 prop.rst:16 那句），后面几格收别的类型。
   */
  propSig(n, info, ps) {
    if (info.name === '') return this.err(n, "'get' / 'set' 前面要写属性的名字");
    const pn = this.resolve(info.name, (k) => this.props.has(k));
    if (pn === null) return this.err(n, `没有这个属性：'${shown(info.name)}'`);
    const pi = this.props.get(pn);
    const full = `${pn}$${info.special}`;
    let sym = full;
    let ovl = false;                       // 这一格是第二个及以后的存值器
    if (this.fns.has(full)) {
      if (info.special !== 'set') {
        return this.err(n, `${shown(pn)} 的第二个 'get'（属性只有一个取值器，prop.rst:15）`);
      }
      if (pi.sets === undefined) pi.sets = [pi.type];
      sym = `${pn}$set$o${pi.sets.length + 1}`;
      if (this.fns.has(sym)) return this.err(n, `${shown(pn)} 的这一格 'set' 重复了`);
      ovl = true;
    }
    let ret = J_VOID;
    // 索引属性（第七十刀）：两个函数最前面那几个形参是**下标**，个数与类型照声明里那一串查
    //（prop_indexed.rst:74 那句 "all accessors should have the same index arguments"）。
    const k = pi.idx.length;
    for (let i = 0; i < k && i < ps.length; i++) {
      if (!sameTy(ps[i].type, pi.idx[i])) {
        return this.err(n, `'${shown(pn)}.${info.special}()' 的第 ${i + 1} 个形参是 `
          + `${tyName(ps[i].type)}，而属性声明里那个下标是 ${tyName(pi.idx[i])}`);
      }
    }
    if (info.special === 'get') {
      if (ps.length !== k) {
        return this.err(n, k === 0 ? `'${shown(pn)}.get()' 不带形参`
          : `'${shown(pn)}.get()' 要 ${k} 个形参（就是那 ${k} 个下标）`);
      }
      if (!sameTy(info.type, pi.type)) {
        return this.err(n, `'${shown(pn)}.get()' 回的是 ${tyName(info.type)}，`
          + `而属性 '${shown(pn)}' 是 ${tyName(pi.type)}`);
      }
      ret = pi.type;
      pi.get = true;
    } else {
      // `T const property p` 说的就是"没有存值器"（prop.rst:17）——写一个出来是自相矛盾。
      if (pi.cst) {
        return this.err(n, `'${shown(pn)}' 声明里写了 const，那是**只有取**的属性`
          + '（prop.rst:17），不能有 set');
      }
      if (ps.length !== k + 1) {
        return this.err(n, k === 0 ? `'${shown(pn)}.set()' 要恰好一个形参`
          : `'${shown(pn)}.set()' 要 ${k + 1} 个形参（那 ${k} 个下标，再加要存的值）`);
      }
      if (!sameTy(ps[k].type, pi.type) && !ovl) {
        return this.err(n, `'${shown(pn)}.set()' 收的是 ${tyName(ps[k].type)}，`
          + `而属性 '${shown(pn)}' 是 ${tyName(pi.type)}`);
      }
      /* 重载那几格收别的类型（第一百八十一刀）：记进 pi.sets，写属性那一处按它排。
         与第一格收同一个类型的明说不收 —— 那两条在任何右边上都分不出来。 */
      if (ovl) {
        if (pi.sets.some((t) => sameTy(t, ps[k].type))) {
          return this.err(n, `'${shown(pn)}' 的两格 'set' 都收 ${tyName(ps[k].type)}`);
        }
        pi.sets.push(ps[k].type);
      }
      pi.set = true;
    }
    if (pi.cls !== null) {
      // `this` 那一格的类型由 selfTy 挑（第一百九十八刀：结构体那一格里放的本来就是地址）
      ps.unshift({ name: 'this', type: this.selfTy(pi.cls), formals: null });
      this.methods.set(sym, pi.cls);
    }
    info.name = sym;
    // 属性是一层命名空间（第七十一刀，prop_full.rst:15）：记下"这个函数属于哪格属性"，
    // 体降下来时靠它把 `this.ns` 挪进去 —— autoget 生成的 `m_value` 就那样查得着。
    this.propOf.set(sym, pn);
    this.fns.set(sym, sigOf(ps, ret));
    return { info, ps, isMain: false };
  }

  fnSig0(n) {
    /* 完整声明式的属性（第七十刀记的边界，第七十五刀把常见的那一种接上了）：
     * `property p { … }` 在语法上是一格**带体的 fn-def** —— 说明符位置没有类型、只有
     * `property` 那个词，体里是取/存两个函数与属性自己的字段（prop_full.rst:15：那对花括号
     * 开的是一层命名空间）。
     *
     * 常见的那一种（体里只有带体的 get / set）在 `expandFullProps` 那一遍就已经改写成
     * "简单声明式 + 两个体外的函数"，走不到这儿；能落到这儿的是改写不动的形状（比如名字
     * 后面还挂着东西、或者说明符里带着别的词）。落到下面 specs 那儿报的是"这条声明没有
     * 类型"—— 认错了人，所以这一格照旧留着。
     *
     * 那个词也可能写在星号后面（第七十二刀）：`log.Writer* const property m_logWriter { … }`
     * 是语料里最常见的一种。这一问漏了它就会落到 ptrsTy 那儿报"指针后面的修饰符 'property'"
     * —— 同样是认错了人，真拦路的是那对花括号。 */
    if (this.propMod(n.items[1]) || this.tailMods(n.items[2]).includes('property')) {
      return this.nope(n, '完整声明式的属性（`property p { … }` 那对花括号开的是一层命名空间，'
        + 'prop_full.rst:15）');
    }
    // 特殊成员没有类型说明符（语法给的就是一个空的 `(specs)`，jnc.grammar:213/217）——
    // 构造不回值。所以这一格不问 specs，直接摆一个"void、什么修饰符都没有"的说明符
    // 进去（第五十三刀）。
    const special = specialCore(n.items[2]);
    // 属性的**取值器**有返回类型（`int g_p.get()`，prop_simple.rst:25），所以它照常问 specs；
    // 存值器与构造一样没有说明符（第六十八刀）。
    /* 算符重载（第一百三十刀）也照常问 specs：`size_t errorcode operator := (…)` 是**有**返回
       类型的。这一格漏了的话返回类型被吞成 void，体里的 `return m_v` 于是报成"main 里 return
       一个非 0 的值"—— 认错了人（这是这一刀量出来的一个洞，先前那句话谁看了都会去查 main）。
       **下标算符**（第一百三十八刀）落在同一格上：裸写的 `set` 是 `bool errorcode set(…)`，
       它也有返回类型 —— 只有**属性的**存值器（名字写在前面的 `p.set(T x)`）才是没有说明符的
       那一种。同一条分支上第四次踩这个坑，判据这回按"裸写还是写了名字"分。 */
    const sp = special === null || special === 'get' || isOpSpecial(special)
      || bareAccessor(n.items[2])
      ? this.specs(n.items[1], true)
      : {
        type: J_VOID, thin: false, stat: false, fnptr: false,
        virt: null, errc: false, prop: false, cst: false, agt: false, bnd: false, bdata: false,
        evt: false,
      };
    if (sp === null) return null;
    const info = this.declarator(n.items[2], sp);
    if (info === null) return null;
    if (info.formals === null) return this.err(n, `'${info.name}' 有函数体，但声明符上没有形参表`);
    const ps = this.formalList(info.formals);
    if (ps === null) return null;
    // 回一格类**值** jancy 也拒（`prepareReturnType`，jnc_ct_DeclTypeCalc.cpp:432-441）：
    // 回的得是类指针。这一层两者同型，所以差别只在源码里写没写那个 `*`（第五十二刀）。
    if (isClass(info.type) && info.type.own === true) {
      return this.err(n, `'${info.name}' 回的是类（jancy 那句 "function cannot return `
        + `'${tyName(info.type)}'"）—— 写成 '${shown(info.type.name)}*'`);
    }
    // 返回数组是合法的（prepareReturnType 只拒 class / function / property 与长度省掉的
    // 那种，DeclTypeCalc.cpp:425）。写法是 `int f() [3]` —— 方括号在形参表**后面**。
    if (isArr(info.type) && info.type.n === null) {
      return this.err(n, `'${info.name}' 回的数组长度省不掉（jancy 那句 "function cannot return `
        + `auto-size-array '${tyName(info.type)}'"）`);
    }
    // 构造（第五十三刀）。名字在这一层自己拼：实例构造是 `C$construct`，静态构造是
    // `C$construct$static` —— 与方法同一条路（体内写的 ns 已经是那个类，体外写的
    // `C.construct()` 名字里本来就带着 `C.`），所以两种放法到这儿又是同一格。
    if (info.special !== null) {
      /* 体外写的方法名**叫 `get` / `set`**（第一百三十六刀）：`int C0.get() { … }`。
         语法上它与属性的取值器一模一样（`(qualified-special (name C0) (accessor get))`），
         所以先前一律当属性办 —— 左边那个 `C0` 拿去 `this.props` 里查，查不着就报
         "没有这个属性：'C0'"。那句话指着别处：`C0` 是个**类名**，写错的不是它。
         判据一句：左边那个名字解得出一格属性吗？解不出、而解得出一格类 / 结构体，
         这就是一格普通方法 —— 名字接回去（`C0.get`），special 清掉，走下面那条常路。
         （语料里的原样是 `Value MapImpl<T>.get(Key key) const`，stdt_Map.jnc:135。） */
      if ((info.special === 'get' || info.special === 'set')
        && this.resolve(info.name, (k) => this.props.has(k)) === null
        && this.resolve(info.name, (k) => this.classes.has(k) || this.structs.has(k)) !== null) {
        info.name = `${info.name}.${info.special}`;
        info.special = null;
      }
    }
    if (info.special !== null) {
      /* 裸写的 `get` / `set`（第一百三十八刀）：那是**下标算符**，不是属性 —— 名字没写在前面
         （`info.name === ''`）就是它。排在 propSig 之前，那儿第一句问的是"名字前面写了吗"。 */
      if ((info.special === 'get' || info.special === 'set') && info.name === '') {
        return this.opIndexSig(n, info, ps);
      }
      if (info.special === 'get' || info.special === 'set') return this.propSig(n, info, ps);
      // 赋值算符（第一百三十刀）：自己一处，落法与方法同一条
      if (info.special === 'operator :=') return this.opAssignSig(n, info, ps);
      /* 复合赋值那一族（第一百五十二刀）：`operator += (string_t)`。判据与上面那一条同一份，
         只是名字与表里的键带上是哪一个算符。 */
      if (info.special.startsWith('operator ')
        && COMPOUND_OPS.has(info.special.slice('operator '.length))) {
        return this.opCompoundSig(n, info, ps, info.special.slice('operator '.length));
      }
      // 相等算符（第一百四十刀）：一个形参、回 bool，调用点在二元比较那一处
      if (info.special === 'operator ==' || info.special === 'operator !=') {
        return this.opCmpSig(n, info, ps);
      }
      // 调用算符（第二百〇二刀）：`obj(…)` 走它，形参个数由写的人定
      if (info.special === 'operator ()') return this.opCallSig(n, info, ps);
      // 自增自减那四个（第一百三十一刀）：与赋值算符同一条路，只是不收形参
      if (isOpSpecial(info.special)) return this.opIncSig(n, info, ps);
      /* 构造的主人（第五十三刀是类；第一百二十九刀把**结构体**也算上）：先按类查，查不着再按
         结构体查 —— 两边的落法只差 `this` 那一格的类型（类是一条引用 tClass，结构体那一格里
         放的本来就是地址，所以直接用那个结构体类型，与第一百〇一刀的方法一模一样）。 */
      const owner = info.name === ''
        ? (this.structs.has(this.ns) ? this.ns : null)
        : this.resolve(info.name, (k) => this.structs.has(k));
      const ownStruct = owner !== null && !this.classes.has(owner);
      if (owner === null) {
        return this.err(n, `'${info.special}' 只能是类或结构体的成员（写在体里，或写成 `
          + `'${info.name === '' ? 'C' : shown(info.name)}.construct()'）`);
      }
      const stat = info.special === 'static construct';
      if (stat && ownStruct) {
        return this.nope(n, `结构体里的 'static construct'（那一格要一道 once 闸门，是另一笔账）`);
      }
      const full = stat ? `${owner}$construct$static` : `${owner}$construct`;
      /* 构造的**重载**（第一百五十五刀）：jancy 收形参不同的好几个 `construct`
         （type_class.rst:63 那句 "Constructors can be overloaded, the rest of construction
         methods must have no arguments"）。这一层走方法那条现成的路 —— 第七十九刀的
         `overloadName` 把第二条起改名成 `…$o1`，调用点（ctorArgs）照第八十刀的 `pickOverload`
         按实参挑。`static construct` 不进这一族：它不带形参，一个类上只有一格。 */
      let dname = full;
      if (this.fns.has(full)) {
        if (stat) {
          return this.err(n, `${shown(owner)} 的第二个 'static construct'（它不带形参，`
            + '一个类上只有一格）');
        }
        const alt = this.overloadName(n, full, ps, info.sp);
        if (alt === null) return null;
        dname = alt;
      }
      info.name = dname;
      if (stat) {
        // 静态构造不带 `this`，也**不带形参**：jancy 那句话把两件事一起说了（同一处 type_class.rst:63）。
        // 它是**类那一格上**的一次性初始化，不属于哪个对象。
        if (ps.length > 0) return this.err(n, "'static construct' 不带形参");
        this.sctors.set(owner, full);
      } else {
        ps.unshift({
          name: 'this',
          type: ownStruct ? { k: 'struct', name: owner } : tClass(owner, false),
          formals: null,
          def: null,
        });
        this.methods.set(dname, owner);
        /* `ctors` 里记的一直是**这一族的基名**（`C$construct`）：调用点先看 `overloads` 有没有
           这个基名，有就按实参挑一条，所以第二条起不改这一格。 */
        if (dname === full) {
          this.ctors.set(owner, {
            name: full,
            params: ps.slice(1).map((p) => p.type),
            defs: sigOf(ps.slice(1), J_VOID).defs,
          });
        }
      }
      this.fns.set(dname, sigOf(ps, J_VOID));
      return { info, ps, isMain: false };
    }
    // `int main()` 是入口：降成方言的 `(main …)`。jancy 的 main 回 int，而方言的入口
    // 不回值 —— 那个返回值是给外面的退出码，这一层没有它，所以 `return 0` 就是 `(ret)`。
    // 命名空间里的 `main` **不是**入口（jancy 的入口是全局那一个），所以先看 ns（第五十一刀）。
    const isMain = this.ns === '' && info.name === 'main' && ps.length === 0;
    if (isMain) {
      if (this.mainSeen) return this.err(n, '`int main()` 定义了两次');
      this.mainSeen = true;
      // `int errorcode main()`：入口没有"上一层"可传，而这一层的 main 连退出码都不回
      //（那条边界记在 bad/main-nonzero）—— 悄悄丢掉那个词就是骗人。
      // 读 `info.sp`（第一百三十三刀）：那个词也可能写在星号后面，`declarator` 才知道。
      if (info.sp.errc) return this.nope(n, '`errorcode` 写在 `main` 上（错传不到调用方去）');
    } else {
      // 名字带上命名空间前缀，而那个带前缀的名字**同时**就是方言里那个函数的名字。
      info.name = this.qual(info.name);
      /* 重载（第七十九刀）之后 `info.name` 可能被改名，而 owner 与"源码里那个方法名"
         要从**没改名的**那个算 —— `C$open$o1` 上按最后一个 `$` 切出来的 owner 是
         `C$open`，那是错的。所以基名单独留一格。 */
      const base = info.name;
      // 原型上写了 `abstract`、体又写在类外（第五十七刀）：报的得是"abstract 不能有体"，
      // 而不是下面那句"定义了两次"—— 原型那一遍已经把签名放进 fns 了。
      if (this.virt.get(base) === 'abstract') {
        return this.err(n, `'${shown(base)}' 是 abstract，不能有函数体（jancy 那句 `
          + '"\'%s\' is abstract and hence cannot have a body"）');
      }
      if (this.fns.has(base)) {
        const alt = this.overloadName(n, base, ps, sp);
        if (alt === null) return null;
        info.name = alt;
      }
      // 方法（第五十二刀）：名字的前一格是个**类**时这就是它的方法 —— 体内写的那些在 nsFlat
      // 那一遍已经把 ns 设成了类名，体外写的 `void C.foo()` 名字里本来就带着 `C.`，两条路
      // 到这儿是同一个全名（`C$foo`）。落法是一个**自由函数**，`this` 当第一个形参。
      const cut = base.lastIndexOf('$');
      const owner = cut < 0 ? null : base.slice(0, cut);
      /* 结构体的方法（第一百〇一刀）：落法与类的一模一样 —— 一个自由函数、`this` 当第一个
         形参。差别只在 `this` 那一格的类型：类是一条引用（tClass），结构体那一格里放的
         **本来就是地址**（第十二刀），所以直接用那个结构体类型。 */
      if (owner !== null && !this.classes.has(owner) && this.structs.has(owner)) {
        this.methodNames.add(base.slice(cut + 1));
        /* `static` 的那一格没有 `this`（第二百〇一刀）：jancy 的 `DerivableType::addMethod`
           在 `StorageKind_Static` 那一支直接 break、**不走** `convertToMemberMethod`
           （jnc_ct_DerivableType.cpp:169-185），所以它就是"名字挂在这个类型上的一个自由函数"。
           先前这一层把那个词悄悄丢了：签名照旧多一格 `this`，于是 `S.f(…)` 报的是"要一个
           对象来调它"—— 指着别处（那一句在**静态**方法上不成立）。 */
        if (!sp.stat) {
          this.methods.set(info.name, owner);
          ps.unshift({ name: 'this', type: { k: 'struct', name: owner }, formals: null });
        }
        if (sp.virt !== null) {
          this.nope(n, `结构体的方法 '${shown(base)}' 上写 '${sp.virt}'（虚派发要对象头那一格`
            + '类型标签，结构体没有）');
        }
        this.fns.set(info.name, sigOf(ps, info.type));
        /* `errorcode` 也要在这一支记（第一百九十六刀）：这一支先前直接 return 了，下面那句
           errcReg 够不着 —— 那个词于是被**悄悄吞掉**，调用点一句检查都不插（量出来的：
           `long errorcode Guid.parse(…)` 出错时上一层照旧往下走）。 */
        if (info.sp.errc && this.errcReg(n, info.name, info.type) === null) return null;
        return { info, ps, isMain: false };
      }
      if (owner !== null && this.classes.has(owner)) {
        this.methodNames.add(base.slice(cut + 1));
        // `static` 的那一格没有 `this`（第二百〇一刀，与结构体那一支同一条）
        if (!sp.stat) {
          this.methods.set(info.name, owner);
          ps.unshift({ name: 'this', type: tClass(owner, false), formals: null });
        }
        // 虚方法（第五十七刀）。`abstract` 的那一个**没有体** —— jancy 自己那句话就是
        // "'%s' is abstract and hence cannot have a body"（jnc_ct_ModuleItem.h:690）。
        if (sp.virt !== null) {
          if (sp.virt === 'abstract') {
            return this.err(n, `'${shown(info.name)}' 是 abstract，不能有函数体（jancy 那句 `
              + '"\'%s\' is abstract and hence cannot have a body"）');
          }
          this.virt.set(info.name, sp.virt);
        }
      } else if (sp.virt !== null) {
        return this.err(n, `'${sp.virt}' 只能写在类的方法上（type_class.rst:178）`);
      }
      this.fns.set(info.name, sigOf(ps, info.type));
      // errorcode（第五十八刀）：出错值由返回类型定，见 errcReg。读的是 `info.sp` ——
      // 那个词写在星号后面时只有 declarator 那一遍认得它（第一百三十三刀）。
      if (info.sp.errc && this.errcReg(n, info.name, info.type) === null) return null;
    }
    return { info, ps, isMain };
  }

  /**
   * 同一个名字的第二条定义（第七十九刀）：是重载就换个方言名字，不是就报"定义了两次"。
   *
   * jancy 判合法只看**实参那一串的签名**（`getArgSignature`，jnc_ct_FunctionType.h:289-326）——
   * 返回类型不算、`errorcode` / `unsafe` / `async` 也不算，所以只差这些的两条它自己就拒
   * （`illegal function overload: duplicate argument signature`，
   * jnc_ct_FunctionTypeOverload.cpp:248-261）。
   *
   * 这一层先只做**按实参个数**分得开的那一半（语料 159 组里 92 组）：元数不同就收，
   * 同元的当场说还不收 —— 同元要按参数类型排序（jancy 那是一个标量：各实参 CastKind 里
   * 最差的那个，jnc_ct_OperatorMgr.cpp:721-759），而那要先有一张这一层的隐式转换代价表。
   *
   * 虚方法上的重载也不收：第五十七刀的虚派发是"整数标签 + 按标签分派"，分派表按**方法名**
   * 接，同名两条会撞。
   *
   * @returns 新的方言名，或 null（已经报过错）
   */
  overloadName(n, base, ps, sp) {
    const cands = this.overloads.get(base) ?? [base];
    if (this.virt.has(base) || (sp !== undefined && sp !== null && sp.virt !== null)) {
      return this.nope(n, `虚方法 '${shown(base)}' 的重载（这一层的虚派发按方法名接，`
        + '同名两条会撞在一格分派表上）');
    }
    const mine = ps.map((p) => p.type);
    for (const c of cands) {
      const s = this.fns.get(c);
      if (s === undefined) continue;
      // 方法的 params 里第 0 格是 this —— 那一格两边一样，比的是后面那一串
      const theirs = this.methods.has(c) ? s.params.slice(1) : s.params;
      if (this.sameArgs(mine, theirs)) {
        return this.err(n, `函数 '${shown(base)}' 定义了两次`);
      }
    }
    this.overloads.set(base, [...cands, `${base}$o${cands.length}`]);
    return `${base}$o${cands.length}`;
  }

  /**
   * 实参那一串的类型完全一样吗（第八十刀）。jancy 判"这是重载还是重定义"就问这一句
   * （`getArgSignature`，jnc_ct_FunctionType.h:289-326）—— 返回类型与 `errorcode` 都不算。
   */
  sameArgs(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameTy(a[i], b[i])) return false;
    return true;
  }

  /**
   * 一格实参的类型**不降就问得出来**吗（第八十刀）。
   *
   * 同元的重载要按参数类型挑，而挑之前就得知道实参是什么类型 —— 可这一层的 `expr` 是
   * **按 want 定向**的（`null` 要 want 才知道是哪种指针、花括号要 want、整数字面量的宽度
   * 也看 want），而且降的时候会发码（传播的提升、提临时量）。所以不能"先降一遍拿类型、
   * 再按选中的那一条降第二遍"。
   *
   * 这一格因此只回**不降也知道**的那几种：字面量、`true`/`false`、以及查得着的名字
   * （局部量 / 形参 / 模块级 / 方法体里裸写的字段 —— 那三个查名都是纯查表，不发一个字）。
   * 别的回 null，调用点那儿就说"还不收"，绝不猜。
   *
   * 整数**字面量**单独标一格 `lit`：jancy 对常量的 int -> int 加宽算 `Identity`
   * （jnc_ct_CastOp_Int.h:23-111），于是 `p(int)` / `p(long)` 喂 `1` 在它那儿是
   * **ambiguous**。所以这一层对字面量一律不给"完全一样"那一档 —— 两条同分、当场拒，
   * 与 jancy 一样不给答案。
   *
   * @returns `{ ty, lit }` 或 null（问不出来）
   */
  cheapTy(n) {
    if (isStr(n)) return { ty: J_STR, lit: true };
    if (isAtom(n)) {
      const s = n.value;
      if (/^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|0[0-7]+|[0-9]+)$/.test(s)) {
        return { ty: J_I32, lit: true };          // 宽度不管：字面量那一档下面一律算 int -> int
      }
      if (/^[0-9]+(\.[0-9]*([eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)$/.test(s)) {
        return { ty: J_REAL, lit: true };
      }
      return null;
    }
    if (!isList(n)) return null;
    const h = head(n);
    if (h === 'true' || h === 'false') return { ty: J_BOOL, lit: true };
    if (h === 'name' && isAtom(n.items[1])) {
      const nm = n.items[1].value;
      const r = this.lookupRef(nm);
      if (r !== null) return { ty: r.type, lit: false };
      const f = this.selfField(nm);
      if (f !== null) return { ty: f.type, lit: false };
      return null;
    }
    /* 下面这五格是第一百四十四刀添的。守的仍旧是这一格原来那两条：**一个字都不发**
       （不碰 expr / specs / err / nope，只查表），而且**只在问得准时才回**，别的照旧回 null。
       挑这五种是量出来的 —— 语料里那一行拦着的实参全是它们：
         `new ui.Icon(iconFileName)`（doc_Plugin.jnc:68）、`new Label(label)`（ui_Layout.jnc:107）
         `text.m_p` / `text.m_length`（log_Writer.jnc:75）
         `std.getLastError()` / `sys.getPreciseTimestamp()`（同上:101、105）
         `StdRecordCode.SyncId`（同上:136）、`&syncId`（同上，第 2 个）。 */
    if (h === 'field') {
      const et = this.cheapEnumMem(n);
      if (et !== null) return { ty: et, lit: false };
      const ft = this.cheapField(n.items[1], n.items[2]);
      return ft === null ? null : { ty: ft, lit: false };
    }
    if (h === 'ptr-field') {
      const ft = this.cheapField(n.items[1], n.items[2]);
      return ft === null ? null : { ty: ft, lit: false };
    }
    // `&x`：取地址不改"那一格是什么类型"这件事 —— 与 addrOf 的三个出口一样都是 `T*`。
    if (h === 'addr') {
      const b = this.cheapTy(n.items[1]);
      return b === null || b.lit ? null : { ty: tPtr(b.ty), lit: false };
    }
    if (h === 'new') return this.cheapNew(n);
    if (h === 'call') return this.cheapCall(n);
    /* 下面这三格是第二百刀添的。守的仍旧是原来那两条：**一个字都不发**、只在问得准时才回。
       挑这三种也是量出来的 —— 榜上"同元重载 / 同元原型：第 N 个实参的类型这一层还得先降一遍
       才知道"那一族（第一百九十九刀之后 134 + 115 + 86 + 85 处）拦着的实参就是它们：
         `indent.append(' ', 4)`（HidUtils.jnc:19）—— 字符字面量
         `insert(-1, string)`（std_String.jnc:96）—— 一元的负号
         `std.setError($"attempt to access out-of-bounds offset $offset")`（同上:162）—— 格式化字面量 */
    // 字符字面量：charLit 落成的是一格**整数**字面量（那几个字节拼成的数），所以与 `65` 同一档。
    if (h === 'char') return { ty: J_I32, lit: true };
    /* 格式化字面量：`$"…"` 产出的是一格**动态**的字符串（literals.rst:62）—— 类型是 string，
       而**不算字面量那一档**（那一格只对整数之间那条有意思，见 argCost）。`concat` 是
       "字面量后面紧跟一个 `$"…"`"那种拼接，同一件事。 */
    if (h === 'fmt' || h === 'concat') return { ty: J_STR, lit: false };
    /* 一元的那四个：`-` / `+` / `~` 不改类型（整数还是整数、实数还是实数），`!` 回 bool。
       别的（`*` 解引用、`&` 取地址、`++` 那一族）各有自己的形状，照旧回 null。 */
    if (h === 'unary' && isStr(n.items[1])) {
      const op = n.items[1].value;
      if (op === '!') return { ty: J_BOOL, lit: false };
      if (op !== '-' && op !== '+' && op !== '~') return null;
      const b = this.cheapTy(n.items[2]);
      if (b === null || !(isInt(b.ty) || b.ty === J_REAL)) return null;
      if (op === '~' && b.ty === J_REAL) return null;      // `~` 只对整数有意思
      return { ty: b.ty, lit: b.lit };
    }
    return null;
  }

  /** 这个名字是一格**类型**吗（第二百三十三刀）。回 `'string'` / `'其它'` / null。
   *  只查表、一个字都不发 —— 与 `cheapTy` 那一族同一条规矩。挑的这几种就是 specs 里
   *  认类型名的那几支（见 specTy）：整数别名、`size_t`、`string_t`、`variant_t`、
   *  类 / 结构体 / 枚举 / typedef。 */
  callTypeName(nm) {
    if (nm === 'string_t') return 'string';
    if (INT_ALIASES.has(nm) || nm === 'size_t' || nm === 'variant_t') return '其它';
    if (this.resolve(nm, (k) => this.classes.has(k)) !== null) return '其它';
    if (this.resolve(nm, (k) => this.structs.has(k)) !== null) return '其它';
    if (this.resolve(nm, (k) => this.enums.has(k)) !== null) return '其它';
    return null;
  }

  /**
   * `cheapTy` 回 null 的那个实参**是哪一种**（第二百三十七刀）。**一个字都不发**、只看语法树 ——
   * 用处是把"这一层还得先降一遍才知道"那句笼统话换成指名的那一句：量出来（第二百二十八刀那一遍
   * 全语料的统计）拦着"同元重载：第 N 个实参"那一族的就是两种，而两种都是**已经记着的方言级
   * 的账**，不是这一层欠的：
   *   `sizeof(params)` / `countof(a)` 那一族 —— 268 + 6 + 4 处（sizeof 那笔：方言一格 8 字节）
   *   `text.m_p` / `text.m_length` —— 168 处（string_t 的字节段那笔）
   * 回 `'sizeof'` / `'strbytes'` / null（null 就照旧说那句笼统的）。
   */
  cheapWhy(e) {
    if (!isList(e)) return null;
    const h = head(e);
    if (h === 'sizeof' || h === 'countof' || h === 'offsetof'
      || h === 'dynamic-sizeof' || h === 'dynamic-countof' || h === 'dynamic-offsetof') {
      return 'sizeof';
    }
    if (h === 'field' || h === 'ptr-field') {
      const b = this.cheapTy(e.items[1]);
      if (b !== null && !b.lit && b.ty === J_STR) return 'strbytes';
      return null;
    }
    // 算式与取地址里头也算（`&params` / `p + sizeof(hdr)`）：谁先答上算谁
    if (h === 'addr' || h === 'unary') return this.cheapWhy(e.items[e.items.length - 1]);
    if (h === 'binary') {
      for (let i = 2; i < e.items.length; i++) {
        const w = this.cheapWhy(e.items[i]);
        if (w !== null) return w;
      }
    }
    return null;
  }

  /** 上面那一问答出来之后该说的那半句（第二百三十七刀）。 */
  cheapWhyText(w) {
    return w === 'sizeof'
      ? '是 `sizeof` / `countof` 那一族 —— 要方言的布局先认整数宽度'
        + '（jancy 的 int 是 4 字节，方言这边一格 8 字节），与榜上 `sizeof` 那一行同一笔账'
      : '读的是 `string_t` 的字节段（`m_p` / `m_length`）—— 那是一格指到字节上的 '
        + '`char const*`，而这一层的 `char*` 指的是方言的整数格，与榜上 `m_p` 那一行同一笔账';
  }

  /** `E.M` 里那格枚举类型 —— enumMember 的**纯查表**那一半（第一百四十四刀）。
   *  差别只在"查不着就回 null"：那儿要报错，这儿一个字都不许发。 */
  cheapEnumMem(n) {
    const ob = n.items[1];
    if (!isList(ob) || (head(ob) !== 'name' && head(ob) !== 'field')) return null;
    const en0 = this.dotted(ob);
    if (en0 === null || this.lookupRef(en0) !== null) return null;
    const en = this.resolve(en0, (k) => this.enums.has(k));
    if (en === null) return null;
    const info = this.enums.get(en);
    const mn = isAtom(n.items[2]) ? n.items[2].value : null;
    if (mn === null || !info.members.has(mn)) return null;
    return { k: 'enum', name: en, base: info.base, bits: info.bits === true };
  }

  /** `x.f` / `p->f` 里那格字段的类型（第一百四十四刀）：memberOf 的纯查表那一半。
   *  属性与方法名一律回 null —— 那两种右边的名字**不是**字段，`autoget` 的属性还有一格同名的
   *  底层字段，拿它的类型当答案就是接错人（读它其实是一次调用，类型是取值器的返回类型）。 */
  cheapField(obNode, memNode) {
    const nm = isAtom(memNode) ? memNode.value : null;
    if (nm === null || this.propNames.has(nm) || this.methodNames.has(nm)) return null;
    const b = this.cheapTy(obNode);
    if (b === null || b.lit) return null;
    const t = jncIsPtr(b.ty) ? b.ty.target : b.ty;
    if (!jncIsStruct(t) && !isClass(t)) return null;
    const fs = this.structs.get(t.name);
    const f = fs === undefined ? undefined : fs.find((x) => x.name === nm);
    // 位域与 bigendian 的字段在这张表里查不着（各走自己那条路），于是自然回 null。
    return f === undefined || f.type === undefined ? null : f.type;
  }

  /** `new C(…)` 那一格的类型（第一百四十四刀）：**只**收"一个名字、没有指针后缀、没有修饰符"
   *  这一种写法 —— 那时类型就写在那儿，一次 resolve 就问得准。别的（`new T*`、`new int[n]`、
   *  带 `thin` 之类的修饰符）回 null：那些要走 specs，而 specs 会报诊断。 */
  cheapNew(n) {
    const tn = n.items[1];
    if (!isList(tn) || head(tn) !== 'type-name') return null;
    if (this.flat(tn.items[2]).length > 0) return null;         // 有指针后缀
    const sp = tn.items[1];
    if (!isList(sp) || head(sp) !== 'specs') return null;
    if (this.flat(sp.items[2]).length > 0 || this.flat(sp.items[3]).length > 0) return null;
    const nm = this.qname(sp.items[1]);
    if (nm === null) return null;
    const cn = this.resolve(nm, (k) => this.classes.has(k));
    // 类那一支：`new C` 给的就是 `C*`，也就是这一层的类类型自己（第五十二刀，见 newPtr）。
    if (cn !== null) return { ty: tClass(cn, false), lit: false };
    const sn = this.resolve(nm, (k) => this.structs.has(k));
    return sn === null ? null : { ty: tPtr({ k: 'struct', name: sn }), lit: false };
  }

  /** `f(…)` 那一格的类型（第一百四十四刀）：按名字查得着、而且**自己不是一族重载**时就是它的
   *  返回类型。是重载的回 null —— 那要先挑一条，而挑它又要问实参的类型，绕回来了。
   *
   *  第二百二十八刀添了"只有原型的顶层函数"那一支。守的仍旧是这一格原来那两条（**一个字都不发**、
   *  只在问得准时才回）：返回类型就写在那条声明上，`hostTopSigs` 那张表（第一百八十五 /
   *  一百九十四刀）现成就有，问它与问 `fns` 一样只是查表。**有没有带体的定义与返回类型是什么
   *  是两件事** —— jancy 挑重载看的是函数**类型**（jnc_ct_FunctionTypeOverload.cpp:44-91 通篇
   *  只碰 `FunctionType`），体在哪儿根本不进这一步。语料里拦着榜上那一行的就是它们两个：
   *    `std.getLastError()`（std_Error.jnc:90 `Error const* getLastError();`，量到 172 处）
   *    `sys.getPreciseTimestamp()`（sys_globals.jnc:141 `uint64_t getPreciseTimestamp();`，84 处）
   *  同名好几条原型（`std.setError` 那种，第一百九十四刀）照旧回 null：那要先按实参挑一条，
   *  而挑它又要问实参的类型 —— 与上面那条重载的路一样绕回来了。 */
  cheapCall(n) {
    const cal = n.items[1];
    if (!isList(cal) || (head(cal) !== 'name' && head(cal) !== 'field')) return null;
    const nm0 = this.dotted(cal);
    if (nm0 === null || this.lookupRef(nm0) !== null) return null;
    const fn = this.resolve(nm0, (k) => this.fns.has(k));
    if (fn === null) {
      const pf = this.resolve(nm0, (k) => this.protoFns.has(k));
      if (pf === null) return null;
      const ts = this.hostTopSigs.get(pf);
      if (ts === undefined || ts.length !== 1) return null;
      const rt = ts[0].ret;
      if (rt === undefined || rt === null || rt === J_VOID) return null;
      return { ty: rt, lit: false };
    }
    if (this.overloads.has(fn)) return null;
    const s = this.fns.get(fn);
    if (s === undefined || s.ret === undefined || s.ret === null || s.ret === J_VOID) return null;
    return { ty: s.ret, lit: false };
  }

  /**
   * 一格实参配一格形参有多合得上（第八十刀）。档次照 jancy 的 `CastKind`
   * （jnc_ct_CastOp.h:26-35）**相对次序**排，只是粗一些 —— 这一层可行的隐式转换本来就少
   * （量过：`double d = 1;` 收，`int i = 2.5;` 拒）：
   *
   *   4 完全一样（Identity）
   *   3 int 之间（两个方向 jancy 都是 Implicit）、类的上转
   *   1 int -> real（ImplicitCrossFamily，严格差于 Implicit）、bool -> int、枚举 -> int
   *   0 合不上
   *
   * 字面量不给 4（见 cheapTy 那段）。次序与 jancy 一致这一点是关键：我们**给出答案时**
   * 与 jancy 挑的是同一条；分不出来时说还不收，而不是猜。
   */
  argCost(from, to, lit) {
    if (isInt(from) && isInt(to)) return lit ? 3 : (sameTy(from, to) ? 4 : 3);
    if (sameTy(from, to)) return 4;
    if (isClass(from) && isClass(to) && this.isBase(to.name, from.name)) return 3;
    if (to === J_REAL && isInt(from)) return 1;
    if (isInt(to) && from === J_BOOL) return 1;
    if (isInt(to) && jncIsEnum(from)) return 1;
    return 0;
  }

  /**
   * 调用点在一族重载里挑一条（第七十九刀 + 第八十刀）。两步：
   *
   *   1. 按**给了几个实参**筛。每个候选可接受的个数是一个区间
   *      `元数 − 末尾带默认值的个数` .. `元数`（第七十七刀那格 `defs` 现成的）。
   *   2. 剩下不止一条时按**参数类型**排（`argCost` / `cheapTy`）：每个候选取各实参里**最差**
   *      的那一档，取最高分 —— 与 jancy 的 `chooseOverload` 同一个算法
   *      （jnc_ct_FunctionTypeOverload.cpp:44-91）。平手或者哪个实参的类型问不出来，
   *      当场说还不收，不猜。
   *
   * @returns 挑中的方言名，或 null（已经报过错）
   */
  pickOverload(n, base, argNodes, hasSelf, hostOk = false) {
    const cands = this.overloads.get(base);
    if (cands === undefined) return base;
    const given = argNodes.length;
    const shape = (c) => {
      const s = this.fns.get(c);
      const want = hasSelf ? s.params.slice(1) : s.params;
      const defs = s.defs === undefined || s.defs === null ? null
        : (hasSelf ? s.defs.slice(1) : s.defs);
      return { want, opt: defs === null ? 0 : defs.filter((d) => d !== null).length };
    };
    const fits = cands.filter((c) => {
      if (this.fns.get(c) === undefined) return false;
      const { want, opt } = shape(c);
      return given >= want.length - opt && given <= want.length;
    });
    if (fits.length === 1) return fits[0];
    if (fits.length === 0) {
      // 那个类里同名的还有只有原型的几条（第一百五十刀）：数出来的个数本来就不全，别说成"对不上"
      if (hostOk && this.hostSibling(base)) return HOST_PICK;
      if (this.protoSibling(base)) return this.protoSiblingNope(n, base, given);
      const counts = cands.map((c) => shape(c).want.length);
      return this.err(n, `'${shown(base)}' 有 ${cands.length} 条重载，收的实参个数是 `
        + `${counts.join(' / ')}，这里给了 ${given} 个`);
    }
    // 按类型排。先把这几个实参的类型问出来 —— 有一个问不出来就整条不猜。
    const tys = argNodes.map((a) => this.cheapTy(a));
    if (tys.some((t) => t === null)) {
      const bi = tys.findIndex((t) => t === null);
      /* 那个实参**是哪一种**（第二百三十七刀）：量出来拦着这一族的两种都是已经记着的方言级的账，
         说得准就别说那句笼统的。 */
      const why = this.cheapWhy(argNodes[bi]);
      if (why !== null) {
        return this.nope(n, `'${shown(base)}' 的同元重载要按参数类型挑（见 ADR-0016 第八十刀），`
          + `而第 ${bi + 1} 个实参${this.cheapWhyText(why)}`);
      }
      return this.nope(n, `'${shown(base)}' 的同元重载：第 `
        + `${bi + 1} 个实参的类型这一层还得先降一遍才知道`
        + '（同元重载要按参数类型挑，见 ADR-0016 第八十刀）');
    }
    let best = -1;
    let bestScore = 0;
    let tie = false;
    for (const c of fits) {
      const { want } = shape(c);
      let score = 5;
      for (let i = 0; i < tys.length; i++) {
        const one = this.argCost(tys[i].ty, want[i], tys[i].lit);
        if (one < score) score = one;
      }
      if (score === 0) continue;                       // 这一条根本合不上
      if (score === bestScore) tie = true;
      if (score > bestScore) { bestScore = score; best = c; tie = false; }
    }
    if (best === -1) {
      // 同上（第一百五十刀）：合得上的那一条可能就在没进候选的那几条原型里
      if (hostOk && this.hostSibling(base)) return HOST_PICK;
      if (this.protoSibling(base)) return this.protoSiblingNope(n, base, given);
      return this.err(n, `'${shown(base)}' 的 ${fits.length} 条重载没有一条收得下这几个实参`
        + `（${tys.map((t) => tyName(t.ty)).join(', ')}）`);
    }
    if (tie) {
      return this.nope(n, `'${shown(base)}' 的同元重载在这一句上分不出来`
        + `（${tys.map((t) => tyName(t.ty)).join(', ')} 对两条一样合得上 —— jancy 那边这也是`
        + ' "ambiguous call to overloaded function"）');
    }
    return best;
  }

  /** 那道闸门那几行（第五十三刀）：`if (!跑过) { 跑过 = true; 静态构造(); }`。
   *  与第二十六刀 `static` 局部量的初值用的是同一个形状（那边的出处是 jancy 的 `once`）。 */
  gateLines(cls, pad) {    const gate = this.gates.get(cls);
    return [
      `${pad}(if (un "!" (var ${gate}))`,
      `${pad}  (do`,
      `${pad}    (set ${gate} (bool true))`,
      `${pad}    (expr (call ${this.sctors.get(cls)}))))`,
    ];
  }

  /**
   * 构造实参那一串（第五十三刀）：`C1 a(100)` / `new C1(100)` / `C1 a construct(100)`
   * 三处共用。检查与普通调用同一条规矩（个数、整数隐式转、类型对得上）。
   */
  /**
   * 那个类的 `construct` **只有原型**（第一百四十八刀）。
   *
   * 语料里的原样：`class GroupProperty: Property { construct(string_t name); }`
   * （ui_PropertyGrid.jnc:37-39）。先前这一层报的是"`ui.GroupProperty` 的 construct 要 0 个
   * 实参，这里给了 1 个"（那个 0 是**这一层自己合出来的**那格无参构造）或者"没有 construct" ——
   * 两句都是认错人：construct 在，只是体不在这儿。
   *
   * 与 `opaque class` 那一支（第六十六刀）同一句话、不同的口径：那边用户明写了"实现在宿主
   * 那边"，这边没写，所以这一层不替它认下来。要紧的是**不能装作"没有构造"就把对象交出去**
   * —— 那是悄悄少跑一段。
   */
  protoCtorNope(node, cls) {
    // 第二处**不写类名**是有意的：榜上归一那一步只把**引号里**的名字换成 '…'，写两遍就成了
    // 一份文件一行（第一百四十九刀量到的：十来个类各自一行，全是 1 处）。
    return this.nope(node, `原型 '${shown(cls)}.construct' 没有带体的定义 —— 造一格它就得调它`
      + '（实现在宿主那边的走 opaque class 那条路，在别的模块里的要 import 得着）');
  }

  /** 那个类的 construct 只写了原型、**而且**体外也没有定义（第一百四十八刀）。
   *
   *  两问都要：体外写了定义那是第五十三刀那条正当的放法（`C.construct(…) { … }`），
   *  那时 `ctors` 里躺的是真的那一个。而这一层自己合出来的无参构造带着 `synth` 记号 ——
   *  它**顶不了**用户声明的那一个，所以看见它照旧算"只有原型"。少了这一问就会把
   *  cases/50-construct、62-opaque、63-dualmod 三份拒掉（第一遍就是这么错的）。 */
  protoCtorOnly(cls) {
    if (!this.protoCtors.has(cls)) return false;
    const ct = this.ctors.get(cls);
    return ct === undefined || ct.synth === true;
  }

  /** 这个类有**真的**（用户写出体的）construct 吗（第一百四十八刀）。
   *  这一层自己合出来的那几格带着 `synth` 记号 —— 它们只把字段默认值、基类的构造与静态构造
   *  串起来，顶不了用户声明的那一个。 */
  realCtor(cls) {
    const ct = this.ctors.get(cls);
    return ct !== undefined && ct.synth !== true;
  }

  /** 这个名字在**同一个主人**身上还有只有原型的那几条吗（第一百五十刀）。
   *
   *  `base` 是方言里那个名字（`ui$FormLayout$addRow`，重载改名过的那种末尾还带 `$oN`）：
   *  末段是方法名、前缀是主人。用处是把"实参个数不对"这类话拦下来 —— 那个类里同名的还有几条
   *  只有原型的，它们没进候选（第一百四十四刀那条账），所以数出来的那几个个数本来就不全。 */
  protoSibling(base) {
    const b = /\$o[0-9]+$/.test(base) ? base.slice(0, base.lastIndexOf('$')) : base;
    const i = b.lastIndexOf('$');
    if (i < 0) return false;
    const owners = this.protoMethods.get(b.slice(i + 1));
    return owners !== undefined && owners.has(b.slice(0, i));
  }

  /** 上面那一问为真时该说的那句话（第一百五十刀；第一百六十六刀把它说定了）。
   *
   *  `given` 给了、而且**正好有一条原型收这么多个**时，那就不是"可能不在表里"，是"合得上的
   *  那一条就是它" —— 真拦路的东西是"它没有带体的定义"，与顶层那一格（第九十二刀）同一句话。 */
  protoSiblingNope(node, base, given = null) {
    const b = /\$o[0-9]+$/.test(base) ? base.slice(0, base.lastIndexOf('$')) : base;
    if (given !== null) {
      const ar = this.protoArity.get(b);
      if (ar !== undefined && ar.has(given)) {
        /* 个数**不写进这句话**（第一百四十九刀那条口径）：写进去榜上归一那一步就按数字把这一行
           裂成几十行（量出来是 pairs +323），那种涨数是噪音不是账。要看几个，诊断指着的源码上有。 */
        return this.nope(node, `原型 '${shown(b)}' 没有带体的定义 —— 同名那几条里收这么多个实参`
          + '的就是它（实现在宿主那边的走 opaque class 那条路，在别的模块里的要 import 得着）');
      }
    }
    return this.nope(node, `'${shown(b)}' 同名的那几条里有只有原型的 —— 只有原型的重载这一层`
      + '还没有收进候选（见 ADR-0016 第一百四十四刀那一段），所以合得上的那一条**可能就不在'
      + '这张表里**：这儿说"对不上"的那个个数与类型都是拿剩下那几条数出来的');
  }

  ctorArgs(node, cls, argNodes0) {
    if (this.protoCtorOnly(cls)) return this.protoCtorNope(node, cls);
    const ct = this.ctors.get(cls);
    if (ct === undefined) {
      if (argNodes0.length > 0) {
        return this.err(node, `${shown(cls)} 没有 construct，后面挂不了构造实参`);
      }
      return null;                     // 没有构造：什么都不用调
    }
    /* 这一族有重载（第一百五十五刀）：先按实参挑一条，再照下面那一遍逐个检查。
       `hasSelf` 给 true —— 那几条签名里第 0 格是 `this`，挑的时候不能把它算进实参。
       `ctors` 里记的一直是基名那一条，所以挑中之后要把 params / defs 换成**挑中那一条**的。 */
    let pick = ct;
    const cbase = `${cls}$construct`;
    if (this.overloads.has(cbase)) {
      const chosen = this.pickOverload(node, cbase, argNodes0, true);
      if (chosen === null) return null;
      const cs = this.fns.get(chosen);
      pick = {
        name: chosen,
        params: cs.params.slice(1),
        defs: cs.defs === undefined || cs.defs === null ? null : cs.defs.slice(1),
      };
    }
    const want = pick.params;
    const argNodes = this.withDefaults(argNodes0, want,
      pick.defs === undefined ? null : pick.defs, cls);
    if (argNodes === null) return null;
    if (argNodes.length !== want.length) {
      return this.err(node, `${shown(cls)} 的 construct 要 ${want.length} 个实参，`
        + `这里给了 ${argNodes0.length} 个`);
    }
    const vals = [];
    for (let i = 0; i < argNodes.length; i++) {
      let v = this.expr(argNodes[i], want[i]);
      if (v === null) return null;
      if (isInt(v.type) && isInt(want[i])) v = intConv(v, want[i]);
      if (!this.assignOk(v.type, want[i])) {
        return this.err(argNodes[i], `${shown(cls)} 的 construct 的第 ${i + 1} 个实参要 `
          + `${tyName(want[i])}，这里是 ${tyName(v.type)}`);
      }
      vals.push(v);
    }
    return { name: pick.name, vals };
  }

  /**
   * `C1 a;` / `C1 a(100);` 里那一句构造调用（第五十三刀）。类的变量一声明就是**造一个对象**
   * （第五十二刀那段），造完紧接着就是构造 —— jancy 的 `initializeObject` 之后调的正是它。
   * 没有构造（也没有静态构造）时一个字都不发。回 null 表示报过错了。
   */
  ctorCall(node, cls, self, ctorNode, pad, out) {
    /* 体在宿主那边的 construct（第二百三十二刀）：`ui.ToolBar m_toolBar;` —— 一格**嵌进来**的
       类字段（局部的类变量同理），而那个类的 construct 只有原型。`new` 那一条路第一百六十二刀
       就落了（同一个符号、同一份声明里的签名），这一条先前还留在原处报 —— 同一件事，只是那格
       地址是字段的地址而不是刚 `pnew` 出来的那一格。语料里的原样是 doc_PluginHost.jnc:26/28
       （`ui.ToolBar m_toolBar;` / `ui.PropertyGrid m_propertyGrid;`），一起编那张榜上剩的
       就是这两处。 */
    if (!this.realCtor(cls) && this.hostCtors.has(cls)) {
      const hc = this.hostCtorArgs(node, cls, ctorNode === null ? [] : this.flat(ctorNode));
      if (hc === null) return null;
      out.push(`${pad}(expr (ccall ${hc.sym} ${self}`
        + `${hc.vals.map((v) => ` ${v.code}`).join('')}))`);
      return out;
    }
    if (this.protoCtorOnly(cls)) return this.protoCtorNope(node, cls);
    const argNodes = ctorNode === null ? [] : this.flat(ctorNode);
    if (!this.ctors.has(cls)) {
      if (argNodes.length > 0) return this.ctorArgs(node, cls, argNodes);
      return out;
    }
    const c = this.ctorArgs(node, cls, argNodes);
    if (c === null) return null;
    out.push(`${pad}(expr (call ${c.name} ${self}${c.vals.map((v) => ` ${v.code}`).join('')}))`);
    return out;
  }

  /**
   * `import "x.jnc";`（第六十刀）。jancy 的 import **不是 C 的 #include**：它不在这一点上
   * 展开文本，而是往一张待办表里记一笔（`ImportMgr::addImport`，jnc_ct_ImportMgr.cpp:34-76），
   * 等当前这个文件整个解完之后再一个个解那些文件，解出来的东西全都进**同一个模块**。
   * 也就是说它是"把另一份源码的顶层条目也算进来"，没有作用域、没有可见性、没有顺序。
   *
   * 摊平这一层刚好是那个语义：把待办记下来，`impDrain` 再把它们的顶层条目续到同一份
   * `items` 后面 —— 后面那一串"命名空间成员不看声明顺序"的遍数于是自动管到被 import 的文件。
   *
   * `.jncx` 不收：那是**编译好的动态扩展库**（addImport 里 `isExtensionLib` 那一支走的是
   * `loadDynamicLib`），一个 zip，里头封着 `.jnc` 声明加一份共享库；整棵参考树里一个
   * `.jncx` 文件都没有 —— 它们是构建产物。
   *
   * **我们这边换了一条路**（ADR-0022 的 J4c）：直接 `import "libfoo.dylib"`（`.so`/`.dll`
   * 同样收）。理由是那两件事本来可以分开 —— 「有哪些符号」由源码里的声明说（`opaque class`
   * 上的方法原型），「它们的体在哪儿」由这一句说。于是不需要 `.jncx` 那层封装：一句
   * `(lib "…")` 传给下游，JIT 那侧变成 `--lib`、链接那侧变成命令行上的一项。
   *
   * C 的系统库不写路径、写名字（`libc`/`libm`…，见 `hir/c_abi.js` 的 `C_SYSLIBS`）：
   * 它们**已经在这个进程里**了，而 macOS 上它们连磁盘上的文件都不是。
   */
  impAdd(it) {
    const a = it.items[1];
    const spec = isStr(a) || isAtom(a) ? a.value : null;
    if (spec === null) return this.err(it, 'import 后面要一个字符串');
    /* `as g`（ADR-0022 的 J4d）：那个库里的**函数**挂在 `g` 底下（`g.glfwInit()`）。
       一个真库有几百个名字，全摊进全局那一格是不礼貌的。宏与枚举常量**不挂** ——
       它们在 C 里本来就没有命名空间，挂上去反而是一种发明。 */
    const asNs = head(it) === 'import-as';
    const ns = asNs ? this.qname(it.items[2]) : null;
    const hdrNode = asNs ? it.items[3] : it.items[2];
    if (asNs && ns === null) return this.err(it, 'import … as 后面那个名字认不出来');
    /* `.jncx`（第二百一十刀把第六十刀那条"永久边界"改成一句提醒）：那一句在 jancy 里**只**做
       一件事 —— 把那个编译好的扩展库装进来（`addImport` 里 `isExtensionLib` 那一支走
       `loadDynamicLib`）。**声明不在它里头**：`io_base` 那个库的源码表是**空的**
       （`JNC_BEGIN_LIB_SOURCE_FILE_TABLE(IoLib)` 紧跟着就 `END`，jnc_io_IoLib.cpp:155-156），
       所以写 `import "io_base.jncx"` 的文件**另外**还写着 `import "io_SocketAddress.jnc"`
       那几句（UdpFlowMonSession.jnc:7-10 就是这个形状）—— 名字是从后面那几句来的。

       于是这一句在这一层没有可发的东西：「有哪些符号」由那几句 `.jnc` import 说，「它们的体在
       哪儿」由 C_ABI 那条约定说（只有原型的就是宿主符号，第一百八十三 / 一百九十七刀）。
       `.jncx` 自己是**构建产物**，整棵参考树里一个都没有，名字也无从落成一句 `(lib …)` ——
       编一个出来是发明。所以这一句照旧不发东西，但**不再拦整份文件**：先前那一格
       `还不收` 把后面所有的诊断都盖住了，而这儿其实什么都不缺。

       代价照实记：`.jncx` 的名字写错了这一层看不出来 —— 与 `(cabi …)` 那条路一样，
       从"编译期一句诊断"变成"链接期找不着符号"（ADR-0022 的 J4b 早就接受了这一笔）。 */
    if (spec.endsWith('.jncx')) {
      this.warn(it, `import "${spec}"：这一层不装编译好的扩展库 —— 声明从那几句 .jnc import 来、`
        + '体按 C_ABI 那条约定去找（这一句在这儿是空跑）');
      return null;
    }
    /* 动态库：不进那张"再解一份源码"的待办表，而是记成一句 `(lib …)`。
       三个平台的后缀都收，`.so.6` 那种带版本号的也算（Linux 上很常见）。
       预登记的**系统库**写名字不写路径（`libc`/`libm`/`libpthread`/`libdl`）——
       它们已经在这个进程里了，macOS 上连磁盘上的文件都不是（见 `hir/c_abi.js` 的
       `C_SYSLIBS`）。这儿只按形状分流，名字对不对由下游那一处表说。 */
    if (/\.(dylib|dll)$/.test(spec) || /\.so($|\.)/.test(spec)
      || /^lib[a-z0-9_]+$/.test(spec) || /\.framework$/.test(spec)) {
      this.decls.push(`  (lib ${JSON.stringify(spec)})`);
      /* `with "foo.h"`（ADR-0022 的 J4d）：那个头文件里的函数声明**一条条变成 `(cabi …)`**。
         收不下的（float、struct 按值、老式声明…）跳过并记一笔 —— 一个真头文件里总有几条
         落不进 C_ABI 那七个词，而其中一条都不该让整次 import 失败。 */
      const hspec = hdrNode === undefined || hdrNode === null
        ? null : (isStr(hdrNode) || isAtom(hdrNode) ? hdrNode.value : null);
      if (hspec !== null) this.impWith(it, spec, hspec, ns);
      /* `as g` 而**没有** `with`：一个类型都不知道。那一路照旧收下 —— 名字记进
         `cLibNs`，调用点按实参**推**一份签名出来，并且报一条 warning（ADR-0022 的 J4d：
         「不强制，但遇到崩溃不该惊讶，权利和方便留给使用者」）。 */
      if (ns !== null && hspec === null) this.cLibNs.add(ns);
      return null;
    }
    if (this.impFind === null || this.impParse === null) {
      return this.nope(it, `import "${spec}"（这一趟降级没带模块加载）`);
    }
    this.impQ.push({ node: it, spec, from: this.impFrom });
    return null;
  }

  /**
   * `import "libfoo.dylib" with "foo.h"` 的 `with` 那一半（ADR-0022 的 J4d）。
   *
   * 头文件里的函数声明一条条变成 `(cabi 名字 返回类型 (形参类型…))`，宏与枚举常量进
   * `cconsts`（用到的地方当场变成字面量，见 `cconstLit`）。解析那件事**不在这儿**：
   * 走的是注入的 `decls` 钩子（`cap('c.declsOf')`）—— 那一格用的是这个仓库里已有的那份 C
   * 前端（tcc 的移植，现在就在读真的 SDK 头），所以不外挂 tcc、也不另写一个 C 解析器。
   *
   * 收不下的一律**跳过并记一笔**（`warn`），不让一条声明把整次 import 失败：一个真头文件
   * 里总有几条落不进 C_ABI 那七个词（`long double`、struct 按值、老式声明…）。
   *
   * **变参这一版收得下**：`(cabi f R (T ...))`，分界（定参个数）在声明里，下游是
   * `CCALL` 的 aux。于是 `printf` 那一族也从头文件里进得来。
   */
  impWith(it, lib, hspec, ns) {
    if (this.impDecls === null) {
      return this.nope(it, `import "${lib}" with "${hspec}"（这一趟降级没带 C 头文件解析）`);
    }
    const got = this.impDecls(hspec, this.impFrom);
    if (got === null) return this.err(it, `找不着头文件 '${hspec}'`);
    let n = 0;
    for (const d of got.decls) {
      /* 变参也收（`(cabi f R (T ...))`）：分界在声明里，下游是 `CCALL` 的 aux。
         C 里 `...` 前面至少要有一格定参，一格都没有的（真头文件里基本不存在）跳过。 */
      if (d.variadic === true && d.params.length === 0) {
        this.warn(it, `${d.name}：变参而一格定参都没有，C 里那种声明不合法 —— 跳过`);
        continue;
      }
      const ps = d.variadic === true ? d.params.concat(['...']) : d.params;
      this.decls.push(`  (cabi ${d.name} ${d.ret} (${ps.join(' ')}))`);
      this.cabiNames.add(d.name);
      /* `as g` 那一路：查表的键带上前缀（`g.glfwInit`，就是调用点 `qname` 出来的样子），
         而 `sym` 始终是**真的 C 符号名** —— 命名空间是这一侧的事，那一端不知道有这回事。 */
      const key = ns === null || ns === undefined ? d.name : `${ns}.${d.name}`;
      this.cabiSigs.set(key, {
        ret: d.ret, params: d.params, variadic: d.variadic === true, sym: d.name,
      });
      n++;
    }
    /* 跳过的那些只报**一条**汇总：一个 `<math.h>` 能跳过五六十条，逐条报会把真正的诊断埋掉。
       而"第一条是什么"信息量很低 —— 一个真头文件里跳过的东西**成族**（`math.h` 里几乎全是
       `long double` 那一族的 `acosl`/`asinl`/…）。所以按理由分组，报最大的那一族加上它的
       条数：读的人一眼看出"这是 long double 那一族，不是我写错了什么"。 */
    if (got.skipped.length > 0) {
      const byWhy = new Map();
      for (const s of got.skipped) {
        /* 分组的键要把**形参的名字**去掉：`形参 $p0 的类型 long double …` 与
           `形参 x 的类型 long double …` 是同一族，留着名字就分成了几十组。 */
        const key = s.why.replace(/形参 [^ ]+ 的/, '形参的');
        byWhy.set(key, (byWhy.get(key) ?? 0) + 1);
      }
      let topWhy = '';
      let topN = 0;
      for (const [w, c] of byWhy) if (c > topN) { topWhy = w; topN = c; }
      const kinds = byWhy.size === 1 ? '' : `，共 ${byWhy.size} 类`;
      this.warn(it, `"${hspec}" 里有 ${got.skipped.length} 条声明落不进 C_ABI 的那几个词`
        + `（收下了 ${n} 条${kinds}）；最多的一类 ${topN} 条：${topWhy}`);
    }
    /* 常量（宏 + 枚举常量）。**后来的不盖先来的**：同一个名字在两个头文件里出现时，
       第一次那个赢 —— 与 C 的 `#ifndef` 守卫同一个方向。求不出值的那些一句都不报：
       一份真头文件里的求不出来的宏基本全是 include 守卫和 `__attribute__` 那一族，
       它们本来就不是常量，报出来只会是噪音。真用到一个求不出来的名字时，
       报的是「未声明的变量」—— 那句话在那个位置是对的。 */
    for (const c of got.consts ?? []) {
      if (!this.cconsts.has(c.name)) this.cconsts.set(c.name, c);
    }
    return null;
  }

  /**
   * import 那张待办表（第六十刀）。jancy 的 `parseImports` 是个 **worklist**：把当前攒下的
   * 那一批整批取走、逐个解，解出来的文件里又会攒下新的一批，循环到空
   * （jnc_ct_Module.cpp:412-431）。传递依赖与循环 import 都在这一层收掉 —— 收掉靠的是
   * 那张按规范化路径查重的表（`m_importFilePathMap` 的 FindResult_AlreadyImported，
   * jnc_ct_ImportMgr.cpp:126-128），环里第二次碰到同一个文件就直接跳过。
   *
   * 摊出来的条目一律挂在 `ns ''` 上：被 import 的文件是**另一个 unit**，它从全局命名空间
   * 开始解（`parseLazyImport` 里那句 `openNamespaceIf(getGlobalNamespace())`，
   * jnc_ct_ImportMgr.cpp:162），所以写在 `namespace a { import "x.jnc"; }` 里也一样。
   */
  /**
   * 扩展库那几份**隐式 import**（第一百九十九刀）。jancy 的扩展库除了那张源码表
   * （`JNC_LIB_SOURCE_FILE`）还有一张**导入表**：`JNC_LIB_IMPORT("std_globals.jnc")` 与
   * `JNC_LIB_IMPORT("std_Error.jnc")`（jnc_std_StdLib.cpp:930-931）、
   * `JNC_LIB_IMPORT("sys_globals.jnc")`（jnc_sys_SysLib.cpp:218）—— 那几份声明对**每个模块**
   * 都是"一开张就在"的，谁都不用写那条 import。`memcpy` / `strlen` / `atoi` / `std.setError` /
   * `sys.getTimestamp` 那几族全在里头（榜上 `没有这个函数：'…'` 那一行的大半）。
   *
   * 这一层没有"装扩展库"那一步（扩展库走的是 `import "libfoo.dylib"`，声明照旧写在源码里），
   * 所以判据只有一条：**那几份声明找得着吗**。找得着（第一百八十九刀把 jancy 自己那几个扩展库的
   * `jnc` 目录放进了 `-I`）就照 jancy 那样隐式 import；找不着就什么都不做 —— tests/jnc 底下那些
   * 用例的 `-I` 里没有它们，所以那一侧一个字都不变。
   *
   * 自己就是那几份之一时不会重复摊：`impSeen` 一开始就装着这个 unit（impDrain 按路径查重）。
   */
  libImports(node) {
    if (this.impFind === null || this.impParse === null) return;
    for (const spec of LIB_IMPORTS) {
      const p = this.impFind(spec, this.unit);
      if (p === null || this.impSeen.has(p)) continue;
      this.impQ.push({ node, spec, from: this.unit });
    }
  }

  impDrain(items) {
    while (this.impQ.length !== 0) {
      const batch = this.impQ;
      this.impQ = [];
      for (const e of batch) {
        const p = this.impFind(e.spec, e.from);
        if (p === null) {
          // 拒的这句话要说清"在哪儿找过"（第六十二刀）：没给 `-I` 时只找过旁边一格，
          // 给了就把那张表也报出来 —— 不然"找不着"这句话既可能是名字错了、也可能是
          // 目录表少了一格，读的人分不出来。
          const where = this.impDirs.length === 0
            ? '在写这条 import 的那个文件旁边找不着它；jancy 那边还有 `-I` 给的目录表，'
              + '这一趟一个都没给'
            : `在写这条 import 的那个文件旁边、以及 -I 给的 ${this.impDirs.length} 个目录里`
              + '都找不着它';
          this.nope(e.node, `import "${e.spec}"（${where}）`);
          continue;
        }
        if (this.impSeen.has(p)) continue;
        this.impSeen.add(p);
        this.impFrom = p;
        this.nsFlat(this.impParse(p), '', items);
      }
    }
    this.impFrom = this.unit;
    return items;
  }

  fnDef(n) {
    const sig = this.sigs.get(n);
    if (sig === undefined) return null;        // 签名那一遍就报过错了
    const { info, ps, isMain } = sig;
    this.scopes = [new Map()];
    // 方法的体（第五十二刀）：`this` 是第一个形参，而**类自己是一层命名空间** ——
    // 所以体里查名先看这个类（`foo()` 找得着同一个类的 `C$foo`），裸字段名由 selfField 接。
    // 体外写的 `void C.foo() {}` 与体内写的走的是同一条路（this.ns 摆到类上）。
    const saveNs = this.ns;
    const saveSelf = this.selfClass;
    // errorcode（第五十八刀）：这个函数自己的出错值 —— 传播那一句 `return` 回的就是它。
    const saveErr = this.curErr;
    this.curErr = this.errFns.has(info.name) ? this.errFns.get(info.name) : null;
    this.shield = 0;
    this.guards = [];
    const owner = this.methods.get(info.name);
    if (owner !== undefined) { this.ns = owner; this.selfClass = owner; }
    else this.selfClass = null;
    // 属性的取/存那两个函数（第七十一刀）：`this.ns` 再往里挪一层，摆到**属性**那一格上 ——
    // 属性在 jancy 那边本来就是一层命名空间（prop_full.rst:15）。顶层 autoget 生成的那格存储
    // 在方言里叫 `g_p$m_value`，于是体里写的 `m_value` 由 resolve 从 `g_p` 退出去时接着；
    // 成员的那两格（`m_value` 第七十一刀 / `m_onChanged` 第八十四刀）是类里的字段，换名的
    // 活儿在 selfField 里 —— 这儿摆的就是它那张"源码里的名字 -> 字段名"的表。
    const savePr = this.selfProp;
    this.selfProp = null;
    const pOf = this.propOf.get(info.name);
    if (pOf !== undefined) {
      this.ns = pOf;
      const pi = this.props.get(pOf);
      if (pi !== undefined && pi.cls !== null) {
        // 写的人给那两格起的名字（完整声明式，第七十六刀）；没记就是文档里的默认名。
        const mem = this.propMemName.get(pOf);
        const ren = new Map();
        if (pi.store !== null) {
          ren.set(mem !== undefined && mem.store !== null ? mem.store : 'm_value', pi.store);
        }
        if (pi.onch !== null) {
          ren.set(mem !== undefined && mem.onch !== null ? mem.onch : 'm_onChanged', pi.onch);
        }
        if (ren.size > 0) this.selfProp = ren;
      }
    }

    // 取地址那一遍（第九刀）：先扫一遍函数体，知道哪些名字要提到堆上，再降。
    const taken = new Set();
    /* 返回类型是**指向结构体的指针**时，`return entry;` 也算取地址（第一百六十七刀）。 */
    this.collectAddrTaken(n.items[3], taken,
      info.type !== null && info.type !== undefined && info.type.k === 'ptr'
        && jncIsStruct(info.type.target));
    const saveLifted = this.lifted;
    this.lifted = taken;
    const saveAlias = this.alias;
    this.alias = new Map();
    // `this` 在方言里叫 `$this`：`this` 是 JS 的关键字，而 JS 后端把方言的名字**原样**发成
    // JS 的标识符（`$` 不在 jancy 的标识符里，所以撞不上用户的名字 —— 与 cellName 同一条）。
    if (owner !== undefined) this.alias.set('this', '$this');
    // 形参被取地址时提**它的一份拷贝**（C 的语义：形参就是个局部量，改它不影响调用方）
    const pre = [];
    for (const p of ps) {
      this.push(p.name, p.type);
      // 结构体形参是**按值**传的（第十三刀）：进来的是调用方那一段的地址，所以函数开头
      // 先开一格自己的、把它抄进来，之后这个名字一律指那一格。改形参因此不动调用方 ——
      // 与上面"被取地址的标量形参提一份拷贝"是同一个道理，只是抄的东西大一点。
      // 数组形参走同一条路（第二十一刀）：jancy 那边它也是按值的一整块，不是 C 的 `T*`。
      // 结构体的方法上那格 `this` **不抄**（第一百〇一刀）：它是"这一个对象"，不是一份拷贝
      // —— jancy 那边结构体方法的 this 也是个指针（`p.foo()` 改得动 p）。
      if (jncIsStruct(p.type) && p.name === 'this' && owner !== undefined) continue;
      if (jncIsStruct(p.type) || isArr(p.type)) {
        const v = `${p.name}$v`;
        const st = slotText(p.type);
        pre.push(`    (let ${v} ${st} (pnew ${st} (int 1)))`);
        if (this.copyVal(`(var ${v})`, `(var ${p.name})`, p.type, '    ', pre) === null) {
          this.lifted = saveLifted;
          this.alias = saveAlias;
          this.scopes = [];
    this.ns = saveNs;
          this.selfClass = saveSelf;
          this.selfProp = savePr;
          this.curErr = saveErr;
          return null;
        }
        this.alias.set(p.name, v);
        continue;
      }
      if (!taken.has(p.name)) continue;
      if (!this.liftable(p.type)) {
        this.nope(n, `对 ${tyName(p.type)} 的形参取地址（要方言能把它当内存里的值，见 liftable 那处）`);
        this.lifted = saveLifted;
        this.alias = saveAlias;
        this.scopes = [];
        this.ns = saveNs;
        this.selfClass = saveSelf;
        this.selfProp = savePr;
        this.curErr = saveErr;
        return null;
      }
      const c = this.cellName(p.name);
      const pt = tyText(tPtr(p.type));
      pre.push(`    (let ${c} ${pt} (pnew ${pt} (int 1)))`);
      pre.push(`    (pstore (var ${c}) (var ${p.name}))`);
    }
    // 静态构造在**实例构造的开头**调（第五十三刀）：jancy 的顺序是"基类构造 → 静态构造 →
    // 字段初值 → 属性构造"（jnc_ct_Parser.cpp:3005-3009），前后那两格这一层都没有，所以
    // 剩下的就是这一句。闸门保证它只跑一次，run 那一遍已经把 bool 开好了。
    if (owner !== undefined && info.name === `${owner}$construct` && this.sctors.has(owner)) {
      for (const l of this.gateLines(owner, '    ')) pre.push(l);
    }
    // 基类的构造（第五十六刀 + 第九十四刀）。jancy 的顺序里它排在最前（同一处 3005 行的第一句
    // `callBaseTypeConstructors`，那是**复数**）：源码里写了 `basetypeN.construct(…)` 的那几格
    // 就用那一句，没写的自动补 —— 而那一格要实参时补不出来，那时报错（jancy 同）。
    if (owner !== undefined && info.name === `${owner}$construct`) {
      const called = baseCtorCalls(n.items[3]);
      const dirs = this.dirBases(owner);
      for (let i = 0; i < dirs.length; i++) {
        const bc = this.ctors.get(dirs[i]);
        if (bc === undefined || called.has(i + 1)) continue;
        if (bc.params.length > 0) {
          this.err(n, `${shown(owner)} 的 construct 里没有调 basetype${dirs.length > 1 ? i + 1 : ''}`
            + `.construct(…)，而基类 ${shown(dirs[i])} 的 construct 要 ${bc.params.length} 个实参`);
        } else {
          pre.push(`    (expr (call ${bc.name} (var $this)))`);
        }
      }
      /* 类里那几格事件的单子（第八十三刀）：排在字段初值**之前** —— 初值里可以写
         `m_e += h`，那时单子必须已经建好。 */
      for (const l of this.evtInitLines(owner, '    ')) pre.push(l);
      /* 内嵌的类字段那几格（第一百六十一刀）：与事件那几行同一处、紧跟在它后面 —— 字段初值里
         可以写 `m_menu.addItem(…)`，那时那格对象得已经造出来。 */
      for (const l of this.embInitLines(owner, '    ')) pre.push(l);
      /* 字段的默认值（第七十八刀）：排在基类构造与静态构造之后、用户写的那个体之前 ——
         正是 jancy 那四句的第三句（jnc_ct_Parser.cpp:3005-3009 的 initializeFields）。
         所以 construct 里再给同一格字段赋值会**盖掉**默认值，与 jancy 一致。
         上下文已经摆好了（this.ns 在类上、`this` 别名成 `$this`、形参都 push 过），
         所以这儿直接用当前上下文降，不另开一格。 */
      for (const l of this.fieldInitLines(owner, 4)) pre.push(l);
      /* 结构体里那几格**字段自己的构造**（第一百二十九刀）：`Outer` 的构造里要把
         `Inner m_in` 那一格也构造一遍 —— jancy 那边这是 initializeFields 的一部分。
         不发这几句就是**静默的错答案**（那一格停在零值上，而源码明明写了 construct）。
         排在用户写的体之前：体里再给同一格赋值会盖掉它，与字段默认值同一条口径。 */
      for (const l of this.memCtorLines(owner, '    ')) pre.push(l);
    }
    const save = this.retTy;
    this.retTy = isMain ? J_VOID : info.type;
    let body = this.block(n.items[3], 4);
    this.retTy = save;
    this.scopes = [];
    this.lifted = saveLifted;
    this.alias = saveAlias;
    this.ns = saveNs;
    this.selfClass = saveSelf;
    this.selfProp = savePr;
    this.curErr = saveErr;
    if (body === null) return null;
    if (pre.length !== 0) body = `${pre.join('\n')}\n${body}`;
    if (isMain) { this.mainBody = body; return null; }
    // `this` 那一格在方言里叫 `$this`（见上面 alias 那一句）
    const params = ps.map((p) => `(${p.name === 'this' ? '$this' : p.name} ${slotText(p.type)})`).join(' ');
    this.decls.push(`  (fn ${info.name} (${params}) ${slotText(info.type)}\n${body})`);
    return null;
  }

  /* -------------------------------------------------------------- 语句 */

  /** `(compound unit)` -> 一串缩进好的语句文本（不含外层的 `(do …)`）。 */
  block(n, ind) {
    if (!isList(n) || head(n) !== 'compound') { this.err(n, '这里要一个 { … } 块'); return null; }
    const list = this.flat(n.items[1]);
    // `catch:` 把这个块的语句序列**切成两段**（第五十九刀），所以它不是一条能单独降的语句。
    const at = list.findIndex((s) => isLabel(s, 'catch'));
    if (at >= 0) return this.catchBlock(list, at, ind);
    this.scopes.push(new Map());
    const out = [];
    for (const s of list) {
      const lines = this.stmt(s, ind);
      if (lines !== null) for (const l of lines) out.push(l);
    }
    this.scopes.pop();
    return out.join('\n');
  }

  /**
   * 带 `catch:` 的一个块（第五十九刀）。前一段是**守着的**那些语句，后一段是处理。
   *
   *   (let $c0 bool (bool false))
   *   (while (bool true)          ; 一次性：出错就 brk 出来
   *     (do
   *       …前一段…                ; errorcode 出错 -> (do (set $c0 true) (brk N))
   *       (brk)))                 ; 正常走到底也出来，只是标志还是 false
   *   (if (var $c0)
   *     (do …后一段…))
   *
   * 那格标志是必需的：正常走到底与出错走出来是**同一个** `brk`。jancy 那边不用标志，因为它有
   * 两个块可跳（正常流跳 `catch_follow`、出错跳 `m_catchBlock`，Eh.cpp:330-345）；方言里
   * 一圈循环只有一个出口，所以差别记在一格 bool 上。
   *
   * 两段各是**自己的作用域**，与 jancy 同（`catchLabel` 里先 `closeScope()` 再
   * `openScope(pos, ScopeFlag_Catch)`）：前一段声明的名字在处理里看不见。方言这边它自然成立 ——
   * 前一段的 `(let …)` 在那圈循环的 `(do …)` 里。
   *
   * jancy 还多一条这一层不用管的：函数作用域上 `catch:` 之前那段**必须 return**
   * （`checkReturn()`，Eh.cpp:311-314）。真 return 了，下面那句 `(brk)` 就是不可达的死代码；
   * 没 return（void 函数）也对 —— 标志是 false，处理那段跳过去。
   */
  catchBlock(list, at, ind) {
    const pad = ' '.repeat(ind);
    const flag = `$c${this.tmp}`;
    this.tmp++;
    this.loops.push({ kind: 'oneshot', step: false });
    this.guards.push({ flag, loopIdx: this.loops.length - 1 });
    this.scopes.push(new Map());
    const guarded = [];
    let bad = false;
    for (let i = 0; i < at; i++) {
      const lines = this.stmt(list[i], ind + 4);
      if (lines === null) bad = true; else for (const l of lines) guarded.push(l);
    }
    this.scopes.pop();
    this.guards.pop();
    this.loops.pop();
    // 处理那一段在**守护之外**：里头的 errorcode 调用照旧往调用方传（jancy 同 —— catch 作用域
    // 里再抛是往外一层找，findCatchScope 从当前作用域往上走）。
    this.scopes.push(new Map());
    const handler = [];
    for (let i = at + 1; i < list.length; i++) {
      const lines = this.stmt(list[i], ind + 4);
      if (lines === null) bad = true; else for (const l of lines) handler.push(l);
    }
    this.scopes.pop();
    if (bad) return null;
    const out = [
      `${pad}(let ${flag} bool (bool false))`,
      `${pad}(while (bool true)`,
      `${pad}  (do`,
      ...guarded,
      `${pad}    (brk)`,
      `${pad}  )`,
      `${pad})`,
      `${pad}(if (var ${flag})`,
      `${pad}  (do`,
      ...handler,
      `${pad}  )`,
      `${pad})`,
    ];
    return out.join('\n');
  }

  /**
   * 一条语句 -> 若干行。返回 null 表示已经报过错。
   *
   * 这一层只管一件事：**errorcode 的传播插在哪儿**（第五十八刀）。jancy 那边 `checkErrorCode`
   * 是在那次调用之后**当场**分块的（jnc_ct_OperatorMgr_Call.cpp:591-592），这一层没有块，
   * 只有"一条语句"这个粒度 —— 于是把那次调用抬成一格临时、把"比一下就 return"插在**这条
   * 语句之前**。这么做要求那次调用在这条语句里只求一遍值，所以只有下面这几种语句开这个
   * 落点；循环那三种的条件每一圈都要重求一次，抬到外面就是错的，所以它们不开（落进去的
   * errorcode 调用会在 callExpr 那儿明说不收）。
   */
  stmt(n, ind) {
    const h = isList(n) ? head(n) : null;
    if (h !== null && EC_HOIST.has(h)) return this.ecScope(ind, () => this.stmt0(n, ind));
    const save = this.ecOut;
    this.ecOut = null;
    const r = this.stmt0(n, ind);
    this.ecOut = save;
    return r;
  }

  /** 开一格新的传播落点，降完把收上来的那几行摆在前面（第五十八刀）。 */
  ecScope(ind, run) {
    const saveOut = this.ecOut;
    const savePad = this.ecPad;
    this.ecOut = [];
    this.ecPad = ' '.repeat(ind);
    const r = run();
    const pre = this.ecOut;
    this.ecOut = saveOut;
    this.ecPad = savePad;
    if (r === null) return null;
    return pre.length === 0 ? r : [...pre, ...r];
  }

  /**
   * 在**惰性位置**上降一格表达式（第五十八刀）：`&&` / `||` 的右边、表达式位置上 `? :` 的
   * 两支 —— 那儿求不求值要看别人。传播那两句只插得到"这条语句之前"，插到那儿就成了
   * "无条件先调一遍"，求值顺序与短路语义一起被改掉。所以这些位置把落点**关掉**：落进去的
   * errorcode 调用当场说不收，而不是悄悄发一段跑法不一样的代码。
   */
  ecLazy(run) {
    const save = this.ecOut;
    this.ecOut = null;
    const r = run();
    this.ecOut = save;
    return r;
  }

  /** 一条语句 -> 若干行。返回 null 表示已经报过错。 */
  stmt0(n, ind) {
    const pad = ' '.repeat(ind);
    if (!isList(n)) { this.err(n, '认不出的语句'); return null; }
    const h = head(n);
    if (h === 'empty-stmt') return [];
    if (h === 'type-decl') { this.typeDecl(n.items[1]); return []; }
    if (h === 'compound') {
      const b = this.block(n, ind + 2);
      return b === null ? null : [`${pad}(do`, b, `${pad})`];
    }
    if (h === 'var-decl') return this.localDecl(n, ind);
    if (h === 'var-decl-curly') return this.localDeclCurly(n, ind);
    if (h === 'expr-stmt') return this.exprStmt(n.items[1], ind);
    if (h === 'if') return this.ifStmt(n, ind);
    if (h === 'while') return this.whileStmt(n, ind);
    if (h === 'do') return this.doWhileStmt(n, ind);
    if (h === 'for') return this.forStmt(n, ind);
    if (h === 'switch') return this.switchStmt(n, ind);
    if (h === 'case' || h === 'default') {
      this.err(n, `'${h}' 只能写在 switch 的花括号里`);
      return null;
    }
    if (h === 'return') return this.retStmt(n, ind);
    /* 第二百一十九刀：`语句 '…'` 剩下那 11 份按真话拆开是四件事，其中一件能落。

       **能落的那一格**：写在函数体里的 `typedef`（20_FunctionPtr.jnc:37 的
       `typedef function FpFunc(int, int, int);`、35_PropertyPtr.jnc 的
       `typedef double property FpProp;`）。这一层顶层的 typedef 那一整套（第三十八刀，函数
       类型那一支是第八十二刀）现成 —— 而 typedef 只是**给一格类型起个名字**，不生成任何
       代码，所以体里那一条与写在外面那一层是同一件事，直接交给 typedefDecl。
       **代价明写**：名字**提到了外面那层命名空间**（`qual(name)`），所以
         - 函数外面也能用那个名字了（jancy 那儿不能）—— 拒得更松，不改能跑的程序的行为；
         - 同一层里两个函数各写一条同名 typedef 会撞（jancy 那儿不撞）—— 那时 typedefDecl
           会报"重复定义"，是**拒得更严**，也不会给错答案。
       真按作用域收要一张跟着 `scopes` 一起进出的类型表，与函数体里的 `using namespace`
       （第二百一十七刀那条界）是同一件事，等那张表一起落。 */
    if (h === 'typedef') {
      this.typedefDecl(n);
      return [];
    }
    /* `dylayout (layout) { … }`（4 份：BacNetMsTp.jnc、BacNetMsTpLogRepresenter.jnc、
       io_Modbus.jnc、io_ModbusTemplates.jnc）。jancy 那儿它是**动态布局**那一整套的语句形式：
       块里那些 `dylayout` 字段按运行期读到的字节一格一格摆出来，读的是 `jnc.DynamicLayout`
       上那格 validator（与第二百一十四刀那三个 `dynamic …` 算子是同一族）。 */
    if (h === 'dylayout') {
      return this.nope(n, '`dylayout (layout) { … }` —— jancy 那儿它是**动态布局**那一整套'
        + '（块里的字段按运行期读到的字节一格一格摆，读的是 jnc.DynamicLayout 上那格 '
        + 'validator），与 `dynamic sizeof` 那三个算子同一族（见第二百一十四刀）');
    }
    /* 挂在**语句**上的属性块（`[ … ] 语句`）。声明上那一格第一百〇八刀就收下不看了（属性是
       纯元数据，jancy 那边它进的是 doxygen / 反射那张表，不改生成的代码），语句这一侧同一条 ——
       只有一种例外：方括号里写 `Regex…` 那几个词时它**不是**元数据，是那台 DFA 的开关
       （Stmt.llk:207 那句 `regexSwitchStmt_Create(&$stmt, &m_pragmaConfig, popAttributeBlock())`
       —— 属性块与 pragma 配置一起递进去）。语料里那一处正是这一种
       （70_RegexSwitch.jnc:34 的 `[ RegexAnchored ]`），而 regex switch 本来就还不收，
       所以这儿把它单独说清、别混进"收下不看"里。 */
    if (h === 'attributed') {
      const names = [];
      const walk = (a) => {
        if (!isList(a)) return;
        if (head(a) === 'attr' && isAtom(a.items[1])) { names.push(a.items[1].value); return; }
        for (let i = 1; i < a.items.length; i++) walk(a.items[i]);
      };
      walk(n.items[1]);
      const rx = names.find((x) => x.startsWith('Regex'));
      if (rx !== undefined) {
        return this.nope(n, `属性块里的 '${rx}' —— 它不是元数据，是 regex switch 那台 DFA 的开关`
          + '（Stmt.llk:207 把属性块与 pragma 配置一起递给 regexSwitchStmt_Create），'
          + '而 regex switch 还不收（见第二百一十四刀）');
      }
      return this.stmt(n.items[2], ind);
    }
    /* `throw;`（第二百一十八刀）。语料里 8 份文件、全是**不带值**的那一种
       （ReplayLogLayer.jnc:348、JLinkRttSession.jnc:483、io_Modbus.jnc:762 那一族）。
       jancy 那儿 `throwException()` 就两句（jnc_ct_ControlFlowMgr_Eh.cpp:93-112）：
       里头有 catch 作用域就跳它（`escapeScope(catchScope, …)`），没有就
       `ret(returnType->getErrorCodeValue())` —— 而那时当前函数**必须**是 errorcode
       （同处那句 ASSERT）。
       这一层第五十九刀早把这两句写好了：`escape(g)` 就是它 —— 有 guard 跳那圈一次性循环的
       `brk`、没有就 `(ret curErr)`。所以 `throw;` 与"errorcode 调用出错时那一跳"落的是
       **同一段代码**，一个字节的新机器都不用造。
       拦的条件也照抄 propagate 那一处：既没有 guard、这个函数自己也不是 errorcode 时说清。 */
    if (h === 'throw') {
      if (n.items.length > 1) {
        /* `throw expr;`（语料里一处都没有）：jancy 那儿它先调 `std.setError(value)` 再抛
           （jnc_ct_ControlFlowMgr_Eh.cpp:69-90）。那要一格"当前的错"的槽与 std.Error 那一套。 */
        return this.nope(n, '`throw 一个值`—— jancy 那儿它先调 `std.setError(值)` 再抛'
          + '（jnc_ct_ControlFlowMgr_Eh.cpp:69-90），要一格"当前的错"的槽与 std.Error 那一套；'
          + '不带值的 `throw;` 收了');
      }
      const g = this.guards.length === 0 ? null : this.guards[this.guards.length - 1];
      if (g === null && this.curErr === null) {
        return this.nope(n, '`throw;` 写在一个自己不是 errorcode、外面也没有 `try { … }` / '
          + '`catch:` 的函数里（jancy 那儿这一格是 ASSERT：抛出去的那一跳没有去处，'
          + 'jnc_ct_ControlFlowMgr_Eh.cpp:108-111）');
      }
      return [`${pad}${this.escape(g)}`];
    }
    if (h === 'break' || h === 'continue') {
      const lvl = isAtom(n.items[1]) ? Number(n.items[1].value) : 1;
      const st = this.loops;
      // `break N`：jancy 把 switch 也算一层（cflow_switch.rst:37 那个 `break2` 就是
      // "出 switch 再出循环"），for 的体外面套的那圈一次性循环则**不算** —— 它是我们摊出来的。
      // 找到目标那一格之后，方言的层号是"到栈顶的距离"，一次性那几圈自然被数进去。
      if (h === 'break') {
        let bseen = 0;
        let bidx = -1;
        for (let i = st.length - 1; i >= 0; i--) {
          if (st[i].kind !== 'oneshot' && ++bseen === lvl) { bidx = i; break; }
        }
        if (bidx < 0) {
          this.err(n, `break${lvl === 1 ? '' : lvl} 要往外数 ${lvl} 层（switch 也算一层），这里只有 ${bseen} 层`);
          return null;
        }
        const blevel = st.length - bidx;
        return [`${pad}(brk${blevel === 1 ? '' : ` ${blevel}`})`];
      }
      // `continue N` 只数**真循环**：switch 与一次性那圈都不算（与 C 同）。所以 switch 里的
      // `continue` 落到方言里是 `(cont 2)` —— 跳过合成的那圈，回到外面那个真循环。
      let seen = 0;
      let idx = -1;
      for (let i = st.length - 1; i >= 0; i--) {
        if (st[i].kind === 'loop' && ++seen === lvl) { idx = i; break; }
      }
      if (idx < 0) {
        this.err(n, `continue${lvl === 1 ? '' : lvl} 要往外数 ${lvl} 层循环（switch 不算），这里只有 ${seen} 层`);
        return null;
      }
      // 带步进的 for：跳的是它体外那圈**一次性**循环的 `brk` —— 落点正好在步进之前
      // （第四十二刀）。没有步进的循环直接 `cont` 到头上就行。
      if (st[idx + 1] !== undefined && st[idx + 1].kind === 'oneshot') {
        const olevel = st.length - (idx + 1);
        return [`${pad}(brk${olevel === 1 ? '' : ` ${olevel}`})`];
      }
      if (st[idx].step) {
        // 走到这儿说明 forStmt 该套那圈却没套 —— 那是编译器自己的 bug，不许静默跳错地方。
        this.err(n, `内部错：带步进的 for 没有套一次性循环，continue${lvl === 1 ? '' : lvl} 无处可跳`);
        return null;
      }
      const level = st.length - idx;
      return [`${pad}(cont${level === 1 ? '' : ` ${level}`})`];
    }
    if (h === 'assert') return this.assertStmt(n, ind);
    if (h === 'unsafe') {
      const save = this.unsafe;
      this.unsafe = true;
      const b = this.block(n.items[1], ind + 2);
      this.unsafe = save;
      return b === null ? null : [`${pad}(unsafe`, b, `${pad})`];
    }
    // `try { … }`（第五十九刀）。它**不是**"把里面的错忽略掉"：出错时那一块剩下的语句一句都
    // 不跑，然后从块后面接着走（exceptions.rst:53-57 那个 `baz(21); // never get here`）。
    // 方言里"跳到一格作用域的出口"就是那圈**一次性循环**的 `brk` —— 与第四十二刀给带步进的
    // for 套的那一圈是同一个东西。于是这一条不用方言长任何新形式。
    //
    // 注意它**不要求外面这个函数是 errorcode**：jancy 那边 `canStaticThrow()` 是
    // "canCatch() || 自己带 ErrorCode"（Scope.h:144-145），`try` 块自己就提供了前一半。
    if (h === 'try') {
      this.loops.push({ kind: 'oneshot', step: false });
      this.guards.push({ flag: null, loopIdx: this.loops.length - 1 });
      const b = this.block(n.items[1], ind + 4);
      this.guards.pop();
      this.loops.pop();
      if (b === null) return null;
      return [
        `${pad}(while (bool true)`,
        `${pad}  (do`,
        b,
        `${pad}    (brk)`,
        `${pad}  )`,
        `${pad})`,
      ];
    }
    // `catch:` / `finally:`（第五十八刀记的边界，`catch:` 第五十九刀落地）。语法上它们是标签
    // （`(label "catch")`），可管的是**这个作用域出错时跳哪儿** —— `catch:` 由 block 那一处
    // 拦下来（它要把语句序列切成两段），所以走到这儿的 `catch:` 只有一种：一个块里写了两遍。
    if (h === 'label' && (isStr(n.items[1]) || isAtom(n.items[1]))
      && (n.items[1].value === 'catch' || n.items[1].value === 'finally')) {
      if (n.items[1].value === 'catch') {
        this.err(n, "'catch' 在这个块里已经有一个了（jancy 那句 \"'catch' is already defined\"，"
          + 'jnc_ct_ControlFlowMgr_Eh.cpp:322-325）');
        return null;
      }
      this.nope(n, '`finally:`（不管走哪条路都要跑一遍 —— 连 `return` 也得先绕过去，jancy 为它'
        + '专门开了一格 `finallyRouteIdx` 变量，jnc_ct_ControlFlowMgr_Eh.cpp:41-50）');
      return null;
    }
    /* `nestedscope:`（第二百一十九刀把它从"语句 '…'"那一句里拆出来；语料里 2 处：
       UdpSession.jnc 与 test105.jnc）。jancy 那儿这个标签把**它后面那一段**变成一格嵌套的
       可弃作用域 —— 也就是 `disposable` 那一套的另一半（disposable.rst:17 讲的正是
       "要确定时机就用 `dispose` / `nestedscope`"）。要作用域出口那一套钩子，与第二百一十二刀
       给 `disposable` 记的是同一笔账。 */
    if (h === 'label' && (isStr(n.items[1]) || isAtom(n.items[1]))
      && n.items[1].value === 'nestedscope') {
      this.nope(n, '`nestedscope:` —— 它把后面那一段变成一格嵌套的可弃作用域'
        + '（disposable.rst:17 那句"要确定时机就用 dispose / nestedscope"），'
        + '要作用域出口那一套钩子 —— 与 `disposable` 记同一笔账（第二百一十二刀）');
      return null;
    }
    /* `once <语句>`（第二百〇四刀）。jancy 那句话是"给这段代码生成一个**线程安全的**包装，
       保证它每次程序运行只跑一遍"（cflow_once.rst:15）。落法这一层早就有 —— `static` 局部量
       那一格（第二十六刀）与类的 static 局部量（第一百五十四刀）用的就是同一道闸门，而那两处
       的出处正是 jancy 自己的 `once`（`once` 包着 `initializeVariable`，jnc_ct_Parser.cpp:2452）：

         (global 旗子 bool)
         (if (un "!" (var 旗子)) (do (set 旗子 (bool true)) <那段> ))

       "线程安全"这一格：方言没有线程，所以那句保证在这一层是白拿的 —— 不是"少做了一件事"。
       `threadlocal once`（同处:41-46，每个线程一遍）照旧不收：那要 threadlocal 那一格存储，
       墙钉在 bad/threadlocal.jnc。 */
    if (h === 'once') {
      const flag = `jnc$once$${this.tmp++}`;
      this.decls.push(`  (global ${flag} bool)`);
      const bpad = `${pad}    `;
      const body = this.stmt(n.items[1], ind + 4);
      if (body === null) return null;
      // stmt 回的是**一串行**（block 回的是拼好的一段文本），所以这儿摊平再拼
      return [
        `${pad}(if (un "!" (var ${flag}))`,
        `${pad}  (do`,
        `${bpad}(set ${flag} (bool true))`,
        ...body,
        `${pad}  ))`,
      ];
    }
    /* 写在**函数体里**的 `using namespace X;`（第二百一十七刀立的界，test41.jnc:29）。
       写在命名空间那一层的那一格同一刀收了（usingScan），可这一格的作用域是**这个块** ——
       jancy 那儿它塞的是当前 scope 的 using 表（Function.cpp:130 那句 addUsingSet），
       所以要一张跟着 `scopes` 一起进出的表。说清是这一种，别让它落到笼统那句话上。 */
    if (h === 'using-namespace') {
      this.nope(n, '写在函数体里的 `using namespace X;` —— 它的作用域是这个块，'
        + '要一张跟着作用域一起进出的表（写在命名空间那一层的那一格收了，见 ADR-0016 '
        + '第二百一十七刀）');
      return null;
    }
    this.nope(n, `语句 '${h}'`);
    return null;
  }

  /** 局部量。没写初值的按零初始化 —— jancy 保证"用户代码碰到之前每一格都是零"。 */
  /**
   * 一格局部声明降不下来时，那个名字**仍旧要进作用域**（第一百四十五刀）。
   *
   * `GroupProperty* prop = new GroupProperty(name);`（ui_PropertyGrid.jnc:420）初值那一句报了
   * 一条（那个类的 construct 只有原型），先前这儿连名字都不记 —— 于是下面每一句用到 prop 的
   * 都跟着报"未声明的变量 'prop'"。逐份那张榜上那一行 296 处、一起编那张榜上 45 处，
   * 全是这么长出来的：**把这一句的账记到后面那些句子头上**，与"下一步算不出来记在这一步头上"
   * 是同一个形状的错账（第一百四十二刀那条口径的反面）。
   *
   * 声明的类型是**写出来的**，初值算不出来一点也不影响它，所以记下来不是猜。这一格只改诊断的
   * 落点：这条语句照旧算失败（一个字也不发、退出码照旧是 1）。
   */
  declBail(info) {
    if (info !== null && info !== undefined && info.type !== null && info.type !== undefined) {
      this.push(info.name, info.type);
    }
    return null;
  }

  /** 一串（或一格）声明符上写着的那几个名字（第二百三十五刀）。**一个字都不发** ——
   *  这一句的用处只有一个：那条声明自己已经报过错了，把名字记进 `badNames`，
   *  好让查名那两处说"声明写着，是那一句先没成"，而不是"未声明的变量"。 */
  badDeclNames(dclsNode) {
    for (const d of this.flat(dclsNode)) {
      let dcl = d;
      const dh = isList(d) ? head(d) : null;
      if (dh === 'init' || dh === 'ref-init') dcl = d.items[1];
      if (!isList(dcl) || head(dcl) !== 'dcl') continue;
      const nm = this.qname(dcl.items[2]);
      if (nm !== null) this.badNames.add(nm);
    }
  }

  localDecl(n, ind) {
    const pad = ' '.repeat(ind);
    const sp = this.specs(n.items[1]);
    /* 说明符那一句就没成（第二百三十五刀）：诊断已经发过一次了，可这几个名字**一格都没登记上**,
       于是后面每一处用到它们又各报一句"未声明的变量" —— 一件事记成好几笔。把名字记下来，
       查名那两处据此说准。 */
    if (sp === null) { this.badDeclNames(n.items[2]); return null; }
    // 函数体里的 `int property* p` 是一格**属性指针**（35_PropertyPtr.jnc:97-126）：里头存的
    // 是"取/存两个函数 + 那个对象"。这一层没有那一格类型，而 `property` 这个词 specs 是收下
    // 的 —— 不在这儿拦，它就会被悄悄降成一格普通指针（第七十刀）。
    if (sp.prop) return this.nope(n, '函数体里的属性声明（属性指针要一格"属性指针"类型）');
    const out = [];
    for (const d of this.flat(n.items[2])) {
      const dh = isList(d) ? head(d) : null;
      let dcl = d;
      let initNode = null;
      if (dh === 'init') { dcl = d.items[1]; initNode = d.items[2]; }
      else if (dh === 'ref-init') { this.nope(d, '引用初始化（`:=`）'); return null; }
      const info = this.declarator(dcl, sp);
      if (info === null) return null;
      if (info.formals !== null) {
        /* `A a(x, y);`（第一百〇三刀）：那对括号里是**构造实参**，不是形参表 —— 判据与
           "怎么当实参用"都在 ctorArgsOf 那儿。凑齐了就走第五十三刀那条现成的路。 */
        // `T v(a, b)`（第一百〇三刀）：类的变量收得下，结构体从第一百二十九刀起也收得下
        const ca = (isClass(info.type) && info.type.own === true) || jncIsStruct(info.type)
          ? this.ctorArgsOf(info.formals) : null;
        if (ca === null) {
          this.nope(dcl, '局部量上的形参表（`T v(a, b)` 那种构造实参只有类与结构体的变量收得下）');
          return null;
        }
        info.ctor = ca;
        info.formals = null;
      }
      // 声明符尾巴上的构造实参只有类与**结构体**的变量收得下（第五十三刀 + 第一百二十九刀）：
      // 别的类型那一格 jancy 也没有构造可调 —— 不明说就会被悄悄丢掉。
      if (info.ctor !== null && !(isClass(info.type) && info.type.own === true)
        && !jncIsStruct(info.type)) {
        this.err(dcl, `'${info.name}' 不是类或结构体的变量，后面挂不了构造实参`);
        return null;
      }
      // `static int x = 1;` 是另一回事：那一格程序启动时就分配好、初值**只跑一次**
      // （第二十六刀，见 staticLocal）。
      if (sp.stat) {
        if (this.staticLocal(dcl, info, initNode, pad, out) === null) return null;
        continue;
      }
      // 数组（第十刀）：`int a[3];` 就是一段长度 3 的零内存。`int a[];` 不合法（长度只能从
      // 花括号初值数出来）。`int b[3] = a;` 是**抄一份**（第二十一刀）—— 与结构体同一档，
      // 理由与出处见 copyVal 那一段。
      if (isArr(info.type)) {
        if (info.type.n === null) { this.err(dcl, `'${info.name}[]' 的长度得从花括号初值数出来`); return null; }
        let srcCode = null;
        if (initNode !== null) {
          const v = this.expr(initNode, info.type);
          if (v === null) return this.declBail(info);
          if (!this.assignOk(v.type, info.type)) {
            this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(info.type)}`);
            return this.declBail(info);
          }
          // 源头先钉住（要在目标那一格之前发：`int b[3] = b;` 里右边那个 b 指外层那个）
          srcCode = this.aggSource(v.code, slotText(info.type), pad, out);
        }
        // `&a` 不用把它提到堆上（第二十刀）：那一格里放的**就是**一整块的地址。
        this.push(info.name, info.type);
        const at = tyText(info.type);
        out.push(`${pad}(let ${info.name} ${at} (pnew ${at} (int 1)))`);
        if (srcCode !== null) {
          if (this.copyArr(`(var ${info.name})`, srcCode, info.type, pad, out) === null) return null;
        }
        continue;
      }
      // 类的变量（第五十二刀）：`C1 a;` 在 jancy 那边**就是**造一个对象 ——
      // "when Jancy programmer declares a class variable or a field he creates an actual
      // object, not a pointer to this object"（01_Classes.jnc:90-92），文档里那句更直白：
      // 局部的类变量"allocated on heap (same as: `C1* a = heap new C1;`)"（type_class.rst
      // 的 Construction 一节）。写了 `*` 的那一种（`C* p;`）不造对象，落到下面的标量那一条
      // （零值是空引用），所以这儿只管 own 那一种。
      if (isClass(info.type) && info.type.own === true) {
        if (initNode !== null) {
          this.err(initNode, `'${info.name}' 是类的变量，赋不了值（type_class.rst:19 那句 `
            + '"You cannot assign varibles or fields of class types"）—— 要一份拷贝得自己写 clone');
          return this.declBail(info);
        }
        if (this.lifted.has(info.name)) {
          this.nope(dcl, `对类的变量取地址（&${info.name}）—— 那要一格 \`C**\``);
          return this.declBail(info);
        }
        this.push(info.name, info.type);
        const ct = tyText(info.type);
        out.push(`${pad}(let ${info.name} ${ct} (pnew ${ct} (int 1)))`);
        // 动态类型那一格（第五十七刀）：一造出来就写死，往后虚派发按它挑实现。
        const tg = this.tagStore(dcl, info.type.name, `(var ${info.name})`, pad);
        if (tg === null) return null;
        out.push(tg);
        // 造完紧接着构造（第五十三刀）：`C1 a;` 也调 —— 无参构造与"只有静态构造"两种情形
        // 都在 ctorCall 里；两样都没有时一个字都不发。
        if (this.ctorCall(dcl, info.type.name, `(var ${info.name})`, info.ctor, pad, out) === null) {
          return null;
        }
        continue;
      }
      // 结构体（第十二刀）：`S s;` 是一格自己的零内存，`S t = s;` 逐字段抄一份。
      // `&s` 免费 —— 那一格的名字里放的**就是**地址。
      if (jncIsStruct(info.type)) {
        let srcCode = null;
        if (initNode !== null) {
          const v = this.expr(initNode, info.type);
          if (v === null) return this.declBail(info);
          if (!this.assignOk(v.type, info.type)) {
            this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(info.type)}`);
            return this.declBail(info);
          }
          srcCode = v.code;
        }
        this.push(info.name, info.type);
        const st = slotText(info.type);
        // 源头先钉住（要在目标那一格之前发：`S t = t;` 里右边那个 t 指外层那个）
        if (srcCode !== null) srcCode = this.aggSource(srcCode, st, pad, out);
        out.push(`${pad}(let ${info.name} ${st} (pnew ${st} (int 1)))`);
        if (srcCode !== null) {
          if (this.copyAgg(`(var ${info.name})`, srcCode, info.type.name, pad, out) === null) return null;
        }
        /* 结构体的构造（第一百二十九刀）：`P p;` / `P p(1, 2);` 造完紧接着调 —— 与类那一侧
           （第五十三刀）同一个 ctorCall，`this` 那一格传的就是这一格名字（结构体的名字里放的
           **本来就是地址**，所以不用先提到堆上）。写了初值的那一种不调：那是"抄一份"，
           源头已经构造过了（与 jancy 的 copy construct 同一条口径 —— 这一层没有拷贝构造）。 */
        if (srcCode === null
          && this.ctorCall(dcl, info.type.name, `(var ${info.name})`, info.ctor, pad, out) === null) {
          return null;
        }
        continue;
      }
      let code = null;
      if (initNode === null) {
        code = zeroText(info.type);
        if (code === null) {
          // 走到这儿只剩 void 与 string 那几种不该出现在局部量上的类型（结构体与数组
          // 在上面两条分支里各自开了自己那一格内存）。
          this.nope(dcl, `${tyName(info.type)} 的局部量不写初值`);
          return this.declBail(info);
        }
      } else {
        let v = this.expr(initNode, info.type);
        if (v === null) return this.declBail(info);
        if (isInt(v.type) && isInt(info.type)) v = intConv(v, info.type);
        if (!this.assignOk(v.type, info.type)) {
          this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(info.type)}`);
          return this.declBail(info);
        }
        code = v.code;
      }
      // 先降初值再进作用域：`int x = x;` 里右边那个 x 指的是外层那个（C 的规矩，jancy 同）
      this.push(info.name, info.type);
      // 被取过地址的名字提到堆上（第九刀）：那一格是 `(pnew (ptr T) (int 1))`，初值
      // 用 `pstore` 写进去。之后对它的读写全走那一格，于是 `*p` 与它是同一个字。
      if (this.lifted.has(info.name)) {
        if (!this.liftable(info.type)) {
          this.nope(dcl, `对 ${tyName(info.type)} 取地址（要方言能把它当内存里的值，见 liftable 那处）`);
          return null;
        }
        const c = this.cellName(info.name);
        const pt = tyText(tPtr(info.type));
        out.push(`${pad}(let ${c} ${pt} (pnew ${pt} (int 1)))`);
        out.push(`${pad}(pstore (var ${c}) ${code})`);
        continue;
      }
      out.push(`${pad}(let ${info.name} ${tyText(info.type)} ${code})`);
    }
    return out;
  }

  /**
   * `static` 的局部量（第二十六刀）。两件事，各有出处：
   *
   * **存储**：`static` 就是"程序启动时分配、一直待到程序结束"（decl_storage.rst），也就是
   * 一格模块级的槽 —— 所以这一层把它发成 `(global 名字$sN T)`，名字带一个计数好躲开
   * 同名（`$` 不在 jancy 的标识符里）。作用域还是那个块：它进的是 `this.scopes`，
   * 只是那一格记着"我在方言里叫别的名字、而且是模块级的"（见 push / lookupRef）。
   *
   * **初值只跑一次**：jancy 把它包在 `once` 里 —— `Parser::declare` 里
   * `onceStmt_Create` / `PreBody` / `initializeVariable` / `PostBody` 那四句
   * （jnc_ct_Parser.cpp:2452），就地包在**声明这一处**，不是挪到 module.construct
   * （那一条只对 `parentNamespace` 是全局的那些，jnc_ct_VariableMgr.cpp:209）。所以落法是
   * 一格 bool 闸门加一句 `(if (un "!" 闸门) (do (set 闸门 true) …初值…))`：第一次走到这儿
   * 才跑，之后每次都跳过。没写初值的一个字都不用发 —— `(global …)` 出来就是零，而 jancy
   * 那边也正是"初值空着就不包 once"（同一处 2454 行）。
   *
   * 没接的是 `threadlocal once`（一格线程一次）—— 这一层没有线程。
   */
  staticLocal(dcl, info, initNode, pad, out) {
    const t = info.type;
    // 类的 static 局部量（第五十三刀）：那一格要"造一次对象、构造一次"，也就是又一道 once
    // 闸门（jancy 那边正是 `once` 包着 initializeVariable）。先明说不收 —— 底下那条标量支路
    // 会把它当一格引用、只发一个空值出来，那是在骗人。类**指针**（`static C* p;`）不在这条里。
    if (isClass(t) && t.own === true) {
      /* 类的 static 局部量（第一百五十四刀，第五十三刀那时明说不收的那一格）：那一格要
         "造一次对象、写一次 `$tag`、构造一次"，三句都落在**同一道 once 闸门**里 —— 与 jancy
         那边 `once` 包着 `initializeVariable`（jnc_ct_Parser.cpp:2452）一句对一句。
         槽本身是模块级的（`(global 名字$sN C)`，出来是空引用），对象在第一次走到这儿时才造。
         写了初值的照旧拒：那是"类的变量赋不了值"（第五十二刀），与 static 无关。 */
      if (initNode !== null) {
        return this.err(dcl, `'${info.name}' 是类的变量，赋不了值（type_class.rst:19 那句 `
          + '"You cannot assign varibles or fields of class types"）');
      }
      const dnc = `${info.name}$s${this.tmp++}`;
      this.decls.push(`  (global ${dnc} ${slotText(t)})`);
      this.push(info.name, t, dnc);
      const flagc = `${dnc}$1`;
      this.decls.push(`  (global ${flagc} bool)`);
      const bpadc = `${pad}    `;
      const bodyc = [`${bpadc}(set ${dnc} (pnew (ptr ${clsRoot(t.name)}) (int 1)))`];
      const tg = this.tagStore(dcl, t.name, `(var ${dnc})`, bpadc);
      if (tg === null) return null;
      bodyc.push(tg);
      if (this.ctorCall(dcl, t.name, `(var ${dnc})`, info.ctor, bpadc, bodyc) === null) return null;
      out.push(`${pad}(if (un "!" (var ${flagc}))`);
      out.push(`${pad}  (do`);
      out.push(`${bpadc}(set ${flagc} (bool true))`);
      for (const l of bodyc) out.push(l);
      out.push(`${pad}  ))`);
      return out;
    }
    const dn = `${info.name}$s${this.tmp++}`;
    // 被 `&` 取过地址的标量要提到一段自己的内存里（与第二十四刀对模块级变量做的一样）
    const lift = this.gTaken.has(info.name) && this.liftable(t);
    if (isArr(t) && t.n === null) {
      return this.err(dcl, `'${info.name}[]' 的长度得从花括号初值数出来`);
    }
    if (jncIsStruct(t) || isArr(t)) {
      const st = slotText(t);
      this.decls.push(`  (global ${dn} ${st})`);
      this.globalCells.push(`    (set ${dn} (pnew ${st} (int 1)))`);
    } else if (lift) {
      const pt = tyText(tPtr(t));
      this.gLifted.add(dn);
      this.decls.push(`  (global ${dn} ${pt})`);
      this.globalCells.push(`    (set ${dn} (pnew ${pt} (int 1)))`);
    } else if (zeroText(t) === null) {
      return this.nope(dcl, `${tyName(t)} 的 static 局部量`);
    } else {
      this.decls.push(`  (global ${dn} ${slotText(t)})`);
    }
    // 初值降完了才进作用域：`static int x = x;` 里右边那个 x 指的是外层那个（与局部量同）
    const body = [];
    const bpad = `${pad}    `;
    if (initNode !== null && this.staticInitTo(dcl, dn, t, lift, initNode, bpad, body) === null) {
      return null;
    }
    this.push(info.name, t, dn);
    if (initNode === null) return out;
    const flag = `${dn}$1`;
    this.decls.push(`  (global ${flag} bool)`);
    out.push(`${pad}(if (un "!" (var ${flag}))`);
    out.push(`${pad}  (do`);
    out.push(`${bpad}(set ${flag} (bool true))`);
    for (const l of body) out.push(l);
    out.push(`${pad}  ))`);
    return out;
  }

  /** `static` 那一格的初值写进去：标量一句，聚合逐字段/逐格抄（与局部量同一份 copyVal）。 */
  staticInitTo(dcl, dn, t, lift, initNode, pad, out) {
    if (jncIsStruct(t) || isArr(t)) {
      const v = this.expr(initNode, t);
      if (v === null) return null;
      if (!this.assignOk(v.type, t)) {
        return this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(t)}`);
      }
      const src = this.aggSource(v.code, slotText(t), pad, out);
      return this.copyVal(`(var ${dn})`, src, t, pad, out);
    }
    let v = this.expr(initNode, t);
    if (v === null) return null;
    if (isInt(v.type) && isInt(t)) v = intConv(v, t);
    if (!this.assignOk(v.type, t)) {
      return this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(t)}`);
    }
    out.push(lift ? `${pad}(pstore (var ${dn}) ${v.code})` : `${pad}(set ${dn} ${v.code})`);
    return out;
  }

  /**
   * 花括号初始化的局部量（第十刀，第十四刀改成走 curlyPlan）：
   * `int a[3] = { 1, 2, 3 }` / `int b[] = { 7, 8 }` / `Point p = { 10, m_z = 30 }`。
   *
   * 语法上它是**另一条**产生式（`decl -> specs dcl "=" curly`，一次只声明一个名字）——
   * jancy 那边花括号初始化之后可以省掉分号，所以它不能挂在 init-dcl 上。
   *
   * 项少于格子时剩下的是**零**（CastOp_Array.cpp:`if (dstSize > srcSize) memset(dst, 0, …)`），
   * 而 pnew 出来的那一段本来就是零，所以少写的那几格一个字都不用发。项**多于**格子是错
   * （同一处：`srcElementCount <= dstElementCount` 才是一次转换），那一条在 curlyMember 里判。
   *
   * `static` 走另一条尾巴（第二十六刀）：那一格是模块级的，花括号里那几句包在 once 闸门里。
   */
  localDeclCurly(n, ind) {
    const pad = ' '.repeat(ind);
    const sp = this.specs(n.items[1]);
    if (sp === null) return null;
    const dcl = n.items[2];
    const info = this.declarator(dcl, sp);
    if (info === null) return null;
    if (info.formals !== null) { this.nope(dcl, '函数上的花括号初始化'); return null; }
    const curly = n.items[3];
    if (!isList(curly) || head(curly) !== 'curly') { this.err(n, '认不出的花括号初始化'); return null; }
    const t = this.curlyType(n, info, curly);
    if (t === null) return null;
    if (sp.stat) return this.staticLocalCurly(n, info, t, curly, pad);
    const out = [];
    const plan = this.curlyPlan(curly, t, pad, out, {
      shadow: info.name,
      val: (node, want) => this.initValue(node, want),
    }, [], []);
    if (plan === null) return null;
    // 初值降完了才进作用域、也才发目标那一格：`int a[2] = { a, 1 }` 里的 a 指外层那个
    this.push(info.name, t);
    const st = slotText(t);
    out.push(`${pad}(let ${info.name} ${st} (pnew ${st} (int 1)))`);
    return this.curlyEmit(plan, `(var ${info.name})`, pad, out);
  }

  /**
   * `static Point p = { … }`（第二十六刀）：那一格是模块级的（连它的一段内存一起，跟着
   * globalCells 在程序开头分配好），花括号里那几句照样包在 once 闸门里 —— 与 staticLocal
   * 同一份出处（jnc_ct_Parser.cpp:2452 的 onceStmt_*）。花括号初值只对聚合，所以这儿
   * 不必管标量提不提。
   */
  staticLocalCurly(n, info, t, curly, pad) {
    const dn = `${info.name}$s${this.tmp++}`;
    const st = slotText(t);
    this.decls.push(`  (global ${dn} ${st})`);
    this.globalCells.push(`    (set ${dn} (pnew ${st} (int 1)))`);
    const flag = `${dn}$1`;
    this.decls.push(`  (global ${flag} bool)`);
    const bpad = `${pad}    `;
    const body = [`${bpad}(set ${flag} (bool true))`];
    const plan = this.curlyPlan(curly, t, bpad, body, {
      shadow: info.name,
      val: (node, want) => this.initValue(node, want),
    }, [], []);
    if (plan === null) return null;
    // 初值降完了才进作用域：`static int a[2] = { a, 1 }` 里的 a 指外层那个（与局部量同）
    this.push(info.name, t, dn);
    if (this.curlyEmit(plan, `(var ${dn})`, bpad, body) === null) return null;
    return [`${pad}(if (un "!" (var ${flag}))`, `${pad}  (do`, ...body, `${pad}  ))`];
  }

  /** 可写的位置。方言里只有两种写法：`(set 名字 值)` 与 `(pstore 指针 值)`。 */
  lvalue(n) {
    if (!isList(n)) return this.err(n, '这里要一个可以赋值的位置');
    const h = head(n);
    if (h === 'name') return this.nameLv(n, n.items[1].value);
    // `this`（第五十二刀）：方法体里它就是第一个形参那一格。
    if (h === 'this') {
      if (this.selfClass === null) return this.err(n, '`this` 只在方法体里有');
      return this.nameLv(n, 'this');
    }
    // `a.g` —— 命名空间里的那一格（第五十一刀）。它在表达式里是一串 `field`，所以要在
    // "取字段"之前问一次：整体摊得动、而且摊出来的名字查得着，那就是它。
    if (h === 'field') {
      const q = this.dotted(n);
      if (q !== null && this.resolve(q, (k) => this.globals.has(k)) !== null) {
        return this.nameLv(n, q);
      }
    }
    return this.lvalue0(n, h);
  }

  /** 一个名字（可能带命名空间前缀）当可写位置。 */
  nameLv(n, nm) {
      const r = this.lookupRef(nm);
      // 方法体里裸写的字段名（第五十二刀）：`m_x` 就是 `this.m_x`，落在同一句 pfield 上。
      // 局部量与形参遮住它 —— 所以这一问排在 lookupRef 之后。
      if (r === null) {
        /* 裸写一格 bigendian 字段（第一百二十六刀）：它**是**一格真字段，所以这一问要排在
           `selfField` **之前** —— 排在后面就被那一支当普通字段接走了，字节序那一步就丢了。 */
        const bev = this.selfBeLv(nm);
        if (bev !== null) return bev;
        const f = this.selfField(nm);
        if (f !== null) {
          return {
            kind: jncIsStruct(f.type) || isArr(f.type) ? 'agg' : 'ptr',
            code: `(pfield (var $this) ${f.name})`,
            type: f.type,
          };
        }
        // 裸写一格字段路径别名（第一百〇四刀）
        const apv = this.selfPathLv(nm);
        if (apv !== null) return apv;
        // 裸写一格位域（第一百一十二刀）
        const bpv = this.selfBitLv(nm);
        if (bpv !== null) return bpv;
      }
      if (r === null) {
        // 属性不是一格内存（第六十九刀，与 memberOf 里那一条同一句）：`g_p++`、`&g_p` 落到
        // 这儿来。报"未声明"是认错了人 —— 那个名字在，只是它那一格要走取/存两个函数。
        const pq = this.propBare(nm);
        if (pq !== null) {
          return this.nope(n, `属性 '${shown(pq)}' 当一格可写的内存用 —— 读写各是一次调用，`
            + '`++`、`&` 与复合赋值这类"就地改"的写法这一层接不上');
        }
      /* 那格声明自己没成（第二百三十五刀）：名字**写着**，只是那一句先报了错（类型认不出来
         那一族），于是它一格都没登记上。这儿再说"未声明的变量"就是认错人，而且把一件事记成
         好几笔（一个名字用了几处就几笔）。指回那一句。
         记成**普通错**而不是"还不收"：根上那一句（`没有这个类型`）本来就是普通错，这儿只是
         它的回声 —— 记成 N 会把那几份文件从"没有还不收"那一格里挤出去（量出来 clean 239 -> 235），
         而那不是真的多欠了什么。 */
        if (this.badNames.has(nm)) {
          return this.err(n, `'${nm}' 那格声明自己没成（上面那一句已经报过）—— 名字写着，`
            + '可它一格都没登记上，所以这儿用不上它');
        }
        return this.err(n, `未声明的变量 '${nm}'`);
      }
      const t = r.type;
      // 它在方言里叫什么：`static` 的局部量那一格是模块级的、名字带函数名（第二十六刀），
      // 别的名字要过一遍 alias（结构体形参的那份拷贝，第十三刀）。
      const dn = r.dname === nm ? this.dialectName(nm) : r.dname;
      // 结构体与数组那一格里放的是地址，所以它们是 `agg`：读就是那个地址，写要抄一份
      //（结构体逐字段、数组逐格 —— 第十二刀与第二十一刀，见 copyVal）。
      // 这一条要在 lifted 之前 —— 它们本来就是一段内存，`&s` / `&a` 不用再提一次。
      if (jncIsStruct(t) || isArr(t)) return { kind: 'agg', code: `(var ${dn})`, type: t };
      // 提到堆上的那些名字本身就是一格内存，所以它是 `ptr` 而不是 `var` ——
      // 于是读写自动走 pload / pstore，而 `&x` 就是它的 code（见 expr0 的 addr）。
      // 模块级的那一半是第二十四刀：那一格就是全局自己（发成了 `(ptr T)`）。
      if (r.global) {
        if (this.gLifted.has(dn)) return { kind: 'ptr', code: `(var ${dn})`, type: t };
        return { kind: 'var', name: dn, type: t, global: true };
      }
      if (this.lifted.has(nm)) return { kind: 'ptr', code: `(var ${this.cellName(nm)})`, type: t };
      return { kind: 'var', name: dn, type: t, global: false };
  }

  lvalue0(n, h) {
    // `*p = v`
    if (h === 'indirect') {
      const p = this.expr(n.items[1], null);
      if (p === null) return null;
      return this.ptrLv(n, p);
    }
    // `p[i] = v`。jancy 的下标就是 `*(p + i)`，范围检查在解引用那一步
    // （type_ptr_data.rst：Range is checked on both array accesses and pointer dereferences）
    if (h === 'index') {
      const a = this.expr(n.items[1], null);
      if (a === null) return null;
      return this.subLv(n, a);
    }
    // `p->f = v` 与 `(*p).f = v` 是同一件事
    if (h === 'ptr-field') return this.fieldLv(n, n.items[1], n.items[2]);
    if (h === 'field') {
      const ob = n.items[1];
      if (isList(ob) && head(ob) === 'indirect') return this.fieldLv(n, ob.items[1], n.items[2]);
      // `s.f`：s 是结构体那一格，它的 code 就是地址，所以与 `p->f` 落在同一句 pfield 上
      // （第十二刀）。这一条以前不收，理由是"结构体只能经指针到达"。
      // **`.` 与 `->` 在 jancy 里是同一个算符**（第二十五刀）：`point2.m_x` 里的 point2 就是
      // 一个 `Point*`（samples/jnc/84_CurlyInitializers.jnc:66）。所以指针也从这儿走 ——
      // 那一格读出来的就是基地址，与结构体那一格唯一的差别是多一次 pload。
      // 左边不是**可写的形状**时（`f().x`、`(new T { … }).x`）当右值求一次值：回来的那一格
      // 也是一段内存的地址，只是这段内存没名字，读完就没人再指它（第十三刀 / 第二十五刀）。
      let base = null;
      let bt = null;
      if (isList(ob) && !LV_SHAPES.has(head(ob))) {
        const o = this.expr(ob);
        if (o === null) return null;
        base = o.code;
        bt = o.type;
      } else {
        // 左边是一格**属性**时（第七十二刀）：`g_icon.m_k` 里的 g_icon 先读一次（调取值器），
        // 读出来的是一格指针，之后取字段与 `p->f` 同一条。属性自己**没有被写**，所以这跟
        // "把属性当一格可写的内存用"不是一回事 —— 那一条拦的是 `g_icon++` 那种就地改。
        const pt = this.propTarget(ob);
        if (pt === null) return null;
        if (pt !== undefined) {
          const v = this.propGet(ob, pt.pn, pt.self);
          if (v === null) return null;
          base = v.code;
          bt = v.type;
        } else {
          const o = this.lvalue(ob);
          if (o === null) return null;
          base = this.read(o);
          bt = o.type;
        }
      }
      const st = structBehind(bt);
      // 枚举走到这儿说明左边不是**一个名字**（那一条在 expr0 的 field 支上，enumValueMember）。
      // jancy 那边 `pick().A` 是合法的：`getEnumTypeMember` 只要一格值。这一层还不收 ——
      // 收它要先求一次值再决定发 `&` 还是 `==`，而这一族里"先求值"的形状要一格临时量。
      if (st === null && jncIsEnum(bt)) {
        return this.nope(n, `从一个要先求值的东西上问 ${tyName(bt)} 的成员（只收左边是一个名字的）`);
      }
      if (st === null) return this.err(n, `'.' 的左边不是结构体：${tyName(bt)}`);
      return this.memberOf(n, base, st.name, n.items[2]);
    }
    return this.nope(n, `赋值给 '${h}'`);
  }

  fieldLv(n, ptrNode, memNode) {
    let p = this.expr(ptrNode, null);
    if (p === null) return null;
    /* `operator ->`（第一百三十四刀）：左边是一格带这个算符的类 / 结构体就先调它，
       算出来的指针再走下面那条原来的路。读写两侧都从这儿过 —— `it->m_value = value`
       （stdt_Map.jnc:150）靠的就是这一句。 */
    const od = this.opUnaryCall(p, 'arrow');
    if (od !== undefined) p = od;
    if (!jncIsPtr(p.type)) return this.err(n, `'->' 要一个指针，这里是 ${tyName(p.type)}`);
    if (!jncIsStruct(p.type.target)) return this.err(n, `'->' 的目标不是结构体：${tyName(p.type.target)}`);
    return this.memberOf(n, p.code, p.type.target.name, memNode);
  }

  /** `*p` 那一格的位置（第一百三十四刀把它从 lvalue 里提出来）：`p` 是已经算好的那格指针值。
   *  提出来是因为求值那一侧也要用它 —— 那儿为了先问一句"有没有 `operator *`"已经把左边算过
   *  一遍了，再走 lvalue 就会**算第二遍**（诊断会报两回、errorcode 的传播那两句会插两回）。 */
  ptrLv(n, p) {
    if (!jncIsPtr(p.type)) return this.err(n, `'*' 要一个指针，这里是 ${tyName(p.type)}`);
    const tt = p.type.target;
    return { kind: jncIsStruct(tt) || isArr(tt) ? 'agg' : 'ptr', code: p.code, type: tt };
  }

  /** `p[i]` 那一格的位置（第一百三十八刀把它从 lvalue 里提出来）：`a` 是已经算好的左边那一格。
   *  提出来的理由与 ptrLv 一样 —— 求值那一侧为了先问一句"有没有下标算符"已经把左边算过一遍，
   *  再走 lvalue 就会算第二遍（诊断报两回、errorcode 的传播那两句插两回）。 */
  subLv(n, a) {
    if (!jncIsPtr(a.type)) return this.err(n, `下标要一个指针，这里是 ${tyName(a.type)}`);
    const i = this.expr(n.items[2], J_I64);
    if (i === null) return null;
    if (!isInt(i.type)) return this.err(n, `下标要整数，这里是 ${tyName(i.type)}`);
    const tt = a.type.target;
    // 一格里躺的是数组时（多维，第十九刀）那一格**就是地址** —— 与结构体同一档：
    // 读它不发 pload（那一块不是一个值），退化那一步由 decay 的 `(pelem …)` 做。
    return {
      kind: jncIsStruct(tt) || isArr(tt) ? 'agg' : 'ptr',
      code: `(padd ${a.code} ${i.code})`,
      type: tt,
    };
  }

  /** 一个字段的位置：`(pfield 地址 f)`。字段自己是结构体或数组时它又是一格 `agg`（嵌套）。 */
  memberOf(n, baseCode, structName, memNode) {
    const nm = isAtom(memNode) ? memNode.value : null;
    const fs = this.structs.get(structName);
    const f = fs === undefined ? undefined : fs.find((x) => x.name === nm);
    if (f === undefined) {
      /* 套在匿名 struct 里的 bigendian 成员（第一百二十六刀）：它在外层那张字段表里查不着
         （名字挂在那一组的里层），所以这一问要排在别名那一张表**之前** —— 排在后面就被
         aliasPath 当普通字段接走了，字节序那一步就丢了。 */
      const bepA = nm === null ? undefined : this.bePath.get(`${structName}$${nm}`);
      if (bepA !== undefined) return this.beLv(bepA, baseCode);
      /* 字段路径的别名（第一百〇四刀）：`b.m_head` 里 m_head 是 `m_list.m_head` 的另一个名字
         —— 叠成一串 pfield。查名这一步展开，之后读写与"真写出那一串"完全同一条路。 */
      const ap = nm === null ? undefined : this.aliasPath.get(`${structName}$${nm}`);
      if (ap !== undefined) {
        let code = baseCode;
        for (const s of ap.path) code = `(pfield ${code} ${s})`;
        return {
          kind: jncIsStruct(ap.type) || isArr(ap.type) ? 'agg' : 'ptr',
          code,
          type: ap.type,
        };
      }
      // 位域（第一百一十二刀）：与上面那张表是同一种展开，只是路走到**存储那一格**就停，
      // 剩下的"哪几位"由 read / store 那两句办。
      const bp = nm === null ? undefined : this.bitPath.get(`${structName}$${nm}`);
      if (bp !== undefined) return this.bitsLv(bp, baseCode);
      // 属性不是一格内存（第六十九刀）：`b.p++`、`&b.p` 这些"就地改/取地址"的写法会落到这儿。
      // 报"没有这个字段"是认错了人 —— 那个成员在，只是它那一格要走取/存两个函数。左边得是
      // **类**才问这一句：属性只长在类上，结构体那边同名的字段不存在时报的仍旧是"没有字段"。
      if (nm !== null && this.propNames.has(nm) && this.classes.has(structName)) {
        return this.nope(n, `属性 '${nm}' 当一格可写的内存用 —— 读写各是一次调用，`
          + '`++`、`&` 与复合赋值这类"就地改"的写法这一层接不上');
      }
      // 名字要走 shown()：内部拼法（`doc$PluginHost`）漏进诊断里，用户不认得那是什么
      return this.err(n, `${shown(structName)} 没有字段 '${nm}'`);
    }
    /* bigendian 的字段（第一百二十六刀）：它**是**一格真字段（上面那一问找得着它），所以这一格
       挂在最后这个出口上，而不是像位域那样挂在"找不着"那一支里。读写各套一次字节序反转。 */
    const bep = this.bePath.get(`${structName}$${nm}`);
    if (bep !== undefined) return this.beLv(bep, baseCode);
    return {
      kind: jncIsStruct(f.type) || isArr(f.type) ? 'agg' : 'ptr',
      code: `(pfield ${baseCode} ${nm})`,
      type: f.type,
    };
  }

  store(lv, valueCode) {
    if (lv.kind === 'bits') return this.bitsStore(lv, valueCode);
    if (lv.kind === 'be') return this.bswapStore(lv, valueCode);
    return lv.kind === 'var' ? `(set ${lv.name} ${valueCode})` : `(pstore ${lv.code} ${valueCode})`;
  }

  /**
   * 位域读出来那一句（第一百一十二刀）。照 jancy 的 `extractBitField`
   * （jnc_ct_OperatorMgr_DataRef.cpp:272-314）一步不差：
   *
   *   `(存储 >> off) & ((1 << cnt) - 1)`，声明类型**有符号**时再补符号位。
   *
   * 两处细节要紧：
   *   - 右移要**逻辑**移。存储那一格记成无符号（见 bitSlot），所以 64 位那一格上 uOp 会挑
   *     `u>>`；窄的那几格里存的值本来就非负（写那一侧掩过），有符号右移也是同一个数。
   *   - 补符号位用 `(x ^ s) - s`（s 是 `1 << (cnt-1)`）—— 与 wrapTo 里那一句是同一个恒等式，
   *     jancy 那边写成 `value |= ~((signBit & value) - 1)`，两者逐位相同。
   *     `cnt === bw` 时整格就是它，那一步就是"按声明的符号性读这一格"，走 intConv。
   */
  bitsRead(lv) {
    const st = mkInt(lv.bw, true);
    const raw = `(pload ${lv.code})`;
    if (lv.cnt >= lv.bw) return intConv({ code: raw, type: st }, lv.type).code;
    const sh = lv.off === 0 ? raw : `(bin "${uOp('>>', st)}" ${raw} (int ${lv.off}))`;
    let code = `(bin "&" ${sh} (int ${(1n << BigInt(lv.cnt)) - 1n}))`;
    if (!lv.type.u) {
      const s = 1n << BigInt(lv.cnt - 1);
      code = `(bin "-" (bin "^" ${code} (int ${s})) (int ${s}))`;
    }
    return code;
  }

  /**
   * 位域写进去那一句（第一百一十二刀）。照 jancy 的 `mergeBitField`
   * （同处 :316-350）：`(旧 & ~掩码) | ((值 & 位掩码) << off)`。
   *
   * 也就是**读-改-写** —— 一格位域没有自己的字节，写它非得把同一格里别人那几位原样带回去。
   * `~掩码` 这一层写成 `旧 ^ (旧 & 掩码)`（把那几位清掉）：等价，而且不用发负数字面量。
   * 地址那一串（`lv.code`）在这一句里出现两次 —— 与复合赋值那儿 `lv op= v` 的落法同一条
   * （那儿也是 read 一次、store 一次），而这一层的地址串是纯的折offset，重求没有副作用。
   */
  bitsStore(lv, valueCode) {
    const cm = (1n << BigInt(lv.cnt)) - 1n;
    if (lv.cnt >= lv.bw) {
      // 整格都是它：写进去的就是"掩到这一格宽度"的那个值（与赋值到窄格同一条规矩）
      return `(pstore ${lv.code} ${wrapTo(valueCode, lv.bw, true)})`;
    }
    const mask = cm << BigInt(lv.off);
    const old = `(pload ${lv.code})`;
    const cleared = `(bin "^" ${old} (bin "&" ${old} (int ${mask})))`;
    const put = `(bin "&" ${valueCode} (int ${cm}))`;
    const shifted = lv.off === 0 ? put : `(bin "<<" ${put} (int ${lv.off}))`;
    return `(pstore ${lv.code} (bin "|" ${cleared} ${shifted}))`;
  }

  /**
   * 字节序反转（第一百二十六刀）：把 `code` 那个值的 w/8 个字节倒过来拼回去。
   *
   * 挑字节用**无符号**右移（`uOp`）—— 64 位那一格上有符号右移会把符号位摊进来，
   * 挑出来的高字节就是错的。拼回去之后再按声明的类型回卷一次（`wrapTo`）：无符号只掩位，
   * 有符号要把最高位摊成符号位 —— 与位域那一处（bitsRead）同一条规矩。
   *
   * `code` 在这儿会**出现好几次**（每个字节一次）。今天它一律是 `(pload …)`（纯读、没有
   * 副作用），与 bitsStore 里 `old` 出现两次是同一笔账；哪天左边能是带副作用的表达式，
   * 这两处要一起改成"先落一格临时量"。
   */
  bswapExpr(code, w, ty) {
    const st = mkInt(w, true);
    const n = w / 8;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const from = i * 8;
      const to = (n - 1 - i) * 8;
      let b = from === 0 ? code : `(bin "${uOp('>>', st)}" ${code} (int ${from}))`;
      b = `(bin "&" ${b} (int 255))`;
      parts.push(to === 0 ? b : `(bin "<<" ${b} (int ${to}))`);
    }
    const joined = parts.reduce((a, b) => `(bin "|" ${a} ${b})`);
    return wrapTo(joined, w, ty.u === true);
  }

  /** 一格 bigendian 字段的读：先按机器序读出来，再把字节倒过来。 */
  bswapRead(lv) {
    const t0 = jncIsEnum(lv.type) ? lv.type.base : lv.type;
    return this.bswapExpr(`(pload ${lv.code})`, lv.w, t0);
  }

  /** 一格 bigendian 字段的写：把要写的值先倒过来，再按机器序存。 */
  bswapStore(lv, valueCode) {
    const t0 = jncIsEnum(lv.type) ? lv.type.base : lv.type;
    return `(pstore ${lv.code} ${this.bswapExpr(valueCode, lv.w, t0)})`;
  }

  /** 取值。`agg`（结构体那一格）的 code **就是**地址，所以不 pload —— 结构体的"值"在这一层
   *  一律用它那段内存的地址表示，要抄一份的地方由 copyAgg 逐字段抄。 */
  read(lv) {
    if (lv.kind === 'bits') return this.bitsRead(lv);
    if (lv.kind === 'be') return this.bswapRead(lv);
    if (lv.kind === 'agg') return lv.code;
    return lv.kind === 'var' ? `(var ${lv.name})` : `(pload ${lv.code})`;
  }

  /**
   * 花括号初值的目标：一段**能按格子写**的内存（第十四刀）。结构体走 lvalue 的 `agg`（那一格
   * 的 code 就是地址），数组的名字在 lvalue 里是拒的（`a = b` 不合法），可 `a = { … }` 合法 ——
   * 那不是"给整个数组赋值"，是逐格写 —— 所以数组这一条在这儿自己取那一格。
   */
  aggTarget(n) {
    if (isList(n) && head(n) === 'name') {
      const nm = n.items[1].value;
      const r = this.lookupRef(nm);
      // 它在方言里叫什么：与 lvalue 那一处同一条（`static` 的局部量换了名字 —— 第二十六刀）
      if (r !== null && isArr(r.type)) {
        const dn = r.dname === nm ? this.dialectName(nm) : r.dname;
        return { code: `(var ${dn})`, type: r.type };
      }
    }
    const lv = this.lvalue(n);
    if (lv === null) return null;
    if (lv.kind !== 'agg') {
      return this.err(n, `花括号初值的左边要一段结构体或数组，这里是 ${tyName(lv.type)}`);
    }
    return { code: lv.code, type: lv.type };
  }

  /** 表达式语句。赋值与 ++/-- 只在这儿（与 for 的两格）成立 —— 方言里它们是语句不是表达式。 */
  exprStmt(n, ind) {
    const pad = ' '.repeat(ind);
    if (!isList(n)) { this.err(n, '认不出的表达式语句'); return null; }
    const h = head(n);
    if (h === 'assign') {
      const op = isStr(n.items[1]) ? n.items[1].value : null;
      // `point = { , 200, 300 }`（第十四刀）。右边是一对花括号时这**不是**一次赋值，而是
      // 按格子写进去 —— 空项那几格保留原值（84_CurlyInitializers.jnc:61 那行之后 m_x 还是 10）。
      if (isList(n.items[3]) && head(n.items[3]) === 'curly') {
        if (op !== '=') { this.err(n, `'${op}' 的右边不能是一对花括号`); return null; }
        const tgt = this.aggTarget(n.items[2]);
        if (tgt === null) return null;
        const out = [];
        const plan = this.curlyPlan(n.items[3], tgt.type, pad, out, {
          shadow: null,
          val: (node, want) => this.initValue(node, want),
        }, [], []);
        if (plan === null) return null;
        return this.curlyEmit(plan, tgt.code, pad, out);
      }
      // 给属性赋值（第六十八刀）：那不是往一格内存里写，是调存值器。这一问排在 lvalue
      // 之前 —— 属性没有"可写的那一格"，lvalue 会去查变量、查不着就报"未声明"。
      const pt = this.propRef(n.items[2]);
      if (pt !== null) return this.propSet(n, pt, op, n.items[3], pad);
      /* 事件上的 `+=` / `=`（第七十三刀）：同一条理由排在 lvalue 之前 —— `bindingof(p)`
       * 压根不是一格变量，而事件那一格在方言里是一格数组，写它走 apush 不走赋值。 */
      const mcl = this.mcRef(n.items[2]);
      if (mcl === null) return null;
      if (mcl !== undefined) return this.mcAssign(n, mcl, op, n.items[3], pad);
      // `c.m_a = 5` —— 成员属性（第六十九刀）：同样是调存值器，对象当第一个实参。同一条理由
      // 排在 lvalue 之前 —— 属性没有"可写的那一格"。
      const lhs = n.items[2];
      if (isList(lhs) && head(lhs) === 'field' && isAtom(lhs.items[2])
        && this.propNames.has(lhs.items[2].value)) {
        const pm = this.propMember(lhs, lhs.items[2].value);
        if (pm === null) return null;
        if (pm !== undefined) return this.propSet(n, pm.pn, op, n.items[3], pad, pm.self);
      }
      // `p[i] = v` / `obj.p[i] = v` —— 索引属性（第七十刀）：下标是存值器最前面那几个实参。
      // 同一条理由排在 lvalue 之前 —— 那儿只会报"下标要一个指针"。
      if (isList(lhs) && head(lhs) === 'index') {
        const ch = this.indexChain(lhs);
        const t = this.propTarget(ch.base);
        if (t === null) return null;
        // 没声明下标、类型又是指针的那些让路（第七十二刀）：那对方括号是读出来那一格的。
        if (t !== undefined && !this.propSubOnValue(t.pn)) {
          return this.propSet(n, t.pn, op, n.items[3], pad, t.self, ch.subs);
        }
        /* 下标算符（第一百三十八刀）：`c[i] = v` 走那一格裸写的 `set`。排在索引属性那一问
           **之后**（那一族是自己的路），排在 lvalue **之前**（那儿只会报"下标要一个指针"）。
           只在 `=` 上认 —— `c[i] += 1` 要先读一次再写一次，那是另一笔账（明说不收）。 */
        if (this.opIndex.size > 0) {
          const b = this.expr(lhs.items[1], null);
          if (b === null) return null;
          const oi = this.opIndexOf(b.type);
          if (oi !== undefined && oi.set !== undefined) {
            if (op !== '=') {
              return this.nope(n, `下标算符上的 '${op}'（要先读一次再写一次，是另一笔账）`);
            }
            const r = this.opIndexCall(lhs, oi.set, b, n.items[3]);
            return r === null ? null : [`${pad}(expr ${r.code})`];
          }
        }
      }
      const lv = this.lvalue(n.items[2]);
      if (lv === null) return null;
      /* 赋值算符（第一百三十刀）：左边那一格的类型上写了 `operator :=` 就调它。
         排在下面"类的变量赋不了值"与同型检查**之前** —— 那一句正是这个算符要盖掉的
         （jancy 的 std_String / std_Buffer 就靠它，`s = "abc"`）。
         三条判据写清：
           - 只在 `=` 上认（`+=` 那一族在 jancy 那边是另外的算符，还不收）；
           - 右边**同型**时不认：那是"抄一份"，是拷贝不是转换；
           - 右边要对得上它那**一个**形参（对不上就落回老路，让那儿说"两边不同型"）。
         右边按**算符那一格形参**的类型求值（`want` 给对了，字面量才落得对）。 */
      const oa = (isClass(lv.type) || jncIsStruct(lv.type))
        ? this.opAssign.get(lv.type.name) : undefined;
      if (op === '=' && oa !== undefined) {
        // 好几条 `operator :=` 时先按右边的类型挑一条（第二百四十二刀）
        const oap = this.opPick(n, 'operator :=', oa, n.items[3]);
        if (oap === null) return null;
        let ov = this.expr(n.items[3], oap.param);
        if (ov === null) return null;
        if (isInt(ov.type) && isInt(oap.param)) ov = intConv(ov, oap.param);
        if (!sameTy(ov.type, lv.type) && this.assignOk(ov.type, oap.param)) {
          const self = lv.kind === 'agg' ? lv.code : this.read(lv);
          return [`${pad}(expr (call ${oap.name} ${self} ${ov.code}))`];
        }
      }
      /* 复合赋值算符（第一百五十二刀）：左边那一格的类型上写了 `operator +=` 就调它。
         位置与上面那一条一样要排在"类的变量赋不了值"与整数那条路**之前** —— 它盖掉的正是那儿
         （第一遍放在了后面，`b -= 7` 于是撞上那句话，跑了一趟腿才看见）。 */
      const oc = op !== null && COMPOUND_OPS.has(op) && (isClass(lv.type) || jncIsStruct(lv.type))
        ? this.opCompound.get(`${lv.type.name}$${op}`) : undefined;
      if (oc !== undefined) {
        // 好几条 `operator +=` 时先按右边的类型挑一条（第二百四十二刀）
        const ocp = this.opPick(n, `operator ${op}`, oc, n.items[3]);
        if (ocp === null) return null;
        let ov = this.expr(n.items[3], ocp.param);
        if (ov === null) return null;
        if (isInt(ov.type) && isInt(ocp.param)) ov = intConv(ov, ocp.param);
        if (!this.assignOk(ov.type, ocp.param)) {
          this.err(n, `'operator ${op}' 的实参要 ${tyName(ocp.param)}，这里是 ${tyName(ov.type)}`);
          return null;
        }
        const self = lv.kind === 'agg' ? lv.code : this.read(lv);
        return [`${pad}(expr (call ${ocp.name} ${self} ${ov.code}))`];
      }
      // 类的变量赋不了值（第五十二刀）：type_class.rst:19 那句 "You cannot assign varibles
      // or fields of class types"。类**指针**照旧可以赋（那是换个引用，不是拷贝对象）。
      if (isClass(lv.type) && lv.type.own === true) {
        this.err(n, `类的变量赋不了值（type_class.rst:19 那句 "You cannot assign varibles `
          + 'or fields of class types"）—— 要一份拷贝得自己写 clone');
        return null;
      }
      let v = this.expr(n.items[3], lv.type);
      if (v === null) return null;
      if (op === '=') {
        // 整数之间的赋值是**隐式收窄**（`char c = 300` 存 44）—— C 的规矩，jancy 同。
        if (isInt(lv.type) && isInt(v.type)) v = intConv(v, lv.type);
        if (!this.assignOk(v.type, lv.type)) {
          this.err(n, `赋值两边不同型：左是 ${tyName(lv.type)}，右是 ${tyName(v.type)}`);
          return null;
        }
        // 结构体与数组都是**值**：`t = s` 抄一份，不是共享同一段（第十二刀、第二十一刀）
        if (lv.kind === 'agg') {
          const out = [];
          const src = this.aggSource(v.code, slotText(lv.type), pad, out);
          return this.copyVal(lv.code, src, lv.type, pad, out);
        }
        return [`${pad}${this.store(lv, v.code)}`];
      }
      const bin = op === null ? null : op.slice(0, -1);
      if (bin !== '+' && bin !== '-' && bin !== '*' && bin !== '/' && bin !== '%'
        && bin !== '&' && bin !== '|' && bin !== '^' && bin !== '<<' && bin !== '>>') {
        this.nope(n, `复合赋值 '${op}'`);
        return null;
      }
      // 指针上的 `p += i` 是**指针算术**，不是加法（type_ptr_data.rst 那段就是它）
      if (jncIsPtr(lv.type)) {
        if (bin !== '+' && bin !== '-') { this.nope(n, `指针上的 '${op}'`); return null; }
        if (!isInt(v.type)) { this.err(n, `指针上的 '${op}' 右边要整数，这里是 ${tyName(v.type)}`); return null; }
        const d = bin === '+' ? v.code : `(un "-" ${v.code})`;
        return [`${pad}${this.store(lv, `(padd ${this.read(lv)} ${d})`)}`];
      }
      // `bitflag enum` 上的 `&= |= ^=`（第四十七刀）。它不是新规矩，是二元那三条的复合形式：
      // `lv op= v` 就是 `lv = lv op v`，而二元那儿 `&` 任一边是 bitflag 枚举、`|` / `^` 两边
      // 同型 bitflag 枚举时结果就是那个枚举（jnc_ct_BinOp_Arithmetic.cpp:356-388），
      // 于是回赋进 lv 不用再转一次。语料与文档里的写法就是 `flags &= ~OpenFlags.Exclusive`
      //（type_enum.rst:87）。值照基整数算，`& | ^` 在规范形上不出范围，所以不回卷。
      if ((bin === '&' || bin === '|' || bin === '^') && jncIsEnum(lv.type) && lv.type.bits === true) {
        const vt = jncIsEnum(v.type) ? v.type : null;
        const ok = bin === '&'
          ? (vt === null ? isInt(v.type) : sameTy(vt, lv.type))
          : (vt !== null && sameTy(vt, lv.type));
        if (!ok) {
          this.err(n, `'${op}' 的右边要${bin === '&' ? `整数或同型的 ${tyName(lv.type)}` : `同型的 ${tyName(lv.type)}`}，这里是 ${tyName(v.type)}`);
          return null;
        }
        const x = { code: this.read(lv), type: lv.type.base };
        const y = intConv({ code: v.code, type: vt === null ? v.type : vt.base }, lv.type.base);
        return [`${pad}${this.store(lv, `(bin "${bin}" ${x.code} ${y.code})`)}`];
      }
      // `lv op= v` 就是 `lv = (T)(lv op v)`。中间那一格照常用算术转换来，**要真的转**
      //（第三十三刀）：以前两边都是有符号，"结果那一格总是 >= lv 那一格"这条让中间那一次
      // 省得掉；混了无符号之后不成立了 —— `int i = -7; i /= (unsigned)2;` 在 C 与 jancy 里
      // 是**无符号除法**（2147483644），省掉中间那一次就成了 -3。
      if (isInt(lv.type) && isInt(v.type)) {
        // 移位是例外：中间那一格**只看左边**（第三十五刀，与二元 `<<` `>>` 同一条规矩）。
        const shift = bin === '<<' || bin === '>>';
        const rt = shift ? arith(lv.type) : common(lv.type, v.type);
        const x = intConv({ code: this.read(lv), type: lv.type }, rt);
        const y = shift ? intConv(v, arith(v.type)) : intConv(v, rt);
        let code = `(bin "${uOp(bin, rt)}" ${x.code} ${y.code})`;
        // 回卷只发**一次**：收窄那一次自己就掩了低位，中间那一次省得掉。`%` 例外 ——
        // 余数天然在范围里，只有回到 lv 那一格要换符号性时才要动。
        const same = rt.w === lv.type.w && !rt.u === !lv.type.u;
        if (!same || bin !== '%') code = wrapTo(code, lv.type.w, lv.type.u);
        return [`${pad}${this.store(lv, code)}`];
      }
      // 位运算与移位只在整数上有定义（C 的规矩，jancy 同）。走到这儿两边不都是整数。
      if (bin === '&' || bin === '|' || bin === '^' || bin === '<<' || bin === '>>') {
        this.err(n, `'${op}' 要整数，这里左是 ${tyName(lv.type)}、右是 ${tyName(v.type)}`);
        return null;
      }
      if (!this.assignOk(v.type, lv.type)) {
        this.err(n, `'${op}' 两边不同型：左是 ${tyName(lv.type)}，右是 ${tyName(v.type)}`);
        return null;
      }
      return [`${pad}${this.store(lv, `(bin "${bin}" ${this.read(lv)} ${v.code})`)}`];
    }
    if (h === 'pre-inc' || h === 'post-inc' || h === 'pre-dec' || h === 'post-dec') {
      // 内建那三种（指针 / 整数 / real）在语句位置上前缀与后缀没有差别（都不取值）；
      // 重载那一族**有**差别（是两个函数），见下面那处。
      const lv = this.lvalue(n.items[1]);
      if (lv === null) return null;
      const up = h === 'pre-inc' || h === 'post-inc';
      /* 算符重载（第一百三十一刀）：主人的类型上写了这一族就调它。
         排在下面那三条（指针 / 整数 / real）**之前**，可其实撞不上 —— 类与结构体三条都不是，
         走到底只会得到那句"要整数 / real / 指针"。真正要写清的是**前缀与后缀在这儿有差别**：
         上面那句老注释说"语句位置上前缀与后缀没有差别"，对内建那三种成立（都不取值），对
         重载**不成立** —— 它们是两个函数（stdt_Iterator.jnc:44 那个 postfix 回的是旧值，
         副作用一样、回的值不一样）。所以后缀那一格先找 postfix 那个名字，没写才落回前缀
         （jancy 同：postfix 是可选的）；反过来只写了 postfix 却写成前缀，就明说。 */
      if (isClass(lv.type) || jncIsStruct(lv.type)) {
        const base = `${lv.type.name}$op$${up ? 'inc' : 'dec'}`;
        const post = h === 'post-inc' || h === 'post-dec';
        const full = post && this.opIncDec.has(`${base}$post`) ? `${base}$post` : base;
        if (this.opIncDec.has(full)) {
          const self = lv.kind === 'agg' ? lv.code : this.read(lv);
          return [`${pad}(expr (call ${full} ${self}))`];
        }
        if (!post && this.opIncDec.has(`${base}$post`)) {
          this.err(n, `${shown(lv.type.name)} 上只写了 'postfix operator ${up ? '++' : '--'}'`
            + `（前缀那一格没有）—— 写成 'x${up ? '++' : '--'}'`);
          return null;
        }
      }
      if (jncIsPtr(lv.type)) {
        return [`${pad}${this.store(lv, `(padd ${this.read(lv)} (int ${up ? '1' : '-1'}))`)}`];
      }
      if (isInt(lv.type)) {
        // `char c = 127; c++;` 是 -128（回卷），不是 128；`unsigned char c = 255; c++;` 是 0。
        const code = `(bin "${up ? '+' : '-'}" ${this.read(lv)} (int 1))`;
        return [`${pad}${this.store(lv, wrapTo(code, lv.type.w, lv.type.u))}`];
      }
      if (lv.type !== J_REAL) {
        this.err(n, `'${up ? '++' : '--'}' 要整数 / real / 指针，这里是 ${tyName(lv.type)}`);
        return null;
      }
      return [`${pad}${this.store(lv, `(bin "${up ? '+' : '-'}" ${this.read(lv)} (real 1.0))`)}`];
    }
    if (h === 'call') return this.callStmt(n, ind);
    // `try 调用;`（第五十八刀）：`try` 挡的是"抛"，不是"检查" —— 底下那次调用照旧发出去，
    // 只是出错时不往上传（exceptions.rst:40）。所以这一条就是"把挡板加一层再降底下那条"。
    if (h === 'try-expr') {
      this.shield++;
      const r = this.exprStmt(n.items[1], ind);
      this.shield--;
      return r;
    }
    // `? :` 当语句（第五十八刀）。语料里那 37 处的形状是 `m_state ? close() : try open();` ——
    // 两支都是**有副作用的调用**，取的值没人要。于是它就是一个 if：两支各按语句降。
    // 两支各开自己的传播落点 —— 那两句得落在**那一支里面**，抬到 if 之前就是无条件执行了。
    if (h === 'cond') {
      const c = this.cond(n.items[1]);
      if (c === null) return null;
      const a = this.ecScope(ind + 4, () => this.exprStmt(n.items[2], ind + 4));
      if (a === null) return null;
      const b = this.ecScope(ind + 4, () => this.exprStmt(n.items[3], ind + 4));
      if (b === null) return null;
      return [`${pad}(if ${c.code}`, `${pad}  (do`, ...a, `${pad}  )`, `${pad}  (do`, ...b, `${pad}  ))`];
    }
    this.nope(n, `这条表达式语句（'${h}'）没有副作用，jancy 那边也会拒`);
    return null;
  }

  /**
   * `<一格 reactor>.start()` / `.stop()` / `.restart()`（第八十五刀）。
   * 不是这个形状回 undefined（那时调用照旧往下走），算不出来回 null。
   *
   * 语料里数过：一格 reactor 上被叫到的**只有这三个**（start 59、stop 2、restart 2，别的 0），
   * 所以这一处不做"reactor 类"那一整套 —— 三个名字直接落到发出来的那两个函数上。
   */
  reactorCall(n, callee, args, pad) {
    if (!isList(callee) || head(callee) !== 'field' || !isAtom(callee.items[2])) return undefined;
    const meth = callee.items[2].value;
    if (meth !== 'start' && meth !== 'stop' && meth !== 'restart') return undefined;
    const ob = callee.items[1];
    if (!isList(ob)) return undefined;
    if (head(ob) === 'name' && isAtom(ob.items[1])) {
      const nm = ob.items[1].value;
      // 顶层那一格（`g_r.start()`）：按命名空间从里往外查。
      const top = this.resolve(nm, (k) => this.reactors.has(k) && this.reactors.get(k).cls === null);
      if (top !== null) return this.rctFire(n, this.reactors.get(top), meth, '', args, pad);
      // 方法体里裸写成员名（`m_uiReactor.start()`）：与裸写字段名同一条，`this` 由这儿补。
      if (this.rctNames.has(nm) && this.selfClass !== null) {
        const r = this.rctOf(this.selfClass, nm);
        if (r !== null) return this.rctFire(n, r, meth, ' (var $this)', args, pad);
      }
      return undefined;
    }
    // `obj.m_uiReactor.start()`：先按名字便宜地筛一次，再去求左边那个对象（与 mcRef 同一条）。
    if (head(ob) !== 'field' || !isAtom(ob.items[2]) || !this.rctNames.has(ob.items[2].value)) {
      return undefined;
    }
    const src = ob.items[1];
    let bv = null;
    if (isList(src) && LV_SHAPES.has(head(src))) {
      const o = this.lvalue(src);
      if (o === null) return null;
      bv = { code: this.read(o), type: o.type };
    } else {
      bv = this.expr(src, null);
      if (bv === null) return null;
    }
    if (!isClass(bv.type)) return undefined;
    const r = this.rctOf(bv.type.name, ob.items[2].value);
    if (r === null) return undefined;
    return this.rctFire(n, r, meth, ` ${bv.code}`, args, pad);
  }

  /** 这条继承链上有这一格 reactor 吗（与 findProp / findMethod 同一个形状）。 */
  rctOf(cls, nm) {
    for (const cur of this.baseWalk(cls)) {
      const r = this.reactors.get(`${cur}$${nm}`);
      if (r !== undefined) return r;
    }
    return null;
  }

  /** 那三个名字发出来的样子（第八十五刀）：restart 就是先 stop 再 start。 */
  rctFire(n, r, meth, self, args, pad) {
    if (args.length > 0) return this.err(n, `reactor 的 ${meth}() 不收实参`);
    if (meth === 'restart') {
      return [`${pad}(expr (call ${r.full}$stop${self}))`, `${pad}(expr (call ${r.full}$start${self}))`];
    }
    return [`${pad}(expr (call ${r.full}$${meth}${self}))`];
  }

  /** 调用当语句。printf 在这儿拆开；别的走普通调用，返回值丢掉。 */
  callStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const callee = n.items[1];
    const args = this.flat(n.items[2]);
    if (isList(callee) && head(callee) === 'name' && callee.items[1].value === 'printf') {
      return this.printf(n, args, ind);
    }
    /* `print(s)`（第九十八刀）：jancy 那边它是 `jnc_std` 那格宿主库里的一个函数
       （jnc_std_StdLib.cpp:891 的 `JNC_MAP_FUNCTION("print", jnc::std::print)`），
       语义是"把这一格字符串**原样**写出去、不添换行、也**不当格式串解释**"。方言里现成的
       就是 `(write …)`，printf 那条路上 `$"…"` 走的也是它。
       只在这个名字**没有别的定义**时才接 —— 语料里有人自己写 `print`（那时按自己那个算）。 */
    if (isList(callee) && head(callee) === 'name' && callee.items[1].value === 'print'
      && this.lookupRef('print') === null && this.resolve('print', (k) => this.fns.has(k)) === null) {
      return this.printCall(n, args, ind);
    }
    /* `s.m_uiReactor.start()` / `g_r.start()`（第八十五刀）：一格 reactor 上能叫的只有
       start / stop / restart 三个（语料里数过：59 / 2 / 2，别的一个都没有）。 */
    const rc = this.reactorCall(n, callee, args, pad);
    if (rc !== undefined) return rc;
    /* `m_onChanged();` / `bindingof(p)();`（第七十三刀）：叫一格事件不是"调一个函数"，是
     * 照单子从头到尾叫一遍（jancy 那边 `m(…)` 走的是多播类的 `call` 方法，
     * jnc_ct_TypeMgr.cpp:962-975 那张表里的 `type->m_callOperator`）。 */
    const mc = this.mcRef(callee);
    if (mc === null) return null;
    if (mc !== undefined) {
      const want = mc.type.params;
      if (args.length !== want.length) {
        this.err(n, `这格事件要 ${want.length} 个实参，给了 ${args.length} 个`);
        return null;
      }
      const vs = [];
      for (let i = 0; i < args.length; i++) {
        const v = this.expr(args[i], want[i]);
        if (v === null) return null;
        vs.push(isInt(want[i]) && isInt(v.type) ? intConv(v, want[i]) : v);
      }
      return [`${pad}(expr (call ${this.mcFire(mc.type)} ${mc.code}`
        + `${vs.map((v) => ` ${v.code}`).join('')}))`];
    }
    const v = this.expr(n, null);
    if (v === null) return null;
    // errorcode 的调用在这儿已经被抬成了"一格临时 + 一句检查"（第五十八刀），那两行就是这条
    // 语句的全部 —— 再发一句 `(expr (var $e0))` 是一条没有副作用的语句。
    if (v.hoisted === true) return [];
    return [`${pad}(expr ${v.code})`];
  }

  /**
   * 折不动的那一格是什么（第五十四刀）。诊断要说得准 —— 三种各是一格自己的边界：
   *
   *   - 相邻拼接里的格式化字面量：`"a" $"b"` 那种。jancy 那边这一串整块落到 GC 堆上
   *     （literals.rst:90），这一层的拼接只管**不含**格式化字面量的那一半 —— 第六十四刀
   *     把单独的 `$"…"` 接上了，混着拼的那一格仍旧是自己一刀（整份语料里只有 1 处）。
   *   - 二进制字面量 `0x"61 62"`：它定义的是**逐字节**的一块 const char（literals.rst:33），
   *     而这一层一格整数占 64 位（ADR-0016 决策二那处刻意留下的差别）—— 要它得先有"一格
   *     一个字节"的存储宽度，与 `sizeof` 同一格。
   *   - `__FILE__` / `__DIR__` / `__FUNC__` / `__LINE__` / `__DATE__` / `__TIME__`：词法层
   *     的预定义字面量宏（Lexer.rl 里就是 LITERAL）；值要靠编译期环境，后两个还不可复现。
   */
  litWhy(n) {
    if (isList(n) && head(n) === 'fmt') {
      return '格式化字面量（jancy 那边这一串整块落到 GC 堆上，literals.rst:90）';
    }
    if (isList(n) && head(n) === 'concat') {
      return this.litWhy(litFold(n.items[1]) === null ? n.items[1] : n.items[2]);
    }
    const v = isAtom(n) ? String(n.value) : null;
    if (v !== null) {
      if (/^0[xXdD]"/.test(v)) return '二进制字面量（要"一格一个字节"的存储宽度，与 sizeof 同一格）';
      if (/^r"/.test(v)) return '原始字面量 `r"…"`（里面的转义不处理，词法要另一格）';
      if (/^__[A-Z]+__$/.test(v)) return `预定义字面量宏 '${v}'（值要靠编译期环境）`;
    }
    return '这一格';
  }

  /**
   * `printf(格式串, 实参…)` -> 若干条 `print`。
   *
   * 方言的 `print` 自带换行，所以按 `\n` 切开、每段一条。末尾不带换行的那段发 `(write …)`。
   * 收的转换是 `%d` / `%i` / `%f` / `%s` / `%c` / `%x` / `%X` / `%o` / `%%`，宽度与精度
   * 收十进制常量也收 `*` / `.*`（第二十七刀）。
   */
  /**
   * `print(s)`（第九十八刀）：把一格字符串**原样**写出去。
   *
   * jancy 那边它是 `jnc_std` 宿主库里的一个函数（jnc_std_StdLib.cpp:891），签名
   * `void print(string_t text)` —— 不添换行、也**不**把内容当格式串再解释一遍。方言里现成的
   * 就是 `(write …)`（printf 那条路上 `$"…"` 走的也是它），所以这一格不用长出任何新东西。
   *
   * 与 printf 的差别正是"不再解释一遍"：`print("100%")` 印出来就是 `100%`。
   */
  printCall(n, args, ind) {
    const pad = ' '.repeat(ind);
    if (args.length !== 1) {
      this.err(n, `print 要 1 个实参（一格字符串），这里给了 ${args.length} 个`);
      return null;
    }
    // 格式化字面量走 printf 那条现成的路：它自己把值排好，结果就是一格字符串。
    const fl = fmtNode(args[0]);
    if (fl !== null) {
      const v = this.fmtLit(args[0], fl.tok, fl.args === null ? [] : this.flat(fl.args));
      if (v === null) return null;
      return [`${pad}(write ${v.code})`];
    }
    const v = this.expr(args[0], J_STR);
    if (v === null) return null;
    if (v.type !== J_STR && !(v.type !== undefined && v.type.k === 'string')) {
      this.err(args[0], `print 的实参要是一格字符串，这里是 ${tyName(v.type)}`);
      return null;
    }
    return [`${pad}(write ${v.code})`];
  }

  printf(n, args, ind) {
    const pad = ' '.repeat(ind);
    if (args.length === 0) { this.err(n, 'printf 至少要一个格式串'); return null; }
    // `printf($"…")`（第六十四刀）：格式化字面量自己就把值排好了，结果是**一格字符串** ——
    // 这一句就是把它写出去（`write` 不添换行，与 printf 一致）。
    //
    // 只有一处不能这么办：结果里还留着裸的 `%`。jancy 那边 printf 会把它**再解释一遍**
    // （字面量产出的是 char*，printf 是真变参函数），而这一层没有运行期的格式解释 ——
    // 所以那种写法明说不收，而不是悄悄少印一个 `%`。
    const fl = fmtNode(args[0]);
    if (fl !== null && args.length > 1) {
      this.err(n, '格式化字面量自己带实参表（`$"…"(a, b)`），printf 这儿不能再给别的实参');
      return null;
    }
    if (fl !== null && args.length === 1) {
      const v = this.fmtLit(args[0], fl.tok, fl.args === null ? [] : this.flat(fl.args));
      if (v === null) return null;
      if (v.rawPct === true) {
        this.nope(args[0], 'printf 的实参是带裸 `%` 的格式化字面量'
          + '（jancy 那儿这个 `%` 还要被 printf 再解释一遍，要它得有运行期的格式解释）');
        return null;
      }
      return [`${pad}(write ${v.code})`];
    }
    // 字面量是词法层的 `string` 节点（`{kind:'string', value, raw}`），不是 atom；相邻的几个
    // 拼在一起是 `(concat …)`，编译期折平（第五十四刀）—— 折出来的仍旧是一格字面量。
    const fmt = litFold(args[0]);
    if (fmt === null) {
      const why = this.litWhy(args[0]);
      this.nope(args[0], why === '这一格'
        ? 'printf 的格式串不是字面量（要它就得在运行期解释格式）'
        : `printf 的格式串是${why}`);
      return null;
    }
    const vals = [];
    for (let i = 1; i < args.length; i++) {
      const v = this.expr(args[i], null);
      if (v === null) return null;
      vals.push(v);
    }
    return this.fmtRun(n, fmt, vals, args.slice(1), pad, [], 'stmt');
  }

  /**
   * 一个 C 口径的格式串 + 一串已经算好的值 -> 输出（第六十四刀把它从 printf 里分出来）。
   *
   *   - `mode === 'stmt'`：按 `\n` 切开、每段一条 `print`（它自带换行），末段发 `(write …)`。
   *     回的是那几行语句。printf 走这条。
   *   - `mode === 'str'`：不切换行，整条拼成**一格字符串的代码**回去。格式化字面量
   *     `$"…"` 走这条 —— 它产出的是一格值（literals.rst:62），不是一次输出。
   *
   * 分出来的理由是"算法只该有一处家"：两条路上 `%08.3f` 该长什么样必须一个字不差。
   * 第六十一刀那次 `q /= three` 的教训就是同一个形状 —— 两处各写一遍，其中一处写错。
   *
   * `nodes[k]` 是第 k 个值对应的**源码节点**（诊断要指着它）。
   */
  fmtRun(n, fmt, vals, nodes, pad, out, mode) {
    // 一段一段攒：`pieces` 是当前这一段的若干块（字符串常量与 (tostr …)）。
    // 'stmt' 那条路遇到 `\n` 就发一条 `print`（它自带换行）；末尾那段没有换行时发 `(write …)`
    // ——方言这一刀刚长出 write，所以"不以 \n 收尾的格式串"不再是边界（ADR-0016 第四刀）。
    // 'str' 那条路一个都不切：换行就是串里的一个字符。
    let pieces = [];
    let ai = 0;
    let lit = '';
    const flushLit = () => { if (lit !== '') { pieces.push(`(str ${JSON.stringify(lit)})`); lit = ''; } };
    const flush = (nl) => {
      flushLit();
      if (pieces.length === 0) { if (nl) out.push(`${pad}(print (str ""))`); pieces = []; return; }
      let code = pieces[0];
      for (let k = 1; k < pieces.length; k++) code = `(bin "+" ${code} ${pieces[k]})`;
      out.push(`${pad}(${nl ? 'print' : 'write'} ${code})`);
      pieces = [];
    };
    for (let i = 0; i < fmt.length; i++) {
      const c = fmt[i];
      if (c === '\n' && mode === 'stmt') { flush(true); continue; }
      if (c !== '%') { lit += c; continue; }
      // 转换说明：`%` [标志] [宽度] [`.` 精度] 转换字符。五个标志都收了：`-`（左对齐）、
      // `0`（补零）、`+` 与空格（符号，第二十九刀）、`#`（另一种形式，同一刀）；宽度与精度
      // 收十进制常量，也收 `*` / `.*`（从实参来 —— 第二十七刀）。
      let j = i + 1;
      let left = false;
      let zero = false;
      let plus = false;
      let space = false;
      let alt = false;
      for (;; j++) {
        if (fmt[j] === '-') { left = true; continue; }
        if (fmt[j] === '0') { zero = true; continue; }
        if (fmt[j] === '+') { plus = true; continue; }
        if (fmt[j] === ' ') { space = true; continue; }
        if (fmt[j] === '#') { alt = true; continue; }
        break;
      }
      // 两个都写时 `+` 赢（C99 7.19.6.1 的 flags 那一段，clang 也直说"flag ' ' is ignored
      // when flag '+' is present"）。
      if (plus) space = false;
      let width = 0;
      let wStar = false;
      if (fmt[j] === '*') { wStar = true; j++; } else {
        while (fmt[j] >= '0' && fmt[j] <= '9') { width = width * 10 + (fmt[j].charCodeAt(0) - 48); j++; }
      }
      // 精度 `.N`（ADR-0016 第八刀）。`.` 后面不写数字在 C 里是 0（`%.f` = `%.0f`）。
      let prec = -1;
      let pStar = false;
      if (fmt[j] === '.') {
        j++;
        prec = 0;
        if (fmt[j] === '*') { pStar = true; j++; } else {
          while (fmt[j] >= '0' && fmt[j] <= '9') { prec = prec * 10 + (fmt[j].charCodeAt(0) - 48); j++; }
        }
      }
      // 长度修饰（第四十四刀）。C 里它定的是"实参是哪一格整数"；这一层没有 C 的变参提升，
      // 所以它定的是**这次转换按多少位读** —— 与不写修饰时"位数从类型上取"是同一个约定。
      // `hh` = 8、`h` = 16、`l` / `ll` = 64（jancy 的 long 就是 64 位，macOS 的 C 同）。
      let mod = '';
      if (fmt[j] === 'h' || fmt[j] === 'l') {
        mod = fmt[j];
        j++;
        if (fmt[j] === mod) { mod += mod; j++; }
      } else if (fmt[j] === 'z' || fmt[j] === 'j' || fmt[j] === 't' || fmt[j] === 'L') {
        mod = fmt[j];
        j++;
      }
      const spec = fmt[j];
      i = j;
      if (spec === '%') { lit += '%'; continue; }
      /* `%p`（第二百三十八刀把话说准）：榜上"printf 的转换 '…'"那一行**全是它**（量出来 59 处、
         逐份榜上 15 对），可它与别的没收下的转换符**不是同一种拒** —— 那几个是"还没长出来"，
         `%p` 是**刻意不做**，而理由早就写在 `bad/printf-conv-p` 那道墙的注上（第三十二刀）：
         这几条腿上指针是**两套实现**（run / interp 那几条是 arena 模拟，地址是块内偏移；
         run-c / run-llvm 是真指针），裸地址在两边根本不是同一个数，所以"印出来"这件事没有一个
         各条腿都对的答案；而"不许观测裸地址"这条纪律正是那两套实现能一直对得上的原因。
         先前诊断只说了个转换符的名字，把这条**刻意**的界说成了像"还没做"—— 这一刀把墙注上
         那句话搬进诊断里。 */
      if (spec === 'p') {
        this.nope(n, 'printf 的 `%p`（印裸地址）—— 这一层**刻意**不给：这几条腿上指针是两套'
          + '实现（run / interp 那几条是 arena 模拟，地址是块内偏移；run-c / run-llvm 是真'
          + '指针），同一格指针印出来不是同一个数，而"不许观测裸地址"正是这两套能一直对得上的'
          + '原因。能观测的是 `p == null` / `*p` / `p[i]` / `p - q`');
        return null;
      }
      if (spec !== 'd' && spec !== 'i' && spec !== 'f' && spec !== 's' && spec !== 'c'
        && spec !== 'x' && spec !== 'X' && spec !== 'o' && spec !== 'e' && spec !== 'E'
        && spec !== 'g' && spec !== 'G' && spec !== 'u') {
        this.nope(n, `printf 的转换 '%${spec === undefined ? '' : spec}'`);
        return null;
      }
      if (mod !== '') {
        const modInt = spec === 'd' || spec === 'i' || spec === 'u'
          || spec === 'x' || spec === 'X' || spec === 'o';
        // `%lf` 在 C 里就是 `%f`（`l` 对浮点无效，被忽略）。别的组合各是一条边界：
        // `z` / `j` / `t` 的宽度是平台 typedef 定的（这一层没有那一格）、`L` 是 long double、
        // `ll` 配浮点在 C 里本身就没定义、`h` / `l` 配 `%c` / `%s` 是宽字符那一族。
        const sized = mod === 'hh' || mod === 'h' || mod === 'l' || mod === 'll';
        const floatL = mod === 'l' && (spec === 'f' || spec === 'e' || spec === 'E'
          || spec === 'g' || spec === 'G');
        if (!sized || !(modInt || floatL)) {
          this.nope(n, `printf 的长度修饰 '%${mod}${spec}'`);
          return null;
        }
      }
      const modW = mod === 'hh' ? 8 : (mod === 'h' ? 16 : (mod === 'l' || mod === 'll' ? 64 : 0));
      if (prec > 30) { this.err(n, `printf 的精度最多 30 位，这里是 ${prec}`); return null; }
      // `*` / `.*` 的实参按 C 的顺序取：宽度、精度、值（第二十七刀）。两者都要读好几次
      //（判正负、算要补几个），所以先落成局部量。
      let wVar = null;
      if (wStar) {
        wVar = this.starArg(n, nodes, vals, ai, '宽度', pad, out);
        if (wVar === null) return null;
        ai++;
      }
      let pCode = prec < 0 ? null : `(int ${prec})`;
      if (pStar) {
        pCode = this.starArg(n, nodes, vals, ai, '精度', pad, out);
        if (pCode === null) return null;
        ai++;
      }
      // 宽度 1 平时不用补（一段文本至少一个字符），可精度**能把它变成空串**
      //（`%.0d` 印 0 是零个字符），那时宽度 1 也要补一格空格。
      const wCode = wStar ? wVar
        : (width > 1 || (width === 1 && pCode !== null) ? `(int ${width})` : null);
      if (ai >= vals.length) { this.err(n, 'printf 的实参比格式串里的转换少'); return null; }
      // 枚举在这儿就落到基整数上（第三十九刀）：printf 是变参，jancy 那边这一次转换也是隐式的，
      // 于是 `%d` / `%u` / `%x` 那几条一个字都不用改。
      const v = jncIsEnum(vals[ai].type) ? { code: vals[ai].code, type: vals[ai].type.base } : vals[ai];
      // 这条转换对应的**实参节点**（诊断要指着它）。
      const argNode = nodes[ai];
      ai++;
      let piece = null;
      // `%c`：一个码位 -> 一个字符。方言的 `(chr E)`（另外四条腿早就有它）。
      if (spec === 'c') {
        if (!isInt(v.type)) {
          this.err(argNode, `'%c' 要整数（jancy 的 char 就是 8 位整数），这里是 ${tyName(v.type)}`);
          return null;
        }
        piece = `(chr ${v.code})`;
      } else if ((spec === 'd' || spec === 'i') && v.type === J_BOOL) {
        // jancy 的 `bool` 底下是 int8，`printf("%d", b)` 印 1 / 0（C 的样子）——
        // 用 `sel` 变成 1 / 0，而不是 `(tostr b)`（那会印 true / false）。
        piece = `(tostr (sel ${v.code} (int 1) (int 0)))`;
      } else if ((spec === 'd' || spec === 'i') && isInt(v.type)) {
        // 四种位宽都收：值已经是规范形（符号扩展过的），照印就是 C 的样子。
        // 无符号那一格上 `%d` 是"按**有符号**读"（第三十三刀）——
        // `printf("%d", (unsigned)4294967240)` 在 C 里印 -56，所以先转到同宽的有符号格。
        // 位数从**类型**上取，与 `%x` 那一条同一个约定（见 07-hex.jnc）；写了长度修饰就听它的
        // （第四十四刀）——`%hhd` 印 300 是 44，与 C 逐字节相同。
        piece = `(tostr ${intConv(v, mkInt(modW > 0 ? modW : promo(v.type.w), false)).code})`;
      } else if (spec === 'x' || spec === 'X' || spec === 'o' || spec === 'u') {
        // `%x` / `%X` / `%o`（ADR-0016 第七刀）与 `%u`（第三十二刀）。C 把实参当
        // **unsigned** 读，而"多少位"是**默认实参提升之后**那一格 ——
        // `printf("%x", (char)-56)` 印 `ffffffc8`（提到 int 之后当 32 位无符号读），
        // 不是 `c8`；`printf("%u", (char)-56)` 同一条，印 `4294967240`。所以这儿先掩到
        // promo(位宽) 位。64 位不用掩：`(sbase …)` 本来就把它的实参当无符号 64 位读。
        //
        // 第三十二刀因此一个字的方言都没长：`%u` 就是这条路子上进制换成 10。
        let code = null;
        let w = 32;
        if (v.type === J_BOOL) code = `(sel ${v.code} (int 1) (int 0))`;
        else if (isInt(v.type)) { code = v.code; w = promo(v.type.w); } else {
          this.err(argNode, `'%${spec}' 要整数，这里是 ${tyName(v.type)}`);
          return null;
        }
        if (modW > 0) w = modW;   // 长度修饰说了算（第四十四刀）
        if (w < 64) code = `(bin "&" ${code} (int ${(1n << BigInt(w)) - 1n}))`;
        const base = spec === 'o' ? 8 : (spec === 'u' ? 10 : 16);
        piece = `(sbase ${code} (int ${base}))`;
        // 大写走 `(supper …)`：`sbase` 只给小写，这条是它们分工的那一刀。
        if (spec === 'X') piece = `(supper ${piece})`;
      } else if (spec === 'f') {
        // `%f` 是 C 的 `%.6f`（**默认精度 6**），不是"把这个数印出来" —— 原先这一格降成
        // `(tostr …)`（也就是 `%.6g`），于是 `printf("%f", 1.5)` 印 `1.5` 而 C 印
        // `1.500000`。那是一处静默的差别，第八刀把它补上：`(sfix E N)`，N 默认 6。
        // `.*` 的实参是负数时"等于没写精度"，也就是回到 6（第二十七刀）。
        if (v.type !== J_REAL) {
          this.err(argNode, `'%f' 要 double，这里是 ${tyName(v.type)}（整数先写 (double)x）`);
          return null;
        }
        // `.*` 也收了（第二十八刀让方言的 `(sfix E N)` 认一段运行期的 N）。C 里精度实参是
        // 负数等于"没写精度"，也就是回到 6。
        const nf = pCode === null ? '(int 6)'
          : (pStar ? `(sel (bin "<" ${pCode} (int 0)) (int 6) ${pCode})` : pCode);
        piece = `(sfix ${v.code} ${nf})`;
      } else if (spec === 'e' || spec === 'E') {
        // `%e` / `%E` 是 C 的 `%.6e`（第三十刀）—— 方言新长的 `(ssci E N)`。默认精度、
        // `.*` 是负数回到 6 这两条与 `%f` 一字不差（同一段 C 的规则）。
        if (v.type !== J_REAL) {
          this.err(argNode, `'%${spec}' 要 double，这里是 ${tyName(v.type)}（整数先写 (double)x）`);
          return null;
        }
        const nf = pCode === null ? '(int 6)'
          : (pStar ? `(sel (bin "<" ${pCode} (int 0)) (int 6) ${pCode})` : pCode);
        piece = `(ssci ${v.code} ${nf})`;
        // `#` 在这一格是"小数点一定印出来"，而点要插在 `e` **前面**（`%#.0e` 的 1.5 是
        // `2.e+00`）—— 与 `%f` 的"补在末尾"不是同一件事，所以在这儿做、不在下面那一处。
        // nan / inf 那两支没有 `e`，先挡掉：`ssub` 越界是运行期错误。
        if (alt) {
          const t = this.spill(piece, pad, out);
          const ix = this.spill(`(sfind ${t} (str "e"))`, pad, out, 'int');
          const ins = `(bin "+" (ssub ${t} (int 0) ${ix})`
            + ` (bin "+" (str ".") (ssub ${t} ${ix} (bin "-" (slen ${t}) ${ix}))))`;
          piece = `(sel (bin "<" ${ix} (int 0)) ${t}`
            + ` (sel (bin "<" (sfind ${t} (str ".")) (int 0)) ${ins} ${t}))`;
        }
        // 大写走 `(supper …)`：与 `%X` 同一条分工（`ssci` 只给小写的 `e`）
        if (spec === 'E') piece = `(supper ${piece})`;
      } else if (spec === 'g' || spec === 'G') {
        // `%g` / `%G`（第三十一刀）—— 方言的 `(sgen E N)` / `(sgenk E N)`。这一格的 `#`
        // 不在这一层做：它改的是"去不去尾随零"，而那是排版本身的一部分，所以是两个算子。
        if (v.type !== J_REAL) {
          this.err(argNode, `'%${spec}' 要 double，这里是 ${tyName(v.type)}（整数先写 (double)x）`);
          return null;
        }
        const nf = pCode === null ? '(int 6)'
          : (pStar ? `(sel (bin "<" ${pCode} (int 0)) (int 6) ${pCode})` : pCode);
        piece = `(${alt ? 'sgenk' : 'sgen'} ${v.code} ${nf})`;
        if (spec === 'G') piece = `(supper ${piece})`;
      } else {
        // 到这儿只剩 `%s`（`%d` / `%i` 在整数与 bool 上都在上面接完了，剩下的是类型不对）
        const want = spec === 's' ? J_STR : J_I32;
        if (!this.assignOk(v.type, want)) {
          this.err(argNode, `'%${spec}' 要 ${tyName(want)}，这里是 ${tyName(v.type)}`);
          return null;
        }
        piece = v.type === J_STR ? v.code : `(tostr ${v.code})`;
      }
      flushLit();
      const intSpec = spec === 'd' || spec === 'i' || spec === 'x' || spec === 'X'
        || spec === 'o' || spec === 'u';
      const hexConv = spec === 'x' || spec === 'X';
      // 带符号的转换（`+` / 空格 / 摘符号那一路认的就是这一族）：浮点那三格都在里面
      const signed = spec === 'd' || spec === 'i' || spec === 'f'
        || spec === 'e' || spec === 'E' || spec === 'g' || spec === 'G';
      // 三处 C 的**未定义行为**，各有 clang 的一句话，没有可对的答案，所以拒：
      // `%c` 上的精度、不是有符号转换上的 `+` / 空格、`%d` / `%s` / `%c` 上的 `#`。
      if (pCode !== null && spec === 'c') {
        this.nope(n, "`%c` 上的精度（C 里它是未定义行为，没有可对的答案）");
        return null;
      }
      if ((plus || space) && !signed) {
        this.nope(n, `'%${spec}' 上的 '${plus ? '+' : ' '}' 标志（C 里它是未定义行为）`);
        return null;
      }
      if (alt && !hexConv && spec !== 'o' && spec !== 'f' && spec !== 'e' && spec !== 'E'
        && spec !== 'g' && spec !== 'G') {
        this.nope(n, `'%${spec}' 上的 '#' 标志（C 里它是未定义行为）`);
        return null;
      }
      // C 里整数上一写精度，`0` 标志就作废（7.19.6.1 的 flags 那一段）；`.*` 的实参是负数时
      // 等于精度没写，那时 `0` 又活着 —— 那一格的判断落到运行期（见 padTo 的第三种 zero）。
      let zeroF = zero && !left && spec !== 's' && spec !== 'c';
      if (intSpec && pCode !== null) zeroF = zeroF && pStar ? `(bin "<" ${pCode} (int 0))` : false;
      // **前缀**（第二十九刀）：符号（`-` / `+` / 空格）与 `#` 的 `0x` / `0X`。它排在补零
      // **外面**，所以从这儿起分成两段拿着（见 padTo）。把符号摘出来是有代价的（一次 spill
      // 加两个 sel），所以只在真的用得上时摘：写了 `+` / 空格、要补零、或整数上写了精度。
      let pfx = null;
      if (signed && (plus || space || zeroF !== false || (intSpec && pCode !== null))) {
        const t = this.spill(piece, pad, out);
        const neg = `(bin "==" (ssub ${t} (int 0) (int 1)) (str "-"))`;
        const other = plus ? '+' : (space ? ' ' : '');
        pfx = `(sel ${neg} (str "-") (str "${other}"))`;
        piece = `(sel ${neg} (ssub ${t} (int 1) (bin "-" (slen ${t}) (int 1))) ${t})`;
      }
      // `#` 在 `%x` / `%X` 上是 `0x` / `0X`，**值为 0 时不加**（量过：`%#x` 印 0 还是 `0`）。
      // 判的是**补零之前**那几位 —— 补过之后 "0000" 就看不出值是不是 0 了。
      if (alt && hexConv) {
        const t = this.spill(piece, pad, out);
        pfx = `(sel (bin "==" ${t} (str "0")) (str "") (str "${spec === 'x' ? '0x' : '0X'}"))`;
        piece = t;
      }
      if (pCode !== null && (intSpec || spec === 's')) {
        const t = this.spill(piece, pad, out);
        piece = intSpec ? this.precInt(t, pCode) : this.precStr(t, pCode);
      }
      // `#` 在 `%o` 上是"逼出一个前导 0"（C99：把精度提到让第一位是 0），所以它在精度
      // **之后**：`%#.4o` 印 8 是 `0010`（已经以 0 开头，不再加），`%#o` 印 8 是 `010`。
      // 空串那一支（`%#.0o` 印 0）要先挡掉 —— `(ssub …)` 越界是运行期错误。
      if (alt && spec === 'o') {
        const t = this.spill(piece, pad, out);
        piece = `(sel (bin "==" (slen ${t}) (int 0)) (str "0")`
          + ` (sel (bin "==" (ssub ${t} (int 0) (int 1)) (str "0")) ${t} (bin "+" (str "0") ${t})))`;
      }
      // `#` 在 `%f` 上是"小数点一定印出来"（`%#.0f` 印 1 是 `1.`）
      if (alt && spec === 'f') {
        const t = this.spill(piece, pad, out);
        piece = `(sel (bin "<" (sfind ${t} (str ".")) (int 0)) (bin "+" ${t} (str ".")) ${t})`;
      }
      if (wCode !== null) {
        // 宽度那一支要**多次读**这两段（量长度、再拼上去），所以先落成局部量。
        // 直接内联的话 `%5d` 里的 `(call f x)` 会被算两遍（补零那一支是四遍）。
        // 落在这儿而不是别处：jancy 与 C 一样在调用前算完所有实参，先算一步更贴。
        const t = this.spill(piece, pad, out);
        const p = pfx === null ? null : this.spill(pfx, pad, out);
        if (!wStar) pieces.push(this.padTo(p, t, wCode, left, zeroF));
        else {
          // `%*d` 的宽度是负数时"等于写了 `-` 标志、宽度取它的绝对值"（C99 7.19.6.1）。
          const aw = `(sel (bin "<" ${wCode} (int 0)) (un "-" ${wCode}) ${wCode})`;
          pieces.push(`(sel (bin "<" ${wCode} (int 0)) ${this.padTo(p, t, aw, true, false)}`
            + ` ${this.padTo(p, t, aw, left, zeroF)})`);
        }
      } else pieces.push(pfx === null ? piece : `(bin "+" ${pfx} ${piece})`);
    }
    if (mode === 'str') {
      flushLit();
      if (ai !== vals.length) { this.err(n, 'printf 的实参比格式串里的转换多'); return null; }
      if (pieces.length === 0) return '(str "")';
      let code = pieces[0];
      // 循环变量刻意不叫 `k`：这个函数里的闭包（flush）自己有一个 `k`，自举那一层的检查
      // 按名字看，同名会被判成"被闭包捕获的循环变量"。
      for (let q = 1; q < pieces.length; q++) code = `(bin "+" ${code} ${pieces[q]})`;
      return code;
    }
    flush(false);   // 末尾没换行的那一段走 write
    if (ai !== vals.length) { this.err(n, 'printf 的实参比格式串里的转换多'); return null; }
    return out;
  }

  /**
   * 格式化字面量 `$"…"`（第六十四刀）-> 一格字符串的代码。第五十四刀记下的那条边界还上了。
   *
   * jancy 的形（literals.rst:62-88；词法 Lexer.rl:128-142；语法 Expr.llk:965-993）：
   *
   *   - `$id`：一格**内嵌**的表达式，不占实参表的位置（`site->m_index == -1`）
   *   - `$(expr)` / `$(expr; spec)`：同上，里头是一整条表达式 —— 这一层再解析一遍（parseExpr）
   *   - `%N` / `%(N; spec)`：实参表里第 N 个（**1 起**）
   *   - 光写一个 `%spec`：也占一个实参位，序号是"上一个用过的 + 1"
   *     （`site->m_index = ++literal->m_fmtIndex`，Parser.cpp:3496）
   *   - 没写 spec 时按**静态类型**挑（Parser.cpp:3670-3691）：整数 ≤4 字节 `%d` / `%u`、
   *     64 位 `%lld` / `%llu`、浮点 `%f`、字符串 `%s`。写了 spec 但末尾不是字母时把默认那个
   *     字母补上（`$(x; 8)` -> `%8d`；prepareFormatString，CoreLib.cpp:702-723）
   *   - 实参表里有谁没被用到是**错**（Parser.cpp:3583-3587）
   *
   * 拼出来的是一个 C 口径的格式串加一串值，交给 fmtRun 的 'str' 那条路 —— 于是 `%08.3f`
   * 该长什么样与 printf 是同一份实现，不是第二份。
   */
  fmtLit(node, tok, argNodes) {
    if (this.parseExpr === null) return this.nope(node, '格式化字面量 `$"…"`（这一趟没有再解析一遍的入口）');
    const raw = String(tok.value);
    const inner = raw.slice(2, raw.length - 1);
    const base = tok.span.start + 2;   // inner[0] 在文件里的偏移
    const file = tok.span.file;
    const argVals = argNodes.map(() => null);
    const used = argNodes.map(() => false);
    // 实参按需降级（用两次的 `%(1;x)` 只算一次），并记下谁被用过
    const argAt = (k) => {
      if (k >= argNodes.length) {
        return this.err(node, `格式化字面量里写了 %${k + 1}，可它的实参表只有 ${argNodes.length} 个`);
      }
      if (argVals[k] === null) {
        const v = this.expr(argNodes[k], null);
        if (v === null) return null;
        argVals[k] = v;
      }
      used[k] = true;
      return argVals[k];
    };
    let cfmt = '';
    const vals = [];
    const nodes = [];
    let seq = 0;   // jancy 的 m_fmtIndex：0 表示还没用过任何一个
    let bad = false;
    // 文本里的 `%` 在 C 口径的格式串里要写成 `%%`。记一笔"有过裸的 `%`"——
    // `printf($"…")` 那条路要用它（printf 会把结果再解释一遍格式）。
    let rawPct = false;
    const rawText = (s) => {
      if (s.includes('%')) rawPct = true;
      return s.replace(/%/g, '%%');
    };
    // 一格注入：把 spec 与"这个类型默认那个字母"并起来，值与节点排进去
    const site = (v, spec, nd) => {
      if (v === null) { bad = true; return; }
      const d = fmtDefault(v.type);
      if (d === null) {
        // char* / char[] 在 jancy 那边**是**印得出来的（appendFmtLiteral_p 按 NUL 读一段
        // 内存，CoreLib.cpp:790-810）；这一层的 `%s` 只认 string，所以那一格另有出处。
        this.nope(node, jncIsPtr(v.type)
          ? `格式化字面量里的 ${tyName(v.type)}（jancy 走 appendFmtLiteral_p 按 NUL 读一段内存，`
            + '这一层的 %s 只认 string）'
          : `格式化字面量里印不出 ${tyName(v.type)}（jancy 那边这也是一句 `
            + "\"don't know how to format\"，Parser.cpp:3689）");
        bad = true;
        return;
      }
      if (spec !== null && /B$/.test(spec)) {
        this.nope(node, '格式化字面量的 `B` 转换（jancy 那边是逐字节的二进制排版，'
          + '与二进制字面量同一格）');
        bad = true;
        return;
      }
      cfmt += fmtMergeSpec(spec, d);
      vals.push(jncIsEnum(v.type) ? { code: v.code, type: v.type.base } : v);
      nodes.push(nd);
    };
    // `$(…)` / `$id` 里那一段源码 -> 一格值。位置按原文算，所以里头报错指的是真地方。
    const inlineVal = (src, off) => {
      const t = this.parseExpr(file, src, base + off);
      if (t === null) { this.err(node, `格式化字面量里这一段解析不了：'${src}'`); return null; }
      return this.expr(t, null);
    };
    let i = 0;
    while (i < inner.length && !bad) {
      const c = inner[i];
      // 转义照普通字面量那一套（lex.js:282-311 是同一张表）：\t \n \r \xHH，别的脱掉反斜杠
      if (c === '\\') {
        const e = inner[i + 1];
        i += 2;
        if (e === 't') { cfmt += '\t'; continue; }
        if (e === 'n') { cfmt += '\n'; continue; }
        if (e === 'r') { cfmt += '\r'; continue; }
        if (e === 'x') {
          const cc = Number.parseInt(inner.slice(i, i + 2), 16);
          if (Number.isInteger(cc)) { cfmt += rawText(String.fromCharCode(cc)); i += 2; continue; }
          cfmt += 'x';
          continue;
        }
        cfmt += e === undefined ? '' : rawText(e);
        continue;
      }
      if (c === '$') {
        const rest = inner.slice(i + 1);
        if (rest.startsWith('!')) {
          this.nope(node, '格式化字面量里的 `$!`（要 std.getLastError 那一套）');
          bad = true;
          break;
        }
        const id = rest.match(/^[A-Za-z_]\w*/);
        if (id !== null) {
          site(inlineVal(id[0], i + 1), null, node);
          i += 1 + id[0].length;
          continue;
        }
        if (rest.startsWith('(')) {
          const sp = fmtSplitSite(inner, i + 1);
          if (sp === null) {
            this.err(node, '格式化字面量里的 `$(` 没有配对的 `)`');
            bad = true;
            break;
          }
          site(inlineVal(sp.body, i + 2), sp.spec, node);
          i = sp.end;
          continue;
        }
        if (/^\d/.test(rest)) {
          this.nope(node, '格式化字面量里的 `$1`（正则捕获组，要 regex switch 那一套）');
          bad = true;
          break;
        }
        cfmt += '$';
        i++;
        continue;
      }
      if (c === '%') {
        const rest = inner.slice(i + 1);
        if (rest.startsWith('(')) {
          const sp = fmtSplitSite(inner, i + 1);
          if (sp === null) {
            this.err(node, '格式化字面量里的 `%(` 没有配对的 `)`');
            bad = true;
            break;
          }
          const k = /^\d+$/.test(sp.body.trim()) ? Number(sp.body.trim()) : -1;
          if (k <= 0) {
            this.nope(node, `格式化字面量里的 \`%(${sp.body};…)\`（jancy 那儿这一格是实参的序号）`);
            bad = true;
            break;
          }
          seq = k;
          site(argAt(k - 1), sp.spec, argNodes[k - 1] === undefined ? node : argNodes[k - 1]);
          i = sp.end;
          continue;
        }
        // Ragel 的最长匹配：`%08x` 是 spec（4 字符）、`%8` 是序号（2 字符）。
        // spec 里的宽度只跟在标志后面（Lexer.rl:133），所以 `%8d` 的 `%8` 是序号、`d` 是文本。
        const idx = rest.match(/^\d+/);
        const sp = rest.match(/^([-+ #0]\d*)?(\.\d+)?(ll|l|z)?[diuxXfeEgGcsp]/);
        const spLen = sp === null ? 0 : 1 + sp[0].length;
        const idxLen = idx === null ? 0 : 1 + idx[0].length;
        if (spLen >= idxLen && spLen > 0) {
          seq += 1;
          site(argAt(seq - 1), `%${sp[0]}`, argNodes[seq - 1] === undefined ? node : argNodes[seq - 1]);
          i += spLen;
          continue;
        }
        if (idxLen > 0) {
          seq = Number(idx[0]);
          if (seq <= 0) {
            this.err(node, '格式化字面量里的实参序号从 1 起');
            bad = true;
            break;
          }
          site(argAt(seq - 1), null, argNodes[seq - 1] === undefined ? node : argNodes[seq - 1]);
          i += idxLen;
          continue;
        }
        cfmt += '%%';
        rawPct = true;
        i++;
        continue;
      }
      cfmt += rawText(c);
      i++;
    }
    if (bad) return null;
    // 同上，循环变量不叫 `k`：这个函数里的 argAt 有一个同名形参。
    for (let q = 0; q < argNodes.length; q++) {
      if (!used[q]) {
        return this.err(argNodes[q], `格式化字面量的第 ${q + 1} 个实参没有被用到`
          + '（jancy 那边这也是一句错，Parser.cpp:3585）');
      }
    }
    // 补零、宽度、`#` 那几支要先把值落成局部量。表达式位置上能不能插语句看 ecOut
    //（与第五十八刀 errorcode 那一格是同一个通道）。
    const out = this.ecOut === null ? [] : this.ecOut;
    const pad = this.ecOut === null ? '' : this.ecPad;
    const code = this.fmtRun(node, cfmt, vals, nodes, pad, out, 'str');
    if (code === null) return null;
    if (this.ecOut === null && out.length !== 0) {
      return this.nope(node, '这个位置上带宽度或补零的格式化字面量（那几支要先把值落成局部量，'
        + '而这儿插不进语句 —— 见 EC_HOIST）');
    }
    return { code, type: J_STR, rawPct };
  }

  /** 把一段要读好几次的东西先落成一个局部量，回它的读法。 */
  spill(code, pad, out, ty = 'string') {
    const t = `$f${this.tmp}`;
    this.tmp++;
    out.push(`${pad}(let ${t} ${ty} ${code})`);
    return `(var ${t})`;
  }

  /**
   * `%*d` / `%.*s` 里那个从实参来的宽度或精度（第二十七刀）。C 里它是一个 `int`，
   * 在实参表里排在值**前面**（宽度、精度、值）。
   */
  starArg(n, nodes, vals, idx, what, pad, out) {
    if (idx >= vals.length) return this.err(n, `printf 的 '*'（${what}）没有对应的实参`);
    const v = vals[idx];
    if (!isInt(v.type)) {
      return this.err(nodes[idx], `printf 的 '*'（${what}）要整数，这里是 ${tyName(v.type)}`);
    }
    return this.spill(v.code, pad, out, 'int');
  }

  /**
   * 整数上的精度（第二十七刀）。C 里 `%.3d` 是"**至少**三位数字"—— 零补在符号**后面**，
   * 而且它与宽度是两件事（`%8.3d` 先补到三位数字、再补到八个字符宽）。两条边角也照收：
   *
   *   - 精度是 0 而值是 0 时**一个字符都不印**（C99 7.19.6.1："The result of converting
   *     a zero value with a precision of zero is no characters."）。
   *   - `.*` 的实参是负数时"等于没写精度"—— 负的个数进 `srep` 回的是空串，所以这一条
   *     自己就成立，不用另写一支。
   *
   * `code` 要是一个局部量（读好几次）。传进来的是**不带前缀**的那一截：符号（`-` / `+` /
   * 空格）与 `#` 的 `0x` 都由调用方单独拿着（第二十九刀，见 padTo 的 pfx）。
   */
  precInt(code, pCode) {
    // 那一截等于 "0" 只可能是值为 0（`%x` / `%o` 同），那时精度 0 收的是空串。
    const d = `(sel (bin "==" ${code} (str "0"))`
      + ` (sel (bin "==" ${pCode} (int 0)) (str "") (str "0")) ${code})`;
    return `(bin "+" (srep (str "0") (bin "-" ${pCode} (slen ${d}))) ${d})`;
  }

  /**
   * `%s` 上的精度（第二十七刀）：`%.5s` 是"**最多**五个字符"。核心方言的 `(ssub …)`
   * 不夹范围（越界是运行期错误 —— frontend-asy 那边为此包了个 asy__ssub），所以这儿自己夹：
   * 本来就短的不动，`.*` 的实参是负数时也不动（C 里那等于没写精度）。
   */
  precStr(code, pCode) {
    const cut = `(sel (bin ">" (slen ${code}) ${pCode}) (ssub ${code} (int 0) ${pCode}) ${code})`;
    return `(sel (bin "<" ${pCode} (int 0)) ${code} ${cut})`;
  }

  /**
   * 把"前缀 + 主体"补到至少 `wCode` 个字符宽（`wCode` 是一段方言代码 —— `%*d` 的宽度运行期
   * 才知道，第二十七刀）。补的那一截是 `(srep 填充字符 (bin "-" w 总长))` —— `srep` 在个数
   * <= 0 时回空串，所以"本来就够宽"这一情形不用另写一支。
   *
   * **前缀是单独一段**（第二十九刀）：`0` 标志补的零在 C 里排在前缀**后面** ——
   * `%05d` 印 -42 是 `-0042`（不是 `00-42`）、`%#08x` 印 255 是 `0x0000ff`。以前这儿是
   * "看第一个字符是不是 `-`"，那在 `+` / 空格 / `0x` 面前就不够了（前缀的长度不定），
   * 所以改成由调用方把符号与 `0x` 拿出来、当 `pfx` 传进来（`null` 表示没有前缀）。
   * `pfx` 与 `code` 都会被读好几次，调用方**必须**先落成局部量（见 printf 里那处）。
   *
   * `zero` 收三种值：`false`（补空格）、`true`（补零）、以及**一段运行期的 bool** ——
   * 后一种只有 `%0*.*d` 用得上（写了 `0`、精度又是 `.*`：精度一写出来 `0` 就作废，而
   * 实参是负数等于精度没写、那时 `0` 又活着）。`sel` 降成 Ternary（两支各一个基本块），
   * 所以嵌一层不会把两边都算一遍。
   */
  padTo(pfx, code, wCode, left, zero) {
    const len = pfx === null ? `(slen ${code})` : `(bin "+" (slen ${pfx}) (slen ${code}))`;
    const gap = (fill) => `(srep (str "${fill}") (bin "-" ${wCode} ${len}))`;
    const whole = pfx === null ? code : `(bin "+" ${pfx} ${code})`;
    if (left) return `(bin "+" ${whole} ${gap(' ')})`;
    const sp = `(bin "+" ${gap(' ')} ${whole})`;
    if (zero === false) return sp;
    const zp = pfx === null ? `(bin "+" ${gap('0')} ${code})`
      : `(bin "+" ${pfx} (bin "+" ${gap('0')} ${code}))`;
    return zero === true ? zp : `(sel ${zero} ${zp} ${sp})`;
  }

  /* -------------------------------------------------------------- 控制流 */

  /** 控制语句的体：语法上是 decl（属性块挂在它上面，见 jnc.grammar 那段注释），
   *  这里当一条语句降。单条与块都走 `(do …)`，省一处形状判断。 */
  body(n, ind) {
    const pad = ' '.repeat(ind);
    if (isList(n) && head(n) === 'compound') {
      const b = this.block(n, ind + 2);
      return b === null ? null : `${pad}(do\n${b}\n${pad})`;
    }
    this.scopes.push(new Map());
    const lines = this.stmt(n, ind + 2);
    this.scopes.pop();
    if (lines === null) return null;
    return `${pad}(do\n${lines.join('\n')}\n${pad})`;
  }

  /**
   * **真值化**。jancy 会把整数、实数与指针当条件用（C 的规矩，它没改）。方言的条件
   * 只收 bool（ADR-0014 决策 1），所以这一层把 jancy 侧那次隐式转换**显式写出来**。
   *
   * 这不是"向方言妥协"：转换本来就发生，只是 jancy 让它隐着。写出来之后五条腿看到的
   * 是同一句比较，而"整数怎么算真"这件事只有这一处定义。
   */
  truthy(v, node) {
    if (v === null) return null;
    if (v.type === J_BOOL) return v;
    /* `operator bool`（第一百三十九刀）：主人的类型上写了它就调它。要排在下面**类那一支之前**
       —— 那一支把类引用当条件用是"跟零比"（一次空检查），而写了转换算符的那一格上，用户的
       意思是"问那个算符"，不是"问它是不是 null"。排错了就是静默的错答案。
       语料里的用法：`it ? it->m_value : undefinedValue`（stdt_Map.jnc:117）。 */
    if (isClass(v.type) || jncIsStruct(v.type)) {
      const ob = this.opUnary.get(`${v.type.name}$op$bool`);
      if (ob !== undefined) return { code: `(call ${ob.name} ${v.code})`, type: J_BOOL };
    }
    if (isInt(v.type)) return { code: `(bin "!=" ${v.code} (int 0))`, type: J_BOOL };
    if (v.type === J_REAL) return { code: `(bin "!=" ${v.code} (real 0.0))`, type: J_BOOL };
    if (jncIsPtr(v.type)) return { code: `(un "!" (pisnull ${v.code}))`, type: J_BOOL };
    // 类引用当条件用（第五十二刀）：`Cast_Bool` 对 `TypeKind_ClassPtr` 走的也是"跟零比"
    // （jnc_ct_CastOp_Bool.cpp 那张表里 ClassPtr 与 DataPtr 同一支），而类指针的有效性
    // 就是一次空检查（type_ptr_class.rst）—— 所以与指针同一句 pisnull。
    if (isClass(v.type)) return { code: `(un "!" (pisnull ${v.code}))`, type: J_BOOL };
    // 枚举当条件用（第四十七刀）：jancy 的 `Cast_Bool::getCastOperator` 里
    // `case TypeKind_Enum` 走的就是 `m_fromZeroCmp`（jnc_ct_CastOp_Bool.cpp:181）——
    // 与整数同一条"跟 0 比"。逼出这一条的是 `if (flags & OpenFlags.ReadOnly)`：
    // bitflag 的 `&` 结果是那个枚举，直接就落在条件位置上。普通枚举也一样收 —— 它在
    // jancy 那边就是同一个 case。
    if (jncIsEnum(v.type)) return { code: `(bin "!=" ${v.code} (int 0))`, type: J_BOOL };
    /* 字符串当条件用（第一百四十六刀）：jancy 那边是 `Cast_BoolFromString::llvmCast`
       （jnc_ct_CastOp_Bool.cpp:96-111）—— 取字符串那格结构体的**第 3 个字段**再转 bool，
       而那张表是 `m_p` / `!m_ptr_sz` / `m_length`（jnc_ct_TypeMgr.cpp:2031-2039），
       也就是第 3 个是**长度**。所以 `if (s)` 问的是"长度不为零"，**不是**"m_p 是不是空"——
       空串 `""` 在 jancy 那儿是**假**。方言的 `(slen E)` 也是按字节的长度，两边同一件事。
       逼出它的是 `if (!key)`（ui_Dictionary.jnc:32）。 */
    if (v.type === J_STR) return { code: `(bin "!=" (slen ${v.code}) (int 0))`, type: J_BOOL };
    /* 函数值当条件用（第一百七十五刀）。jancy 那边这一格是**照表走的**：
         // jnc_ct_CastOp_Bool.cpp:183-187
         case TypeKind_DataPtr: case TypeKind_ClassPtr:
         case TypeKind_FunctionPtr: case TypeKind_PropertyPtr:
           return &m_fromPtr;
       而 `Cast_BoolFromPtr::llvmCast` 是"取那格胖指针的第 0 个字段（函数地址）跟零比"
       （同文件:116-127）—— 也就是 `if (fp)` 问的是**函数地址那一半在不在**，与闭包那一半无关。
       这一层的函数值是一条闭包记录，"没有"那一格就是 `(null (fnty …))`，所以同一件事写成
       "跟空的那一格比"。逼出它的是 `if (m_onTriggered)` 那一族（语料里 83 处）。 */
    if (isFn(v.type)) {
      return { code: `(bin "!=" ${v.code} (null ${tyText(v.type)}))`, type: J_BOOL };
    }
    return this.err(node, `${tyName(v.type)} 不能当条件用`);
  }

  cond(n) {
    return this.truthy(this.expr(n, J_BOOL), n);
  }

  ifStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const c = this.cond(n.items[1]);
    if (c === null) return null;
    const t = this.body(n.items[2], ind + 2);
    if (t === null) return null;
    if (n.items[3] === undefined) return [`${pad}(if ${c.code}`, t, `${pad})`];
    const e = this.body(n.items[3], ind + 2);
    if (e === null) return null;
    return [`${pad}(if ${c.code}`, t, e, `${pad})`];
  }

  /** 一个结点在源码里的原样文本，换行连同紧跟其后的那串空白收成一个空格 —— 与 jancy 的
   *  `Token::getText(list)` 同一条（axl_lex_RagelLexer.h:52-84：没有换行就**直接切一段源码**，
   *  有换行则把 `\n` 及其后的连续空白换成单个空格）。所以"条件的文本"不是我们重排出来的，
   *  是照 jancy 的做法从源码里切的 —— 一个字节都不用猜。 */
  srcText(node) {
    if (node === null || node === undefined) return null;
    const sp = node.span;
    if (sp === null || sp === undefined) return null;
    if (sp.file === null || sp.file === undefined || typeof sp.file.text !== 'string') return null;
    return sp.file.text.slice(sp.start, sp.end).replace(/\n[ \t\r\n\f\v]*/g, ' ');
  }

  /**
   * `assert(C)` / `assert(C, "话")`（第四十九刀）。jancy 那边这条摊成两个块：条件真跳
   * `assert_continue`、假跳 `assert_fail`，后者调 `assertionFailure(文件, 行, 条件文本, 话)`
   * （jnc_ct_Parser.cpp:3798-3825），而那个函数印的是
   * `"%s(%d): assertion failure: %s"`、带话的再追一个 `" (%s)"`，然后 `dynamicThrow()`
   * （jnc_rtl_CoreLib.cpp:534-541）。行号那一格是 `pos.m_line`（0 起）印成 `line + 1`，
   * 也就是**条件第一个 token 所在的那一行**，1 起。
   *
   * 方言这边不用新形式：`(fail E)` 就是"印一句、退 70"（sexpr/lower.js:922-929），五条腿
   * 都有。于是整条落成 `(if (un "!" C) (do (fail (str 那句话))))` —— 与 jancy 的两块
   * 一一对上，只是"抛"换成"停"：jancy 的 `dynamicThrow` 能被 `try` 接住，这一层还没有
   * 异常（`try`/`throw` 都还在边界上），所以断言失败是**到此为止**。
   *
   * 一处明写的差别：jancy 的 assert 由 `-a`/`--assert` 开关点亮（CmdLine.h:181-184 →
   * CmdLine.cpp:90-92 → jnc_ct_Parser.cpp:3784，没开就**整条丢掉**，条件都不求值）。
   * 这一层没有开关机构，选的是**一直开着** —— 反过来那头意味着断言失败静静地过，
   * 而这条线是靠"跑起来对不对"往前走的，那种沉默最不能要。
   */
  assertStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const cn = n.items[1];
    const c = this.cond(cn);
    if (c === null) return null;
    let extra = '';
    if (n.items[2] !== undefined) {
      // 第二个实参在 jancy 的产生式里写死是 `TokenKind_Literal`（Stmt.llk:415），拿的是
      // `$m.m_data.m_string` —— 编译期就定下的一串字节。收表达式会让"运行期才知道那句话"
      // 变成能写的东西，而 jancy 写不出来。相邻的几个字面量拼在一起照收（第五十四刀）。
      const msg = litFold(n.items[2]);
      if (msg === null) {
        return this.nope(n.items[2], 'assert 的第二个实参不是字符串字面量（jancy 那条产生式只收字面量）');
      }
      extra = ` (${msg})`;
    }
    const text = this.srcText(cn);
    if (text === null) return this.nope(n, 'assert 的条件取不到源码文本');
    const where = cn.span.file.lineCol(cn.span.start);
    const line = `${cn.span.file.path}(${where.line}): assertion failure: ${text}${extra}`;
    return [
      `${pad}(if (un "!" ${c.code})`,
      `${pad}  (do`,
      `${pad}    (fail (str ${JSON.stringify(line)}))))`,
    ];
  }

  /**
   * `switch` —— 方言里没有它，所以摊成「派发下标 + 一串守卫」（第三十六刀）：
   *
   *   (let $sv0 int COND)
   *   (let $sk0 int (int 缺省组))          ;; 一个都不中时指向"组的个数"，于是哪一组都不跑
   *   (if (bin "==" (var $sv0) (int k)) (set $sk0 (int 组号)))   ;; 每个 case 一条
   *   (while (bool true)
   *     (do
   *       (if (bin "<=" (var $sk0) (int 0)) (do 第0组))
   *       (if (bin "<=" (var $sk0) (int 1)) (do 第1组))
   *       …
   *       (brk)))
   *
   * 三件事靠这个形状同时成立：
   *   1. **贯穿**（fall-through）。case 的值互不相同，所以派发那几条 `if` 谁在前谁在后都一样；
   *      而守卫是 `<=`，从第 j 组进去就会接着跑 j+1、j+2 …… —— 这正是 C 与 jancy 的贯穿
   *      （cflow_switch.rst:29 明写着 "even when we fall-through from previous case label"）。
   *   2. **break 跳出整个 switch**。那圈 `while` 只跑一遍（体的末尾就是 `(brk)`），所以里面的
   *      `(brk)` 落到 switch 之外。
   *   3. **每组一层作用域**。jancy 给每个 case 块隐式开一层（cflow_switch.rst:15），所以
   *      `case 0: int i = 10;` 与 `case 1: int i = 20;` 不冲突 —— 这里每组包一个 `(do …)`。
   *
   * 那圈 `while` 是**合成的**，所以它在 `this.loops` 里记成 `sw: true`：`break` 数它
   * （jancy 也把 switch 算一层，cflow_switch.rst:37），`continue` 不数它 —— switch 里的
   * `continue` 落到方言里是 `(cont 2)`，跳过这一圈回到外面那个真循环（第四十一刀）。
   */
  switchStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const es = n.items[1];
    const conds = isList(es) && head(es) === 'exprs' ? es.items.slice(1) : [es];
    if (conds.length !== 1) {
      // `switch (state, string_t(p, 1))` —— 括号里是逗号串时那是**正则** switch
      //（Stmt.llk:192-195 的 resolver 就按这个分），另一条边界。
      this.nope(n, '正则 switch（括号里是逗号串）');
      return null;
    }
    const v = this.expr(conds[0]);
    if (v === null) return null;
    // 枚举当条件：落到基整数上（第三十九刀）。case 的标签那一边同理，见 constInt。
    const cv = jncIsEnum(v.type) ? { code: v.code, type: v.type.base } : v;
    if (!isInt(cv.type)) {
      this.err(n, `switch 的条件要整数，这里是 ${tyName(v.type)}`);
      return null;
    }
    const groups = this.switchGroups(n);
    if (groups === null) return null;
    const sv = `$sv${this.tmp}`;
    const sk = `$sk${this.tmp}`;
    this.tmp++;
    let def = groups.length;
    const seen = new Map();
    const disp = [];
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].def) {
        if (def !== groups.length) { this.err(groups[i].defNode, 'switch 里有两个 default'); return null; }
        def = i;
      }
      for (const [k, kn] of groups[i].labels) {
        if (seen.has(k)) { this.err(kn, `switch 里 case ${k} 出现了两次`); return null; }
        seen.set(k, i);
        disp.push(`${pad}(if (bin "==" (var ${sv}) (int ${k})) (do (set ${sk} (int ${i}))))`);
      }
    }
    this.loops.push({ kind: 'switch', step: false });
    const bodies = [];
    let bad = false;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].stmts.length === 0) { bodies.push(null); continue; }
      this.scopes.push(new Map());
      const out = [];
      for (const s of groups[i].stmts) {
        const lines = this.stmt(s, ind + 6);
        if (lines === null) bad = true; else for (const l of lines) out.push(l);
      }
      this.scopes.pop();
      bodies.push(out);
    }
    this.loops.pop();
    if (bad) return null;
    const out = [
      `${pad}(let ${sv} int ${v.code})`,
      `${pad}(let ${sk} int (int ${def}))`,
      ...disp,
      `${pad}(while (bool true)`,
      `${pad}  (do`,
    ];
    for (let i = 0; i < groups.length; i++) {
      if (bodies[i] === null) continue;
      out.push(`${pad}    (if (bin "<=" (var ${sk}) (int ${i}))`);
      out.push(`${pad}      (do`);
      for (const l of bodies[i]) out.push(l);
      out.push(`${pad}      )`);
      out.push(`${pad}    )`);
    }
    out.push(`${pad}    (brk)`);
    out.push(`${pad}  )`);
    out.push(`${pad})`);
    return out;
  }

  /**
   * switch 的花括号里是一串**扁平**的语句，`case` / `default` 是其中的标记（与 C 同一个形状，
   * 见 Stmt.llk:180-189）。这里把它切成一组一组：连着写的标记（`case 1: case 2:`）归同一组。
   */
  switchGroups(n) {
    const groups = [];
    let cur = null;
    for (const s of this.flat(n.items[2])) {
      const h = head(s);
      if (h === 'case' || h === 'default') {
        // 标记之间没有语句时不另开一组 —— `case 1: case 2: foo();` 两个值指向同一组
        if (cur === null || cur.stmts.length > 0) {
          cur = { labels: [], def: false, defNode: null, stmts: [] };
          groups.push(cur);
        }
        if (h === 'default') { cur.def = true; cur.defNode = s; continue; }
        const k = this.caseLabel(s.items[1]);
        if (k === null) return null;
        cur.labels.push([k, s]);
        continue;
      }
      if (cur === null) {
        this.err(s, 'switch 的第一个 case 之前不能有语句（那段谁也到不了）');
        return null;
      }
      cur.stmts.push(s);
    }
    return groups;
  }

  /**
   * case 的标签是**常量整数表达式**（Stmt.llk:181 `constant_integer_expr`）。这一层只认
   * 字面量与一元减 —— 常量折叠（`case 1 + 2:`）与命名常量（`case Request.Terminate:`）
   * 都要先有编译期求值那一格，各是一条边界。
   */
  caseLabel(e) {
    const k = this.constInt(e);
    if (k === null) {
      /* 榜上这一行 53 份，**全是同一种**（第二百二十四刀量的）：
         `case EthernetTapLogRecordCode.Packet_ch1:`、`case HidDispatchCode.GetDeviceVid:`
         这样的**限定名**，而那个枚举躺在别的模块里、逐份编的时候 import 不着。
         枚举成员本身这一层早就认（`case Code.Ok:` 当场量过能走，constInt 里 exposedLit 与
         枚举体那两支）；常量折叠也认（constBin）。所以"算不出来"这句话是**认错人**——
         真话是"这个名字这一层不认得"，与 `没有这个类型` 是同一笔口径账。 */
      const dn = isList(e) && (head(e) === 'name' || head(e) === 'field') ? this.dotted(e) : null;
      if (dn !== null) {
        this.nope(e, `case 的标签 '${shown(dn)}' 这一层不认得 —— 枚举成员与常量折叠都认得`
          + '（`case E.M:` / `case 1 + 2:`），所以这一格是那个名字本身找不着'
          + '（那个枚举在别的模块里，与 `没有这个类型` 同一笔口径账）');
        return null;
      }
      this.nope(e, 'case 的标签算不出来（要一个编译期整数常量）');
      return null;
    }
    return k;
  }

  /**
   * 编译期整数求值（第三十六刀起头，第四十八刀长成）。**从语法树上算**，不看降出来的文本
   * —— 降级会把一元减包进回卷（`(bin "-" (bin "^" …))`），照文本认不出来。
   *
   * jancy 那边的口径是 `parseConstIntegerExpression`：把它当**一整条表达式**解出来，然后
   * 只要求结果是 `ValueKind_Const` 且类型带 `TypeKindFlag_Integer`
   * （jnc_ct_OperatorMgr_New.cpp:379-403）。所以"能不能写"这件事在 jancy 那边等于
   * "编译器折得动吗"，而不是"是不是一个字面量"。这一处照着它收：
   *
   *   - 整数字面量（各种进制，走 numLit）
   *   - `true` / `false` —— **bool 也带 Integer 这个位**（jnc_Type.cpp:38-48 那张表里
   *     Bool1 与 Bool8 都有 `jnc_TypeKindFlag_Integer`），所以 `C = false` 是 0，合法。
   *     语料里真这么写：test104.jnc:4。
   *   - 一元 `+` `-` `~` `!`
   *   - 二元 `+ - * / % & | ^ << >>` 与六个比较（比较回 bool，同样带 Integer 位）
   *   - 枚举成员 `Color.Green`（第三十九刀）
   *
   * 算在 BigInt 上，**不在这一层回卷**：调用方各自知道该落进哪一格（枚举成员走
   * `wrapVal(…, info.base)`，数组长度要非负），在那儿收窄一次就够。
   *
   * 返回 null 表示"这里不是一个能算的常量"，由调用方报错。
   */
  constInt(e) {
    if (isAtom(e)) {
      const v = this.numLit(e);
      if (v === null || !isInt(v.type)) return null;
      const m = v.code.match(/^\(int (-?\d+)\)$/);
      return m === null ? null : BigInt(m[1]);
    }
    if (isList(e) && head(e) === 'true') return 1n;
    if (isList(e) && head(e) === 'false') return 0n;
    // 光一个名字 —— 只在**枚举自己的体里**认，指的是同一个枚举里已经定下的成员
    // （第四十八刀）。jancy 那边成员住在枚举自己的命名空间里（type_enum.rst:17），
    // 而初值就是在那个命名空间里解的，所以 `Bridged = Opened + 1` 里的 `Opened`
    // 不用写全名。语料里的写法：test56.jnc:15。
    if (isList(e) && head(e) === 'name' && this.constEnum !== null) {
      const nm = this.qname(e);
      if (nm === null) return null;
      const v = this.constEnum.members.get(nm);
      if (v !== undefined) return BigInt(v);
    }
    /* 无名枚举漏出来的那些成员（第九十六刀）：`int a[Major + 1]` 与
       `enum X { A = Major }` 都要在编译期算得出它。裸名字与带命名空间前缀的都从
       exposedLit 那一张表来 —— 与表达式那一侧同一句。 */
    if (isList(e) && (head(e) === 'name' || head(e) === 'field')) {
      const dn = this.dotted(e);
      const ex = dn === null ? null : this.exposedLit(dn);
      if (ex !== null) {
        const m = ex.code.match(/^\(int (-?\d+)\)$/);
        if (m !== null) return BigInt(m[1]);
      }
    }
    if (isList(e) && head(e) === 'binary' && isStr(e.items[1])) {
      return this.constBin(e, e.items[1].value);
    }
    if (isList(e) && head(e) === 'unary' && isStr(e.items[1])) {
      const op = e.items[1].value;
      const k = this.constInt(e.items[2]);
      if (k === null) return null;
      if (op === '+') return k;
      if (op === '-') return -k;
      if (op === '~') return -k - 1n;               // ~x == -x-1，与位宽无关
      if (op === '!') return k === 0n ? 1n : 0n;
      return null;
    }
    // `Color.Green` —— 枚举成员的值在编译期就定了（第三十九刀），所以 `case Color.Green:`
    // 与 `enum X { A = Color.Green }` 都能算。
    if (isList(e) && head(e) === 'field') {
      const em = this.enumMember(e, e.items[1], e.items[2]);
      if (em === undefined || em === null) return null;
      const m = em.code.match(/^\(int (-?\d+)\)$/);
      return m === null ? null : BigInt(m[1]);
    }
    /* `'a'` 那一格也是编译期的整数（第九十七刀）：`enum { Sig = '\xa1\xb2\xc3\xd4' }` 与
       `int a['z' - 'a']` 都要算得出来。 */
    if (isList(e) && head(e) === 'char') {
      const cv = this.charLit(e);
      if (cv === null) return null;
      const m = cv.code.match(/^\(int (-?\d+)\)$/);
      return m === null ? null : BigInt(m[1]);
    }
    return null;
  }

  /**
   * 编译期求值里的二元算子（第四十八刀）。BigInt 上的整数语义 —— 与运行期那一份的差别只在
   * "不回卷"：调用方各自知道该落进哪一格。三处**拒**而不是硬算：
   *   - 除以 0（jancy 那边也是错，不是"折出个数来"）
   *   - 移位量不在 0..63（C 里移位量 >= 位宽是未定义行为，没有可对的答案）
   *   - `&&` / `||`（它们回 bool，也带 Integer 位，但短路语义在常量位置上没有意义 ——
   *     语料里一处都没有，留着当边界）
   * `/` 按**向零截断**（C 与 jancy 同），BigInt 的除法本来就是这个。
   */
  constBin(e, op) {
    const a = this.constInt(e.items[2]);
    const b = this.constInt(e.items[3]);
    if (a === null || b === null) return null;
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0n ? null : a / b;
      case '%': return b === 0n ? null : a % b;
      case '&': return a & b;
      case '|': return a | b;
      case '^': return a ^ b;
      case '<<': return b < 0n || b > 63n ? null : a << b;
      case '>>': return b < 0n || b > 63n ? null : a >> b;
      case '==': return a === b ? 1n : 0n;
      case '!=': return a !== b ? 1n : 0n;
      case '<': return a < b ? 1n : 0n;
      case '<=': return a <= b ? 1n : 0n;
      case '>': return a > b ? 1n : 0n;
      case '>=': return a >= b ? 1n : 0n;
      default: return null;
    }
  }

  whileStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const c = this.cond(n.items[1]);
    if (c === null) return null;
    this.loops.push({ kind: 'loop', step: false });
    const b = this.body(n.items[2], ind + 2);
    this.loops.pop();
    if (b === null) return null;
    return [`${pad}(while ${c.code}`, b, `${pad})`];
  }

  /**
   * `do BODY while (C);` —— 方言里没有"后置判断的循环"，所以借一格标志：
   *
   *   (let $doN bool true)
   *   (while (bin "||" (var $doN) C)
   *     (do (set $doN (bool false)) BODY))
   *
   * `||` 短路，所以第一圈不会算 C（这一点要紧：C 里可能有第一圈还没成立的东西）。
   * 第二圈起判断落在循环头，也就是第一圈的体之后 —— 与 do-while 的语义一致。
   *
   * 标志清零放在体的**开头**而不是末尾：放末尾时体里的 `continue` 会把它跳过去，
   * 于是变成死循环。放开头就没有这个坑（`break` 照旧从 `while` 里出去）。
   */
  doWhileStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const flag = `$do${this.tmp}`;
    this.tmp++;
    this.loops.push({ kind: 'loop', step: false });
    const b = this.body(n.items[1], ind + 4);
    const c = this.cond(n.items[2]);
    this.loops.pop();
    if (b === null || c === null) return null;
    return [
      `${pad}(let ${flag} bool (bool true))`,
      `${pad}(while (bin "||" (var ${flag}) ${c.code})`,
      `${pad}  (do`,
      `${pad}    (set ${flag} (bool false))`,
      b,
      `${pad}  )`,
      `${pad})`,
    ];
  }

  /**
   * `for (INIT; C; STEP) BODY` -> `(do INIT (while C (do BODY STEP)))`。
   *
   * 三格都可以空：没有 C 时是 `(bool true)`。INIT 里的声明要能被 C / STEP / BODY 看到，
   * 所以整条包在一个 `(do …)` 里，而那个 do 自带一层作用域。
   *
   * 步进非空时体里的 `continue` 在 stmt() 里被拦掉 —— 方言的 `cont` 跳到循环头，
   * 会漏掉一次步进。
   */
  forStmt(n, ind) {
    const pad = ' '.repeat(ind);
    this.scopes.push(new Map());
    const out = [`${pad}(do`];
    const init = n.items[1];
    let bad = false;
    if (isList(init) && head(init) === 'none') { /* 空 */ }
    else if (isList(init) && head(init) === 'var-decl') {
      const ls = this.localDecl(init, ind + 2);
      if (ls === null) bad = true; else for (const l of ls) out.push(l);
    } else {
      for (const e of this.flat(init)) {
        const ls = this.exprStmt(e, ind + 2);
        if (ls === null) { bad = true; break; }
        for (const l of ls) out.push(l);
      }
    }
    // 步进：一串表达式语句（`for (…; …; i++, k += 2)`）。先降它 —— 拿到的行要塞进体的末尾。
    const steps = [];
    for (const e of this.flat(n.items[3])) {
      const ls = this.exprStmt(e, ind + 6);
      if (ls === null) { bad = true; break; }
      for (const l of ls) steps.push(l);
    }
    let cond = '(bool true)';
    const cn = n.items[2];
    if (!(isList(cn) && head(cn) === 'none')) {
      const c = this.cond(cn);
      if (c === null) bad = true; else cond = c.code;
    }
    // 体里有 `continue` 指着这一层、而这一层又带步进时，给体套一圈**一次性**循环
    // （第四十二刀）：`continue` 变成那圈的 `(brk)`，落点正好在步进之前。
    const oneshot = steps.length > 0 && this.contTargets(n.items[4], 0);
    this.loops.push({ kind: 'loop', step: steps.length > 0 });
    if (oneshot) this.loops.push({ kind: 'oneshot', step: false });
    const b = this.body(n.items[4], ind + (oneshot ? 8 : 4));
    if (oneshot) this.loops.pop();
    this.loops.pop();
    this.scopes.pop();
    if (bad || b === null) return null;
    out.push(`${pad}  (while ${cond}`);
    out.push(`${pad}    (do`);
    if (oneshot) {
      out.push(`${pad}      (while (bool true)`);
      out.push(`${pad}        (do`);
      out.push(b);
      out.push(`${pad}          (brk)`);
      out.push(`${pad}        )`);
      out.push(`${pad}      )`);
    } else {
      out.push(b);
    }
    for (const s of steps) out.push(s);
    out.push(`${pad}    )`);
    out.push(`${pad}  )`);
    out.push(`${pad})`);
    return out;
  }

  /**
   * 体里有没有一条 `continue` 正好指着"我"这一层（第四十二刀）。
   *
   * 数的规矩与 stmt 里的 `continue N` 一致：**只数真循环**（while / do / for），switch 不算。
   * `d` 是"从我这一层往里又进了几层真循环"，所以 `continue N` 指着我等价于 `N === d + 1`。
   * 这一遍必须在 AST 上走 —— 降级后的文本里 `(brk)` 与 `(cont)` 已经分不出是谁的了。
   */
  contTargets(n, d) {
    if (!isList(n)) return false;
    const h = head(n);
    if (h === 'continue') {
      const lv = isAtom(n.items[1]) ? Number(n.items[1].value) : 1;
      return lv === d + 1;
    }
    const inner = h === 'while' || h === 'do' || h === 'for' ? d + 1 : d;
    for (const it of n.items) {
      if (isList(it) && this.contTargets(it, inner)) return true;
    }
    return false;
  }

  retStmt(n, ind) {
    const pad = ' '.repeat(ind);
    if (n.items[1] === undefined) {
      if (this.retTy !== J_VOID) {
        this.err(n, `这个函数回 ${tyName(this.retTy)}，光一个 return 不够`);
        return null;
      }
      return [`${pad}(ret)`];
    }
    // `int main()` 降成方言的 `(main …)`，而那个入口不回值 —— `return 0` 就是 `(ret)`。
    // 只放过字面的 0（`return 1` 是"非零退出码"，这一层还没有那一格，得当场说清）。
    if (this.retTy === J_VOID) {
      const v = n.items[1];
      if (isAtom(v) && v.value === '0') return [`${pad}(ret)`];
      return this.nope(n, 'main 里 `return` 一个非 0 的值（方言的入口没有退出码）');
    }
    /* 结构体的**左值**回一格指向它的指针（第一百六十七刀）：
         `DictionaryEntry* insertDictionaryHead(…) { DictionaryEntry entry; … return entry; }`
         （test/ioninja/api/ui_Dictionary.jnc:67-79，逐份榜上 90 处）。jancy 里这不是"类型不对"——
       一格左值在它那边的类型是 `DataRef`，而 `Cast_DataPtr::getCastOperator` 里 `TypeKind_DataRef`
       那一支只把数组与字符串挑出去特殊办，**结构体那一支落到下面按指针种类查的那张表**
       （jnc_ct_CastOp_DataPtr.cpp:815-823 与 856-859；`DataRef` 在它那边就是 `DataPtrType` 的一种），
       也就是说左值直接退化成"指向它自己的指针"。地址逃出这个函数这件事由 GC 兜着 —— 这一层的
       对应机器是第九刀那一套：被取过地址的量提到自己一段内存里（`gTaken` / `lifted`）。
       所以这儿就是照 `&entry` 那条路发，一个字都不用新造。 */
    if (this.retTy !== null && this.retTy !== undefined && this.retTy.k === 'ptr'
      && jncIsStruct(this.retTy.target)) {
      const ct0 = this.cheapTy(n.items[1]);
      if (ct0 !== null && ct0.lit !== true && jncIsStruct(ct0.ty)
        && sameTy(ct0.ty, this.retTy.target)) {
        const sp0 = n.items[1].span;
        const a0 = this.addrOf(this.mkL(sp0, this.mkA(sp0, 'addr'), n.items[1]));
        if (a0 === null) return null;
        return [`${pad}(ret ${a0.code})`];
      }
    }
    let v = this.expr(n.items[1], this.retTy);
    if (v === null) return null;
    if (isInt(v.type) && isInt(this.retTy)) v = intConv(v, this.retTy);
    if (!this.assignOk(v.type, this.retTy)) {
      this.err(n, `return 的类型是 ${tyName(v.type)}，函数声明的是 ${tyName(this.retTy)}`);
      return null;
    }
    return [`${pad}(ret ${v.code})`];
  }

  /* -------------------------------------------------------------- 表达式 */

  /**
   * 一个表达式 -> `{code, type}`。`want` 是**类型提示**，只有两处真的要它：
   *   - `null` 本身没有类型，得从左边（声明/形参/返回）那儿知道自己是什么指针
   *   - jancy 的 int -> double 是隐式的，所以 want 是 real 而结果是 int 时补一条 `toreal`
   * 别的地方 want 只是个建议，不影响结果的类型。
   */
  expr(n, want) {
    // 数组在这儿退化成指针（jancy 的 `int* p = a;`）。放在这一处而不是散在每个用处，
    // 是因为 expr 是所有取值的唯一入口 —— 声明那两处要看**没退化**的类型，它们直接
    // 走 expr0 / 自己判（见 localDecl 与 localDeclCurly）。
    //
    // **要的就是数组时一个字都不退**（第二十一刀）：jancy 的退化不在"取值"那一步，是在
    // "转成目标类型"那一步（`Cast_DataPtr_FromArray`，CastOp_DataPtr.cpp:24），所以目标
    // 本身是 `T[N]` 时（数组形参、数组返回、数组之间的赋值）走的是 `Cast_Array` 那条路。
    const v0 = this.expr0(n, want);
    const v = want !== undefined && want !== null && isArr(want) ? v0 : decay(v0);
    if (v === null) return null;
    // int -> real 的隐式加宽（jancy 与 C 同）。反过来**不**做：那是丢精度，
    // jancy 那边也要一次显式强制转换。
    if (want === J_REAL && isInt(v.type)) return { code: realOf(v.code, v.type), type: J_REAL };
    /* `variant_t` 的装箱与拆箱（第一百一十三刀）。两个方向在 jancy 里**都是隐式的** ——
       语料里的写法就是 `*out = atoi(s);`（装箱）与 `m_editText = in;`（拆箱），
       两句都不写强制转换。所以这两条挂在这一处：它是"要一个具体类型"的取值的唯一入口，
       于是初值、赋值、实参、返回值四处一起接上（与上面 bool -> 整数那条同一个理由）。

       排在 int -> real 之后：`variant_t v = 1;` 要的是装一格**整数**，不是先变实数。 */
    if (isVar(want) && !isVar(v.type)) {
      const bx = this.varBoxOf(v);
      if (bx !== null) return bx;
      return this.nope(n, `把 ${tyName(v.type)} 装进一格 variant_t（今天收整数 / 实数 / 布尔 /`
        + ' 枚举 / 字符串；指针、结构体与函数值那几种要 variant 里也能装那格表示）');
    }
    if (isVar(v.type) && want !== undefined && want !== null && !isVar(want)) {
      const ux = this.varUnboxTo(v, want);
      if (ux !== null) return ux;
      return this.nope(n, `把一格 variant_t 拆成 ${tyName(want)}（今天拆得出整数 / 实数 /`
        + ' 布尔 / 字符串）');
    }
    // bool -> 整数的隐式转换（第三十七刀）。出处两条：1 位那一格用**零扩展**
    //（`m_ext_u`，jnc_ct_CastOp_Int.cpp:354），而扩展这一族的 getCastKind 就是
    // `CastKind_Implicit`（jnc_ct_CastOp_Int.h:63）。所以 `int b = a > 0;` 在 jancy 里合法，
    // 值是 0 或 1 —— 与 C 同。这一处是所有"要一个具体类型"的取值的唯一入口，所以初值、
    // 赋值、实参、返回值四个地方一起接上。
    if (want !== undefined && want !== null && isInt(want) && v.type === J_BOOL) {
      return { code: `(sel ${v.code} (int 1) (int 0))`, type: want };
    }
    // 枚举 -> 整数是**隐式**的（第三十九刀）：getArithmeticOperatorResultType 见到
    // TypeKind_Enum 会递归到基类型（jnc_ct_UnOp_Arithmetic.cpp:39）。反过来要**显式**
    //（type_enum.rst:60 那句 "cast int->enum must be explicit"），所以这儿只有一个方向。
    if (want !== undefined && want !== null && isInt(want) && jncIsEnum(v.type)) {
      return intConv({ code: v.code, type: v.type.base }, want);
    }
    // **0 可以隐式赋进 bitflag 枚举**（第四十七刀）。jancy 那边这一条写在 int -> enum 的
    // getCastKind 里：`(type->getFlags() & EnumTypeFlag_BitFlag) && opValue.isZero()` 时是
    // `CastKind_Implicit`（jnc_ct_CastOp_Int.cpp:306-311）。注意它问的是 `opValue.isZero()`
    // —— **编译期常量零**，不是"运行期恰好是 0"。所以这儿也只认常量：`flags = 0` 收，
    // `flags = x` 不收（哪怕 x 这一趟正好是 0）。别的整数值还是要显式强制转换。
    if (want !== undefined && want !== null && jncIsEnum(want) && want.bits === true && isInt(v.type)) {
      const k = this.constInt(n);
      if (k === 0n) return { code: '(int 0)', type: want };
    }
    return v;
  }

  /** 数值字面量。方言的 `(int …)` 只收十进制，所以 `0x` / `0b` / `0o` 在这儿就折成十进制。 */
  numLit(n) {
    const s = n.value;
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) return this.intLit(n, BigInt(`0x${s.slice(2)}`));
    if (/^0[bB][01]+$/.test(s)) return this.intLit(n, BigInt(`0b${s.slice(2)}`));
    if (/^0[oO][0-7]+$/.test(s)) return this.intLit(n, BigInt(`0o${s.slice(2)}`));
    if (/^0[oO][0-9]+$/.test(s)) return this.err(n, `八进制字面量里有 8 或 9：'${s}'`);
    if (/^0[nNdD][0-9]+$/.test(s)) return this.intLit(n, BigInt(s.slice(2)));
    // 打头一个 `0` 再跟一串八进制数字**就是八进制**（Lexer.rl:429 `'0' oct+`，基数 8）。
    // 语料里真这么写：SerialMonProcessor_lnx.jnc:44 的 `CBAUD = 0010017` 是 termios 那套
    // 八进制掩码。带 8 或 9 的（`0778` / `08`）落不到那条规则上 —— ragel 取更长的匹配，也就是
    // 下面那条 `dec+`，于是它们是**十进制**（这一格与 C 不同，C 那边 `08` 是错）。
    if (/^0[0-7]+$/.test(s)) return this.intLit(n, BigInt(`0o${s.slice(1)}`));
    if (/^[0-9]+$/.test(s)) return this.intLit(n, BigInt(s));
    // FP 那两条词法规则出来的形状（`1.5` / `1.` / `1e3` / `1.5e-3`）方言的 realLit 都收
    if (/^[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?$/.test(s)) return { code: `(real ${s})`, type: J_REAL };
    // 二进制字面量与预定义的字面量宏在词法里都是 LITERAL，可它们不是"数"（第五十四刀）——
    // 说清是哪一格，别落到"认不出的字面量"那句上。
    const why = this.litWhy(n);
    if (why !== '这一格') return this.nope(n, why);
    return this.err(n, `认不出的字面量 '${s}'`);
  }

  /**
   * 整数字面量的类型：**装得下就是 `int`（32 位），装不下就是 `long`（64 位）**。C 的规矩，
   * jancy 同。这条有个众所周知的后果，照抄不改：`-2147483648` 是 `long` 而不是 `int`
   * （一元减在字面量**之外**，而 `2147483648` 已经装不下 32 位了）。
   *
   * 比 INT64_MAX 还大的那一格是 `unsigned long`（第六十一刀）。这不是 C 的规矩（C 那边
   * 不带后缀的十进制字面量只走有符号那条链，`18446744073709551615` 在 C99 里是"没有类型
   * 装得下"），是 **jancy 自己的**：整数字面量走 `setConstInt64_u`
   * （jnc_ct_Expr.llk:856），它挑类型用的 `getInt64TypeKind_u` 最后一格正是
   * `integer <= INT64_MAX ? TypeKind_Int64 : TypeKind_Int64_u`（jnc_ct_Type.cpp:64）。
   * 位上存的还是那 64 位（`asIntN` 折一下），无符号性挂在类型上，算子由 binary 那边按
   * 类型挑 u 版 —— 与第三十三刀"位宽与符号性合起来才是一格"是同一条。
   */
  intLit(n, v) {
    if (v > 0xffffffffffffffffn) {
      return this.err(n, `整数字面量超出 unsigned long 能装的范围：'${n.value}'`);
    }
    if (v > 0x7fffffffffffffffn) return { code: `(int ${BigInt.asIntN(64, v)})`, type: J_U64 };
    return { code: `(int ${v})`, type: v > 0x7fffffffn ? J_I64 : J_I32 };
  }

  /**
   * `with "h.h"` 收来的一个 C 函数的调用点（ADR-0022 的 J4d）。发的是方言的
   * `(ccall 名字 实参…)` —— 实参已经是机器值，**不过 marshaler**。
   *
   * 实参按 C 那边的声明检查，词与 jnc 类型的对法在 `CABI_WANT` 里。`ptr` 那一格
   * 松一些：整数（句柄/地址）、jnc 的指针（fat 与 thin）、字符串字面量都收 ——
   * 后两样在方言那一侧抽的都是"当前"那一格（见 sexpr/lower.js 的 ccall）。
   *
   * 变参（`printf` 那一族）：定参按声明查，后面那些按 C 的默认实参提升 —— 整数、
   * `real`、地址都行，`bool` 不行（C 会把它提升成 int，这一层没有那一步）。
   * 分界写在声明里（`(cabi f R (T ...))`），下游是 `CCALL` 的 aux。
   */
  /**
   * jnc 类型 -> C_ABI 的那几个词。落不进的回 null（调用点据此明说，不悄悄放宽）。
   *
   * 类引用也是 `ptr`：这一侧它是一格带界的三字指针，交给 C 的是"当前"那一格 ——
   * 与 `(ptr T)` 同一条。`void` 只在返回位上成立。
   */
  cabiWordOfJnc(t, isRet) {
    if (t === null || t === undefined) return null;
    if (t.k === 'void') return isRet === true ? 'void' : null;
    if (t.k === 'bool') return 'bool';
    if (t.k === 'real') return 'f64';
    if (t.k === 'int') return t.w <= 32 ? 'i32' : 'i64';
    /* 枚举**就是它的底整数**（第一百六十三刀，翻第一百三十九刀那条"不猜"的案）：这不是猜，
       是 jancy 的代码生成本身 ——

           // jnc_ct_EnumType.h:182-183
           prepareLlvmType() { m_llvmType = m_baseType->getLlvmType(); }

       也就是说枚举在**调用约定这一层根本不存在**：过去的就是那格整数。所以宿主面上按底整数
       过是照抄，不是"悄悄按底整数传过去"。 */
    if (jncIsEnum(t)) return this.cabiWordOfJnc(t.base, isRet);
    if (t.k === 'ptr' || t.k === 'tptr' || t.k === 'class' || t.k === 'string' || t.k === 'arr') {
      return 'ptr';
    }
    return null;
  }

  /**
   * `opaque class` 上那些**体在宿主里**的方法的调用点（ADR-0022 的 J4b 最后一步）。
   *
   * jancy 那边这一格由扩展库登记（`JNC_BEGIN_CLASS` 那一串，abi.rst:60-70），对象由 jancy
   * 分配、方法是宿主的函数、第一个实参是对象自己。我们照同一个形状，只把"登记"换成
   * **按名字约定**：`Owner.method` -> C 符号 `Owner_method`，第一个形参是 `ptr`（那个对象）。
   *
   * 为什么用 `_` 而不是 `$`：`$` 不是可移植的 C 标识符字符（clang 收，标准不收）。
   * 命名空间里的类名本来带 `$`，一并换成 `_`。
   *
   * 体在哪个库里由源码另说一句（`import "libfoo.dylib"`）—— 与 `(cabi …)`/`(lib …)` 的
   * 分工完全一致：这一格只说"有这么个符号、它是这么声明的"。
   */
  /**
   * 宿主面同名那几条里挑一条（第一百七十一刀）。回 `{sig, i}`（`i` 是声明顺序，符号名靠它加
   * `_o2` / `_o3`…），说不通时发诊断回 null。
   *
   * 规矩与普通重载那一处（pickOverload）逐条一样：先按**个数**筛（默认值算可省的那几格），
   * 剩一条就是它；剩几条按**实参类型**排（argCost），问不出实参类型的明说不收（第八十刀那条
   * "绝不猜"），同分的也明说（jancy 那边这也是 ambiguous）。
   */
  /**
   * 一格 `variant_t` 过宿主面（第一百七十三刀）：**过去的是一格地址**。
   *
   * 为什么这不是猜：jancy 的 `variant_t` 在 C 那一侧是 `struct jnc_Variant`
   * （include/jnc_Variant.h:150-189 —— 48 字节的 union + 一格补白 + 一格 `jnc_Type*`，
   * 64 位机上共 64 字节），而 64 字节的聚合在 SysV x86-64 与 AAPCS64 上都**按内存过**：
   * 被调方拿到的本来就是一个地址，调用方负责那份拷贝。这一刀照这个形状发。
   *
   * 指向的那块按**这一层自己**那格 variant 的表示（`variantTy()`）—— 与 `Owner_method` 那条
   * 约定同一性质：宿主本来就是照我们的约定写的（选项 A，见 ADR-0016 那一节）。
   *
   * "那份拷贝"要一格临时内存，而那是**一条语句** —— 用第五十八刀那条现成的落点（`ecOut`）。
   * 惰性位置上落点是关着的（`ecLazy`），那时明说不收：那儿插一句就把求值顺序改了。
   */
  hostVariantArg(node, v) {
    /* **量出来一格、把上一句话改对**：这一层的 variant 值本来就是**一格地址** ——
       `varBox` 那几格出来的类型是 `jnc$variant*`（结构体值在这一层一律按地址拿，与形参、
       返回、赋值那几处同一条）。所以这儿一句都不用发：把那个地址原样过去就是了。
       先前这一版按"落进一格临时内存再取地址"写，方言当场拦住了
       （`这个指针指向 jnc$variant，写进去的是 jnc$variant*`）—— 腿是最后一道闸门，
       这一笔记在 ADR-0016 第一百七十三刀那一节里。
       附带的好处：不用 `ecOut`，所以惰性位置（`&&` 的右边、`? :` 的两支）上照样过得去。 */
    return v.code;
  }

  /**
   * 一格 `variant_t` **从宿主面回来**（第一百七十四刀）：按内存回的那一格变成**最前面一个**
   * 指针形参、被调的那个函数自己回 `void`。
   *
   * 这条也不是我们定的约定，是 jancy 自己的调用约定里那一段 ——
   *
   *     // jnc_ct_CdeclCallConv_arm.cpp:71-80
   *     if (returnType->getFlags() & TypeFlag_StructRet) {
   *       if (returnType->getSize() > m_retCoerceSizeLimit) { // return in memory
   *         argCount++;
   *         typeRwi[0] = returnType->getDataPtrType(DataPtrKind_Thin)->getLlvmType();
   *         j = 1;
   *         returnType = m_module->m_typeMgr.getPrimitiveType(TypeKind_Void);
   *
   * `variant_t` 正是"按内存回"的那一档（`TypeFlag_StructRet` 在那张 `StructFlags` 里，
   * jnc_ct_TypeMgr.cpp:1716-1721；arm 那一支的 `m_retCoerceSizeLimit` 是 0，64 字节铁定超），
   * 而 `j = 1` 那一句说的就是**缓冲区那格摆在对象那格之前**。于是 `Owner.m` 在 C 那边是
   * `void Owner_m(jnc_Variant* ret, void* self, …)`。
   *
   * "先要一格缓冲区、再调、再把那格地址当值用"是**三句话**，而 `expr` 这一层回的是一格值 ——
   * 用 variantTy 那一族现成的办法：**一个符号发一格包装函数**（`jnc$vret$<符号>`）。好处与
   * `varBox` 那几格一样：调用点仍旧只是一格 `(call …)`，所以惰性位置（`&&` 的右边、`? :` 的
   * 两支）上照样过得去，不占第五十八刀那条语句落点。
   */
  hostVretFn(sym, slots) {
    const name = `jnc$vret$${sym}`;
    if (this.varFns.has(name)) return name;
    this.variantTy();
    const vt = `(ptr ${VARIANT})`;
    const ps = slots.map((s, i) => `(a${i} ${s})`).join(' ');
    const as = slots.map((s, i) => ` (var a${i})`).join('');
    this.decls.push(`  (fn ${name} (${ps}) ${vt}\n`
      + `    (let v ${vt} (pnew ${vt} (int 1)))\n`
      + `    (expr (ccall ${sym} (var v)${as}))\n`
      + '    (ret (var v)))');
    this.varFns.add(name);
    return name;
  }

  /**
   * jancy 的**全局 CRT** 那一族（第一百七十六刀）。
   *
   * 出处：jancy 的 std 扩展库随身带一份**源码** `std_globals.jnc`，并且**自动 import** ——
   *
   *     // jnc_std_StdLib.cpp:906-931
   *     JNC_LIB_SOURCE_FILE("std_globals.jnc", g_std_globalsSrc)
   *     …
   *     JNC_LIB_IMPORT("std_globals.jnc")
   *
   * 里头那些没有体的声明由 `JNC_MAP_FUNCTION` 接到 C/C++ 的实现上（同文件:834-895）。所以
   * 「每个模块都看得见 `rand` / `isdigit` / `toupper`」不是内建，是那一份隐式的 import。
   *
   * 这一刀落**字符那一族与 `rand`**（都不碰指针，所以没有胖指针 / GC 那些分岔）：
   *
   *   - `rand()`：jancy 的文档写着 "Maps directly to standard C function ``rand``"
   *     （std_globals.jnc:387-391），扩展库那一行也是 `JNC_MAP_FUNCTION("rand", ::rand)` ——
   *     所以这儿发的就是一句 `(ccall rand i32 ())`，一等的照抄。
   *   - 八个 `isXXX(utf32_t) -> bool` 与 `toupper` / `tolower`：**不发 `(ccall …)`**。
   *     jancy 那边接的是它自己的 Unicode 函数（`enc::isSpace` / `enc::toUpper` 那一族），
   *     而 C 库的 `isspace` / `toupper` 是按 locale 的单字节表 —— 名字一样、答案在 ≥128 的码点上
   *     不一样。所以这一层自己发一格按 **ASCII** 判的助手，并且把这条分岔记成账
   *     （ADR-0016 第一百七十六刀）：ASCII 那一段两边逐个相同，≥128 的码点上这一层一律答 false /
   *     原样返回，而 jancy 会按 Unicode 表答。语料里这一族全部用在 ASCII 上。
   *
   * 回 `undefined` 表示"这个名字不在这一族里"（调用方接着报"没有这个函数"）。
   */
  crtCall(n, nm) {
    const spec = CRT_CHAR.get(nm);
    if (spec === undefined && nm !== 'rand') return undefined;
    const args = this.flat(n.items[2]);
    if (nm === 'rand') {
      if (args.length !== 0) {
        return this.err(n, `'rand' 不带实参，这里给了 ${args.length} 个`);
      }
      if (!this.cabiNames.has('rand')) {
        this.decls.push('  (cabi rand i32 ())');
        this.cabiNames.add('rand');
        this.cabiSigs.set('rand', { ret: 'i32', params: [], sym: 'rand' });
      }
      return { code: '(ccall rand)', type: J_I32 };
    }
    if (args.length !== 1) {
      return this.err(n, `'${nm}' 收 1 个实参，这里给了 ${args.length} 个`);
    }
    let v = this.expr(args[0], J_U32);
    if (v === null) return null;
    if (jncIsEnum(v.type)) v = { code: v.code, type: v.type.base };
    if (!isInt(v.type)) {
      return this.err(n, `'${nm}' 的实参要一格整数（码点），这里是 ${tyName(v.type)}`);
    }
    return { code: `(call ${this.crtCharFn(nm, spec)} ${intConv(v, J_U32).code})`, type: spec.ret };
  }

  /** 上面那一族各发一格助手函数，一个名字一格。判据全在 ASCII 表上，见 crtCall 的注释。 */
  crtCharFn(nm, spec) {
    const name = `jnc$crt$${nm}`;
    if (this.varFns.has(name)) return name;
    this.varFns.add(name);
    this.decls.push(`  (fn ${name} ((c int)) ${slotText(spec.ret)}\n    (ret ${spec.body}))`);
    return name;
  }

  /**
   * 顶层那格只有原型的函数的调用点（第一百八十五刀）。与类里那些（hostMethodCall）逐条同一套
   * 检查，只少一格 `this`：符号名是这条声明的**全名**把 `$` 换成 `_`（`doc.sessionDispatch`
   * -> `doc_sessionDispatch`），实参与返回照 C_ABI 那几个词过，`variant_t` 那两头走
   * 第一百七十三 / 一百七十四刀那两条。
   */
  hostTopCall(n, fn, sig, oi = 0) {
    /* 同名那一族里第二条及以后的（第一百九十四刀）：符号名加 `_o2` / `_o3` …，与类里那几条
       原型（第一百八十六刀）是同一条规则 —— jancy 那边它们本来也各是一个 C 函数
       （`JNC_MAP_OVERLOAD`）。 */
    const sym = `${sig.sym === undefined || sig.sym === null ? fn.replace(/\$/g, '_') : sig.sym}`
      + `${oi > 0 ? `_o${oi + 1}` : ''}`;
    const vret = isVar(sig.ret);
    const rw = vret ? 'void' : this.cabiWordOfJnc(sig.ret, true);
    if (rw === null) {
      return this.nope(n, `'${shown(fn)}' 的返回类型 ${tyName(sig.ret)}`
        + '（落不进 C_ABI 的那几个词）');
    }
    const args0 = this.flat(n.items[2]);
    const args = sig.defs === null ? args0 : this.withDefaults(args0, sig.params, sig.defs, null);
    if (args === null) return null;
    const va = sig.variadic === true;
    if (va ? args.length < sig.params.length : args.length !== sig.params.length) {
      return this.err(n, va
        ? `'${shown(fn)}' 至少要 ${sig.params.length} 个定参，这里给了 ${args0.length} 个`
        : `'${shown(fn)}' 要 ${sig.params.length} 个实参，这里给了 ${args0.length} 个`);
    }
    const words = vret ? ['ptr'] : [];
    const parts = [];
    const slots = [];
    for (let i = 0; i < args.length; i++) {
      /* 变参那一段没有声明的类型可对（第一百九十五刀）：C 的默认实参提升说了算，与
         `ccallSite` 那一处（`with "h.h"` 收来的变参声明）逐条一样 —— bool 在 C 里会被
         提升成 int，而这一层没有那一步，所以明说不收、让人写个 `(int)`。 */
      if (i >= sig.params.length) {
        let ev = this.expr(args[i], null);
        if (ev === null) return null;
        if (ev.type.k === 'bool') {
          return this.err(args[i], `'${shown(fn)}' 的第 ${i + 1} 个实参落在变参那一段，`
            + '而 bool 在 C 里会被提升成 int —— 这一层没有那一步，写 `(int)` 转一下');
        }
        const ew = isVar(ev.type) ? 'ptr' : this.cabiWordOfJnc(ev.type, false);
        if (ew === null) {
          return this.nope(args[i], `'${shown(fn)}' 的第 ${i + 1} 个实参的类型 `
            + `${tyName(ev.type)} 落在变参那一段（落不进 C_ABI 的那几个词）`);
        }
        if (isVar(ev.type)) {
          const pv = this.hostVariantArg(args[i], ev);
          if (pv === null) return null;
          parts.push(pv);
          slots.push(`(ptr ${VARIANT})`);
        } else {
          parts.push(ev.code);
          slots.push(slotText(ev.type));
        }
        continue;
      }
      const w = isVar(sig.params[i]) ? 'ptr' : this.cabiWordOfJnc(sig.params[i], false);
      if (w === null) {
        return this.nope(n, `'${shown(fn)}' 的第 ${i + 1} 个形参的类型 `
          + `${tyName(sig.params[i])}（落不进 C_ABI 的那几个词）`);
      }
      let v = this.expr(args[i], sig.params[i]);
      if (v === null) return null;
      if (isInt(v.type) && isInt(sig.params[i])) v = intConv(v, sig.params[i]);
      if (!this.assignOk(v.type, sig.params[i])) {
        return this.err(args[i], `'${shown(fn)}' 的第 ${i + 1} 个实参要 `
          + `${tyName(sig.params[i])}，这里是 ${tyName(v.type)}`);
      }
      words.push(w);
      slots.push(isVar(sig.params[i]) ? `(ptr ${VARIANT})` : slotText(sig.params[i]));
      if (isVar(sig.params[i])) {
        const pv = this.hostVariantArg(args[i], v);
        if (pv === null) return null;
        parts.push(pv);
      } else parts.push(v.code);
    }
    if (!this.cabiNames.has(sym)) {
      /* 变参那一格写在声明里（第一百九十五刀）：`(cabi f R (T ...))` —— 与 `with "h.h"`
         收来的那些同一个形状（见 impDecls 那一处）。 */
      const ws0 = va ? [...words, '...'] : words;
      this.decls.push(`  (cabi ${sym} ${rw} (${ws0.join(' ')}))`);
      this.cabiNames.add(sym);
      this.cabiSigs.set(sym, { ret: rw, params: words, variadic: va, sym });
    }
    if (vret) {
      return { code: `(call ${this.hostVretFn(sym, slots)}${parts.map((p) => ` ${p}`).join('')})`, type: sig.ret };
    }
    return {
      code: `(ccall ${sym}${parts.map((p) => ` ${p}`).join('')})`,
      type: sig.ret,
    };
  }

  /** 宿主面那张表里有没有这个名字（第一百八十七刀）：`base` 是方言里那个名字（重载改名过的
   *  末尾带 `$oN`），而 `hostSigs` 的键是"主人$方法名"。 */
  hostSibling(base) {
    const b = /\$o[0-9]+$/.test(base) ? base.slice(0, base.lastIndexOf('$')) : base;
    const sigs = this.hostSigs.get(b);
    return sigs !== undefined && sigs.length > 0;
  }

  /**
   * 上面那一格的重试（第一百八十六刀）：`nm` 这个名字在**宿主面**那张表里也有几条时，按宿主面
   * 那条路（hostMethodCall）再挑一次。回 `undefined` 表示"那张表里没有"（调用方接着发它自己的
   * 诊断）；回 null 表示**试过了、那一处已经报过**（调用方就别再报第二句）。
   *
   * `self` 是**已经求过值**的那一格（调用方那儿算出来的），所以这儿把它照原样包成一格值传下去
   * —— 不再走 `baseVal`，免得把左边那个表达式求两遍（`f().m(x)` 那种）。`hostMethodCall` 只拿
   * `bv.type` 挑主人，所以类型写成那个主人的类就是对的。
   */
  protoHostRetry(n, nm, self) {
    const b = /\$o[0-9]+$/.test(nm) ? nm.slice(0, nm.lastIndexOf('$')) : nm;
    const i = b.lastIndexOf('$');
    if (i < 0) return undefined;
    const sigs = this.hostSigs.get(b);
    if (sigs === undefined || sigs.length === 0) return undefined;
    const owner = b.slice(0, i);
    return this.hostMethodCall(n, null, new Set([owner]), b.slice(i + 1),
      { code: self, type: tClass(owner, false) });
  }

  /**
   * 顶层那一格的重试（第二百三十六刀）：`nm` 这个名字**带体的那几条**都对不上，而它在宿主面
   * 那张表（`hostTopSigs`）里还有几条时，按宿主面那条路（`hostTopCall`）再挑一次。
   * 回 `undefined` 表示那张表里没有（调用方接着发它自己的诊断）；回 null 表示**试过了、
   * 那一处已经报过**。与类里那一格 `protoHostRetry` 是同一条路，只差"主人"那一段。
   */
  hostTopRetry(n, nm) {
    const sigs = this.hostTopSigs.get(nm);
    if (sigs === undefined || sigs.length === 0) return undefined;
    const tp = this.hostPickSigs(n, shown(nm), sigs);
    if (tp === null) return null;
    return this.hostTopCall(n, nm, tp.sig, tp.i);
  }

  hostPick(n, owner, mn, sigs) {
    return this.hostPickSigs(n, `${shown(owner)}.${mn}`, sigs);
  }

  /** 上面那一步与顶层那几条原型（第一百九十四刀）共用的一段 —— 只差话里那个名字怎么写。 */
  hostPickSigs(n, label, sigs, args0 = null) {
    if (sigs.length === 1) return { sig: sigs[0], i: 0 };
    // 实参那一串：调用点那两处从 `n` 上摊，construct 那一处（第二百〇七刀）直接给
    const args = args0 === null ? this.flat(n.items[2]) : args0;
    const given = args.length;
    const fits = [];
    for (let i = 0; i < sigs.length; i++) {
      const sg = sigs[i];
      const opt = sg.defs === null || sg.defs === undefined
        ? 0 : sg.defs.filter((d) => d !== null).length;
      // 变参那一条（第一百九十五刀）：定参之后给多少个都算合得上
      if (sg.variadic === true) {
        if (given >= sg.params.length) fits.push(i);
        continue;
      }
      if (given >= sg.params.length - opt && given <= sg.params.length) fits.push(i);
    }
    if (fits.length === 1) return { sig: sigs[fits[0]], i: fits[0] };
    if (fits.length === 0) {
      return this.err(n, `'${label}' 那几条原型收的实参个数是 `
        + `${sigs.map((sg) => sg.params.length).join(' / ')}，这里给了 ${given} 个`);
    }
    const tys = args.map((a) => this.cheapTy(a));
    if (tys.some((t) => t === null)) {
      return this.nope(n, `'${label}' 那几条同元的原型：第 `
        + `${tys.findIndex((t) => t === null) + 1} 个实参的类型这一层还得先降一遍才知道`
        + '（同元重载要按参数类型挑，见 ADR-0016 第八十刀）');
    }
    let best = -1;
    let bestScore = 0;
    let tie = false;
    for (const i of fits) {
      const want = sigs[i].params;
      let score = 5;
      // 变参那一段没有形参可对（第一百九十五刀）：只按定参排
      for (let k = 0; k < tys.length && k < want.length; k++) {
        const one = this.argCost(tys[k].ty, want[k], tys[k].lit);
        if (one < score) score = one;
      }
      if (score === 0) continue;
      if (score === bestScore) tie = true;
      if (score > bestScore) { bestScore = score; best = i; tie = false; }
    }
    if (best === -1) {
      return this.err(n, `'${label}' 那 ${fits.length} 条原型没有一条收得下这几个实参`
        + `（${tys.map((t) => tyName(t.ty)).join(', ')}）`);
    }
    if (tie) {
      return this.nope(n, `'${label}' 那几条同元的原型在这一句上分不出来`
        + `（${tys.map((t) => tyName(t.ty)).join(', ')} 对两条一样合得上）`);
    }
    return { sig: sigs[best], i: best };
  }

  hostMethodCall(n, callee, owners, mn, selfVal = null) {
    const some = [...owners][0];
    if (selfVal === null && head(callee) !== 'field') {
      return this.err(n, `'${shown(some)}.${mn}' 要一个对象来调它`);
    }
    let bv = selfVal;
    if (bv === null) {
      const ob = callee.items[1];
      // `.` 的左边读出来那一格（第一百一十六刀抽成一处，属性走取值器）
      bv = this.baseVal(ob);
    }
    if (bv === null) return null;
    /* 结构体也算（第一百九十七刀）：`struct Guid` 的三个方法在 jancy 那边就是宿主实现的
       （jnc_std_Guid.cpp:28-31）。它那一格里放的**本来就是地址**（第十二刀），所以 self 过
       C_ABI 时与类那一格一样是 `ptr`。结构体没有基类链，所以主人那一步只按它自己那个名字认。 */
    const structSelf = bv.type.k === 'struct';
    if (!isClass(bv.type) && !structSelf) {
      return this.err(n, `'${tyName(bv.type)}' 不是类，上面问不出方法 '${mn}'`);
    }
    /* 主人按**对象**认（第一百六十八刀）：同一个方法名可以在好几个 `opaque class` 上各声明一条
       （`setOptions` 在 `ui.FlagProperty` 与 `ui.EnumProperty` 上都有，ui_PropertyGrid.jnc:145/334）。
       先前 `hostFns` 一个名字只记一格主人，后声明的盖掉前面的 —— 于是 `enumProp.setOptions(…)` 按
       `FlagProperty` 那一条查型、发的还是 `FlagProperty_setOptions`，是个静默的错答案（逐份榜上
       88 处报的"第 1 个实参要 ui.FlagPropertyOption*，这里是 ui.ListItem*"就是它）。
       这儿先看对象自己那个类，再往基类走 —— 与普通方法查名同一条路。 */
    let owner = owners.has(bv.type.name) ? bv.type.name : null;
    if (owner === null && !structSelf) {
      for (const o of owners) if (this.isBase(o, bv.type.name)) { owner = o; break; }
    }
    if (owner === null) {
      return this.err(n, `'${tyName(bv.type)}' 上没有方法 '${mn}'（同名那几条声明在`
        + `${[...owners].map((o) => ` '${shown(o)}'`).join('、')} 上）`);
    }
    const sigs = this.hostSigs.get(`${owner}$${mn}`);
    if (sigs === undefined || sigs.length === 0) {
      return this.nope(n, `'${shown(owner)}.${mn}'（这个方法的原型没收下来）`);
    }
    /* 同名那几条（第一百七十一刀，把第一百六十四刀那条"挑不出"换成真的挑）：先按个数筛、
       再按实参类型排，规矩与普通重载那一处（pickOverload）逐条一样 —— 问不出实参类型的
       明说不收（第八十刀那条：绝不猜）。 */
    const pick = this.hostPick(n, owner, mn, sigs);
    if (pick === null) return null;
    const sig = pick.sig;
    const symSuffix = pick.i === 0 ? '' : `_o${pick.i + 1}`;
    /* `sym` 写着的就用它（第二百〇六刀）：那是 `alias dispose = hide;` 那一格 —— 名字是
       `dispose`，而库里那个符号叫 `Owner_hide`。 */
    const sym = sig.sym === undefined || sig.sym === null
      ? `${owner.replace(/\$/g, '_')}_${mn}${symSuffix}` : sig.sym;
    /* 回一格 `variant_t`（第一百七十四刀）：照 jancy 自己的调用约定 —— 缓冲区那格摆在最前面、
       被调的函数回 void（见 hostVretFn）。别的类型照旧问 C_ABI 那张表。 */
    const vret = isVar(sig.ret);
    const rw = vret ? 'void' : this.cabiWordOfJnc(sig.ret, true);
    if (rw === null) {
      return this.nope(n, `'${shown(owner)}.${mn}' 的返回类型 ${tyName(sig.ret)}`
        + '（落不进 C_ABI 的那几个词）');
    }
    const args0 = this.flat(n.items[2]);
    /* 默认值在**声明那一头**的作用域里折（第一百〇五刀那条口径）：宿主面那一头就是那个类。 */
    const args = sig.defs === null || sig.defs === undefined ? args0
      : this.withDefaults(args0, sig.params, sig.defs, owner);
    if (args === null) return null;
    if (args.length !== sig.params.length) {
      return this.err(n, `'${shown(owner)}.${mn}' 要 ${sig.params.length} 个实参`
        + `${sig.defs === null || sig.defs === undefined ? '' : `（其中 ${sig.defs.filter((d) => d !== null).length} 个有默认值）`}`
        + `，这里给了 ${args0.length} 个`);
    }
    const words = vret ? ['ptr', 'ptr'] : ['ptr'];
    const parts = [bv.code];
    const slots = [slotText(bv.type)];
    for (let i = 0; i < args.length; i++) {
      /* `variant_t` 那一格过去的是地址（第一百七十三刀）；别的类型照旧问 C_ABI 那张表。 */
      const w = isVar(sig.params[i]) ? 'ptr' : this.cabiWordOfJnc(sig.params[i], false);
      if (w === null) {
        return this.nope(n, `'${shown(owner)}.${mn}' 的第 ${i + 1} 个形参的类型 `
          + `${tyName(sig.params[i])}（落不进 C_ABI 的那几个词）`);
      }
      let v = this.expr(args[i], sig.params[i]);
      if (v === null) return null;
      if (isInt(v.type) && isInt(sig.params[i])) v = intConv(v, sig.params[i]);
      if (!this.assignOk(v.type, sig.params[i])) {
        return this.err(args[i], `'${shown(owner)}.${mn}' 的第 ${i + 1} 个实参要 `
          + `${tyName(sig.params[i])}，这里是 ${tyName(v.type)}`);
      }
      words.push(w);
      slots.push(isVar(sig.params[i]) ? `(ptr ${VARIANT})` : slotText(sig.params[i]));
      if (isVar(sig.params[i])) {
        const pv = this.hostVariantArg(args[i], v);
        if (pv === null) return null;
        parts.push(pv);
      } else parts.push(v.code);
    }
    /* 一个符号只发一句声明（方言那侧重复声明是错）。 */
    if (!this.cabiNames.has(sym)) {
      this.decls.push(`  (cabi ${sym} ${rw} (${words.join(' ')}))`);
      this.cabiNames.add(sym);
      this.cabiSigs.set(sym, { ret: rw, params: words, sym });
    }
    if (vret) {
      return { code: `(call ${this.hostVretFn(sym, slots)} ${parts.join(' ')})`, type: sig.ret };
    }
    return { code: `(ccall ${sym} ${parts.join(' ')})`, type: sig.ret };
  }

  /**
   * 宿主面 construct 的实参（第一百六十二刀）。回 `{sym, vals}`：符号名与已经查过型的那几格
   * 实参；说不通时发诊断回 null。签名是**声明**里那一份（`hostCtorSigs`），与方法那一格
   * （hostMethodCall）逐字同一套检查 —— 落不进 C_ABI 那几个词的明说不收，不猜。
   */
  hostCtorArgs(n, cls, argNodes) {
    const sigs = this.hostCtorSigs.get(cls);
    if (sigs === undefined || sigs.length === 0) {
      return this.nope(n, `造一格 '${shown(cls)}' —— 它那格 construct 的形参表没收下来`
        + '（体在宿主的 C/C++ 那边，opaque.rst:15-29）');
    }
    /* 同名好几条 construct（第二百〇七刀）：挑哪一条与顶层那几条原型共用同一段
       （先按个数筛、再按实参类型排，问不出类型的明说不收 —— 第八十刀那条）。 */
    const pickC = this.hostPickSigs(n, `${shown(cls)}.construct`, sigs, argNodes);
    if (pickC === null) return null;
    const sig = pickC.sig.params;
    /* 默认值在**声明那一头**的作用域里折（第一百〇五刀那条口径）：宿主面那一头就是那个类。 */
    const cds = pickC.sig.defs === undefined ? null : pickC.sig.defs;
    const argNodes2 = cds === null ? argNodes
      : this.withDefaults(argNodes, sig, cds, cls);
    if (argNodes2 === null) return null;
    if (argNodes2.length !== sig.length) {
      return this.err(n, `'${shown(cls)}' 的 construct 要 ${sig.length} 个实参`
        + `${cds === null ? '' : `（其中 ${cds.filter((d) => d !== null).length} 个有默认值）`}`
        + `，这里给了 ${argNodes.length} 个`);
    }
    const sym = `${cls.replace(/\$/g, '_')}_construct${pickC.i > 0 ? `_o${pickC.i + 1}` : ''}`;
    const words = ['ptr'];
    const vals = [];
    for (let i = 0; i < argNodes2.length; i++) {
      const w = isVar(sig[i]) ? 'ptr' : this.cabiWordOfJnc(sig[i], false);
      if (w === null) {
        return this.nope(n, `'${shown(cls)}' 的 construct 的第 ${i + 1} 个形参的类型 `
          + `${tyName(sig[i])}（落不进 C_ABI 的那几个词）`);
      }
      let v = this.expr(argNodes2[i], sig[i]);
      if (v === null) return null;
      if (isInt(v.type) && isInt(sig[i])) v = intConv(v, sig[i]);
      if (!this.assignOk(v.type, sig[i])) {
        return this.err(argNodes2[i], `'${shown(cls)}' 的 construct 的第 ${i + 1} 个实参要 `
          + `${tyName(sig[i])}，这里是 ${tyName(v.type)}`);
      }
      words.push(w);
      if (isVar(sig[i])) {
        const pv = this.hostVariantArg(argNodes2[i], v);
        if (pv === null) return null;
        vals.push({ code: pv, type: tPtr(this.variantTy()) });
      } else vals.push(v);
    }
    if (!this.cabiNames.has(sym)) {
      this.decls.push(`  (cabi ${sym} void (${words.join(' ')}))`);
      this.cabiNames.add(sym);
      this.cabiSigs.set(sym, { ret: 'void', params: words, sym });
    }
    return { sym, vals };
  }

  ccallSite(n, nm, sig) {    const args = this.flat(n.items[2]);
    const va = sig.variadic === true;
    if (va ? args.length < sig.params.length : args.length !== sig.params.length) {
      return this.err(n, va
        ? `'${nm}' 至少要 ${sig.params.length} 个定参，这里给了 ${args.length} 个`
        : `'${nm}' 要 ${sig.params.length} 个实参，这里给了 ${args.length} 个`);
    }
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      /* 变参那一段没有声明的类型可对 —— C 的默认实参提升说了算（整数、real、地址）。
         方言那一侧 `(ccall …)` 会再查一遍，那儿才是最后一道。 */
      const w = i < sig.params.length ? sig.params[i] : 'ptr';
      const want = CABI_WANT.get(w);
      let v = this.expr(args[i], want === undefined ? null : want);
      if (v === null) return null;
      if (i >= sig.params.length) {
        if (v.type.k === 'bool') {
          return this.err(args[i], `'${nm}' 的第 ${i + 1} 个实参落在变参那一段，`
            + '而 bool 在 C 里会被提升成 int —— 这一层没有那一步，写 `(int)` 转一下');
        }
        parts.push(v.code);
        continue;
      }
      if (w === 'ptr') {
        if (!isInt(v.type) && !jncIsPtr(v.type) && v.type.k !== 'string' && !isArr(v.type)) {
          return this.err(args[i], `'${nm}' 的第 ${i + 1} 个实参是 C 的指针，`
            + `这里是 ${tyName(v.type)}`);
        }
      } else {
        if (isInt(v.type) && isInt(want)) v = intConv(v, want);
        if (!this.assignOk(v.type, want)) {
          return this.err(args[i], `'${nm}' 的第 ${i + 1} 个实参要 ${w}（C 那边这么声明的），`
            + `这里是 ${tyName(v.type)}`);
        }
      }
      parts.push(v.code);
    }
    const ret = CABI_RET.get(sig.ret);
    /* 发的是**真的 C 符号名**（`as g` 那一路上 `nm` 带着前缀，那是这一侧的名字）。 */
    const sym = sig.sym === undefined ? nm : sig.sym;
    return {
      code: `(ccall ${sym}${parts.length === 0 ? '' : ` ${parts.join(' ')}`})`,
      type: ret === undefined ? J_I64 : ret,
    };
  }

  /**
   * `import "libfoo.dylib" as g`（**没有** `with`）里 `g.foo(…)` 的调用点（J4d）。
   *
   * 一个类型都不知道，所以按**实参**推一份签名出来：整数 -> `i64`、`real` -> `f64`、
   * 字符串与指针 -> `ptr`，返回值当 `i64`。这是 ffi 那一族的常规做法，也是 ADR-0022 里
   * 说的那条 —— 不强制写声明，但**报一条 warning**：推错了那一端会当场崩，而"权利和方便
   * 留给使用者"的前提是他知道自己在赌什么。要准就写 `with "h.h"`（那才是查得到的出处）。
   */
  ccallGuess(n, nsName, sym) {
    const args = this.flat(n.items[2]);
    const parts = [];
    const words = [];
    for (const a of args) {
      const v = this.expr(a, null);
      if (v === null) return null;
      const k = v.type === null || v.type === undefined ? '?' : v.type.k;
      const w = k === 'int' ? 'i64'
        : k === 'real' ? 'f64'
          : (k === 'string' || k === 'ptr' || k === 'tptr' || k === 'arr') ? 'ptr' : null;
      if (w === null) {
        return this.err(a, `${nsName}.${sym}：${tyName(v.type)} 这一格猜不出 C 那边要什么`
          + ' —— 写 `import … with "头文件"`，或者手写一句声明');
      }
      words.push(w);
      parts.push(v.code);
    }
    /* 同一个名字调两次只发一句声明（方言那侧重复声明是错）。第二次起签名必须一样 ——
       不一样就说明两个调用点对它的类型看法不同，那正是该报出来的事。 */
    const key = `${nsName}.${sym}`;
    const was = this.cabiSigs.get(key);
    if (was === undefined) {
      this.warn(n, `${nsName}.${sym}(…)：这个库是 \`as ${nsName}\` 进来的、没有头文件，`
        + `所以签名是**从调用点猜的**（(${words.join(' ')}) -> i64）。`
        + `猜错了那一端会崩 —— 要准就写 import "…" with "头文件"`);
      this.decls.push(`  (cabi ${sym} i64 (${words.join(' ')}))`);
      this.cabiNames.add(sym);
      this.cabiSigs.set(key, { ret: 'i64', params: words, sym });
    } else if (was.params.join(' ') !== words.join(' ')) {
      return this.err(n, `${nsName}.${sym}：前一个调用点猜的是 (${was.params.join(' ')})，`
        + `这一个是 (${words.join(' ')}) —— 两处对不上，写一句声明说清`);
    }
    return {
      code: `(ccall ${sym}${parts.length === 0 ? '' : ` ${parts.join(' ')}`})`,
      type: J_I64,
    };
  }

  /**
   * `with "h.h"` 收来的一格常量当值用（ADR-0022 的 J4d）。不认识这个名字就回 null ——
   * 那时候上面那句「未声明的变量」是对的。
   *
   * 类型按**值**挑，与整数字面量同一条规矩（`intLit`）：装得进 32 位就是 `int`，
   * 装不进是 `long`。这一点与 C 那边宏的类型不完全一样（C 的 `#define A 0x4000` 参与
   * 运算时按 `int` 走），但方言里 `int` 就是 64 位，而 jnc 的 32/64 只影响溢出与除法 ——
   * 挑小的那一格才与"人手写这个字面量"完全同形。
   */
  cconstLit(n, nm) {
    const c = this.cconsts.get(nm);
    if (c === undefined) return null;
    if (c.kind === 'str') return { code: `(str ${JSON.stringify(c.value)})`, type: J_STR };
    if (c.kind === 'real') return { code: `(real ${jncRealText(c.value)})`, type: J_REAL };
    const v = c.value;
    if (v >= -0x80000000n && v <= 0x7fffffffn) return { code: `(int ${v})`, type: J_I32 };
    return { code: `(int ${v})`, type: J_I64 };
  }

  expr0(n, want) {    if (isStr(n)) return { code: `(str ${JSON.stringify(n.value)})`, type: J_STR };
    // 相邻字面量的拼接（第五十四刀）：`"a" "b"` 在**编译期**折成一格字面量，
    // 与 C 一样（jancy 的 `literal` 就是 `literal_atom+`，见 jnc.grammar 那处注释）。
    if (isList(n) && head(n) === 'concat') {
      const s = litFold(n);
      if (s === null) return this.nope(n, `字面量拼接里的${this.litWhy(n)}`);
      return { code: `(str ${JSON.stringify(s)})`, type: J_STR };
    }
    if (isAtom(n)) return this.numLit(n);
    if (!isList(n)) return this.err(n, '认不出的表达式');
    const h = head(n);
    switch (h) {
      case 'true': return { code: '(bool true)', type: J_BOOL };
      case 'false': return { code: '(bool false)', type: J_BOOL };
      case 'null': {
        // `null` 自己没有类型。左边知道要什么时就用它；不知道时（比如 `x == null` 里
        // x 是整数）当场说清，而不是随便挑一个。
        // 类引用也是一种"指针"（第五十二刀）：`C* p = null` 与 `p == null` 都要它。
        if (want !== null && want !== undefined && isClass(want)) {
          return { code: `(pnull (ptr ${clsRoot(want.name)}))`, type: want };
        }
        /* `variant_t data = null`（第一百一十三刀，语料里 8 处）：一格**空**的 variant，
           标签 0。这一条要在这儿而不是在 expr 那两条装箱规则里 —— `null` 自己没有类型，
           走不到"v.type 是什么"那一步。 */
        if (isVar(want)) {
          this.variantTy();
          return { code: `(call ${this.varBox('0', V_NULL, null, null)})`, type: this.variantTy() };
        }
        /* 函数值那一格（第一百四十三刀量出来、第一百七十五刀兑掉）：方言这一侧**已经有**
           "空的那一格" —— `(null (fnty …))`（sexpr/lower.js:2418-2437，方言那边的第三十三刀），
           OIR 的 `NullFn` 六条腿都认（JS `null`、C `NULL`、LLVM `null`、两个解释器的 `null`、
           MIR 的 `K.nul`）。上一版那句"还没有空的那一格"写在方言长出这一格之前，是**过期的账**。
           语料里的形状：`void function* onTriggered() = null`（ui_Action.jnc:39）。 */
        if (want !== null && want !== undefined && isFn(want)) {
          return { code: `(null ${tyText(want)})`, type: want };
        }
        /* `null` 当一格 `string_t`（第一百六十五刀）：语料里的原样是
           `storage.writeString($"%1-key-%2"(name, i), null);`（ui_Dictionary.jnc:64 —— 那一格形参
           声明的就是 `string_t`）。jancy 的 `string_t` 是一格带指针的结构（`jnc_String`），null
           进去就是"指针那格是空的那一种字符串"。这一层不用另造一格：**字符串槽的零值本来就是
           `(str "")`**（见 jncZeroText —— `string_t s;` 那一格出来的就是它），而这一层可观测的三件事
           （长度、当条件用、印出来）在"空的"与"零长"上一模一样（第一百四十六刀那条 `slen != 0`）。
           所以这儿回同一格零值，不是替 jancy 猜一个新语义。 */
        if (want !== null && want !== undefined && want.k === 'string') {
          return { code: '(str "")', type: J_STR };
        }
        if (want === null || want === undefined || !jncIsPtr(want)) {
          return this.err(n, 'null 得从左边知道自己是哪种指针（这里问不出来）');
        }
        return { code: `(pnull ${tyText(want)})`, type: want };
      }
      case 'name': {
        const nm = n.items[1].value;
        const r = this.lookupRef(nm);
        if (r === null) {
          // 方法体里裸写的字段名（第五十二刀）：与写法可写的那一侧同一份（见 nameLv）。
          if (this.selfField(nm) !== null) return this.load(n, this.nameLv(n, nm));
          const fq = this.resolve(nm, (k) => this.fns.has(k));
          // 函数名当值用（第五十五刀）：那就是一格函数指针。方法要一个对象才拼得出那一格
          // （闭包里捕的是它），方法体里裸写的名字捕的是 `this` —— 与 `foo()` 补 this 同一条。
          // 重载过的名字**取不出一格函数值**（第七十九刀）：一族里挑哪一条由那一格函数指针的
          // 类型说，而这里左边要什么还没传下来。jancy 那边靠 getFunctionPtrCastKind 排序挑。
          if (fq !== null && this.overloads.has(fq)) {
            return this.nope(n, `把重载过的名字 '${shown(fq)}' 当函数值用（挑哪一条要看`
              + '左边那格函数指针的类型，这一层还传不下来）');
          }
          if (fq !== null) return this.fnValue(n, fq, null);
          // 属性（第六十八刀）：源码里它长得像变量，所以这一问排在"查不着变量、也不是
          // 函数名"之后。读它就是调取值器。方法体里裸写的属性名走 propBare（第六十九刀）：
          // 那一条连基类链一起找，`this` 由 propGet 那一处补上。
          const pq = this.propBare(nm);
          if (pq !== null) return this.propGet(n, pq);
          // 裸写一格字段路径别名（第一百〇四刀）：读那一侧（写那一侧在 nameLv）
          const apr = this.selfPathLv(nm);
          if (apr !== null) return this.load(n, apr);
          // 裸写一格位域（第一百一十二刀）：同样是读那一侧
          const bpr = this.selfBitLv(nm);
          if (bpr !== null) return this.load(n, bpr);
          // 无名枚举漏出来的那些成员（第九十六刀）：`enum { A = 1 }` 之后裸写 `A`。
          const ex = this.exposedLit(nm);
          if (ex !== null) return ex;
          // `with "h.h"` 收来的常量（第 J4d 刀）：宏与枚举常量在这儿变成一格字面量。
          const cv = this.cconstLit(n, nm);
          if (cv !== null) return cv;
          // 同上（第二百三十五刀）：那格声明自己没成，别把一件事记成好几笔
          if (this.badNames.has(nm)) {
            return this.err(n, `'${nm}' 那格声明自己没成（上面那一句已经报过）—— 名字写着，`
              + '可它一格都没登记上，所以这儿用不上它');
          }
          return this.err(n, `未声明的变量 '${nm}'`);
        }
        // 它在方言里叫什么：见 lvalue 那一处同一句
        const dn = r.dname === nm ? this.dialectName(nm) : r.dname;
        // 结构体那一格里放的就是地址（第十二刀），所以它不走 lifted 那条路。
        // 数组同理（第二十刀）：那一格里放的是**一整块**的地址，`&a` 就是它自己。
        if (jncIsStruct(r.type) || isArr(r.type)) {
          return { code: `(var ${dn})`, type: r.type };
        }
        // 提到堆上的那些名字要 pload 一次（第九刀）。模块级的那一半是第二十四刀，
        // 它的"那一格"就是全局自己（发成了 `(ptr T)`），所以不用 cellName。
        if (r.global) {
          if (this.gLifted.has(dn)) return { code: `(pload (var ${dn}))`, type: r.type };
          return { code: `(var ${dn})`, type: r.type };
        }
        if (this.lifted.has(nm)) {
          return { code: `(pload (var ${this.cellName(nm)}))`, type: r.type };
        }
        return { code: `(var ${dn})`, type: r.type };
      }
      // `this`（第五十二刀）：方法体里的第一个形参那一格，值就是对象那段内存的地址。
      case 'this': return this.load(n, this.lvalue(n));
      case 'char': return this.charLit(n);
      case 'binary': return this.binary(n);      case 'unary': return this.unary(n, want);
      case 'indirect': {
        /* `operator *`（第一百三十四刀）：`*it` 里 it 是一格带这个算符的类 / 结构体就调它，
           整格的值与类型都由它给 —— 语料里那一句是 `T* p = *it;`（stdt_HashTable.jnc:107），
           所以 `*it` **就是**算符回的那格指针，不是"再解引用一次"。
           这一问要排在 derefLv 之前（那儿只会报"`*` 要一个指针"），而左边算过一遍之后
           不能再让 derefLv 算第二遍 —— 所以走 ptrLv 那条共用的尾巴。
           整份文件里一个这样的算符都没有时（243 份里 242 份）连这一步都不进。 */
        if (this.opUnary.size > 0) {
          const v = this.expr(n.items[1], null);
          if (v === null) return null;
          const od = this.opUnaryCall(v, 'mul');
          if (od !== undefined) return od;
          const lv = this.ptrLv(n, v);
          return lv === null ? null : this.load(n, lv);
        }
        return this.load(n, this.derefLv(n));
      }
      case 'index': {
        // 索引属性的读（第七十刀）：`p[i][j]` 是"调取值器、下标当实参"，不是解引用。要排在
        // derefLv 之前问 —— 那儿只会报"下标要一个指针"。
        const ig = this.propIndexGet(n);
        if (ig !== undefined) return ig;
        /* 下标算符（第一百三十八刀）：`c[i]` 里 c 是一格带裸写 `get` 的类 / 结构体就调它。
           同样要排在 derefLv 之前，而左边算过一遍之后不能再算第二遍 —— 走 subLv 那条共用的
           尾巴。整份文件里一个下标算符都没有时连这一步都不进。 */
        if (this.opIndex.size > 0) {
          const b = this.expr(n.items[1], null);
          if (b === null) return null;
          const oi = this.opIndexOf(b.type);
          if (oi !== undefined && oi.get !== undefined) return this.opIndexCall(n, oi.get, b, null);
          const lv = this.subLv(n, b);
          return lv === null ? null : this.load(n, lv);
        }
        return this.load(n, this.derefLv(n));
      }
      case 'ptr-field': return this.load(n, this.fieldLv(n, n.items[1], n.items[2]));
      case 'field': {
        const ob = n.items[1];
        // `Color.Red` —— 枚举成员（第三十九刀）。要在把左边当变量算之前拦下来：
        // jancy 的枚举成员藏在枚举自己的命名空间里（type_enum.rst:17），所以左边是**类型名**，
        // 不是一格值。值在编译期就定了，发出去的就是一个字面量。
        const em = this.enumMember(n, ob, n.items[2]);
        if (em !== undefined) return em;
        /* 无名枚举漏到某一层命名空间里的成员（第九十六刀）：`ns.Inner` 整体是**一个名字**。
           要排在"把左边当值算"之前 —— 左边那个 `ns` 不是一格值。 */
        const dn = this.dotted(n);
        const ex = dn === null ? null : this.exposedLit(dn);
        if (ex !== null) return ex;
        // `flags.ReadOnly` —— 左边是一格**枚举的值**（第四十七刀）。要排在下面那两支之前：
        // 枚举不是结构体，走到 lvalue 那儿只会报"'.' 的左边不是结构体"。
        const ev = this.enumValueMember(n, ob, n.items[2]);
        if (ev !== undefined) return ev;
        // 命名空间里的属性（第六十八刀）：`cfg.level` 在语法这一层是一串 field，可它整体
        // 是**一个名字**。与枚举成员同一条理由 —— 要排在"把左边当值算"之前。
        const pf = this.propRef(n);
        if (pf !== null) return this.propGet(n, pf);
        if (isList(ob) && head(ob) === 'indirect') {
          return this.load(n, this.fieldLv(n, ob.items[1], n.items[2]));
        }
        // `c.m_a` —— 成员属性（第六十九刀）：读它就是调取值器，对象当第一个实参。要排在落到
        // lvalue 之前问：那儿只会报"没有这个字段"。与下面那条方法名同一个形状。
        if (isAtom(n.items[2]) && this.propNames.has(n.items[2].value)) {
          const pm = this.propMember(n, n.items[2].value);
          if (pm === null) return null;
          if (pm !== undefined) return this.propGet(n, pm.pn, pm.self);
        }
        // `c.foo` 当**值**用（第五十五刀）：右边那个名字是方法时，这一格是一格捕获了对象的
        // 函数指针 —— jancy 的 fat function pointer 正是"函数 + 那个对象"。要排在落到 lvalue
        // 之前问：那儿只会报"没有这个字段"。
        if (isAtom(n.items[2]) && this.methodNames.has(n.items[2].value)) {
          const mv = this.methodRef(n, n.items[2].value);
          if (mv !== undefined) return mv;
        }
        /* `string_t` 上那两格**公开**字段（第一百七十七刀）。jancy 的字符串是一格结构体，
           哪几格能直接读，它的源码里连注释一起写着 ——

               // jnc_ct_TypeMgr.cpp:2031-2039
               // m_p && m_length are accessible directly
               // (e.g.: string_t s; file.write(s.m_p, s.m_length);
               type->createField("m_p", getStdType(StdType_CharConstPtr), 0, ConstKind_ReadOnly);
               type->createField("!m_ptr_sz", getStdType(StdType_CharConstPtr));
               type->createField("m_length", getPrimitiveType(TypeKind_SizeT), 0, ConstKind_ReadOnly);

           带 `!` 的那一格是内部的（jancy 自己的约定：`!` 开头查不着名字），所以公开的就是
           `m_p` 与 `m_length`，两格都是**只读**的。
             - `m_length` 这一层答得出：`(slen …)` 就是它 —— 都是"按字节的长度"（第一百四十六刀
               那条 `if (s)` 用的也是它）。
             - `m_p` 答不出：那是一格指到**字节**上的 `char const*`，而这一层的 `char*` 指的是
               方言的整数格（一格 8 字节）—— 两边不是同一个东西，明说不收。 */
        if (isAtom(n.items[2]) && (n.items[2].value === 'm_length' || n.items[2].value === 'm_p')) {
          const ct = this.cheapTy(ob);
          if (ct !== null && ct.ty.k === 'string') {
            if (n.items[2].value === 'm_p') {
              return this.nope(n, '`string_t` 的 `m_p`（那是一格指到字节上的 `char const*`，'
                + '而这一层的 `char*` 指的是方言的整数格 —— 两边不是同一个东西）');
            }
            const sv = this.expr(ob, J_STR);
            if (sv === null) return null;
            return { code: `(slen ${sv.code})`, type: mkInt(64, true) };
          }
        }
        // `s.f` / `p.f` / `f().x` / `(new T { … }).x` 全落在 lvalue 那一支上：那儿算的是
        // "这个字段在哪一格内存里"，读一次就是这儿要的值（第十二刀 / 第二十五刀）。
        return this.load(n, this.lvalue(n));
      }
      case 'call': return this.callExpr(n);
      case 'new-array': return this.newPtr(n, n.items[1], n.items[2], null);
      // `new C1(100)` / `new C1 construct(100)` 的实参在 items[2]（第五十三刀）——
      // 语法上是同一条产生式，那个 `construct` 只是把"这括号是构造实参"写明白。
      case 'new': return this.newPtr(n, n.items[1], null, n.items[2] === undefined ? null : n.items[2]);
      // `f~(实参…)` —— 部分应用（type_ptr_function.rst 那句 "partial application"，
      // `foo~(10)`）。语法节点叫 `call-operator-new` 是照 jancy 自己的产生式起的，可它
      // 与 `new` 没关系：它造的是一格**新的函数指针**，捕获里多存了那几个已经绑住的实参。
      // 方言的 `(cfn …)` 说得出这件事，但得按"哪几个位置绑住了"当场抬一段 thunk —— 自己一格。
      case 'call-operator-new':
        return this.nope(n, '`~()` 的部分应用（要按绑住的实参当场抬一段 thunk）');
      // `new T { … }`（第二十五刀）：那几条语句抬成一个函数，项的值当实参传进去 ——
      // 于是它仍旧是一个表达式，惰性位置上也成立。见 newCurly。
      case 'new-curly': return this.newCurly(n, n.items[1], n.items[2]);
      // 格式化字面量（第六十四刀）：`$"i = $i"` 产出的是一格**动态**的字符串
      //（literals.rst:62）。三种注入都在 fmtLit 里，转换本身与 printf 同一份实现（fmtRun）。
      case 'fmt': return this.fmtLit(n, n.items[1], []);

      // `countof(a)`（第四十五刀）：编译期的元素个数，见 countof。
      case 'countof': return this.countofExpr(n, n.items[1]);
      // `sizeof(x)` 在 jancy 那边也是编译期常量（`type->getSize()`，
      // jnc_ct_OperatorMgr.cpp:952），可它给出的**字节数**是 jancy 自己那张表：
      // int8=1 / int16=2 / int32=4 / int64=8 / double=8（jnc_ct_TypeMgr.cpp:1727-1736）。
      // 方言这边一格整数一律 8 字节（hir/types.js:144，ADR-0016 决策二），于是
      // `sizeof(int)` 照 jancy 写是 4、照方言里真占的字节写是 8 —— 两个都不能算错。
      // 语料里 `sizeof(buffer) - 1` 当的是"这块内存有多大"，所以它必须与真布局一致；
      // 要两边同时对，得先让方言的布局认整数宽度。那是另一刀，这一刀先明说不收。
      case 'sizeof':
        return this.nope(n, 'sizeof —— 要方言的布局先认整数宽度（jancy 的 int 是 4 字节，方言这边一格 8 字节）');

      case 'cast': return this.cast(n, n.items[1], n.items[2]);
      case 'cond': return this.ternary(n, want);
      // `try E`（第五十八刀）：挡一层"抛"。jancy 那边它把底下那次抛接到自己那一格 phi 上，
      // 出错时整条表达式的值就是**那个出错值**（`endTryOperator`，Eh.cpp:207-244）——
      // 而这一层的调用回的正好是那个值，所以除了"别往上传"之外一个字都不用发。
      case 'try-expr': {
        this.shield++;
        const v = this.expr(n.items[1], want);
        this.shield--;
        return v;
      }
      case 'addr':
        return this.addrOf(n);
      // 赋值当表达式（第一百一十四刀）：`return m_currentIndex = insertItem(…)`。
      case 'assign':
        return this.asgnExpr(n);
      /* `x++` / `++x` 写在**表达式**里（第二百二十一刀）。语料里 20 份：post-inc 13、
         pre-inc 6、post-dec 1，原样是 `m_reportFieldEncoderArray[encoderIdx++].encode(…)`
         那一族。
         方言里 `++` 是**语句**（不取值），所以这一格要的正是 EC_HOIST 那条现成的路：
         把"旧值"（后缀）或"新值"（前缀）落成一格临时，自增那一句插到**这条语句之前**。
         插不进语句的位置照旧说清 —— 与 errorcode 那一处、带宽度的格式化字面量那一处
         是同一句话（那两处也走 ecOut）。
         次序是这一格的全部内容：后缀先落临时再自增，前缀先自增再落临时。 */
      case 'pre-inc': case 'post-inc': case 'pre-dec': case 'post-dec': {
        if (this.ecOut === null) {
          return this.nope(n, `这个位置上的 ${h}（要先把值落成一格局部量，而这儿插不进语句`
            + ' —— 见 EC_HOIST）');
        }
        const lv0 = this.lvalue(n.items[1]);
        if (lv0 === null) return null;
        /* 算符重载那一族（第一百三十一刀）先不收：它们是**两个函数**，而 `postfix operator ++`
           回的是旧值、前缀那个回的是新值（stdt_Iterator.jnc:44）—— 取值这一半要按哪个函数
           回什么来定，与内建那三种"自己读一遍"不是一条路。 */
        if (isClass(lv0.type) || jncIsStruct(lv0.type)) {
          return this.nope(n, `表达式里对 ${tyName(lv0.type)} 用 ${h} —— 那一族是算符重载`
            + '（两个函数，前缀回新值、postfix 回旧值），取值这一半要按调的是哪个函数来定');
        }
        const post = h === 'post-inc' || h === 'post-dec';
        const tmp = `$x${this.ecSeq++}`;
        const tt = slotText(lv0.type);
        if (post) this.ecOut.push(`${this.ecPad}(let ${tmp} ${tt} ${this.read(lv0)})`);
        const inc = this.exprStmt(n, this.ecPad.length);
        if (inc === null) return null;
        for (const l of inc) this.ecOut.push(l);
        if (!post) this.ecOut.push(`${this.ecPad}(let ${tmp} ${tt} ${this.read(lv0)})`);
        return { code: `(var ${tmp})`, type: lv0.type, hoisted: true };
      }
      /* 第二百一十四刀：`表达式 '…'` 这一行 35 份文件按真话拆开是四件事（与第二百一十二刀
         同一条法）。每一支的话里写清 jancy 那边落在哪儿，好让看榜的人知道该做哪个。 */
      case 'offsetof':
        /* `offsetof(BacNetMsTpHdr.m_crc)`（BacNetMsTp.jnc:74 / :164、test07.jnc:25、
           test76.jnc:26 —— 6 处 / 3 份）。jancy 那儿它回一格**编译期常量**：那格字段的
           `getFieldOffset()`（jnc_ct_OperatorMgr.cpp:1110-1113，实参不是字段就报
           "'offsetof' can only be applied to fields"）。可那是**字节**偏移，而方言这边一格
           就是 8 个字节、也不认字节偏移 —— 与 `sizeof` 那一行是同一笔账（方言的布局得先认
           整数宽度）。 */
        return this.nope(n, 'offsetof —— jancy 那儿它回那格字段的**字节**偏移'
          + '（编译期常量，jnc_ct_OperatorMgr.cpp:1110-1113），而方言这边一格就是 8 个字节、'
          + '也不认字节偏移（与 sizeof 那一行同一笔账）');
      case 'dynamic-sizeof': case 'dynamic-offsetof': case 'dynamic-countof':
        /* `dynamic sizeof(p)` / `dynamic offsetof(p)` / `dynamic countof(p)`
           （jnc_DynamicLayout.jnc 那一族，44 处）。这三个在 jancy 那儿**不是**编译期常量：
           它们落成一句运行期调标准库函数（StdFunc_DynamicSizeOf / DynamicOffsetOf /
           DynamicCountOf，jnc_ct_OperatorMgr.cpp:948-950 与 :1105-1106）。可那三个函数
           读的东西**都只是那格 fat 指针的 validator 范围**：
             dynamicSizeOf   = rangeEnd - p
             dynamicOffsetOf = p - rangeBegin
             dynamicCountOf  = dynamicSizeOf / 元素大小
           （jnc_rtl_CoreLib.cpp:52-69，三个函数一共 20 行）。
           方言的 fat 指针是三个字 `{addr, base, end}`（hir/types.js:87-88）—— 范围本来就在
           那儿。缺的是**"以字节算"那一头**：方言一格就是 8 个字节，`rangeEnd - p` 这个差
           在这儿数出来的不是 jancy 那个数。所以这三个与 `sizeof` 那一行是同一笔账
           （见 bad/dynamic-countof.jnc，第四十五刀就是这么记的）。 */
        return this.nope(n, `${h.replace('dynamic-', 'dynamic ')} —— jancy 那儿它是运行期调一格`
          + '标准库函数，而那函数读的只是 fat 指针的 validator 范围'
          + '（rangeEnd - p / p - rangeBegin / 再除元素大小，jnc_rtl_CoreLib.cpp:52-69）；'
          + '方言的 fat 指针 {addr, base, end} 里范围本来就在，缺的是"以字节算"那一头'
          + '（方言一格 8 字节）—— 与 sizeof 那一行同一笔账');
      case 'dynamic-cast':
        /* `dynamic (T*) p`（7 处）。jancy 那儿它走 `castOperator(OperatorDynamism_Dynamic, …)`
           （Expr.llk:692）—— 拿对象自己带着的类型信息在**运行期**判一次能不能转、不能就回
           null。这一层的对象上没有那格类型信息。 */
        return this.nope(n, 'dynamic (T*) 的转换 —— jancy 那儿它在运行期拿对象自己带的类型信息'
          + '判一次（Expr.llk:692 的 OperatorDynamism_Dynamic），这一层的对象上没有那格信息');
      case 'exprs-add':
        /* 逗号隔开的一串表达式。语料里这 3 处（test53.jnc:18、test84.jnc:5、
           72_StreamRegexSwitch.jnc:37）全是 `switch (state, string_t(p, 1))` —— jancy 那儿
           `switch` 的实参多于一个就是 **regex switch**（第一个实参是 `jnc.RegexState*`，
           Stmt.llk:192-198 那条 resolver），要一台 DFA 与一整套 case 上的正则。 */
        return this.nope(n, '逗号隔开的一串表达式（语料里全是 `switch (state, …)` —— jancy 那儿'
          + ' switch 的实参多于一个就是 **regex switch**，第一个实参是 `jnc.RegexState*`，'
          + 'Stmt.llk:192-198；那要一台 DFA）');
      case 'capture':
        /* `$0` / `$1`（70_RegexSwitch.jnc:58）：regex switch 里那台 DFA 匹配到的那一段。 */
        return this.nope(n, '`$0` 这种捕获 —— 它是 regex switch 里那台 DFA 匹配到的那一段，'
          + '要 regex switch 先落下来');
      default:
        return this.nope(n, `表达式 '${h}'`);
    }
  }

  /** `(indirect p)` / `(index p i)` 复用 lvalue 那一份 —— 读写两侧算的是同一个地址。 */
  derefLv(n) { return this.lvalue(n); }

  /**
   * `countof(a)`（第四十五刀）—— **编译期**的元素个数。
   *
   * jancy 那边一个字都不多做：`countofOperator` 拿操作数只为了问它的类型
   * （`prepareOperandType(..., OpFlag_LoadArrayRef)`），不是数组就报
   * "'countof' operator is only applicable to arrays"，是数组就
   * `setConstSizeT(getElementCount())` —— 一个 size_t 常量
   * （jnc_ct_OperatorMgr.cpp:963-986）。所以操作数**不求值**，这儿也不该发出它的代码。
   *
   * 于是只走 lvalue 那几种形状：那一族算的是"这个东西在哪一格内存里"，
   * 名字/下标/字段都是纯的（`a[0]` 这种多维的那一层正好在 lvalue 的 index 支上退一维）。
   * 别的形状（`countof(f())`、`countof(int)`）当场说不收，而不是求一遍值再把它丢掉。
   */
  countofExpr(n, x) {
    if (!isList(x)) return this.nope(n, 'countof 的操作数不是一个数组变量');
    const h = head(x);
    if (h === 'type-name' || h === 'fn-type') return this.nope(n, 'countof 作用在类型名上');
    if (h !== 'name' && h !== 'index' && h !== 'field' && h !== 'ptr-field' && h !== 'indirect') {
      return this.nope(n, `countof(${h} …) —— 只收名字/下标/字段这几种不用求值的形状`);
    }
    const lv = this.lvalue(x);
    if (lv === null) return null;
    // jancy 自己的那句话（jnc_ct_OperatorMgr.cpp:981）：只能作用在数组上。指针不算 ——
    // 指针要的是 `dynamic countof`（那要 fat 指针带的范围，还不收）。
    if (!isArr(lv.type)) {
      return this.err(n, `countof 只能作用在数组上，这里是 ${tyName(lv.type)}`);
    }
    if (lv.type.n === null) return this.err(n, 'countof 作用在长度还没定下来的数组上');
    // size_t —— 这个前端把它当 64 位（见 typeOf 里 `size_t` 那一行）。
    return { code: `(int ${lv.type.n})`, type: J_I64 };
  }

  /**
   * `&E`（第九刀）。**一条规则管全部**：`lvalue(E)` 已经把每种可写位置算成"名字"或
   * "一个指针"两类，而后者的 `code` **本来就是那个地址**。于是
   *
   *   &x        提到堆上的局部量  -> `(var x$c)`
   *   &*p                        -> `p`（一个字都不用发）
   *   &p[i]                      -> `(padd p i)`
   *   &p->f / &(*p).f            -> `(pfield p f)`
   *
   * 全都落在同一句上。走到 `var` 那一类说明取地址的那一遍没认出这个形状（见
   * collectAddrTaken：它只认直接写在 `&` 后面的名字），当场说清而不是发出错代码。
   */
  addrOf(n) {
    // `&a`（第二十刀）：数组那一格里放的**就是**一整块的地址，所以一个字都不用发 ——
    // 回来的类型是 `T(*)[N]`，在方言里与 `T[N]` 是同一个写法 `(ptr (blk T N))`。
    // 这一条要在 lvalue 之前：`a = b` 在那儿是拒的（数组之间没有赋值），而 `&a` 合法。
    const tgt = n.items[1];
    if (isList(tgt) && head(tgt) === 'name' && isAtom(tgt.items[1])) {
      const nm = tgt.items[1].value;
      const r = this.lookupRef(nm);
      // 模块级的数组也算（第二十四刀）：它那一格里放的同样是块地址（globalDecl 里的那句 pnew）
      if (r !== null && isArr(r.type)) {
        const dn = r.dname === nm ? this.dialectName(nm) : r.dname;
        return { code: `(var ${dn})`, type: tPtr(r.type) };
      }
    }
    const lv = this.lvalue(n.items[1]);
    if (lv === null) return null;
    if (lv.kind !== 'ptr') {
      // 结构体那一格的 code **就是**地址，所以 `&s` / `&a[i]` / `&s.in` 都不发一个字（第十二刀）
      if (lv.kind === 'agg') return { code: lv.code, type: tPtr(lv.type) };
      /* 一格位域没有自己的地址（第一百一十二刀）。jancy 自己也拒这一句 —— 它那边取地址回的是
         带 `PtrTypeFlag_BitField` 的数据指针，也就是"地址 + 哪几位"三样东西，而这一层的
         指针里只有地址。与第六十九刀"属性不是一格内存"是同一句话。 */
      if (lv.kind === 'bits') {
        return this.nope(n, '对一格位域取地址 —— 它没有自己的字节（jancy 那边那种指针里还带着'
          + '"哪几位"，这一层的指针里只有地址）');
      }
      // 标量的模块级变量走的是"提到一格自己的内存里"（第二十四刀，见 declareGlobal），
      // 所以能落到这儿的只剩方言放不进内存的那些类型（`string` 那一档）。
      if (lv.kind === 'var' && lv.global) {
        return this.nope(n, `对 ${tyName(lv.type)} 的模块级变量 '${lv.name}' 取地址`
          + '（要方言能把它当内存里的值，见 liftable 那处）');
      }
      return this.nope(n, `对这种形状取地址（'&' 后面只认名字、'*p'、'p[i]'、'p->f'）`);
    }
    return { code: lv.code, type: tPtr(lv.type) };
  }

  /**
   * 二元。这一层要分三件事，都得先知道两边的类型：
   *   - `p - q` 是**指针差**（按元素），`p + i` / `p - i` 是指针算术
   *   - `p == null` 是 `(pisnull p)`；方言里没有指针相等，所以 `p == q` 明着不收
   *   - 一边 int 一边 real 时把 int 那边加宽（jancy 与 C 同）
   */
  binary(n) {
    const op = isStr(n.items[1]) ? n.items[1].value : (isAtom(n.items[1]) ? n.items[1].value : null);
    if (op === null) return this.err(n, '认不出的二元算符');
    // jancy 自己的三条：`=~` / `!~`（正则）与 `@`（按位与的取反版）。方言里没有对应物。
    if (op === '=~' || op === '!~' || op === '@') return this.nope(n, `算符 '${op}'`);
    /* `&&` / `||`（第二百二十二刀把它们提到这儿单独一条路）：右边是**惰性**的，而右边可能有
       要插语句的东西（errorcode 的传播那两句）。与 `? :` 那一格是同一件事，落法也同一套 ——
       见 logicOp。 */
    if (op === '&&' || op === '||') return this.logicOp(n, op);
    // null 那一侧要从另一侧知道自己的类型，所以先降"不是 null"的那一边
    const lNull = isList(n.items[2]) && head(n.items[2]) === 'null';
    const rNull = isList(n.items[3]) && head(n.items[3]) === 'null';
    // `&&` / `||` 上面那条路已经接走了（第二百二十二刀），所以这儿的右边一律照常求值。
    const rhs = (want) => this.expr(n.items[3], want);
    let a = null;
    let b = null;
    if (lNull && !rNull) {
      b = rhs(null);
      if (b === null) return null;
      a = this.expr(n.items[2], b.type);
    } else {
      a = this.expr(n.items[2], null);
      if (a === null) return null;
      // 函数值那一格也要把类型传给 null（第一百四十三刀）：`cb == null` 里左边说得出它是
      // 什么，不传下去那边报的就是"问不出来"—— 又是一句认错人的话。真拦路的在方言那一侧。
      b = rhs((jncIsPtr(a.type) || isClass(a.type) || isFn(a.type)) && rNull ? a.type : null);
    }
    if (a === null || b === null) return null;
    /* 相等算符（第一百四十刀）：主人的类型上写了 `operator ==` / `!=` 就调它。要排在下面
       **类那一支之前** —— 那一支上类引用的 `==` 是"比是不是同一个对象"（peq），而写了算符的
       那一格上用户的意思是"问那个算符"（std_Guid 比的是四个字段）。与第一百三十九刀
       `operator bool` 那处是同一条口径：排错了就是静默的错答案。
       跟 `null` 比不走这条 —— 那一问在两边都是"这一格在不在"，与内容相等不是一件事。 */
    if ((op === '==' || op === '!=') && !lNull && !rNull && this.opCmp.size > 0) {
      const oc = (isClass(a.type) || jncIsStruct(a.type))
        ? this.opCmp.get(`${a.type.name}$op$${op === '==' ? 'eq' : 'ne'}`) : undefined;
      if (oc !== undefined) return this.opCmpCall(n, oc, a, b);
    }
    // 类引用的相等比较（第五十二刀）。jancy 的类指针**没有算术、没有大小比较**
    // （type_ptr_class.rst 开头那两句：不能对类指针做指针算术，有效性就是一次空检查），
    // 所以只有这两个算子 —— 落法与数据指针那一支同一条（pisnull / peq）。
    if (isClass(a.type) || isClass(b.type)) {
      if (op !== '==' && op !== '!=') return this.nope(n, `类引用上的 '${op}'`);
      let t = null;
      if (lNull !== rNull) t = `(pisnull ${lNull ? b.code : a.code})`;
      else if (!isClass(a.type) || !isClass(b.type)) {
        return this.err(n, `'${op}' 一边是类引用一边是 ${tyName(isClass(a.type) ? b.type : a.type)}`);
      } else if (!sameTy(a.type, b.type)) {
        return this.err(n, `'${op}' 两边不是同一个类：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
      } else t = `(peq ${a.code} ${b.code})`;
      return { code: op === '==' ? t : `(un "!" ${t})`, type: J_BOOL };
    }
    if (jncIsPtr(a.type) || jncIsPtr(b.type)) {
      if (op === '==' || op === '!=') {
        // 跟 null 比走 `pisnull`（一条指令），两个指针互比走方言新长出来的 `peq`。
        // 两条都是**有定义**的：arena 偏移与真地址都是标量，比相等在两套实现下一致。
        let t = null;
        if (lNull !== rNull) t = `(pisnull ${lNull ? b.code : a.code})`;
        else if (!jncIsPtr(a.type) || !jncIsPtr(b.type)) {
          return this.err(n, `'${op}' 一边是指针一边是 ${tyName(jncIsPtr(a.type) ? b.type : a.type)}`);
        } else if (!sameTy(a.type, b.type)) {
          return this.err(n, `'${op}' 两个指针不同型：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
        } else t = `(peq ${a.code} ${b.code})`;
        return { code: op === '==' ? t : `(un "!" ${t})`, type: J_BOOL };
      }
      if (op === '-' && jncIsPtr(a.type) && jncIsPtr(b.type)) {
        if (!sameTy(a.type, b.type)) {
          return this.err(n, `指针差要同型：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
        }
        return { code: `(psub ${a.code} ${b.code})`, type: J_I64 };
      }
      if ((op === '+' || op === '-') && jncIsPtr(a.type) && isInt(b.type)) {
        const d = op === '+' ? b.code : `(un "-" ${b.code})`;
        return { code: `(padd ${a.code} ${d})`, type: a.type };
      }
      // `i + p` 也成立（C 的规矩），但 `i - p` 不成立
      if (op === '+' && isInt(a.type) && jncIsPtr(b.type)) {
        return { code: `(padd ${b.code} ${a.code})`, type: b.type };
      }
      // 指针比大小（第四十六刀）。jancy 那边它就是"两个指针都转成 intptr 再比"
      // （`getPtrCmpOperatorOperandType` 回 TypeKind_IntPtr，jnc_ct_BinOp_Cmp.cpp:22-29），
      // 六个比较算子一起。
      //
      // 这一层**不**去比裸地址：方言刻意不给指针 `<` `>`，理由与我们拒 `%p` 是同一条 ——
      // 块之间的次序在 arena 与真地址两套实现下不一样。方言那处注释同时给了正路：
      //「那种比较只在同一块内有意义，而"是不是同一块"要用 `psub`（它会替你报错）」
      // （sexpr/lower.js:1761-1762）。所以 `p < q` 降成 `(psub p q) < 0`：
      //   - 同一块内：psub 是按元素的有符号差，符号就是次序，五条腿一致；
      //   - 跨块：psub 当场报运行期错 —— C 那边这是未定义行为（C99 6.5.8p5），
      //     我们把它变成一句能看见的错，比 UB 强。
      if ((op === '<' || op === '<=' || op === '>' || op === '>=')
        && jncIsPtr(a.type) && jncIsPtr(b.type)) {
        if (!sameTy(a.type, b.type)) {
          return this.err(n, `指针比大小要同型：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
        }
        return { code: `(bin "${op}" (psub ${a.code} ${b.code}) (int 0))`, type: J_BOOL };
      }
      return this.nope(n, `指针上的 '${op}'`);
    }
    // `bitflag enum` 上的位运算（第四十七刀）。两条规矩照抄 jancy 自己那两个函数
    // （jnc_ct_BinOp_Arithmetic.cpp:356-388）：
    //   - `&`：**任一边**是 bitflag 枚举，结果就是那个枚举
    //     （`getBitFlagEnumBwAndResultType`）—— 所以 `flags & 0x20` 与 `0x20 & flags` 都是枚举；
    //   - `|` / `^`：**两边都**得是 bitflag 枚举、且同型，结果才是那个枚举
    //     （`getBitFlagEnumBwOrXorResultType`；不同型就回 NULL，于是落回整数那条路）。
    // 值本身照基整数算：两边都是规范形，`& | ^` 在规范形上不会出范围，所以不用回卷。
    if (op === '&' || op === '|' || op === '^') {
      const ba = jncIsEnum(a.type) && a.type.bits === true;
      const bb = jncIsEnum(b.type) && b.type.bits === true;
      let et = null;
      if (op === '&') et = ba ? a.type : (bb ? b.type : null);
      else if (ba && bb && sameTy(a.type, b.type)) et = a.type;
      if (et !== null) {
        const x = intConv({ code: a.code, type: jncIsEnum(a.type) ? a.type.base : a.type }, et.base);
        const y = intConv({ code: b.code, type: jncIsEnum(b.type) ? b.type.base : b.type }, et.base);
        if (!isInt(x.type) || !isInt(y.type)) {
          return this.err(n, `'${op}' 的另一边要整数，这里是 ${tyName(isInt(a.type) || jncIsEnum(a.type) ? b.type : a.type)}`);
        }
        return { code: `(bin "${op}" ${x.code} ${y.code})`, type: et };
      }
    }
    const cmp = op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=';
    // 两个同型枚举比大小 / 相等：在基整数那一格上比（第三十九刀）。两边都是规范形，直接比就对。
    // 不同型的两个枚举、或枚举与整数混算，都先落到基整数上 —— 枚举 -> 整数是隐式的。
    if (jncIsEnum(a.type) || jncIsEnum(b.type)) {
      if (jncIsEnum(a.type) && jncIsEnum(b.type) && sameTy(a.type, b.type) && cmp) {
        return { code: `(bin "${op}" ${a.code} ${b.code})`, type: J_BOOL };
      }
      if (jncIsEnum(a.type)) a = { code: a.code, type: a.type.base };
      if (jncIsEnum(b.type)) b = { code: b.code, type: b.type.base };
    }
    // bool 参与整数运算（第三十七刀）。jancy 的提升表里 Bool1 与 Bool8 都落到 Int32
    //（jnc_ct_UnOp_Arithmetic.cpp:23 那张表的头两行），所以 `(a > 0) + 1` 是 int 上的加法。
    // 两个 bool 比相等是例外：方言的 bool 比较本来就精确，绕道整数没有意义。
    const bothBoolEq = a.type === J_BOOL && b.type === J_BOOL && (op === '==' || op === '!=');
    if (!bothBoolEq) {
      if (a.type === J_BOOL && (isInt(b.type) || b.type === J_BOOL)) {
        a = { code: `(sel ${a.code} (int 1) (int 0))`, type: J_I32 };
      }
      if (b.type === J_BOOL && isInt(a.type)) {
        b = { code: `(sel ${b.code} (int 1) (int 0))`, type: J_I32 };
      }
    }
    // 两边都是整数：先常用算术转换定出结果那一格，再看要不要回卷。
    if (isInt(a.type) && isInt(b.type)) {
      // 常用算术转换要**真的转**（第三十三刀）。以前两边都是有符号，规范形在更宽的格里是
      // 同一个数，所以不转也对；有了无符号之后那条不成立了 —— `int i = -1; unsigned u = 1;`
      // 里 `i < u` 在 C 与 jancy 里都是**假**（-1 转成 u32 是 4294967295），不转就成了真。
      // 移位是例外：结果那一格**只看左边**，右边不参与常用算术转换（C 的规矩，jancy 同）。
      const shift = op === '<<' || op === '>>';
      const rt = shift ? arith(a.type) : common(a.type, b.type);
      const x = intConv(a, rt);
      const y = shift ? intConv(b, arith(b.type)) : intConv(b, rt);
      // 64 位无符号那一格（第六十一刀）：它的规范形与有符号 64 位**位一模一样**，所以
      // 存放、传参、`+ - * & | ^ << == !=` 全都照旧；分岔的只有除、取余、右移与四个大小
      // 比较，换成方言里无符号那一版（`u/` `u%` `u>>` `u<` …）。
      // 窄的那几格**不用**换：intConv 已经把它们掩成非负数了，有符号的算子算出来就是对的。
      const uop = uOp(op, rt);
      const code = `(bin "${uop}" ${x.code} ${y.code})`;
      // 比较不用管宽度：转到同一格之后两边都是规范形，直接比就是对的。
      if (cmp) return { code, type: J_BOOL };
      // 会溢出的只有这五条；`% & | ^ >>` 在规范形上天然还在范围里，一个字都不用发。
      const over = op === '+' || op === '-' || op === '*' || op === '/' || op === '<<';
      return { code: over ? wrapTo(code, rt.w, rt.u) : code, type: rt };
    }
    // 一边整数一边 real：加宽整数那一边
    if (isInt(a.type) && b.type === J_REAL) a = { code: realOf(a.code, a.type), type: J_REAL };
    else if (a.type === J_REAL && isInt(b.type)) b = { code: realOf(b.code, b.type), type: J_REAL };
    if (!sameTy(a.type, b.type)) {
      return this.err(n, `'${op}' 两边不同型：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
    }
    /* 结构体之间没有算符（第一百一十三刀补的一个洞）。这一条**不是** variant 带来的 ——
       `S a, b; a + b` 先前就落到下面那句上，发出一句 `(bin "+" 地址 地址)`，然后在后端
       炸掉（`js.bin: + on struct`）。variant 让它变得容易碰上（`v1 + v2` 在 jancy 那边
       是**合法**的，落法是按两边的标签在运行期选一条算），所以在这儿说清。 */
    if (jncIsStruct(a.type)) {
      return this.nope(n, `'${op}' 的两边是 ${tyName(a.type)}（结构体之间没有算符；`
        + `${isVar(a.type) ? 'variant_t 上 jancy 那边是按两边的标签在运行期选一条算，那要一整张分派表' : '要就得自己写一个方法'}）`);
    }
    /* 函数值上的比较（第一百七十五刀）。收的是**跟 null 比**这一格，两个函数值互相比明说不收 ——
       这不是偷懒，是两边语义**真的不一样**：jancy 的比较把两边一起转成 `intptr_t`
       （`getPtrCmpOperatorOperandType`，jnc_ct_BinOp_Cmp.cpp:22-29，`TypeKindFlag_Ptr` 把函数指针
       也算进去），而"函数指针转整数"取的是**函数地址那一半**，闭包那一半不参与；这一层的函数值
       是一条闭包记录，`(bin "==" f g)` 比的是"是不是同一条记录"。于是"同一个方法绑在两个不同对象
       上"这一句：jancy 说相等，这一层说不相等。跟 null 比不受这条影响（空就是空），所以那一格收。
       比大小两边都没有（jancy 那边指针比大小也只在 `psub` 的意义上成立，这一层第 33 刀记过）。 */
    if (isFn(a.type)) {
      if (op !== '==' && op !== '!=') {
        return this.nope(n, `函数值之间的 '${op}'（只有 '==' / '!=' 成立）`);
      }
      if (!lNull && !rNull) {
        return this.nope(n, `两个函数值之间的 '${op}'（jancy 那边比的是函数地址那一半、`
          + '闭包那一半不参与，而这一层的函数值是一条闭包记录 —— 两边答得不一样，'
          + '所以这一格明说不收；跟 `null` 比是收的）');
      }
    }
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: cmp ? J_BOOL : a.type };
  }

  unary(n, want) {
    const op = isStr(n.items[1]) ? n.items[1].value : (isAtom(n.items[1]) ? n.items[1].value : null);
    const a0 = this.expr(n.items[2], op === '!' ? J_BOOL : want);
    if (a0 === null) return null;
    // 枚举落到基整数上再算（第四十七刀）：`getArithmeticOperatorResultType` 见到
    // TypeKind_Enum 就递归到基类型（jnc_ct_UnOp_Arithmetic.cpp:39）—— 二元那一侧第三十九刀
    // 已经这么做了，一元这一侧漏了。逼出它的是 `flags &= ~OpenFlags.Exclusive`
    //（type_enum.rst:87）：`~` 的操作数是个枚举成员。`!` 不走这儿（它要的是 bool，
    // truthy 那一处管）。
    const a = jncIsEnum(a0.type) && op !== '!' ? { code: a0.code, type: a0.type.base } : a0;
    if (op === '+') {
      // 一元加是恒等，但**带整型提升**（`char c; +c` 是 int）。提升在规范形里不发一个字。
      if (isInt(a.type)) return { code: a.code, type: arith(a.type) };
      if (a.type !== J_REAL) return this.err(n, `一元 '+' 要整数 / real，这里是 ${tyName(a.type)}`);
      return a;
    }
    if (op === '-') {
      // `char c = -128; -c` 还是 -128 吗？不是 —— 提到 int 之后是 128。回卷按**提升后**那一格。
      // 无符号那一格上 `-x` 是回卷出来的（`-(unsigned)1` 是 4294967295），同一句话管两边。
      if (isInt(a.type)) {
        const rt = arith(a.type);
        return { code: wrapTo(`(un "-" ${a.code})`, rt.w, rt.u), type: rt };
      }
      if (a.type !== J_REAL) return this.err(n, `一元 '-' 要整数 / real，这里是 ${tyName(a.type)}`);
      return { code: `(un "-" ${a.code})`, type: a.type };
    }
    if (op === '!') {
      // `!p` / `!n` 也成立（jancy 与 C 同）：先真值化再取反。
      const t = this.truthy(a, n.items[2]);
      if (t === null) return null;
      return { code: `(un "!" ${t.code})`, type: J_BOOL };
    }
    if (op === '~') {
      // 方言的 `un` 只有 `-` 与 `!`，但按位取反不用新形式：`~x` 就是 `x ^ -1`。
      // 有符号那一格不用回卷 —— 提升后那一格里的规范形取反还在同一格里（`~127` = -128）。
      // 无符号要回卷：`x ^ -1` 是负的，掩一下才回到 `2^w-1-x`（`~(unsigned)0` 是 4294967295）。
      if (!isInt(a.type)) return this.err(n, `'~' 要整数，这里是 ${tyName(a.type)}`);
      const rt = arith(a.type);
      const code = `(bin "^" ${a.code} (int -1))`;
      return { code: rt.u ? wrapTo(code, rt.w, true) : code, type: rt };
    }
    return this.nope(n, `一元 '${op}'`);
  }

  /**
   * `c ? a : b` -> `(sel c 甲 乙)`。方言这一刀刚长出 `sel`（惰性：只算取中的那一支），
   * 所以这里是一对一的映射，不用拆成临时量加 if —— 那种拆法只在语句位置成立。
   *
   * 两支的类型：jancy 与 C 一样会做常用算术转换，这一层只做 int -> real 那一步
   * （方言的 `sel` 要两支同型，而它刻意不推导）。
   */
  /**
   * `a && b` / `a || b`（第二百二十二刀）。两边各自真值化（jancy 与 C 同：`p && n` 合法），
   * 结果是 bool。**右边是惰性的**：方言的 `(bin "&&" …)` 本身就是惰性节点，所以只要右边不用
   * 插语句，这儿就照旧发一句 `(bin "&&" 甲 乙)` —— 一个字都不多发。
   *
   * 右边要插语句时（`setDeviceVidPid(vid, pid) && openDevice()` —— 两个都是 errorcode，
   * 传播那两句得插成语句）走与 `? :` 同一套落法：给结果开一格内存、把短路摊成一句 if，
   * 右边那几句插在**它自己那半**里。惰性一点没丢。
   */
  logicOp(n, op) {
    const a = this.expr(n.items[2], null);
    if (a === null) return null;
    const ta = this.truthy(a, n.items[2]);
    if (ta === null) return null;
    if (this.ecOut === null) {
      // 惰性位置（第五十八刀）：这儿插不进语句，右边落进去的 errorcode 调用当场说不收。
      const b0 = this.ecLazy(() => this.expr(n.items[3], null));
      if (b0 === null) return null;
      const tb0 = this.truthy(b0, n.items[3]);
      if (tb0 === null) return null;
      return { code: `(bin "${op}" ${ta.code} ${tb0.code})`, type: J_BOOL };
    }
    const savePad = this.ecPad;
    const bpad = `${savePad}    `;
    const saveOut = this.ecOut;
    this.ecOut = [];
    this.ecPad = bpad;
    const b = this.expr(n.items[3], null);
    const lines = this.ecOut;
    this.ecOut = saveOut;
    this.ecPad = savePad;
    if (b === null) return null;
    const tb = this.truthy(b, n.items[3]);
    if (tb === null) return null;
    if (lines.length === 0) {
      return { code: `(bin "${op}" ${ta.code} ${tb.code})`, type: J_BOOL };
    }
    const cell = `$l${this.ecSeq++}`;
    this.ecOut.push(`${savePad}(let ${cell} (ptr bool) (pnew (ptr bool) (int 1)))`);
    // 短路那一半先写定：`&&` 短路成 false、`||` 短路成 true。
    this.ecOut.push(`${savePad}(pstore (var ${cell}) (bool ${op === '&&' ? 'false' : 'true'}))`);
    const gate = op === '&&' ? ta.code : `(un "!" ${ta.code})`;
    this.ecOut.push(`${savePad}(if ${gate}`);
    this.ecOut.push(`${savePad}  (do`);
    for (const l of lines) this.ecOut.push(l);
    this.ecOut.push(`${bpad}(pstore (var ${cell}) ${tb.code})))`);
    return { code: `(pload (var ${cell}))`, type: J_BOOL, hoisted: true };
  }

  ternary(n, want) {
    const c = this.cond(n.items[1]);
    if (c === null) return null;
    /* 两支里有**要插语句**的东西时（第二百二十二刀）：`return m_state ? true : open();`
       —— `open()` 是 errorcode，传播那两句得插成语句，而这两支是**惰性**的（只算取中的那一
       支），插到"这条语句之前"就成了"无条件先调一遍"。先前这儿把落点关掉、当场说不收
       （榜上 `这个位置上的 errorcode 调用` 20 份里 18 份是这一种）。

       落法：给结果开**一格内存**（`(pnew (ptr T) (int 1))` —— 与第九刀把局部量提进内存、
       第二十四刀把取过地址的全局提进内存是同一件事，方言一个字没动），然后把整条 `? :` 摊成
       一句 `(if 条件 (do 甲那几句 (pstore 格 甲)) (do 乙那几句 (pstore 格 乙)))`，
       表达式本身回 `(pload 格)`。惰性一点没丢：每一支的语句都在**它自己那半**里。

       **只有真需要时才走这条路**：两支都没插出语句就照旧发 `(sel …)`（一个字都不多发），
       所以先前能编的程序一个字节都不变。 */
    if (this.ecOut !== null) {
      const savePad = this.ecPad;
      const bpad = `${savePad}    `;
      const arm = (node, w) => {
        const saveOut = this.ecOut;
        this.ecOut = [];
        this.ecPad = bpad;
        const v = this.expr(node, w);
        const lines = this.ecOut;
        this.ecOut = saveOut;
        this.ecPad = savePad;
        return v === null ? null : { v, lines };
      };
      const ra = arm(n.items[2], want);
      if (ra === null) return null;
      const rb = arm(n.items[3], want === null || want === undefined ? ra.v.type : want);
      if (rb === null) return null;
      if (ra.lines.length === 0 && rb.lines.length === 0) return this.selValue(n, c, ra.v, rb.v);
      const t = this.selValue(n, c, ra.v, rb.v, true);
      if (t === null) return null;
      const cell = `$s${this.ecSeq++}`;
      const ct = slotText(t.type);
      this.ecOut.push(`${savePad}(let ${cell} (ptr ${ct}) (pnew (ptr ${ct}) (int 1)))`);
      this.ecOut.push(`${savePad}(if ${c.code}`);
      this.ecOut.push(`${savePad}  (do`);
      for (const l of ra.lines) this.ecOut.push(l);
      this.ecOut.push(`${bpad}(pstore (var ${cell}) ${t.a.code}))`);
      this.ecOut.push(`${savePad}  (do`);
      for (const l of rb.lines) this.ecOut.push(l);
      this.ecOut.push(`${bpad}(pstore (var ${cell}) ${t.b.code})))`);
      return { code: `(pload (var ${cell}))`, type: t.type, hoisted: true };
    }
    // 两支是**惰性**的（第五十八刀）：只算取中的那一支，所以传播那两句插不到这条语句之前去。
    let a = this.ecLazy(() => this.expr(n.items[2], want));
    let b = this.ecLazy(() => this.expr(n.items[3],
      want === null || want === undefined ? (a === null ? null : a.type) : want));
    if (a === null || b === null) return null;
    return this.selValue(n, c, a, b);
  }

  /**
   * `? :` 两支的类型对齐 + 发那一句（第二百二十二刀把它从 ternary 里抽出来 —— 那儿现在有两条
   * 路，普通的一句 `(sel …)` 与"两支要插语句"那一格摊成的 if，两条用的是**同一套**对齐规矩）。
   *
   * `parts` 为真时只回对齐后的两支与结果类型（给摊成 if 的那条路用），不拼 `(sel …)`。
   */
  selValue(n, c, a0, b0, parts = false) {
    let a = a0;
    let b = b0;
    // 两支都是整数：结果是常用算术转换定出的那一格。有符号之间加宽在规范形里不发一个字，
    // 可换符号性要真的转（第三十三刀），所以这儿两支都过一遍 intConv。
    if (isInt(a.type) && isInt(b.type)) {
      const rt = common(a.type, b.type);
      const x = intConv(a, rt);
      const y = intConv(b, rt);
      return parts ? { a: x, b: y, type: rt } : { code: `(sel ${c.code} ${x.code} ${y.code})`, type: rt };
    }
    if (isInt(a.type) && b.type === J_REAL) a = { code: realOf(a.code, a.type), type: J_REAL };
    else if (a.type === J_REAL && isInt(b.type)) b = { code: realOf(b.code, b.type), type: J_REAL };
    if (!sameTy(a.type, b.type)) {
      return this.err(n, `'? :' 两支不同型：甲是 ${tyName(a.type)}，乙是 ${tyName(b.type)}`);
    }
    return parts ? { a, b, type: a.type } : { code: `(sel ${c.code} ${a.code} ${b.code})`, type: a.type };
  }

  /**
   * `basetype.成员`（第五十六刀 + 第九十四刀）。jancy 拿 `basetype` 与 `basetype1` .. `basetype9`
   * 指基类，用处是**构造**与**名字解析**（type_class.rst:226）。不带序号的就是第 1 格
   * （语法树里 `(basetype 1)`），`basetype2` 起指第二格往后的那些基类。
   *
   * 回的是方言里那个函数名 —— 静态绑定，`basetype.foo()` 说的就是"调基类那一个"。
   *
   * `cls` 是"从谁的基类里找"。写在方法体里时它是 `this` 那个类（默认）；跟在点后面的那一格
   * （`p.m_bucket.basetype.remove(…)`，第一百二十七刀）传的是**左边那个值**的类。
   */
  baseTarget(n, bt, mn, cls = this.selfClass) {
    const idx = isAtom(bt.items[1]) ? Number(bt.items[1].value) : 1;
    if (cls === null) return this.err(n, "'basetype' 只能写在方法体里");
    const dirs = this.dirBases(cls);
    if (dirs.length === 0) {
      return this.err(n, `${shown(cls)} 没有基类，'basetype' 指不着谁`);
    }
    if (idx < 1 || idx > dirs.length) {
      return this.err(n, `${shown(cls)} 只有 ${dirs.length} 格基类，`
        + `'basetype${idx}' 指不着谁`);
    }
    const base = dirs[idx - 1];
    if (mn === null) return this.nope(n, "'basetype' 后面那个成员认不出来");
    if (mn === 'construct') {
      const c = this.ctors.get(base);
      if (c !== undefined) return c.name;
      /* 基类那格 construct **在宿主那边**（第一百九十二刀）：`basetype.construct(strdjb2, streq)`
         （std_HashTable.jnc:185/191 那两处 —— 派生类的 ctor 里调基类的，而基类是个
         `opaque class`、它的 ctor 只有原型）。这一格与第一百八十七刀同一个形状：这儿回的是
         **一个名字**，放不下"改发 `(ccall Base_construct …)`"这件事，所以回一格哨兵、把是谁
         记在一边，调用点那儿改道。 */
      if (this.hostCtorSigs.has(base)) {
        this.baseHostCtor = base;
        return HOST_PICK;
      }
      return this.err(n, `${shown(base)} 没有 construct`);
    }
    const full = this.findMethod(base, mn);
    if (full === null) return this.err(n, `${shown(base)} 没有方法 '${mn}'`);
    // `basetype.foo()` 是静态绑定的，而 abstract 的那一个**没有实现**（第五十七刀）——
    // jancy 那句就是 "'%s' is abstract"（jnc_ct_OperatorMgr_Member.cpp:376）。
    if (this.virt.get(full) === 'abstract') {
      return this.err(n, `${shown(base)} 的 '${mn}' 是 abstract，basetype 调不着它（jancy 那句 `
        + '"\'%s\' is abstract"）');
    }
    return full;
  }

  callExpr(n) {
    const callee = n.items[1];
    // `$"…"(a, b)`：那对括号不是调用，是**格式化字面量自己的实参表**（Expr.llk:940 把它
    // 挂在 literal 上）。语法这一层它落成了一次调用，所以在这儿先认出来（第六十四刀）。
    const fl = fmtNode(n);
    if (fl !== null) return this.fmtLit(n, fl.tok, fl.args === null ? [] : this.flat(fl.args));
    // 从一格**函数指针**上调（第五十五刀）：`p(…)` 里的 p 是变量而不是函数名，那就是方言的
    // `(callfn …)`。这一问排在按名字找函数之前 —— 同名的局部量遮住模块级的那个函数。
    const fv = this.fnCallee(callee);
    if (fv !== undefined) return fv === null ? null : this.callThrough(n, fv);
    // 被调的**可以**是个限定名（`a.f()`，第五十一刀）：那在表达式里是一串 `field`，
    // 整体摊得动才算限定名，摊不动才是"取字段再调"（那一条还不收）。
    const nm0 = isList(callee) && (head(callee) === 'name' || head(callee) === 'field')
      ? this.dotted(callee) : null;
    if (nm0 === 'printf') return this.nope(n, '把 printf 的返回值当值用');
    let nm = nm0 === null ? null : this.resolve(nm0, (k) => this.fns.has(k));
    // 方法体里裸写基类的方法（第五十六刀）：类是一层命名空间，可**基类不是这一层的外层** ——
    // resolve 走的是命名空间的前缀，走不到基类那条链上，所以这儿沿链再问一遍。
    if (nm === null && nm0 !== null && !nm0.includes('.') && this.selfClass !== null) {
      nm = this.findMethod(this.selfClass, nm0);
    }
    // 方法调用（第五十二刀）：`c.foo(…)` 是 `C$foo(c, …)` —— 对象当第一个实参。
    // 名字这一层查不着、而 `.` 右边那个名字确实是某个类的方法时才去求左边的值，
    // 免得给"真的没有这个函数"多发一条诊断。
    let self = null;
    let statBind = false;      // `basetype.foo()` 是**静态**绑定的，不过分派那一格
    const mh = isList(callee) ? head(callee) : null;
    const mn = (mh === 'field' || mh === 'ptr-field') && isAtom(callee.items[2])
      ? callee.items[2].value : null;
    // `basetype.construct(…)` / `basetype.foo()`（第五十六刀，type_class.rst:226 与 :253）。
    // 要排在下面那条方法调用之前：`basetype` 不是一格值，求它会报错。它是**静态**绑定的
    // —— 说的就是"调基类那一个"，所以名字直接沿链取。
    if (nm === null && mh === 'field' && isList(callee.items[1])
      && head(callee.items[1]) === 'basetype') {
      const b = this.baseTarget(n, callee.items[1], mn);
      if (b === null) return null;
      /* 基类那格 construct **在宿主那边**（第一百九十二刀）：发一句
         `(ccall Base_construct $this 实参…)`。默认值、C_ABI 那几个词、`variant_t` 那两条都由
         `hostCtorArgs` 一并管了 —— 与 `new C(…)` 走的是**同一份**（第一百六十二刀那一处）。 */
      if (b === HOST_PICK) {
        const bc = this.baseHostCtor;
        this.baseHostCtor = null;
        const ha = this.hostCtorArgs(n, bc, this.flat(n.items[2]));
        if (ha === null) return null;
        return {
          code: `(ccall ${ha.sym} (var $this)${ha.vals.map((v) => ` ${v.code}`).join('')})`,
          type: J_VOID,
        };
      }
      nm = b;
      self = '(var $this)';
      statBind = true;
    }
    /* `x.basetype.m(…)`（第一百二十七刀）：跟在**点后面**的那一格 basetype —— 拿左边那个对象的
       基类那一面调。语料里 `p.m_bucket.basetype.remove(…)`（stdt_HashTable.jnc:155）就是它，
       用处是"绕过派生类的遮挡，调基类那一个"。与写在方法体里的 `basetype.m(…)` 是同一件事，
       只是 `this` 换成了左边那个值：一条继承链共用**一格**方言结构体（第五十六刀），所以
       "换一面"发的是**零条指令**，静态绑定这一条也照旧。 */
    if (nm === null && mh === 'field' && isList(callee.items[1])
      && head(callee.items[1]) === 'field' && isAtom(callee.items[1].items[2])
      && callee.items[1].items[2].value.startsWith('basetype')) {
      const w = callee.items[1].items[2].value;
      const ov = this.expr(callee.items[1].items[1]);
      if (ov === null) return null;
      if (!isClass(ov.type)) {
        return this.nope(n, `'${w}' 的左边不是一格类（这儿是 ${tyName(ov.type)}）`);
      }
      const sp2 = callee.span;
      const at = (v) => ({ kind: 'atom', value: v, span: sp2 });
      const bt = { kind: 'list', span: sp2, items: [at('basetype'), at(w === 'basetype' ? '1' : w.slice(8))] };
      const b = this.baseTarget(n, bt, mn, ov.type.name);
      if (b === null) return null;
      nm = b;
      self = ov.code;
      statBind = true;
    }
    if (nm === null && mn !== null && this.methodNames.has(mn)) {
      const m = this.methodCallee(n, callee, mn);
      if (m === null) return null;
      nm = m.name;
      self = m.self;
    }
    /* 第二百二十刀：`不是直接调一个名字的调用` 这一行 31 份按被调那一格的形状拆开是四件事。 */
    if (nm === null && nm0 === null) {
      const ih = isList(callee) && isList(callee.items[1]) ? head(callee.items[1]) : null;
      /* `typeof(EnumType).getValueName(…)`（13 份，NetSnifferLog 那一族按枚举把码翻成名字）：
         jancy 的 `typeof` 回一格**运行期的类型对象**（`jnc.Type*`，反射那一套），上面那些
         `getValueName` / `getDataPtrType` 是它的方法。这一层没有反射那张表。 */
      if (ih === 'typeof-expr') {
        return this.nope(n, '在 `typeof(…)` 上叫方法 —— jancy 的 typeof 回一格运行期的**类型'
          + '对象**（`jnc.Type*`，反射那一套），`getValueName` 那些是它的方法；这一层没有'
          + '反射那张表');
      }
      /* `(bar @ scheduler)(100)`（4 份）：jancy 的 `f @ scheduler` 是**换个地方跑**——
         把这次调用交给那格 scheduler（`jnc.Scheduler`，io_base 那一族的主线程调度器）。
         那要一格运行期的调度器。 */
      if (isList(callee) && head(callee) === 'binary'
        && (isAtom(callee.items[1]) || isStr(callee.items[1]))
        && callee.items[1].value === '@') {
        return this.nope(n, '`f @ scheduler` 这种调用 —— jancy 那儿它把这次调用交给那格'
          + ' scheduler 去跑（jnc.Scheduler），要一格运行期的调度器');
      }
      /* 剩下的都长一个样：`左边那一格.方法(…)`，而**那个方法名这一层一个类上都没见过**
         （`m_abr[0].close()`、`m_type.getDataPtrType(…).getTargetValueString(…)`、
         `((io.EthernetAddress const*)p).getString()`）—— 那些类在别的模块里。所以这不是
         "调用的形状不收"，是与 `没有这个类型` 同一笔**口径**账（逐份编，import 不着的那些）。
         左边是名字的时候上面那条路已经把话说准了（"X 没有方法 'm'"），这儿补的是"左边是一格
         算出来的值"那一半。 */
      if (mn !== null) {
        return this.nope(n, `在一格算出来的值上叫方法 '${mn}' —— 这个名字这一层一个类上都没`
          + '见过（那个类在别的模块里，与 `没有这个类型` 同一笔口径账）');
      }
      return this.nope(n, '不是直接调一个名字的调用');
    }
    /* 名字查不着，而它是某个 `opaque class` 上声明过的方法（第六十六刀 + ADR-0022 的 J4b）：
       那不是"没有这个函数"，是**实现在宿主那边** —— 发 `(ccall Owner_method self …)`。 */
    if (nm === null) {
      const hostOwners = mn === null ? undefined : this.hostFns.get(mn);
      if (hostOwners !== undefined) return this.hostMethodCall(n, callee, hostOwners, mn);
    }
    /* `with "h.h"` 收进来的那些（ADR-0022 的 J4d）：调用点发 `(ccall …)` 而不是
       `(call …)` —— 实参已经是机器值，不过 marshaler。实参与返回都按**声明**检查，
       签名是从头文件里收来的那一份（`cabiSigs`），不是从调用点猜的。 */
    /* 这一层自己**从原型发出去**的那些 C_ABI 符号不走这条路（第一百九十四刀）：符号名与源码里
       那个名字一模一样（顶层不带命名空间那种），于是第一次调用登记了 `cabiSigs` 之后，第二次
       调用就被这一格截走了 —— 那儿只比个数、不补默认值、也不认同名那一族，报的是
       "要 3 个实参，这里给了 1 个"。判据一句：这个名字是源码里的一条原型吗？是就归下面那条路。 */
    if (nm === null && nm0 !== null && this.cabiSigs.has(nm0)
      && this.resolve(nm0, (k) => this.protoFns.has(k)) === null) {
      return this.ccallSite(n, nm0, this.cabiSigs.get(nm0));
    }
    /* `import "libfoo.dylib" as g`（没有 `with`）：`g.foo(…)` 的类型从调用点猜，带 warning。 */
    if (nm === null && nm0 !== null && nm0.includes('.')) {
      const dot = nm0.lastIndexOf('.');
      const pre = nm0.slice(0, dot);
      if (this.cLibNs.has(pre)) return this.ccallGuess(n, pre, nm0.slice(dot + 1));
    }
    /* 从一格**函数指针的字段**上调（第一百一十七刀）：`c.m_f(3, 4)`，以及方法体里**裸写**
       字段名的 `m_op(a, b)`（那时 callee 是一格 `name`，`fnCallee` 那一支问的是 lookupRef，
       裸字段名不在里头）。
       排在这么后面是刻意的 —— 前面所有"按名字找"的路子都试过了，所以这一支不会把方法调用
       抢过来；而它要先求左边那个值（会发诊断），所以只在名字确实是一格函数指针字段时才走
       （`fnFieldNames`）。落法与从变量上调完全同一条：读出那一格，再 `callThrough`。 */
    if (nm === null && (mh === 'field' || mh === 'name')) {
      const fname = mh === 'field' ? mn : nm0;
      if (fname !== null && this.fnFieldNames.has(fname)) {
        const lv = this.lvalue(callee);
        if (lv === null) return null;
        if (isFn(lv.type)) return this.callThrough(n, { code: this.read(lv), type: lv.type });
      }
    }
    if (nm === null) {
      /* 名字查不着，可它在某个类 / 结构体体里**声明过**，只是没有带体的定义（第一百四十七刀）：
         那时"没有这个函数"是**认错人** —— 那个名字明明在。说法照抄第九十二刀给顶层原型定的
         那一句。主人不止一个就都列出来：这一层这时还不知道左边那个值是哪个类（问它要先求值，
         而求值会发诊断），所以**不挑一个说**，免得像第一百四十五刀量到的那样指着别的类。 */
      const bare = mn !== null ? mn
        : (nm0 !== null && !nm0.includes('.') && this.selfClass !== null ? nm0 : null);
      /* 方法体里**裸写**的宿主面方法（第一百七十刀）：`addPart(PartKind.Break, …)` 写在同一个
         `opaque class` 的另一个方法里（log_Representation.jnc:136 那一族，group 榜上 19 处）。
         上面那一问（hostFns）只走 `obj.m(…)` 那一种 —— 裸写时 `mn` 是 null，于是落到下面那句
         "原型没有带体的定义"。可这儿的 `this` 就是那个对象：主人是当前这个类（或它的基类）时，
         按宿主面那条路发，`self` 就是 `$this`。 */
      const hb = bare === null ? undefined : this.hostFns.get(bare);
      /* 结构体的方法体里裸写的也算（第一百九十七刀）：`struct Guid` 的 `construct` 里
         `parse(string)` 就是这个形状（std_Guid.jnc:77）。结构体没有基类链，所以只问自己那一格。 */
      if (hb !== undefined && this.selfClass !== null
        && (hb.has(this.selfClass)
          || (this.classes.has(this.selfClass)
            && [...hb].some((o) => this.isBase(o, this.selfClass))))) {
        return this.hostMethodCall(n, null, hb, bare,
          { code: '(var $this)', type: this.selfTy(this.selfClass) });
      }
      const owners = bare === null ? undefined : this.protoMethods.get(bare);
      if (owners !== undefined) {
        const who = [...owners].map((o) => `${shown(o)}.${bare}`).join(' / ');
        return this.nope(n, `原型 '${who}' 没有带体的定义（实现在宿主那边的走 opaque class`
          + ' 那条路，在别的模块里的要 import 得着）');
      }
      /* 顶层只有原型的函数（第一百五十一刀钉的界，第一百八十五刀兑掉）：`receive(p, size)`
         （ias.jnc:87 —— 体在宿主那边）。与类里那些同一条，只是名字不挂在类上，所以按命名空间
         从里往外解一次。 */
      const pf = nm0 === null ? null : this.resolve(nm0, (k) => this.protoFns.has(k));
      if (pf !== null) {
        const ts = this.hostTopSigs.get(pf);
        if (ts !== undefined) {
          const tp = this.hostPickSigs(n, shown(pf), ts);
          if (tp === null) return null;
          return this.hostTopCall(n, pf, tp.sig, tp.i);
        }
        return this.nope(n, `原型 '${shown(pf)}' 没有带体的定义（形参表这一层没收下来）`);
      }
      /* jancy 的**全局 CRT** 那一族（第一百七十六刀）：`rand` / `isdigit` / `toupper` …
         它们不是"内建"，是 jancy 的 std 扩展库随身带的一份**源码**
         （`JNC_LIB_SOURCE_FILE("std_globals.jnc", …)` + `JNC_LIB_IMPORT("std_globals.jnc")`，
         jnc_std_StdLib.cpp:906-931）—— 也就是每个模块都**隐式 import** 了那一份声明。
         所以这儿报"没有这个函数"是认错人：那些名字在 jancy 里明明是有的。 */
      const crt = nm0 === null || nm0.includes('.') ? undefined : this.crtCall(n, nm0);
      if (crt !== undefined) return crt;
      /* 左边是一格**值**，而它的类型上有 `operator ()`（第二百〇二刀）：那不是"没有这个函数"，
         是调用算符。语料里的原样是 `m_hash(key)`（stdt_HashTable.jnc:101）—— `m_hash` 是一格
         字段，类型是那个函子。排在最后：这一格问的是"名字查不着"之后的最后一种可能。 */
      const oc0 = this.opCallOf(callee);
      if (oc0 !== undefined) return this.opCallSite(n, oc0, callee);
      /* 左边是一格**类型**（第二百三十三刀）：`T(x)` 在 jancy 里是一格**构造式转换**，不是
         "没有这个函数" —— 那是认错人，名字明明在，只是它不是函数。
         榜上那一行的头名就是它：`string_t(p, length)`（std_String.jnc:33/96/117/162 那一族，
         量到 128 处）—— 从**一段字节**造一格字符串，那正是 `string_t` 的 `m_p` 那笔方言级的账
         （这一层的 `char*` 指的是方言的整数格，不是字节；见那一行的注）。所以这一格分两句说：
         string 那一种指着那笔账，别的种指着"构造式转换"这件事本身。 */
      const tnm = nm0 === null ? null : this.callTypeName(nm0);
      if (tnm !== null) {
        if (tnm === 'string') {
          return this.nope(n, '`string_t(指针, 长度)`：从一段**字节**造一格字符串 —— 与 '
            + '`string_t` 的 `m_p` 同一笔账（那是一格指到字节上的 `char const*`，'
            + '而这一层的 `char*` 指的是方言的整数格 —— 两边不是同一个东西）');
        }
        return this.nope(n, `'${shown(nm0)}' 是一格类型，`
          + '`类型(实参…)` 是 jancy 的**构造式转换**（要按目标类型挑一条转换，与 `(类型)值` '
          + '那种写法同一件事）—— 这一层只收 `(类型)值` 那一种');
      }
      return this.err(n, `没有这个函数：'${nm0}'`);
    }
    // 方法体里裸写 `foo()` 就是 `this.foo()`（类是一层命名空间，所以 resolve 已经找着了
    // `C$foo`）—— 这儿把 `this` 补上。
    const owner = this.methods.get(nm);
    if (owner !== undefined && self === null) {
      // 基类的方法也算（第五十六刀）：`this` 那一格在方言里与基类那一格同型（一条链共用
      // 一格结构体），所以补上去就是了。
      if (this.selfClass !== owner && !this.isBase(owner, this.selfClass)) {
        return this.err(n, `'${shown(nm)}' 是 ${shown(owner)} 的方法，要一个对象来调它`);
      }
      self = '(var $this)';
    }
    const args0 = this.flat(n.items[2]);
    /* 重载（第七十九刀）：这一族里按**给了几个实参**挑一条。排在这儿是因为 `self` 到这一步
       才定下来（方法体里裸写 `foo()` 那条也补好了 `this`），而方法的元数要减掉 this 那一格。
       挑完再往下走 —— 下面那一整段（默认值、个数、类型）一个字都不用改。 */
    if (this.overloads.has(nm)) {
      /* `hostOk` 那一格（第一百八十七刀）：带体的那几条都不合、而宿主面那张表里有同名的时，
         `pickOverload` **安静地**回一格哨兵（不发诊断），这儿改挑宿主面那条。这时候一个实参
         都还没降（`pickOverload` 只用 cheapTy 问类型、不降），所以不会把谁降两遍。 */
      const pick = this.pickOverload(n, nm, args0, self !== null, self !== null);
      if (pick === HOST_PICK) {
        const hr0 = this.protoHostRetry(n, nm, self);
        if (hr0 !== undefined) return hr0;
        return this.protoSiblingNope(n, nm, args0.length);
      }
      if (pick === null) return null;
      nm = pick;
    }
    const sig = this.fns.get(nm);
    const want = self === null ? sig.params : sig.params.slice(1);
    const defs = sig.defs === undefined || sig.defs === null ? null
      : (self === null ? sig.defs : sig.defs.slice(1));
    // 默认值在**声明那一头**的作用域里折（第一百〇五刀）：全名去掉最后一段就是那一头
    const cut = nm.lastIndexOf('$');
    const args = this.withDefaults(args0, want, defs, cut < 0 ? '' : nm.slice(0, cut));
    if (args === null) return null;
    if (args.length !== want.length) {
      /* 同名的还有只有原型的几条（第一百五十刀记的账，第一百八十六刀兑掉）：那几条的**体在宿主
         那边**（第一百八十三刀），所以"合得上的那一条"不是"不在表里"，是在**宿主面**那张表里。
         这儿按那张表再挑一次。

         为什么这一格是安全的（不会把该调的定义换成 ccall）：走到这儿说明**带体的那几条里没有
         一条收这么多个实参**（pickOverload 先按个数筛过），所以宿主面那张表里收这么多个的那一条
         必然没有对应的定义。而且这时候**一个实参都还没降**（下面那个循环才降），所以不会把谁
         降两遍。 */
      const hr = self === null ? this.hostTopRetry(n, nm) : this.protoHostRetry(n, nm, self);
      if (hr !== undefined) return hr;
      // 同名的还有只有原型的几条（第一百五十刀）：给了几个"不对"是拿不全的那张表数出来的
      if (this.protoSibling(nm)) return this.protoSiblingNope(n, nm, args0.length);
      return this.err(n, `'${nm0 === null ? shown(nm) : nm0}' 要 ${want.length} 个实参`
        + `${defs === null ? '' : `（其中 ${defs.filter((d) => d !== null).length} 个有默认值）`}`
        + `，这里给了 ${args0.length} 个`);
    }
    const parts = self === null ? [] : [self];
    /* 这一轮降实参之前先记一格水位（第一百八十八刀）：下面那一处要是改挑宿主面那条，就得把
       这几个实参**降出来的传播语句**（第五十八刀那条落点）退回去，不然它们会被发两遍。
       `decls` 那一侧不用退 —— 那儿的东西都按名字去重（`varBox` 那一族）。 */
    const ecMark = this.ecOut === null ? -1 : this.ecOut.length;
    for (let i = 0; i < args.length; i++) {
      let v = this.expr(args[i], want[i]);
      if (v === null) return null;
      // 实参与赋值同一条规矩：整数隐式转到形参那一格（窄了就回卷）。
      if (isInt(v.type) && isInt(want[i])) v = intConv(v, want[i]);
      if (!this.assignOk(v.type, want[i])) {
        /* 同名的还有只有原型的几条（第一百五十三刀）：那"要什么类型"是**另一条**的形参说的 ——
           合得上的那一条可能就在没进候选的那几条里。语料里 `copy(string)`（std_String.jnc:49，
           那个类写着四条 copy）报的是"第 1 个实参要 char*"，而 `copy(string_t)` 那一条明明在。
           与第一百五十刀那三处是同一笔账，只是这一处的出错口是**实参类型**而不是个数。 */
        /* 合得上的那一条可能在**宿主面**那张表里（第一百八十八刀）：走到这儿说明带体的那几条
           里挑出来的最合的那一条也收不下这个实参（pickOverload 先按类型排过），所以不会把
           "该调的定义"换成 ccall。退回那格水位再试。 */
        if (ecMark >= 0 && this.ecOut !== null) this.ecOut.length = ecMark;
        /* 传下去的是**这一句调用**那格节点（`hostMethodCall` 要从它身上取实参表）——
           不是 `args[i]`（那是其中一个实参，量出来过一次：那儿 `n.items[2]` 是 undefined）。 */
        const hr1 = self === null ? this.hostTopRetry(n, nm) : this.protoHostRetry(n, nm, self);
        if (hr1 !== undefined) return hr1;
        if (this.protoSibling(nm)) return this.protoSiblingNope(args[i], nm, args.length);
        return this.err(args[i], `'${nm0 === null ? shown(nm) : nm0}' 的第 ${i + 1} 个实参要 ${tyName(want[i])}，`
          + `这里是 ${tyName(v.type)}`);
      }
      parts.push(v.code);
    }
    // errorcode 那一位挂在**源码里写的那个函数**上，所以要在下面换名字之前问（换成分派那一段
    // 之后名字就不在 errFns 里了）。
    const ec = this.errFns.get(nm);
    // 虚方法：调的不是那一个实现，是按 `$tag` 挑实现的那一段（第五十七刀）。签名与被覆盖的
    // 那一个同型（vtCheck 管着这一条），所以上面那一遍实参照旧按 sig 对 —— 换名字放在最后，
    // 诊断里印的就还是源码里写的那个名字。
    if (!statBind && self !== null && this.virt.has(nm)) {
      const d = this.dispatch(nm);
      if (d === null) return null;
      nm = d;
    }
    const code = `(call ${nm}${parts.map((p) => ` ${p}`).join('')})`;
    if (ec !== undefined) return this.propagate(n, code, sig.ret, nm0 === null ? shown(nm) : nm0);
    if (sig.ret === J_VOID) return { code, type: J_VOID };
    return { code, type: sig.ret };
  }

  /**
   * 一次 errorcode 调用（第五十八刀）。三种去处：
   *
   *   - `try` 底下：什么都不插，调用本身就是那一格值。jancy 的 `try` 也不是"不检查" ——
   *     它把那次抛接到自己那一格 phi 上（`endTryOperator`，Eh.cpp:207-244），于是出错时
   *     整条表达式的值就是那个出错值。这一层的调用**回的正是那个值**，所以一个字不用发。
   *   - 能插语句：抬一格临时、比一下，出错就往外跳。往哪儿跳看 `guards`（第五十九刀）——
   *     里头有 `try { … }` 或 `catch:` 那一格作用域时跳它的出口，没有才回调用方。jancy 是
   *     同一条：`throwException` 先问 `findCatchScope()`，有就 `escapeScope(catchScope, …)`，
   *     没有才 `ret(returnType->getErrorCodeValue())`（jnc_ct_ControlFlowMgr_Eh.cpp:103-112）。
   *   - 插不进去：明说不收，而不是**悄悄把错吞掉**。
   */
  propagate(node, code, ret, shownName) {
    if (this.shield > 0) return { code, type: ret };
    const g = this.guards.length === 0 ? null : this.guards[this.guards.length - 1];
    if (g === null && this.curErr === null) {
      return this.nope(node, `不写 \`try\` 调 errorcode 的 '${shownName}'，而这个函数自己不是 `
        + 'errorcode、外面也没有 `try { … }` / `catch:`（jancy 那儿这条走运行期的 dynamic '
        + 'throw：Scope.h:144-145 的 canStaticThrow 为假 -> '
        + 'jnc_ct_ControlFlowMgr_Eh.cpp:98-101，而这一层没有运行期的展开）');
    }
    if (this.ecOut === null) {
      return this.nope(node, `这个位置上的 errorcode 调用 '${shownName}'（传播那两句得插成语句，`
        + '而这儿插不进去 —— 见 EC_HOIST）');
    }
    const v = `$e${this.ecSeq++}`;
    const t = errTest(`(var ${v})`, ret);
    if (t === null) return this.err(node, `内部错：${tyName(ret)} 定不出出错值的比法`);
    this.ecOut.push(`${this.ecPad}(let ${v} ${slotText(ret)} ${code})`);
    this.ecOut.push(`${this.ecPad}(if ${t} (do ${this.escape(g)}))`);
    return { code: `(var ${v})`, type: ret, hoisted: true };
  }

  /** 出错的那一跳（第五十九刀）：跳到最里那一格 `try` / `catch` 作用域的出口，没有就回调用方。
   *  方言里"跳到一格作用域的出口"就是那圈一次性循环的 `brk` —— 层号照第四十刀那条算法
   *  （到栈顶的距离），所以中间隔着几层真循环都不用这一处操心。 */
  escape(g) {
    if (g === null) return `(ret ${this.curErr})`;
    const lvl = this.loops.length - g.loopIdx;
    const brk = `(brk${lvl === 1 ? '' : ` ${lvl}`})`;
    return g.flag === null ? brk : `(do (set ${g.flag} (bool true)) ${brk})`;
  }

  /** `c.foo(…)` / `p->foo(…)` 里的被调（第五十二刀）：回 `{name, self}`。
   *  左边那一格与取字段走同一条路 —— 类那一格的值**就是**对象那段内存的地址。 */
  /**
   * `.` 的左边读出来那一格**值**（第一百一十六刀把它抽成一处）。
   *
   * 左边是一格**属性**时读它就是**调取值器** —— 那与第六十九刀拦的"把属性当一格可写的内存用"
   * 不是一回事：属性自己没被写。这一格先前只有 `lvalue0` 的 field 支接着（第七十二刀），
   * 而 `methodCallee` / `methodRef` / `propMember` / 原型那一处**四处各抄了一遍**同样的七行、
   * 都没接。于是 `o.m_p.twice()`（属性的值是一格类引用、拿它调方法）报的是那句管"就地改"的
   * 诊断 —— 名字起错了，量下来榜上 34 份全是这一种（见 ADR-0016 那一节）。
   *
   * 抽成一处之后四条路一起对，而且以后再往这一格上加东西不会漏。
   */
  baseVal(ob) {
    if (!isList(ob) || !LV_SHAPES.has(head(ob))) return this.expr(ob, null);
    const pt = this.propTarget(ob);
    if (pt === null) return null;
    if (pt !== undefined) return this.propGet(ob, pt.pn, pt.self);
    const o = this.lvalue(ob);
    if (o === null) return null;
    return { code: this.read(o), type: o.type };
  }

  methodCallee(n, callee, mn) {
    const ob = callee.items[1];
    let bv = null;
    if (head(callee) === 'field') {
      // `.` 的左边读出来那一格（第一百一十六刀抽成一处，属性走取值器）
      bv = this.baseVal(ob);
      if (bv === null) return null;
    } else {
      bv = this.expr(ob, null);
      if (bv === null) return null;
    }
    if (!isClass(bv.type)) {
      /* 结构体的方法（第一百〇一刀）：结构体那一格里放的**就是地址**（第十二刀），所以
         `this` 那一格直接用它，一条指令都不用发。`P*` 上叫方法也走这儿 —— jancy 那边
         `p->foo()` 与 `p.foo()` 是同一件事。 */
      const sn = jncIsStruct(bv.type) ? bv.type.name
        : (bv.type.k === 'ptr' && jncIsStruct(bv.type.target) ? bv.type.target.name : null);
      if (sn !== null) {
        const sf = this.findMethod(sn, mn);
        if (sf !== null) return { name: sf, self: bv.code };
      }
      return this.err(n, `'${tyName(bv.type)}' 不是类，上面问不出方法 '${mn}'`);
    }
    const full = this.findMethod(bv.type.name, mn);
    if (full === null) return this.err(n, `${shown(bv.type.name)} 没有方法 '${mn}'`);
    return { name: full, self: bv.code };
  }

  /** `c.foo` 里那个 foo 是方法吗（第五十五刀）。是就把那一格函数指针拼出来；左边不是类、
   *  或者那个类没有这个方法时回 undefined —— 那条路继续当"取字段"走（诊断留给那一处发）。 */
  methodRef(n, mn) {
    const ob = n.items[1];
    let bv = null;
    // `.` 的左边读出来那一格（第一百一十六刀抽成一处，属性走取值器）
    bv = this.baseVal(ob);
    if (bv === null) return null;
    if (!isClass(bv.type)) return undefined;
    const full = this.findMethod(bv.type.name, mn);
    if (full === null) return undefined;
    return this.fnValue(n, full, bv.code);
  }

  /** 被调是**一格函数指针**吗（第五十五刀）。不是就回 undefined（那条路继续按名字找函数），   *  是就把那一格求出来 —— 求失败回 null。`lookupRef` 是纯的，问它一句不发一个字。 */
  fnCallee(callee) {
    if (!isList(callee)) return undefined;
    // `f(…)(…)` —— 前一个调用回的是一格函数指针（`BinOp pick(int)` 那种）。这一支没有别的
    // 意思可撞，所以直接求值再看类型；求不出来那一处自己报过了。
    if (head(callee) === 'call') {
      const v = this.expr(callee, null);
      if (v === null) return null;
      return isFn(v.type) ? v : undefined;
    }
    /* 被调是一格 `? :`（第二百二十刀）：`y = (x ? c.foo : c.bar)();`（test41.jnc 那一族，
       语料里 2 份）。与上面 `call` 那一支同一条理由 —— **没有别的意思可撞**（三元式写在被调
       位置上只可能是"算出一格函数指针再调它"），所以直接求值。算出来不是函数指针就地说清，
       别落到下面那句笼统的话上。 */
    if (head(callee) === 'cond') {
      const v = this.expr(callee, null);
      if (v === null) return null;
      if (!isFn(v.type)) {
        return this.nope(callee, `被调的那一格 \`? :\` 算出来是 ${tyName(v.type)}，不是函数指针`);
      }
      return v;
    }
    if (head(callee) !== 'name' || !isAtom(callee.items[1])) return undefined;
    const r = this.lookupRef(callee.items[1].value);
    if (r === null || !isFn(r.type)) return undefined;
    return this.expr(callee, null);
  }

  /** 从一格函数指针上调（第五十五刀）：方言的 `(callfn E 实参…)`。签名就在那一格的类型里，
   *  所以实参这一遍与按名字调的那一遍是同一条规矩（整数隐式转、别的要同型）。 */
  callThrough(n, fv) {
    const sig = fv.type;
    const args = this.flat(n.items[2]);
    if (args.length !== sig.params.length) {
      return this.err(n, `这一格 ${tyName(sig)} 要 ${sig.params.length} 个实参，`
        + `这里给了 ${args.length} 个`);
    }
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      let v = this.expr(args[i], sig.params[i]);
      if (v === null) return null;
      if (isInt(v.type) && isInt(sig.params[i])) v = intConv(v, sig.params[i]);
      if (!this.assignOk(v.type, sig.params[i])) {
        return this.err(args[i], `这一格函数指针的第 ${i + 1} 个实参要 ${tyName(sig.params[i])}，`
          + `这里是 ${tyName(v.type)}`);
      }
      parts.push(v.code);
    }
    return { code: `(callfn ${fv.code}${parts.map((p) => ` ${p}`).join('')})`, type: sig.ret };
  }

  /**
   * 函数名当**值**用（第五十五刀）。jancy 的 fat function pointer 是"函数 + 一个闭包对象"
   * （type_ptr_function.rst），方言的函数值那一格正是同一个东西（ADR-0010 的 `{fp, c_*}`）：
   *
   * - 普通函数：`(fnref 名字)` —— 闭包那一半是空的。
   * - 方法（`c.foo`）：捕获的就是那个对象。方言里"带捕获的函数"是 `(cfn …)` + `(mkclo …)`，
   *   所以这一层给每个被当值用的方法抬一段 thunk 出来：捕 `$self`，转手调真正那个方法。
   *   jancy 自己也是这么说的 —— "if the function is a method, the closure holds the object"。
   */
  fnValue(node, full, selfCode) {
    const sig = this.fns.get(full);
    const owner = this.methods.get(full);
    // errorcode 的函数当值用（第五十八刀记的边界）：jancy 的 `errorcode` 是**函数类型上**的
    // 一位（`FunctionTypeFlag_ErrorCode`），所以从那一格指针调过去照旧会检查、照旧会传播。
    // 这一层的 `(fnty …)` 上没有那一位，errFns 是按**名字**记的 —— 于是从指针调就悄悄
    // 不检查了。宁可当场拒，也不要把错吞掉。
    if (this.errFns.has(full)) {
      return this.nope(node, `errorcode 的 '${shown(full)}' 当函数指针用（那一位是挂在函数`
        + '**类型**上的，这一层的 fnty 还没有它 —— 从指针调过去就检不着了）');
    }
    if (owner === undefined) {
      return { code: `(fnref ${full})`, type: tFn(sig.params, sig.ret) };
    }
    let self = selfCode;
    if (self === null) {
      // 方法体里裸写方法名就是 `this.foo`（与 `foo()` 补 this 同一条）；基类的方法也算
      // （第五十六刀）。
      if (this.selfClass !== owner && !this.isBase(owner, this.selfClass)) {
        return this.err(node, `'${shown(full)}' 是 ${shown(owner)} 的方法，要一个对象才拼得出`
          + '它那一格函数指针');
      }
      self = '(var $this)';
    }
    // 虚方法当值用（第五十七刀）：那一格里放的得是"按对象挑出来的那个实现"，所以 thunk
    // 转手调的是分派那一段。jancy 也是这么做的（取虚方法的值时它从虚表里取）。abstract
    // 的那一个本来就没有实现 —— jancy 那句 "'%s' is abstract"（Member.cpp:376）。
    let target = full;
    if (this.virt.has(full)) {
      if (this.virt.get(full) === 'abstract') {
        return this.err(node, `'${shown(full)}' 是 abstract，拼不出它那一格函数指针（jancy 那句 `
          + '"\'%s\' is abstract"）');
      }
      const d = this.dispatch(full);
      if (d === null) return null;
      target = d;
    }
    return {
      code: `(mkclo ${this.methodThunk(target, owner, sig)} ${self})`,
      type: tFn(sig.params.slice(1), sig.ret),
    };
  }

  /** 方法的 thunk（第五十五刀）：一个方法一段，抬到模块级，用 this.clos 记着别发两遍。 */
  methodThunk(full, owner, sig) {
    const have = this.clos.get(full);
    if (have !== undefined) return have;
    const name = `${full}$clo`;
    this.clos.set(full, name);
    const ps = sig.params.slice(1);
    const decl = ps.map((t, i) => `($a${i} ${slotText(t)})`).join(' ');
    const as = ps.map((t, i) => ` (var $a${i})`).join('');
    const call = `(call ${full} (cap $self)${as})`;
    this.decls.push(`  (cfn ${name} (($self ${slotText(tClass(owner, false))})) (${decl}) `
      + `${slotText(sig.ret)}\n    ${sig.ret === J_VOID ? `(expr ${call})` : `(ret ${call})`})`);
    return name;
  }

  /**
   * `new T { … }`（第二十五刀，decl_curly.rst 最后那一格：
   * `Point* point2 = new Point { m_y = 2000 }`）。
   *
   * 花括号初值是**几条语句**（先开那一格，再逐格写），而这一层的表达式降级只交出一段文字。
   * 上一刀在边界表上记的补法是"在表达式降级里开一条语句通道"—— 但那条通道在**惰性**位置
   * 上立不住：`while (new T { … })` 的条件每一圈都要重算，提到前面去就只算了一次。
   *
   * 所以走的是另一条：**把那几条语句抬成一个函数**。项的值在**调用方**这一侧求（顺序、
   * 作用域都还是原来那个），逐格写与 `pnew` 在被调那一侧，于是整个 `new T { … }` 就是一句
   * `(call $newc7 …)` —— 一个表达式，放哪儿都成立，每次求值都真的新开一格。方言一个字没改。
   *
   * 项的值当**实参**传进去正好解掉两件事：一是"在调用方求值"，二是名字的作用域
   * （被调那一侧只看得见形参，看不见调用方的局部量，所以不会误捕）。聚合的那些项传的是
   * 那一格的地址（`slotText`），抄一份由被调里的 copyVal 做 —— 与第十三刀那条"抄在被调
   * 那一侧"是同一条。
   */
  newCurly(n, tnNode, curly) {
    const t = this.newTy(tnNode);
    if (t === null) return null;
    if (t === J_VOID) return this.err(n, 'new void');
    // `new C { … }`（第五十二刀）：jancy 那边花括号初值对类也成立，可它是在**构造之后**跑的
    // （`initializeObject` 之后才 `parseCurlyInitializer`）。构造第五十三刀收了，可"构造完
    // 再逐格写"要把 curlyEmit 那一套接到抬出来的那个函数里去 —— 那是另一格，先明说不收。
    if (isClass(t)) return this.nope(n, `new ${tyName(t)} { … }（花括号初值要接在构造之后）`);
    if (!jncIsStruct(t) && !isArr(t)) {
      return this.err(n, `new ${tyName(t)} { … }：花括号初值要一格聚合`);
    }
    if (isArr(t) && t.n === null) return this.err(n, `new ${tyName(t)} { … } 的长度得写出来`);
    if (!isList(curly) || head(curly) !== 'curly') return this.err(n, '认不出的花括号初值');
    const pad = '      ';
    const body = [];
    const args = [];
    const plan = this.curlyPlan(curly, t, pad, body, {
      shadow: null,          // 被调那一侧没有同名的目标可遮，所以不用钉
      val: (node, want) => {
        const code = this.initValue(node, want);
        if (code === null) return null;
        const k = args.length;
        args.push({ code, type: want });
        return `(var $i${k})`;
      },
    }, [], []);
    if (plan === null) return null;
    const st = slotText(t);
    const pre = [`${pad}(let $p ${st} (pnew ${st} (int 1)))`];
    if (this.curlyEmit(plan, '(var $p)', pad, body) === null) return null;
    const fn = `$newc${this.tmp++}`;
    const ps = args.map((a, i) => `($i${i} ${slotText(a.type)})`).join(' ');
    this.decls.push(`  (fn ${fn} (${ps}) ${st}\n    (do\n${pre.concat(body).join('\n')}\n`
      + `${pad}(ret (var $p))))`);
    const as = args.map((a) => ` ${a.code}`).join('');
    return { code: `(call ${fn}${as})`, type: tPtr(t) };
  }


  /** `new T` / `new T[n]` / `new T { … }` 三处共用的类型解析。 */
  newTy(tnNode) {
    if (!isList(tnNode) || head(tnNode) !== 'type-name') return this.nope(tnNode, '这种 new 的类型');
    const sp = this.specs(tnNode.items[1]);
    if (sp === null) return null;
    return this.ptrsTy(sp, tnNode.items[2], tnNode);
  }

  /** `new T[n]` -> `(pnew (ptr T) n)`；`new T` -> 一格。两者出来的都是**指针**。
   *  类还多一段构造（第五十三刀）：`new C1(100)` 的实参在 argsNode 里。 */
  newPtr(n, tnNode, countNode, argsNode) {
    const t = this.newTy(tnNode);
    if (t === null) return null;
    if (t === J_VOID) return this.err(n, 'new void');
    if (argsNode !== null && !isClass(t) && !jncIsStruct(t)) {
      return this.err(n, `new ${tyName(t)}(…)：只有类与结构体有构造，实参没处去`);
    }
    // `new C`（第五十二刀）：出来的是一条**类引用**，不是"指向类指针的指针"——
    // jancy 的 `new` 对类给的就是 `C*`（也就是这一层的类类型自己）。`new C[n]` 没有：
    // 类的数组它自己就拒（`getArrayType` 的 TypeKind_Class 那一支）。
    if (isClass(t)) {
      if (countNode !== null) {
        return this.err(n, `不能造类的数组（jancy 那句 "cannot create array of '${tyName(t)}'"）`);
      }
      const raw = { code: `(pnew (ptr ${clsRoot(t.name)}) (int 1))`, type: tClass(t.name, false) };
      const hasCtor = this.ctors.has(t.name);
      /* `opaque class` 声明了 construct、可体在宿主那边（第六十六刀）：造出来的对象不能
         假装"没有构造"就交出去 —— 那是**悄悄少跑一段**。所以这儿明说。
         这一问先前写的是 `!hasCtor`，那是**漏的**（第一百四十八刀量出来的）：语料里的
         `opaque class ComboProperty: Property { construct(string_t name); }` 有基类、也有
         `autoget` 属性，于是这一层给它合了一格无参构造 —— `hasCtor` 就成了真，这条 N 被跳过，
         报出来的是"要 0 个实参，这里给了 1 个"（逐份榜上这一族十来行、每行 88 处）。
         合出来的那一格顶不了用户声明的那一个，所以问的该是"有没有**真的**那一个"。 */
      if (!this.realCtor(t.name) && this.hostCtors.has(t.name)) {
        /* 宿主面的 construct（第一百六十二刀）：与方法（ADR-0022 的 J4b）、属性的取/存
           （第一百六十刀）同一条约定 —— 造完那一格、写完 `$tag`，紧接着
           `(ccall C_construct self …)`。签名是**声明**里那一份（hostCtorSigs），不是从调用点猜的。 */
        const hc = this.hostCtorArgs(n, t.name, argsNode === null ? [] : this.flat(argsNode));
        if (hc === null) return null;
        const st0 = slotText(t);
        const ps0 = hc.vals.map((v, i) => `($i${i} ${slotText(v.type)})`).join(' ');
        const tg0 = this.tagStore(n, t.name, '(var $p)', '      ');
        if (tg0 === null) return null;
        const fn0 = `$newh${this.tmp++}`;
        this.decls.push(`  (fn ${fn0} (${ps0}) ${st0}\n    (do\n`
          + `      (let $p ${st0} ${raw.code})\n${tg0}\n`
          + `      (expr (ccall ${hc.sym} (var $p)`
          + `${hc.vals.map((v, i) => ` (var $i${i})`).join('')}))\n`
          + `      (ret (var $p))))`);
        return {
          code: `(call ${fn0}${hc.vals.map((v) => ` ${v.code}`).join('')})`,
          type: raw.type,
        };
      }
      // 只有原型的 construct（第一百四十八刀）：与上一条同一件事，只是那个类没写 `opaque`。
      if (this.protoCtorOnly(t.name)) return this.protoCtorNope(n, t.name);
      if (!hasCtor && argsNode !== null && this.flat(argsNode).length > 0) {
        return this.err(n, `${shown(t.name)} 没有 construct，给不了构造实参`);
      }
      // 一格新对象、写死 `$tag`（第五十七刀）、再（有的话）构造 —— **三句**，而 `new` 是一个
      // 表达式（惰性位置上每一次求值都得真造一格），所以照第二十五刀 newCurly 那条路，
      // 把这几句抬成一个函数。
      const c = hasCtor ? this.ctorArgs(n, t.name, argsNode === null ? [] : this.flat(argsNode)) : null;
      if (hasCtor && c === null) return null;
      const vals = c === null ? [] : c.vals;
      const st = slotText(t);
      const ps = vals.map((v, i) => `($i${i} ${slotText(v.type)})`).join(' ');
      const as = vals.map((v, i) => ` (var $i${i})`).join('');
      const tg = this.tagStore(n, t.name, '(var $p)', '      ');
      if (tg === null) return null;
      const fn = `$newo${this.tmp++}`;
      this.decls.push(`  (fn ${fn} (${ps}) ${st}\n    (do\n`
        + `      (let $p ${st} ${raw.code})\n${tg}\n`
        + (c === null ? '' : `      (expr (call ${c.name} (var $p)${as}))\n`)
        + `      (ret (var $p))))`);
      return { code: `(call ${fn}${vals.map((v) => ` ${v.code}`).join('')})`, type: raw.type };
    }
    let count = '(int 1)';
    if (countNode !== null) {
      const c = this.expr(countNode, J_I64);
      if (c === null) return null;
      if (!isInt(c.type)) return this.err(countNode, `new T[n] 的 n 要整数，这里是 ${tyName(c.type)}`);
      count = c.code;
    }
    /* `new S` / `new S(…)`（第一百二十九刀）：结构体也有构造了 —— 造完那一格紧接着调它。
       与类那一支同一条路：`new` 是**表达式**，而"造一格 + 调构造 + 交出去"是三句，所以照
       第二十五刀那条路抬成一个函数。`new S[n]` 那一种不调 —— 一次造 n 格，"每格都构造一遍"
       要一个循环，是单独一笔账（明说）。 */
    if (jncIsStruct(t) && (this.ctors.has(t.name) || argsNode !== null)) {
      if (countNode !== null) {
        return this.nope(n, `new ${tyName(t)}[n] —— 那一格有构造，n 格要每格都调一遍`
          + '（要一个循环，是单独一笔账）');
      }
      const c = this.ctorArgs(n, t.name, argsNode === null ? [] : this.flat(argsNode));
      if (this.ctors.has(t.name) && c === null) return null;
      const vals = c === null ? [] : c.vals;
      const pt = tyText(tPtr(t));
      const ps = vals.map((v, i) => `($i${i} ${slotText(v.type)})`).join(' ');
      const as = vals.map((v, i) => ` (var $i${i})`).join('');
      const fn = `$news${this.tmp++}`;
      this.decls.push(`  (fn ${fn} (${ps}) ${pt}\n    (do\n`
        + `      (let $p ${pt} (pnew ${pt} (int 1)))\n`
        + (c === null ? '' : `      (expr (call ${c.name} (var $p)${as}))\n`)
        + `      (ret (var $p))))`);
      return { code: `(call ${fn}${vals.map((v) => ` ${v.code}`).join('')})`, type: tPtr(t) };
    }
    return { code: `(pnew ${tyText(tPtr(t))} ${count})`, type: tPtr(t) };
  }

  /**
   * 强制转换。这一刀只认三种，别的当场报错：
   *   - `(double)i` / `(int)d` -> `(toreal …)` / `(toint …)`
   *   - `(T thin*)p` -> `(pthin p)`（fat 丢掉范围；方言要求它写在 `unsafe` 里）
   *   - 同型（写了但没变）-> 原样
   */
  cast(n, tnNode, exprNode) {
    if (!isList(tnNode) || head(tnNode) !== 'type-name') return this.nope(tnNode, '这种强制转换的类型');
    const sp = this.specs(tnNode.items[1]);
    if (sp === null) return null;
    const to = this.ptrsTy(sp, tnNode.items[2], tnNode);
    if (to === null) return null;
    const v = this.expr(exprNode, to);
    if (v === null) return null;
    if (sameTy(v.type, to)) return v;
    if (isInt(to) && isInt(v.type)) return intConv(v, to);
    if (to === J_REAL && isInt(v.type)) return { code: realOf(v.code, v.type), type: J_REAL };
    if (isInt(to) && v.type === J_REAL) {
      // 先向零截断成 64 位（方言的 `toint` 就是它），再回卷到目标那一格。
      return intConv({ code: `(toint ${v.code})`, type: J_I64 }, to);
    }
    // `(E)i` —— int 到枚举的**显式**转换（第五十刀）。jancy 的 `Cast_Enum::getCastKind`
    // 给的就是 `CastKind_Explicit`（jnc_ct_CastOp_Int.cpp:295-311）：隐式只留两条 ——
    // 枚举到它的基枚举、字面 0 到 bitflag 枚举。转法照它写：先转成枚举的**根类型**
    // （`getRootType()`，:323），再原样拷过去（StdCast_Int + StdCast_Copy，:330-332）。
    // 第一个算子是 `StdCast_Int`，也就是 `Cast_Int` —— 它的源不止整数，实数与 bool
    // 都收，所以 `(Color)3.9` 与 `(Color)true` 照 jancy 也是能写的。
    if (jncIsEnum(to)) {
      let src = v;
      if (jncIsEnum(src.type)) src = { code: src.code, type: src.type.base };
      else if (src.type === J_BOOL) src = { code: `(sel ${src.code} (int 1) (int 0))`, type: J_I64 };
      else if (src.type === J_REAL) src = { code: `(toint ${src.code})`, type: J_I64 };
      if (isInt(src.type)) {
        const x = intConv(src, to.base);
        return { code: x.code, type: to };
      }
    }
    if (to.k === 'tptr' && v.type.k === 'ptr' && sameTy(to.target, v.type.target)) {
      // 在这儿拦一次而不是等方言报：这条消息能指着 jancy 那一行说话。
      if (!this.unsafe) {
        return this.err(n, '转成 thin 指针要写在 `unsafe { … }` 里 —— 它把范围丢掉了');
      }
      return { code: `(pthin ${v.code})`, type: to };
    }
    return this.nope(n, `把 ${tyName(v.type)} 转成 ${tyName(to)}`);
  }

  load(n, lv) {
    if (lv === null) return null;
    return { code: this.read(lv), type: lv.type };
  }
}


