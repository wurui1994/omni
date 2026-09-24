// tests/eval/perf.js —— **接了 GPU 后端之后的性能判据**（`docs/design/eval-realtime-gpu.md` §15）
//
// 口径（2026-09-24 用户定的）：**每个例子 ≤ 5s，而且不能比本机那份 c_impl 实现慢。**
// 参考就在这台机器上、同一颗 GPU、同一份脚本 —— 没有比它更硬的尺子：
//
//     /Users/wurui/Documents/polydraw/c_impl/build/polydraw-render x.pss --frame 0 --w W --h H -o out.png
//
// ## 量的是**二进制**，不是 `omni run`
//
// `omni run` 那条路每趟都要付编译器的启动账（这台机器上 node 空跑 0.42s、再 import
// 两百多份 ESM +0.3s），那与"接 GPU 后端快不快"是两件事。所以这份判据：
//   1. `omni build x.pss -o exe`（一次，时间记账但不判）；
//   2. 那个二进制跑 N 趟取**最小**（暖态，`OMNI_GFX=gl`）；
//   3. `polydraw-render` 跑 N 趟取**最小**；
//   4. 门槛：**二进制 ≤ 5s** 且 **二进制 ≤ c_impl**。
//
// 取最小而不是平均：这一层量的是"这台机器上它能跑多快"，抖动（调度、热）只会让数变大。
// 没有那份参考（不是这台机器 / 没编）就只判 5s 那条，并在账上说明。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/cli.js');
const OUT = join(ROOT, '.omni-cache', 'evalperf');
const REF = '/Users/wurui/Documents/polydraw/c_impl/build/polydraw-render';
const PSS = process.env.OMNI_PSS_DIR ?? '/Users/wurui/Documents/polydraw';

const argv = process.argv.slice(2);
const val = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const CFG = {
  reps: Number(val('--reps', '3')),
  w: val('--w', '320'),
  h: val('--h', '240'),
  cap: Number(val('--cap', '5')) * 1000,   /* 出图那一趟的硬上限（秒） */
  frames: val('--frames', '2000'),         /* 主脚本那一栏跑多少帧（要跑到 ≥100ms 才量得准） */
  fast: Number(val('--fast', '3')),        /* 主脚本那一栏至少要快几倍 */
  only: val('--only', ''),
};
const REF_EVAL = '/Users/wurui/Documents/polydraw/c_impl/build/polydraw-eval';

/* 判据那一组例子：我们自己那几份（2D / GL 立即模式 / 着色器 / 纹理）+ 语料里**重**的那几份
   （光线步进、GPGPU、几何着色器）—— 挑的是"要真算"的，不是最省的。 */
const CASES = [
  /* 主脚本那一栏（纯算术，不碰设备）—— 编译 vs 解释。 */
  'tests/eval/hot.pss',
  /* 出图那一栏：我们自己那几份（GL 立即模式 / 着色器 / 几何着色器 / 纹理）。 */
  'ext/polydraw/examples/02-gl.pss',
  'ext/polydraw/examples/04-shader.pss',
  'ext/polydraw/examples/05-shader-geom.pss',
  'ext/polydraw/examples/06-texture.pss',
  /* 语料里**重**的那几份（光线步进、GPGPU）。 */
  `${PSS}/tigrou/fractal.pss`,
  `${PSS}/tigrou/menger tower.pss`,
  `${PSS}/ken/gpgpu.pss`,
].filter((f) => CFG.only === '' || f.includes(CFG.only));


mkdirSync(OUT, { recursive: true });
let pass = 0;
let fail = 0;
const P = (s) => process.stdout.write(s);

/** 那份 GL 插件（`cli.js` 的 `glPlugin()` 编出来的）—— 二进制自己 dlopen 它。 */
const glLib = () => {
  const r = spawnSync('/bin/sh', ['-c',
    `ls -t "${join(ROOT, '.omni-cache/gl')}"/*/libomnigl.dylib 2>/dev/null | head -1`],
  { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
};

/**
 * 跑一趟，回**被测进程自己的墙上毫秒**（跑不起来把话放 why 里）。
 *
 * **用 `/usr/bin/time -p` 而不是父进程这侧的 `hrtime`**：量出来过，同一个二进制
 * 从 shell 里跑 0.15s、从 node 里 `spawnSync` 量到 **1.03s** —— 那 0.88s 是
 * `spawnSync` 自己的开销（起进程 + 收 stdio），与被测的东西半点关系没有。
 * 拿它当分子会把"我们比 c_impl 慢 4 倍"这种结论凭空造出来。
 */
function once(cmd, args, env) {
  const r = spawnSync('/usr/bin/time', ['-p', cmd, ...args],
    { encoding: 'utf8', cwd: ROOT, timeout: 120000, env });
  const m = /real\s+([\d.]+)/.exec(r.stderr ?? '');
  if (r.status !== 0 || m === null) {
    return { ms: Infinity, why: `${(r.stderr ?? '').trim().slice(0, 200)}` };
  }
  return { ms: Number(m[1]) * 1000, why: null };
}


/** 跑 N 趟取最小（第一趟只暖缓存，不计入）。 */
function best(cmd, args, env) {
  let why = null;
  let min = Infinity;
  for (let i = 0; i <= CFG.reps; i++) {
    const r = once(cmd, args, env);
    if (r.why !== null) { why = r.why; break; }
    if (i > 0 && r.ms < min) min = r.ms;
  }
  return { ms: min, why };
}

/** 这一份是**纯脚本**（不含图形调用）吗 —— 只有它能对照那份解释器，见第 5 步的注。 */
function pureScript(p) {
  const s = readFileSync(p, 'utf8').toLowerCase();
  return !/\b(gl[a-z]*\s*\(|cls\s*\(|setpix\s*\(|drawsph\s*\(|drawcone\s*\(|moveto\s*\(|lineto\s*\(|refresh\s*\(|printg\s*\()/.test(s);
}

const LIB = glLib();

const rows = [];
for (const src of CASES) {
  const name = basename(src);
  const exe = join(OUT, `${name.replace(/[^\w.-]/g, '_')}.bin`);
  /* 1. 编一趟（时间记账不判 —— 那是编译器的事，不是 GPU 那条路的事）。 */
  const b = once(process.execPath, [CLI, 'build', src, '-o', exe], process.env);
  if (b.why !== null || !existsSync(exe)) {
    fail++;
    P(`  FAIL ${name} 编得出二进制\n       ${b.why ?? '没产物'}\n`);
    continue;
  }
  /* 2. 我们这条腿（GPU 后端）取最小。 */
  const envGl = { ...process.env, OMNI_GFX: 'gl', OMNI_GFX_W: CFG.w, OMNI_GFX_H: CFG.h,
    OMNI_GFX_OUT: join(OUT, `${name}.png`), ...(LIB === '' ? {} : { OMNI_GL_LIB: LIB }) };
  const ours = best(exe, [], envGl);
  if (ours.why !== null) {
    fail++;
    P(`  FAIL ${name} 二进制跑得起来\n       ${ours.why}\n`);
    continue;
  }
  /* 3. 参考实现（同一颗 GPU、同一份脚本、同样离屏出一帧）。 */
  let ref = { ms: Infinity, why: '没有那份参考' };
  if (existsSync(REF)) {
    ref = best(REF, [src, '--frame', '0', '--w', CFG.w, '--h', CFG.h,
      '-o', join(OUT, `${name}.ref.png`)], process.env);
  }
  rows.push({ name, build: b.ms, ours: ours.ms, ref: ref.why === null ? ref.ms : null });
  /* 4. 出图那一趟的两条门槛（这一栏里 shader 那一半对双方**公平** —— 同一颗 GPU）。 */
  if (ours.ms <= CFG.cap) {
    pass++;
    P(`  ok   ${name} 出图 ≤ ${CFG.cap / 1000}s [${ours.ms.toFixed(0)}ms]\n`);
  } else {
    fail++;
    P(`  FAIL ${name} 出图 ≤ ${CFG.cap / 1000}s\n       量到 ${ours.ms.toFixed(0)}ms\n`);
  }
  if (ref.why !== null) {
    P(`  --   ${name} 出图与 c_impl 对照：跳过（${ref.why}）\n`);
  } else if (ours.ms <= ref.ms) {
    pass++;
    P(`  ok   ${name} 出图不慢于 c_impl [我们 ${ours.ms.toFixed(0)}ms / 参考 ${ref.ms.toFixed(0)}ms`
      + ` = ${(ours.ms / ref.ms).toFixed(2)}x]\n`);
  } else {
    fail++;
    P(`  FAIL ${name} 出图不慢于 c_impl\n       我们 ${ours.ms.toFixed(0)}ms / 参考 `
      + `${ref.ms.toFixed(0)}ms = ${(ours.ms / ref.ms).toFixed(2)}x\n`);
  }
  /* 5. **主脚本那一栏**（语言这一半，不画一个像素）：我们是编译到 C 的原生码，
     c_impl 那侧是**没做优化的解释器** —— 所以这儿的门槛不是"不慢"，而是**快几倍**。
     两边都是"把帧函数跑 N 趟"：我们 `--gfx null` + `OMNI_FRAMES=N`、
     那侧 `polydraw-eval -f x.pss -n N`。
     **只有不含图形调用的脚本算得数**：参考那侧无上下文时 `GLVERTEX`/`GLBEGIN` 那一族是
     **no-op stub**（`c_impl/src/pd_polyhost.c:6` 的注），拿含 GL 的脚本比等于比谁更会空转
     —— 那种例子这一栏直接跳过（它们的账在上面那一栏，那儿双方都真画）。 */
  const envNull = { ...process.env, OMNI_GFX: 'null', OMNI_FRAMES: CFG.frames };
  const oursS = pureScript(src) ? best(exe, [], envNull) : { ms: Infinity, why: '含图形调用' };
  let refS = { ms: Infinity, why: '没有那份参考' };
  if (oursS.why === null && existsSync(REF_EVAL)) {
    refS = best(REF_EVAL, ['-f', src, '-n', CFG.frames], process.env);
  }

  const last = rows[rows.length - 1];
  last.oursS = oursS.why === null ? oursS.ms : null;
  last.refS = refS.why === null ? refS.ms : null;
  if (oursS.why === '含图形调用') {
    P(`  --   ${name} 主脚本与 c_impl 对照：跳过（含图形调用 —— 那侧是 no-op stub，不公平）\n`);
  } else if (oursS.why !== null) {
    fail++;
    P(`  FAIL ${name} 主脚本那一栏跑得起来\n       ${oursS.why}\n`);
  } else if (refS.why !== null) {
    P(`  --   ${name} 主脚本与 c_impl 对照：跳过（${refS.why}）\n`);
  } else if (oursS.ms < 100 || refS.ms < 100) {
    /* `/usr/bin/time` 只有 10ms 的刻度 —— 跑不到 100ms 的那一格量出来的是噪声，
       不能当判据（把 `--frames` 提上去再量）。 */
    P(`  --   ${name} 主脚本与 c_impl 对照：跳过（${CFG.frames} 帧只跑了 `
      + `我们 ${oursS.ms.toFixed(0)}ms / 解释器 ${refS.ms.toFixed(0)}ms，刻度不够）\n`);
  } else if (oursS.ms * CFG.fast <= refS.ms) {
    pass++;
    P(`  ok   ${name} 主脚本比 c_impl 快 ≥${CFG.fast}x [我们 ${oursS.ms.toFixed(0)}ms / 解释器 `
      + `${refS.ms.toFixed(0)}ms = ${(refS.ms / oursS.ms).toFixed(1)}x]\n`);
  } else {
    fail++;
    P(`  FAIL ${name} 主脚本比 c_impl 快 ≥${CFG.fast}x\n       我们 ${oursS.ms.toFixed(0)}ms / `
      + `解释器 ${refS.ms.toFixed(0)}ms = 只快 ${(refS.ms / oursS.ms).toFixed(1)}x`
      + `（${CFG.frames} 帧）\n`);
  }

}

P('\n两栏账（都是取最小；编那一格不判，只记账）：\n');
P(`  出图一帧（GPU 那一半对双方公平）        主脚本 ${CFG.frames} 帧（我们编译 vs 它解释）\n`);
P('  我们(ms)  c_impl(ms)    比      我们(ms)  解释器(ms)    快   例子\n');
for (const r of rows) {
  const sx = r.oursS === null || r.refS === null ? '—' : `${(r.refS / r.oursS).toFixed(1)}x`;
  P(`  ${r.ours.toFixed(0).padStart(8)}  ${(r.ref === null ? '—' : r.ref.toFixed(0)).padStart(9)}`
    + `  ${(r.ref === null ? '—' : `${(r.ours / r.ref).toFixed(2)}x`).padStart(5)}`
    + `      ${(r.oursS === null ? '—' : r.oursS.toFixed(0)).padStart(6)}  `
    + `${(r.refS === null ? '—' : r.refS.toFixed(0)).padStart(9)}  ${sx.padStart(6)}   ${r.name}\n`);
}
P(`\n${pass} passed, ${fail} failed（出图 ≤ ${CFG.cap / 1000}s 且不慢于 c_impl；`
  + `主脚本要快 ≥${CFG.fast}x）\n`);
process.exit(fail === 0 ? 0 : 1);


