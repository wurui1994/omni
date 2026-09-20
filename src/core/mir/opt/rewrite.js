/**
 * opt —— Go 的 `applyRewrite(f, rewriteBlockgeneric, rewriteValuegeneric)` 那一格
 * （`ssa/rewrite.go` + `_gen/generic.rules`）。常量折叠 + 代数化简。
 *
 * 两条纪律，都是照 Go 抄的：
 *
 * 1. **通道表里这一格只跑一遍，但这一格自己迭代到不动点** —— Go 的 `applyRewrite` 就是
 *    `for { changed := false; ...; if !changed { break } }`。"不迭代"说的是**通道之间**，
 *    不是一条规则集内部。我们这儿每条指令最多改一次（改过的记在 `done` 里），所以
 *    轮数天然有界。
 *
 * 2. **规则一条一条从 `generic.rules` 抄，每条注明行号**。不自己想规则 —— 想出来的规则
 *    要么是错的（`x+0.0 => x` 在 x = -0.0 上不成立），要么是别人早写过的。
 *
 * 这一版的规则有三种形状：**折成一个常量**、**换成一个已有的 ref**、
 * **就地把 op 换掉**（强度削减那一族，回 `IN_PLACE`）。前两种只改"谁引用谁"
 * （`replaceRef`），第三种只改这一条自己的 op 与操作数 —— 三种都不新增指令、
 * 不动控制流，被换掉的那条由紧跟的 `opt deadcode` 收走。
 *
 * `Not(Less x y) => Leq y x` 那一族（generic.rules:397-403）走的也是第三种：
 * **改写 `Not` 自己那一条**，不碰内层那条比较 —— 于是既不新增指令、也不必数使用次数。
 */

import {
  OP, OP_MODES, REF_BIAS, REF_NONE, T_BOOL, T_F32, CVT_BITCAST,
  isCmp, isIntType, isFloatType, intBits, typeLanes, negCmp,
} from '../ir.js';
import { replaceRef } from './edit.js';
import { buildCfg } from './cfg.js';
import { mayWriteMemory, sameCell, cellOf, disjoint, sameSpot } from './memory.js';
import { forwardCopiedLoads } from './copyfwd.js';
import { registerPass } from './pass.js';

/** 取一个 ref 的常量池条目；不是常量、或者压根不是 ref（角色 'n'/'s'/'j'）回 null。
 *
 * ⚠️ **必须按角色问**：`CALL` 的 a 是函数表下标、`BR` 的 aux 是层数 —— 都是小整数，
 * 拿去查常量池会查到一条**别人的常量**（或者 undefined）。第一版没按角色问，
 * `omni c run` 上当场炸在 `c.kind`（fib 那个例子里 a 是函数号 3）。 */
function constOf(mod, ref) {
  if (ref === REF_NONE || ref >= REF_BIAS) return null;
  const c = mod.consts.items[ref];
  return c === undefined ? null : c;
}
/** 角色是 'r' 的那一格才当 ref 读。 */
function constArg(fn, mod, pc, which) {
  const m = OP_MODES[fn.op[pc]];
  if (m[which] !== 'r') return null;
  return constOf(mod, which === 0 ? fn.a[pc] : fn.b[pc]);
}
function intOf(c) { return c !== null && c.kind === 'int' ? BigInt(c.text) : null; }
function realOf(c) {
  if (c === null || c.kind !== 'real') return null;
  if (c.text === 'inf' || c.text === '-inf' || c.text === 'nan') return null;  // 非有限的不折
  return Number(c.text);
}
function boolOf(c) { return c !== null && c.kind === 'bool' ? c.text === 'true' : null; }

/**
 * `rewriteValue` 的第三种回值：**这条指令已经就地改过了**（op 换了、操作数换了），
 * 没有"换成哪个 ref"这回事 —— 引用它的人照旧引用它。
 *
 * 只有强度削减那一族（`Mul x 2^k => Lsh x k`）用它。与 `-1`（不动）和
 * 一个真 ref（换成别人）三态互斥。
 */
const IN_PLACE = -2;

/** 整数的规范形：i32 符号扩展到 32 位，i64 到 64 位（见 ir.js 的 T_I32）。 */
function wrapInt(v, bits) { return bits === 32 ? BigInt.asIntN(32, v) : BigInt.asIntN(64, v); }
/** 同一个值的无符号读法（USHR/UDIV/ULT 那一族要它）。 */
function asUint(v, bits) { return bits === 32 ? BigInt.asUintN(32, v) : BigInt.asUintN(64, v); }

function mkInt(mod, t, v) { return mod.consts.intern(t, 'int', String(wrapInt(v, intBits(t)))); }
function mkBool(mod, v) { return mod.consts.bool(v); }
/** 浮点常量：f32 先 fround（见 ir.js 的 T_F32）。非有限的一律不折，回 -1。
 *
 * **负零要特判**：`String(-0)` 是 `"0"`，直接用它会把 `-0.0` 折成 `0.0` ——
 * `tests/c/gen/15-float.c` 上量到过（`-0.000000` 印成了 `0.000000`）。 */
function mkReal(mod, t, x) {
  const v = t === T_F32 ? Math.fround(x) : x;
  if (!Number.isFinite(v)) return -1;
  const text = Object.is(v, -0) ? '-0' : String(v);
  return mod.consts.intern(t, 'real', text);
}

/** 标量（不是向量）的整数/浮点类型 —— 折叠只在这两类上做。 */
function scalarInt(t) { return typeLanes(t) === 1 && isIntType(t); }
function scalarFloat(t) { return typeLanes(t) === 1 && isFloatType(t); }

/**
 * 两个整数常量的折叠。回 BigInt（还没规范化）或 null（这一条不折）。
 *
 * 照 `generic.rules`：`:140 (Add64 (Const64 [c]) (Const64 [d])) => (Const64 [c+d])`
 * 那一族；除法那两条带 `&& d != 0`（`:201`、`:244`）。
 * 移位只在 `0 <= d < 位宽` 折：超出位宽在 C 里是未定义行为，我们不替语言做决定。
 */
function foldIntBin(op, bits, x, y) {
  if (op === OP.ADD) return x + y;                                   // :140
  if (op === OP.SUB) return x - y;                                   // :149
  if (op === OP.MUL) return x * y;                                   // :156
  if (op === OP.BAND) return x & y;                                  // :175
  if (op === OP.BOR) return x | y;                                   // :181
  if (op === OP.BXOR) return x ^ y;                                  // :186
  if (op === OP.DIV || op === OP.MOD) {                              // :201 / :244
    if (y === 0n) return null;
    /* 最小负数 / -1 在 C 里是未定义行为（x86 上会发 #DE），不折。 */
    const min = bits === 32 ? -2147483648n : -(2n ** 63n);
    if (x === min && y === -1n) return null;
    return op === OP.DIV ? x / y : x % y;
  }
  if (op === OP.SHL || op === OP.SHR) {                               // :251 / :252
    if (y < 0n || y >= BigInt(bits)) return null;
    return op === OP.SHL ? x << y : x >> y;
  }
  /* 无符号那几条（ADR-0016 第六十一刀的 op）：按无符号读法算，再回规范形。 */
  if (op === OP.UDIV || op === OP.UMOD) {
    if (y === 0n) return null;
    const ux = asUint(x, bits), uy = asUint(y, bits);
    return op === OP.UDIV ? ux / uy : ux % uy;
  }
  if (op === OP.USHR) {
    if (y < 0n || y >= BigInt(bits)) return null;
    return asUint(x, bits) >> y;
  }
  return null;
}

/** 两个浮点常量的折叠。回 number 或 null。`generic.rules:142/151/158/207`。 */
function foldFloatBin(op, x, y) {
  if (op === OP.ADD) return x + y;
  if (op === OP.SUB) return x - y;
  if (op === OP.MUL) return x * y;
  if (op === OP.DIV) return x / y;   // 0 除在 IEEE 里有定义（inf/nan），mkReal 会挡住非有限的
  return null;
}

/** 比较的折叠。`x`/`y` 是同类的宿主值；回 boolean 或 null。`generic.rules:900..945` 那一段。 */
function foldCmp(op, x, y) {
  if (op === OP.EQ) return x === y;
  if (op === OP.NE) return x !== y;
  if (op === OP.LT || op === OP.ULT) return x < y;
  if (op === OP.LE || op === OP.ULE) return x <= y;
  if (op === OP.GT || op === OP.UGT) return x > y;
  if (op === OP.GE || op === OP.UGE) return x >= y;
  return null;
}

/**
 * 一条指令的重写。回「换成哪个 ref」，或 -1（这条不动）。
 */
function rewriteValue(fn, mod, pc) {
  const op = fn.op[pc];
  const t = fn.t[pc];
  const A = fn.a[pc], B = fn.b[pc];
  const ca = constArg(fn, mod, pc, 0), cb = constArg(fn, mod, pc, 1);

  /**
   * ---------------------------------------------------- 零、两次按位重解释互相抵消
   *
   * `CVT_BITCAST(CVT_BITCAST(x))` ⇒ `x`。与 `(Com (Com x)) => x`（generic.rules:689）
   * 同一类恒等式。要这一条是因为 `copyfwd.js` 把「按字拷贝的聚合」那条链一档一档转发成了
   * 一串 `CVT_BITCAST`，两两抵消之后剩下的才是最初那个寄存器里的值。
   *
   * 判据：里层那条的**操作数类型**得与我们的结果类型一样（宽度一样、读法一样）。
   *
   * ⚠️ **必须摆在类型分派之前**。放在后面（`scalarFloat(t)` 那一块里）等于永远不跑：
   * 那一块末尾一律 `return -1`，`t` 是 f64 的 CVT 压根到不了后面。
   * 这个位置是量出来的：放错地方时 `sph_intersect` 里每个 `vsub` 的结果都要
   *     fmov x9,d10 / mov x21,x9 … mov x9,x21 / mov x8,x9 / fmov d8,x8
   * 六条指令把一个 double 从 d10 搬到 d8。
   */
  if (op === OP.CVT && fn.aux[pc] === CVT_BITCAST && A >= REF_BIAS && A !== REF_NONE) {
    const ip = A - REF_BIAS;
    if (fn.op[ip] === OP.CVT && fn.aux[ip] === CVT_BITCAST) {
      const inner = fn.a[ip];
      if (inner !== REF_NONE && fn.typeOf(inner, mod.consts) === t) return inner;
    }
  }

  /* ---------------------------------------------------------- 一、常量折叠 */
  if (isCmp(op)) {
    /* 比较的 `t` 是**操作数**的类型（ir.js 的 typeOf 那段），结果永远是 bool。 */
    if (scalarInt(t)) {
      const x = intOf(ca), y = intOf(cb);
      if (x !== null && y !== null) {
        const bits = intBits(t);
        const unsigned = op >= OP.ULT && op <= OP.UGT;
        const r = unsigned ? foldCmp(op, asUint(x, bits), asUint(y, bits)) : foldCmp(op, x, y);
        if (r !== null) return mkBool(mod, r);
      }
    } else if (scalarFloat(t)) {
      const x = realOf(ca), y = realOf(cb);
      if (x !== null && y !== null) {
        const r = foldCmp(op, x, y);
        if (r !== null) return mkBool(mod, r);
      }
    } else if (t === T_BOOL) {
      const x = boolOf(ca), y = boolOf(cb);
      if (x !== null && y !== null) {
        const r = foldCmp(op, x, y);
        if (r !== null) return mkBool(mod, r);
      }
      /* `(EqB (ConstBool [true]) x) => x`、`(NeqB (ConstBool [false]) x) => x`
         —— generic.rules:309 / :314（交换律，两边都试）。 */
      if (op === OP.EQ) {
        if (x === true) return B;
        if (y === true) return A;
      }
      if (op === OP.NE) {
        if (x === false) return B;
        if (y === false) return A;
      }
    }
    return -1;
  }

  if (scalarInt(t)) {
    const bits = intBits(t);
    const x = intOf(ca), y = intOf(cb);
    if (x !== null && y !== null) {
      const r = foldIntBin(op, bits, x, y);
      if (r !== null) return mkInt(mod, t, r);
    }
    if (op === OP.NEG && x !== null) return mkInt(mod, t, -x);          // :133
    if (op === OP.BNOT && x !== null) return mkInt(mod, t, ~x);         // :690

    /* `Mul(32|64) <t> x (Const ... [c]) && IsPowerOfTwo(c) && pass != "opt"`
     *  => `Lsh(32|64)x64 <t> x (Const64 [log(c)])` —— generic.rules:1149-1156。
     * Go 把这一族挡在 `opt` 之外、只在 `middle opt` 与 `late opt` 里跑 ——
     * 因为 `opt` 那一轮之后还有 CSE，而 `MUL x 128` 跟 `MUL y 128` 能共享常量，
     * 换成 `SHL x 7` 跟 `SHL y 7` 之后不亏也不赚。
     * 我们照同一条纪律：`opt` 那一轮传进来的是 `fn`，`middle opt`/`late opt` 也是
     * `fn` —— 区分它们靠 `registerPass` 的名字。
     * 但 `rewriteValue` 一份代码跑三遍没有 pass 名字这个上下文 ——
     * 而这一族在 `middle opt`/`late opt` 里跑也完全正确（只是 `opt` 里不跑），
     * 所以**直接放在这里**：效果等同于三遍都跑，不比 Go 少一格。
     *
     * 这一条在 radiance 里量得到：`MUL x 128` 那条是 Vec 内存布局决定的数组下标，
     * 换成 `SHL x 7` 省一条整数乘（arm64 上 `mul` 3-5 周期、`lsl` 1 周期）。 */
    if (op === OP.MUL && y !== null && y > 1n && (y & (y - 1n)) === 0n) {
      /* y 是 2 的幂：MUL x, 2^k  =>  SHL x, k。乘 1 让 `intIdentity` 去消。 */
      const k = BigInt(y.toString(2).length - 1);
      fn.op[pc] = OP.SHL;
      fn.b[pc] = mod.consts.intern(t, 'int', String(k));
      return IN_PLACE;
    }
    if (op === OP.MUL && x !== null && x > 1n && (x & (x - 1n)) === 0n) {
      const k = BigInt(x.toString(2).length - 1);
      fn.op[pc] = OP.SHL;
      fn.a[pc] = B;
      fn.b[pc] = mod.consts.intern(t, 'int', String(k));
      return IN_PLACE;
    }

    const r = intIdentity(fn, mod, pc, op, t, A, B, x, y);
    if (r !== -1) return r;
    return -1;
  }

  if (scalarFloat(t)) {
    const x = realOf(ca), y = realOf(cb);
    if (x !== null && y !== null) {
      const r = foldFloatBin(op, x, y);
      if (r !== null) {
        const k = mkReal(mod, t, r);
        if (k >= 0) return k;
      }
    }
    if (op === OP.NEG && x !== null) {
      const k = mkReal(mod, t, -x);
      if (k >= 0) return k;
    }
    /* `(Mul(32|64)F x (Const(32|64)F [1])) => x` —— generic.rules:1370。
       **只有乘 1 这一条**：`x + 0.0` 在 x = -0.0 上不成立，Go 也没有那条规则。 */
    if (op === OP.MUL) {
      if (y === 1) return A;
      if (x === 1) return B;
    }
    return -1;
  }

  /* `(Not (ConstBool [c])) => (ConstBool [!c])` —— generic.rules:210 */
  if (op === OP.NOT) {
    const x = boolOf(ca);
    if (x !== null) return mkBool(mod, !x);
    /* `(Not (Not x)) => x`：Go 那边这一条是靠 `Com(Com x)`（:689）与
       `Not` 折进比较（:430-436）两族覆盖的，我们只留这一条同形的。 */
    if (A >= REF_BIAS && A !== REF_NONE && fn.op[A - REF_BIAS] === OP.NOT) return fn.a[A - REF_BIAS];
    /**
     * `(Not (Less x y)) => (Leq y x)` 那一族 —— generic.rules:397-403。
     *
     * 我们的比较是**连号成对**的（`negCmp` = `op ^ 1`，见 ir.js 那张表），所以不必换
     * 操作数次序：`!(a < b)` 就是 `a >= b`。就地把这一条 `NOT` 改写成取反的比较，
     * 原来那条比较没人用了自然由 deadcode 收走 —— 于是**不必数使用次数**
     * （文件头上原先说这一族"要改内层指令并数使用次数"，改写自己这一条就绕开了）。
     *
     * **浮点只收 EQ/NE**：Go 的 :397/:398 收了 `64F`/`32F`，而 :400-403 那四条
     * 只列整数宽度 —— 有 NaN 时 `!(a < b)` 不等于 `a >= b`（两边都假）。
     *
     * 量出来的账（`bench/go/loop.go` 的内层循环，arm64）：原先
     *     cmp x21,x10 / cset x22,lt / eor x23,x22,#1 / cbnz x23,出口
     * 那条 `eor` 就是这一格 NOT。
     */
    if (A >= REF_BIAS && A !== REF_NONE) {
      const ip = A - REF_BIAS;
      const cop = fn.op[ip];
      const ct = fn.t[ip];
      const eqne = cop === OP.EQ || cop === OP.NE;
      if (isCmp(cop) && (eqne || !scalarFloat(ct))) {
        fn.op[pc] = negCmp(cop);
        fn.a[pc] = fn.a[ip];
        fn.b[pc] = fn.b[ip];
        fn.t[pc] = ct;
        fn.aux[pc] = fn.aux[ip];
        return IN_PLACE;
      }
    }
    return -1;
  }

  return -1;
}

/** 整数的代数化简。回 ref 或 -1。**每条都注了 `generic.rules` 的行号。**
 *  交换律的 op（ADD/MUL/BAND/BOR/BXOR）两种次序都试 —— Go 的 rulegen 对
 *  `commutative` 的 op 会自动展开两种匹配，所以它的规则里只写一种。
 *  我们**不改操作数的次序**：改次序会动到后端发出来的形状，而这一格的纪律是只改引用。 */
function intIdentity(fn, mod, pc, op, t, A, B, x, y) {
  const zero = 0n, one = 1n, neg1 = -1n;

  if (op === OP.ADD) {
    if (y === zero) return A;                                          // :684
    if (x === zero) return B;                                          // :684（换个次序）
  }
  if (op === OP.MUL) {
    if (y === one) return A;                                           // :218
    if (x === one) return B;                                           // :218
    if (y === zero || x === zero) return mkInt(mod, t, zero);          // :686
  }
  if (op === OP.BOR) {
    if (y === zero) return A;                                          // :667
    if (x === zero) return B;                                          // :667
    if (y === neg1 || x === neg1) return mkInt(mod, t, neg1);          // :668
    if (A === B) return A;                                             // :666
  }
  if (op === OP.BAND) {
    if (y === neg1) return A;                                          // :674
    if (x === neg1) return B;                                          // :674
    if (y === zero || x === zero) return mkInt(mod, t, zero);          // :675
    if (A === B) return A;                                             // :673
  }
  if (op === OP.BXOR) {
    if (y === zero) return A;                                          // :681
    if (x === zero) return B;                                          // :681
    if (A === B) return mkInt(mod, t, zero);                           // :680
  }
  if (op === OP.SUB) {
    if (A === B) return mkInt(mod, t, zero);                           // :685
    if (y === zero) return A;                                          // 与 :684 对称（x-0）
    /* `(Sub64 (Add64 x y) y) => x` —— :816。加法有交换律，所以两个实参都要比。 */
    if (A >= REF_BIAS && A !== REF_NONE) {
      const d = A - REF_BIAS;
      if (fn.op[d] === OP.ADD && fn.t[d] === t) {
        if (fn.b[d] === B) return fn.a[d];
        if (fn.a[d] === B) return fn.b[d];
      }
    }
  }
  if (op === OP.SHL || op === OP.SHR || op === OP.USHR) {
    if (y === zero) return A;                                          // :505 / :506 / :507
  }
  if (op === OP.NEG && A >= REF_BIAS && A !== REF_NONE) {
    if (fn.op[A - REF_BIAS] === OP.NEG) return fn.a[A - REF_BIAS];      // :720
  }
  if (op === OP.BNOT && A >= REF_BIAS && A !== REF_NONE) {
    if (fn.op[A - REF_BIAS] === OP.BNOT) return fn.a[A - REF_BIAS];     // :689
  }
  return -1;
}

/**
 * 存储转发：`MLOAD p (… MSTORE p x …)` ⇒ `x`。
 * 照 `generic.rules:839`「Load of store of same address, with compatibly typed value
 * and same size」那一族（它靠内存 SSA 链往回看，最多穿四条 store，每条要
 * `Disjoint`）。我们没有那条链，所以**块内往回走**，一遇到证不了的就停：
 *
 *   - 同一个地址 ref + `sameCell`（同偏移、同字节数、全宽访问）⇒ 换成那条 store 的值
 *   - **一定不相交**的 `MSTORE`（同基址、两个常量偏移的区间不叠，见 `memory.js` 的
 *     `disjoint`）⇒ 接着往前找。`t[0]=x; t[1]=y; … t[0]` 这一族靠它才转发得了
 *   - 相交或者证不了 ⇒ **停**
 *   - 任何可能写内存的指令（调用、syscall、PSTORE…）⇒ 停
 *   - 读内存的指令（别的 MLOAD）不打断 —— 读不改值
 *
 * 这是 C 那条腿上最值钱的一格：取过地址的局部量（数组、struct）每次读写都是
 * 一条 MLOAD/MSTORE，转发之后它们变回普通的值。
 */
function forwardLoads(fn, mod) {
  const cfg = buildCfg(fn);
  if (cfg.blocks.length === 0) return 0;
  let n = 0;
  for (const bb of cfg.blocks) {
    for (let pc = bb.from; pc <= bb.to; pc++) {
      if (fn.op[pc] !== OP.MLOAD) continue;
      const v = lookBackStore(fn, mod, bb.from, pc);
      if (v < 0) continue;
      /* 换成那条 store 的值。MLOAD 本身留着（没人引用了，紧跟的 deadcode 会删）。
         值的可见性不用另外问：那条 store 与这条 load 在同一个块里，而块整个落在
         同一层区域里，所以 store 的值在这儿一定看得见。

         **只数真换掉的那几处**（`replaceRef` 回的就是这个数）。从前是无条件 `n++`：
         MLOAD 留在数组里，下一轮 `lookBackStore` 又找到同一条 store、又"转发"一次 ——
         这一次一处都没换，可 `n` 还是加一，于是 `opt` 里那个不动点循环**永远数不到 0**，
         每次都把 `fn.op.length + 1` 轮跑满。量出来的：sp.c 上 66 次 `opt` 共跑了
         **7345 轮**、3251ms（整条管线 3412ms 的 95%），而逐条重写那一半只要 6ms。 */
      const k = replaceRef(fn, REF_BIAS + pc, v);
      if (k > 0) n++;
    }
  }
  return n;
}

/** 往回找"写同一处"的那条 MSTORE 的值 ref；找不到/证不了回 -1。 */
function lookBackStore(fn, mod, from, pcLoad) {
  const want = cellOf(fn, mod, pcLoad, true);
  for (let pc = pcLoad - 1; pc >= from; pc--) {
    const op = fn.op[pc];
    if (op === OP.MSTORE) {
      const got = cellOf(fn, mod, pc, false);
      if (sameSpot(want, got)) {
        /* 同一个格子：还要问"读回来就是写进去那个值"吗（窄访问不行，见 sameCell）。 */
        return sameCell(fn, pcLoad, pc) ? fn.b[pc] : -1;
      }
      if (disjoint(want, got)) continue;   // 一定不相交（Go 的 Disjoint）⇒ 接着往前找
      return -1;                           // 证不了 ⇒ 停
    }
    if (mayWriteMemory(op)) return -1;
  }
  return -1;
}

/* `OMNI_OPT_STAT=1` 的账本：这一格的时间花在"逐条重写"还是"存储转发"上。 */
export const OPT_STAT = {
  calls: 0, insns: 0,
  rewriteMs: 0, rewriteRounds: 0,
  fwdMs: 0, fwdRounds: 0, loadsMs: 0, copyMs: 0,
};

/**
 * 跑 opt。回改了几条指令。
 *
 * 迭代到不动点（Go 的 `applyRewrite` 同形），但**每条指令最多改一次** ——
 * 改过的记在 `done` 里，于是轮数有界（最多 = 指令条数），不会来回抖。
 */
export function opt(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  const stat = process.env.OMNI_OPT_STAT === '1' ? OPT_STAT : null;
  const done = new Set();
  let total = 0;
  let t0 = stat === null ? 0 : performance.now();
  let rounds = 0;
  for (let round = 0; round < fn.op.length + 1; round++) {
    rounds++;
    let changed = 0;
    for (let pc = 0; pc < fn.op.length; pc++) {
      if (done.has(pc)) continue;
      const to = rewriteValue(fn, mod, pc);
      if (to === -1) continue;
      /* 就地改过的（强度削减那一族）：没人要换引用，记一笔就完。 */
      if (to === IN_PLACE) { done.add(pc); changed++; continue; }
      const self = REF_BIAS + pc;
      if (to === self) continue;
      done.add(pc);
      replaceRef(fn, self, to);
      changed++;
    }
    if (changed === 0) break;
    total += changed;
  }
  if (stat !== null) { stat.rewriteMs += performance.now() - t0; stat.rewriteRounds += rounds; }
  /* 存储转发放在逐条重写**之后**：转发出来的值还要再被折一遍常量
     （`MSTORE p k1; MLOAD p` -> k1，然后 `ADD k1 k2` 才折得掉），所以再跑一轮重写。
     **转发自己也要迭代到不动点**（Go 的 `applyRewrite` 就是整套规则一起迭代）：
     一条拷贝链是一档一档往上转的，`A<-B<-C` 要走两轮才到头。
     量出来的：`sph_intersect` 上第一轮改 13 处、第二轮还能改 8 处。 */
  let fwd = 0;
  t0 = stat === null ? 0 : performance.now();
  let fr = 0, fl = 0, fc = 0;
  for (let round = 0; round < fn.op.length + 1; round++) {
    fr++;
    let ta = stat === null ? 0 : performance.now();
    const k1 = forwardLoads(fn, mod);
    if (stat !== null) { fl += performance.now() - ta; ta = performance.now(); }
    const k2 = forwardCopiedLoads(fn, mod);
    if (stat !== null) fc += performance.now() - ta;
    const k = k1 + k2;
    if (k === 0) break;
    fwd += k;
  }
  if (stat !== null) {
    stat.fwdMs += performance.now() - t0; stat.fwdRounds += fr;
    stat.loadsMs += fl; stat.copyMs += fc; stat.calls++;
    stat.insns += fn.op.length;
  }
  if (fwd > 0) {
    total += fwd;
    for (let pc = 0; pc < fn.op.length; pc++) {
      if (done.has(pc)) continue;
      const to = rewriteValue(fn, mod, pc);
      if (to === -1) continue;
      if (to === IN_PLACE) { done.add(pc); total++; continue; }
      const self = REF_BIAS + pc;
      if (to === self) continue;
      done.add(pc);
      replaceRef(fn, self, to);
      total++;
    }
  }
  return total;
}

/* 通道表里 `opt` / `middle opt` / `late opt` 是同一套规则跑三遍（Go 也是同一个
 * `rewriteValuegeneric`，差别在它前后有哪些格子跑过）。 */
registerPass('opt', opt);
registerPass('middle opt', opt);
registerPass('late opt', opt);
