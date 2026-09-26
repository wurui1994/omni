// tests/gl/run.js —— **本机 OpenGL 设备那一档的判据**（`src/runtime-gl/omni_ev_gl.c`）
//
// 口径在 `docs/design/eval-realtime-gpu.md` 第 13 节。这一档是**命令行那一侧的 GPU**：
// 浏览器那一档（WebGL2）早就通了，CPU 备选画得了几何、画不了着色器。
//
// 这份判据判两节，都不靠"看上去对"：
//   第一节（插件本身）
//   1. 那份插件在这台机器上**编得出来**（`clang -dynamiclib -framework OpenGL`）；
//   2. `dlopen` 挂上之后**离屏真拿到像素**：清成 `0x102030`、画一个裁剪空间的红三角，
//      读回来 **红 = 9600、背景 = 67200**（320×240 里三角占 1/8 —— 那两个数是算出来的，
//      所以它同时钉住"顶点是裁剪空间"这条契约）。
//   第二节（转发那一层，`OMNI_GFX=gl`）：真跑两份例子，`gl` 与 `host` 两档对比 ——
//   判据写在那一节的注里。
//
// 没有 `OpenGL.framework`（不是 macOS）就整份**跳过**，不算红 —— 与 `omni_r3.c` 那一侧
// "拿不到插件就回落 CPU"同一条口径。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0;
let fail = 0;
const ok = (s, extra) => { pass++; process.stdout.write(`  ok   ${s}${extra === undefined ? '' : ` [${extra}]`}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };

if (!existsSync('/System/Library/Frameworks/OpenGL.framework')) {
  process.stdout.write('  --   这台机器上没有 OpenGL.framework，本机 GL 那一档整份跳过\n');
  process.stdout.write('\n0 passed, 0 failed（本机 OpenGL 设备）\n');
  process.exit(0);
}

const out = join(ROOT, '.omni-cache/test-gl');
mkdirSync(out, { recursive: true });
const lib = join(out, 'libomnigl_ev.dylib');
const probe = join(out, 'probe');

const cc = (args) => spawnSync('clang', args, { encoding: 'utf8', cwd: ROOT });

const r1 = cc(['-O2', '-w', '-dynamiclib', '-o', lib,
  join(ROOT, 'src/runtime-gl/omni_ev_gl.c'), '-framework', 'OpenGL',
  /* 文件纹理的解码走 ImageIO（§20.2）—— 与 cli 那两处编插件的旗子一致。 */
  '-framework', 'ImageIO', '-framework', 'CoreGraphics', '-framework', 'CoreFoundation']);
if (r1.status !== 0) {
  no('插件编得出来', (r1.stderr ?? '').trim().slice(0, 300));
} else {
  ok('插件编得出来', 'libomnigl_ev.dylib');
  const r2 = cc(['-O2', '-w', '-o', probe, join(ROOT, 'tests/gl/probe.c')]);
  if (r2.status !== 0) {
    no('探针编得出来', (r2.stderr ?? '').trim().slice(0, 300));
  } else {
    const r3 = spawnSync(probe, [lib], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
    const line = (r3.stdout ?? '').trim();
    const m = /red=(\d+) bg=(\d+)/.exec(line);
    if (r3.status !== 0 || m === null) {
      no('离屏真拿到像素', `${line} ${(r3.stderr ?? '').trim()}`.slice(0, 300));
    } else {
      const red = Number(m[1]);
      const bg = Number(m[2]);
      ok('离屏真拿到像素（裁剪空间的红三角 + 背景）', line);
      if (red === 9600 && bg === 67200) ok('像素数与算出来的一样（红 9600 / 背景 67200）');
      else no('像素数与算出来的一样', `红 ${red}（要 9600）、背景 ${bg}（要 67200）`);
    }
  }
}

/* ── 第二节：**转发那一层**（`OMNI_GFX=gl`，§13.8）────────────────────────────────
 *
 * 判的是"真走了 GPU"而不是"图看上去对"：
 *   1. `02-gl.pss`（GL 立即模式那一族）在 `--gfx gl` 与 `--gfx host`（CPU 备选）两档上
 *      **非黑格数差 5% 以内** —— 两个渲染器，不逐字节；同时 `gl` 那趟 stderr 上不许有
 *      "挂不上 / 开不出来"（有的话它其实偷偷回落了 CPU，这条判据就成了自己判自己）；
 *   2. `draw2d.kc`（全是宿主那一侧的 2D：setpix/lineto/drawsph）两档**逐字节相同** ——
 *      钉住"GPU 那一层当底、宿主那一层盖上去"那格合成没有把 2D 弄坏。
 */
const rgba = (p) => {
  const b = readFileSync(p);
  return b.subarray(b.indexOf(10) + 1);   /* 头是一行 `#gbga 宽 高\n` */
};
const nonBlack = (b) => {
  let n = 0;
  for (let i = 0; i < b.length; i += 4) if (b[i] | b[i + 1] | b[i + 2]) n++;
  return n;
};
const runLeg = (src, mode, out) => spawnSync(process.execPath,
  [join(ROOT, 'src/cli.js'), 'run', join(ROOT, src), '--backend', 'c'],
  { encoding: 'utf8', cwd: ROOT, timeout: 120000,
    env: { ...process.env, OMNI_GFX: mode, OMNI_GFX_OUT: out } });

for (const [src, tol] of [['ext/polydraw/examples/02-gl.pss', 0.05],
  ['ext/evaldraw/examples/draw2d.kc', 0]]) {
  const name = src.slice(src.lastIndexOf('/') + 1);
  const pg = join(out, `${name}.gl.rgba`);
  const pc = join(out, `${name}.cpu.rgba`);
  const rg = runLeg(src, 'gl', pg);
  const rc = runLeg(src, 'host', pc);
  if (rg.status !== 0 || rc.status !== 0 || !existsSync(pg) || !existsSync(pc)) {
    no(`${name} 两档都跑得出一帧`, `${(rg.stderr ?? '').trim()} | ${(rc.stderr ?? '').trim()}`.slice(0, 300));
    continue;
  }
  const err = (rg.stderr ?? '');
  if (err.includes('#gfx gl')) {
    no(`${name} 真走了本机 GL（没回落）`, err.trim().slice(0, 200));
    continue;
  }
  ok(`${name} 真走了本机 GL（没回落 CPU 备选）`);
  const a = rgba(pg);
  const b = rgba(pc);
  const na = nonBlack(a);
  const nb = nonBlack(b);
  if (tol === 0) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    if (diff === 0) ok(`${name} 两档逐字节相同（宿主那一层的 2D 没被合成弄坏）`, `非黑 ${na}`);
    else no(`${name} 两档逐字节相同`, `${diff} 个字节不同（非黑 ${na} vs ${nb}）`);
  } else if (nb > 0 && Math.abs(na - nb) <= nb * tol) {
    ok(`${name} 与 CPU 备选结构一致（非黑格数差 ${tol * 100}% 以内）`, `gl ${na} / cpu ${nb}`);
  } else {
    no(`${name} 与 CPU 备选结构一致`, `非黑 gl ${na} vs cpu ${nb}（差要在 ${tol * 100}% 以内）`);
  }
}

/* ── 第三节：**着色器那一族**（§13.5 第 3 条）────────────────────────────────────
 *
 * 这三份 `.pss` 整幅图都在片元着色器里 —— CPU 备选一格都画不出来（`batchprog != 0`
 * 当场报），所以这一节判的就是"真编真画"那三条，与浏览器那一档同一套探针：
 *   铺满（非黑的比例）/ 片元真在算（不同颜色的个数，不是一片纯色）/
 *   uniform 真喂进去（第 0 帧与第 30 帧的图**不一样** —— 时间那格 uniform 在动）。
 */
const stat = (p) => {
  const b = rgba(p);
  const hist = new Set();
  let nz = 0;
  for (let i = 0; i < b.length; i += 4) {
    if (b[i] | b[i + 1] | b[i + 2]) nz++;
    hist.add((b[i] << 16) | (b[i + 1] << 8) | b[i + 2]);
  }
  return { n: b.length / 4, nz, colors: hist.size };
};
const runFrame = (src, outPath, frame) => spawnSync(process.execPath,
  [join(ROOT, 'src/cli.js'), 'run', join(ROOT, src), '--backend', 'c'],
  { encoding: 'utf8', cwd: ROOT, timeout: 120000,
    env: { ...process.env, OMNI_GFX: 'gl', OMNI_GFX_OUT: outPath,
      ...(frame === undefined ? {} : { OMNI_GFX_FRAME: String(frame) }) } });

/* 每份的两个下界（都比量到的数留了余量）：铺满的比例、不同颜色的个数。 */
for (const [name, minFill, minColors] of [['04-shader.pss', 0.9, 1000],
  ['05-shader-geom.pss', 0.05, 1000], ['06-texture.pss', 0.9, 500]]) {
  const src = `ext/polydraw/examples/${name}`;
  const p0 = join(out, `${name}.f0.rgba`);
  const r0 = runFrame(src, p0);
  if (r0.status !== 0 || !existsSync(p0)) {
    no(`${name} 在本机 GL 上真编真画`, (r0.stderr ?? '').trim().slice(0, 300));
    continue;
  }
  const s = stat(p0);
  if (s.nz >= s.n * minFill && s.colors >= minColors) {
    ok(`${name} 真编真画（铺满 + 片元真在算）`, `非黑 ${s.nz}/${s.n}、${s.colors} 种颜色`);
  } else {
    no(`${name} 真编真画`, `非黑 ${s.nz}/${s.n}（要 ≥ ${minFill}）、`
      + `${s.colors} 种颜色（要 ≥ ${minColors}）`);
  }
}

/* uniform 那一条单判一份（跑第二趟要钱，挑铺满那一份最省）。 */
{
  const src = 'ext/polydraw/examples/04-shader.pss';
  const p30 = join(out, '04-shader.pss.f30.rgba');
  const r30 = runFrame(src, p30, 30);
  const p0 = join(out, '04-shader.pss.f0.rgba');
  if (r30.status !== 0 || !existsSync(p30) || !existsSync(p0)) {
    no('04-shader.pss 的 uniform 真喂进去了', (r30.stderr ?? '').trim().slice(0, 300));
  } else {
    const a = rgba(p0);
    const b = rgba(p30);
    let d = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) d++;
    }
    if (d >= (a.length / 4) * 0.5) ok('04-shader.pss 的 uniform 真喂进去了（第 0 帧 ≠ 第 30 帧）', `${d} 格不同`);
    else no('04-shader.pss 的 uniform 真喂进去了', `只有 ${d} 格不同（时间那格 uniform 没动）`);
  }
}

/* ── 第四节：**窗口那一档**（`--mode view`，任务 #24）────────────────────────────
 *
 * 看不见窗口也要能判，所以四条都是**量出来的**：
 *   1. 真开出窗口 —— stderr 上有 `#gfx view 窗口 WxH`（开不出来会印 `#gfx view 开不出窗口`，
 *      那就整节**跳过**：没装 GLFW 的机器上不算红，与"挂不上就回落"同一档口径）；
 *   2. 窗口那张帧缓冲里**真有像素**（`OMNI_GFX_WINDBG=1` 印非黑格数，读在 swap 之前）；
 *   3. **view 与 render 两档逐字节相同** —— 这一条是这一刀的核心：窗口只是"多贴一步"，
 *      合成与画那条路一个字没改。挑 `02-gl.pss`（它不读 `klock`，所以 view 的墙上时钟
 *      与 render 的确定性时钟不影响这一比）；
 *   4. **输入来源是窗口，不是 `OMNI_MOUSE`**：探针脚本按 `mousx/mousy` 画个圆，
 *      `OMNI_MOUSE=1,2` 时 render 那趟圆心在 (1,2)，view 那趟**不在** ——
 *      光标不在窗口上就夹到边上，总之不听环境变量那一格。
 */
{
  const winRun = (src, file, extra) => spawnSync(process.execPath,
    [join(ROOT, 'src/cli.js'), 'run', src, '--backend', 'c'],
    { encoding: 'utf8', cwd: ROOT, timeout: 120000,
      env: { ...process.env, OMNI_GFX: 'gl', OMNI_GFX_MODE: 'view', OMNI_FRAMES: '3',
        OMNI_GFX_OUT: file, ...extra } });
  const offRun = (src, file, extra) => spawnSync(process.execPath,
    [join(ROOT, 'src/cli.js'), 'run', src, '--backend', 'c'],
    { encoding: 'utf8', cwd: ROOT, timeout: 120000,
      env: { ...process.env, OMNI_GFX: 'gl', OMNI_FRAMES: '3', OMNI_GFX_OUT: file, ...extra } });

  const pv = join(out, '02-gl.view.rgba');
  const rv = winRun(join(ROOT, 'ext/polydraw/examples/02-gl.pss'), pv, { OMNI_GFX_WINDBG: '1' });
  const ev = rv.stderr ?? '';
  if (!ev.includes('#gfx view 窗口')) {
    process.stdout.write('  --   这台机器上开不出窗口（没装 GLFW / 没有显示）—— 窗口那一节跳过\n');
  } else {
    ok('`--mode view` 真开出窗口', /#gfx view 窗口 \S+/.exec(ev)[0]);
    const m = /#gfx win 第 \d+ 帧 非黑 (\d+)\/(\d+)/.exec(ev);
    if (m !== null && Number(m[1]) > 0) {
      ok('窗口那张帧缓冲里真有像素（读在 swap 之前）', `非黑 ${m[1]}/${m[2]}`);
    } else {
      no('窗口那张帧缓冲里真有像素', `没量到（${ev.trim().slice(0, 200)}）`);
    }
    const pr = join(out, '02-gl.render.rgba');
    const rr = offRun(join(ROOT, 'ext/polydraw/examples/02-gl.pss'), pr);
    if (rr.status !== 0 || !existsSync(pv) || !existsSync(pr)) {
      no('view 与 render 两档都出得来一帧', (rr.stderr ?? '').trim().slice(0, 200));
    } else {
      const a = rgba(pv);
      const b = rgba(pr);
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      if (diff === 0) ok('view 与 render 两档逐字节相同（窗口只是多贴一步）');
      else no('view 与 render 两档逐字节相同', `${diff} 个字节不同`);
    }
    /* 输入来源。探针脚本写在缓存里（两句话，不值得进语料）。 */
    const probe = join(out, 'mouse.kc');
    writeFileSync(probe, '()\n{\n   cls(0,0,0);\n   setcol(255,255,255);\n'
      + '   drawsph(mousx,mousy,3);\n}\n');
    const center = (p) => {
      const b = rgba(p);
      let n = 0;
      let sx = 0;
      let sy = 0;
      const w = 320;
      for (let i = 0; i < b.length; i += 4) {
        if (!(b[i] | b[i + 1] | b[i + 2])) continue;
        n++;
        sx += (i / 4) % w;
        sy += Math.floor((i / 4) / w);
      }
      return n === 0 ? null : [Math.round(sx / n), Math.round(sy / n)];
    };
    const pm = join(out, 'mouse.view.rgba');
    const pc = join(out, 'mouse.render.rgba');
    winRun(probe, pm, { OMNI_MOUSE: '1,2' });
    offRun(probe, pc, { OMNI_MOUSE: '1,2' });
    const cv = existsSync(pm) ? center(pm) : null;
    const cr = existsSync(pc) ? center(pc) : null;
    /* 圆被画布边裁掉一半，所以**重心不等于圆心** —— 量到 (2,2) 而不是 (1,2)。
       所以这儿判"差 2 格以内"，别把裁剪当成读错了环境变量。 */
    const near = (c, x, y) => c !== null && Math.abs(c[0] - x) <= 2 && Math.abs(c[1] - y) <= 2;
    if (!near(cr, 1, 2)) {
      no('输入那一族：render 那一档听 OMNI_MOUSE', `重心 ${JSON.stringify(cr)}（该在 (1,2) 附近）`);
    } else if (cv !== null && cv[0] === cr[0] && cv[1] === cr[1]) {
      no('输入那一族：view 那一档听窗口（不是 OMNI_MOUSE）', '两档重心一样，说明还在读环境变量');
    } else {
      ok('输入那一族：view 听窗口、render 听 OMNI_MOUSE',
        `view ${JSON.stringify(cv)} / render ${JSON.stringify(cr)}`);
    }
    /* **view 那一档的 `klock()` 从"这一趟开跑"起算**，不是开机至今（2026-09-26）。
       正本里这个零点是 `qtim0`，在编译那一刻重置（`polydraw.c:2259`；1669 行注释写着
       "0=seconds since compile"）。从前 C 那侧回的是 `CLOCK_MONOTONIC`（开机至今）、
       js 那侧是 `Date.now()` —— 于是**按 `dtim` 走位的脚本第二帧就飞出画布**：
       `ken/balls.pss --mode view` 只闪一帧然后全黑。
       探针按 `dtim` 推一个点（每秒 10 像素），三帧之后它该还在起点附近；
       零点错的话头一帧的 `dtim` 是几十万秒，点早出画布了 ⇒ 全黑。 */
    const kp = join(out, 'klock.kc');
    writeFileSync(kp, '()\n{\n   static px = 40, tim = 0;\n'
      + '   otim = tim; tim = klock(); dtim = tim-otim;\n'
      + '   px += dtim*10;\n'
      + '   cls(0,0,0); setcol(255,255,255); drawsph(px,40,6);\n}\n');
    const pk = join(out, 'klock.view.rgba');
    winRun(kp, pk, {});
    const ck = existsSync(pk) ? center(pk) : null;
    if (ck === null) {
      no('view 那一档 klock 从 0 起（不是开机至今）', '三帧之后画布全黑：点飞出去了');
    } else if (Math.abs(ck[0] - 40) > 6 || Math.abs(ck[1] - 40) > 6) {
      no('view 那一档 klock 从 0 起（不是开机至今）', `重心 ${JSON.stringify(ck)}（该在 (40,40) 附近）`);
    } else {
      ok('view 那一档 klock 从"这一趟开跑"起算', `重心 ${JSON.stringify(ck)}`);
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（本机 OpenGL 设备）\n`);
process.exit(fail === 0 ? 0 : 1);

