// tests/eval/perf.js —— **实时性判据**（`docs/design/eval-realtime-gpu.md` §15）
//
// 口径（2026-09-24 用户定的，两次纠正之后的最终版）：
//
//   **PolyDraw / EvalDraw 是为实时交互设计的 —— 几十年前的旧电脑上就做到 60fps。**
//   所以这一层要的不是"比谁快一点"，而是"**是不是实时**"：
//     1. **每帧 ≤ 16.7ms**（60fps）—— 不到这条线，做出来的就不是 evaldraw 的效果；
//     2. **改完脚本到看见画面的延迟要小**（编译时间算在里头）—— 交互式编辑的命门；
//     3. 所以**重要的模式是 LLVM JIT / tcc -run / 编到 JS**（尤其浏览器端），
//        **编译到 C 那条的整趟时间不重要**（cc 一趟一秒多，那条路是给"出成品"用的）；
//     4. **shader 渲染往往不是瓶颈**，而且 shader 那一半可以走 FFI 接动态库 ——
//        所以 GPU 那一档不是"慢"的来源，语言这一半与启动延迟才是。
//
// 与 c_impl 的对照仍然留着（那是唯一的外部尺子），但它只是一栏账，不是主判据：
//   * 出图一帧：`c_impl/build/polydraw-render`（同一颗 GPU，双方公平）；
//   * 主脚本：`polydraw-eval -f x.pss -n N`（它是没优化的解释器，我们编译到 C，
//     所以门槛是"快几倍"；而且只有**不含图形调用**的脚本算得数 —— 那侧无上下文时
//     `GLVERTEX`/`GLBEGIN` 是 no-op stub，见 `c_impl/src/pd_polyhost.c:6`）。
//
// ## 量法上的坑（踩过）
//
// **别拿父进程这侧的 `hrtime` 当分子**：同一个二进制从 shell 里跑 0.15s、从 node 里
// `spawnSync` 量到 1.03s —— 那 0.88s 是起进程 + 收 stdio 的开销。第一版判据就是这么量的，
// 于是"我们比 c_impl 慢 4.8 倍"这个结论是**工具造出来的**。现在一律 `/usr/bin/time -p`
// 包一层、读被测进程自己报的 `real`；每帧那个数直接读运行时自己印的 `#perf gfx` 行。
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
  /* 实时性那一栏：跑多少帧、每帧的线、启动延迟的线（毫秒）。 */
  rtFrames: val('--rt-frames', '120'),
  rtFrame: Number(val('--rt-frame-ms', '16.7')),
  rtStart: Number(val('--rt-start-ms', '1000')),
  only: val('--only', ''),
};
const REF_EVAL = '/Users/wurui/Documents/polydraw/c_impl/build/polydraw-eval';

/**
 * **实时那几种模式**（用户点名的三种在最前）：
 *   * `jit`  —— LLVM ORC JIT：不落文件、不等 cc；
 *   * `tcc`  —— `--backend c --cc tcc`（tcc 一趟就是几十毫秒，"tcc -run"那一档）；
 *   * `js`   —— 编到 JS 在本进程里跑（**浏览器端就是这一条**，所以"编译速度 + 执行速度"
 *               要一起算）；
 *   * `interp` —— 解释器（改一个字就能跑的那一档）；
 *   * `c`    —— cc 编译那条：**启动延迟不判**（它是出成品用的，一趟一秒多），
 *               但每帧那条线照判（它是帧时间的上限参考）。
 */
const MODES = [
  { id: 'jit', args: ['--backend', 'jit'], startJudged: true },
  { id: 'tcc', args: ['--backend', 'c', '--cc', 'tcc'], startJudged: true, needs: 'tcc' },
  { id: 'js', args: ['--backend', 'js'], startJudged: true },
  { id: 'interp', args: ['--backend', 'interp'], startJudged: true },
  { id: 'c', args: ['--backend', 'c'], startJudged: false },
].filter((m) => {
  /* 外部工具不在这台机器上就**跳过那一档**（与 GL 插件那格同一条口径：不算红）。
     `c` 那一档走的是**我们自带的 C 前端 + 自己的链接器**（`via self`），不需要外部 cc。 */
  if (m.needs === undefined) return true;
  const r = spawnSync('which', [m.needs], { encoding: 'utf8' });
  if (r.status === 0) return true;
  process.stdout.write(`  --   [${m.id}] 这台机器上没有 ${m.needs}，那一档跳过\n`);
  return false;
});



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

/* ── **实时性那一栏**（主判据，见文件头）─────────────────────────────────────────
 *
 * 每种模式跑两趟：一趟 1 帧（量"改完到看见画面"的延迟，编译算在里头）、
 * 一趟 N 帧（量每帧时间，读运行时自己印的 `#perf gfx` 行）。
 * 门槛：每帧 avg ≤ 16.7ms（60fps）；启动延迟 ≤ 1s（`c` 那条只记账 —— 它是出成品用的）。
 */
const RT_CASES = CASES.filter((f) => /02-gl|04-shader/.test(f));

/** 跑一趟 `omni run`，回 `{ real, avg, max, why }`（都是毫秒）。 */
function runMode(src, mode, frames) {
  const env = { ...process.env, OMNI_GFX: 'gl', OMNI_FRAMES: String(frames),
    OMNI_GFX_PERF: '1', OMNI_GFX_W: CFG.w, OMNI_GFX_H: CFG.h,
    OMNI_GFX_OUT: join(OUT, 'rt.png'), ...(LIB === '' ? {} : { OMNI_GL_LIB: LIB }) };
  const r = spawnSync('/usr/bin/time', ['-p', process.execPath, CLI, 'run', src, ...mode.args],
    { encoding: 'utf8', cwd: ROOT, timeout: 180000, env });
  const err = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const real = /real\s+([\d.]+)/.exec(r.stderr ?? '');
  if (r.status !== 0 || real === null) {
    const line = err.split('\n').find((l) => /error|Error|没有/.test(l)) ?? '';
    return { why: line.trim().slice(0, 160) || '跑不起来' };
  }
  const pf = /#perf gfx \S+ frames=(\d+) total=([\d.]+)ms avg=([\d.]+)ms min=([\d.]+)ms max=([\d.]+)ms/
    .exec(err);
  return { real: Number(real[1]) * 1000,
    avg: pf === null ? null : Number(pf[3]),
    max: pf === null ? null : Number(pf[5]),
    why: null };
}

P('\n实时性那一栏（每帧 ≤ 16.7ms = 60fps；启动 = 改完到看见画面，编译算在里头）：\n');
const rt = [];
for (const src of RT_CASES) {
  const name = basename(src);
  for (const mode of MODES) {
    const one = runMode(src, mode, 1);
    const many = one.why === null ? runMode(src, mode, CFG.rtFrames) : one;
    rt.push({ name, mode: mode.id, ...many, start: one.real });
    if (many.why !== null) {
      fail++;
      P(`  FAIL ${name} [${mode.id}] 跑得起来\n       ${many.why}\n`);
      continue;
    }
    if (many.avg === null) {
      fail++;
      P(`  FAIL ${name} [${mode.id}] 印得出每帧的账（#perf gfx）\n`);
      continue;
    }
    if (many.avg <= CFG.rtFrame) {
      pass++;
      P(`  ok   ${name} [${mode.id}] 每帧 ≤ ${CFG.rtFrame}ms `
        + `[avg ${many.avg.toFixed(1)}ms max ${many.max.toFixed(1)}ms]\n`);
    } else {
      fail++;
      P(`  FAIL ${name} [${mode.id}] 每帧 ≤ ${CFG.rtFrame}ms\n       avg `
        + `${many.avg.toFixed(1)}ms（max ${many.max.toFixed(1)}ms）= `
        + `${(1000 / many.avg).toFixed(0)}fps\n`);
    }
    if (!mode.startJudged) {
      P(`  --   ${name} [${mode.id}] 启动 ${one.real.toFixed(0)}ms（这条路不判 —— 出成品用的）\n`);
    } else if (one.real <= CFG.rtStart) {
      pass++;
      P(`  ok   ${name} [${mode.id}] 启动 ≤ ${CFG.rtStart}ms [${one.real.toFixed(0)}ms]\n`);
    } else {
      fail++;
      P(`  FAIL ${name} [${mode.id}] 启动 ≤ ${CFG.rtStart}ms\n       量到 ${one.real.toFixed(0)}ms\n`);
    }
  }
}

P('\n  启动(ms)  每帧avg(ms)  每帧max(ms)   fps   模式    例子\n');
for (const r of rt) {
  const fps = r.avg ? (1000 / r.avg).toFixed(0) : '—';
  P(`  ${(r.start === undefined ? '—' : r.start.toFixed(0)).padStart(8)}  `
    + `${(r.avg === null || r.avg === undefined ? '—' : r.avg.toFixed(1)).padStart(11)}  `
    + `${(r.max === null || r.max === undefined ? '—' : r.max.toFixed(1)).padStart(11)}  `
    + `${fps.padStart(4)}   ${r.mode.padEnd(6)}  ${r.name}${r.why ? `  （${r.why.slice(0, 40)}）` : ''}\n`);
}

P(`\n${pass} passed, ${fail} failed（实时性 + 与 c_impl 的两栏对照）\n`);
process.exit(fail === 0 ? 0 : 1);



