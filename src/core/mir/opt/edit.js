/**
 * 改图的那几件事 —— 各通道共用（`ssa.js` / `deadcode.js` / `rewrite.js` 都从这儿拿）。
 *
 * 为什么要收在一处：MIR 的指令是五个平行数组 + 一个自描述的实参池，而「谁引用谁」
 * 分散在三处（`a`、`b`、池里那几格）。改引用与删指令这两件事各写一遍就迟早漏一处 ——
 * mem2reg 第一版就是把 `pc` 当 ref 用，于是"改写 0 处、白跑一趟"。
 */

import { OP_MODES, REF_BIAS, REF_NONE } from '../ir.js';

/** 这条指令读的那些 ref（角色 'r' 的两个字段 + 角色 'p' 的实参池）。
 *  'j' 是层数表、'n' 是字面量、's' 是槽位号 —— 一律不许当 ref 碰。 */
export function operandRefs(fn, pc) {
  const m = OP_MODES[fn.op[pc]];
  const out = [];
  if (m[0] === 'r') out.push(fn.a[pc]);
  if (m[1] === 'r') out.push(fn.b[pc]);
  if (m[1] === 'p') {
    const at = fn.b[pc];
    const n = fn.args[at];
    for (let i = 0; i < n; i++) out.push(fn.args[at + 1 + i]);
  }
  return out;
}

/**
 * 把 fn 里**所有**引用 oldRef 的地方换成 newRef。回换了几处。
 *
 * 这一处刻意**不按角色过滤**（扫整个 a/b/args 数组）：oldRef 一定是个指令 ref
 * （>= REF_BIAS），而角色 'n'/'s'/'j' 那几格装的是小整数（类型号、槽号、层数），
 * 撞不上。比按角色走一遍更结实 —— 角色表将来加一格也不会漏。
 */
export function replaceRef(fn, oldRef, newRef) {
  if (oldRef < REF_BIAS || oldRef === REF_NONE) {
    throw new Error(`mir/opt: replaceRef 的 oldRef 必须是指令 ref，得到 ${oldRef}`);
  }
  let n = 0;
  for (let i = 0; i < fn.a.length; i++) {
    if (fn.a[i] === oldRef) { fn.a[i] = newRef; n++; }
    if (fn.b[i] === oldRef) { fn.b[i] = newRef; n++; }
  }
  for (let i = 0; i < fn.args.length; i++) {
    if (fn.args[i] === oldRef) { fn.args[i] = newRef; n++; }
  }
  return n;
}

/** 老 ref -> 新 ref。常量与 REF_NONE 原样过；指向被删指令的一律是 bug，当场炸。 */
function mapRef(fn, ref, map) {
  if (ref === REF_NONE) return ref;
  if (ref < REF_BIAS) return ref;
  const i = ref - REF_BIAS;
  const j = map[i];
  if (j === undefined || j < 0) {
    throw new Error(`mir/opt: ${fn.name} 里 %${i} 被删了却还有人引用`);
  }
  return j + REF_BIAS;
}

/**
 * 按下标集合删指令：重编号 + 重建那五个平行数组 + 按角色改 ref。回删了几条。
 *
 * **凡是要删指令的通道一律走这儿**（deadcode、elim unread autos、dse…）：
 * MIR 里没有 NOP（`END` 会关掉最近一个未闭合的区域），所以「先标记、后统一删」这件事
 * 只能有一份实现。Go 那边是把删掉的 store 改写成 `OpCopy(内存实参)` 再等 deadcode 收尸，
 * 我们没有内存 SSA 链可以接，所以直接在这一处删。
 *
 * 删了还有人引用的指令 = 调用方的 bug，`mapRef` 当场炸（这就是那道自检）。
 */
export function removeInsns(fn, doomed) {
  if (!doomed || doomed.size === 0) return 0;
  const n = fn.op.length;

  /* 一、重编号：老下标 -> 新下标（-1 = 删了） */
  const map = [];
  let k = 0;
  for (let pc = 0; pc < n; pc++) {
    if (doomed.has(pc)) map.push(-1); else { map.push(k); k++; }
  }

  /* 二、重建那五个平行数组 */
  const op = [], t = [], a = [], b = [], aux = [];
  for (let pc = 0; pc < n; pc++) {
    if (doomed.has(pc)) continue;
    op.push(fn.op[pc]);
    t.push(fn.t[pc]);
    a.push(fn.a[pc]);
    b.push(fn.b[pc]);
    aux.push(fn.aux[pc]);
  }
  fn.op = op; fn.t = t; fn.a = a; fn.b = b; fn.aux = aux;

  /* 删过指令之后，按**下标**记的那些标注全废了 —— `regalloc` 的 `regHint`/`regHintF`
     就是两张 `下标 -> 颜色` 的表。清掉而不是重编号：通道表里 regalloc 在倒数第三格，
     它之后只剩 `trim`，而"先分配、再删指令"本来就该重新分配一次。
     `slotHint`/`slotHintF` 的键是槽号（删指令不改槽号），可它们的**区间**是按 pc 算的，
     与值的颜色是同一个池子分出来的 —— 只清一半会留下相交却同色的一对。所以四张一起清。
     `regHintGF`（寄放进 FP 的整数值）也是按下标记的，漏掉它会**段错误**：后端认了一张
     过期的表，值写进 d 寄存器而读的是另一处（pt 上踩过一次）。 */
  if (fn.regHint !== undefined) fn.regHint = undefined;
  if (fn.regHintF !== undefined) fn.regHintF = undefined;
  if (fn.regHintGF !== undefined) fn.regHintGF = undefined;
  if (fn.slotHint !== undefined) fn.slotHint = undefined;
  if (fn.slotHintF !== undefined) fn.slotHintF = undefined;
  /* `noPool`（后端关掉一遍过缓存、把 x11-x15 让给分配表）**必须与分配表同生共死**：
     留着一个 true 而表是空的 = 那五个寄存器谁都不用，没涂色的值全落栈位。 */
  if (fn.noPool !== undefined) fn.noPool = false;

  /* 三、按角色改 ref。
     实参池**不压缩**：起点存在 b 上，压缩了就得同时改 b，而池里可能还有别的东西
     指着它。池里死掉的那几格是垃圾，不占语义、不进后端（后端只从起点读 n 格）。
     同一个起点只改一遍 —— 映射是"老 -> 新"且新 <= 老，改两遍会再往下跌一次。 */
  const donePools = new Set();
  for (let pc = 0; pc < fn.op.length; pc++) {
    const m = OP_MODES[fn.op[pc]];
    if (m[0] === 'r') fn.a[pc] = mapRef(fn, fn.a[pc], map);
    if (m[1] === 'r') fn.b[pc] = mapRef(fn, fn.b[pc], map);
    if (m[1] === 'p') {
      const at = fn.b[pc];
      if (donePools.has(at)) continue;
      donePools.add(at);
      const cnt = fn.args[at];
      for (let i = 0; i < cnt; i++) {
        fn.args[at + 1 + i] = mapRef(fn, fn.args[at + 1 + i], map);
      }
    }
  }

  return doomed.size;
}
