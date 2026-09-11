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
//     剩下的四条：没写初值的那一格（方言的函数值没有空值，跟着 `if (p)` 也立不住）、
//     函数指针的**字段**（方言的结构体字段放不下函数值 —— 第五十七刀的虚派发因此换成了
//     一格整数标签）、`function**` 与它的数组、`~()` 的部分应用。
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

/** `(type-decl (agg class …))` 里的那个 agg 吗（第五十二刀）。 */
function isClassAgg(n) {
  return isList(n) && head(n) === 'agg'
    && aggCls(isAtom(n.items[1]) ? n.items[1].value : null);
}

/** 体里那些方法要**提到顶层**的 agg 吗（第一百〇一刀把 struct 也算进来了）。
 *  jancy 的 struct 也是一层命名空间、也能有方法（`type_struct.rst` 的 Methods 一节）。 */
function isHoistAgg(n) {
  if (!isList(n) || head(n) !== 'agg') return false;
  const k = isAtom(n.items[1]) ? n.items[1].value : null;
  return aggCls(k) || k === 'struct';
}

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
 *  这几种在语法里是自己一格（`special` / `accessor`，jnc.grammar 的 special 规则）。 */
function specialCore(dcl) {
  if (!isList(dcl) || head(dcl) !== 'dcl') return null;
  let core = dcl.items[2];
  if (isList(core) && head(core) === 'qualified-special') core = core.items[2];
  if (!isList(core)) return null;
  const h = head(core);
  if (h !== 'special' && h !== 'accessor') return null;
  return isStr(core.items[1]) || isAtom(core.items[1]) ? core.items[1].value : h;
}

/** 这个声明符是**属性的**取/存吗（第六十九刀）：`m_v.get()` 名字写在前面（语法上那是
 *  `qualified-special`），而类体里裸写的 `int get(int i)` / `void set(int i, int v)` 是
 *  **下标运算符**（test90.jnc:12-24 里 `c[10] = 100` 走的就是它），与属性没关系 ——
 *  那一格照旧由 typeDecl 报"还不收"，不能混进属性这条路里。 */
function accessorNamed(dcl) {
  if (!isList(dcl) || head(dcl) !== 'dcl') return false;
  const core = dcl.items[2];
  if (!isList(core) || head(core) !== 'qualified-special') return false;
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
function zeroText(t) {
  if (t.k === 'int') return '(int 0)';
  if (t.k === 'real') return '(real 0.0)';
  if (t.k === 'bool') return '(bool false)';
  if (t.k === 'string') return '(str "")';
  if (t.k === 'ptr' || t.k === 'tptr') return `(pnull ${tyText(t)})`;
  // 类指针的零值是空引用（第五十二刀）：`C* p;` 那一格出来是 null，要 `new C` 才有对象。
  if (t.k === 'class') return `(pnull (ptr ${clsRoot(t.name)}))`;
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
    this.hostFns = new Map();
    /* 那些方法的**签名**（`类名$方法名` -> `{owner, ret, params}`，jnc 类型）。调用点靠它
       发 `(cabi Owner_method …)` 与 `(ccall Owner_method self …)`（ADR-0022 的 J4b 最后一步）。 */
    this.hostSigs = new Map();
    this.hostCtors = new Set();
    this.methods = new Map();
    this.methodNames = new Set();
    this.selfClass = null;
    this.nsExtra = null;
    // 构造（第五十三刀）。`ctors` 是类名 -> {name, params}（那一格是实例构造，方言里的名字是
    // `C$construct`），`sctors` 是类名 -> 静态构造的方言名。静态构造**在实例构造的开头调、
    // 只调一次**（jnc_ct_Parser.cpp:3005-3009 那四句的第二句 + MemberBlock 里那个
    // `ModuleItemFlag_Constructed` 闸门），所以要一格模块级的 bool。
    this.ctors = new Map();
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
      const hasFI = this.fieldInits.has(name) || this.evtFields.has(name);
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
      this.ctors.set(name, { name: full, params: [] });
      if (hasFI) { this.synthFI.add(name); continue; }
      const calls = bcs.map((x) => `    (expr (call ${x.c.name} (var $this)))`).join('\n');
      this.decls.push(`  (fn ${full} (($this ${slotText(self)})) void\n${calls})`);
    }
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
    for (const e of this.flat(s.items[1])) {
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
   */
  resolve(nm, has) {
    const k = nm.replace(/\./g, '$');
    let p = this.ns;
    for (;;) {
      const full = p === '' ? k : `${p}$${k}`;
      if (has(full)) return full;
      if (p === '') break;
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
    return null;
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
  collectAddrTaken(node, out) {
    if (!isList(node)) return;
    if (head(node) === 'addr') {
      const t = node.items[1];
      if (isList(t) && head(t) === 'name' && isAtom(t.items[1])) out.add(t.items[1].value);
    }
    for (const it of node.items) this.collectAddrTaken(it, out);
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
  copyVal(dstCode, srcCode, type, pad, out) {
    if (jncIsStruct(type)) return this.copyAgg(dstCode, srcCode, type.name, pad, out);
    if (isArr(type)) return this.copyArr(dstCode, srcCode, type, pad, out);
    out.push(`${pad}(pstore ${dstCode} (pload ${srcCode}))`);
    return out;
  }

  /** 逐格抄一整块。长度是编译期的字面量，所以这里就地展开（与 copyAgg 逐字段同一形状）。 */
  copyArr(dstCode, srcCode, type, pad, out) {
    const d0 = `(pelem ${dstCode})`;
    const s0 = `(pelem ${srcCode})`;
    for (let i = 0; i < type.n; i++) {
      const d = i === 0 ? d0 : `(padd ${d0} (int ${i}))`;
      const s = i === 0 ? s0 : `(padd ${s0} (int ${i}))`;
      if (this.copyVal(d, s, type.el, pad, out) === null) return null;
    }
    return out;
  }

  copyAgg(dstCode, srcCode, name, pad, out) {
    const fs = this.structs.get(name);
    if (fs === undefined) return this.err(null, `内部错误：没有结构体 '${name}'`);
    for (const f of fs) {
      const d = `(pfield ${dstCode} ${f.name})`;
      const s = `(pfield ${srcCode} ${f.name})`;
      if (this.copyVal(d, s, f.type, pad, out) === null) return null;
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
      const fs = this.structs.get(type.name);
      if (fs === undefined) return this.err(node, `内部错误：没有结构体 '${type.name}'`);
      const f = name === null ? fs[idx] : fs.find((x) => x.name === name);
      if (f === undefined) {
        return name === null
          ? this.err(node, `第 ${idx + 1} 项越过了 ${type.name} 的 ${fs.length} 个字段`)
          : this.err(node, `${type.name} 没有字段 '${name}'`);
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
    for (const it of this.flat(tree)) {
      if (isList(it) && (head(it) === 'import' || head(it) === 'import-as')) {
        this.impAdd(it);
        continue;
      }
      if (isList(it) && head(it) === 'namespace') {
        const nm = this.qname(it.items[1]);
        if (nm === null) { this.err(it, '认不出的命名空间名字'); continue; }
        const k = nm.replace(/\./g, '$');
        this.nsFlat(it.items[2], ns === '' ? k : `${ns}$${k}`, out);
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
    for (const m of this.flat(agg.items[4])) {
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
        if (sk === null || accessorNamed(m.items[2])
          || (isCls && (sk === 'construct' || sk === 'static construct'))) {
          out.push({ ns: inner, it: m });
        }
        continue;
      }
      if (h === 'type-decl' && isCls) {
        out.push({ ns: inner, it: m });
        if (isHoistAgg(m.items[1])) this.aggHoist(m.items[1], inner, out);
      }
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
    // 被 import 的文件在这儿续到同一份名单后面（第六十刀）—— 一定要**在下面那些遍之前**：
    // 它们的类型名、签名、模块级变量与这个文件的是平权的一堆，不是"外面的库"。
    this.impDrain(items);
    // 完整声明式的属性改写成简单声明式加两个函数（第七十五刀）—— 排在最前面：底下每一遍
    // 看的都是改写之后的名单，属性那一整套一个字都不用动。
    items = this.expandFullProps(items);
    // 结构体的名字先坐下（第十七刀）：`Node* m_next` 要在自己的体里查得着 Node。
    for (const e of items) {
      this.ns = e.ns;
      if (isList(e.it) && head(e.it) === 'type-decl') this.typeName(e.it.items[1]);
    }
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
    for (const e of items) {
      this.ns = e.ns;
      if (isList(e.it) && head(e.it) === 'type-decl') this.typeDecl(e.it.items[1]);
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
      this.ctors.set(cls, { name: full, params: [] });
      this.synthSC.add(cls);
      /* 这个类还带着字段默认值或者事件（第七十八 / 八十三刀）：那就把体交给
         emitFieldInitCtors —— 它会先发闸门那几行、再建事件的单子、再发字段初值。
         两处各发一格 `(fn C$construct …)` 就重名了。 */
      if (this.fieldInits.has(cls) || this.evtFields.has(cls)) { this.synthFI.add(cls); continue; }
      this.decls.push(`  (fn ${full} (($this ${slotText(self)})) void\n`
        + `${this.gateLines(cls, '    ').join('\n')})`);
    }
    // 派生类没写 construct（第五十六刀）。jancy 那边合成的那一个要**把基类的构造调一遍**
    // （`DerivableType::createDefaultMethods` 里 `createDefaultConstructor` 的那条链），
    // 不合成就等于 `D d;` 悄悄跳过了基类的构造 —— 那是骗人。按深度从上往下走，所以基类
    // 那一个（可能也是合成的）已经在表里了。
    this.synthCtors();
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
        // 顶层的那一格就是一格模块级变量。`&` 数的是**源码里写的**名字，而源码里写的是
        // `m_value`（prop_autoget.rst:26），所以两个名字都问一遍 —— 与 declareGlobal 同。
        if ((this.gTaken.has(a.name) || this.gTaken.has('m_value')) && this.liftable(a.type)) {
          this.gLifted.add(a.name);
          const pt = `(ptr ${tyText(a.type)})`;
          this.decls.push(`  (global ${a.name} ${pt})`);
          this.globalCells.push(`    (set ${a.name} (pnew ${pt} (int 1)))`);
        } else {
          this.decls.push(`  (global ${a.name} ${slotText(a.type)})`);
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
      // 成员的那一格已经跟着整条链那格结构体发出去了（propName 那一遍在 classLayout 之前往
      // ownFields 里加的），所以这儿只剩合成那两个函数。
      const self = tClass(a.cls, false);
      const ad = `(pfield (var $this) ${a.name})`;
      if (!pi.get) {
        this.decls.push(`  (fn ${g} (($this ${slotText(self)})) ${slotText(a.type)}\n`
          + `    (ret (pload ${ad})))`);
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

  topItem(item) {
    if (!isList(item)) return this.err(item, '认不出的顶层条目');
    const h = head(item);
    if (h === 'empty-stmt') return null;            // 光一个分号
    if (h === 'fn-def') return this.fnDef(item);
    if (h === 'typedef') return null;               // 已经在前面那一遍收过了（第三十八刀）
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
    this.nope(d, `alias '${name}' 的目标 '${tgt}'（收的是一格类型名、一格函数、`
      + '或者这个类里的一格方法 —— 字段路径的别名还不收）');
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
  expandFullProps(items) {
    const out = [];
    for (const e of items) {
      const it = e.it;
      if (!isList(it) || head(it) !== 'fn-def') { out.push(e); continue; }
      const dcl = it.items[2];
      if (!this.propMod(it.items[1]) && !this.tailMods(dcl).includes('property')) {
        out.push(e);
        continue;
      }
      // `this.qual()` 要当时那一层命名空间（体内那两格的名字要按全名记账）
      const saveNs = this.ns;
      this.ns = e.ns;
      const ex = this.fullProp(it);
      this.ns = saveNs;
      // 说不通的照原样留着：`fnSig0` 那条诊断照旧发，理由不会因为这一刀变模糊。
      if (ex === null) { out.push(e); continue; }
      for (const x of ex) out.push({ it: x, ns: e.ns });
    }
    return out;
  }

  /** 一格完整声明式的属性 -> 三条（声明 + 取 + 存）。**报过错的回空表**（那一条就此丢掉，
   *  免得 fnSig0 再报一遍同一件事）；压根不是这个形状的回 null（照原样留着）。 */
  fullProp(it) {
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
    for (const m of this.flat(body.items[1])) {
      if (isList(m) && head(m) === 'var-decl') {
        const r = this.fullPropMember(nm, m);
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
      if (accs.some((a) => a.kind === kind)) {
        this.nope(m, `完整声明式的属性 '${nm}' 里两个 ${kind}（要重载决议）`);
        return [];
      }
      accs.push({ kind, node: m });
    }
    const g = accs.find((a) => a.kind === 'get');
    /* 类型的出处有两个：写了取值器就抄它的返回类型，没写就抄体里那格 autoget 字段
     * （那时取值器由编译器生成 —— prop_autoget.rst:17 的两半）。两个都没有就说不通。 */
    if (g === undefined && fld === null) {
      this.nope(it, `完整声明式的属性 '${nm}' 里既没有 get 也没有 autoget 的字段 ——`
        + '属性的类型没处抄');
      return [];
    }
    const src = fld !== null ? fld : { sp: g.node.items[1], ptrs: g.node.items[2].items[1] };
    const extra = [];
    if (fld !== null) extra.push('autoget');
    if (evt !== null) extra.push('bindable');
    /* 体里那两格的**名字**是写的人定的（`m_x` / `m_e`，不是默认的 `m_value` / `m_onChanged`）。
     * 改写出来的简单声明式记不住它们，所以在这儿记一笔 —— autoStore / bindStore 按它拼那格
     * 生成物的名字，于是存值器体里裸写的 `m_x` 由属性那层命名空间直接查得着。 */
    const full = this.qual(nm);
    if (fld !== null || evt !== null) {
      this.propMemName.set(full, { store: fld === null ? null : fld.name, onch: evt === null ? null : evt.name });
    }
    const out = [this.propDeclOf(src.sp, src.ptrs, core, extra)];
    for (const a of accs) {
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
  fullPropMember(nm, m) {
    const sp = m.items[1];
    const mods = [...this.flat(sp.items[2]), ...this.flat(sp.items[3])]
      .filter((x) => isAtom(x)).map((x) => x.value);
    const ds = this.flat(m.items[2]);
    if (ds.length !== 1 || !isList(ds[0]) || head(ds[0]) !== 'dcl') {
      this.nope(m, `完整声明式的属性 '${nm}' 体里的这一条（一条声明只收一格）`);
      return null;
    }
    const d = ds[0];
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
    if (ptrs.items.length === 1) {
      const post = sp.items[3];
      sp.items[3] = this.mkL(post.span, ...post.items,
        ...words.map((w) => this.mkA(post.span, w)));
    } else {
      const last = ptrs.items[ptrs.items.length - 1];
      const ms = last.items[1];
      ptrs.items[ptrs.items.length - 1] = this.mkL(last.span, last.items[0],
        this.mkL(ms.span, ...ms.items, ...words.map((w) => this.mkA(ms.span, w))));
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
      // `errorcode` 那一位在 jancy 那边落在**取/存那两个函数**的类型上（属性也进 vtable，所以
      // `virtual` 同理）。这一层的 errorcode 是按函数名记的一张表、虚派发是按方法名接的一格
      // 标签，而属性那两个函数的名字是这一层自己拼的（`p$get`）—— 两条都还接不上。
      if (dsp.errc) {
        this.nope(d, '`errorcode` 写在属性上（那一位落在取/存那两个函数上，'
          + '而这一层的 errorcode 是按函数名记的）');
        continue;
      }
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
      const cls = owner !== null && this.classes.has(owner) ? owner : null;
      if (cls !== null) this.propNames.add(full.slice(cut + 1));
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
    // 「Autoget and indexed property modifiers are mutually exclusive」（prop_autoget.rst:47）。
    if (idx.length > 0) {
      return this.err(d, `'${shown(full)}' 上 autoget 与下标不能一起写`
        + '（prop_autoget.rst:47 那句 mutually exclusive）');
    }
    if (t === J_VOID) return this.err(d, `'${shown(full)}' 的类型是 void`);
    // 生成的那一格是"一格存储"，所以它落得进内存才行：结构体与数组要抄一份才能读写（那时
    // 合成的取值器不是一句 `ret`）、类**值**在 jancy 那边是内嵌的对象、函数值方言的结构体
    // 字段放不下（见 typeDecl 里字段那三条同样的话）。这几种明说不收。
    if (jncIsStruct(t) || isArr(t) || isFn(t) || (isClass(t) && t.own === true)) {
      return this.nope(d, `类型是 ${tyName(t)} 的 autoget 属性 —— 编译器要生成的那一格存储`
        + '得是能一句读完的一格');
    }
    // 完整声明式里那格字段的名字是写的人定的（第七十六刀）；简单声明式里它就叫 `m_value`
    // （prop_autoget.rst:26）。
    const mem = this.propMemName.get(full);
    const name = `${full}$${mem !== undefined && mem.store !== null ? mem.store : 'm_value'}`;
    if (cls === null) {
      if (this.globals.has(name)) return this.err(d, `模块级变量 '${shown(name)}' 声明了两次`);
      this.globals.set(name, t);
      this.autoProps.push({ full, name, cls: null, type: t });
      return name;
    }
    const fs = this.ownFields.get(cls);
    if (fs === undefined) return this.err(d, `'${shown(cls)}' 的字段表还没有 —— autoget 那一格加不进去`);
    fs.push({ name, type: t });
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
    const sp = this.specs(n.items[1]);
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
          this.nope(dcl, `原型 '${shown(fn)}' 没有带体的定义（实现在宿主那边的走 opaque class`
            + ' 那条路，在别的模块里的要 import 得着）');
          continue;
        }
        const ps = this.formalList(info.formals);
        if (ps === null) continue;
        const same = have.params.length === ps.length
          && have.params.every((t, i) => sameTy(t, ps[i].type)) && sameTy(have.ret, info.type);
        if (!same) {
          this.err(dcl, `原型 '${shown(fn)}' 与它那个定义的签名对不上`);
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
    if (key !== 'struct' && !cls0) return null;
    const nm0 = this.qname(n.items[2]);
    if (nm0 === null) return null;
    const name = this.qual(nm0);
    if (this.structs.has(name)) {
      return this.err(n, `${cls0 ? '类' : '结构体'} '${shown(name)}' 声明了两次`);
    }
    this.structs.set(name, []);
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
      base: J_I32, members: new Map(), bits: key === 'bitflag enum', anon: this.anonEnum.has(n),
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
    for (const m of this.flat(n.items[4])) {
      if (!isList(m) || head(m) !== 'enum-item') { this.err(m, '认不出的枚举成员'); continue; }
      const mn = isAtom(m.items[1]) ? m.items[1].value : this.qname(m.items[1]);
      if (mn === null) { this.err(m, '认不出的枚举成员名字'); continue; }
      if (info.members.has(mn)) { this.err(m, `枚举 '${shown(name)}' 里 '${mn}' 出现了两次`); continue; }
      if (m.items[2] !== undefined) {
        this.constEnum = info;
        const k = this.constInt(m.items[2]);
        this.constEnum = null;
        if (k === null) { this.nope(m.items[2], '枚举成员的值算不出来（要一个编译期整数常量）'); continue; }
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
      if (next < 0n) {
        this.nope(m, `bitflag enum '${name}' 里的负值 —— jancy 那边 \`2 << getHiBitIdx64(负数)\` 是 C++ 的未定义行为，没有可对的答案`);
        continue;
      }
      next = next === 0n ? 1n : 2n ** BigInt(next.toString(2).length);
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
    if (key !== 'struct' && !cls) return this.nope(n, `'${key}'（只收 struct 与 class）`);
    const nm3 = this.qname(n.items[2]);
    if (nm3 === null) return this.err(n, `认不出的${cls ? '类' : '结构体'}名字`);
    const name = this.qual(nm3);
    const bases = this.flat(n.items[3]);
    // 基类（第五十六刀 + 第九十四刀）。jancy 的模型是**多继承**（type_class.rst:171-174：
    // "a simple multiple inheritance model (multiple instances of shared bases -- if any)"）。
    // 第五十六刀只接单继承；第九十四刀把"多个基类"这一格收下了 —— 第一格是链的脊梁，第二格起
    // 在这一层与第一格同待遇（见 mixins 那处的注）。剩下两格还没收：**共享基类各一份实例**
    // （一条链一格结构体，同一个基类只有一份 —— classLayout 那儿当场拒），以及结构体当基类
    // （同一处:218 那句 "it's ok to inherit from structs and even unions"，那要"结构体也能
    // 当一层基类"，是自己一格）。
    if (bases.length > 0 && !cls) return this.nope(n, '结构体的基类');
    let base = null;
    const extra = [];
    for (let i = 0; i < bases.length; i++) {
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
    const inits = [];                    // 带默认值的那几格（第七十八刀）
    const evts = [];                     // 事件那几格（第八十三刀）—— 造对象时要建单子
    // 类体里查名从**这个类**这一层起（第五十二刀）：嵌套类型在 nsFlat 那一遍登记成了 `C.S`，
    // 而字段与方法原型写的是裸名字 `S`（test97.jnc:8）。结构体不动 —— 它不是一层命名空间。
    const saveNs = this.ns;
    if (cls) this.ns = name;
    for (const m of this.flat(n.items[4])) {
      if (isList(m) && head(m) === 'empty-stmt') continue;
      // 访问控制（第五十二刀）。jancy 只有 public 与 protected 两种，**默认 public**
      // （type_class.rst:23-27），两种写法（C++ 式的 `public:` 与 Java 式的前缀）都收。
      // 这一层不做可见性检查 —— 那是"拒得更严"，不影响能跑的程序的行为。
      if (isList(m) && head(m) === 'access') continue;
      // 嵌套类型（`class C { struct S { … } }`）在 nsFlat 那一遍已经提到顶层了（名字是
      // `C.S`），这儿跳过。结构体里的嵌套类型照旧不收 —— 那要先有"结构体也是一层命名空间"。
      if (isList(m) && head(m) === 'type-decl') {
        if (!cls) this.nope(m, '结构体里的嵌套类型');
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
          /* `construct` / `destruct` 在结构体里还不收（构造那一族是自己一刀）。裸写的
             `get` / `set` 是**下标运算符**那一族（见 accessorNamed）—— 名字写在前面的
             `p.get()` 是属性的取值器，那一格照旧提上去。 */
          if (sk0 !== null && !accessorNamed(m.items[2])) {
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
          && !accessorNamed(m.items[2])) this.specialNope(m, sk);
        continue;
      }
      // 体内只写原型、体外补上（`void C.foo();` + `void C.foo() { … }`）—— 两种放法
      // jancy 都收（type_class.rst:41-59）。原型这边一个字都不用发：签名那一遍看的是
      // 体外那个定义。`construct` 的原型同理（体在类外，第五十三刀）。
      if (isList(m) && head(m) === 'fn-proto') {
        const sk = specialCore(m.items[2]);
        if (sk === 'construct' || sk === 'static construct') {
          // 同上（第六十六刀）：`opaque class` 的 construct 也在宿主那边。
          if (cls && key === 'opaque class' && sk === 'construct') this.hostCtors.add(name);
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
      if (!isList(m) || head(m) !== 'var-decl') {
        this.nope(m, `${cls ? '类' : '结构体'}里除字段以外的成员`);
        continue;
      }
      const sp = this.specs(m.items[1], cls);
      if (sp === null) continue;
      // 成员属性（第六十九刀）：它**不是一格字段** —— 不在这儿把它挑出来就会被当成一格普通
      // 内存，那是"悄悄换了意思"。登记留给下面那一格（run 里属性那一遍，排在签名之前），
      // 这儿只把节点连当时的 ns（就是这个类）攒起来。这一问走 propMod 而不是 `sp.prop`：
      // 那个词也可能写在星号后面（第七十二刀，`Icon* property m_icon;`）。
      if (this.propMod(m.items[1], m.items[2])) {
        // 结构体的成员属性不收：类才是一层命名空间，而取/存那两个函数要从那一层查过来
        //（`C.p.get()` 里的 `C.` 与体内裸写 `p.get()` 是同一条路，第五十二刀）。
        if (!cls) {
          for (const pd of this.flat(m.items[2])) {
            const pi = this.declarator(pd, sp, m.items[1], cls);
            this.nope(pd, `结构体的成员属性 '${pi === null ? '?' : pi.name}'`);
          }
          continue;
        }
        // `virtual` / `errorcode` 写在属性上那两条不在这儿拦 —— 与顶层那一格合在 propName 里，
        // 一处一句（见那儿的注释）。
        this.propPend.push({ it: m, ns: this.ns });
        continue;
      }
      // `static int m_table[10];` —— 静态字段是**类那一格上的**变量，不在对象里
      // （01_Classes.jnc:22）。它要一格模块级的槽加"从方法里查得着"，是另一刀。
      if (sp.stat) { this.nope(m, '类的静态字段'); continue; }
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
        const info = this.declarator(d, sp);
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
          /* `opaque class` 里的原型（第六十六刀 + ADR-0022 的 J4b）：**没有体外那个定义** ——
             实现在宿主的 C/C++ 里（opaque.rst:15-29 的 `io.Serial` 就是这个形状）。
             名字与**签名**都记下来：调用点据此发 `(ccall Owner_method self …)`。
             体外真写了定义时这一格用不上（调用那边先按名字查，查着了就不问这里）。 */
          if (cls && key === 'opaque class') {
            this.hostFns.set(info.name, name);
            const hps = this.formalList(info.formals);
            if (hps !== null) {
              this.hostSigs.set(`${name}$${info.name}`, {
                owner: name, ret: info.type, params: hps.map((p) => p.type),
              });
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
        // 类**值**的字段：jancy 那边它是**内嵌**的（对象在父对象那一块里就地造出来，
        // type_class.rst 的 Construction 一节：member class fields "allocate inside the
        // parent block"）。这一层的类变量里放的是地址，内嵌要连"父对象造出来时把它也造
        // 出来"一起接 —— 那是另一刀。类**指针**的字段不在这条里：那一格就是一条引用
        // （`Node* m_next`），与第十七刀那条自引用的结构体指针字段同一格。
        if (isClass(info.type) && info.type.own === true) {
          this.nope(d, `类型是类（${tyName(info.type)}）的字段 —— 它在 jancy 那边是内嵌的对象`);
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
        // 函数指针的字段（第五十五刀）。量过：方言的**结构体**字段放不下 `(fnty …)`
        //（hir/types.js 的 structLayout 拒"落不进内存的字段"），而这一层的类与结构体都是
        // 一格 `(struct …)` + `pfield`。所以它是自己一格 —— 也正是虚表要落地的那一格。
        if (isFn(info.type)) {
          this.nope(d, `类型是函数指针（${tyName(info.type)}）的字段 —— 方言的结构体字段`
            + '还放不下函数值（见 hir/types.js 的 structLayout）');
          continue;
        }
        fields.push({ name: info.name, type: info.type });
        // 带初值的那几格记下来（第七十八刀）。排在所有"这一格不收"之后 —— 不收的那些
        // 已经 continue 掉了，不会带着一条永远发不出来的初值往下走。
        if (dflt !== null) inits.push({ name: info.name, type: info.type, expr: dflt, node: d0 });
      }
    }
    this.ns = saveNs;
    const fs = fields.map((f) => `(${f.name} ${fieldText(f.type)})`).join(' ');
    if (!cls) {
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
      const fs = fields.map((f) => `(${f.name} ${fieldText(f.type)})`).join(' ');
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
   *  语法里也落在这张表上，可它只对方法有意思 —— 别的位置默认报错，免得那个词被悄悄丢掉。 */
  specs(n, allowVirt = false, extra = []) {
    if (!isList(n) || head(n) !== 'specs') { this.err(n, '认不出的说明符表'); return null; }
    const mods = [...this.flat(n.items[2]), ...this.flat(n.items[3])]
      .map((m) => (isAtom(m) ? m.value : '?')).concat(extra);
    let thin = false;
    let stat = false;
    let uns = false;
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
        if (!allowVirt) {
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
      this.nope(n, `修饰符 '${m}'`);
      return null;
    }
    const ts = n.items[1];
    /* `event m_e(int x);` 的说明符里**没有类型**（jnc.grammar:263 那条注）：多播的处理函数
     * 一律回 void，所以那一格不用写。带实参那一串挂在声明符的括号里，由调用方（globalDecl /
     * 类的字段那一遍）从 formals 上读，这儿只把"这是一格事件"传上去。 */
    if (isList(ts) && head(ts) === 'no-type') {
      if (evt) return { type: J_MC, thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata: false, evt, rct, als };
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
      if (uns) return { type: mkInt(32, true), thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata: false, evt, rct, als };
      return { type: J_VOID, thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata: false, evt, rct, als };
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
    return { type: evt ? J_MC : base, thin, stat, fnptr, virt, errc, prop, cst, agt, bnd, bdata, evt, rct, als };
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
        // `PtrTypeFlag_Volatile`，jnc_Type.h:220）—— 留着，它是自己一刀。
        if (MUT_MODS.has(m)) continue;
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
   *  的调用方一律读 `info.sp`，不要读自己那一份。 */
  declarator(d, sp, spNode = null, allowVirt = false) {
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
      if (!acc && sk !== 'construct' && sk !== 'static construct') {
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
      if (acc) {
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
        if (t.k !== 'int' && t !== J_REAL && t !== J_BOOL && !jncIsStruct(t) && !jncIsEnum(t)) {
          return this.nope(s, `${tyName(t)} 的数组 —— 要方言能把多个字的值当元素搬（与 &p 同一格）`);
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
    return { name, type: t, formals, ctor, special: null, sp };
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
    return { name, type: tFn(params, sp.type, sp.thin), formals: null, ctor, special: null, sp };
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
   *  `def` 是形参的默认值那一格的**语法节点**（第七十七刀），没写就是 null。 */
  formalList(formalsNode) {
    const ps = [];
    for (const f of this.flat(formalsNode)) {
      const fh = isList(f) ? head(f) : null;
      if (fh === 'formals-varargs') return this.nope(f, '可变形参');
      if (fh === 'formal-anon') return this.nope(f, '无名形参');
      if (fh !== 'formal') return this.nope(f, `形参 '${fh}'`);
      const defNode = f.items[3] === undefined ? null : f.items[3];
      /* 默认值挂在**哪一格上都行**（第九十九刀）。先前这儿照 C++ 那条"只能挂末尾"拦着，
         理由写的是"中间那格空着调用点说不清"—— 那句在 jancy 上不成立：它检查默认值是
         **按位置一格一格**问的（`OperatorMgr_Call.cpp:421-435` 与 :447-460 那两段循环，
         报的是 "argument (%d) of '%s' has no default value"），而中间那一格空着怎么说，
         第八十八刀已经给出来了 —— `f(1,,3)`。所以这儿不该拦。 */
      const fsp = this.specs(f.items[1]);
      if (fsp === null) return null;
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
   */
  withDefaults(args, want, defs) {
    const out = args.slice();
    for (let i = 0; i < out.length; i++) {
      if (!isList(out[i]) || head(out[i]) !== 'unbound') continue;
      const d = defs === null || i >= want.length ? null : defs[i];
      if (d === null) {
        return this.err(out[i], `第 ${i + 1} 个实参是空的，而它那个形参没有默认值`);
      }
      if (!this.defShapeOk(d)) {
        return this.nope(d, '这个形状的默认值（默认值是在调用点算的，所以只收字面量、'
          + '`true`/`false`/`null`、枚举成员，与它们的运算）');
      }
      out[i] = d;
    }
    if (defs === null || out.length >= want.length) return out;
    for (let i = out.length; i < want.length; i++) {
      const d = defs[i];
      if (d === null) break;              // 中间那格没有默认值：个数照旧对不上，由调用方报
      if (!this.defShapeOk(d)) {
        return this.nope(d, '这个形状的默认值（默认值是在调用点算的，所以只收字面量、'
          + '`true`/`false`/`null`、枚举成员，与它们的运算）');
      }
      out.push(d);
    }
    return out;
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
    if (isList(ob) && LV_SHAPES.has(head(ob))) {
      const o = this.lvalue(ob);
      if (o === null) return null;
      bv = { code: this.read(o), type: o.type };
    } else {
      bv = this.expr(ob, null);
      if (bv === null) return null;
    }
    if (!isClass(bv.type)) return undefined;
    const pn = this.findProp(bv.type.name, mn);
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
      return this.nope(n, `写属性 '${shown(pn)}' —— 它的存值器没有定义`
        + '（简单声明式的体写在别处：`p.set(T x) { … }`，prop_simple.rst:29）');
    }
    const sf = this.propSelf(n, pn, pi, self);
    if (sf === null) return null;
    const ix = this.propIndexArgs(n, pn, pi, subs);
    if (ix === null) return null;
    let v = this.expr(valNode, pi.type);
    if (v === null) return null;
    if (isInt(v.type) && isInt(pi.type)) v = intConv(v, pi.type);
    if (!sameTy(v.type, pi.type)) {
      return this.err(n, `属性 '${shown(pn)}' 是 ${tyName(pi.type)}，`
        + `这儿给的是 ${tyName(v.type)}`);
    }
    return [`${pad}(expr (call ${s}${sf}${ix} ${v.code}))`];
  }

  /**
   * 属性的取/存那两个函数的签名（第六十八刀）。
   *
   * 名字这一层自己拼：`p$get` 与 `p$set`。类的成员属性多一格 `this`（与方法同一条，
   * 第五十二刀），于是 `obj.p` 读出来就是一句 `(call C$p$get obj)`。
   *
   * 规矩来自 prop.rst:15-17："Each property has a single getter and optionally one or more
   * setters" —— 取值器只有一个、回属性的类型；存值器收一个实参、类型是属性的类型；
   * 一个 setter 都没有的就是 **const 属性**。存值器的**重载** jancy 收，这一层一个名字
   * 一格函数，所以第二个 `set` 明说不收。
   */
  propSig(n, info, ps) {
    if (info.name === '') return this.err(n, "'get' / 'set' 前面要写属性的名字");
    const pn = this.resolve(info.name, (k) => this.props.has(k));
    if (pn === null) return this.err(n, `没有这个属性：'${shown(info.name)}'`);
    const pi = this.props.get(pn);
    const full = `${pn}$${info.special}`;
    if (this.fns.has(full)) {
      return this.nope(n, `${shown(pn)} 的第二个 '${info.special}'（属性的存值器重载要重载决议）`);
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
      if (!sameTy(ps[k].type, pi.type)) {
        return this.err(n, `'${shown(pn)}.set()' 收的是 ${tyName(ps[k].type)}，`
          + `而属性 '${shown(pn)}' 是 ${tyName(pi.type)}`);
      }
      pi.set = true;
    }
    if (pi.cls !== null) {
      ps.unshift({ name: 'this', type: tClass(pi.cls, false), formals: null });
      this.methods.set(full, pi.cls);
    }
    info.name = full;
    // 属性是一层命名空间（第七十一刀，prop_full.rst:15）：记下"这个函数属于哪格属性"，
    // 体降下来时靠它把 `this.ns` 挪进去 —— autoget 生成的 `m_value` 就那样查得着。
    this.propOf.set(full, pn);
    this.fns.set(full, sigOf(ps, ret));
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
    const sp = special === null || special === 'get' ? this.specs(n.items[1], true)
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
      if (info.special === 'get' || info.special === 'set') return this.propSig(n, info, ps);
      const owner = info.name === ''
        ? (this.classes.has(this.ns) ? this.ns : null)
        : this.resolve(info.name, (k) => this.classes.has(k));
      if (owner === null) {
        return this.err(n, `'${info.special}' 只能是类的成员（写在类体里，或写成 `
          + `'${info.name === '' ? 'C' : shown(info.name)}.construct()'）`);
      }
      const stat = info.special === 'static construct';
      const full = stat ? `${owner}$construct$static` : `${owner}$construct`;
      // 构造的**重载** jancy 是收的（形参不同的好几个 `construct`），这一层一个名字一格函数。
      if (this.fns.has(full)) {
        return this.nope(n, `${shown(owner)} 的第二个 '${info.special}'（构造的重载要重载决议）`);
      }
      info.name = full;
      if (stat) {
        // 静态构造不带 `this`，也**不带形参**：jancy 那句话把两件事一起说了 —— "Constructors
        // can be overloaded, the rest of construction methods must have no arguments"
        //（type_class.rst:63）。它是**类那一格上**的一次性初始化，不属于哪个对象。
        if (ps.length > 0) return this.err(n, "'static construct' 不带形参");
        this.sctors.set(owner, full);
      } else {
        ps.unshift({ name: 'this', type: tClass(owner, false), formals: null, def: null });
        this.methods.set(full, owner);
        this.ctors.set(owner, {
          name: full,
          params: ps.slice(1).map((p) => p.type),
          defs: sigOf(ps.slice(1), J_VOID).defs,
        });
      }
      this.fns.set(full, sigOf(ps, J_VOID));
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
      if (sp.errc) return this.nope(n, '`errorcode` 写在 `main` 上（错传不到调用方去）');
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
        this.methods.set(info.name, owner);
        this.methodNames.add(base.slice(cut + 1));
        ps.unshift({ name: 'this', type: { k: 'struct', name: owner }, formals: null });
        if (sp.virt !== null) {
          this.nope(n, `结构体的方法 '${shown(base)}' 上写 '${sp.virt}'（虚派发要对象头那一格`
            + '类型标签，结构体没有）');
        }
        this.fns.set(info.name, sigOf(ps, info.type));
        return { info, ps, isMain: false };
      }
      if (owner !== null && this.classes.has(owner)) {
        this.methods.set(info.name, owner);
        this.methodNames.add(base.slice(cut + 1));
        ps.unshift({ name: 'this', type: tClass(owner, false), formals: null });
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
      // errorcode（第五十八刀）：出错值由返回类型定，见 errcReg。
      if (sp.errc && this.errcReg(n, info.name, info.type) === null) return null;
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
    return null;
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
  pickOverload(n, base, argNodes, hasSelf) {
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
      const counts = cands.map((c) => shape(c).want.length);
      return this.err(n, `'${shown(base)}' 有 ${cands.length} 条重载，收的实参个数是 `
        + `${counts.join(' / ')}，这里给了 ${given} 个`);
    }
    // 按类型排。先把这几个实参的类型问出来 —— 有一个问不出来就整条不猜。
    const tys = argNodes.map((a) => this.cheapTy(a));
    if (tys.some((t) => t === null)) {
      return this.nope(n, `'${shown(base)}' 的同元重载：第 `
        + `${tys.findIndex((t) => t === null) + 1} 个实参的类型这一层还得先降一遍才知道`
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
  ctorArgs(node, cls, argNodes0) {
    const ct = this.ctors.get(cls);
    if (ct === undefined) {
      if (argNodes0.length > 0) {
        return this.err(node, `${shown(cls)} 没有 construct，后面挂不了构造实参`);
      }
      return null;                     // 没有构造：什么都不用调
    }
    const want = ct.params;
    const argNodes = this.withDefaults(argNodes0, want,
      ct.defs === undefined ? null : ct.defs);
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
    return { name: ct.name, vals };
  }

  /**
   * `C1 a;` / `C1 a(100);` 里那一句构造调用（第五十三刀）。类的变量一声明就是**造一个对象**
   * （第五十二刀那段），造完紧接着就是构造 —— jancy 的 `initializeObject` 之后调的正是它。
   * 没有构造（也没有静态构造）时一个字都不发。回 null 表示报过错了。
   */
  ctorCall(node, cls, self, ctorNode, pad, out) {
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
    if (spec.endsWith('.jncx')) {
      return this.nope(it, `import "${spec}"（.jncx 是编译好的扩展库、不是源码；`
        + '这一层走的是另一条路：直接 import "libfoo.dylib"，声明照旧写在源码里）');
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
    this.collectAddrTaken(n.items[3], taken);
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
      /* 字段的默认值（第七十八刀）：排在基类构造与静态构造之后、用户写的那个体之前 ——
         正是 jancy 那四句的第三句（jnc_ct_Parser.cpp:3005-3009 的 initializeFields）。
         所以 construct 里再给同一格字段赋值会**盖掉**默认值，与 jancy 一致。
         上下文已经摆好了（this.ns 在类上、`this` 别名成 `$this`、形参都 push 过），
         所以这儿直接用当前上下文降，不另开一格。 */
      for (const l of this.fieldInitLines(owner, 4)) pre.push(l);
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
    this.nope(n, `语句 '${h}'`);
    return null;
  }

  /** 局部量。没写初值的按零初始化 —— jancy 保证"用户代码碰到之前每一格都是零"。 */
  localDecl(n, ind) {
    const pad = ' '.repeat(ind);
    const sp = this.specs(n.items[1]);
    if (sp === null) return null;
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
      if (info.formals !== null) { this.nope(dcl, '局部的函数原型'); return null; }
      // 声明符尾巴上的构造实参只有类的变量收得下（第五十三刀）：别的类型那一格 jancy 也没有
      // 构造可调 —— 不明说就会被悄悄丢掉。
      if (info.ctor !== null && !(isClass(info.type) && info.type.own === true)) {
        this.err(dcl, `'${info.name}' 不是类的变量，后面挂不了构造实参`);
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
          if (v === null) return null;
          if (!this.assignOk(v.type, info.type)) {
            this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(info.type)}`);
            return null;
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
          return null;
        }
        if (this.lifted.has(info.name)) {
          this.nope(dcl, `对类的变量取地址（&${info.name}）—— 那要一格 \`C**\``);
          return null;
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
          if (v === null) return null;
          if (!this.assignOk(v.type, info.type)) {
            this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(info.type)}`);
            return null;
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
        continue;
      }
      let code = null;
      if (initNode === null) {
        // 函数指针不写初值（第五十五刀）：方言的函数值那一格**没有空值** —— `(let …)` 要一个
        // 初值，而"空的函数指针"发不出来（连 `if (p)` 也就跟着立不住）。jancy 那边它是零，
        // 调它是运行期的 "null function pointer" 错，要接得连那一格空值一起接。
        if (isFn(info.type)) {
          this.nope(dcl, `${tyName(info.type)} 的局部量不写初值（方言的函数值那一格没有空值）`);
          return null;
        }
        code = zeroText(info.type);
        if (code === null) {
          // 走到这儿只剩 void 与 string 那几种不该出现在局部量上的类型（结构体与数组
          // 在上面两条分支里各自开了自己那一格内存）。
          this.nope(dcl, `${tyName(info.type)} 的局部量不写初值`);
          return null;
        }
      } else {
        let v = this.expr(initNode, info.type);
        if (v === null) return null;
        if (isInt(v.type) && isInt(info.type)) v = intConv(v, info.type);
        if (!this.assignOk(v.type, info.type)) {
          this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(info.type)}`);
          return null;
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
      return this.nope(dcl, `${tyName(t)} 的 static 局部量（要一道 once 闸门把对象造出来再构造）`);
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
        const f = this.selfField(nm);
        if (f !== null) {
          return {
            kind: jncIsStruct(f.type) || isArr(f.type) ? 'agg' : 'ptr',
            code: `(pfield (var $this) ${f.name})`,
            type: f.type,
          };
        }
      }
      if (r === null) {
        // 属性不是一格内存（第六十九刀，与 memberOf 里那一条同一句）：`g_p++`、`&g_p` 落到
        // 这儿来。报"未声明"是认错了人 —— 那个名字在，只是它那一格要走取/存两个函数。
        const pq = this.propBare(nm);
        if (pq !== null) {
          return this.nope(n, `属性 '${shown(pq)}' 当一格可写的内存用 —— 读写各是一次调用，`
            + '`++`、`&` 与复合赋值这类"就地改"的写法这一层接不上');
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
      if (!jncIsPtr(p.type)) return this.err(n, `'*' 要一个指针，这里是 ${tyName(p.type)}`);
      const tt = p.type.target;
      return { kind: jncIsStruct(tt) || isArr(tt) ? 'agg' : 'ptr', code: p.code, type: tt };
    }
    // `p[i] = v`。jancy 的下标就是 `*(p + i)`，范围检查在解引用那一步
    // （type_ptr_data.rst：Range is checked on both array accesses and pointer dereferences）
    if (h === 'index') {
      const a = this.expr(n.items[1], null);
      if (a === null) return null;
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
    const p = this.expr(ptrNode, null);
    if (p === null) return null;
    if (!jncIsPtr(p.type)) return this.err(n, `'->' 要一个指针，这里是 ${tyName(p.type)}`);
    if (!jncIsStruct(p.type.target)) return this.err(n, `'->' 的目标不是结构体：${tyName(p.type.target)}`);
    return this.memberOf(n, p.code, p.type.target.name, memNode);
  }

  /** 一个字段的位置：`(pfield 地址 f)`。字段自己是结构体或数组时它又是一格 `agg`（嵌套）。 */
  memberOf(n, baseCode, structName, memNode) {
    const nm = isAtom(memNode) ? memNode.value : null;
    const fs = this.structs.get(structName);
    const f = fs === undefined ? undefined : fs.find((x) => x.name === nm);
    if (f === undefined) {
      // 属性不是一格内存（第六十九刀）：`b.p++`、`&b.p` 这些"就地改/取地址"的写法会落到这儿。
      // 报"没有这个字段"是认错了人 —— 那个成员在，只是它那一格要走取/存两个函数。左边得是
      // **类**才问这一句：属性只长在类上，结构体那边同名的字段不存在时报的仍旧是"没有字段"。
      if (nm !== null && this.propNames.has(nm) && this.classes.has(structName)) {
        return this.nope(n, `属性 '${nm}' 当一格可写的内存用 —— 读写各是一次调用，`
          + '`++`、`&` 与复合赋值这类"就地改"的写法这一层接不上');
      }
      return this.err(n, `${structName} 没有字段 '${nm}'`);
    }
    return {
      kind: jncIsStruct(f.type) || isArr(f.type) ? 'agg' : 'ptr',
      code: `(pfield ${baseCode} ${nm})`,
      type: f.type,
    };
  }

  store(lv, valueCode) {
    return lv.kind === 'var' ? `(set ${lv.name} ${valueCode})` : `(pstore ${lv.code} ${valueCode})`;
  }

  /** 取值。`agg`（结构体那一格）的 code **就是**地址，所以不 pload —— 结构体的"值"在这一层
   *  一律用它那段内存的地址表示，要抄一份的地方由 copyAgg 逐字段抄。 */
  read(lv) {
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
      }
      const lv = this.lvalue(n.items[2]);
      if (lv === null) return null;
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
      // 语句位置上前缀与后缀没有差别（都不取值）
      const lv = this.lvalue(n.items[1]);
      if (lv === null) return null;
      const up = h === 'pre-inc' || h === 'post-inc';
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
  hostMethodCall(n, callee, owner, mn) {
    const sig = this.hostSigs.get(`${owner}$${mn}`);
    if (sig === undefined) {
      return this.nope(n, `'${shown(owner)}.${mn}'（这个方法的原型没收下来）`);
    }
    if (head(callee) !== 'field') {
      return this.err(n, `'${shown(owner)}.${mn}' 要一个对象来调它`);
    }
    const ob = callee.items[1];
    let bv = null;
    if (isList(ob) && LV_SHAPES.has(head(ob))) {
      const o = this.lvalue(ob);
      if (o === null) return null;
      bv = { code: this.read(o), type: o.type };
    } else {
      bv = this.expr(ob, null);
      if (bv === null) return null;
    }
    if (!isClass(bv.type)) {
      return this.err(n, `'${tyName(bv.type)}' 不是类，上面问不出方法 '${mn}'`);
    }
    const sym = `${owner.replace(/\$/g, '_')}_${mn}`;
    const rw = this.cabiWordOfJnc(sig.ret, true);
    if (rw === null) {
      return this.nope(n, `'${shown(owner)}.${mn}' 的返回类型 ${tyName(sig.ret)}`
        + '（落不进 C_ABI 的那几个词）');
    }
    const args = this.flat(n.items[2]);
    if (args.length !== sig.params.length) {
      return this.err(n, `'${shown(owner)}.${mn}' 要 ${sig.params.length} 个实参，`
        + `这里给了 ${args.length} 个`);
    }
    const words = ['ptr'];
    const parts = [bv.code];
    for (let i = 0; i < args.length; i++) {
      const w = this.cabiWordOfJnc(sig.params[i], false);
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
      parts.push(v.code);
    }
    /* 一个符号只发一句声明（方言那侧重复声明是错）。 */
    if (!this.cabiNames.has(sym)) {
      this.decls.push(`  (cabi ${sym} ${rw} (${words.join(' ')}))`);
      this.cabiNames.add(sym);
      this.cabiSigs.set(sym, { ret: rw, params: words, sym });
    }
    return { code: `(ccall ${sym} ${parts.join(' ')})`, type: sig.ret };
  }

  ccallSite(n, nm, sig) {
    const args = this.flat(n.items[2]);
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
          // 无名枚举漏出来的那些成员（第九十六刀）：`enum { A = 1 }` 之后裸写 `A`。
          const ex = this.exposedLit(nm);
          if (ex !== null) return ex;
          // `with "h.h"` 收来的常量（第 J4d 刀）：宏与枚举常量在这儿变成一格字面量。
          const cv = this.cconstLit(n, nm);
          if (cv !== null) return cv;
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
      case 'indirect': return this.load(n, this.derefLv(n));
      case 'index': {
        // 索引属性的读（第七十刀）：`p[i][j]` 是"调取值器、下标当实参"，不是解引用。要排在
        // derefLv 之前问 —— 那儿只会报"下标要一个指针"。
        const ig = this.propIndexGet(n);
        if (ig !== undefined) return ig;
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
      case 'pre-inc': case 'post-inc': case 'pre-dec': case 'post-dec':
        return this.nope(n, `表达式里的 ${h}（方言里它是语句；单独写成一行就行）`);
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
    // null 那一侧要从另一侧知道自己的类型，所以先降"不是 null"的那一边
    const lNull = isList(n.items[2]) && head(n.items[2]) === 'null';
    const rNull = isList(n.items[3]) && head(n.items[3]) === 'null';
    // `&&` / `||` 的右边是惰性的（第五十八刀）：那儿插不进传播的语句，见 ecLazy。左边总是求值。
    const rhs = (want) => (op === '&&' || op === '||'
      ? this.ecLazy(() => this.expr(n.items[3], want))
      : this.expr(n.items[3], want));
    let a = null;
    let b = null;
    if (lNull && !rNull) {
      b = rhs(null);
      if (b === null) return null;
      a = this.expr(n.items[2], b.type);
    } else {
      a = this.expr(n.items[2], null);
      if (a === null) return null;
      b = rhs((jncIsPtr(a.type) || isClass(a.type)) && rNull ? a.type : null);
    }
    if (a === null || b === null) return null;
    // `&&` / `||` 两边各自真值化（jancy 与 C 同：`p && n` 是合法的）。方言的
    // `(bin "&&" …)` 是惰性的（Logic 节点），短路语义不用这一层操心。
    if (op === '&&' || op === '||') {
      const ta = this.truthy(a, n.items[2]);
      const tb = this.truthy(b, n.items[3]);
      if (ta === null || tb === null) return null;
      return { code: `(bin "${op}" ${ta.code} ${tb.code})`, type: J_BOOL };
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
  ternary(n, want) {
    const c = this.cond(n.items[1]);
    // 两支是**惰性**的（第五十八刀）：只算取中的那一支，所以传播那两句插不到这条语句之前去。
    let a = this.ecLazy(() => this.expr(n.items[2], want));
    let b = this.ecLazy(() => this.expr(n.items[3],
      want === null || want === undefined ? (a === null ? null : a.type) : want));
    if (c === null || a === null || b === null) return null;
    // 两支都是整数：结果是常用算术转换定出的那一格。有符号之间加宽在规范形里不发一个字，
    // 可换符号性要真的转（第三十三刀），所以这儿两支都过一遍 intConv。
    if (isInt(a.type) && isInt(b.type)) {
      const rt = common(a.type, b.type);
      const x = intConv(a, rt);
      const y = intConv(b, rt);
      return { code: `(sel ${c.code} ${x.code} ${y.code})`, type: rt };
    }
    if (isInt(a.type) && b.type === J_REAL) a = { code: realOf(a.code, a.type), type: J_REAL };
    else if (a.type === J_REAL && isInt(b.type)) b = { code: realOf(b.code, b.type), type: J_REAL };
    if (!sameTy(a.type, b.type)) {
      return this.err(n, `'? :' 两支不同型：甲是 ${tyName(a.type)}，乙是 ${tyName(b.type)}`);
    }
    return { code: `(sel ${c.code} ${a.code} ${b.code})`, type: a.type };
  }

  /**
   * `basetype.成员`（第五十六刀 + 第九十四刀）。jancy 拿 `basetype` 与 `basetype1` .. `basetype9`
   * 指基类，用处是**构造**与**名字解析**（type_class.rst:226）。不带序号的就是第 1 格
   * （语法树里 `(basetype 1)`），`basetype2` 起指第二格往后的那些基类。
   *
   * 回的是方言里那个函数名 —— 静态绑定，`basetype.foo()` 说的就是"调基类那一个"。
   */
  baseTarget(n, bt, mn) {
    const idx = isAtom(bt.items[1]) ? Number(bt.items[1].value) : 1;
    if (this.selfClass === null) return this.err(n, "'basetype' 只能写在方法体里");
    const dirs = this.dirBases(this.selfClass);
    if (dirs.length === 0) {
      return this.err(n, `${shown(this.selfClass)} 没有基类，'basetype' 指不着谁`);
    }
    if (idx < 1 || idx > dirs.length) {
      return this.err(n, `${shown(this.selfClass)} 只有 ${dirs.length} 格基类，`
        + `'basetype${idx}' 指不着谁`);
    }
    const base = dirs[idx - 1];
    if (mn === null) return this.nope(n, "'basetype' 后面那个成员认不出来");
    if (mn === 'construct') {
      const c = this.ctors.get(base);
      if (c === undefined) return this.err(n, `${shown(base)} 没有 construct`);
      return c.name;
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
      nm = b;
      self = '(var $this)';
      statBind = true;
    }
    if (nm === null && mn !== null && this.methodNames.has(mn)) {
      const m = this.methodCallee(n, callee, mn);
      if (m === null) return null;
      nm = m.name;
      self = m.self;
    }
    if (nm === null && nm0 === null) return this.nope(n, '不是直接调一个名字的调用');
    /* 名字查不着，而它是某个 `opaque class` 上声明过的方法（第六十六刀 + ADR-0022 的 J4b）：
       那不是"没有这个函数"，是**实现在宿主那边** —— 发 `(ccall Owner_method self …)`。 */
    if (nm === null) {
      const hostOwner = mn === null ? undefined : this.hostFns.get(mn);
      if (hostOwner !== undefined) return this.hostMethodCall(n, callee, hostOwner, mn);
    }
    /* `with "h.h"` 收进来的那些（ADR-0022 的 J4d）：调用点发 `(ccall …)` 而不是
       `(call …)` —— 实参已经是机器值，不过 marshaler。实参与返回都按**声明**检查，
       签名是从头文件里收来的那一份（`cabiSigs`），不是从调用点猜的。 */
    if (nm === null && nm0 !== null && this.cabiSigs.has(nm0)) {
      return this.ccallSite(n, nm0, this.cabiSigs.get(nm0));
    }
    /* `import "libfoo.dylib" as g`（没有 `with`）：`g.foo(…)` 的类型从调用点猜，带 warning。 */
    if (nm === null && nm0 !== null && nm0.includes('.')) {
      const dot = nm0.lastIndexOf('.');
      const pre = nm0.slice(0, dot);
      if (this.cLibNs.has(pre)) return this.ccallGuess(n, pre, nm0.slice(dot + 1));
    }
    if (nm === null) return this.err(n, `没有这个函数：'${nm0}'`);
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
      const pick = this.pickOverload(n, nm, args0, self !== null);
      if (pick === null) return null;
      nm = pick;
    }
    const sig = this.fns.get(nm);
    const want = self === null ? sig.params : sig.params.slice(1);
    const defs = sig.defs === undefined || sig.defs === null ? null
      : (self === null ? sig.defs : sig.defs.slice(1));
    const args = this.withDefaults(args0, want, defs);
    if (args === null) return null;
    if (args.length !== want.length) {
      return this.err(n, `'${nm0 === null ? shown(nm) : nm0}' 要 ${want.length} 个实参`
        + `${defs === null ? '' : `（其中 ${defs.filter((d) => d !== null).length} 个有默认值）`}`
        + `，这里给了 ${args0.length} 个`);
    }
    const parts = self === null ? [] : [self];
    for (let i = 0; i < args.length; i++) {
      let v = this.expr(args[i], want[i]);
      if (v === null) return null;
      // 实参与赋值同一条规矩：整数隐式转到形参那一格（窄了就回卷）。
      if (isInt(v.type) && isInt(want[i])) v = intConv(v, want[i]);
      if (!this.assignOk(v.type, want[i])) {
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
  methodCallee(n, callee, mn) {
    const ob = callee.items[1];
    let bv = null;
    if (head(callee) === 'field' && isList(ob) && LV_SHAPES.has(head(ob))) {
      const o = this.lvalue(ob);
      if (o === null) return null;
      bv = { code: this.read(o), type: o.type };
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
    if (isList(ob) && LV_SHAPES.has(head(ob))) {
      const o = this.lvalue(ob);
      if (o === null) return null;
      bv = { code: this.read(o), type: o.type };
    } else {
      bv = this.expr(ob, null);
      if (bv === null) return null;
    }
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
    if (argsNode !== null && !isClass(t)) {
      return this.err(n, `new ${tyName(t)}(…)：只有类有构造，实参没处去`);
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
      // `opaque class` 声明了 construct、可体在宿主那边（第六十六刀）：造出来的对象不能
      // 假装"没有构造"就交出去 —— 那是**悄悄少跑一段**。所以这儿明说。
      if (!hasCtor && this.hostCtors.has(t.name)) {
        return this.nope(n, `new ${shown(t.name)}(…) —— 它的 construct 声明在 opaque class 里、`
          + '实现在宿主的 C/C++ 那边（opaque.rst:15-29），这一层还没有宿主面');
      }
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


