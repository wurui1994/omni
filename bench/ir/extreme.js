// bench/ir/extreme.js —— **极端例子**（smallpt）三条腿对照：我们 / luajit / node(v8)
//
// 为什么单开一个跑法：原版 smallpt 是 256×256、100spp，**跑不完**（分钟级）。
// 这儿把规模当参数：`--size` 改分辨率、`--samps` 改每像素采样（×4 才是 spp），
// 于是同一个程序可以在"几十毫秒"到"几秒"之间挪，时间可控。
//
// 三条腿跑的是**同一个算法、同一个 LCG、同样的运算次序**，所以校验和必须一样 ——
// 不一样就是真的差，不是"浮点就这样"。lua 那一份用元表算子重载，js 那一份用原型方法，
// 各自是本语言里人会写的形状。
//
// 用法：node bench/ir/extreme.js [--size 48] [--samps 1] [--runs 3]

import { buildRuntime, build, countRtCalls } from './build.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const WORK = '/tmp/omni-extreme';
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const SIZE = arg('size', 48);
const SAMPS = arg('samps', 1);
const RUNS = arg('runs', 3);
/* **预热**：同一个进程里重画 ITERS 遍。
 * 冷性能（进程启动 + 解释/基线 + 编译）与热性能（稳态）是两回事 ——
 * java/v8 这两条腿冷态里有一大截是 JVM/v8 起步与分层编译，只看冷态是不公平的。
 * 判据：跑 ITERS=1 得 T1，跑 ITERS=N 得 TN，**热态一遍 ≈ (TN − T1)/(N − 1)**。
 * 这个算法不需要程序里有时钟，每条腿都一样，所以可比。 */
const ITERS = arg('iters', 5);

mkdirSync(WORK, { recursive: true });

/** 把规模与遍数写进源码（各语言的配置行都在头上，形状固定） */
function scaled(path, kind, iters) {
  let src = readFileSync(path, 'utf8');
  if (kind === 'lua') {
    src = src.replace(/^local W, H, SAMPS = .*$/m, `local W, H, SAMPS = ${SIZE}, ${SIZE}, ${SAMPS}`)
             .replace(/^local ITERS = \d+.*$/m, `local ITERS = ${iters}`);
  } else if (kind === 'js') {
    src = src.replace(/^const W = .+;$/m, `const W = ${SIZE}, H = ${SIZE}, SAMPS = ${SAMPS};`)
             .replace(/^const ITERS = \d+;.*$/m, `const ITERS = ${iters};`);
  } else if (kind === 'c') {
    src = src.replace(/^const int W = .+;$/m, `const int W = ${SIZE}, H = ${SIZE}, SAMPS = ${SAMPS};`)
             .replace(/^const int ITERS = \d+;.*$/m, `const int ITERS = ${iters};`);
  } else if (kind === 'go') {
    src = src.replace(/^\tW     = \d+$/m, `\tW     = ${SIZE}`)
             .replace(/^\tH     = \d+$/m, `\tH     = ${SIZE}`)
             .replace(/^\tSAMPS = \d+$/m, `\tSAMPS = ${SAMPS}`)
             .replace(/^\tITERS = \d+$/m, `\tITERS = ${iters}`);
  } else if (kind === 'java') {
    src = src.replace(/^    static final int W = .+;$/m,
                      `    static final int W = ${SIZE}, H = ${SIZE}, SAMPS = ${SAMPS};`)
             .replace(/^    static final int ITERS = \d+;.*$/m, `    static final int ITERS = ${iters};`);
  }
  return src;
}

/** 跑 n 次取最快的那一次（墙上时间，毫秒） */
function timeIt(cmd) {
  let best = Infinity, out = null;
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    let o;
    try { o = execSync(cmd, { timeout: 600000, encoding: 'utf8' }); } catch (e) { return { ms: null, out: `<失败: ${String(e.message).slice(0, 60)}>` }; }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms < best) best = ms;
    out = o.trim();
  }
  return { ms: Math.round(best), out };
}

const CLANG = '/opt/homebrew/opt/llvm/bin/clang';
let rtCalls = null, aotStages = null;

/** 按给定遍数造出所有腿（sfx 区分产物名，一份 ITERS=1 一份 ITERS=N） */
function buildLegs(iters, sfx) {
  const luaSrc = scaled('bench/ir/suite/extreme/smallpt.lua', 'lua', iters);
  writeFileSync(`${WORK}/smallpt${sfx}.lua`, luaSrc);
  writeFileSync(`${WORK}/smallpt${sfx}.js`, scaled('bench/ir/suite/extreme/smallpt.js', 'js', iters));

  /* **C 基线**：知道上限在哪儿。同一个算法、结构体按值传、一次堆分配都没有。 */
  writeFileSync(`${WORK}/smallpt${sfx}.c`, scaled('bench/ir/suite/extreme/smallpt.c', 'c', iters));
  execSync(`${CLANG} -O2 ${WORK}/smallpt${sfx}.c -o ${WORK}/smallpt_c${sfx} -lm`);

  let goOk = false;
  try {
    writeFileSync(`${WORK}/smallpt${sfx}.go`, scaled('bench/ir/suite/extreme/smallpt.go', 'go', iters));
    execSync(`go build -o ${WORK}/smallpt_go${sfx} ${WORK}/smallpt${sfx}.go`);
    goOk = true;
  } catch (e) { console.error('Go build failed:', String(e.message).slice(0, 80)); }

  /* **Java** 腿 —— VM+JIT 这条路的上限就在这一档（HotSpot 的 C1/C2），
     它比 v8 更是我们 VM-JIT 腿该对的那把尺子。类名要跟着 sfx 换，免得两份 .class 撞。 */
  let javaOk = false;
  try {
    const cls = `Smallpt${sfx || 'C'}`;
    const jSrc = scaled('bench/ir/suite/extreme/Smallpt.java', 'java', iters)
      .replace(/\bSmallpt\b/g, cls);
    writeFileSync(`${WORK}/${cls}.java`, jSrc);
    execSync(`javac -d ${WORK} ${WORK}/${cls}.java`);
    javaOk = cls;
  } catch (e) { console.error('Java build failed:', String(e.message).slice(0, 80)); }

  /* **我们的 VM + JIT** 腿：编字节码 + 造 VM */
  let vmOk = false;
  try {
    execSync(`node tools/gen-bc-defs.js > src/core/lua/bc-defs.h`);
    execSync(`${CLANG} -O2 -o ${WORK}/omni-vm src/core/lua/vm.c -lm`);
    execSync(`node bench/lua/run.js ${WORK}/smallpt${sfx}.lua`, { cwd: process.cwd() });
    execSync(`cp /tmp/omni-lua-vm/prog.olbc ${WORK}/prog${sfx}.olbc`);
    vmOk = true;
  } catch (e) { console.error('VM-JIT build failed:', e.message.slice(0, 80)); }

  const rt = buildRuntime(WORK);
  const b = build(`smallpt${sfx || 'c'}`, luaSrc, WORK, rt, 'link');
  if (sfx === '') { try { rtCalls = countRtCalls(b.bin).total; aotStages = b.stages; } catch {} }

  return [
    ['C -O2', `${WORK}/smallpt_c${sfx}`],
    ...(goOk ? [['Go', `${WORK}/smallpt_go${sfx}`]] : []),
    ['ours(AOT)', b.bin],
    ...(vmOk ? [['ours(VM-JIT)', `${WORK}/omni-vm ${WORK}/prog${sfx}.olbc`]] : []),
    ...(javaOk ? [['java(hotspot)', `java -cp ${WORK} ${javaOk}`]] : []),
    ['luajit', `luajit ${WORK}/smallpt${sfx}.lua`],
    ['node(v8)', `node ${WORK}/smallpt${sfx}.js`],
    ['lua5.1', `lua ${WORK}/smallpt${sfx}.lua`],
  ];
}

const cold = buildLegs(1, '');
const warm = buildLegs(ITERS, 'w');

console.log(`\n=== smallpt  ${SIZE}x${SIZE}  ${SAMPS * 4} spp  (每格取 ${RUNS} 次最快；热态 = ${ITERS} 遍的边际) ===`);
if (aotStages) console.log(`编译（AOT 腿）：${aotStages.emit}ms 发射 + ${aotStages.translate}ms mlir-translate；运行时调用点 ${rtCalls}`);

const rows = [];
for (let i = 0; i < cold.length; i++) {
  const c = timeIt(cold[i][1]);
  const w = timeIt(warm[i][1]);
  /* 热态一遍 = (ITERS 遍那次 − 1 遍那次) / (ITERS − 1)：把进程启动与分层编译摘出去 */
  const hot = (c.ms !== null && w.ms !== null && ITERS > 1)
    ? Math.max(0, (w.ms - c.ms) / (ITERS - 1)) : null;
  rows.push({ name: cold[i][0], cold: c.ms, hot, out: c.out, outW: w.out });
}

const base = rows.find(r => r.name === 'C -O2');
const want = rows.map(r => r.out).filter(o => o && !o.startsWith('<'))[0];
console.log(`  ${'腿'.padEnd(13)} ${'冷态'.padStart(8)} ${'倍'.padStart(7)}   ${'热态/遍'.padStart(9)} ${'倍'.padStart(7)}`);
for (const r of rows) {
  const cr = (r.cold && base.cold) ? `${(r.cold / base.cold).toFixed(1)}x` : '';
  const hr = (r.hot !== null && base.hot) ? `${(r.hot / base.hot).toFixed(1)}x` : '';
  const ok = (r.out === want && r.outW === want) ? '✓' : `✗ ${(r.out || '').slice(0, 24)}`;
  console.log(`  ${r.name.padEnd(14)} ${String(r.cold ?? '—').padStart(6)}ms ${cr.padStart(7)}   `
    + `${(r.hot === null ? '—' : r.hot.toFixed(0)).padStart(7)}ms ${hr.padStart(7)}  ${ok}`);
}
console.log(`  校验和 ${want}（所有 ✓ 的腿一致，冷热两趟都比过）`);
