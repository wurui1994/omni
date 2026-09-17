// tests/graph/cases.js —— **例子表：语言 × 家族**（`run.js` 与 `delete.js` 共用一份）
//
// 抽出来的理由只有一条：**同一张表要被两条判据用**。
//   * `run.js`    —— 语言 × 后端的矩阵（输出逐行相同）
//   * `delete.js` —— **可删除测试**（删掉一格节点，不用它的例子必须照旧全绿）
// 抄两份的话，加一门语言就要改两处，而其中一处一定会忘。

import { node, lit, program, bin } from '../../src/core/graph/graph.js';
// 语言的登记处（语法 · 映射 · 后缀）。这一份**只挑家族**，不再自己抄一张语言表
import { LANGS } from '../../src/core/graph/langs.js';

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
 * 后三行是**定长数组的零值**（N 格各一格）、**`make(map…)` / `make([]T, 0)`**
 * （第一格实参是一格类型，所以要在"先算实参"之前拦；而"这名字装的是 map"那张表要
 * 两种造法都认，漏一种 `m["k"] = 5` 就静静变成列表下标写）、`len(xs)` 落 `prim len`。
 */
export const VARDECL = ['15', '1', '3', '6', '5', '2', '7', '5', '0'];
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
 */
export const LITNONE = ['20', '5', '1', '3', '2', '9'];
/**
 * push：**`arr << x` 是列表追加**（V 独一份）—— 落一格内建 `prim push`，不是一格节点
 * （两格实参都是普通的值，与 `len` 同一类）。这一格是账上算出来的，而且那笔账原来**记错了**：
 * 尺子印的是"这个算子还没接：`<<`"，看着像位运算 —— 抽一遍语料才知道 V 的 `<<` 压倒性地
 * 是数组追加。
 */
export const PUSH = ['30', '40', '100'];
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
 */
export const POSINIT = ['3', '11', '16'];
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

const C = (name, grammar, file, toGraph, expect) => ({ name, grammar, file, toGraph, expect });

/**
 * 一格例子 = 一门语言 × 一个家族。文件名是**算出来的**
 * （`ext/<lang>/examples/<家族>.<后缀>`）—— 那条命名约定因此不许破，破了当场报"文件没有"。
 *
 * 语法 / 映射 / 后缀三样**从 `src/core/graph/langs.js` 取**（那是登记处）。
 * 这儿原来自己抄了一张同样的表，而它现在有第二个消费者（`omni run --engine graph`）——
 * 抄两份的话加一门语言要改两处，忘掉的那处就是"测试里绿的、命令行上没有"。
 * 后缀取 `exts[0]`：例子文件用的就是那门语言最常见的那个后缀。
 */
const fam = (family, expect, langs) => langs.map((lang) => {
  const d = LANGS.get(lang);
  if (d === undefined) throw new Error(`cases.js: langs.js 里没有 ${lang} 这一门`);
  return C(family === 'basics' ? lang : `${lang}+${family}`,
    d.grammar, `ext/${lang}/examples/${family}.${d.exts[0]}`, d.toGraph, expect);
});

const ALL = [...LANGS.keys()];

export const CASES = [
  // 第一个家族：含全部基础要素的完整例子（九门全有）
  ...fam('basics', BASICS, ALL),
  // 第二个家族：多值（生产侧 values / 消费侧一串 pick）
  ...fam('multi', MULTI, ['lua', 'go']),
  // 第三个家族：作用域出口（go/V/nim 的 defer 与 CL 的 unwind-protect 同一格节点）
  ...fam('defer', DEFER, ['go', 'sbcl', 'vlang', 'nim', 'mojo', 'freebasic', 'cpp', 'lua']),
  // 第四个家族：记录（**六门六种写法**，落同一格 record-new）——
  // sbcl 那一份的难处与别人不同：字段名是 `(defstruct point x y)` 一句话生成的一族名字
  ...fam('record', RECORD, ['go', 'lua', 'vlang', 'nim', 'cpp', 'sbcl', 'chez', 'freebasic', 'mojo']),
  // 第五个家族：列表与下标（七个提供者 —— 两门 Lisp 的向量写起来像函数调用）
  ...fam('index', INDEX, ['go', 'lua', 'vlang', 'nim', 'chez', 'sbcl', 'mojo', 'cpp', 'freebasic']),
  // 第六个家族：循环的早退（break / continue 落同一格，差的只有 kind；lua 只有 break）
  ...fam('loopexit', LOOPEXIT, ['go', 'lua', 'vlang', 'nim', 'mojo', 'cpp', 'awk', 'freebasic']),
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
  ...fam('dict', DICT, ['go', 'vlang', 'awk', 'nim', 'lua', 'chez', 'sbcl', 'mojo', 'cpp']),
  // 第十三个家族：串接（四种写法一格内建）—— 它同时钉住字符串在线性内存里的布局
  ...fam('strcat', STRCAT, ['lua', 'go', 'vlang', 'nim']),
  // 第十四个家族：**数 -> 串**（lua 隐式落 concat、nim 显式落 conv —— 两格节点，一份输出）
  ...fam('numstr', NUMSTR, ['lua', 'nim']),
  // 第十五个家族：**对象构造 vs 命名实参**（nim 独有）—— 钉的是"那笔账记错了"：
  // 两者在调用实参这个位置上不同形，判"是不是类型"扫一遍 type 段就够
  ...fam('namedarg', NAMEDARG, ['nim']),
  // 第十六个家族：**方法**（接收者在声明里写着 ⇒ 单态分派 ⇒ 图上只多一格实参）。
  // 各门写法差得远（nim 的 UFCS 是纯改写、go 的接收者写在 `func (p Point)` 那一格里），
  // 落到的却全是现成的 call + func —— 这一族把"不给新节点"那句话变成判据。
  ...fam('method', METHOD, ['nim', 'go', 'vlang', 'mojo', 'lua']),
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
  ...fam('unary', UNARY, ['lua', 'awk']),
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
];

/**
 * 手搭的图（不经过任何一门语言）—— 检的是**调度器自己的语义**。
 * 每一条都要有理由说明"为什么不写成语言例子"，否则它该是一份 `examples/`。
 */
const say = (s) => node('prim', { args: [lit(s)] }, { name: 'print' });
const num = (n) => node('prim', { args: [lit(n)] }, { name: 'print' });
export const HAND = [
  {
    // break **穿过一格 region**：途中那格 region 的出口（scope-exit）照跑。
    // 不写成语言例子的理由：go / V 的 defer 是函数作用域、nim 的是块作用域，
    // 而图上挂的是"最近的一格 region" —— 拿谁的语法当例子都会写歪一门的语义。
    // 印的是**整数**而不是字符串：字符串在 wat 那条腿上还没有（宿主面只有 print_i64），
    // 用整数这一格就能在四条腿上一起验 —— 判据能多一条腿就多一条。
    name: 'hand+break-exit',
    expect: ['1', '2', '3'],
    graph: () => program([
      node('loop', {
        cond: lit(true),
        body: [node('region', {
          body: [
            node('scope-exit', { action: [num(2)] }),     // 出口动作
            num(1),                                        // 体
            node('loop-exit', {}, { kind: 'break' }),      // 早退穿过这格 region
          ],
        })],
      }),
      num(3),
    ]),
  },
  {
    // **逆序**：后注册的先跑。同样只用整数，四条腿一起验。
    name: 'hand+exit-order',
    expect: ['3', '2', '1', '4'],
    graph: () => program([
      node('region', {
        body: [
          node('scope-exit', { action: [num(1)] }),
          node('scope-exit', { action: [num(2)] }),
          num(3),
        ],
      }),
      num(4),
    ]),
  },
  {
    // **出口动作在"跑到出口那一刻"求值**，不是在注册那一刻 ——
    // 这一格钉住的是现在**真实**的语义（不是当初写在注释里的那句）：
    //   x = 1; scope-exit{ print x }; x = 2   →  印 2
    // 对 CL 的 `unwind-protect`（清理表在出口求值）与 nim 的 `defer:`（块作用域）**是对的**；
    // 对 go / V 的 `defer f(x)` **不对** —— 它们的实参在注册那一刻就算好了（该印 1）。
    // 要两家都对，`scope-exit` 得把 action 拆成"被调者 + 实参各一格端口"，
    // 注册时把实参算进临时量。那笔账记在 docs/design/node-graph-contract.md A.6.1。
    name: 'hand+exit-when',
    expect: ['2'],
    graph: () => program([
      node('region', {
        body: [
          node('bind', { init: lit(1) }, { name: 'x' }),
          node('scope-exit', {
            action: [node('prim', { args: [node('ref', {}, { name: 'x' })] }, { name: 'print' })],
          }),
          node('set', { value: lit(2) }, { name: 'x' }),
        ],
      }),
    ]),
  },
  {
    // continue **照跑步进**（`post` 端口那一条）。语言例子里 go 那份也压到了，
    // 这一条把它单独钉住：步进缀在体末尾的老写法在这儿是死循环。
    name: 'hand+continue-post',
    expect: ['0', '2', '9'],
    graph: () => program([
      node('bind', { init: lit(0) }, { name: 'i' }),
      node('loop', {
        cond: bin('<', node('ref', {}, { name: 'i' }), lit(3)),
        body: [node('branch', {
          cond: bin('=', node('ref', {}, { name: 'i' }), lit(1)),
          then: [node('loop-exit', {}, { kind: 'continue' })],
        }), node('prim', { args: [node('ref', {}, { name: 'i' })] }, { name: 'print' })],
        post: [node('set', { value: bin('+', node('ref', {}, { name: 'i' }), lit(1)) }, { name: 'i' })],
      }),
      num(9),                      // 整数而不是字符串 —— 好让 wat 那条腿也验得上
    ]),
  },
  {
    // **打印一格多值**：wasm 上没有 sprintf，所以那一步是运行期造串
    // （数位数 → 从末位往前填 → 长度写偏移 0，见 backend-wat.js 的 `$__str_join`）。
    // 不写成语言例子的理由：lua / go 那两份 multi 印的是 1 与 2 —— 单数位、非负，
    // 把"数位循环"和"负号"两条都盖不住。这一格专挑边界：**负数 · 0 · 多位数**。
    name: 'hand+multi-print',
    expect: ['-5 0 42'],
    graph: () => program([
      node('prim', {
        args: [node('values', { args: [lit(-5), lit(0), lit(42)] })],
      }, { name: 'print' }),
    ]),
  },
];
