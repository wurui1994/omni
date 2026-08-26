// Omni stage0 — asymptote 前端：asy 语法树 -> 核心 S 表达式方言（ADR-0014 第 2 道门槛）
//
// ## 为什么这里有一个手写的降级，而 tests/sexpr 那门玩具语言没有
//
// （那门语言的名字刻意不写在这里 —— tests/sexpr 那条轴的硬指标就是"编译器源码里不许出现
// 它的名字"，连注释也算。）
//
// 「加一门语言 = grammar + 映射标注」这句话管的是**语法**：asy.grammar 是从 camp.y 照原样
// 转写的，动作模板出来的树跟 camp.y 的 AST 一一对应（84 个真实模块全过，一份不落）。
// 但 asy 的**语义**不是语法能表达的：`1/3` 是实数除法而 `1#3` 是整数商、`3 == 3.0` 要把
// 左边提成 real、`write` 的分隔符规则取决于第一个实参是不是字符串 —— 每一条都要先知道
// 子表达式的类型。类型是符号表的事，模板里没有符号表。
//
// 所以这个文件只做**类型定向**的那一半，而且刻意只出核心方言的文本：出来的东西六条腿
// 都能跑（run / run-c / interp / interp --mir / run-llvm / build），中间没有为 asy 写的
// 第二份降级。语法那一半仍然一行代码都没有。
//
// ## 第一刀的边界（都是**刻意**的，不是漏的）
//
// 支持：int / real / bool / string 四种标量、变量与赋值、`+ - * / # % ^` 与比较、
// `&& ||`、一元 `- !`、前缀 `++ --` 与 `+= -= *= /=`、`?:`、if/else、while、do-while、
// C 式 for、break/continue、函数（含递归）、`(int)`/`(real)` 强制转换、`write`
// （含 real 的 %.15g —— 核心方言的 `(tostr E N)` 就是为它加的）、内建数学函数
// sqrt/fabs/abs/floor/ceil/round/fmod（核心方言的 `(rmath …)`）、
// **一维数组**：`T[] a`、`new T[n]`、`{…}` 与 `new T[] {…}`、`a[i]` 读写（写会扩长）、
// `a.length`、`a.push(v)`、`a.pop()`、数组当形参/返回值（引用语义，核心方言的 `(arr T)`）、
// **切片** `a[i:j]`/`a[i:]`/`a[:j]`/`a[:]`（是复制不是视图）、`write` 一整个数组
// （每行「下标 : TAB 值」，多个数组并排）、**for-each**（`for (T x : a)`，循环变量是复制，
// 迭代是活的）、
// **pair**：`(x,y)` 字面量、`+ - * /`（后两个是复数乘除）、一元 `-`、`== !=`、
// `z.x`/`z.y`/`xpart`/`ypart`、`abs`/`length`/`conj`、int/real 到 pair 的隐式转换、
// `(pair)` 强制转换、`write`（`(x,y)` 两个分量各 %.15g）、pair 当形参/返回值/`?:` 的两支、
// **`pair[]`**（第八刀：核心方言的 `(arr T)` 现在收 `(vec T N)` 元素，上面那一整套数组
// 操作 —— 下标读写、切片、`write` 整数组、for-each、当形参 —— 在 pair 上一条不少）、
// **字符串函数**：`length`、`substr`、`find`、`rfind`、`replace`、`erase`
// （核心方言为此加了 `(slen E)`/`(ssub E I N)`/`(sfind E T)` 三条 —— OIR 那边本来就有
// len/substr/indexOf 三个 Builtin，所以四条腿是白捡的，只有 LLVM 那条腿要三行 ABI）。
//
// 不支持（见到就报错，报错里说清是哪一条）：triple、struct、import/access、
// typedef、算符重载、重载解析、默认实参、命名实参、给切片赋值（`a[0:2] = b`）、
// 多维数组（`int[][]` —— 核心方言的 `(arr T)` 不收数组元素：MIR 那一层元素类型只有
// 一个 8 位类型码，`(arr (arr int))` 与 `(arr (arr string))` 在那里是同一个码，
// 类型身份丢了。向量元素能收是因为道数就在那个码的高位上）、复数幂、
// 超越函数（exp/log/trig —— 量过 libm 与 V8 在 atan/tan/log/cos 的最后一位就分叉，
// 收进来六条腿必然有一天对不上；`angle`/`dir`/`expi` 因此也在门外）、
// `unit`（能用 sqrt 加除法写出来，但量不出 asy 用的是"乘倒数"还是"逐分量除" ——
// 两种写法的差别在 %.15g 底下看不见，所以宁可不收也不猜）、
// 字符串的 `reverse`（asy 是**按字节**倒的，而 Omni 的 string 是 UTF-8 字节序列
// （ADR-0005）—— 非 ASCII 倒过来在 C 那条腿上是一串坏字节，在 JS 那条腿上要看
// 宿主怎么处理，"六条腿逐字节相同"这句话就保不住了，所以门外）、
// 字符串的 `insert`/`split`（`insert` 要的 `substr` 拼接现成，但 asy 的越界行为
// 还没量全；`split` 要 `string[]` 的返回值，那条路还没走通）、
// 循环条件里的 `?:`（摊出来的赋值只能落在循环外面，条件就只
// 算一次了 —— 语义会变，所以报错而不是悄悄换个意思）。
//
// ## 与真 asy 的差别，写在这里而不是等着被发现
//
// - 整数溢出：asy 是运行期报错（量过：`2^62 * 4` -> "Integer overflow"），我们回绕。
// - `2^-1`：asy 报 "Only 1 and -1 can be raised to negative exponents as integers"，
//   我们的 helper 对负指数返回 0（`^` 那条 helper 里写着）。
// - **数组的未初始化格子**：asy 每个格子带一个"写过没有"的标记，`new int[2]` 之后读
//   `a[0]` 是运行期错误（量过："read uninitialized value from array at index 0"）；
//   我们填零值。写下标扩长时中间跳过的格子同理。这类程序本来就有 bug，但"我们给 0
//   而 asy 报错"必须写在明处。
// - 反过来的一条**已经对齐**了：后缀 `x++` asy 自己不收（"postfix expressions are not
//   allowed"），所以这一层也拒 —— 比 asy 多接受一门语言不会让任何用例变红，只会让
//   "等价"这两个字变虚。`tests/asy/strict/` 那一节专门盯这种漏洞。
// - **除以零**：asy 是运行期报错，而且**实数除法也报**（量过：`1.0/0.0`、`(1,2)/0`、
//   `(1,2)/(0,0)` 全是 "Divide by zero"）；我们按 IEEE 出 inf/nan。这一条不是 pair
//   才有的，`/` 从第一刀起就这样，量到了就记在这里。
// - **切片的两条边界检查**：`a[3:1]` asy 报 "slice ends before it begins"，我们给空数组；
//   `a[-1:2]` asy 报 "invalid negative index in slice of non-cyclic array"，我们落到
//   `(aget …)` 的越界检查上（也是运行期错误，只是话不一样）。
// - **字符串函数的越界是"静静地失败"，不是钳位**——这一条量完才敢写，而且量出来的
//   跟直觉相反，所以 helper 是照量出来的写的，不是照"应该怎样"写的：
//   `substr("abc",-1,2)` 是 `""` 不是 `"ab"`（起点为负直接空串，不是从 0 算）；
//   `substr("abc",1,-1)` 也是 `""`（长度为负不当成"到末尾"）；起点越界同样是 `""`，
//   而长度过长是钳到末尾。`find("abc","b",-5)` 是 `-1` 不是 `1`（起点为负不当 0）；
//   起点等于长度时找空串给的是长度本身。`erase("abc",-1,2)` 原串不动。
//   `replace("aaa","aa","b")` 是 `"ba"`（从左往右不重叠地换），空针不换。
//   `length(int[])` 在 asy 那边是 "no matching function" —— length 只有 string 和
//   pair 两个重载，数组的长度写 `a.length`；这一条落在 `tests/asy/strict/` 里。

import { isList, isAtom, isStr, head } from '../sexpr/read.js';

/** 所有「这一刀还没做」的报错都带上这句 —— 测试轴按它判「拒得对不对」 */
export const ASY_NOPE = 'asy 前端第一刀还不支持';

const SCALARS = new Set(['int', 'real', 'bool', 'string']);

/** 能当数组元素的类型。pair 是第八刀加的（核心方言的 `(arr T)` 现在收向量元素）；
 *  数组本身仍然不在里面 —— 多维数组是另一刀。 */
const ASY_ARRELEM = new Set(['int', 'real', 'bool', 'string', 'pair']);

/** 算符文本。语法模板里有两种写法：`(bin "+" …)` 给的是字符串节点，
 *  `(self $2 $1 $3)` 直接把 SELFOP **词法 token**（原子）搬过来。两种都要认。
 *  名字带 asy 前缀是封闭 ABI 的要求：模块级的名字全局唯一（mir/print.js 已有一个 opText）。 */
const asyOpText = (n) => (isStr(n) || isAtom(n) ? n.value : null);

/** 数组类型在这一层就是「元素名 + []」的字符串（`'real[]'`），核心方言那边是 `(arr real)`。
 *  用字符串是因为这个文件里所有类型都是字符串，Map 查表与 `===` 比较都现成 ——
 *  为数组另造一个对象型会把每处比较都改成函数调用。名字带 asy 前缀：模块级名字全仓唯一。 */
const asyIsArr = (t) => t !== null && t !== undefined && t.endsWith('[]');
const asyElem = (t) => t.slice(0, -2);

/**
 * pair 就是核心方言的 `(vec real 2)`：第 0 道是 x，第 1 道是 y。
 *
 * 为什么不给核心方言加一条 `pair` 类型：`+` 和 `-` 在 pair 上就是**逐分量**的，
 * 而向量的 `+ -` 已经是逐道的；`(vlit …)`、`(lane …)` 正好是"造一个"和"取一个分量"。
 * 剩下的复数 `*`、`/`、`abs`、`==` 和 `(x,y)` 的印法都是 **asy 的语义**，不是"向量"的
 * 语义 —— 那几条落在这一层的 helper 里，六条腿共用同一份，不会分叉。
 *
 * 代价写在明处：`?:` 的两支是 pair 时靠 ZERO 里那个零向量占位。
 * `pair[]` 第八刀通了：核心方言的 `(arr T)` 现在收 `(vec T N)` 元素，运行时那一份
 * 按字节的实现管长度与增长，元素的读写由每条腿自己发（见 omni_arr.c 尾部）。
 */
const ASY_PAIR_TY = '(vec real 2)';
const asyCore = (t) => {
  if (asyIsArr(t)) return `(arr ${asyCore(asyElem(t))})`;
  return t === 'pair' ? ASY_PAIR_TY : t;
};

/**
 * asy 运行时自带的数学函数（不是 plain.asy 里的定义，所以这一层认它们不算偷偷补模块系统）。
 * 返回类型是量出来的（`asy -noV`）：`floor/ceil/round` 回 **int**（`int i = floor(2.7)`
 * 编得过），`sqrt/fabs/fmod` 回 real，`abs` 按实参分 int/real。
 * 名单只到核心方言 `(rmath …)` 收的那几个为止 —— exp/log/sin 这些各家最后一位就分叉，
 * 方言那边没收（理由在 runtime/omni_math.c 的头注里）。
 */
const ASY_MATH = new Map([
  ['sqrt', { fn: 'sqrt', arity: 1, ret: 'real' }],
  ['fabs', { fn: 'fabs', arity: 1, ret: 'real' }],
  ['abs', { fn: 'fabs', arity: 1, ret: 'real' }],
  ['floor', { fn: 'floor', arity: 1, ret: 'int' }],
  ['ceil', { fn: 'ceil', arity: 1, ret: 'int' }],
  ['round', { fn: 'round', arity: 1, ret: 'int' }],
  ['fmod', { fn: 'fmod', arity: 2, ret: 'real' }],
]);

/** 没写初值时的零值。asy 也是这么定的（未初始化的 int 是 0，string 是空串，pair 是 (0,0)）。 */
const ZERO = new Map([
  ['int', '(int 0)'],
  ['real', '(real 0.0)'],
  ['bool', '(bool false)'],
  ['string', '(str "")'],
  ['pair', `(vlit ${ASY_PAIR_TY} (real 0.0) (real 0.0))`],
]);

/**
 * pair 上的内建函数。返回类型是量出来的（`asy -noV`）：
 *   abs((3,-4)) / length((1,2))  -> real（模）
 *   conj((1,2))                  -> (1,-2)
 *   xpart/ypart                  -> real（`z.x`/`z.y` 是同一件事）
 * `angle`/`dir`/`expi` 要 atan2/cos/sin，白名单里没有；`unit` 见文件头。
 * `realpart`/`imagpart` **asy 自己就没有**（量过："no matching variable 'realpart'"），
 * 所以这里也没有 —— 补上就是比 asy 多接受一门语言。
 */
const ASY_PAIRFN = new Set(['conj', 'xpart', 'ypart']);

/**
 * 字符串上的内建函数。`params` 是每个实参要的类型，`min` 是最少给几个 ——
 * asy 那边 `substr(s,i)` 与 `find(s,t)` 是靠**默认实参**少给一个，这一刀没有默认实参
 * 机制，所以按"给了几个"分派：substr 少给走"到末尾"那条 helper，find 少给补起点 0。
 * `reverse` 刻意不收：它按字节翻转，非 ASCII 翻出来不是合法 UTF-8，而"印一串非法字节"
 * 在 C 与 JS 两条腿上不是同一件事 —— 没量准的东西不收。
 */
const ASY_STRFN = new Map([
  ['substr', { params: ['string', 'int', 'int'], min: 2, fn: 'asy__ssub', short: 'asy__ssubto', ret: 'string' }],
  ['find', { params: ['string', 'string', 'int'], min: 2, fn: 'asy__sfindp', ret: 'int' }],
  ['rfind', { params: ['string', 'string'], min: 2, fn: 'asy__srfind', ret: 'int' }],
  ['replace', { params: ['string', 'string', 'string'], min: 3, fn: 'asy__srepl', ret: 'string' }],
  ['erase', { params: ['string', 'int', 'int'], min: 3, fn: 'asy__serase', ret: 'string' }],
]);

/** helper 之间的依赖：发了外层那条，被它调用的也要发。 */
const ASY_STR_DEPS = new Map([
  ['asy__ssubto', ['asy__ssub']],
  ['asy__serase', ['asy__ssub', 'asy__ssubto']],
  ['asy__sfindp', ['asy__ssub', 'asy__ssubto']],
  ['asy__srepl', ['asy__ssub', 'asy__ssubto']],
]);

/**
 * 字符串上**刻意没做**的那几个，各自带上理由 —— 落到"内建函数 'xxx' 没有"那条通用
 * 消息里的话，看的人分不清是"这一刀没做"还是"asy 也没有"。
 */
const ASY_STR_NOPE = new Map([
  ['reverse', "字符串的 reverse（asy 是按字节倒的，而 Omni 的 string 是 UTF-8 字节序列 —— 非 ASCII 倒出来在 C 与 JS 两条腿上不是同一件事）"],
  ['insert', "字符串的 insert（substr 拼接就够，但 asy 的越界行为还没量全，不猜）"],
  ['split', '字符串的 split（要 string[] 的返回值，函数返回数组那条路还没走通）'],
]);

/** 核心方言的字符串字面量。刻意不用 JSON.stringify：它对控制字符发 \uXXXX，
 *  而 sexpr/read.js 的转义表里没有 \u（那是 WAT 的方言）。只转必须转的五个。 */
function strLit(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + '"';
}

/**
 * 按需发的 helper 函数。多数是「asy 的算符与核心方言的算符不是同一个」逼出来的：
 * `#` 向下取整、`%` 的符号跟着除数、int 上的 `^` 是幂、`abs(int)` 回 int。
 * 每条都只发一次，且只在用到时发。
 */
const HELPERS = new Map([
  ['asy__iabs', `  (fn asy__iabs ((a int)) int
    ;; 整数取绝对值。核心方言的 (rmath "fabs" …) 只吃 real，而 asy 的 abs(int) 回 int ——
    ;; 绕一趟 real 会在 2^53 以上丢精度，所以这里就是一个比较。
    (if (bin "<" (var a) (int 0)) (do (ret (un "-" (var a)))))
    (ret (var a)))`],
  ['asy__quot', `  (fn asy__quot ((a int) (b int)) int
    ;; asy 的 # 是**向下**取整；核心方言的 / 是截断。差别只在"除不尽且异号"时。
    (let q int (bin "/" (var a) (var b)))
    (if (bin "!=" (bin "%" (var a) (var b)) (int 0))
      (do
        (if (bin "!=" (bin "<" (var a) (int 0)) (bin "<" (var b) (int 0)))
          (do (set q (bin "-" (var q) (int 1)))))))
    (ret (var q)))`],
  ['asy__mod', `  (fn asy__mod ((a int) (b int)) int
    ;; asy 的 % 的符号跟着**除数**（量过：-7%3=2、7%-3=-2）；核心方言是 C 语义。
    (let m int (bin "%" (var a) (var b)))
    (if (bin "&&" (bin "!=" (var m) (int 0)) (bin "!=" (bin "<" (var m) (int 0)) (bin "<" (var b) (int 0))))
      (do (set m (bin "+" (var m) (var b)))))
    (ret (var m)))`],
  ['asy__ipow', `  (fn asy__ipow ((a int) (b int)) int
    ;; asy 的 ^ 是幂，核心方言的 ^ 是异或，所以只能写成循环。
    ;; 负指数：asy 报 "Only 1 and -1 can be raised to negative exponents as integers"，
    ;; 我们这一刀不做那条运行期检查，返回 0 —— 差别写在文件头。
    (let r int (int 1))
    (let i int (int 0))
    (if (bin "<" (var b) (int 0)) (do (ret (int 0))))
    (while (bin "<" (var i) (var b))
      (do
        (set r (bin "*" (var r) (var a)))
        (set i (bin "+" (var i) (int 1)))))
    (ret (var r)))`],
  ['asy__boolstr', `  (fn asy__boolstr ((b bool)) string
    ;; asy 在 bool 后面**总是补一个空格**（量过：write(false) 是 6 字节 "false "，
    ;; write("a",false) 是 "afalse "，所以不是对齐到 5，是算符自带的尾空格）
    (if (var b) (do (ret (str "true "))))
    (ret (str "false ")))`],
  ['asy__pmul', `  (fn asy__pmul ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; pair 的 * 是**复数乘法**（量过：(1,2)*(3,-4) = (11,2)）。乘法的形状照抄
    ;; 教科书那一份：x = ax*bx - ay*by，y = ax*by + ay*bx —— 加减顺序是浮点结果的
    ;; 一部分，所以写死，不敢换成"更聪明"的写法。
    (ret (vlit ${ASY_PAIR_TY}
      (bin "-" (bin "*" (lane (var a) 0) (lane (var b) 0)) (bin "*" (lane (var a) 1) (lane (var b) 1)))
      (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 1)) (bin "*" (lane (var a) 1) (lane (var b) 0))))))`],
  ['asy__pdiv', `  (fn asy__pdiv ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; pair 的 / 是**复数除法**，而且是**朴素**那一份（不是 Smith 的防溢出算法）——
    ;; 量出来的：(1,1)/(1e200,1e200) 是 (0,0)（分母平方和溢出成 inf），
    ;; (1e300,1)/1e300 是 (nan,0)（右边那个实数先被提成 (1e300,0)，t 还是 inf）。
    ;; 后一条同时证明了 asy **没有** pair/real 这个重载：实数是先转成 pair 的。
    (let t real (bin "+" (bin "*" (lane (var b) 0) (lane (var b) 0)) (bin "*" (lane (var b) 1) (lane (var b) 1))))
    (ret (vlit ${ASY_PAIR_TY}
      (bin "/" (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 0)) (bin "*" (lane (var a) 1) (lane (var b) 1))) (var t))
      (bin "/" (bin "-" (bin "*" (lane (var a) 1) (lane (var b) 0)) (bin "*" (lane (var a) 0) (lane (var b) 1))) (var t)))))`],
  ['asy__pabs', `  (fn asy__pabs ((a ${ASY_PAIR_TY})) real
    ;; 模。也是朴素那一份 —— 量过 abs((1e200,1e200)) 是 inf，所以不是 hypot。
    (ret (rmath "sqrt" (bin "+" (bin "*" (lane (var a) 0) (lane (var a) 0)) (bin "*" (lane (var a) 1) (lane (var a) 1))))))`],
  ['asy__pconj', `  (fn asy__pconj ((a ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    (ret (vlit ${ASY_PAIR_TY} (lane (var a) 0) (un "-" (lane (var a) 1)))))`],
  ['asy__pneg', `  (fn asy__pneg ((a ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; 逐分量取负。刻意不写成 (0,0) - a：那样 -0.0 会变成 0.0，而 asy 是 pair(-x,-y)。
    (ret (vlit ${ASY_PAIR_TY} (un "-" (lane (var a) 0)) (un "-" (lane (var a) 1)))))`],
  ['asy__peq', `  (fn asy__peq ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) bool
    ;; 向量上没有比较（掩码类型这一刀没有），所以逐道比。写成函数而不是内联展开：
    ;; 内联要把两边的代码各印两遍，f() == g() 就会把 f 和 g 各调两次。
    (ret (bin "&&" (bin "==" (lane (var a) 0) (lane (var b) 0)) (bin "==" (lane (var a) 1) (lane (var b) 1)))))`],
  ['asy__pairstr', `  (fn asy__pairstr ((a ${ASY_PAIR_TY})) string
    ;; write(pair) 的格式：两个分量各 %.15g，夹在圆括号里，中间一个逗号、没有空格
    ;; （量过：(0.333333333333333,0.666666666666667)、(1e+20,1e-05)、(-0,0)）
    (ret (bin "+" (str "(") (bin "+" (tostr (lane (var a) 0) (int 15))
      (bin "+" (str ",") (bin "+" (tostr (lane (var a) 1) (int 15)) (str ")")))))))`],
  // 字符串函数。核心方言给的是**严格**的三条（越界报错），asy 的这几个是**静静地失败**：
  // 量过 substr("abc",5,1) 与 substr("abc",-1,2) 都是空串（不是报错、也不是 clamp 到 0 ——
  // clamp 的话第二个会给 "ab"），substr("abc",1,100) 是 "bc"，erase("abc",-1,2) 原样返回，
  // find("abc","b",-5) 是 -1（clamp 的话会是 1）。所以"负数当无效"这条要照着写。
  ['asy__ssub', `  (fn asy__ssub ((s string) (i int) (n int)) string
    (if (bin "<" (var i) (int 0)) (do (ret (str ""))))
    (if (bin ">" (var i) (slen (var s))) (do (ret (str ""))))
    (let m int (var n))
    (if (bin ">" (bin "+" (var i) (var m)) (slen (var s)))
      (do (set m (bin "-" (slen (var s)) (var i)))))
    (if (bin "<" (var m) (int 0)) (do (ret (str ""))))
    (ret (ssub (var s) (var i) (var m))))`],
  ['asy__ssubto', `  (fn asy__ssubto ((s string) (i int)) string
    ;; substr(s,i)：到末尾。写成 helper 而不是在调用处补 (slen …)，
    ;; 那样接收者的代码要印两遍，substr(f(),1) 就会把 f 调两次。
    (ret (call asy__ssub (var s) (var i) (slen (var s)))))`],
  ['asy__serase', `  (fn asy__serase ((s string) (i int) (n int)) string
    (if (bin "<" (var i) (int 0)) (do (ret (var s))))
    (ret (bin "+" (call asy__ssub (var s) (int 0) (var i))
                  (call asy__ssubto (var s) (bin "+" (var i) (var n))))))`],
  ['asy__sfindp', `  (fn asy__sfindp ((s string) (t string) (p int)) int
    (if (bin "<" (var p) (int 0)) (do (ret (int -1))))
    (if (bin ">" (var p) (slen (var s))) (do (ret (int -1))))
    (let r int (sfind (call asy__ssubto (var s) (var p)) (var t)))
    (if (bin "<" (var r) (int 0)) (do (ret (int -1))))
    (ret (bin "+" (var r) (var p))))`],
  ['asy__srfind', `  (fn asy__srfind ((s string) (t string)) int
    ;; 最后一次出现。核心方言只有"从前往后找"，所以扫一遍记最后一次
    ;; （量过 rfind("hello world","o") 是 7）。空针在末尾命中，和 std::string::rfind 一致。
    (let best int (int -1))
    (let i int (int 0))
    (while (bin "<=" (bin "+" (var i) (slen (var t))) (slen (var s)))
      (do
        (if (bin "==" (ssub (var s) (var i) (slen (var t))) (var t)) (do (set best (var i))))
        (set i (bin "+" (var i) (int 1)))))
    (ret (var best)))`],
  ['asy__srepl', `  (fn asy__srepl ((s string) (a string) (b string)) string
    ;; 换掉**所有**不重叠的出现，从左到右（量过 replace("aaa","aa","b") 是 "ba" ——
    ;; 换掉头两个之后从第三个字符接着走）。空的被换串原样返回（量过）。
    (if (bin "==" (slen (var a)) (int 0)) (do (ret (var s))))
    (let r string (str ""))
    (let i int (int 0))
    (while (bin "<=" (bin "+" (var i) (slen (var a))) (slen (var s)))
      (do
        (if (bin "==" (ssub (var s) (var i) (slen (var a))) (var a))
          (do
            (set r (bin "+" (var r) (var b)))
            (set i (bin "+" (var i) (slen (var a)))))
          (do
            (set r (bin "+" (var r) (ssub (var s) (var i) (int 1))))
            (set i (bin "+" (var i) (int 1)))))))
    (ret (bin "+" (var r) (call asy__ssubto (var s) (var i)))))`],
]);

/** 写下标时的自动扩长。asy 量过：`int[] e; e[2]=5;` 之后 `e.length` 是 **3**（= 下标+1），
 *  中间那些格子在 asy 那边是"未初始化"，读会报错；我们填零值，差别写在文件头。
 *  五种元素各一份，因为核心方言的 `(apush …)` 要具体的零值字面量。pair 那一份是第八刀
 *  加的，元素类型写的是 `(vec real 2)` —— 三条 helper 的**正文一个字都没改**。
 *  这里刻意不用解构（`for (const [a, b] of …)`）：封闭子集里那不是保证能降级的写法。 */
for (const t of ['int', 'real', 'bool', 'string', 'pair']) {
  const et = asyCore(t);
  HELPERS.set(`asy__grow_${t}`, `  (fn asy__grow_${t} ((a (arr ${et})) (i int)) void
    (while (bin "<=" (alen (var a)) (var i))
      (do (apush (var a) ${ZERO.get(t)}))))`);
  // 切片。量过的三条：半开区间、**是复制不是视图**（`b=a[0:2]; b[0]=99;` 之后 a[0] 还是 10）、
  // 右边界超长就截到末尾（`a[2:100]` 给到末尾）。左边界不 clamp：负数在 asy 是运行期错误
  // （"invalid negative index in slice of non-cyclic array"），落到 (aget …) 上也是运行期
  // 错误，只是话不一样。`a[3:1]` asy 报 "slice ends before it begins"，我们给空数组 ——
  // 这条差别写在文件头。
  HELPERS.set(`asy__slice_${t}`, `  (fn asy__slice_${t} ((a (arr ${et})) (i int) (j int)) (arr ${et})
    (let r (arr ${et}) (anew (arr ${et}) (int 0)))
    (let k int (var i))
    (let e int (var j))
    (if (bin ">" (var e) (alen (var a))) (do (set e (alen (var a)))))
    (while (bin "<" (var k) (var e))
      (do
        (apush (var r) (aget (var a) (var k)))
        (set k (bin "+" (var k) (int 1)))))
    (ret (var r)))`);
  // `a[i:]`：末端默认是长度。单独一条 helper 而不是在调用处写 `(alen …)` —— 那样接收者
  // 的代码要印两遍，`f()[1:]` 就会把 f 调两次。
  HELPERS.set(`asy__slicefrom_${t}`, `  (fn asy__slicefrom_${t} ((a (arr ${et})) (i int)) (arr ${et})
    (ret (call asy__slice_${t} (var a) (var i) (alen (var a)))))`);
}

class AsyLower {
  constructor(diags) {
    this.diags = diags;
    this.funcs = new Map();    // 名字 -> {ret, params: 类型名数组}
    this.scopes = [];          // 名字 -> 类型名
    this.used = new Set();     // 用到的 helper
    // for 的更新片段栈。C 式 for 降成 while 之后，`continue` 必须**先跑更新**再跳 ——
    // 不这么做 `for(i=0;i<5;++i){if(i==2)continue;}` 就死循环。量过 asy 的行为：更新会跑。
    this.updates = [];
    this.tmp = 0;
    // 当前语句的**前置语句**。核心方言里 `? :` 不是表达式，只能摊成临时量 + if/else，
    // 那两条 if/else 就攒在这里，由 stmt() 的外壳补在这条语句前面。
    // null = 不在语句上下文里（那时见到 `? :` 只能报错，不能悄悄丢）。
    this.pre = null;
    // 文件级变量的名字。核心方言没有全局量，所以函数里碰到它们要给一句**说得清**的错，
    // 而不是"未声明的变量"——后者会让人以为是拼错了。
    this.globals = new Map();
  }

  err(node, msg) {
    this.diags.error(node === null || node === undefined ? null : node.span, msg);
    return null;
  }

  nope(node, what) {
    return this.err(node, `${ASY_NOPE}：${what}`);
  }

  /** `(H)` / `(H X)` / `(H-add PREV X)` 这三种形状摊成一条平的列表 */
  flat(node, name) {
    if (!isList(node)) return [];
    const h = head(node);
    if (h === `${name}-add`) {
      const out = this.flat(node.items[1], name);
      out.push(node.items[2]);
      return out;
    }
    if (h === name) {
      const out = [];
      for (const x of node.items.slice(1)) out.push(x);
      return out;
    }
    return [node];
  }

  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }

  lookup(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) return this.scopes[i].get(nm);
      i--;
    }
    return null;
  }

  declare(node, nm, t) {
    if (this.scopes[this.scopes.length - 1].has(nm)) return this.err(node, `'${nm}' 在这一层已经声明过了`);
    this.scopes[this.scopes.length - 1].set(nm, t);
    return t;
  }

  /* ------------------------------------------------------------------ 类型 */

  /** `(name-ty (name int))` -> 'int'；`(array-ty (name int) (dims))` -> 'int[]'。
   *  记录/pair 这一刀不做，多维数组也不做（`(dims+ …)` 就是两层以上）。 */
  type(node, what) {
    if (!isList(node)) return this.err(node, `${what}：这里要一个类型`);
    const h = head(node);
    if (h === 'array-ty') {
      const dims = node.items[2];
      if (isList(dims) && head(dims) !== 'dims') return this.nope(node, '多维数组');
      const el = this.plainName(node.items[1]);
      if (el === null) return this.nope(node, '带点的类型名');
      if (!ASY_ARRELEM.has(el)) return this.nope(node, `${el}[] （数组元素这一刀只有 int/real/bool/string/pair）`);
      return `${el}[]`;
    }
    if (h !== 'name-ty') return this.err(node, `${what}：认不出的类型形状 '${h}'`);
    const nm = this.plainName(node.items[1]);
    if (nm === null) return this.nope(node, '带点的类型名');
    if (nm === 'void') return 'void';
    if (nm === 'pair') return 'pair';
    if (!SCALARS.has(nm)) return this.nope(node, `类型 '${nm}'（这一刀只有 int/real/bool/string/pair）`);
    return nm;
  }

  /** `(name x)` -> 'x'；`(qualified ...)` 与算符名（`operator +`）都回 null */
  plainName(node) {
    if (!isList(node) || head(node) !== 'name') return null;
    const a = node.items[1];
    if (!isAtom(a)) return null;
    if (a.value.startsWith('operator ')) return null;
    return a.value;
  }

  /* ---------------------------------------------------------------- 表达式 */

  /** 出 `{code, type}`；失败回 null（诊断已记） */
  expr(n) {
    if (n === undefined || n === null) return this.err(null, '少了一个表达式');
    // 字面量：LIT 是裸原子（`3` / `3.5` / `true`），STRING 是字符串节点
    if (isStr(n)) return { code: `(str ${strLit(n.value)})`, type: 'string' };
    if (isAtom(n)) return this.lit(n);
    if (!isList(n)) return this.err(n, '认不出的表达式');
    return this.exprList(n, head(n));
  }

  lit(n) {
    const t = n.value;
    if (t === 'true' || t === 'false') return { code: `(bool ${t})`, type: 'bool' };
    if (/^[0-9]/.test(t) || t.startsWith('.')) {
      const real = t.includes('.') || t.includes('e') || t.includes('E');
      return real ? { code: `(real ${t})`, type: 'real' } : { code: `(int ${t})`, type: 'int' };
    }
    return this.nope(n, `字面量 '${t}'`);
  }

  /** 数值提升：asy 允许 `3 == 3.0`（量过），核心方言两边必须同型，于是这里显式插 toreal。
   *  pair 也在这条链上：`2+(1,2)` 是 (3,2)、`(1,2)==3` 是 false —— int/real 会被
   *  提成 `(v,0)`（量过，见 asy__pdiv 的注释：连 `/` 都是先转 pair 再算的）。 */
  promote(a, b) {
    if (a.type === b.type) return a.type;
    if (a.type === 'pair' && (b.type === 'int' || b.type === 'real')) {
      const v = this.toPair(b);
      b.code = v.code; b.type = 'pair';
      return 'pair';
    }
    if (b.type === 'pair' && (a.type === 'int' || a.type === 'real')) {
      const v = this.toPair(a);
      a.code = v.code; a.type = 'pair';
      return 'pair';
    }
    if (a.type === 'int' && b.type === 'real') { a.code = `(toreal ${a.code})`; a.type = 'real'; return 'real'; }
    if (a.type === 'real' && b.type === 'int') { b.code = `(toreal ${b.code})`; b.type = 'real'; return 'real'; }
    return null;
  }

  /** int/real -> pair，就是 `(v, 0)`。asy 那边这是一条隐式转换，不是重载。 */
  toPair(v) {
    const x = v.type === 'int' ? `(toreal ${v.code})` : v.code;
    return { code: `(vlit ${ASY_PAIR_TY} ${x} (real 0.0))`, type: 'pair' };
  }

  /** 往目标类型靠：int -> real、int/real -> pair，其余不匹配就是错 */
  coerce(v, want, node, what) {
    if (v === null) return null;
    if (v.type === want) return v;
    if (v.type === 'int' && want === 'real') return { code: `(toreal ${v.code})`, type: 'real' };
    if (want === 'pair' && (v.type === 'int' || v.type === 'real')) return this.toPair(v);
    return this.err(node, `${what}：要 ${want}，这里是 ${v.type}`);
  }

  exprList(n, h) {
    if (h === 'name-exp') {
      const nm = this.plainName(n.items[1]);
      if (nm === null) {
        // `a.length` / `z.x`：词法上"点"是名字的一部分（`name -> name "." ID`），所以
        // 数组和 pair 的字段都不是 `(field …)` 而是一个**带点的名字**。
        const q = this.dotQual(n.items[1]);
        if (q !== null) return this.member(n, q.recv, q.field);
        return this.nope(n, '带点的名字或算符名');
      }
      const t = this.lookup(nm);
      if (t === null) {
        if (this.globals.has(nm)) return this.nope(n, `函数里引用文件级变量 '${nm}'（核心方言没有全局量）`);
        return this.err(n, `未声明的变量 '${nm}'`);
      }
      return { code: `(var ${nm})`, type: t };
    }
    if (h === 'binary') return this.binary(n);
    if (h === 'equality') return this.compare(n, n.items[1].value);
    if (h === 'and-exp' || h === 'or-exp') return this.logic(n, h === 'and-exp' ? '&&' : '||');
    if (h === 'unary') return this.unary(n);
    if (h === 'cast') return this.cast(n);
    if (h === 'call') return this.call(n);
    if (h === 'cond') return this.cond(n);
    if (h === 'assign' || h === 'self' || h === 'prefix' || h === 'postfix') {
      return this.nope(n, `赋值/自增出现在表达式位置（'${h}'）—— 这一刀只认它们当语句`);
    }
    if (h === 'tuple-exp') return this.pairLit(n);
    if (h === 'subscript') return this.index(n);
    if (h === 'slice-exp') return this.slice(n);
    if (h === 'field') return this.field(n);
    if (h === 'new-array') return this.newArray(n);
    if (h === 'new-record' || h === 'new-function') return this.nope(n, 'new');
    if (h === 'arrayinit' || h === 'arrayinit-add' || h === 'arrayinit-rest') {
      // `{1,2,3}` 自己没有类型，类型来自左边的声明 —— 所以只在知道目标类型的地方处理
      return this.nope(n, '花括号数组初值出现在推不出元素类型的位置（只支持 `T[] a = {…}` 与 `new T[] {…}`）');
    }
    if (h === 'scale') return this.nope(n, '隐式缩放（`105cm` 这种）');
    if (h === 'join-exp' || h === 'join-dir' || h === 'spec' || h === 'spec-curl') return this.nope(n, '路径连接');
    return this.nope(n, `表达式 '${h}'`);
  }

  /* ------------------------------------------------------------------ 数组 */

  /** `a[i]` 的**读**侧。写侧在 assign 里，因为写要先扩长（asy 的下标写会长）。 */
  index(n) {
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(n, `下标只能用在数组上，这里是 ${a.type}`);
    const i = this.coerce(this.expr(n.items[2]), 'int', n, '下标');
    if (i === null) return null;
    return { code: `(aget ${a.code} ${i.code})`, type: asyElem(a.type) };
  }

  /**
   * `a[i:j]` / `a[i:]` / `a[:j]` / `a[:]`。**是复制不是视图**（量过），半开区间，
   * 右边界超长截到末尾。四种形状都落到那两条 helper 上，接收者只印一遍。
   *
   * 形状要按**项数**分，不能只看头：语法里 `[:]` 与 `[i:j]` 的头都是 `slice`
   * （`(-> (":") (slice))` 和 `(-> (exp ":" exp) (slice $1 $3))`）。
   */
  slice(n) {
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(n, `切片只能用在数组上，这里是 ${a.type}`);
    const s = n.items[2];
    if (!isList(s)) return this.err(n, '认不出的切片');
    const hs = head(s);
    const el = asyElem(a.type);
    const both = hs === 'slice' && s.items.length === 3;
    if (!both && hs !== 'slice' && hs !== 'slice-from' && hs !== 'slice-to') {
      return this.nope(n, `切片的形状 '${hs}'`);
    }
    const loNode = both ? s.items[1] : (hs === 'slice-from' ? s.items[1] : null);
    const hiNode = both ? s.items[2] : (hs === 'slice-to' ? s.items[1] : null);
    const lo = loNode === null
      ? { code: '(int 0)', type: 'int' }
      : this.coerce(this.expr(loNode), 'int', n, '切片的起点');
    if (lo === null) return null;
    this.used.add(`asy__slice_${el}`);
    if (hiNode !== null) {
      const hi = this.coerce(this.expr(hiNode), 'int', n, '切片的终点');
      if (hi === null) return null;
      return { code: `(call asy__slice_${el} ${a.code} ${lo.code} ${hi.code})`, type: a.type };
    }
    // `a[i:]` 与 `a[:]`：末端是长度
    this.used.add(`asy__slicefrom_${el}`);
    return { code: `(call asy__slicefrom_${el} ${a.code} ${lo.code})`, type: a.type };
  }

  /** `(qualified (name a) F)` 且 a 是**变量**时回 `{recv, field}`，否则回 null。
   *  只认变量：`模块.名字` 也是这个形状，那要模块系统，这一刀没有。 */
  dotQual(node) {
    if (!isList(node) || head(node) !== 'qualified') return null;
    const base = this.plainName(node.items[1]);
    const f = isAtom(node.items[2]) ? node.items[2].value : null;
    if (base === null || f === null) return null;
    const t = this.lookup(base);
    if (t === null) return null;
    return { recv: { code: `(var ${base})`, type: t }, field: f };
  }

  /** `(field 值 ID)`：`a[0].x` 这种（点后面跟的不是名字而是别的表达式时走这条） */
  field(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    return this.member(n, a, nm);
  }

  /** 取字段。数组只有 `.length`，pair 只有 `.x`/`.y`；别的都还没做。 */
  member(n, recv, nm) {
    if (asyIsArr(recv.type)) {
      if (nm === 'length') return { code: `(alen ${recv.code})`, type: 'int' };
      return this.nope(n, `数组的 '.${nm}'（这一刀只有 .length / .push / .pop）`);
    }
    if (recv.type === 'pair') {
      if (nm === 'x') return { code: `(lane ${recv.code} 0)`, type: 'real' };
      if (nm === 'y') return { code: `(lane ${recv.code} 1)`, type: 'real' };
      return this.nope(n, `pair 的 '.${nm}'（这一刀只有 .x / .y）`);
    }
    return this.nope(n, `取字段 '.${nm}'`);
  }

  /* -------------------------------------------------------------------- pair */

  /** `(x,y)`。三个以上就是 triple，这一刀没有。分量按 int -> real 提升。 */
  pairLit(n) {
    const parts = this.flat(n.items[1], 'args');
    if (parts.length !== 2) return this.nope(n, `${parts.length} 个分量的字面量（triple 这一刀没有）`);
    const x = this.coerce(this.expr(parts[0]), 'real', parts[0], 'pair 的 x');
    const y = this.coerce(this.expr(parts[1]), 'real', parts[1], 'pair 的 y');
    if (x === null || y === null) return null;
    return { code: `(vlit ${ASY_PAIR_TY} ${x.code} ${y.code})`, type: 'pair' };
  }

  /** pair 上的内建函数（名单见 ASY_PAIRFN）。实参是 int/real 时先隐式转成 pair。 */
  pairCall(n, nm) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== 1) return this.err(n, `'${nm}' 要 1 个实参，给了 ${args.length} 个`);
    const v = this.coerce(this.expr(args[0]), 'pair', args[0], `'${nm}' 的实参`);
    if (v === null) return null;
    if (nm === 'xpart') return { code: `(lane ${v.code} 0)`, type: 'real' };
    if (nm === 'ypart') return { code: `(lane ${v.code} 1)`, type: 'real' };
    this.used.add('asy__pconj');
    return { code: `(call asy__pconj ${v.code})`, type: 'pair' };
  }

  /* ----------------------------------------------------------------- 字符串 */

  /**
   * `length(…)`：asy 只有 string 和 pair 两个重载 —— 量过 `length(int[])` 是
   * "no matching function 'length(int[])'"（数组用 `a.length`），所以这里也拒，
   * 而且拒得不带 ASY_NOPE：这不是"还没做"，是 asy 自己就没有。
   */
  lengthCall(n) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== 1) return this.err(n, `'length' 要 1 个实参，给了 ${args.length} 个`);
    const v = this.expr(args[0]);
    if (v === null) return null;
    if (v.type === 'string') return { code: `(slen ${v.code})`, type: 'int' };
    if (v.type === 'pair' || v.type === 'int' || v.type === 'real') {
      const p = this.coerce(v, 'pair', args[0], "'length' 的实参");
      if (p === null) return null;
      this.used.add('asy__pabs');
      return { code: `(call asy__pabs ${p.code})`, type: 'real' };
    }
    return this.err(args[0], `length(${v.type}) 在 asy 那边就是 no matching function（数组的长度写 a.length）`);
  }

  /** 字符串上的内建函数（名单与形参类型见 ASY_STRFN）。 */
  strCall(n, nm) {
    const spec = ASY_STRFN.get(nm);
    const args = this.args(n.items[2]);
    if (args === null) return null;
    const max = spec.params.length;
    if (args.length < spec.min || args.length > max) {
      const want = spec.min === max ? `${max}` : `${spec.min} 或 ${max}`;
      return this.err(n, `'${nm}' 要 ${want} 个实参，给了 ${args.length} 个`);
    }
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      const v = this.coerce(this.expr(args[i]), spec.params[i], args[i], `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    let fn = spec.fn;
    if (nm === 'substr' && args.length === 2) fn = spec.short;
    else if (nm === 'find' && args.length === 2) parts.push('(int 0)');
    this.used.add(fn);
    for (const d of ASY_STR_DEPS.get(fn) ?? []) this.used.add(d);
    return { code: `(call ${fn} ${parts.join(' ')})`, type: spec.ret };
  }

  /**
   * `new T[n]` / `new T[]` / `new T[] {…}`。
   *
   * `new T[n]` 的 n 个格子在 asy 那边是**未初始化**的，读会当场报错
   * （量过：`int[] b = new int[2]; write(b[0]);` -> "read uninitialized value from array
   * at index 0"）；我们填零值。差别写在文件头 —— 这类程序本来就是有 bug 的，
   * 但"我们给 0 而 asy 报错"必须写在明处，不能等着被发现。
   */
  newArray(n) {
    const el = this.type(n.items[1], 'new 的元素类型');
    if (el === null) return null;
    if (asyIsArr(el) || el === 'void') return this.nope(n, '多维数组');
    if (!ASY_ARRELEM.has(el)) return this.nope(n, `${el}[] （数组元素这一刀只有 int/real/bool/string/pair）`);
    const dimexps = n.items[2];
    const hasCount = isList(dimexps) && head(dimexps) === 'dimexps';
    if (isList(dimexps) && head(dimexps) === 'dimexps-add') return this.nope(n, '多维数组');
    const init = n.items[hasCount ? 3 : 4];
    if (init !== undefined && isList(init) && head(init).startsWith('arrayinit')) {
      if (hasCount) return this.nope(n, '既给长度又给花括号初值');
      return this.arrLit(init, `${el}[]`);
    }
    if (init !== undefined && isList(init) && head(init) === 'dims+') return this.nope(n, '多维数组');
    const count = hasCount
      ? this.coerce(this.expr(dimexps.items[1]), 'int', n, 'new T[n] 的长度')
      : { code: '(int 0)', type: 'int' };
    if (count === null) return null;
    return { code: `(anew ${asyCore(`${el}[]`)} ${count.code})`, type: `${el}[]` };
  }

  /**
   * 花括号数组初值。核心方言里没有"数组字面量"这一条，所以摊成一串语句：
   * 先 anew 一个空的，再逐个 apush，最后把临时量当值用。这跟 `? :` 用的是同一套
   * `this.pre` 机制 —— 摊出来的语句落在**当前语句之前**，求值顺序不变。
   */
  arrLit(n, t) {
    if (this.pre === null) return this.nope(n, '这个位置的花括号数组初值（它要摊成语句，这里放不下）');
    const el = asyElem(t);
    const items = [];
    if (head(n) === 'arrayinit-rest') return this.nope(n, '`{…, ...rest}` 这种初值');
    for (const x of this.flat(n, 'arrayinit')) items.push(x);
    const nm = `asy__a${this.tmp++}`;
    this.pre.push(`(let ${nm} ${asyCore(t)} (anew ${asyCore(t)} (int 0)))`);
    for (const x of items) {
      const v = this.coerce(this.expr(x), el, x, `${t} 初值里的一项`);
      if (v === null) return null;
      this.pre.push(`(apush (var ${nm}) ${v.code})`);
    }
    return { code: `(var ${nm})`, type: t };
  }

  /** `a.push(v)` / `a.pop()`。asy 里 push 返回压进去的那个值（量过 `int x = c.push(9);`）。 */
  arrMethod(n, recv, nm) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    const el = asyElem(recv.type);
    if (nm === 'pop') {
      if (args.length !== 0) return this.err(n, `'pop' 不要实参，给了 ${args.length} 个`);
      return { code: `(apop ${recv.code})`, type: el };
    }
    if (nm !== 'push') return this.nope(n, `数组的 '.${nm}(…)'（这一刀只有 .push / .pop）`);
    if (args.length !== 1) return this.err(n, `'push' 要 1 个实参，给了 ${args.length} 个`);
    const v = this.coerce(this.expr(args[0]), el, args[0], "'push' 的实参");
    if (v === null) return null;
    // apush 在核心方言里是**语句**（它的"值"没人用），而 asy 的 push 是表达式且返回那个值。
    // 摊成 pre：先把值绑到临时量（只算一次），push 它，再把临时量当结果。
    if (this.pre === null) return this.nope(n, '这个位置的 `.push(…)`（它要摊成语句，这里放不下）');
    const tmp = `asy__p${this.tmp++}`;
    this.pre.push(`(let ${tmp} ${asyCore(el)} ${v.code})`);
    this.pre.push(`(apush ${recv.code} (var ${tmp}))`);
    return { code: `(var ${tmp})`, type: el };
  }

  /** 算术。asy 与核心方言不一致的四个算符（`/` `#` `%` `^`）全在这里换掉。 */
  binary(n) {
    const op = asyOpText(n.items[1]) ?? '?';
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    if (op === '<' || op === '<=' || op === '>' || op === '>=') return this.cmpCode(n, op, a, b);
    if (op === '#') {
      if (a.type !== 'int' || b.type !== 'int') return this.err(n, `'#' 两边要是 int，这里是 ${a.type} 和 ${b.type}`);
      this.used.add('asy__quot');
      return { code: `(call asy__quot ${a.code} ${b.code})`, type: 'int' };
    }
    if (op === '%') {
      // pair 上 asy 自己就没有 `%`（量过："no matching function 'operator %(pair, int)'"），
      // 所以这条是**错**，不是"还没做"；real 上的 `%` 是真的还没做。
      if (a.type === 'pair' || b.type === 'pair') return this.err(n, `pair 上没有 '%'（asy 那边也没有这个算符）`);
      if (a.type !== 'int' || b.type !== 'int') return this.nope(n, "real 上的 '%'");
      this.used.add('asy__mod');
      return { code: `(call asy__mod ${a.code} ${b.code})`, type: 'int' };
    }
    if (op === '^') {
      // pair 上的 `^` asy **是有**的（量过：(1,2)^2 是 (-3,4)，复数幂），我们这一刀没做 ——
      // 整数指数能靠 asy__pmul 迭代，但实数指数要 exp/log/atan2，白名单里没有。
      if (a.type === 'pair' || b.type === 'pair') return this.nope(n, "pair 上的 '^'（复数幂）");
      if (a.type === 'int' && b.type === 'int') {
        this.used.add('asy__ipow');
        return { code: `(call asy__ipow ${a.code} ${b.code})`, type: 'int' };
      }
      // 有一边是 real 就走 pow（量过：`2.0^3` 是 8、`2^0.5` 是 1.4142135623731）
      const av = this.coerce(a, 'real', n, "'^' 的左边");
      const bv = this.coerce(b, 'real', n, "'^' 的右边");
      if (av === null || bv === null) return null;
      return { code: `(rmath "pow" ${av.code} ${bv.code})`, type: 'real' };
    }
    if (op === '/') {
      // pair 上的 `/` 是复数除法（两边都先转成 pair —— 量过，见 asy__pdiv）
      if (a.type === 'pair' || b.type === 'pair') return this.pairArith(n, op, a, b);
      // asy 的 `/` 永远是实数除法：`1/3` 是 0.333…，整数商要写 `#`（量过）
      const av = this.coerce(a, 'real', n, "'/' 的左边");
      const bv = this.coerce(b, 'real', n, "'/' 的右边");
      if (av === null || bv === null) return null;
      return { code: `(bin "/" ${av.code} ${bv.code})`, type: 'real' };
    }
    if (op !== '+' && op !== '-' && op !== '*') return this.nope(n, `算符 '${op}'`);
    if (a.type === 'pair' || b.type === 'pair') return this.pairArith(n, op, a, b);
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
    if (t === 'string' && op !== '+') return this.err(n, `字符串上只有 '+'，这里是 '${op}'`);
    if (t === 'bool') return this.err(n, `'${op}' 不接受 bool`);
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: t };
  }

  /** pair 上的 `+ - * /`。`+ -` 是逐分量的（向量的 `+ -` 正好就是），`* /` 是复数乘除。 */
  pairArith(n, op, a, b) {
    const av = this.coerce(a, 'pair', n, `'${op}' 的左边`);
    const bv = this.coerce(b, 'pair', n, `'${op}' 的右边`);
    if (av === null || bv === null) return null;
    if (op === '+' || op === '-') return { code: `(bin "${op}" ${av.code} ${bv.code})`, type: 'pair' };
    const helper = op === '*' ? 'asy__pmul' : 'asy__pdiv';
    this.used.add(helper);
    return { code: `(call ${helper} ${av.code} ${bv.code})`, type: 'pair' };
  }

  cmpCode(n, op, a, b) {
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
    // pair 上没有大小 —— asy 那边也没有（没有 `operator <(pair,pair)`）
    if (t === 'pair') return this.err(n, `pair 上没有 '${op}'（asy 那边也没有这个算符）`);
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
  }

  compare(n, op) {
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    const t = this.promote(a, b);
    if (t === 'pair') {
      this.used.add('asy__peq');
      const eq = `(call asy__peq ${a.code} ${b.code})`;
      return { code: op === '==' ? eq : `(un "!" ${eq})`, type: 'bool' };
    }
    return this.cmpCode(n, op, a, b);
  }

  /**
   * `c ? a : b`。核心方言里 `? :` 不是表达式，于是摊成一个临时量加一条 if/else：
   *     (let t T <零值>) (if c (do (set t a)) (do (set t b)))
   * 两支各自的前置语句放进**各自那一支**里 —— 这样嵌套的 `? :` 也不会被提到 if 外面，
   * 短路语义（只算中选的那一支）跟着编码保住了。条件自己的前置语句留在外层：它总要算。
   */
  cond(n) {
    if (this.pre === null) return this.nope(n, '这个位置的 `? :`（它要摊成语句，这里放不下）');
    const c = this.coerce(this.expr(n.items[1]), 'bool', n, '`? :` 的条件');
    const outer = this.pre;
    this.pre = [];
    const a = this.expr(n.items[2]);
    const aPre = this.pre;
    this.pre = [];
    const b = this.expr(n.items[3]);
    const bPre = this.pre;
    this.pre = outer;
    if (c === null || a === null || b === null) return null;
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `\`? :\` 两支要同型：真支是 ${a.type}，假支是 ${b.type}`);
    if (t === 'void') return this.err(n, '`? :` 的两支不能是 void');
    const av = this.coerce(a, t, n, '`? :` 的真支');
    const bv = this.coerce(b, t, n, '`? :` 的假支');
    if (av === null || bv === null) return null;
    const nm = `asy__c${this.tmp++}`;
    const yes = aPre.concat([`(set ${nm} ${av.code})`]).join(' ');
    const no = bPre.concat([`(set ${nm} ${bv.code})`]).join(' ');
    this.pre.push(`(let ${nm} ${asyCore(t)} ${asyIsArr(t) ? `(anew ${asyCore(t)} (int 0))` : ZERO.get(t)})`);
    this.pre.push(`(if ${c.code} (do ${yes}) (do ${no}))`);
    return { code: `(var ${nm})`, type: t };
  }

  logic(n, op) {
    const a = this.coerce(this.expr(n.items[1]), 'bool', n, `'${op}' 的左边`);
    const b = this.coerce(this.expr(n.items[2]), 'bool', n, `'${op}' 的右边`);
    if (a === null || b === null) return null;
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
  }

  unary(n) {
    const op = asyOpText(n.items[1]) ?? '?';
    const v = this.expr(n.items[2]);
    if (v === null) return null;
    if (op === '!') {
      if (v.type !== 'bool') return this.err(n, `'!' 要 bool，这里是 ${v.type}`);
      return { code: `(un "!" ${v.code})`, type: 'bool' };
    }
    if (op === '+') return v;
    if (op === '-') {
      if (v.type === 'pair') {
        this.used.add('asy__pneg');
        return { code: `(call asy__pneg ${v.code})`, type: 'pair' };
      }
      if (v.type !== 'int' && v.type !== 'real') return this.err(n, `一元 '-' 要 int/real/pair，这里是 ${v.type}`);
      return { code: `(un "-" ${v.code})`, type: v.type };
    }
    return this.nope(n, `一元算符 '${op}'`);
  }

  /** `(int) e` / `(real) e` / `(pair) e`。别的目标类型这一刀不做。 */
  cast(n) {
    const t = this.type(n.items[1], '强制转换');
    if (t === null) return null;
    const v = this.expr(n.items[2]);
    if (v === null) return null;
    if (t === v.type) return v;
    if (t === 'real' && v.type === 'int') return { code: `(toreal ${v.code})`, type: 'real' };
    if (t === 'int' && v.type === 'real') return { code: `(toint ${v.code})`, type: 'int' };
    if (t === 'pair' && (v.type === 'int' || v.type === 'real')) return this.toPair(v);
    return this.nope(n, `把 ${v.type} 转成 ${t}`);
  }

  /** 实参表摊平。命名实参与展开都不做 —— 那要重载解析。 */
  args(node) {
    const out = [];
    for (const a of this.flat(node, 'args')) {
      if (!isList(a) || head(a) !== 'arg') {
        this.nope(a, isList(a) && head(a) === 'arg-named' ? '命名实参' : '展开实参');
        return null;
      }
      out.push(a.items[1]);
    }
    return out;
  }

  /** 调用。`write` 是语句（void），在表达式位置见到它就报错。 */
  call(n) {
    // `a.push(v)` / `a.pop()`：被调的是 `(field 接收者 名字)`，不是普通名字
    const callee = n.items[1];
    if (isList(callee) && head(callee) === 'field') {
      const recv = this.expr(callee.items[1]);
      if (recv === null) return null;
      const mname = isAtom(callee.items[2]) ? callee.items[2].value : null;
      if (!asyIsArr(recv.type)) return this.nope(n, `方法调用 '.${mname}(…)'`);
      return this.arrMethod(n, recv, mname);
    }
    const nm = isList(n.items[1]) && head(n.items[1]) === 'name-exp' ? this.plainName(n.items[1].items[1]) : null;
    if (nm === null && isList(callee) && head(callee) === 'name-exp') {
      // `c.push(8)`：同上，点是名字的一部分，所以方法调用也是"调一个带点的名字"
      const q = this.dotQual(callee.items[1]);
      if (q !== null) {
        if (!asyIsArr(q.recv.type)) return this.nope(n, `${q.recv.type} 上的方法调用 '.${q.field}(…)'`);
        return this.arrMethod(n, q.recv, q.field);
      }
    }
    if (nm === null) return this.nope(n, '调用一个不是普通名字的东西（函数值、方法、算符名）');
    if (nm === 'write') return this.err(n, `${ASY_NOPE}：write 出现在表达式位置（它是语句）`);
    // 内建数学函数先看：asy 里 sqrt/floor/… 是运行时自带的，不是 plain.asy 里的定义，
    // 所以这一层认它们不算"偷偷补模块系统"。用户自己定义了同名函数时以用户的为准
    // （asy 那边是重载，这一刀没有重载，让用户的定义赢至少不会静悄悄换掉语义）。
    if (!this.funcs.has(nm) && nm === 'length') return this.lengthCall(n);
    if (!this.funcs.has(nm) && ASY_STRFN.has(nm)) return this.strCall(n, nm);
    if (!this.funcs.has(nm) && ASY_STR_NOPE.has(nm)) return this.nope(n, ASY_STR_NOPE.get(nm));
    if (!this.funcs.has(nm) && ASY_PAIRFN.has(nm)) return this.pairCall(n, nm);
    if (!this.funcs.has(nm) && ASY_MATH.has(nm)) return this.mathCall(n, nm);
    const d = this.funcs.get(nm);
    if (d === undefined) return this.nope(n, `内建函数 '${nm}'（这一刀只有 write 和你自己定义的函数）`);
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== d.params.length) {
      return this.err(n, `'${nm}' 要 ${d.params.length} 个实参，给了 ${args.length} 个（默认实参与重载都还没做）`);
    }
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      const v = this.coerce(this.expr(args[i]), d.params[i], args[i], `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    if (d.ret === 'void') return { code: `(call ${nm}${parts.length === 0 ? '' : ' '}${parts.join(' ')})`, type: 'void' };
    return { code: `(call ${nm}${parts.length === 0 ? '' : ' '}${parts.join(' ')})`, type: d.ret };
  }

  /**
   * 内建数学函数。整数上的 `abs` 走一条 helper（核心方言里没有整数取绝对值），
   * 回 int 的那三个在 `(rmath …)` 外面套一层 `(toint …)` —— 结果本来就是整数，
   * 截断是精确的。
   */
  mathCall(n, nm) {
    const spec = ASY_MATH.get(nm);
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== spec.arity) {
      return this.err(n, `'${nm}' 要 ${spec.arity} 个实参，给了 ${args.length} 个`);
    }
    const vs = [];
    for (const a of args) {
      const v = this.expr(a);
      if (v === null) return null;
      vs.push(v);
    }
    if (nm === 'abs' && vs[0].type === 'int') {
      this.used.add('asy__iabs');
      return { code: `(call asy__iabs ${vs[0].code})`, type: 'int' };
    }
    if (nm === 'abs' && vs[0].type === 'pair') {
      // abs(pair) 是模，和 length(pair) 同一条（量过：abs((3,-4)) 与 length((3,-4)) 都是 5）
      this.used.add('asy__pabs');
      return { code: `(call asy__pabs ${vs[0].code})`, type: 'real' };
    }
    const parts = [];
    for (let i = 0; i < vs.length; i++) {
      const v = this.coerce(vs[i], 'real', args[i], `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    const code = `(rmath "${spec.fn}" ${parts.join(' ')})`;
    if (spec.ret === 'int') return { code: `(toint ${code})`, type: 'int' };
    return { code, type: 'real' };
  }

  /**
   * `write` 的重载是量出来的，形状是 `write(string s="", T x, T[] more..., suffix=endl)`：
   * 前缀 `s` 与第一个 T 之间**没有**分隔符，T 与 T 之间是制表符，而所有 T 必须**同型**。
   * 逐条量过（`asy -noV`，od -c 看字节）：
   *   write("a",1,2)        -> `a1\tab2`  ... 即 "a" "1" TAB "2"
   *   write("a","b","c")    -> `ab\tc`    ... 第一个串当前缀，后两个才是 T=string
   *   write("s",true,false) -> `strue \tfalse `
   *   write(1,"b",2)        -> no matching function 'write(int, string, int)'
   *   write("a","b",1)      -> no matching function（前缀吃掉 "a" 之后 T 定成了 string）
   *   write(true,"x")       -> no matching function（没有前缀，T 定成了 bool）
   * T 是**数组**时是另一条格式，见 writeArrays。
   */
  writeStmt(n) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length === 0) return this.nope(n, '不带实参的 write');
    const vals = [];
    for (const a of args) {
      const v = this.expr(a);
      if (v === null) return null;
      if (v.type === 'void') return this.err(a, 'write 的实参不能是 void');
      vals.push(v);
    }
    // 只有实参多于一个时第一个串才是前缀 —— 单个 write("a") 里 "a" 就是那个 T
    const prefix = vals.length > 1 && vals[0].type === 'string';
    const first = prefix ? 1 : 0;
    // T 的判定：asy 那边是重载解析。有一个实参是 pair 时 T 就是 pair，别的 int/real
    // 按隐式转换补成 `(v,0)`（量过：`write(3,(1,2))` 印的是 "(3,0)" TAB "(1,2)"）。
    let t = vals[first].type;
    for (let i = first; i < vals.length; i++) {
      if (vals[i].type === 'pair') t = 'pair';
    }
    for (let i = first; i < vals.length; i++) {
      if (t === 'pair' && (vals[i].type === 'int' || vals[i].type === 'real')) {
        vals[i] = this.toPair(vals[i]);
        continue;
      }
      if (vals[i].type === t) continue;
      const shape = vals.map((v) => v.type).join(', ');
      return this.err(args[i], `write 的实参要同型 —— asy 那边 write(${shape}) 就是 no matching function`);
    }
    // T 是数组：那是另一条格式（每行「下标 : TAB 值」），见 writeArrays
    if (asyIsArr(t)) return this.writeArrays(n, vals, first);
    const parts = vals.map((v) => this.fmtStr(v.type, v.code));
    // 前缀与第一个值之间不加分隔符，值与值之间加制表符
    let code = parts[0];
    for (let i = 1; i < parts.length; i++) {
      if (!(i === 1 && prefix)) code = `(bin "+" ${code} (str "\\t"))`;
      code = `(bin "+" ${code} ${parts[i]})`;
    }
    return [`(print ${code})`];
  }

  /** 一个值印成字符串时的形状。write 的两条路（标量与数组）共用这一份。 */
  fmtStr(t, code) {
    if (t === 'string') return code;
    // real 用 15 位有效数字 —— asy 的默认输出就是 %.15g（量过：1/3 是
    // 0.333333333333333、sqrt(2) 是 1.4142135623731、1e-5 是 1e-05、-0.0 是 -0）
    if (t === 'real') return `(tostr ${code} (int 15))`;
    if (t === 'pair') {
      this.used.add('asy__pairstr');
      return `(call asy__pairstr ${code})`;
    }
    if (t === 'bool') {
      this.used.add('asy__boolstr');
      return `(call asy__boolstr ${code})`;
    }
    return `(tostr ${code})`;
  }

  /**
   * `write` 一个或多个**整数组**。格式是量出来的（`asy -noV`，od -c 看字节）：
   *   int[] a={10,20}; write(a);       -> "0:\tab10\n1:\tab20\n"   即每行「下标 : TAB 值」
   *   write("P",a);                    -> "P\n" 然后才是那些行（前缀**自己占一行**）
   *   int[] b={30}; write(a,b);        -> "0:\tab10\tab30\n1:\tab20\n"
   *                                       行数按最长的那个数组，短的那个到头就不印了
   *   write(new int[0]);               -> 什么都不印
   *   write(a,5);                      -> no matching function 'write(int[], int)'
   *
   * 这一条刻意**不**发 helper 函数，直接摊成语句：数组的个数是变的（helper 要按个数各发
   * 一份），而摊成语句只用一个 while。数组都先绑临时量 —— `write(f(),g())` 里 f 和 g
   * 各只能调一次。
   */
  writeArrays(n, vals, first) {
    if (this.pre === null) return this.nope(n, '这个位置的 write（它要摊成语句，这里放不下）');
    const el = asyElem(vals[first].type);
    const out = [];
    if (first === 1) out.push(`(print ${vals[0].code})`);
    const names = [];
    for (let i = first; i < vals.length; i++) {
      const nm = `asy__wa${this.tmp++}`;
      names.push(nm);
      out.push(`(let ${nm} ${asyCore(vals[first].type)} ${vals[i].code})`);
    }
    const nmax = `asy__wn${this.tmp++}`;
    out.push(`(let ${nmax} int (int 0))`);
    for (const nm of names) {
      out.push(`(if (bin "<" (var ${nmax}) (alen (var ${nm}))) (do (set ${nmax} (alen (var ${nm})))))`);
    }
    const iv = `asy__wi${this.tmp++}`;
    const sv = `asy__ws${this.tmp++}`;
    const body = [`(let ${sv} string (bin "+" (tostr (var ${iv})) (str ":")))`];
    for (const nm of names) {
      const cell = this.fmtStr(el, `(aget (var ${nm}) (var ${iv}))`);
      body.push(`(if (bin "<" (var ${iv}) (alen (var ${nm}))) (do (set ${sv} (bin "+" (var ${sv}) (bin "+" (str "\\t") ${cell})))))`);
    }
    body.push(`(print (var ${sv}))`);
    body.push(`(set ${iv} (bin "+" (var ${iv}) (int 1)))`);
    out.push(`(let ${iv} int (int 0))`);
    out.push(`(while (bin "<" (var ${iv}) (var ${nmax})) (do ${body.join(' ')}))`);
    return out;
  }

  /* ---------------------------------------------------------------- 语句 */

  /**
   * 一条 asy 语句可能摊成好几条核心方言语句，所以一律回数组；失败回 null。
   *
   * 外壳负责**前置语句**：`? :` 这种"核心方言里不是表达式"的东西，降级时要先算进一个
   * 临时量，那几条就攒在 this.pre 里，由这里补在本条语句前面。每条语句一份 pre，所以
   * 嵌套语句（if 的分支、循环体）各自算各自的，不会被提到外面去。
   */
  stmt(n, ret) {
    const outer = this.pre;
    this.pre = [];
    const lines = this.stmtOne(n, ret);
    const pre = this.pre;
    this.pre = outer;
    if (lines === null) return null;
    if (pre.length === 0) return lines;
    return pre.concat(lines);
  }

  /**
   * 循环条件里不许有前置语句。`? :` 摊出来的临时量赋值只能放在**循环外面**，那样条件就
   * 只算一次，语义就错了 —— 所以见到就报错，而不是悄悄换个意思。
   * @param {number} mark 算条件之前 this.pre 的长度
   */
  loopCond(node, what, mark) {
    if (this.pre === null || this.pre.length === mark) return true;
    return this.nope(node, `${what} 的条件里的 \`? :\`（它要摊成语句，而循环条件每轮都得重算）`);
  }

  stmtOne(n, ret) {
    if (!isList(n)) return this.err(n, '认不出的语句');
    const h = head(n);
    if (h === 'empty-stm') return [];
    if (h === 'modified') return this.stmt(n.items[2], ret);
    if (h === 'vardec') return this.vardec(n);
    if (h === 'exp-stm') return this.exprStmt(n.items[1]);
    if (h === 'block-stm') {
      const body = this.body(n.items[1], ret);
      return body === null ? null : [`(do ${body.join(' ')})`];
    }
    if (h === 'if') {
      const c = this.coerce(this.expr(n.items[1]), 'bool', n, 'if 的条件');
      const t = this.stmt(n.items[2], ret);
      if (c === null || t === null) return null;
      if (n.items[3] === undefined) return [`(if ${c.code} (do ${t.join(' ')}))`];
      const e = this.stmt(n.items[3], ret);
      if (e === null) return null;
      return [`(if ${c.code} (do ${t.join(' ')}) (do ${e.join(' ')}))`];
    }
    if (h === 'while') {
      const c = this.coerce(this.expr(n.items[1]), 'bool', n, 'while 的条件');
      if (this.loopCond(n, 'while', 0) === null) return null;
      this.updates.push([]);
      const b = this.stmt(n.items[2], ret);
      this.updates.pop();
      if (c === null || b === null) return null;
      return [`(while ${c.code} (do ${b.join(' ')}))`];
    }
    if (h === 'do') return this.doWhile(n, ret);
    if (h === 'for') return this.forStmt(n, ret);
    if (h === 'for-each') return this.forEach(n, ret);
    if (h === 'break') return ['(brk)'];
    if (h === 'continue') {
      // C 式 for 降成 while 之后，continue 要**先跑更新**再跳（量过 asy 的行为）
      const upd = this.updates.length === 0 ? [] : this.updates[this.updates.length - 1];
      const out = [];
      for (const u of upd) out.push(u);
      out.push('(cont)');
      return out;
    }
    if (h === 'return') {
      if (n.items[1] === undefined) return ['(ret)'];
      const v = this.coerce(this.expr(n.items[1]), ret, n, 'return 的值');
      return v === null ? null : [`(ret ${v.code})`];
    }
    return this.nope(n, `语句 '${h}'`);
  }

  /**
   * `do S while (c)` -> `while (true) { S; if (!c) break; }`。
   * 刻意不复制 S（复制会让 S 里的 break 落在循环外面），代价是 `continue` 在这个编码里
   * 会跳过条件检查，语义就错了 —— 所以见到就报错，而不是悄悄换个意思。
   */
  doWhile(n, ret) {
    this.updates.push([]);
    const b = this.stmt(n.items[1], ret);
    this.updates.pop();
    const mark = this.pre === null ? 0 : this.pre.length;
    const c = this.coerce(this.expr(n.items[2]), 'bool', n, 'do-while 的条件');
    if (this.loopCond(n, 'do-while', mark) === null) return null;
    if (b === null || c === null) return null;
    for (const s of b) {
      if (s === '(cont)' || s.includes(' (cont)')) return this.nope(n, 'do-while 里的 continue');
    }
    return [`(while (bool true) (do ${b.join(' ')} (if (un "!" ${c.code}) (do (brk)))))`];
  }

  /**
   * `for (T x : a) S` -> 绑一次数组**句柄**，按下标走。
   *
   * 量过的两条：循环变量是**复制**（体里 `x = 99` 不动数组），而且迭代是**活的** ——
   * 体里 push 进去的元素会被走到（`int[] a={1,2}; int n=0; for(int x:a){++n; if(n<5) a.push(9);}`
   * 走了 6 轮，末了 a.length 是 6）。所以这里绑句柄、每轮重读 `(alen …)`，
   * 而不是先拷一份快照 —— 快照会让那个程序只走 2 轮。
   */
  forEach(n, ret) {
    const el = this.type(n.items[1], 'for-each 的元素类型');
    if (el === null) return null;
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (nm === null) return this.err(n, 'for-each 少了循环变量名');
    const a = this.expr(n.items[3]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(n, `for-each 要一个数组，这里是 ${a.type}`);
    if (asyElem(a.type) !== el) return this.err(n, `for-each 的元素写的是 ${el}，数组是 ${a.type}`);
    const av = `asy__f${this.tmp++}`;
    const iv = `asy__fi${this.tmp++}`;
    const upd = [`(set ${iv} (bin "+" (var ${iv}) (int 1)))`];
    this.push();
    if (this.declare(n, nm, el) === null) { this.pop(); return null; }
    this.updates.push(upd);
    const body = this.stmt(n.items[4], ret);
    this.updates.pop();
    this.pop();
    if (body === null) return null;
    const inner = [`(let ${nm} ${asyCore(el)} (aget (var ${av}) (var ${iv})))`];
    for (const s of body) inner.push(s);
    for (const s of upd) inner.push(s);
    const head3 = `(let ${av} ${asyCore(a.type)} ${a.code}) (let ${iv} int (int 0))`;
    return [`(do ${head3} (while (bin "<" (var ${iv}) (alen (var ${av}))) (do ${inner.join(' ')})))`];
  }

  /** `for (init; test; upd) body` -> `init; while (test) { body; upd }`（continue 见上） */
  forStmt(n, ret) {
    this.push();
    const init = this.forPart(n.items[1], ret);
    const mark = this.pre === null ? 0 : this.pre.length;
    const test = isList(n.items[2]) && head(n.items[2]) === 'none'
      ? { code: '(bool true)', type: 'bool' }
      : this.coerce(this.expr(n.items[2]), 'bool', n, 'for 的条件');
    if (this.loopCond(n, 'for', mark) === null) { this.pop(); return null; }
    const upd = this.forPart(n.items[3], ret);
    if (init === null || test === null || upd === null) { this.pop(); return null; }
    this.updates.push(upd);
    const body = this.stmt(n.items[4], ret);
    this.updates.pop();
    this.pop();
    if (body === null) return null;
    const inner = [];
    for (const s of body) inner.push(s);
    for (const s of upd) inner.push(s);
    return [`(do ${init.join(' ')} (while ${test.code} (do ${inner.join(' ')})))`];
  }

  /** for 的 init / update 段：`(none)` / `(stmexps ...)` / 一条 barevardec */
  forPart(n, ret) {
    if (!isList(n)) return [];
    const h = head(n);
    if (h === 'none') return [];
    if (h === 'vardec') return this.vardec(n);
    const out = [];
    for (const s of this.flat(n, 'stmexps')) {
      const one = this.stmt(s, ret);
      if (one === null) return null;
      for (const x of one) out.push(x);
    }
    return out;
  }

  /** `int a = 1, b;`：没有初值的按类型给零值 —— asy 也是这么定的 */
  vardec(n) {
    const base = this.type(n.items[1], '变量声明');
    if (base === null) return null;
    if (base === 'void') return this.err(n, 'void 变量');
    const out = [];
    for (const d of this.flat(n.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') return this.err(d, '认不出的声明项');
      const start = d.items[1];
      if (!isList(start) || head(start) !== 'decidstart') return this.err(start, '认不出的声明项');
      // `real a[];`：维度写在名字后面。一层就是数组，两层以上不做
      let t = base;
      if (start.items.length > 2) {
        const dims = start.items[2];
        if (!isList(dims) || head(dims) !== 'dims') return this.nope(start, '声明里带多维数组或形参表');
        if (asyIsArr(t)) return this.nope(start, '多维数组');
        if (!ASY_ARRELEM.has(t)) return this.nope(start, `${t}[] （数组元素这一刀只有 int/real/bool/string/pair）`);
        t = `${t}[]`;
      }
      const nm = isAtom(start.items[1]) ? start.items[1].value : null;
      if (nm === null) return this.err(start, '声明里少了名字');
      let init = asyIsArr(t) ? `(anew ${asyCore(t)} (int 0))` : ZERO.get(t);
      if (d.items[2] !== undefined) {
        // `T[] a = {1,2,3}`：花括号初值自己没有类型，元素类型从左边的声明来
        const raw = d.items[2];
        const lit = asyIsArr(t) && isList(raw) && head(raw).startsWith('arrayinit')
          ? this.arrLit(raw, t)
          : this.expr(raw);
        const v = this.coerce(lit, t, d, `'${nm}' 的初值`);
        if (v === null) return null;
        init = v.code;
      }
      if (this.declare(start, nm, t) === null) return null;
      out.push(`(let ${nm} ${asyCore(t)} ${init})`);
    }
    return out;
  }

  /** 语句位置的表达式。赋值/自增只认这里 —— 它们在核心方言里是语句，不是表达式。 */
  exprStmt(e) {
    if (!isList(e)) return this.err(e, '认不出的表达式语句');
    const h = head(e);
    if (h === 'assign') return this.assign(e, e.items[1], e.items[2], null);
    if (h === 'self') {
      // SELFOP 是词法给的 token（原子），而 `(prefix "+" …)` 里的算符是模板里的字符串 ——
      // 两种节点都可能，所以一律用 asyOpText 取文本，不假设是哪一种
      const op = asyOpText(e.items[1]);
      if (op === null || op.length !== 2 || !'+-*/#%^'.includes(op.slice(0, 1))) return this.nope(e, `复合赋值 '${op}'`);
      return this.assign(e, e.items[2], e.items[3], op.slice(0, 1));
    }
    // 后缀 `x++` / `a[0]++`：**asy 自己就不收**（量过：`int b=1; b++;` 报
    // "postfix expressions are not allowed"，`a[0]++` 也一样）。这一层照着拒 ——
    // 语法认得它（camp.y 里有那条产生式），但收下来就等于比 asy 多接受一门语言。
    if (h === 'postfix') return this.err(e, 'asy 自己就不收后缀 ++/--（postfix expressions are not allowed）：写成 ++x');
    if (h === 'prefix') {
      const op = asyOpText(e.items[1]);
      if (op !== '+' && op !== '-') return this.nope(e, `自增/自减 '${op}'`);
      return this.assign(e, e.items[2], null, op);
    }
    if (h === 'call') {
      const nm = isList(e.items[1]) && head(e.items[1]) === 'name-exp' ? this.plainName(e.items[1].items[1]) : null;
      if (nm === 'write') return this.writeStmt(e);
      const v = this.call(e);
      if (v === null) return null;
      return [`(expr ${v.code})`];
    }
    return this.nope(e, `语句位置的表达式 '${h}'`);
  }

  /** 赋值、复合赋值、自增自减都归到这里：目标是普通变量名，或者数组下标 */
  assign(node, lhs, rhs, op) {
    if (isList(lhs) && head(lhs) === 'subscript') return this.assignIndex(node, lhs, rhs, op);
    // 切片赋值 asy **有**（量过：`int[] a={1,2,3}; a[0:2]=b;` 之后 a 是 7,8,3），
    // 而且右边长度不同时整个数组的长度会跟着变 —— 那是另一条语义，这一刀没做。
    if (isList(lhs) && head(lhs) === 'slice-exp') return this.nope(node, '给切片赋值（`a[0:2] = b`）');
    const nm = isList(lhs) && head(lhs) === 'name-exp' ? this.plainName(lhs.items[1]) : null;
    if (nm === null) return this.nope(node, '赋值给不是普通变量或数组下标的东西（字段、切片、算符名）');
    const t = this.lookup(nm);
    if (t === null) {
      if (this.globals.has(nm)) return this.nope(node, `函数里改文件级变量 '${nm}'（核心方言没有全局量）`);
      return this.err(node, `未声明的变量 '${nm}'`);
    }
    if (op === null) {
      const v = this.coerce(this.expr(rhs), t, node, `给 '${nm}' 赋的值`);
      return v === null ? null : [`(set ${nm} ${v.code})`];
    }
    // 自增自减：右边就是 1，类型跟着变量
    const one = rhs === null ? { code: t === 'real' ? '(real 1.0)' : '(int 1)', type: t } : this.expr(rhs);
    if (one === null) return null;
    if (rhs === null && t !== 'int' && t !== 'real') return this.err(node, `'${nm}' 是 ${t}，不能自增自减`);
    if (t === 'pair') {
      // `z += w` 是逐分量，`z *= 2` 与 `z /= (0,1)` 走复数乘除（量过：(4,6)*=2 是
      // (8,12)、(8,12)/=(0,1) 是 (12,-8)）。`#= %= ^=` pair 上没有。
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return this.err(node, `pair 上没有 '${op}='`);
      const v = this.pairArith(node, op, { code: `(var ${nm})`, type: 'pair' }, one);
      return v === null ? null : [`(set ${nm} ${v.code})`];
    }
    if (op === '#' || op === '%') {
      if (t !== 'int' || one.type !== 'int') return this.err(node, `'${op}=' 两边要是 int`);
      const helper = op === '#' ? 'asy__quot' : 'asy__mod';
      this.used.add(helper);
      return [`(set ${nm} (call ${helper} (var ${nm}) ${one.code}))`];
    }
    if (op === '^') {
      if (t !== 'int' || one.type !== 'int') return this.nope(node, "real 上的 '^='");
      this.used.add('asy__ipow');
      return [`(set ${nm} (call asy__ipow (var ${nm}) ${one.code}))`];
    }
    if (op === '/') {
      if (t !== 'real') return this.nope(node, `int 上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
      const v = this.coerce(one, 'real', node, "'/=' 的右边");
      return v === null ? null : [`(set ${nm} (bin "/" (var ${nm}) ${v.code}))`];
    }
    const v = this.coerce(one, t, node, `'${op}=' 的右边`);
    if (v === null) return null;
    if (t === 'string' && op !== '+') return this.err(node, `字符串上只有 '+='`);
    if (t === 'bool') return this.err(node, `bool 上没有 '${op}='`);
    return [`(set ${nm} (bin "${op}" (var ${nm}) ${v.code}))`];
  }

  /**
   * `a[i] = v` / `a[i] += v` / `a[i]++`。
   *
   * 两件事和变量赋值不一样：
   *
   *  1. **写下标会把数组长到 i+1**（量过：`int[] e; e[2]=5;` 之后 `e.length` 是 3）。
   *     所以先调一个 `asy__grow_元素` 把长度顶上去，再 aset。
   *  2. 数组和下标都要**只算一次**：复合赋值要读一次写一次，`a[f()] += 1` 里的 f 不能调两遍。
   *     所以两者都先绑到临时量（用 `? :` 那套 `this.pre`）。
   */
  assignIndex(node, lhs, rhs, op) {
    const a = this.expr(lhs.items[1]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(node, `下标只能用在数组上，这里是 ${a.type}`);
    const idx = this.coerce(this.expr(lhs.items[2]), 'int', node, '下标');
    if (idx === null) return null;
    if (this.pre === null) return this.nope(node, '这个位置的下标赋值（它要摊成语句，这里放不下）');
    const el = asyElem(a.type);
    const av = `asy__d${this.tmp++}`;
    const iv = `asy__i${this.tmp++}`;
    this.pre.push(`(let ${av} ${asyCore(a.type)} ${a.code})`);
    this.pre.push(`(let ${iv} int ${idx.code})`);
    const grow = `asy__grow_${el}`;
    this.used.add(grow);
    const head2 = `(expr (call ${grow} (var ${av}) (var ${iv})))`;
    const cur = `(aget (var ${av}) (var ${iv}))`;
    const put = (code) => [head2, `(aset (var ${av}) (var ${iv}) ${code})`];
    if (op === null) {
      const v = this.coerce(this.expr(rhs), el, node, '赋给数组元素的值');
      return v === null ? null : put(v.code);
    }
    const one = rhs === null ? { code: el === 'real' ? '(real 1.0)' : '(int 1)', type: el } : this.expr(rhs);
    if (one === null) return null;
    if (rhs === null && el !== 'int' && el !== 'real') return this.err(node, `${el} 的数组元素不能自增自减`);
    if (op === '#' || op === '%') {
      if (el !== 'int' || one.type !== 'int') return this.err(node, `'${op}=' 两边要是 int`);
      const helper = op === '#' ? 'asy__quot' : 'asy__mod';
      this.used.add(helper);
      return put(`(call ${helper} ${cur} ${one.code})`);
    }
    if (op === '^') {
      if (el === 'int' && one.type === 'int') {
        this.used.add('asy__ipow');
        return put(`(call asy__ipow ${cur} ${one.code})`);
      }
      if (el !== 'real') return this.err(node, `'^=' 的两边要是 int 或 real`);
      const v = this.coerce(one, 'real', node, "'^=' 的右边");
      return v === null ? null : put(`(rmath "pow" ${cur} ${v.code})`);
    }
    if (op === '/') {
      if (el !== 'real') return this.nope(node, `int 数组元素上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
      const v = this.coerce(one, 'real', node, "'/=' 的右边");
      return v === null ? null : put(`(bin "/" ${cur} ${v.code})`);
    }
    const v = this.coerce(one, el, node, `'${op}=' 的右边`);
    if (v === null) return null;
    if (el === 'string' && op !== '+') return this.err(node, `字符串上只有 '+='`);
    if (el === 'bool') return this.err(node, `bool 上没有 '${op}='`);
    return put(`(bin "${op}" ${cur} ${v.code})`);
  }

  /** 一段花括号里的东西：`(block-stm BLOCK)` 或直接一条 BLOCK 链 */
  body(n, ret) {
    const inner = isList(n) && head(n) === 'block-stm' ? n.items[1] : n;
    this.push();
    const out = [];
    for (const r of this.flat(inner, 'block')) {
      const one = this.stmt(r, ret);
      if (one === null) { this.pop(); return null; }
      for (const s of one) out.push(s);
    }
    this.pop();
    return out;
  }

  /* ------------------------------------------------------------ 文件与函数 */

  /** `static real f(...)` 这类修饰在文件层是无所谓的，剥掉 */
  unwrapMod(n) {
    let cur = n;
    while (isList(cur) && head(cur) === 'modified') cur = cur.items[2];
    return cur;
  }

  /** 形参表：`(formal (implicit) TYPE (decidstart NAME))`；别的形状都不做 */
  formals(node) {
    const out = [];
    for (const f of this.flat(node, 'formals')) {
      if (!isList(f) || head(f) !== 'formal') return this.nope(f, '关键字形参或可变形参');
      if (f.items.length !== 4) return this.nope(f, f.items.length === 3 ? '无名形参' : '带默认值的形参');
      const ex = f.items[1];
      if (isList(ex) && head(ex) === 'explicit') return this.nope(f, 'explicit 形参');
      const t = this.type(f.items[2], '形参');
      const start = f.items[3];
      if (t === null) return null;
      if (!isList(start) || head(start) !== 'decidstart' || start.items.length !== 2) return this.nope(start, '带维度或形参表的形参名');
      const nm = isAtom(start.items[1]) ? start.items[1].value : null;
      if (nm === null) return this.err(start, '形参少了名字');
      out.push({ name: nm, type: t });
    }
    return out;
  }

  /** 第一遍：登记签名。没有重载 —— 同名第二次就是错。 */
  sig(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (nm === null) return;
    if (nm.startsWith('operator ')) { this.nope(n, '算符重载的定义'); return; }
    if (nm === 'write') { this.nope(n, "重新定义 'write'"); return; }
    const ret = this.type(n.items[1], `函数 ${nm} 的返回类型`);
    const ps = this.formals(n.items[3]);
    if (ret === null || ps === null) return;
    if (this.funcs.has(nm)) { this.nope(n, `重载：'${nm}' 定义了不止一次`); return; }
    const types = [];
    for (const p of ps) types.push(p.type);
    this.funcs.set(nm, { ret, params: types });
  }

  /** 第一遍也收文件级变量的名字（只为了给函数里那句错话） */
  globalNames(n) {
    for (const d of this.flat(n.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') continue;
      const start = d.items[1];
      if (!isList(start) || !isAtom(start.items[1])) continue;
      this.globals.set(start.items[1].value, true);
    }
  }

  /** 第二遍：函数体。核心方言要求非 void 的函数每条路径都有 ret，asy 不要求 —— 差别见下。 */
  func(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    const d = nm === null ? undefined : this.funcs.get(nm);
    if (d === undefined) return null;
    const ps = this.formals(n.items[3]);
    if (ps === null) return null;
    this.push();
    for (const p of ps) this.declare(n, p.name, p.type);
    const body = this.body(n.items[4], d.ret);
    this.pop();
    if (body === null) return null;
    // 掉出函数尾巴：asy 是运行期报 "function did not return a value"，我们补一条零值 ret。
    // 这是**明写的**差别，不是漏的：核心方言的检查在编译期，而这条 ret 永远走不到才对。
    const last = body.length === 0 ? '' : body[body.length - 1];
    if (d.ret !== 'void' && !last.startsWith('(ret ')) {
      body.push(`(ret ${asyIsArr(d.ret) ? `(anew ${asyCore(d.ret)} (int 0))` : ZERO.get(d.ret)})`);
    }
    const params = [];
    for (const p of ps) params.push(`(${p.name} ${asyCore(p.type)})`);
    const lines = [`  (fn ${nm} (${params.join(' ')}) ${asyCore(d.ret)}`];
    for (const s of body) lines.push(`    ${s}`);
    return `${lines.join('\n')})`;
  }

  /** 整个文件 -> 核心方言文本。函数提到模块层，其余全进 (main ...)。 */
  run(tree) {
    const rs = this.flat(tree, 'block');
    for (const r0 of rs) {
      const r = this.unwrapMod(r0);
      if (!isList(r)) continue;
      if (head(r) === 'fundec') this.sig(r);
      else if (head(r) === 'vardec') this.globalNames(r);
    }
    const fns = [];
    for (const r0 of rs) {
      const r = this.unwrapMod(r0);
      if (!isList(r) || head(r) !== 'fundec') continue;
      const f = this.func(r);
      if (f !== null) fns.push(f);
    }
    this.push();
    const main = [];
    for (const r0 of rs) {
      const r = this.unwrapMod(r0);
      if (isList(r) && head(r) === 'fundec') continue;
      const s = this.stmt(r, 'void');
      if (s === null) continue;
      for (const x of s) main.push(x);
    }
    this.pop();
    const out = ['(module'];
    for (const [hnm, text] of HELPERS) {
      if (this.used.has(hnm)) out.push(text);
    }
    for (const f of fns) out.push(f);
    const body = [];
    for (const s of main) body.push(`    ${s}`);
    out.push(`  (main${body.length === 0 ? '' : `\n${body.join('\n')}`}))`);
    return out.join('\n') + '\n';
  }
}

/**
 * asy 语法树 -> 核心方言文本。
 * @param {any} tree glrParse 出来的那棵树（asy.grammar 的 file 规则）
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {string} 核心方言源文本（诊断有错时内容不可用）
 */
export function lowerAsy(tree, diags) {
  return new AsyLower(diags).run(tree);
}
