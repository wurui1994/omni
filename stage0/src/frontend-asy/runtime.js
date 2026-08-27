// Omni stage0 — asy 前端的**运行时那一份**：零值表、pair/字符串内建的名字表，以及
// 降级时按需拉进来的核心方言 helper 源码（HELPERS）。
//
// 从 lower.js 里搬出来的第二摊。这里的东西都是**数据**：字符串、Map、Set，还有两个
// 拼字符串的纯函数。一个都不碰 AsyLower 的状态，所以搬家同样是纯位置变动。
// helper 只有一份源码、六条腿共用 —— 这正是它们该单独成文件的理由：改一处等于改六条腿。
//
// 名字一个都没改：封闭 ABI 要求模块级名字全仓唯一（ADR-0011/0014）。

import { ASY_PAIR_TY, ASY_TRIPLE_TY, asyCore } from './types.js';

/** 没写初值时的零值。asy 也是这么定的（未初始化的 int 是 0，string 是空串，pair 是 (0,0)）。 */
export const ZERO = new Map([
  ['int', '(int 0)'],
  ['real', '(real 0.0)'],
  ['bool', '(bool false)'],
  ['string', '(str "")'],
  ['pair', `(vlit ${ASY_PAIR_TY} (real 0.0) (real 0.0))`],
  // 量过：`triple t;` 是 (0,0,0)
  ['triple', `(vlit ${ASY_TRIPLE_TY} (real 0.0) (real 0.0) (real 0.0) (real 0.0))`],
]);

/**
 * pair 上的内建函数。返回类型是量出来的（`asy -noV`）：
 *   abs((3,-4)) / length((1,2))  -> real（模）
 *   conj((1,2))                  -> (1,-2)
 *   xpart/ypart                  -> real（`z.x`/`z.y` 是同一件事）
 * `angle`/`dir`/`expi` 这一刀还没做（atan2/cos/sin 已经在 rmath 白名单里了，接上就行）；
 * `unit` 见文件头。
 * `realpart`/`imagpart` **asy 自己就没有**（量过："no matching variable 'realpart'"），
 * 所以这里也没有 —— 补上就是比 asy 多接受一门语言。
 */
export const ASY_PAIRFN = new Set(['conj', 'xpart', 'ypart', 'zpart', 'angle', 'unit', 'dir', 'expi',
  'dot', 'cross', 'realmult']);

/**
 * 字符串上的内建函数。`params` 是每个实参要的类型，`min` 是最少给几个 ——
 * asy 那边 `substr(s,i)` 与 `find(s,t)` 是靠**默认实参**少给一个，这一刀没有默认实参
 * 机制，所以按"给了几个"分派：substr 少给走"到末尾"那条 helper，find 少给补起点 0。
 * `reverse` 刻意不收：它按字节翻转，非 ASCII 翻出来不是合法 UTF-8，而"印一串非法字节"
 * 在 C 与 JS 两条腿上不是同一件事 —— 没量准的东西不收。
 */
export const ASY_STRFN = new Map([
  ['substr', { params: ['string', 'int', 'int'], min: 2, fn: 'asy__ssub', short: 'asy__ssubto', ret: 'string' }],
  ['find', { params: ['string', 'string', 'int'], min: 2, fn: 'asy__sfindp', ret: 'int' }],
  ['rfind', { params: ['string', 'string'], min: 2, fn: 'asy__srfind', ret: 'int' }],
  ['replace', { params: ['string', 'string', 'string'], min: 3, fn: 'asy__srepl', ret: 'string' }],
  ['erase', { params: ['string', 'int', 'int'], min: 3, fn: 'asy__serase', ret: 'string' }],
  ['insert', { params: ['string', 'int', 'string'], min: 3, fn: 'asy__sins', ret: 'string' }],
  ['split', { params: ['string', 'string'], min: 2, fn: 'asy__ssplit', ret: 'string[]' }],
]);

/** helper 之间的依赖：发了外层那条，被它调用的也要发。 */
export const ASY_STR_DEPS = new Map([
  ['asy__ssubto', ['asy__ssub']],
  ['asy__serase', ['asy__ssub', 'asy__ssubto']],
  ['asy__sfindp', ['asy__ssub', 'asy__ssubto']],
  ['asy__srepl', ['asy__ssub', 'asy__ssubto']],
  ['asy__sins', ['asy__ssub', 'asy__ssubto']],
  ['asy__ssplit', ['asy__ssub', 'asy__ssubto', 'asy__sfindp']],
]);

/**
 * 字符串上**刻意没做**的那几个，各自带上理由 —— 落到"内建函数 'xxx' 没有"那条通用
 * 消息里的话，看的人分不清是"这一刀没做"还是"asy 也没有"。
 */
export const ASY_STR_NOPE = new Map([
  ['reverse', "字符串的 reverse（asy 是按字节倒的，而 Omni 的 string 是 UTF-8 字节序列 —— 非 ASCII 倒出来在 C 与 JS 两条腿上不是同一件事）"],
]);

/** 核心方言的字符串字面量。刻意不用 JSON.stringify：它对控制字符发 \uXXXX，
 *  而 sexpr/read.js 的转义表里没有 \u（那是 WAT 的方言）。只转必须转的五个。 */
export function strLit(s) {
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
export const HELPERS = new Map([
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
  // dot / cross / realmult 在 pair 上也有（量过：dot((1,2),(3,4))=11、cross 给**实数** -2、
  // realmult 逐分量给 (3,8)）。triple 上是另外三条（asy__tdot / tcross / trealmult）。
  ['asy__pdot', `  (fn asy__pdot ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) real
    (ret (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 0)) (bin "*" (lane (var a) 1) (lane (var b) 1)))))`],
  ['asy__pcross', `  (fn asy__pcross ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) real
    (ret (bin "-" (bin "*" (lane (var a) 0) (lane (var b) 1)) (bin "*" (lane (var a) 1) (lane (var b) 0)))))`],
  ['asy__prealmult', `  (fn asy__prealmult ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    (ret (vlit ${ASY_PAIR_TY} (bin "*" (lane (var a) 0) (lane (var b) 0))
      (bin "*" (lane (var a) 1) (lane (var b) 1)))))`],
  // 下面这四个都要超越函数。它们能落地是因为 rmath 的白名单已经是"宿主数学库的交集"
  // （atan2/cos/sin 都在里面），所以这里没有自己写的实现，只有 asy 那几行的形状。
  ['asy__pangle', `  (fn asy__pangle ((a ${ASY_PAIR_TY}) (warn bool)) real
    ;; angle((0,0)) 在 asy 是**运行期错误** "taking angle of (0,0)"，而 angle(z,false) 给 0
    ;; （两条都量过）。所以零点这一问必须在 atan2 之前 —— libm 的 atan2(0,0) 是 0，不报错。
    (if (bin "&&" (bin "==" (lane (var a) 0) (real 0.0)) (bin "==" (lane (var a) 1) (real 0.0)))
      (do
        (if (var warn) (do (fail (str "taking angle of (0,0)"))))
        (ret (real 0.0))))
    (ret (rmath "atan2" (lane (var a) 1) (lane (var a) 0))))`],
  ['asy__punit', `  (fn asy__punit ((a ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; z / abs(z)，逐分量除。零点要挡一刀：量过 unit((0,0)) 是 (0,0) 而不是 (nan,nan)。
    ;; abs 是朴素那一份（见 asy__pabs），所以 unit((1e200,1e200)) 是 (0,0) —— 量过，一致。
    (let r real (call asy__pabs (var a)))
    (if (bin "==" (var r) (real 0.0)) (do (ret (var a))))
    (ret (vlit ${ASY_PAIR_TY} (bin "/" (lane (var a) 0) (var r)) (bin "/" (lane (var a) 1) (var r)))))`],
  ['asy__pexpi', `  (fn asy__pexpi ((t real)) ${ASY_PAIR_TY}
    ;; expi(t) = (cos t, sin t)。量过 expi(0.5) = (0.877582561890373,0.479425538604203)，
    ;; 与宿主的 cos/sin 一致 —— 两个分量各自舍入，不是"先算一个再推另一个"。
    (ret (vlit ${ASY_PAIR_TY} (rmath "cos" (var t)) (rmath "sin" (var t)))))`],
  ['asy__pdir', `  (fn asy__pdir ((d real)) ${ASY_PAIR_TY}
    ;; dir(度) = expi(radians(度))，radians 就是 deg*pi/180（照 asy 的源码顺序写，
    ;; 乘除的次序是浮点结果的一部分）。量过 dir(45) 的两个分量是 ...548 / ...547：
    ;; 不对称，正是 cos 与 sin 各自舍入的样子。
    (ret (call asy__pexpi (bin "/" (bin "*" (var d) (real 3.14159265358979311600)) (real 180.0)))))`],
  ['asy__ppowi', `  (fn asy__ppowi ((z ${ASY_PAIR_TY}) (n int)) ${ASY_PAIR_TY}
    ;; pair^**int**：反复平方（低位在前），负指数取倒数。asy 这条重载在整数上是**精确**的
    ;; —— 量过 (1,2)^30 印的是 (-6890111163,29729597084) 一个小数点都没有，而下面那条
    ;; exp/log 的路子给 (-6890111162.99996,…)。84 组 (底,指数) 的扫描里这个形状对上
    ;; 75 组，剩下九组差最后一两位（asy 那边是 libstdc++ 的 __complex_pow_unsigned，
    ;; 复数乘法带 NaN 修补，我们没有）—— 所以用例落在 tol/ 而不是逐字节那一节。
    (let m int (var n))
    (if (bin "<" (var m) (int 0)) (do (set m (un "-" (var m)))))
    (let r ${ASY_PAIR_TY} (vlit ${ASY_PAIR_TY} (real 1.0) (real 0.0)))
    (let x ${ASY_PAIR_TY} (var z))
    (while (bin ">" (var m) (int 0))
      (do
        (if (bin "==" (bin "%" (var m) (int 2)) (int 1)) (do (set r (call asy__pmul (var r) (var x)))))
        (set m (bin "/" (var m) (int 2)))
        (if (bin ">" (var m) (int 0)) (do (set x (call asy__pmul (var x) (var x)))))))
    (if (bin "<" (var n) (int 0))
      (do (ret (call asy__pdiv (vlit ${ASY_PAIR_TY} (real 1.0) (real 0.0)) (var r)))))
    (ret (var r)))`],
  ['asy__ppowz', `  (fn asy__ppowz ((z ${ASY_PAIR_TY}) (w ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; pair^**pair**（real 指数先提成 (v,0)，asy 没有 pair^real 这个重载）= exp(w * log z)，
    ;; log z = (log(abs z), angle z)。三处细节都是量出来的，而且**不是**宿主 cpow：
    ;; - abs 是朴素那一份（asy__pabs），所以 (1e200,1e200)^0.5 是 (nan,nan)；真 cpow
    ;;   走 hypot，给的是 1.09868411346781e+100 那个有限值。
    ;; - w*log z 是**复数**乘法，即使 w 是实数也照乘：(1e-200,1e-200)^0.5 里 abs 下溢成 0、
    ;;   log 给 -inf，虚部那一项是 0*(-inf) = nan —— 量过 asy 也是 (nan,nan)。
    ;; - 零底数要挡在前面：量过 (0,0)^任何非零 是 (0,0)、(0,0)^(0,0) 是 (1,0)。
    ;;   （(0,0)^-1 在 asy 是运行期错误 "division by pair (0,0)"，那条走 int 那个重载，
    ;;   我们照 pair 除法的既有偏差出 IEEE 的 inf/nan，不报错 —— 见文件头那条。）
    (if (bin "&&" (bin "==" (lane (var z) 0) (real 0.0)) (bin "==" (lane (var z) 1) (real 0.0)))
      (do
        (if (bin "&&" (bin "==" (lane (var w) 0) (real 0.0)) (bin "==" (lane (var w) 1) (real 0.0)))
          (do (ret (vlit ${ASY_PAIR_TY} (real 1.0) (real 0.0)))))
        (ret (vlit ${ASY_PAIR_TY} (real 0.0) (real 0.0)))))
    (let l ${ASY_PAIR_TY} (vlit ${ASY_PAIR_TY}
      (rmath "log" (call asy__pabs (var z)))
      (rmath "atan2" (lane (var z) 1) (lane (var z) 0))))
    (let u ${ASY_PAIR_TY} (call asy__pmul (var w) (var l)))
    (let e real (rmath "exp" (lane (var u) 0)))
    (ret (vlit ${ASY_PAIR_TY}
      (bin "*" (var e) (rmath "cos" (lane (var u) 1)))
      (bin "*" (var e) (rmath "sin" (lane (var u) 1))))))`],
  ['asy__pneg', `  (fn asy__pneg ((a ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; 逐分量取负。刻意不写成 (0,0) - a：那样 -0.0 会变成 0.0，而 asy 是 pair(-x,-y)。
    (ret (vlit ${ASY_PAIR_TY} (un "-" (lane (var a) 0)) (un "-" (lane (var a) 1)))))`],
  // ---- triple。全部逐道写死，第 3 道恒为 0（见 ASY_TRIPLE_TY 上方那段）。
  ['asy__tneg', `  (fn asy__tneg ((a ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    (ret (vlit ${ASY_TRIPLE_TY} (un "-" (lane (var a) 0)) (un "-" (lane (var a) 1))
      (un "-" (lane (var a) 2)) (real 0.0))))`],
  ['asy__tsmul', `  (fn asy__tsmul ((a ${ASY_TRIPLE_TY}) (s real)) ${ASY_TRIPLE_TY}
    ;; triple * real 是逐分量的（量过 (1,2,3)*2.5 与 2.5*(1,2,3) 都是 (2.5,5,7.5)）
    (ret (vlit ${ASY_TRIPLE_TY} (bin "*" (lane (var a) 0) (var s)) (bin "*" (lane (var a) 1) (var s))
      (bin "*" (lane (var a) 2) (var s)) (real 0.0))))`],
  ['asy__tsdiv', `  (fn asy__tsdiv ((a ${ASY_TRIPLE_TY}) (s real)) ${ASY_TRIPLE_TY}
    ;; triple / real，同样逐分量（量过 (1,2,3)/2 是 (0.5,1,1.5)）。除以零 asy 是运行期
    ;; 错误 "division by 0"，我们照 pair 那条既有偏差出 IEEE 的 inf/nan。
    (ret (vlit ${ASY_TRIPLE_TY} (bin "/" (lane (var a) 0) (var s)) (bin "/" (lane (var a) 1) (var s))
      (bin "/" (lane (var a) 2) (var s)) (real 0.0))))`],
  ['asy__teq', `  (fn asy__teq ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) bool
    ;; 只比前三道：第 3 道是垫出来的，不参与语义
    (ret (bin "&&" (bin "==" (lane (var a) 0) (lane (var b) 0))
      (bin "&&" (bin "==" (lane (var a) 1) (lane (var b) 1))
        (bin "==" (lane (var a) 2) (lane (var b) 2))))))`],
  ['asy__tabs', `  (fn asy__tabs ((a ${ASY_TRIPLE_TY})) real
    ;; abs = length = 三个分量的平方和开根，**朴素**那一份 ——
    ;; 量过 abs((1e200,1e200,1e200)) 是 inf（所以不是 hypot），跟 pair 一致
    (ret (rmath "sqrt" (bin "+" (bin "+" (bin "*" (lane (var a) 0) (lane (var a) 0))
      (bin "*" (lane (var a) 1) (lane (var a) 1))) (bin "*" (lane (var a) 2) (lane (var a) 2))))))`],
  ['asy__tunit', `  (fn asy__tunit ((a ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    ;; a / abs(a)，逐分量。零点挡一刀（量过 unit((0,0,0)) 是 (0,0,0)）；abs 溢出成 inf 时
    ;; 逐分量除给 (0,0,0) —— 量过 unit((1e200,1e200,1e200)) 正是 (0,0,0)。
    (let r real (call asy__tabs (var a)))
    (if (bin "==" (var r) (real 0.0)) (do (ret (var a))))
    (ret (call asy__tsdiv (var a) (var r))))`],
  ['asy__tdot', `  (fn asy__tdot ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) real
    ;; 量过 dot((1,2,3),(4,5,6)) 是 32、dot((1,2,3),(1,2,3)) 是 14
    (ret (bin "+" (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 0))
      (bin "*" (lane (var a) 1) (lane (var b) 1))) (bin "*" (lane (var a) 2) (lane (var b) 2)))))`],
  ['asy__tcross', `  (fn asy__tcross ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    ;; 右手系（量过 cross((1,2,3),(4,5,6)) 是 (-3,6,-3)）
    (ret (vlit ${ASY_TRIPLE_TY}
      (bin "-" (bin "*" (lane (var a) 1) (lane (var b) 2)) (bin "*" (lane (var a) 2) (lane (var b) 1)))
      (bin "-" (bin "*" (lane (var a) 2) (lane (var b) 0)) (bin "*" (lane (var a) 0) (lane (var b) 2)))
      (bin "-" (bin "*" (lane (var a) 0) (lane (var b) 1)) (bin "*" (lane (var a) 1) (lane (var b) 0)))
      (real 0.0))))`],
  ['asy__trealmult', `  (fn asy__trealmult ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    ;; 逐分量乘。asy 没有 triple*triple，逐分量乘就叫 realmult（量过给 (4,10,18)）
    (ret (vlit ${ASY_TRIPLE_TY} (bin "*" (lane (var a) 0) (lane (var b) 0))
      (bin "*" (lane (var a) 1) (lane (var b) 1)) (bin "*" (lane (var a) 2) (lane (var b) 2)) (real 0.0))))`],
  ['asy__texpi', `  (fn asy__texpi ((t real) (p real)) ${ASY_TRIPLE_TY}
    ;; expi(θ,φ) = (sinθ cosφ, sinθ sinφ, cosθ)（弧度）。判据：expi(0.5,1.0) 印
    ;; (0.259034723999926,0.403422680111335,0.877582561890373) —— 第三道正是 cos(0.5)，
    ;; 前两道正是 sin(0.5) 乘 cos(1.0) / sin(1.0)，逐位对上。
    (let s real (rmath "sin" (var t)))
    (ret (vlit ${ASY_TRIPLE_TY} (bin "*" (var s) (rmath "cos" (var p)))
      (bin "*" (var s) (rmath "sin" (var p))) (rmath "cos" (var t)) (real 0.0))))`],
  ['asy__tdir', `  (fn asy__tdir ((t real) (p real)) ${ASY_TRIPLE_TY}
    ;; dir(θ,φ) 收的是**度**（量过 dir(30,45) 的第三道是 cos(30°)=0.866025403784439）
    (ret (call asy__texpi (bin "/" (bin "*" (var t) (real 3.14159265358979311600)) (real 180.0))
      (bin "/" (bin "*" (var p) (real 3.14159265358979311600)) (real 180.0)))))`],
  ['asy__peq', `  (fn asy__peq ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) bool
    ;; 向量上没有比较（掩码类型这一刀没有），所以逐道比。写成函数而不是内联展开：
    ;; 内联要把两边的代码各印两遍，f() == g() 就会把 f 和 g 各调两次。
    (ret (bin "&&" (bin "==" (lane (var a) 0) (lane (var b) 0)) (bin "==" (lane (var a) 1) (lane (var b) 1)))))`],
  ['asy__pairstr', `  (fn asy__pairstr ((a ${ASY_PAIR_TY})) string
    ;; write(pair) 的格式：两个分量各 %.15g，夹在圆括号里，中间一个逗号、没有空格
    ;; （量过：(0.333333333333333,0.666666666666667)、(1e+20,1e-05)、(-0,0)）
    (ret (bin "+" (str "(") (bin "+" (tostr (lane (var a) 0) (int 15))
      (bin "+" (str ",") (bin "+" (tostr (lane (var a) 1) (int 15)) (str ")")))))))`],
  ['asy__triplestr', `  (fn asy__triplestr ((a ${ASY_TRIPLE_TY})) string
    ;; write(triple) 与 pair 同一个形状，三个分量（量过：(1,2,3)、(0.5,1,1.5)、(-3,6,-3)）。
    ;; 第 3 道是垫出来的，这里**不印** —— 那一道不参与语义（见 ASY_TRIPLE_TY）。
    (ret (bin "+" (str "(") (bin "+" (tostr (lane (var a) 0) (int 15))
      (bin "+" (str ",") (bin "+" (tostr (lane (var a) 1) (int 15))
        (bin "+" (str ",") (bin "+" (tostr (lane (var a) 2) (int 15)) (str ")")))))))))`],
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
  ['asy__sins', `  (fn asy__sins ((s string) (i int) (t string)) string
    ;; 量过：insert("abc",1,"XY") 是 "aXYbc"、insert("abc",2,"XY") 是 "abXYc"。
    ;; 越界**什么都不做**（不是追加）：insert("abc",3,"X")、insert("abc",5,"X")、
    ;; insert("abc",-1,"X") 与 insert("",0,"X") 全是原串。这条是这一刀补的测量 ——
    ;; 之前 insert 在门外的理由就是"越界行为没量全"。
    (if (bin "<" (var i) (int 0)) (do (ret (var s))))
    (if (bin ">=" (var i) (slen (var s))) (do (ret (var s))))
    (ret (bin "+" (call asy__ssub (var s) (int 0) (var i))
      (bin "+" (var t) (call asy__ssubto (var s) (var i))))))`],
  ['asy__ssplit', `  (fn asy__ssplit ((s string) (d string)) (arr string)
    ;; 量出来的四条：
    ;;   普通分隔符：不重叠，**保留空字段** —— split("a,,b",",") 是三个元素、
    ;;     split(",a,",",") 也是三个（两头各一个空串）、split("abc","abc") 是两个空串
    ;;   找不到 / 空串：整串一个元素（split("",",") 的长度是 1）
    ;;   分隔符是**空串**：按空格切，并且丢掉空字段 —— split("  a  b  ","") 是 [a,b]，
    ;;     而 split("a,b,c","") 是整串一个元素。只有**空格**算分隔：量过
    ;;     split('a\\tb','') 的长度是 1，制表符与换行都不算。
    (let r (arr string) (anew (arr string) (int 0)))
    (if (bin "==" (var d) (str ""))
      (do
        (let cur string (str ""))
        (let i int (int 0))
        (while (bin "<" (var i) (slen (var s)))
          (do
            (if (bin "==" (ssub (var s) (var i) (int 1)) (str " "))
              (do
                (if (bin "!=" (var cur) (str ""))
                  (do (apush (var r) (var cur)) (set cur (str "")))))
              (do (set cur (bin "+" (var cur) (ssub (var s) (var i) (int 1))))))
            (set i (bin "+" (var i) (int 1)))))
        (if (bin "!=" (var cur) (str "")) (do (apush (var r) (var cur))))
        (ret (var r))))
    (let start int (int 0))
    (let p int (call asy__sfindp (var s) (var d) (int 0)))
    (while (bin ">=" (var p) (int 0))
      (do
        (apush (var r) (call asy__ssub (var s) (var start) (bin "-" (var p) (var start))))
        (set start (bin "+" (var p) (slen (var d))))
        (set p (call asy__sfindp (var s) (var d) (var start)))))
    (apush (var r) (call asy__ssubto (var s) (var start)))
    (ret (var r)))`],
]);

/**
 * 数组三条 helper 的正文（扩长 / 切片 / `a[i:]`），按元素类型生成。
 * 标量与 pair 那五份在下面的循环里一次生好（模块级静态文本）；**记录元素**是逐类型的，
 * 由 AsyLower.arrHelper 用同一个工厂生成 —— 正文只有元素类型与"扩长填什么"两处不同，
 * 所以这里是一个函数而不是两份抄写。
 *
 * 扩长：asy 量过 `int[] e; e[2]=5;` 之后 `e.length` 是 **3**（= 下标+1），中间那些格子在
 * asy 那边是"未初始化"、读会报错；我们填零值（记录元素填 `(cnew T)`，因为方言里写不出
 * 空引用），这条差别写在文件头。
 * 切片：量过的三条 —— 半开区间、**是复制不是视图**（`b=a[0:2]; b[0]=99;` 之后 a[0] 不变，
 * 但元素是记录时"复制"复制的是句柄，所以格子里还是同一批对象，量过 asy 也是这样）、
 * 右边界超长截到末尾。左边界不 clamp、`a[3:1]` 给空数组，两条差别都在文件头。
 * `a[i:]` 单独一条而不是在调用处写 `(alen …)`：那样接收者的代码要印两遍，`f()[1:]` 会把
 * f 调两次。
 */
export function asyArrHelpers(name, et, zero) {
  return [
    [`asy__grow_${name}`, `  (fn asy__grow_${name} ((a (arr ${et})) (i int)) void
    (while (bin "<=" (alen (var a)) (var i))
      (do (apush (var a) ${zero}))))`],
    [`asy__slice_${name}`, `  (fn asy__slice_${name} ((a (arr ${et})) (i int) (j int)) (arr ${et})
    (let r (arr ${et}) (anew (arr ${et}) (int 0)))
    (let k int (var i))
    (let e int (var j))
    (if (bin ">" (var e) (alen (var a))) (do (set e (alen (var a)))))
    (while (bin "<" (var k) (var e))
      (do
        (apush (var r) (aget (var a) (var k)))
        (set k (bin "+" (var k) (int 1)))))
    (ret (var r)))`],
    [`asy__slicefrom_${name}`, `  (fn asy__slicefrom_${name} ((a (arr ${et})) (i int)) (arr ${et})
    (ret (call asy__slice_${name} (var a) (var i) (alen (var a)))))`],
  ];
}

// 这里刻意不用解构（`for (const [a, b] of …)`）：封闭子集里那不是保证能降级的写法。
for (const t of ['int', 'real', 'bool', 'string', 'pair', 'triple']) {
  for (const pair of asyArrHelpers(t, asyCore(t), ZERO.get(t))) HELPERS.set(pair[0], pair[1]);
}
