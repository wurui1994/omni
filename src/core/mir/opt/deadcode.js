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
 * 两半，与 Go 的 `deadcode.go` 同序：**先删不可达的（`unreachable`），再按定义-使用链
 * 删没人用的（`liveValues`）**。Go 那边第一半是 `ssa.ReachableBlocks` + 删块，我们的
 * 控制流是结构化标记，所以第一半按区域栈线性算（见 `unreachable` 的注释）。
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
 * 删**到不了的**指令（Go 的 `deadcode.go` 第一步 `ssa.ReachableBlocks` + 删块）。
 *
 * 结构化控制流里这件事是线性可算的：一条无条件转移（`BR`/`RET`/`BRTABLE`）之后，
 * **同一层**往下的指令都到不了 —— 想进那一段只能往前跳，而结构化标记里没有往前跳
 * （`region.js` 文件头记的就是这条）。到不了的那一段在两处结束：
 *   - 本层的 `END`（区域的出口是汇合点，别的路能到那儿）；
 *   - 本层的 `ELSE`（IF 的假边能到那儿）。
 * 这两条本身**留着**，它们之后恢复成"到得了"。段里嵌套的整个区域（含它的 `END`）一起删。
 *
 * 为什么非做不可：`inline` 把被调函数整段抄进来，而 C 前端给每个有返回值的函数都补了
 * 一条"掉到末尾"的 `return 0`。于是每个内联进来的 `vdot` 都长成
 *   `BLOCK; …; STORE %39 slot:ret; BR ^0; STORE 0.0 slot:ret; BR ^0; END; LOAD slot:ret`
 * 后面那条 `STORE 0.0` 到不了，可 mem2reg 要在 `END` 处对两条前驱取交 —— 一个是 %39、
 * 一个是 0.0，交出来是⊥，于是那条 `LOAD` 留下了。量出来的代价：`intersect`（自时间 52%）
 * 的循环体里每个 `vdot` 都多一趟 `fmov + str + ldr + fmov` 的栈往返，一圈两趟。
 *
 * 保守的一处：若还活着的指令引用了要删的那一段里定的值，整半步放弃（回 0）—— 那说明
 * 有别的变换已经把值从不可达处转发出来了，此刻删就留下悬空 ref。
 *
 * **函数末尾那条到不了的 `RET` 也删**（C 前端给每个有返回值的函数都补了一条）：删它
 * 的前提是同一层前面已经有一条 `RET`，后端的收场挂在那一条上。留着它反倒让 `inline`
 * 的"尾返回"快路（`inline.js` 里那一段）判不成 —— 两条 `RET` 带的值不同。
 */
export function unreachable(fn) {
  const n = fn.op.length;
  const doomed = new Set();
  let dead = false, deadDepth = 0, depth = 0;
  for (let pc = 0; pc < n; pc++) {
    const o = fn.op[pc];
    if (dead) {
      if (o === OP.END) {
        depth--;
        if (depth + 1 === deadDepth) dead = false; else doomed.add(pc);
        continue;
      }
      if (o === OP.ELSE && depth === deadDepth) { dead = false; continue; }
      doomed.add(pc);
      if (o === OP.BLOCK || o === OP.LOOP || o === OP.IF) depth++;
      continue;
    }
    if (o === OP.BLOCK || o === OP.LOOP || o === OP.IF) { depth++; continue; }
    if (o === OP.END) { depth--; continue; }
    if (o === OP.BR || o === OP.RET || o === OP.BRTABLE) { dead = true; deadDepth = depth; }
  }
  if (doomed.size === 0) return 0;
  /* 悬空 ref 的自检（见函数头） */
  for (let pc = 0; pc < n; pc++) {
    if (doomed.has(pc)) continue;
    for (const r of operandRefs(fn, pc)) {
      if (r === REF_NONE || r < REF_BIAS) continue;
      if (doomed.has(r - REF_BIAS)) return 0;
    }
  }
  return removeInsns(fn, doomed);
}

/**
 * 就地 deadcode。回删了几条指令。
 */
export function deadcode(fn, _mod) {
  if (!fn || fn.op.length === 0) return 0;
  let gone = unreachable(fn);
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
  return gone + removeInsns(fn, doomed);
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
