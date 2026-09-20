/**
 * cse —— 公共子表达式消除。照 Go 的 `ssacompile/cse.go`：
 *
 *   「两个值等价 ⇔ op 相同、类型相同、aux 相同、实参个数相同、且逐个实参等价。」
 *   先按前几条切一个粗划分，再**反复按实参的等价类切**直到不动点；
 *   然后在每个等价类里挑**支配者**，把被它支配的那些的使用改指向它。
 *
 * 与 Go 逐字相同的三件事：
 *   - 交换律的 op 比较前先把两个实参按等价类排序（`cse.go:108`）
 *   - **一条指令都不删**（`cse.go:19` 的注释："Values are just relinked, nothing is
 *     deleted. A subsequent deadcode pass is required"）—— 正是通道表里 cse 后面
 *     紧跟 `gcse deadcode` 的理由
 *   - 支配关系用支配树（`cse.go:205` 的 `sdom.IsAncestorEq`）
 *
 * 哪些 op 敢 CSE（我们自己的判据，比 Go 窄，理由逐条记着）
 * ------------------------------------------------------
 * Go 靠"内存也是一个 SSA 值"把读写串成链，于是 load 能参与 CSE。MIR 里没有那条内存链
 * （`LOAD/STORE` 直接按槽号读写），所以**凡是读内存/容器/对象的一律不进**：
 *   - `LOAD`/`GLOAD`：中间可能有 `STORE`/`GSTORE`
 *   - `ALEN`/`BLEN`：`APUSH`/`APOP` 会改长度
 *   - `FLD`：class 是引用语义，`FLDSET` 会改字段
 *   - `COPY`：它的语义是**造一份新的**（ADR-0005 的值语义），共用一份就错了
 *   - `MLOAD`/`PLOAD`/`AGET`/`BGET`/`IDXGET`：读内存，而且带越界检查
 *   - `DIV`/`MOD`/`UDIV`/`UMOD`：deadcode 不删会报错的指令，所以 CSE 了也省不下来
 */

import { OP, OP_MODES, OP_NAMES, REF_BIAS, REF_NONE } from '../ir.js';
import { inScope, regionScope } from './region.js';
import { replaceRef } from './edit.js';
import { registerPass } from './pass.js';

const CSE_NAMES = [
  'ADD', 'SUB', 'MUL', 'NEG', 'SHL', 'SHR', 'USHR',
  'BAND', 'BOR', 'BXOR', 'BNOT', 'NOT',
  'EQ', 'NE', 'LT', 'GE', 'LE', 'GT', 'ULT', 'UGE', 'ULE', 'UGT', 'PEQ',
  'CVT', 'ETAG',
  'VSPLAT', 'VINS', 'VEXT',
  'FRAME', 'GADDR', 'FADDR', 'PNULL', 'PISNULL', 'PTHIN', 'PADD',
];

const CSE_OK = new Set();
for (const name of CSE_NAMES) {
  if (OP[name] === undefined) throw new Error(`mir/opt/cse: 没有 op "${name}"`);
  /* 自检：这几条一律只用 a/b 两个操作数（没有实参池）—— 下面的 key 只看 a/b。 */
  const m = OP_MODES[OP[name]];
  if (m[1] === 'p' || m[1] === 'j') throw new Error(`mir/opt/cse: ${name} 带池，不能这么比`);
  CSE_OK.add(OP[name]);
}

/** 交换律的 op（Go 的 `Commutative` 那一栏）。比较前把两个实参排一下序。 */
const COMMUTATIVE = new Set([OP.ADD, OP.MUL, OP.BAND, OP.BOR, OP.BXOR, OP.EQ, OP.NE, OP.PEQ]);

/** 一个 ref 的等价类号：常量用它自己的号（常量池已经去重了，同号就是同值），
 *  指令用 `cls[]`，没参加划分的用它自己的负号（Go 的 `-v.ID`，保证只跟自己相等）。 */
function classOf(cls, ref) {
  if (ref === REF_NONE) return 'n';
  if (ref < REF_BIAS) return 'k' + ref;
  const pc = ref - REF_BIAS;
  const c = cls[pc];
  return c === 0 ? 'u' + pc : 'c' + c;
}

/** 这条指令在这一轮的细化键：等价类 + 两个实参的等价类（交换律的排一下序）。 */
function refineKey(fn, cls, pc) {
  const op = fn.op[pc];
  const m = OP_MODES[op];
  let ka = m[0] === 'r' ? classOf(cls, fn.a[pc]) : '-';
  let kb = m[1] === 'r' ? classOf(cls, fn.b[pc]) : '-';
  if (COMMUTATIVE.has(op) && kb < ka) { const t = ka; ka = kb; kb = t; }
  return `${cls[pc]}|${ka}|${kb}`;
}

/**
 * 支配：`pcA` 定义的值在 `pcB` 处**还用得上吗**。
 *
 * ⚠️ 这儿**不能用 CFG 的支配树**。第一版用了，在 `src/runtime/omni_r3.c` 上当场被
 * verifier 抓住：`r3_num:%156 CALL: %38 定义在一个已经关掉的区域里`。
 * 循环之前的块在支配树上确实是循环之后那块的祖先，但 MIR 的规矩是**词法作用域**
 * （`verify.js:124 checkRef`）—— `LOOP … END` 一关，里头（与外头跨过 END）的值就不可见。
 * 判据因此是 `region.js` 的 `inScope`：先后次序 + 定义那层区域还开着。
 *
 * 换掉 w 的**全部**使用是安全的：w 的每个使用点都满足"w 那层区域还开着"，
 * 而 v 那层是 w 那层的祖先，于是 v 在那些点上也开着。
 */
function domin(sc, pcA, pcB) { return inScope(sc, pcA, pcB); }
/**
 * 跑 cse。回「改了多少处引用」。**一条指令都不删** —— 后面那格 deadcode 收尸。
 *
 * `opts.zeroArgOnly` = Go 的 `zcse`（通道表里 `zero arg cse` 那一格）。
 */
export function cse(fn, mod, opts) {
  const zeroArgOnly = opts !== undefined && opts.zeroArgOnly === true;
  if (!fn || fn.op.length === 0) return 0;
  const n = fn.op.length;

  /* ---- 一、粗划分：op | 结果类型 | aux（Go 的 partitionValues 用同一套键） */
  const cls = [];
  for (let i = 0; i < n; i++) cls.push(0);
  const coarse = new Map();
  for (let pc = 0; pc < n; pc++) {
    const op = fn.op[pc];
    if (!CSE_OK.has(op)) continue;
    const m = OP_MODES[op];
    if (zeroArgOnly && (m[0] === 'r' || m[1] === 'r')) continue;
    const key = `${op}|${fn.t[pc]}|${fn.aux[pc]}`;
    let bucket = coarse.get(key);
    if (bucket === undefined) { bucket = []; coarse.set(key, bucket); }
    bucket.push(pc);
  }
  let cno = 1;
  const parts = [];
  for (const bucket of coarse.values()) {
    if (bucket.length < 2) continue;           // 单元素类不用管（Go 也不收 singleton）
    for (const pc of bucket) cls[pc] = cno;
    parts.push(bucket);
    cno++;
  }
  if (parts.length === 0) return 0;

  /* ---- 二、按实参的等价类反复细化，直到不动点（Go 的那个 for { changed } 循环） */
  for (let round = 0; round < n + 2; round++) {
    let changed = false;
    const next = [];
    for (const e of parts) {
      const groups = new Map();
      for (const pc of e) {
        const k = refineKey(fn, cls, pc);
        let g = groups.get(k);
        if (g === undefined) { g = []; groups.set(k, g); }
        g.push(pc);
      }
      if (groups.size === 1) { next.push(e); continue; }
      changed = true;
      for (const g of groups.values()) {
        if (g.length < 2) { for (const pc of g) cls[pc] = 0; continue; }
        for (const pc of g) cls[pc] = cno;
        next.push(g);
        cno++;
      }
    }
    parts.length = 0;
    for (const e of next) parts.push(e);
    if (!changed) break;
  }

  /* ---- 三、每个类里挑支配者，把被支配的那些的使用改过去 */
  const sc = regionScope(fn);
  let moved = 0;
  for (const e of parts) {
    /* 按下标升序：靠前的更可能支配靠后的（Go 按 DomOrder 排，同一个用意） */
    const list = e.slice().sort((x, y) => x - y);
    const gone = new Set();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (gone.has(v)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const w = list[j];
        if (gone.has(w)) continue;
        if (!domin(sc, v, w)) continue;
        moved += replaceRef(fn, REF_BIAS + w, REF_BIAS + v);
        gone.add(w);
      }
    }
  }
  return moved;
}

/** Go 的 `zcse`（`ssacompile/zcse.go`）：只管零实参的值，给后面那遍真 cse 减负。
 *
 * **与 Go 差一件事**：它把第一个零实参值**搬到入口块**，这样它天然支配全函数
 * （"This prevents the need for any dominator calculations in this pass"）。
 * 我们不搬 —— 搬一条指令要在数组中间插入并重编号所有 ref，而 MIR 的区域标记是按
 * 位置配对的，搬错一格就把控制流改坏。不搬的代价是只在支配关系已经成立时才合并，
 * 比 Go 弱一档；搬这件事等有了真正的块重排（`layout`/`schedule` 那两格）再说。 */
export function zcse(fn, mod) { return cse(fn, mod, { zeroArgOnly: true }); }

registerPass('zero arg cse', zcse);
registerPass('generic cse', (fn, mod) => cse(fn, mod));
registerPass('lowered cse', (fn, mod) => cse(fn, mod));

/** 给判据用：这一格认哪些 op（名字）。 */
export function cseOpNames() {
  const out = [];
  for (const o of CSE_OK) out.push(OP_NAMES[o]);
  return out;
}
