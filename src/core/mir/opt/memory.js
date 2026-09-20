/**
 * 线性内存那一片的两个问句 —— `dse` 与 `opt` 的读写转发都要它，所以收在一处。
 *
 * MIR 里"内存"分三个互不相干的空间，这一格只管**线性内存**（`MLOAD`/`MSTORE`）：
 *   - 槽位（`LOAD`/`STORE`，角色 's'）：没有任何 op 能取它的地址，连调用都读不到
 *   - 模块级的"一格"（`GLOAD`/`GSTORE`）：wasm 的 `(global …)`，也不在线性内存上
 *   - **按地址读写**（`MLOAD`/`MSTORE`）：原生腿上地址就是真地址（局部量那一块是 `FRAME`、
 *     全局量是 `GADDR`）；线性内存与那个 `$sp` 影子栈是 **wasm/js/解释器**那几条腿的事
 * 所以 `STORE`/`GSTORE` 既不读也不写线性内存 —— 这不是偷懒，是 ir.js 里那三条 op 的定义。
 *
 * 两个白名单的方向都是**保守**的：名单之外一律算"会读/会写"。加一条新 op 而忘了登记，
 * 后果是少优化一点，不会错。
 */

import {
  OP, OP_NAMES, REF_BIAS, REF_NONE,
  MLOAD_BYTES, MSTORE_BYTES, MLOAD_KINDS, MSTORE_KINDS, memKindNo, memOff,
} from '../ir.js';

/** 一定不读线性内存的那些 op（Go 的 `deadstore.go:56`："These ops never read from
 *  their memory input" 是同一件事）。 */
const NO_READ_NAMES = [
  'BLOCK', 'LOOP', 'IF', 'ELSE', 'END', 'BR', 'BRIF', 'BRTABLE', 'RET',
  'LOAD', 'STORE', 'GLOAD', 'GSTORE',
  'MSTORE', 'PSTORE',
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG', 'SHL', 'SHR', 'BAND', 'BOR', 'BXOR', 'BNOT', 'NOT',
  'EQ', 'NE', 'LT', 'GE', 'LE', 'GT', 'ULT', 'UGE', 'ULE', 'UGT',
  'UDIV', 'UMOD', 'USHR', 'CVT', 'PEQ', 'PISNULL', 'PTHIN', 'PADD', 'PSUB', 'PNULL',
  'FRAME', 'GADDR', 'FADDR', 'MSIZE', 'SPGET', 'FPGET',
  'VSPLAT', 'VINS', 'VEXT',
];

/** 一定不写线性内存的那些 op。与上面那张差在：`MLOAD` 只读不写、`MSTORE`/`PSTORE` 会写。 */
const NO_WRITE_NAMES = [
  'BLOCK', 'LOOP', 'IF', 'ELSE', 'END', 'BR', 'BRIF', 'BRTABLE', 'RET',
  'LOAD', 'STORE', 'GLOAD', 'GSTORE',
  'MLOAD', 'PLOAD',
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG', 'SHL', 'SHR', 'BAND', 'BOR', 'BXOR', 'BNOT', 'NOT',
  'EQ', 'NE', 'LT', 'GE', 'LE', 'GT', 'ULT', 'UGE', 'ULE', 'UGT',
  'UDIV', 'UMOD', 'USHR', 'CVT', 'PEQ', 'PISNULL', 'PTHIN', 'PADD', 'PSUB', 'PNULL',
  'FRAME', 'GADDR', 'FADDR', 'MSIZE', 'SPGET', 'FPGET',
  'VSPLAT', 'VINS', 'VEXT',
];

function setOf(names, who) {
  const s = new Set();
  for (const n of names) {
    if (OP[n] === undefined) throw new Error(`mir/opt/memory: ${who} 里没有 op "${n}"`);
    s.add(OP[n]);
  }
  return s;
}
const NO_READ = setOf(NO_READ_NAMES, 'NO_READ');
const NO_WRITE = setOf(NO_WRITE_NAMES, 'NO_WRITE');

/** 这条指令可能**读**线性内存吗（白名单之外一律算会读）。 */
export function mayReadMemory(op) { return !NO_READ.has(op); }
/** 这条指令可能**写**线性内存吗（白名单之外一律算会写）。 */
export function mayWriteMemory(op) { return !NO_WRITE.has(op); }

/**
 * 一条 `MLOAD` 与一条 `MSTORE` 读写的是**同一个格子、而且读回来就是写进去那个值**吗。
 *
 * 三条都要成立（对应 Go `generic.rules:839` 的三个条件 `IsSamePtr` /
 * `copyCompatibleType` / `t1.Size() == t2.Size()`）：
 *   1. 静态偏移相同（地址那个 ref 相同由调用方比）
 *   2. 字节数相同
 *   3. **宽度就是那个类型的全宽**，不是窄访问 —— 窄的不行：`int8_t x = n;` 存的是
 *      一个 i32 值的低字节，`i8s` 读回来是"那个字节的符号扩展"，与原值不是一回事。
 *      所以只认 i64/i32s/f32/f64 这四对，而且两边的 `t` 必须一样。
 */
export function sameCell(fn, pcLoad, pcStore) {
  if (memOff(fn.aux[pcLoad]) !== memOff(fn.aux[pcStore])) return false;
  const kl = memKindNo(fn.aux[pcLoad]), ks = memKindNo(fn.aux[pcStore]);
  if (MLOAD_BYTES[kl] !== MSTORE_BYTES[ks]) return false;
  if (fn.t[pcLoad] !== fn.t[pcStore]) return false;
  const ln = MLOAD_KINDS[kl], sn = MSTORE_KINDS[ks];
  return (ln === 'i64' && sn === 'i64')
      || (ln === 'i32s' && sn === 'i32')
      || (ln === 'f32' && sn === 'f32')
      || (ln === 'f64' && sn === 'f64');
}

/** 给判据用：这两张白名单（名字）。 */
export function memoryOpNames() {
  const r = [], w = [];
  for (const o of NO_READ) r.push(OP_NAMES[o]);
  for (const o of NO_WRITE) w.push(OP_NAMES[o]);
  return { noRead: r, noWrite: w };
}

/* -------------------------------------------------------- 地址 = 基址 + 静态偏移
 * Go 那边地址长成 `(OffPtr [off] p)`，于是 `IsSamePtr` 与 `Disjoint`
 * （`ssa/rewrite.go`）都能按"同一个 base + 两个常量偏移"判。
 * MIR 里没有 OffPtr —— `&a[3]` 就是 `ADD(base, 常量)`（ir.js 里 PADD 那段的同一条理由：
 * "字段地址就是 PADD(p, 常量偏移)"）。所以这一格把 `ADD(base, k)` 拆回 `{base, off}`，
 * 两条访问于是能比"是不是同一处"与"是不是不相交"。
 */

/** 拆地址：回 `{base, off}`。不是 `ADD(base, 常量)` 的形状就当 `{base: ref, off: 0}`。 */
export function addrOf(fn, mod, ref) {
  let base = ref, off = 0;
  /* 最多剥三层（`ADD(ADD(base,k1),k2)` 这种）—— 有界，免得图里出环时打转。 */
  for (let i = 0; i < 3; i++) {
    if (base < REF_BIAS || base === REF_NONE) break;
    const pc = base - REF_BIAS;
    if (fn.op[pc] !== OP.ADD) break;
    const ka = constVal(fn, mod, fn.a[pc], 0);
    const kb = constVal(fn, mod, fn.b[pc], 0);
    if (kb !== null && fn.a[pc] >= REF_BIAS) { off += kb; base = fn.a[pc]; continue; }
    if (ka !== null && fn.b[pc] >= REF_BIAS) { off += ka; base = fn.b[pc]; continue; }
    break;
  }
  return { base, off };
}

/**
 * 这个 ref 是个**编译期常数**吗（是就回那个数，不是回 null）。
 *
 * 不只认常量池里的一条 —— 还认「几个常量算出来的那棵小树」（`ADD`/`SUB`/`MUL`/`SHL`/`NEG`）。
 * 为什么要这一层：C 前端的数组下标是 `ADD(base, MUL(下标, 元素宽))`，`t[0]` 于是是
 * `ADD(base, MUL(k0, k4))` —— 那个 `MUL` 要等 `opt` 那一格才折成常量，而通道表里
 * `decompose user`（SROA）**在 `opt` 之前**（Go 的前端出的是 `OffPtr [常量]`，没有这一步）。
 * 不认这棵小树的话数组一格都拆不了 —— 判据 `sroa.test.js` 的 `plain` 量到过：
 * 三条 MLOAD 一条没动，而同一份里 struct 的字段（偏移直接是常量）拆得干干净净。
 *
 * 中间用 Number 算但每步都查 `isSafeInteger`；深度有界（4 层）。
 */
export function constOffset(fn, mod, ref) { return constVal(fn, mod, ref, 0); }

function constVal(fn, mod, ref, depth) {
  if (ref === REF_NONE) return null;
  if (ref < REF_BIAS) {
    const c = mod.consts.items[ref];
    if (c === undefined || c.kind !== 'int') return null;
    const v = Number(BigInt(c.text));
    return Number.isSafeInteger(v) ? v : null;
  }
  if (depth >= 4) return null;
  const pc = ref - REF_BIAS;
  const op = fn.op[pc];
  if (op === OP.NEG) {
    const a = constVal(fn, mod, fn.a[pc], depth + 1);
    return a === null ? null : -a;
  }
  if (op !== OP.ADD && op !== OP.SUB && op !== OP.MUL && op !== OP.SHL) return null;
  const a = constVal(fn, mod, fn.a[pc], depth + 1);
  if (a === null) return null;
  const b = constVal(fn, mod, fn.b[pc], depth + 1);
  if (b === null) return null;
  let r = 0;
  if (op === OP.ADD) r = a + b;
  else if (op === OP.SUB) r = a - b;
  else if (op === OP.MUL) r = a * b;
  else {
    if (b < 0 || b > 31) return null;
    r = a * Math.pow(2, b);
  }
  return Number.isSafeInteger(r) ? r : null;
}

/** 一条 MLOAD/MSTORE 访问的**字节区间**：`{base, lo, hi, kind}`（hi 不含）。 */
export function cellOf(fn, mod, pc, isLoad) {
  const a = addrOf(fn, mod, fn.a[pc]);
  const lo = a.off + memOff(fn.aux[pc]);
  const k = memKindNo(fn.aux[pc]);
  const bytes = isLoad ? MLOAD_BYTES[k] : MSTORE_BYTES[k];
  return { base: a.base, lo, hi: lo + bytes, kind: k };
}

/** 两处访问**一定不相交**吗（Go 的 `Disjoint`）。基址不同就答不了 —— 回 false。 */
export function disjoint(x, y) {
  if (x.base !== y.base) return false;
  return x.hi <= y.lo || y.hi <= x.lo;
}

/** 两处访问**一定是同一个格子**吗（同基址、同区间）。 */
export function sameSpot(x, y) {
  return x.base === y.base && x.lo === y.lo && x.hi === y.hi;
}
