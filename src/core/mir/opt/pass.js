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
  { name: 'addressing modes',          batch: BATCH_2,   req: false, fn: null },
  { name: 'late lower',                batch: BATCH_2,   req: true,  fn: null },
  { name: 'pair',                      batch: BATCH_3,   req: false, fn: null },
  { name: 'lowered deadcode for cse',  batch: BATCH_1,   req: false, fn: null },
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
    p.fn(fn, mod);
    const after = fn.op.length;
    if (log !== null) log.push({ name: p.name, todo: false, before, after });
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
