/**
 * deadcode —— 删掉"产了值但没人用"的纯指令，**并重建指令数组、重编号 ref**。
 *
 * 这一格是通道表里**删指令的唯一出口**。别的变换（mem2reg、cse、opt…）一律只改
 * "谁引用谁"，因为 MIR 里**没有 NOP**：`END` 会关掉最近一个未闭合的区域，把消掉的
 * 指令改写成 `END` 会当场把控制流改坏（`opt/ssa.js` 文件头记了那次）。所以 Go 的通道表
 * 在每个变换之后都紧跟一格 deadcode —— 变换只做标记，删的活集中在这儿一处。
 *
 * 照 Go 的 `ssa/deadcode.go`：从**根**出发按定义-使用链正向标记，没标到的删掉。
 * 同一个函数挂在通道表的八格 `*deadcode` 上（Go 也是同一个 `deadcode` 挂多格）。
 *
 * 什么算根（保守，这一版**只删纯值**）
 * ------------------------------------
 * 不在 `REMOVABLE` 里的一律是根。所以区域标记、跳转、所有写内存的、所有调用、
 * 所有分配、所有会报运行期错误的访问（越界/空指针/除零）都留着 —— 删掉它们
 * 就是删掉一个可观察的行为。
 *
 * 这一版**不动块**：不可达的块照旧留着。Go 那边 deadcode 也删不可达块，但我们的控制流是
 * 结构化标记，删块要同时补平区域的配对 —— 那是 `trim`/`layout` 那一族的活，另开一格。
 */

import { OP, OP_MODES, OP_NAMES, REF_BIAS, REF_NONE } from '../ir.js';
import { registerPass } from './pass.js';

/* 能删的那些 op：**产一个值、没有副作用、不会报运行期错误**。
 *
 * 刻意不在表里的几族，每一族都有理由：
 *   - DIV/MOD/UDIV/UMOD：除零是运行期错误，删了就把错误删了
 *   - AGET/BGET/IDXGET/PLOAD/MLOAD：带范围/空指针检查，同上
 *   - APOP/VAARG：读的同时把容器/游标推了一格，是写
 *   - NEW/ANEW/BNEW/PNEW/AGGLIT/CLOSURE/MKENUM：分配。删死分配是"对象不落堆"那条路上的事
 *     （escape + decompose + dead auto elim 三步，ADR-0039 第 3 节），不是这一格能单独做对的
 *   - SPGET/SPALLOC/FPGET/SETJMP：读的是机器状态，位置本身有意义
 */
const REMOVABLE_NAMES = [
  // 算术（除法那四条除外，见上）
  'ADD', 'SUB', 'MUL', 'NEG', 'SHL', 'SHR', 'USHR',
  'BAND', 'BOR', 'BXOR', 'BNOT', 'NOT',
  // 比较（十条，两段连号）
  'EQ', 'NE', 'LT', 'GE', 'LE', 'GT', 'ULT', 'UGE', 'ULE', 'UGT', 'PEQ',
  // 转换与取值
  'CVT', 'COPY', 'FLD', 'ETAG',
  // 槽位与模块级变量的**读**
  'LOAD', 'GLOAD',
  // 长度（不解引用元素，所以不会越界）
  'ALEN', 'BLEN', 'MSIZE',
  // 向量的三条（全是纯的按道搬）
  'VSPLAT', 'VINS', 'VEXT',
  // 地址（算地址不访问内存）
  'FRAME', 'GADDR', 'FADDR', 'PNULL', 'PISNULL', 'PTHIN', 'PADD',
];

/** 名字 -> opcode，顺手自检（表里写错一个名字就当场炸，不静悄悄少删一族）。 */
const REMOVABLE = new Set();
for (const name of REMOVABLE_NAMES) {
  if (OP[name] === undefined) throw new Error(`mir/opt/deadcode: 没有 op "${name}"`);
  REMOVABLE.add(OP[name]);
}

/** 这条指令读的那些 ref（只看角色是 'r' 的字段，加角色是 'p' 的实参池）。
 *  'j' 是层数表、'n' 是字面量、's' 是槽位号 —— 一律不许当 ref 碰。 */
function operandRefs(fn, pc) {
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

/** 老 ref -> 新 ref。常量与 REF_NONE 原样过；指向被删指令的一律是 bug，当场炸。 */
function mapRef(fn, ref, map) {
  if (ref === REF_NONE) return ref;
  if (ref < REF_BIAS) return ref;
  const i = ref - REF_BIAS;
  const j = map[i];
  if (j === undefined || j < 0) {
    throw new Error(`mir/opt/deadcode: ${fn.name} 里 %${i} 被删了却还有人引用`);
  }
  return j + REF_BIAS;
}

/**
 * 就地 deadcode。回删了几条指令。
 */
export function deadcode(fn, _mod) {
  if (!fn || fn.op.length === 0) return 0;
  const n = fn.op.length;

  /* ---- 一、从根正向标记 */
  const live = [];
  for (let i = 0; i < n; i++) live.push(false);
  const work = [];
  for (let pc = 0; pc < n; pc++) {
    if (!REMOVABLE.has(fn.op[pc])) { live[pc] = true; work.push(pc); }
  }
  while (work.length > 0) {
    const pc = work.pop();
    for (const r of operandRefs(fn, pc)) {
      if (r === REF_NONE || r < REF_BIAS) continue;
      const i = r - REF_BIAS;
      if (i < 0 || i >= n) throw new Error(`mir/opt/deadcode: ${fn.name} 的 %${i} 出界`);
      if (!live[i]) { live[i] = true; work.push(i); }
    }
  }

  let dead = 0;
  for (let pc = 0; pc < n; pc++) if (!live[pc]) dead++;
  if (dead === 0) return 0;

  /* ---- 二、重编号：老下标 -> 新下标（-1 = 删了） */
  const map = [];
  let k = 0;
  for (let pc = 0; pc < n; pc++) {
    if (live[pc]) { map.push(k); k++; } else map.push(-1);
  }

  /* ---- 三、重建那五个平行数组 */
  const op = [], t = [], a = [], b = [], aux = [];
  for (let pc = 0; pc < n; pc++) {
    if (!live[pc]) continue;
    op.push(fn.op[pc]);
    t.push(fn.t[pc]);
    a.push(fn.a[pc]);
    b.push(fn.b[pc]);
    aux.push(fn.aux[pc]);
  }
  fn.op = op; fn.t = t; fn.a = a; fn.b = b; fn.aux = aux;

  /* ---- 四、按角色改 ref。
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

  return dead;
}

/** 通道表里八格 `*deadcode` 都是同一个函数（Go 那边也是同一个 `deadcode` 挂多格）。 */
const SLOTS = [
  'early deadcode',
  'pre-opt deadcode',
  'opt deadcode',
  'gcse deadcode',
  'generic deadcode',
  'lowered deadcode for cse',
  'lowered deadcode',
  'late deadcode',
];
for (const s of SLOTS) registerPass(s, deadcode);

/** 给判据用：这一格认哪些 op 可删（名字）。 */
export function removableOpNames() {
  const out = [];
  for (const o of REMOVABLE) out.push(OP_NAMES[o]);
  return out;
}
