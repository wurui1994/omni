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

import { OP, OP_NAMES, REF_BIAS, REF_NONE } from '../ir.js';
import { registerPass } from './pass.js';
import { operandRefs, removeInsns } from './edit.js';

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
  /* 线性内存的**读**（第二格加的）。Go 那边 `OpLoad` 没有副作用、没人用就删 ——
   * 我们跟它一样，理由是 C 的越界/空指针读是**未定义行为**，删掉一条没人用的读
   * 只可能把"本来会崩"变成"不崩"，而那正是所有 -O2 编译器的做法。
   *
   * 为什么加它：`opt` 的存储转发（`generic.rules:839`）把 `MLOAD` 的使用改指向了
   * 那条 `MSTORE` 的值，MLOAD 自己就没人用了 —— 不删的话转发一格指令都省不下来
   * （`arr` 那个例子量到过：转发成了，可 15 条里还留着两条没人用的 MLOAD）。
   *
   * **AGET/BGET/IDXGET/PLOAD 刻意不在这儿**：那几条的越界是我们自己语言的
   * 运行期错误（ADR-0014 门槛 7、ADR-0016），不是 UB —— 删了就是删掉一个可观察的行为。 */
  'MLOAD',
  // 长度（不解引用元素，所以不会越界）
  'ALEN', 'BLEN', 'MSIZE',
  // 向量的三条（全是纯的按道搬）
  'VSPLAT', 'VINS', 'VEXT',
  // 地址（算地址不访问内存）
  'FRAME', 'GADDR', 'FADDR', 'PNULL', 'PISNULL', 'PTHIN', 'PADD',
  /* **按值收发 struct 的那两个记号**（第二格加的）。`ARGMEM p n` / `ARGSRET p n`
   * 只是"这一块在 p、n 个字节"的说明，自己**不访问内存、没有副作用** ——
   * 它们的意义全在被哪条 `CALL` 的实参池引用着。
   *
   * 为什么非删不可：`inline` 把一条 CALL 换成它的函数体之后，那条 CALL 的
   * `ARGMEM`/`ARGSRET` 就没人引用了，可它们还**攥着那个帧块的地址**。
   * 于是 `copyfwd.js` 的 `localFrame` 与 `sroa.js` 的 `scanBase` 都判那一块逃逸，
   * 两格都不敢动 —— 量出来的代价是 `sph_intersect`（smallpt 自时间的 47%）里
   * 88 条访存一条都收不掉。 */
  'ARGMEM', 'ARGSRET',
];

/** 名字 -> opcode，顺手自检（表里写错一个名字就当场炸，不静悄悄少删一族）。 */
const REMOVABLE = new Set();
for (const name of REMOVABLE_NAMES) {
  if (OP[name] === undefined) throw new Error(`mir/opt/deadcode: 没有 op "${name}"`);
  REMOVABLE.add(OP[name]);
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

  const doomed = new Set();
  for (let pc = 0; pc < n; pc++) if (!live[pc]) doomed.add(pc);
  return removeInsns(fn, doomed);
}

/**
 * 按下标集合删指令的那一步在 `edit.js` 的 `removeInsns` 里 —— 凡是要删指令的通道
 * （`elim unread autos`、`dse`…）都走同一处，因为 MIR 里没有 NOP。
 */

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
