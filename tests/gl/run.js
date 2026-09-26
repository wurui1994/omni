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

/* ── 第五节：**js 腿走同一台设备**（"自动 FFI"，2026-09-26）────────────────────
 *
 * `--backend js` 不编不链（改完立刻能跑），设备那一半靠那份 `.node`（`process.dlopen`）——
 * 也就是同一份 `omni_ev_gl.c`，只是进门的方式不同。这一节判三条：
 *   1. **没明说 `--gfx` 也走 GPU**：脚本里有着色器时 CLI 自己开 `gl` 那一档
 *      （从前 `omni run balls.pss` 当场报"CPU 备选没有可编程管线"）；
 *   2. **两条腿逐字节相同**：同一份 `.pss` 的第 2 帧，js 腿与原生腿一个字节都不差 ——
 *      这一条同时钉住那两条零拷贝的路（顶点 `ArrayBuffer` 进、像素 `readBytes` 出）；
 *   3. **js 腿也开得出窗口**（`--mode view`）：窗口那张帧缓冲里真有像素。
 */
{
  const src = join(ROOT, 'ext/polydraw/examples/04-shader.pss');
  const pj = join(out, '04-shader.js.rgba');
  const pc2 = join(out, '04-shader.c.rgba');
  /* 第一条：**一格 `--gfx` 都不给**（`OMNI_GFX` 也不给）—— 该由 CLI 自己认出着色器。 */
  const clean = { ...process.env };
  delete clean.OMNI_GFX;
  delete clean.OMNI_GFX_MODE;
  const rj = spawnSync(process.execPath,
    [join(ROOT, 'src/cli.js'), 'run', src, '--backend', 'js', '--frame', '2', '-o', pj],
    { encoding: 'utf8', cwd: ROOT, timeout: 120000, env: clean });
  if (rj.status !== 0 || !existsSync(pj)) {
    no('js 腿：没明说 --gfx 也自己走 GPU（自动 FFI）',
      `${(rj.stdout ?? '').trim()} ${(rj.stderr ?? '').trim()}`.slice(0, 300));
  } else if ((rj.stderr ?? '').includes('#gfx gl 挂不上')) {
    no('js 腿：没明说 --gfx 也自己走 GPU（自动 FFI）', (rj.stderr ?? '').trim().slice(0, 200));
  } else {
    const s = stat(pj);
    if (s.nz >= s.n * 0.9) ok('js 腿：没明说 --gfx 也自己走 GPU（自动 FFI）', `非黑 ${s.nz}/${s.n}`);
    else no('js 腿：没明说 --gfx 也自己走 GPU', `只画了 ${s.nz}/${s.n} 格（着色器没生效？）`);
    const rc = spawnSync(process.execPath,
      [join(ROOT, 'src/cli.js'), 'run', src, '--backend', 'c', '--frame', '2', '-o', pc2],
      { encoding: 'utf8', cwd: ROOT, timeout: 120000, env: { ...clean, OMNI_GFX: 'gl' } });
    if (rc.status !== 0 || !existsSync(pc2)) {
      no('js 腿与原生腿逐字节相同（同一台 GL 设备）', (rc.stderr ?? '').trim().slice(0, 200));
    } else {
      const a = rgba(pj);
      const b = rgba(pc2);
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      if (diff === 0) ok('js 腿与原生腿逐字节相同（顶点进、像素出，两条都是零拷贝）');
      else no('js 腿与原生腿逐字节相同', `${diff} 个字节不同`);
    }
  }
  /* 第三条：js 腿的窗口（`--mode view`）。开不出窗口的机器上跳过，与第四节同一档口径。 */
  const rv2 = spawnSync(process.execPath,
    [join(ROOT, 'src/cli.js'), 'run', src, '--backend', 'js', '--mode', 'view'],
    { encoding: 'utf8', cwd: ROOT, timeout: 120000,
      env: { ...clean, OMNI_FRAMES: '3', OMNI_GFX_WINDBG: '1' } });
  const ev2 = rv2.stderr ?? '';
  if (!ev2.includes('#gfx view 窗口')) {
    process.stdout.write('  --   js 腿这台机器上开不出窗口 —— 那一格跳过\n');
  } else {
    const m2 = /#gfx win 第 \d+ 帧 非黑 (\d+)\/(\d+)/.exec(ev2);
    if (m2 !== null && Number(m2[1]) > 0) {
      ok('js 腿也开得出窗口（`--mode view`，那份 .node 里的 winopen/winpresent）',
        `非黑 ${m2[1]}/${m2[2]}`);
    } else {
      no('js 腿也开得出窗口', `窗口那张帧缓冲里没量到像素（${ev2.trim().slice(0, 200)}）`);
    }
  }
}

/* ── 第六节：**3D 体素那一档**（`(x,y,z,&r,&g,&b)`，2026-09-26）──────────────────
 *
 * 口径见 `docs/design/eval-realtime-gpu.md` §34.5：单位立方体里的网格每格调一次，
 * 回值 `>0` 实心、颜色从 `&r,&g,&b` 拿；我们抽出表面那些面，一面一个四边形。
 *
 * 探针是个半径 .8 的实心球（颜色固定 (200,40,40)），判三条 —— 都是量出来的：
 *   1. **真画出来了**（非黑格数在一个球该占的区间里，不是全黑也不是铺满）；
 *   2. **重心在画布中心**（镜头看的是原点 —— 摆错了轴或者没摆镜头都会跑偏）；
 *   3. **颜色是脚本给的那一族**（R 明显大于 G/B）—— 钉住 `&r,&g,&b` 真传回来了，
 *      而不是拿调色板（2D 那两档的回值上色）画出来的。
 */
{
  const probe = join(out, 'vox3d.kc');
  writeFileSync(probe, '(x,y,z,&r,&g,&b)\nr=200; g=40; b=40;\n.64-(x*x+y*y+z*z);\n');
  const pv3 = join(out, 'vox3d.rgba');
  const r3 = spawnSync(process.execPath,
    [join(ROOT, 'src/cli.js'), 'run', probe, '--backend', 'c', '-o', pv3],
    { encoding: 'utf8', cwd: ROOT, timeout: 180000,
      env: { ...process.env, OMNI_GFX: 'gl', OMNI_GFX_MODE: 'render' } });
  if (r3.status !== 0 || !existsSync(pv3)) {
    no('3D 体素那一档真画出来了', `${(r3.stdout ?? '').trim()} ${(r3.stderr ?? '').trim()}`.slice(0, 300));
  } else {
    const b = rgba(pv3);
    const n = b.length / 4;
    let nz = 0;
    let sx = 0;
    let sy = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    const w = 320;
    for (let i = 0; i < b.length; i += 4) {
      if (!(b[i] | b[i + 1] | b[i + 2])) continue;
      nz++;
      sx += (i / 4) % w;
      sy += Math.floor((i / 4) / w);
      sr += b[i];
      sg += b[i + 1];
      sb += b[i + 2];
    }
    if (nz > n * 0.05 && nz < n * 0.6) ok('3D 体素那一档真画出来了（一个球该占的格数）', `非黑 ${nz}/${n}`);
    else no('3D 体素那一档真画出来了', `非黑 ${nz}/${n}（该在 5%~60% 之间）`);
    const cx = Math.round(sx / Math.max(nz, 1));
    const cy = Math.round(sy / Math.max(nz, 1));
    if (nz > 0 && Math.abs(cx - w / 2) <= 12 && Math.abs(cy - 120) <= 12) {
      ok('镜头看的是原点（重心在画布中心）', `重心 [${cx},${cy}]`);
    } else {
      no('镜头看的是原点', `重心 [${cx},${cy}]（该在 [160,120] 附近）`);
    }
    const ar = sr / Math.max(nz, 1);
    const ag = sg / Math.max(nz, 1);
    const ab = sb / Math.max(nz, 1);
    if (nz > 0 && ar > ag * 2 && ar > ab * 2) {
      ok('颜色是脚本那三格 `&r,&g,&b`（不是 2D 那两档的调色板）',
        `平均 (${Math.round(ar)},${Math.round(ag)},${Math.round(ab)})`);
    } else {
      no('颜色是脚本那三格 `&r,&g,&b`',
        `平均 (${Math.round(ar)},${Math.round(ag)},${Math.round(ab)})（R 该明显大）`);
    }
  }
}

/* ── 第七节：**EvalDraw 的 GL 子集用 EvalDraw 的相机**（`.kc`，2026-09-26）───────────
 *
 * 那门语言的 `glBegin/glVertex` **不是 OpenGL**（`evaldraw.txt:1641`）：跟的是它自己那套
 * 3D 相机（`setcam`/`setview`：**+z 是前、y 往下**），而且**没有 `glColor`** —— 顶点色就是
 * 当前 `setcol`。从前这一族按 OpenGL 那套走（-z 是前、顶点色默认 0），于是 45 份用
 * `glBegin` 的 `.kc` 画出来**全黑**（几何在镜头背后 + 颜色是黑的）。
 *
 * 探针两块四边形：z=+4 那块（红）该看得见、z=-4 那块（绿）在镜头背后该看不见。
 */
{
  const probe = join(out, 'evgl.kc');
  writeFileSync(probe, '()\n{\n   setcol(0xff0000);\n   glBegin(GL_QUADS);\n'
    + '   glVertex(-1,-1,4); glVertex(1,-1,4); glVertex(1,1,4); glVertex(-1,1,4);\n'
    + '   glEnd();\n   setcol(0x00ff00);\n   glBegin(GL_QUADS);\n'
    + '   glVertex(-1,-1,-4); glVertex(1,-1,-4); glVertex(1,1,-4); glVertex(-1,1,-4);\n'
    + '   glEnd();\n}\n');
  const pe = join(out, 'evgl.rgba');
  const re = spawnSync(process.execPath,
    [join(ROOT, 'src/cli.js'), 'run', probe, '--backend', 'c', '-o', pe],
    { encoding: 'utf8', cwd: ROOT, timeout: 180000,
      env: { ...process.env, OMNI_GFX: 'gl', OMNI_GFX_MODE: 'render' } });
  if (re.status !== 0 || !existsSync(pe)) {
    no('.kc 的 glBegin 那一族走 EvalDraw 的相机',
      `${(re.stdout ?? '').trim()} ${(re.stderr ?? '').trim()}`.slice(0, 300));
  } else {
    const b = rgba(pe);
    let red = 0;
    let green = 0;
    for (let i = 0; i < b.length; i += 4) {
      if (b[i] > 200 && b[i + 1] < 60) red++;
      if (b[i + 1] > 200 && b[i] < 60) green++;
    }
    if (red > 2000 && green === 0) {
      ok('.kc 的 glBegin 那一族走 EvalDraw 的相机（+z 是前）+ 顶点色来自 setcol',
        `红 ${red} 格、绿 ${green} 格`);
    } else {
      no('.kc 的 glBegin 那一族走 EvalDraw 的相机',
        `红 ${red} 格（该有一大片）、绿 ${green} 格（该是 0：那块在镜头背后）`);
    }
  }
}

/* ── 第八节：**`.kc` 的纹理真贴上了**（`glsettex` + 内建那对的贴图版，2026-09-26）──
 *
 * EvalDraw 没有着色器：`glsettex(…)` 选一张图，接下来的多边形就该贴着它画
 * （`evaldraw.txt:1627`）。而设备内建那对**原来没有 sampler** ⇒ 那些面出来是纯白。
 * 现在多了一格内建贴图版（`batchprog(2)`）。
 *
 * 探针不碰外部素材：拿**静态数组**当纹理（`glsettex(buf,2,2)`，说明书那一档 ——
 * 一格一个纹素、24 位 RGB），红/蓝两色的棋盘贴满一格四边形。判两条：
 * 红蓝**都出现**（真采样了，不是平色），且没有第三种颜色（`GL_NEAREST` 那一档）。
 */
{
  const probe = join(out, 'evtex.kc');
  writeFileSync(probe, '()\n{\n   static buf[4] = {0xff0000, 0x0000ff, 0x0000ff, 0xff0000};\n'
    + '   glsettex(buf,2,2);\n   setcol(0xffffff);\n   glBegin(GL_QUADS);\n'
    + '   glTexCoord(0,0); glVertex(-1,-1,2);\n   glTexCoord(1,0); glVertex(1,-1,2);\n'
    + '   glTexCoord(1,1); glVertex(1,1,2);\n   glTexCoord(0,1); glVertex(-1,1,2);\n'
    + '   glEnd();\n}\n');
  const pt = join(out, 'evtex.rgba');
  const rt = spawnSync(process.execPath,
    [join(ROOT, 'src/cli.js'), 'run', probe, '--backend', 'c', '-o', pt],
    { encoding: 'utf8', cwd: ROOT, timeout: 180000,
      env: { ...process.env, OMNI_GFX: 'gl', OMNI_GFX_MODE: 'render' } });
  if (rt.status !== 0 || !existsSync(pt)) {
    no('.kc 的纹理真贴上了（内建那对的贴图版）',
      `${(rt.stdout ?? '').trim()} ${(rt.stderr ?? '').trim()}`.slice(0, 300));
  } else {
    const b = rgba(pt);
    let red = 0;
    let blue = 0;
    for (let i = 0; i < b.length; i += 4) {
      if (b[i] > 200 && b[i + 2] < 60) red++;
      if (b[i + 2] > 200 && b[i] < 60) blue++;
    }
    if (red > 500 && blue > 500) {
      ok('.kc 的纹理真贴上了（红蓝棋盘都采样到了）', `红 ${red} 格、蓝 ${blue} 格`);
    } else {
      no('.kc 的纹理真贴上了', `红 ${red} 格、蓝 ${blue} 格（都该有一大片 ——`
        + ' 纯白说明内建那对还是平色那一份）');
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（本机 OpenGL 设备）\n`);
process.exit(fail === 0 ? 0 : 1);

