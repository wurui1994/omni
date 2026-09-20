/**
 * MIR 的优化管线 —— **公共的那一层**（ADR-0039）。
 *
 * 为什么在这儿而不是在某个后端里：量出来的账（`docs/adr/0039` 第 0 节）是
 * AOT 腿 15.7x、VM-JIT 腿 17.0x（smallpt 64×64 热态，C = 1.0x、Go = 1.2x）——
 * **两条一样差**。差的 15 倍不在某一门语言的发射器里，在这层缺的通道表里
 * （`mir/ir.js` 开头那句"不做优化"就是它自己写的）。
 *
 * 形状照 Go 抄（`cmd/compile/internal/ssacompile/compile.go:414` 的 `var passes`）：
 *   - **每格一遍、顺序固定、不迭代到不动点** —— 这是"编译快"的唯一来源
 *   - 质量靠通道的**数量与次序**，不靠某一格反复跑
 *   - 另有一张 `passOrder` 约束表（"a 必须在 b 之前"），启动时自检
 *
 * 档位（`-O`）：
 *   0 = 只跑 required（等于现在的行为 + 必要的形状归一）
 *   1 = 第一批（骨架：decompose/opt/cse/deadcode/lower/layout/schedule/regalloc…）
 *   2 = 第一批 + 第二批（质量补齐），**tcc -O2 那一档**
 *   3 = 再加第三批（prove/licm/memcombine 那一族）
 *
 * 宿主约束（ADR-0011 决策 2）：这份代码要能被编译器自己编译 —— 只用封闭 ABI 里的东西
 * （数组、对象、Map/Set 可以，TypedArray/DataView 不行）。
 */

/* --------------------------------------------------------------- 批次常量 */
export const BATCH_REQ = 0;   // required：不能关
export const BATCH_1 = 1;
export const BATCH_2 = 2;
export const BATCH_3 = 3;
export const BATCH_NO = 9;    // 我们不要的（softfloat / writebarrier / 诊断格）

/**
 * 通道表。**次序就是 Go 那张表的次序**，一格不许挪 —— 挪了要先改 PASS_ORDER 并跑自检。
 * `fn` 为 null = 还没实现（跑到它就跳过，dump 里标 `todo`）。
 *
 * batch 的含义见上面；`req` 对应源码里的 `Required: true`。
 */
export const PASSES = [
  { name: 'number lines',              batch: BATCH_NO,  req: true,  fn: null },
  /* `inline` —— **这一格是我们加的，Go 的表里没有**：Go 在 SSA 之前就内联完了
   * （`internal/inline.InlineDecls`，前端的活），然后**才**建 SSA。我们没有那一层，
   * 所以它落在 MIR 上，位置照它在 Go 里的位置摆：**整张表的最前面**。
   *
   * 从前它排在 `decompose user` 紧前面（理由只写了"在 SROA 之前就行"），代价是量出来的：
   * 内联把按值实参铺成「`STORE 那一块的地址 -> 形参槽`」，紧跟着被调体里一条
   * `LOAD 形参槽`。而这两条之间**没有任何一格 mem2reg** —— `early phielim and copyelim`
   * 在它前面、`late phielim and copyelim` 在一百格之后。于是 `decompose user` 一路判
   * "地址存进了还有人读的 slot"就放弃整块：`radiance` 里 0 号帧块那 447 条访存一条都收不掉。
   * 挪到最前面之后，`early phielim` 正好就是"内联完再建一次 SSA"，与 Go 的次序反而对上了。
   *
   * 依赖仍然记在 PASS_ORDER 里（必须在 `decompose user` 之前）。 */
  { name: 'inline',                    batch: BATCH_1,   req: false, fn: null },
  { name: 'early phielim and copyelim',batch: BATCH_1,   req: false, fn: null },
  { name: 'early deadcode',            batch: BATCH_1,   req: false, fn: null },
  { name: 'short circuit',             batch: BATCH_2,   req: false, fn: null },
  { name: 'decompose user',            batch: BATCH_1,   req: true,  fn: null },
  { name: 'pre-opt deadcode',          batch: BATCH_1,   req: false, fn: null },
  { name: 'opt',                       batch: BATCH_1,   req: true,  fn: null },
  { name: 'zero arg cse',              batch: BATCH_1,   req: true,  fn: null },
  { name: 'opt deadcode',              batch: BATCH_1,   req: true,  fn: null },
  { name: 'generic cse',               batch: BATCH_1,   req: false, fn: null },
  { name: 'phiopt',                    batch: BATCH_2,   req: false, fn: null },
  { name: 'gcse deadcode',             batch: BATCH_1,   req: true,  fn: null },
  { name: 'nilcheckelim',              batch: BATCH_2,   req: false, fn: null },
  { name: 'prove',                     batch: BATCH_3,   req: false, fn: null },
  { name: 'divisible',                 batch: BATCH_3,   req: true,  fn: null },
  { name: 'divmod',                    batch: BATCH_3,   req: true,  fn: null },
  { name: 'middle opt',                batch: BATCH_1,   req: true,  fn: null },
  { name: 'known bits',                batch: BATCH_3,   req: false, fn: null },
  { name: 'early fuse',                batch: BATCH_2,   req: false, fn: null },
  /**
   * **`expand calls`（Go 的 `ssacompile/expand_calls.go`）—— 还空着，但设计定了。**
   *
   * Go 在那个文件开头把要做的四件事列清了：
   *   1. 每个**聚合实参**变成"拆开聚合、把零件传过去"
   *   2. 每个**聚合返回值**变成"从零件装配回来"
   *   3. 每个**多值出口**变成"拆开、分别返回零件"
   *   4. 进来的**聚合实参**变成"把零件装配起来"
   *
   * 为什么它是剩下最值钱的一格（量出来的，见 `sroa.js` 的 `OMNI_SROA_STAT` 与
   * `arm64/from_mir.js` 的 `OMNI_EMIT_STAT`）：
   *   - 后端每条 MIR op 只摊 1.1~1.6 条机器指令，寄存器分配覆盖率 99.3% ⇒ **后端没余量了**
   *   - smallpt 的 `radiance` 里 405 条访存，**321 条落在同一个帧块上** ——
   *     就是那份按值收进来的 `Ray`（48 字节、6 个 double）。它的地址交给了两个调用
   *     （递归的 `radiance` 与 `intersect`），于是 `sroa.js` 判整块逃逸、一条都不换
   *   - go 的同一个函数里聚合访存是 **0**：`Ray` 的 6 个 double 住 F0-F5
   *
   * **落点是这一格而不是前端**（HFA 那次栽过一回，记在 `tccgen.js` 的 `inRegs` 上）：
   * 前端的 `callArgs(what, params, variadic, ret, old)` 手上只有类型、没有被调的链接信息，
   * 所以调用方与被调方会各自按类型做决定 —— 一旦两边判据不同就串位。
   * 而这一格拿得到**整个模块**（`optimizeMir(mod)`），可以**同时**改被调的形参表与所有
   * 调用点，两侧一定一致。
   *
   * 做法（第 1 + 4 件，不需要给 MIR 加多值返回，先做这一半）：
   *   - 候选：被调 `g` 不是 `extern`/`decl`、不变参、**没有 `FADDR` 取它的地址**
   *     （取了地址就可能被模块外经指针调用，签名不能动）；
   *   - `g` 的某个形参是按值收的聚合（调用点在那一格传 `ARGMEM`），
   *     而且它在 `g` 里的访问能摊成 ≤ K 个标量格子（照 `sroa.js` 的 `scanBase` 那套
   *     判据取格子的偏移与类型，Go 的 `MaxStruct = 4`，我们要到 6 才够 `Ray`）；
   *   - 改写 `g`：那一格形参换成 N 个标量形参；在 `g` 的开头划一个同样大小的帧块、
   *     把 N 个形参存进去、让原来那个形参槽装这一块的地址 —— **函数体一个字都不用改**，
   *     而这一块的地址从此不出 `g`，`sroa.js` 与槽位提升随后就能动它；
   *   - 改写每个调用点：`ARGMEM addr` 那一格换成 N 个标量实参，各自是 `MLOAD addr+off`。
   *
   * 第 2/3 件（聚合返回值、多值出口）要先给 MIR 加**多值返回**（Go 的 `OpSelectN`），
   * 那是另一格的事 —— 顺序上也该在第 1/4 件之后，与 Go 的注释同序。
   */
  { name: 'expand calls',              batch: BATCH_1,   req: true,  fn: null },
  { name: 'decompose builtin',         batch: BATCH_1,   req: true,  fn: null },
  { name: 'softfloat',                 batch: BATCH_NO,  req: true,  fn: null },
  { name: 'branchelim',                batch: BATCH_2,   req: false, fn: null },
  { name: 'late opt',                  batch: BATCH_1,   req: true,  fn: null },
  { name: 'dead auto elim',            batch: BATCH_1,   req: false, fn: null },
  { name: 'sccp',                      batch: BATCH_2,   req: false, fn: null },
  { name: 'generic deadcode',          batch: BATCH_1,   req: true,  fn: null },
  { name: 'late fuse',                 batch: BATCH_2,   req: false, fn: null },
  { name: 'check bce',                 batch: BATCH_NO,  req: false, fn: null },
  { name: 'dse',                       batch: BATCH_1,   req: false, fn: null },
  { name: 'memcombine',                batch: BATCH_3,   req: false, fn: null },
  { name: 'writebarrier',              batch: BATCH_NO,  req: true,  fn: null },
  { name: 'lower',                     batch: BATCH_1,   req: true,  fn: null },
  { name: 'addressing modes',          batch: BATCH_1,   req: false, fn: null },
  { name: 'late lower',                batch: BATCH_2,   req: true,  fn: null },
  { name: 'pair',                      batch: BATCH_3,   req: false, fn: null },
  { name: 'lowered deadcode for cse',  batch: BATCH_1,   req: false, fn: null },
  /* `lowered cse` —— 2026-09-21 一度以为它在浮点那一类上是负的（raytrace 227→267ms），
   * **那个数是假的**：同一个二进制过一会儿再量是 216ms。编译刚跑完就计时，机器还在忙
   * （min-of-7 交错也挡不住这一格）。重量之后三档 216/218/218ms —— 它是**中性**的。
   * 留这一句在这儿是免得下一次又照那个假数把它挪档。要判它到底值不值，得等 regalloc
   * 有 spill 代价模型（Go 的 `ssacompile/regalloc.go` 的 `spillCost`/`desired`）之后
   * 在 smallpt 那一档上量，那儿 FP 压力最大。 */
  { name: 'lowered cse',               batch: BATCH_2,   req: false, fn: null },
  { name: 'elim unread autos',         batch: BATCH_1,   req: false, fn: null },
  { name: 'tighten tuple selectors',   batch: BATCH_2,   req: true,  fn: null },
  { name: 'lowered deadcode',          batch: BATCH_1,   req: true,  fn: null },
  { name: 'checkLower',                batch: BATCH_1,   req: true,  fn: null },
  { name: 'loop invariant',            batch: BATCH_3,   req: false, fn: null },
  { name: 'late phielim and copyelim', batch: BATCH_1,   req: false, fn: null },
  { name: 'tighten',                   batch: BATCH_2,   req: true,  fn: null },
  { name: 'late deadcode',             batch: BATCH_1,   req: false, fn: null },
  { name: 'critical',                  batch: BATCH_1,   req: true,  fn: null },
  { name: 'phi tighten',               batch: BATCH_2,   req: false, fn: null },
  { name: 'likelyadjust',              batch: BATCH_2,   req: false, fn: null },
  { name: 'layout',                    batch: BATCH_1,   req: true,  fn: null },
  { name: 'schedule',                  batch: BATCH_1,   req: true,  fn: null },
  { name: 'late nilcheck',             batch: BATCH_2,   req: false, fn: null },
  { name: 'flagalloc',                 batch: BATCH_1,   req: true,  fn: null },
  { name: 'regalloc',                  batch: BATCH_1,   req: true,  fn: null },
  { name: 'loop rotate',               batch: BATCH_2,   req: false, fn: null },
  { name: 'trim',                      batch: BATCH_1,   req: false, fn: null },
];

/**
 * 次序约束（照 Go 的 `passOrder`，`compile.go` 紧跟 passes 之后那一张）。
 * 这是**自检**，不是顺序本身 —— 顺序在 PASSES 里。
 */
export const PASS_ORDER = [
  ['generic cse', 'prove'],
  ['prove', 'generic deadcode'],
  ['prove', 'divisible'],
  ['divisible', 'divmod'],
  /* `generic cse` 必须在 `dse` 之前（`compile.go:506`）。这一条在我们这儿**尤其**要紧：
     dse 判"同一处"靠的是地址**同一个 ref**，而 `t[0]=1; t[0]=n;` 这两处的地址是
     两串一样的 `MUL`+`ADD` —— 不先 CSE 掉，dse 一条都删不掉（判据 dse.test.js 量到过）。 */
  ['generic cse', 'dse'],
  ['generic cse', 'nilcheckelim'],
  ['generic cse', 'tighten'],
  /* 我们自己加的那一格（`inline`）的依赖：内联把被调的局部块搬进调用者，SROA 才有东西可拆。 */
  ['inline', 'decompose user'],
  ['dse', 'lower'],
  ['expand calls', 'decompose builtin'],
  ['decompose builtin', 'lower'],
  ['lower', 'checkLower'],
  ['lower', 'addressing modes'],
  ['critical', 'layout'],
  ['layout', 'schedule'],
  ['schedule', 'flagalloc'],
  ['flagalloc', 'regalloc'],
  ['regalloc', 'trim'],
];

/** 启动自检：PASSES 里有没有重名；PASS_ORDER 的每一对是不是都满足。 */
export function checkPassTable() {
  const seen = new Map();
  for (let i = 0; i < PASSES.length; i++) {
    const n = PASSES[i].name;
    if (seen.has(n)) throw new Error(`mir/opt: 通道重名 "${n}"（第 ${seen.get(n)} 与第 ${i} 格）`);
    seen.set(n, i);
  }
  for (const pair of PASS_ORDER) {
    const ia = seen.get(pair[0]);
    const ib = seen.get(pair[1]);
    if (ia === undefined) throw new Error(`mir/opt: 约束里的 "${pair[0]}" 不在通道表里`);
    if (ib === undefined) throw new Error(`mir/opt: 约束里的 "${pair[1]}" 不在通道表里`);
    if (ia >= ib) throw new Error(`mir/opt: 次序约束不满足："${pair[0]}" 必须在 "${pair[1]}" 之前`);
  }
  return true;
}

/** 这一档要不要跑这一格。 */
function passEnabled(p, level, only) {
  if (only !== null && only.length > 0) return only.indexOf(p.name) >= 0;
  if (p.batch === BATCH_NO) return false;
  if (p.req) return true;             // required 的一律跑（Go 也是这样）
  return p.batch <= level;
}

/**
 * 跑管线。`opts`：
 *   level  0..3（默认从 OMNI_MIR_OPT 读，缺省 0）
 *   only   只跑这几格（名字数组）——做单格 A/B 用
 *   dump   跑完这一格之后打印（名字或 '*'）
 *   log    收集每格的统计（{name, ms, changed}）
 */
export function runPasses(fn, mod, opts) {
  const o = opts || {};
  const level = o.level === undefined ? 0 : o.level;
  const only = o.only === undefined ? null : o.only;
  const dump = o.dump === undefined ? null : o.dump;
  const log = o.log === undefined ? null : o.log;

  for (const p of PASSES) {
    if (!passEnabled(p, level, only)) continue;
    if (p.fn === null) {
      if (log !== null) log.push({ name: p.name, todo: true });
      continue;
    }
    const before = fn.op.length;
    const t0 = log === null ? 0 : performance.now();
    p.fn(fn, mod);
    const after = fn.op.length;
    if (log !== null) log.push({ name: p.name, todo: false, before, after, ms: performance.now() - t0 });
    if (dump === '*' || dump === p.name) {
      // 打印交给调用方（这一层不 import print.js，免得循环依赖）
      if (o.onDump) o.onDump(p.name, fn, mod);
    }
  }
  return fn;
}

/** 把一格实现挂上去（各 pass 文件在自己的模块里调这个注册）。 */
export function registerPass(name, fn) {
  for (const p of PASSES) {
    if (p.name === name) { p.fn = fn; return; }
  }
  throw new Error(`mir/opt: 通道表里没有 "${name}"`);
}

/** 现在实现了几格（给 dump / 进度用）。 */
export function passStatus() {
  let done = 0, want = 0;
  for (const p of PASSES) {
    if (p.batch === BATCH_NO) continue;
    want++;
    if (p.fn !== null) done++;
  }
  return { done, want, total: PASSES.length };
}
