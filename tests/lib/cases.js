// tests/lib/cases.js —— **例子表：语言 × 家族**（好几条判据共用一份）
//
// 抽出来的理由只有一条：**同一张表要被几条判据用**。
//   * `tests/lower/run.js`     —— adapter → 标准 IR → 公共 lower → `.sx` → 真跑一趟
//   * `tests/grammar/delete.js` —— **可删除测试**（删掉一条产生式，不用它的例子必须照旧全绿）
// 抄两份的话，加一门语言就要改两处，而其中一处一定会忘。
//
// 语言的登记处（语法 · adapter · 后缀）。这一份**只挑家族**，不再自己抄一张语言表。
import { LANGS } from '../../src/core/lower/langs.js';

/**
 * 期望的输出。**一个例子家族一份**，家族里所有语言、所有后端共用 ——
 * 这就是这一格的全部判据。
 *   basics  ：第一批节点（decl / func / 控制流 / 循环 / print）
 *   multi   ：多值那两格（values / pick）+ arity 契约（列表里只有最后一格展开）
 *   defer   ：scope-exit —— 逆序 + 早退也跑
 *   record  ：record-new / field-get / field-set（**与类型无关**）
 *   index   ：list-new / index-get / index-set（下标起点是语言的事）
 *   loopexit：break / continue（函数边界之外的第一格 may-early-exit）
 *   intmath ：**四条腿都跑得动的那个子集**
 */
export const BASICS = ['15', '120', '7', 'ok'];
export const MULTI = ['3', '7', '1 2'];
export const DEFER = ['in', 'b', 'a', 'out'];
export const RECORD = ['1', '5', '6'];
export const INDEX = ['10', '30', '45'];
export const LOOPEXIT = ['12', '6', '8'];
export const INTMATH = ['15', '120'];
/** conv：表示转换那一格 —— 目标是附属，写法是语言的事（`int` / `f64` / `CInt` / `Int`） */
export const CONV = ['2', '3.5'];
/** slice：一段范围复制成一格新列表（上界不含、0 起） */
export const SLICE = ['20', '30'];
/** values：多值那两格的另外两个提供者（CL 的 `values` 与 nim 的元组） */
export const VALUES = ['3', '7'];
/**
 * deferarg：**go 独有的那一条** —— defer 的实参在注册那一刻就算掉。
 * 只有一门语言（G5 那条判据里的"一家"），所以它不是一格新节点，
 * 是 go 自己用 bind + ref 说清的一条规矩（`fromtree.js` 的 `deferNow`）。
 */
export const DEFERARG = ['2', '1'];
/** dict：map 那四格（map-new / map-get / map-set / map-has）—— 键是**值**不是名字 */
export const DICT = ['1', '3', '4', 'yes'];
/** strcat：串接（lua 的 `..` / nim 的 `&` / go 与 V 的 `+`）—— 一格内建，不是新节点 */
export const STRCAT = ['ab', 'hi there'];
/** numstr：数 -> 串（lua 隐式、nim 显式的 `$`）—— 两格节点、一份输出 */
export const NUMSTR = ['n=7', 'i=42'];
/** namedarg：`T(x: 1)`（record-new）与 `f(a = 3)`（call）—— 树上**不同形**，那笔账记错了 */
export const NAMEDARG = ['1', '7'];
/**
 * method：**方法不是一格新节点** —— 名字从声明来，接收者只是第一格实参。
 * 三行分别是：点号写法 · 点号写法带实参 · 函数写法（与第一行是**同一张图**）。
 */
export const METHOD = ['3', '9', '3'];
/**
 * blockret：**CL 独有的那个形状** —— 早退是"从带名字的块里返回"。
 * `(return)` 在循环里落 loop-exit break、`(return-from f v)` 在 defun 里落 ret：
 * 形状独一门，节点一格新的都没加。三行是：循环里早退后的和 · 循环量 · 函数里早退的值。
 */
export const BLOCKRET = ['15', '6', '7'];
/**
 * mut：**改写一格已有的名字**（`set`）。单开一族的理由是账上算出来的 ——
 * `set` 规格十门、矩阵九门，缺的 chez 欠的不是机制而是**一份用它的例子**。
 */
export const MUT = ['1', '3'];
/**
 * vardecl：**`var` / `const`**（go 独一份）—— 零值、const 组里省略初值就重复上一条、
 * `iota` 是组里的序号、`_` 是空位。前四行落到的节点全是 bind，**一格新的都没有**。
 * 中两行是**语句头上的声明位**：`if v := …; cond`（init 的作用域是整条链 -> region 包着
 * branch）与 `for ; cond ;`（省掉的格子在树上是 `(none)`，不是节点）。
 * 末一行是**泛型函数**（类型参数丢掉 -> 一格普通函数）—— 它钉的是一件结构上的事：
 * 那条产生式比不带类型参数的**多一格**，所以映射里要按标签找签名与体，不能按位置数。
 * 前面三行是**定长数组的零值**（N 格各一格）、**`make(map…)` / `make([]T, 0)`**
 * （第一格实参是一格类型，所以要在"先算实参"之前拦；而"这名字装的是 map"那张表要
 * 两种造法都认，漏一种 `m["k"] = 5` 就静静变成列表下标写）、`len(xs)` 落 `prim len`。
 */
export const VARDECL = ['15', '1', '3', '6', '5', '2', '7', '5', '0', '9'];
/**
 * enumval：**枚举的值 · Option 上的转换**（V 独一份）—— 枚举的声明在图上是丢掉的，
 * 可 `.red` / `Color.red` 要拿到**值**，所以名字与值从**声明**登记（与"字段名与顺序从声明来"
 * 同一条路子）。`.red` 的类型从上下文来而这一层看不见，靠"变体名唯一"定、撞了当场报。
 * 末两行是 `?int(…)`：Option 那一层的类型丢掉了，所以 `?int(7)` 就是 7、`?int(none)` 是 nil。
 */
export const ENUMVAL = ['1', '2', '11', '0', '7', '1'];
/**
 * litnone：**"同一个标签两件事"那一族**（V 独一份）—— 定长数组 · `none` · 三段 for 的空格子 ·
 * 不写类型的 map 字面量 · `unsafe` 块。`(none)` 既是 Option 空值又是空格子（条件落成 nil
 * 就是"条件为假"，`for ;; {}` 会一次都不跑）；`(map …)` 既是字面量又是类型（靠"孩子全是
 * kv"分开），而"这名字装的是 map"那张表要**两种写法都认**，漏一种 `m['b']` 就变成列表下标。
 * 末两行是 `if v := maybe(…) { … } else { … }`：**语句头上的绑定** —— 落成 region 包着
 * "绑一格 + branch"（绑的那一格作用域是整条链），条件是"拆得开吗"（这一批落成 `!= nil`）。
 */
export const LITNONE = ['20', '5', '1', '3', '2', '9', '6', '8'];
/**
 * push：**`arr << x` 是列表追加**（V 独一份）—— 落一格内建 `prim push`，不是一格节点
 * （两格实参都是普通的值，与 `len` 同一类）。这一格是账上算出来的，而且那笔账原来**记错了**：
 * 尺子印的是"这个算子还没接：`<<`"，看着像位运算 —— 抽一遍语料才知道 V 的 `<<` 压倒性地
 * 是数组追加。
 */
export const PUSH = ['30', '40', '100'];
/**
 * member：**`x in 数组` 落一格内建 `contains`**（V 与 nim）—— 同样是账上算出来的
 * （"这个算子还没接：in" V 20 份 + nim 5 份），照 `push` 的分类落内建而不是节点。
 * 这一族压的是两条容易错而不报的：同一个 `in` 在**数组上找元素、在 map 上找键**
 * （后者是 `map-has`，在 `dict` 那一族里判着，映射先查"这名字装的是不是 map"）；
 * nim 那边源码写的是 `元素 in 容器`，而内建收的是 `contains(容器, 元素)` —— **次序相反**，
 * 所以那一格不能顺着 `binOf` 走。`!in` / `notin` 不是另一格，是 `not(contains(…))`。
 */
export const MEMBER = ['true', 'false', 'true', 'false'];
/**
 * pointer：**`&T{…}` 与图上的引用正好重合**（go 与 V）—— 图上一格新节点也没加。
 * `record-new` 交出来的是一格对象，两个名字绑上去指的是同一格，所以 `p := &T{…}` 之后
 * `p.f = 1` 改的就是那一格 —— 不是近似。这一族压三处：`&T{…}` 传进函数里改（外头看得见）、
 * 两个名字指同一格、`(*p).f` 剥掉那一层。**当场报的两处不在这儿**（判据只判走得通的路）：
 * `&x`（名字的地址）与光秃秃的 `*p` 当值用 —— 那两处要真的指针。
 */
export const POINTER = ['11', '20', '5', '20', '9'];
/**
 * optres：**Option / Result 落成"有没有值 + 一支垫底"**（V 独一份）—— 一格新节点也没加。
 * 四种写法各落一串现成的节点：`or { 垫底 }`（`if x == nil { set x = … }`）、
 * `or { panic(…) }`（`panic` 落那格 assert）、`f()!`（`if x == nil { return x }`）、
 * 单独一条语句的 `f() or { … }`（一格临时名，**那一支的值不要** —— 要了就把一格 print
 * 塞进值位置，wat 当场报）。`return error('…')` 也落 nil：**消息不在图上**，所以
 * `or { … }` 的体里一用 `err` 就当场报。
 */
export const OPTRES = ['6', '7', '5', '4', '10'];
/**
 * ctconst：**`@FN` / `@METHOD` / `@STRUCT` / `@MOD` 落一格常量串**（V 独一份）——
 * `编译期求值` 那一族里**不用求值**的那一半：它们问的是"我在谁里头"，答案就在树上。
 * 另一半当场报（位置那一族没有行号 · `@VEXE` 那一族是编译那台机器上的事）。
 * 这一族**故意不从函数里返回串**：wasm 那条腿的返回值上还接不住字符串（有名有姓的旧账）。
 */
export const CTCONST = ['who', 'demo', 'Box', 'Box.label', 'main'];
/**
 * fnval：**匿名函数当值用**（go 与 V）—— 落那格现成的 `func`，图上一格新节点也没加
 * （`func` 在清单里本来就是**表达式**，chez 的 lambda 就是这么落的）。名字是附属，
 * 匿名的现取一个（`__fnN`，按文件从 0 数起）。三种用法一起压：绑名字再调 · 当实参传 ·
 * 当场就调。**两条腿按名有姓地欠着**（c 的"按值调用"、core 的"func 在表达式位置上"）——
 * 两条都是既有的形状账。V 的**捕获表**那一种当场报：`[a]` 是按值抄一份，图上的闭包按引用。
 */
export const FNVAL = ['42', '15', '9'];
/**
 * bits：**位运算那六格内建**（go 与 V）—— `band` / `bor` / `bxor` / `bnot` / `shl` / `shr`，
 * 一格节点也没加。名字**用词不用符号**：图上的 `^` 早就是幂，而 go / V 的 `^` 都是 xor。
 * 算在 **64 位**上（interp 与 js 走 BigInt 再折回 Number —— js 的位运算是 32 位的），
 * 所以六条腿逐字节相同。写法差别归各自的映射（取反 `^x` / `~x`）。
 */
export const BITS = ['8', '14', '6', '6', '-13'];
/**
 * bitsgo：**go 自己那两格**（`<<` 与 `&^`）。单开一族的理由与 `deferarg` 同一条：
 * 别的语言写不出这个形状 —— V 的 `<<` 是列表追加（在 `push` 那一族），
 * `&^` 是 go 独一份，落的是 `band(a, bnot(b))` 两格现成的内建。
 */
export const BITSGO = ['48', '4'];
/**
 * caserange：**`of 1 .. 5:` 是一段区间**（nim 独一份）—— 落成两格比较用 and 串起来
 * （`n >= lo and n <= hi`），一格新节点也没加。nim 的区间是**中缀算符**（含上界），
 * 所以 case 的分支左边也能是它；从前这一支跟着走 `==`，那格 `..` 当场报。
 * wasm 那条腿按名跳过（返回值上还接不住字符串 —— 旧账）。
 */
export const CASERANGE = ['bad', 'ok', 'great', '?'];
/**
 * hoist：**表达式位置上的临时量（"物化"）**（V 独一份）—— `g(f() or { 0 })` 那一族。
 * 把"绑一格 + branch"提到当前语句前面，表达式位置只留一格 `ref`，一格新节点也没加。
 * 判据是**它前面不许有带副作用的东西**（`safeToHoist`）：包着它的那格调用**不算**"先发生"
 * （实参先算、调用后发生），而 `add(noisy(), f() or { 0 })` 那种**提不动**、照旧报。
 */
export const HOIST = ['12', '14', '108'];
/**
 * ctif：**编译期分支**（V 的 `$if` 与 nim 的 `when`）—— 走中的那一支摊开、没走的整格丢掉
 * （两门都明说没走的那支不要求编得过）。图上一格新节点也没加。
 * **环境是声明出来的**（`CT_ENV` / `NIM_CT_ENV`：linux · x64 · gcc）而不是"看这台机器" ——
 * 尺子要可重现。名字不在表里就当场报；V 的 `flag ?` 与 nim 的 `nimvm` 两格 false
 * 是**那门语言自己的规矩**，不是猜。
 */
export const CTIF = ['lin', 'notwin', 'both', 'flagoff'];
/**
 * charlit：**字符字面量落一格单字符的串**（V 独一份）—— 图上没有 char 那一格。
 * 这一格是**语料量出来的**：`` c == `e` `` 508 处 vs `` c + `0` `` 4 处（99.2% 是比较）。
 * 两端的 backtick 要去掉（记号里带着它们 —— 头一版漏了，`println(`x`)` 印出了 `` `x` ``）。
 * 算术那 4 处与 V 的 `s[i]`（按字节取）照旧在墙上：要类型层。
 * 这一族顺带在 core 那条腿上撞出**第二个** `retTypeOf` 的洞（match 当表达式落成 branch）。
 */
export const CHARLIT = ['true', 'false', 'x', 'vowel', 'other'];
/**
 * makelen：**`make([]T, n)` 落一格内建 `fill`**（go 独一份）—— 照 `push` / `contains`
 * 的分类：两格实参都是普通的值（长度、每格的初值），列表上的一个库函数，不是节点。
 * 元素的零值走 `zeroOf`（`vardecl` 那一刀定的那张表）。**只接标量初值** ——
 * js 的 `Array(n).fill(obj)` 是 n 格指向同一格，而具名结构体的零值在映射那层本来就报，
 * 所以两边的约束是对上的。wat 与 core 按名欠着（要一格循环）。
 */
export const MAKELEN = ['4', '0', '7', '2'];
/**
 * method2：**两个类型上的同名方法**（V 独一份）—— `docs/design/cross-file-methods.md`
 * 那条 A 路的判据。方法名按接收者类型压平（`Point__total` / `Box__total`），
 * 于是"重名要类型才分得开"那条墙不再是墙（V 那栏"类型才分得开"93 -> 50）。
 * **接收者的类型从哪儿来**也在这儿判着：`b := Box{…}` 那句写着的、形参上写着的 ——
 * 只收语法上写着的那一档（`VARTYPE`），不做推断。删掉 mangle 那一步，第二行就不是 12。
 */
export const METHOD2 = ['3', '12', '30', '7'];
/**
 * mapiter：**按键遍历**（图上第 29 格 `map-keys`，第三十批）。
 *
 * 前三行钉住的不只是"遍历跑通了"，是**次序**：六条腿必须给出同一个次序，而那个次序
 * 是**插入序**（`nodes.js` 里 map-keys 那段写着为什么）。go 的规范说 map 的迭代次序
 * 不定，所以"某个固定次序"是它的合法实现 —— 但六条腿之间不许分叉，不然这三行就不一样。
 *
 * 后两个数各压一格：`3` 是"键的列表真的出来了"（两格名字都不要，只按键数转）、
 * `9` 是"第二格名字给的是值"（1+3+5）。
 */
export const MAPITER = ['a', 'b', 'c', '3', '9'];
/**
 * ptrmethod：**指针接收者**（go 独一份）。
 *
 * 前两行压的是"声明与登记必须是同一个算法"：`func (c *Counter) get()` 发出来的名字是
 * `Counter__get`，而登记那一处从前只认光秃秃的 `(tname …)`，把主人记成 `'?'` ——
 * 调用点于是落 `ref ?__get`（**指向不存在的函数**）。落得出图、尺子数得上，跑起来才炸，
 * 所以只有这一族拦得住它。
 *
 * 第三行压的是**改**那一半：`c.add(4)` 之后 `c.n` 要是 5。图上接收者只是第一格实参，
 * 而记录在六条腿上都按引用传 —— 这一行就是那句话的判据。
 */
export const PTRMETHOD = ['1', '5', '5'];

/**
 * tokentest：**从 go 编译器摘出的 token 枚举 + 字符串化**（go 独一份）。
 *
 * 验的是"真实 go 代码能编到 JS 并正确运行"：47 格 iota 常量、切片索引表查字符串、
 * 位运算做集合判定。期望输出与 `go run` 逐行一致。
 */
export const TOKENTEST = ['EOF', 'name', 'literal', 'break', 'var', 'unknown', 'true', 'false'];

/**
 * postest：**从 go 编译器的 Pos / PosBase 摘出的位置编码**（go 独一份）。
 *
 * 与 tokentest 同一条性质（期望输出由 `go run` 给）：struct 造 + 字段读、
 * 常量位运算（`1 << 30`）、饱和截断、`Sprintf("%s:%d:%d")` 三格动词。
 */
export const POSTEST = ['1073741824', '1073741824', '100', 'test.go',
  '10', '20', 'true', 'false', 'test.go:10:20'];

/**
 * scanutil：**从 go 编译器的 source.go / scanner.go 摘出的扫描器工具函数**（go 独一份）。
 *
 * 位运算缓冲区增长、字符分类（isLetter/isDigit）、关键字 map 查表、
 * 字符串遍历切标识符。期望输出由 `go run` 给。
 */
export const SCANUTIL = ['4096', '8192', '2097152', '3145728',
  'true', 'false', 'true', 'true', 'false', 'true',
  'break', 'for', '22', '0'];

/**
 * syntaxpkg：**从 go 编译器 syntax 包摘出的综合测试**（go 独一份）。
 *
 * 在一个文件里组装 tokens + operators + Pos + 缓冲区增长 + 字符分类 +
 * 关键字查表 + 标识符扫描。20 行输出与 go run 逐行一致。
 */
export const SYNTAXPKG = [
  'EOF', 'break', 'var', 'unknown',
  '+', '==', '<<',
  '42', '7', '1073741824',
  '4096', '8192',
  'true', 'true', 'false',
  '31', '0',
  'hello', '_foo123',
];




/**
 * assertok：**断言那一格**（V 与 mojo）—— 条件与消息各一个端口。这一格是账上算出来的
 * （V 自己的编译器里 578 份文件的第一堵墙），也是**第二十八格节点**。
 * 这一族里的断言**都成立**，判的是"它不搅和别的"；不成立那一路在
 * `tests/graph/assertfail.js`（各腿的"停下来"不同形，所以单开一格判据）。
 */
export const ASSERTOK = ['3', '7'];
/**
 * casefor：**`case` 与 `for … in`**（nim 独一份）—— 落 branch 链 / `counted`，一格新节点
 * 都没加。nim 在这两处各有一条别人没有的：`case` 里除了 `of` 还能有 **`elif`**（走自己的
 * 条件，不是"主语等于什么"）；区间是**中缀算符**（`..<` 不含、`..` 含）而不是另一条产生式。
 * 末一行是 `discard f()`：算掉、把值扔了 —— 带作用的那一格留下。
 */
export const CASEFOR = ['10', '20', '30', '40', '60', '6'];
/**
 * posinit：**位置型结构字面量**（V 独一份）—— `Point{1, 5}` 只给了值，字段名与顺序从
 * **声明**来（与 mojo / CL / Scheme / FB 那四门同一条）。同一条产生式两种写法：
 * 位置型出 `(positional …)`、带名字的出 `(f 名 值)`；混着写当场报。
 * 末一行是**第三种写法** `total(x: 2, y: 3)`：V 的"命名实参"就是那格参数结构体的字面量，
 * 所以落一格 record-new 当唯一实参 —— **不是**按形参名排回位置（那些名字是字段名）。
 */
export const POSINIT = ['3', '11', '16', '5'];
/**
 * match：**`match` 落一条 branch 链**（V 独一份）—— 与 go 的 switch 同一件事，多压一样：
 * match **既是语句也是表达式**，两者在图上不同形（语句那一路主语落一格 bind、体是 region；
 * 表达式那一路每支交出一个值、主语抄进每格比较、必须有 else）。
 */
export const MATCH = ['10', '20', '30', '200'];
/**
 * forin：**`for … in` 落一格计数循环**（V 独一份）—— **一个名字给的是元素**（与 go 正相反）、
 * 两个名字才是"下标 + 元素"、`0..4` 是区间（上界不含、终点只算一次）、嵌一层换号。
 */
export const FORIN = ['60', '80', '6', '9'];
/**
 * unary：**一元那三格**（lua 与 awk）—— `prim -`（一个实参就是取负）· `prim not` ·
 * `prim len`。这一族是 `tests/graph/deadcase.js` 找出来的：两份映射里那格 `case 'un'`
 * 是死代码（两门的语法给一元算子各自一条产生式），于是 `-x` / `not x` 一格都落不成图。
 * 第三行两门写法不同、节点相同：lua 写 `#s`、awk 写 `length(s)`。
 */
export const UNARY = ['-5', '1', '3'];
/**
 * decls：**顶层那几格声明与修饰**（V 独一份）—— `pub` 与 `@[inline]` 拆一层（不产生代码）、
 * `const` 落一串 bind（V 没有 go 那两条规矩）、`type X = …` 与 `interface` 整格丢掉、
 * `true` 是自己一条产生式而不是名字。
 */
export const DECLS = ['25', '20', '1'];
/**
 * forrange：**`for … range` 落一格计数循环**（go 独一份）—— 序列与长度只算一次、
 * 第一格是下标、第二格是元素（index-get）、`_` 不绑名字、`:=` 出 bind / `=` 出 set、
 * 嵌一层换号。五行各压一样。
 */
export const FORRANGE = ['80', '3', '30', '32', '9'];
/**
 * format：**格式串落成一格 `concat`**（go 独一份）—— 它先堵一个错而不报：`Printf` 原来在
 * "都落 print"那张表里，于是 `fmt.Printf("x=%d\n", 3)` 印成 `x=%d\n 3`。
 * 只接 `%d` / `%s` / `%v` / `%%`（在图上那三格动词是同一件事：`concat` 会把值印出来），
 * 别的当场报；`Printf` 自己不换行而 `print` 换行，所以格式串以 `\n` 收尾时去掉它。
 */
export const FORMAT = ['k=7', 'a=1 b=z', '100%', '42'];
/**
 * zeroval：**零值那一族**（go 独一份）—— `var x T` 的零值从**声明**来：具名 struct 是
 * "每个字段各自的零值"（字段名与顺序从 `type X struct{…}` 登记）、嵌套是递归一层、
 * 匿名 struct 走同一条路、别的具名类型（`type Level int` / `type Name = string`）是
 * **底子的零值**（一层间接）。图上一格新节点都没加，落的是 record-new。
 */
export const ZEROVAL = ['4', '0', '0', '0', 'true'];
/**
 * switch：**`switch` 落一条 branch 链**（go 独一份）—— 没有隐式贯穿，所以不给它开节点。
 * 六行分别压：主语相等 · 一个分支几个值（或）· default 垫底 · 没主语那一路 ·
 * `switch k := …; k` 的 init + 主语临时量 · 嵌一层换个临时量号。
 */
export const SWITCH = ['10', '20', '30', '2', '4', '3'];
/**
 * blockscope：**一段带自己作用域的语句**（nim 的 `block:` -> region）。
 * 里外两个同名的 `x`：块里印 5、块外印 1 —— 那两行压的是"region 真的开了一层作用域"。
 */
export const BLOCKSCOPE = ['5', '1'];

const C = (name, grammar, file, expect) => ({ name, grammar, file, expect });

/**
 * 一格例子 = 一门语言 × 一个家族。文件名是**算出来的**
 * （`ext/<lang>/examples/<家族>.<后缀>`）—— 那条命名约定因此不许破，破了当场报"文件没有"。
 *
 * 语法 / 后缀两样**从 `src/core/lower/langs.js` 取**（那是登记处）：抄两份的话加一门语言
 * 要改两处，忘掉的那处就是"测试里绿的、命令行上没有"。
 * 后缀取 `exts[0]`：例子文件用的就是那门语言最常见的那个后缀。
 */
const fam = (family, expect, langs) => langs.map((lang) => {
  const d = LANGS.get(lang);
  if (d === undefined) throw new Error(`cases.js: langs.js 里没有 ${lang} 这一门`);
  return C(family === 'basics' ? lang : `${lang}+${family}`,
    d.grammar, `ext/${lang}/examples/${family}.${d.exts[0]}`, expect);
});

/** 登记处上那几门（一门语言一格 `toIR`，ADR-0044）。 */
const ALL = [...LANGS].filter(([, d]) => typeof d.toIR === 'function').map(([n]) => n);

export const CASES = [
  // 第一个家族：含全部基础要素的完整例子（九门全有）
  ...fam('basics', BASICS, ALL),
  // 第二个家族：多值（生产侧 values / 消费侧一串 pick）
  ...fam('multi', MULTI, ['go']),
  // 第三个家族：作用域出口（go/V/nim 的 defer 与 CL 的 unwind-protect 同一格节点）
  ...fam('defer', DEFER, ['go', 'sbcl', 'vlang', 'nim', 'mojo', 'freebasic', 'cpp']),
  // 第四个家族：记录（**六门六种写法**，落同一格 record-new）——
  // sbcl 那一份的难处与别人不同：字段名是 `(defstruct point x y)` 一句话生成的一族名字
  ...fam('record', RECORD, ['go', 'vlang', 'nim', 'cpp', 'sbcl', 'chez', 'freebasic', 'mojo']),
  // 第五个家族：列表与下标（七个提供者 —— 两门 Lisp 的向量写起来像函数调用）
  ...fam('index', INDEX, ['go', 'vlang', 'nim', 'chez', 'sbcl', 'mojo', 'cpp', 'freebasic']),
  // 第六个家族：循环的早退（break / continue 落同一格，差的只有 kind；lua 只有 break）
  ...fam('loopexit', LOOPEXIT, ['go', 'vlang', 'nim', 'mojo', 'cpp', 'awk', 'freebasic']),
  // 第七个家族：**四条腿都跑得动的那个子集**（只有整数 / 函数 / if / while）
  ...fam('intmath', INTMATH, ALL),
  // 第八个家族：表示转换（五门语言的转换在树上**都是调用的形状** —— 靠名字表分开）
  ...fam('conv', CONV, ['go', 'vlang', 'nim', 'mojo', 'freebasic', 'cpp', 'sbcl', 'chez']),
  // 第九个家族：切片（四种写法一格节点；上界不含、0 起，差别由各自的映射摆平）
  ...fam('slice', SLICE, ['go', 'vlang', 'nim', 'mojo', 'sbcl', 'chez']),
  // 第十个家族：多值的另外两个提供者（CL 的 values / nim 的元组）——
  // 单开一个家族的理由写在 ext/sbcl/examples/values.lisp 的文件头里
  ...fam('values', VALUES, ['sbcl', 'nim', 'vlang', 'chez', 'mojo', 'cpp']),
  // 第十一个家族：**go 独有**的 defer 实参时机（注册那一刻求值）。
  // 一门语言就单开一个家族，理由正是"它不该变成节点"：G5 那条判据里它是"一家"，
  // 而 defer.go 那份印的是常量 —— 看不出时机，所以要这一份把它钉住。
  ...fam('deferarg', DEFERARG, ['go']),
  // 第十二个家族：map / dict 那四格（键是值、缺键报错、默认值归语言）
  // cpp 是最后进来的一门，标记是**声明那一行**（`std::map<K,V> m;`）：库名由例子自己
  // 前向声明（这一门不做预处理），`count` 在条件里就是"在不在"。九门写法各不相同。
  ...fam('dict', DICT, ['go', 'vlang', 'awk', 'nim', 'chez', 'sbcl', 'mojo', 'cpp']),
  // 第十三个家族：串接（四种写法一格内建）—— 它同时钉住字符串在线性内存里的布局
  ...fam('strcat', STRCAT, ['go', 'vlang', 'nim']),
  // 第十四个家族：**数 -> 串**（lua 隐式落 concat、nim 显式落 conv —— 两格节点，一份输出）
  ...fam('numstr', NUMSTR, ['nim']),
  // 第十五个家族：**对象构造 vs 命名实参**（nim 独有）—— 钉的是"那笔账记错了"：
  // 两者在调用实参这个位置上不同形，判"是不是类型"扫一遍 type 段就够
  ...fam('namedarg', NAMEDARG, ['nim']),
  // 第十六个家族：**方法**（接收者在声明里写着 ⇒ 单态分派 ⇒ 图上只多一格实参）。
  // 各门写法差得远（nim 的 UFCS 是纯改写、go 的接收者写在 `func (p Point)` 那一格里），
  // 落到的却全是现成的 call + func —— 这一族把"不给新节点"那句话变成判据。
  ...fam('method', METHOD, ['nim', 'go', 'vlang', 'mojo']),
  // 第十七个家族：**CL 独有的早退形状**（从带名字的块里返回）。单开一族的理由与
  // `deferarg` 同一条：别的九门写不出这个形状 —— 而它落到的节点一格新的都没加
  // （循环里的 `(return)` 落 break、defun 里的 `(return-from f v)` 落 ret）。
  ...fam('blockret', BLOCKRET, ['sbcl']),
  // 第十八个家族：**改写一格已有的名字**（chez 独一份）。理由同上，是账上算出来的：
  // `set` 那格规格十门、矩阵九门，而缺的 chez 欠的是**判据**不是机制。
  ...fam('mut', MUT, ['chez']),
  // 第十九个家族：**显式的块**（nim 的 `block:`）—— 同样是账上算出来的（`region`
  // 规格十门、矩阵九门，缺 nim）。它顺带把"region 到底管不管用"也压住了：同名遮蔽。
  ...fam('blockscope', BLOCKSCOPE, ['nim']),
  // 第二十个家族：**`var` / `const`**（go 独一份）。理由与 deferarg 同一条：那三条规矩
  // （零值 · 省略初值重复上一条 · `iota` 是序号）都归 go 的映射，图上一格新节点也没加。
  // 它顺带把**模块级变量**压在四条腿上（顶层的 bind 在 `call main` 之前）。
  ...fam('vardecl', VARDECL, ['go']),
  // 第二十一个家族：**switch**（go 独一份）。同一条理由：go 没有隐式贯穿，所以这一格
  // 就是一串 if / else if / else —— 图上一格新节点也没加。它顺带把一条**答案错而不报**的
  // 口子钉住：switch 里的 `break` 是跳出 switch，落成 branch 链会变成跳出循环，所以当场报。
  ...fam('switch', SWITCH, ['go']),
  // 第三十三个家族：**零值**（go 独一份）。它是"名字与顺序从声明来"那条既有路子的
  // 又一处提供者 —— 三处当场报（嵌入字段 / 跨模块的类型 / `[N]T` 里 N 不是字面量）。
  ...fam('zeroval', ZEROVAL, ['go']),
  // 第三十四个家族：**格式串**（go 独一份）。落的是现成的 `concat` 内建 —— 一格新节点也没加，
  // 而它同时是"`Printf` 被当成 print 那一族"那个错而不报的证物。
  ...fam('format', FORMAT, ['go']),
  // 第二十二个家族：**for range**（go 独一份）。同一条理由：`for i, v := range xs` 落的是
  // 现成的 `counted`（一格 region + 一格 loop），图上一格新节点也没加。它顺带把
  // "序列只算一次"与"长度只算一次"压在判据上（那两样是 go 规范的原话）。
  ...fam('forrange', FORRANGE, ['go']),
  // 第二十三个家族：**顶层的声明与修饰**（V 独一份）。理由同 `vardecl`：判"该丢还是该拆"
  // 只有这门语言说得清（`pub` / `@[…]` 不产生代码 -> 拆；类型的声明 -> 丢；`const` -> bind），
  // 而落到的节点一格新的都没有。
  ...fam('decls', DECLS, ['vlang']),
  // 第二十四个家族：**一元算子**（lua + awk）。这一族的来历与别的都不同 ——
  // 它是**另一格判据**（`tests/graph/deadcase.js`）算出来的：那两门的 `case 'un'` 接的
  // 标签语法出不来，所以 `-x` / `not x` / `#s` 从来没落成过图。有了这一族才押得住。
  ...fam('unary', UNARY, ['awk']),
  // 第二十五、二十六个家族：**match** 与 **for … in**（V 独一份）。与 go 那两刀是同一个
  // 形状（branch 链 / counted），差别正是"归语言的那几条"：match 还是**表达式**、
  // `for x in xs` 里 x 是**元素**不是下标、`0..4` 是区间。
  ...fam('match', MATCH, ['vlang']),
  ...fam('forin', FORIN, ['vlang']),
  // 第二十七个家族：**位置型结构字面量**（V 独一份）。它不是一格新节点 —— 是"字段名与
  // 顺序从声明来"那条既有路子在这一门上的第五个提供者，而 V 的特殊之处是**同一条产生式
  // 两种写法**（位置型与带名字的），所以要一格判据把两者摆在一起。
  ...fam('posinit', POSINIT, ['vlang']),
  // 第二十八个家族：**case 与 for … in**（nim 独一份）。与 go 的 switch/range、V 的
  // match/for-in 是同一批格子 —— 单开一族是为了压住 nim 多出来的那两条：
  // case 里的 `elif`（走自己的条件）与"区间是中缀算符"。
  ...fam('casefor', CASEFOR, ['nim']),
  // 第二十九个家族：**断言**（V + mojo）。两门的 assert 在树上不同形（V 是语句形状、
  // mojo 是 Python 形状），落到的是**同一格新节点** —— 这一批唯一加了节点的一刀，
  // 理由在 nodes.js 的 `assert` 那一格上（消息是自己的端口 + 可以整格删掉）。
  ...fam('assertok', ASSERTOK, ['vlang', 'mojo']),
  // 第三十个家族：**列表追加**（V 独一份）。它压的是一条"尺子会骗人"的账：`<<` 那 98 份
  // 看着是位运算，其实要的是追加 —— 所以这一族的判据同时是那句话的证物。
  ...fam('push', PUSH, ['vlang']),
  // 第三十一个家族：**定长数组 / `none` / 三段 for 的空格子**（V 独一份）。
  // 单开一族的理由是那条**同一个标签两件事**：`(none)` 在表达式位置上是 Option 空值、
  // 在 for 的格子里是"这儿什么都没写"—— 混起来就是"循环一次都不跑"那种错而不报。
  ...fam('litnone', LITNONE, ['vlang']),
  // 第三十二个家族：**枚举的值与 Option 上的转换**（V 独一份）。它是"名字与顺序/值从声明来"
  // 那条既有路子的第六个提供者 —— 图上一格新节点也没加（落的全是 `const`）。
  ...fam('enumval', ENUMVAL, ['vlang']),
  // 第三十五个家族：**成员在不在**（V 与 nim）。这一族是"映射那一层最后一格"，
  // 也是两门语言第一次在一格内建上碰头 —— 各自的写法（`!in` / `notin`、次序相反）
  // 归各自的映射，图上一格新节点也没加。
  ...fam('member', MEMBER, ['vlang', 'nim']),
  // 第三十六个家族：**取地址那一半**（go 与 V）。这一族的理由是"账上最高的那一堵墙里，
  // 有一半根本不要新节点"：图上的记录就是引用，所以 `&T{…}` 落的就是那一格记录。
  // 另一半（`&x` / 光秃秃的 `*p`）当场报 —— 判据只判走得通的路，报的那两处在墙上。
  ...fam('pointer', POINTER, ['go', 'vlang']),
  // 第三十七个家族：**Option / Result**（V 独一份）。账上第二大的一族，落地靠的是
  // "这一层只问有没有值"那一条口径 —— 与 `if-bind` 那一格同一条。图上一格新节点也没加。
  ...fam('optres', OPTRES, ['vlang']),
  // 第三十八个家族：**编译期常量里"我在谁里头"那一半**（V 独一份）。同样一格新节点也没加 ——
  // 落的是 const 串。它顺带在 core 那条腿上撞出一个真 bug（串接也写成 `+`）。
  ...fam('ctconst', CTCONST, ['vlang']),
  // 第三十九个家族：**匿名函数当值用**（go 与 V）。账上第五大的一族（152 份）落地时
  // 一格新节点也没加 —— 它从头到尾是"这门映射没接那条产生式"，与前两次"死代码"同一形状。
  ...fam('fnval', FNVAL, ['go', 'vlang']),
  // 第四十个家族：**位运算那六格内建**（go 与 V）。账上算出来的一族，六条腿全绿 ——
  // 而它压住一条真差别：js 的位运算是 32 位的，所以那两条腿要走 BigInt。
  ...fam('bits', BITS, ['go', 'vlang']),
  // 第四十一个家族：**go 自己那两格**（`<<` 与 `&^`）—— 理由与 deferarg 同一条。
  ...fam('bitsgo', BITSGO, ['go']),
  // 第四十二个家族：**case 的分支左边是一段区间**（nim 独一份 —— 区间是中缀算符）。
  ...fam('caserange', CASERANGE, ['nim']),
  // 第四十三个家族：**表达式位置上的临时量**（V 独一份）。它解的是"一串语句塞不进表达式"
  // 那一类，而判据是**求值次序不许变** —— 提不动的那一半留在墙上。
  ...fam('hoist', HOIST, ['vlang']),
  // 第四十四个家族：**编译期分支**（V 的 `$if` 与 nim 的 `when`）。账上第二大的一族，
  // 落地靠的是"环境是声明出来的"那一条 —— 不看机器，所以尺子在哪台机器上都是同一个数。
  ...fam('ctif', CTIF, ['vlang', 'nim']),
  // 第四十五个家族：**字符字面量**（V 独一份）。落成单字符的串 —— 语料里 99.2% 是比较。
  ...fam('charlit', CHARLIT, ['vlang']),
  // 第四十六个家族：**按长度造一格列表**（go 独一份）。第 25 格内建 `fill`。
  ...fam('makelen', MAKELEN, ['go']),
  // 第四十七个家族：**两个类型上的同名方法**（V 独一份）。方法名按接收者类型压平 ——
  // 图上一格新节点也没加（还是"多一格实参的普通函数"），改的只是那个函数**叫什么**。
  ...fam('method2', METHOD2, ['vlang']),
  // 第四十八个家族：**按键遍历 map**（go / V / nim —— 图上第 29 格节点 `map-keys`）。
  // 一格新循环节点都没加：`map-keys` 出一格列表，往下走的是现成的 `counted`。
  // 三门在这一格上恰好同形：第一格键、第二格值，所以共用一份 `mapForIn`。
  ...fam('mapiter', MAPITER, ['go', 'vlang', 'nim']),
  // 第四十九个家族：**指针接收者**（go 独一份）。go 里大多数方法的接收者是 `*T`，而这一格
  // 从前**两处写得不一样**：声明剥指针发 `Counter__get`、登记只认 `(tname …)` 记成 `'?'`，
  // 于是调用点落一格指向不存在的函数的 `ref`。图落得出来、尺子数得上，跑起来才炸 ——
  // 所以这一族压的是"两处必须是同一个算法"，第三行还压住"指针接收者里的改看得见"。
  ...fam('ptrmethod', PTRMETHOD, ['go']),
  // 第五十个家族：**真实 go 代码**（go 独一份）。从 `cmd/compile/internal/syntax/tokens.go`
  // 摘出的 token 枚举 + 字符串化。它与前面那些家族的性质不同：**不是为压某一格节点写的**，
  // 是为了回答"生成的 JS 跑起来对不对" —— 期望输出由 `go run` 给（不是我们自己编的）。
  ...fam('tokentest', TOKENTEST, ['go']),
  // 第五十一个家族：**Pos / PosBase**（go 独一份）。从 `cmd/compile/internal/syntax/pos.go`
  // 摘出的位置编码——struct 造 + 字段读、常量位运算、饱和截断、Sprintf。
  ...fam('postest', POSTEST, ['go']),
  // 第五十二个家族：**scanner 工具函数**（go 独一份）。从 `source.go` / `scanner.go` 摘出的
  // 缓冲区增长、字符分类、关键字 map 查表、字符串索引切标识符。
  ...fam('scanutil', SCANUTIL, ['go']),
  // 第五十三个家族：**syntax 包综合测试**（go 独一份）。在一个文件里组装 go 编译器
  // syntax 包的 tokens/operators/Pos/缓冲区增长/字符分类/关键字查表/标识符扫描。
  // 19 行输出与 go run 逐行一致——验证整个 syntax 包的核心运行期行为。
  ...fam('syntaxpkg', SYNTAXPKG, ['go']),
];


/**
 * 手搭的图（不经过任何一门语言）—— 检的是**调度器自己的语义**。
 * 每一条都要有理由说明"为什么不写成语言例子"，否则它该是一份 `examples/`。
 */
