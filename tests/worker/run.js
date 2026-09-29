#!/usr/bin/env node
/**
 * tests/worker —— **EVAL 两门跑进一格 Worker**（任务 #39，口径 `docs/design/eval-realtime-gpu.md` §41）。
 *
 * 为什么单开一份判据：这一条是"**真浏览器 + `omni serve`**"那一格 —— 与 `tests/studio`
 * 不一样（那儿端的是单体 HTML、没有服务），也与 `tests/serve` 不一样（那儿只敲 HTTP、
 * 没有浏览器）。Worker 那条路要三样一起在：服务（`/eval-worker.js` 与 `/api/units`
 * 都是它发的）、真 WebGL2、以及**画布 `transferControlToOffscreen()` 交给 Worker**。
 *
 * 判的是七件事：
 *   1. Worker 里那台设备**开得起来**（`webgl2`，没有 DOM 也没有 rAF），而且**停的旗子在**
 *      （`SharedArrayBuffer` —— 服务发了 COOP/COEP 才有它，见 §41.2）；
 *   2. 按单元产物在 Worker 里**跑得起来**（`/api/units` -> `import(启动器 URL)`）；
 *   3. **真画上了**（读回来非背景色的格数够多）且一条 miss 都没有；
 *   4. **帧循环在 Worker 里是活的**（帧号在涨 —— 那一档没有 rAF，走的是 `setTimeout` 那条）；
 *   5. **脚本自己拿 `refresh()` 当帧循环**那一族（`selfloop.kc`）：给了帧上限就从帧边界
 *      退出去，退完 Worker 还答得出话（消息循环回来了）；
 *   6. 同一族不给上限时**按 60fps 一直转**（`Atomics.wait` 那条真等待点）；
 *   7. 宿主写一格共享内存里的旗子就能把它停下 —— 不用 `terminate()`（画布只能交一次，
 *      掐了 Worker 就连画布一起没了）；
 *   8. **输入也走那块共享内存**（`input.kc`：把鼠标写进去，那一列上就出现了十字与圆）。
 *
 * `playwright-cli` 不在仓库依赖里（是台机器上的工具），没装就**明着跳过**。
 */
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { startServer } from '../../src/core/serve.js';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log(`  ok   ${name}${note === undefined ? '' : ` [${note}]`}`); }
  else { fail++; console.log(`  FAIL ${name}${note === undefined ? '' : ` —— ${note}`}`); }
};

let havePw = true;
try { execFileSync('playwright-cli', ['--version'], { encoding: 'utf8', timeout: 20000 }); }
catch { havePw = false; }
if (!havePw) {
  console.log('  skip 这台机器上没有 playwright-cli');
  console.log('\n0 passed, 0 failed（EVAL 跑进 Worker）');
  process.exit(0);
}

const s = await startServer({ port: 0, root });
const S = '-s=worker-judge';
const pw = async (args) => (await execFile('playwright-cli', args,
  { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 })).stdout;

/* 页面里那一段：起 Worker、把画布交过去、编一份、跑、等几帧、读回来。
   写成一行行拼起来的串（`--raw eval` 收的是一格表达式）—— 与 tests/studio 那几节同一手。

   **`tick` 不占回信的位子**：脚本自己拿 `refresh()` 当帧循环的那一族**不会回来**
   （`run` 那封回信永远不发），Worker 靠 `tick` 报活；宿主这儿按 `kind` 分路，
   不然那一串 tick 会把等回信的那几个 resolver 吃掉（次序全乱）。 */
const PROBE = 'async () => {'
  + ' const w = new Worker("/eval-worker.js", { type: "module" });'
  + ' const box = [];'
  + ' let ticks = 0;'
  + ' let lastFrame = 0;'
  + ' w.onmessage = (e) => {'
  + '   const d = e.data;'
  + '   if (d !== null && d !== undefined && d.kind === "tick") { ticks += 1; lastFrame = d.frames; return; }'
  + '   const f = box.shift(); if (f !== undefined) f(d);'
  + ' };'
  + ' const ask = (m, tr) => new Promise((res) => { box.push(res); w.postMessage(m, tr ?? []); });'
  + ' const units = async (p) => (await (await fetch("/api/units", { method: "POST",'
  + '   headers: { "content-type": "application/json" },'
  + '   body: JSON.stringify({ path: p, lang: p.endsWith(".kc") ? "kc" : "pss" }) })).json());'
  + ' const c = document.createElement("canvas");'
  + ' c.width = 320; c.height = 240;'
  + ' c.style.position = "fixed"; c.style.left = "-9999px";'
  + ' document.body.appendChild(c);'
  + ' const off = c.transferControlToOffscreen();'
  + ' const opened = await ask({ kind: "open", canvas: off, w: 320, h: 240 }, [off]);'
  + ' const SH = opened.shared === null || opened.shared === undefined ? null'
  + '   : new Int32Array(opened.shared);'
  + ' const em = await units("ext/evaldraw/examples/draw2d.kc");'
  + ' if (em.main === null || em.main === undefined) {'
  + '   w.terminate();'
  + '   return { opened, err: (em.stderr || "没有 main").slice(0, 300) };'
  + ' }'
  + ' const ran = await ask({ kind: "run", main: em.main, units: em.units ?? [],'
  + '   assets: "ext/evaldraw/examples" });'
  + ' const s1 = await ask({ kind: "shot" });'
  + ' await new Promise((r) => setTimeout(r, 500));'
  + ' const s2 = await ask({ kind: "shot" });'
  + ' await ask({ kind: "stop" });'
  /* ---- 第二段：**脚本自己拿 refresh() 当帧循环**那一族（`selfloop.kc`）。
          先跑"有上限"那一趟（20 帧就从帧边界退出去，退完还得答得出话）；
          再跑"没上限"那一趟（它不回消息循环，只数 tick），最后**写那格共享内存里的旗子**
          把它停下 —— 停完再问一次话，证明 Worker 还在（画布没被 terminate 带走）。 ---- */
  + ' const sl = await units("ext/evaldraw/examples/selfloop.kc");'
  + ' ticks = 0;'
  + ' const capped = sl.main === null || sl.main === undefined ? { err: "没编出来" }'
  + '   : await ask({ kind: "run", main: sl.main, units: sl.units ?? [], cap: 20 });'
  + ' await new Promise((r) => setTimeout(r, 700));'
  + ' const cappedTicks = ticks;'
  + ' const cappedFrame = lastFrame;'
  + ' const s3 = await ask({ kind: "shot" });'
  + ' ticks = 0;'
  + ' const free = sl.main === null || sl.main === undefined ? { err: "没编出来" }'
  + '   : await ask({ kind: "run", main: sl.main, units: sl.units ?? [], cap: 0 });'
  + ' await new Promise((r) => setTimeout(r, 500));'
  + ' const t1 = ticks;'
  + ' await new Promise((r) => setTimeout(r, 300));'
  + ' const t2 = ticks;'
  + ' let t3 = -1; let t4 = -1;'
  + ' if (SH !== null) {'
  + '   Atomics.store(SH, 1, 1); Atomics.notify(SH, 0);'
  + '   await new Promise((r) => setTimeout(r, 300)); t3 = ticks;'
  + '   await new Promise((r) => setTimeout(r, 300)); t4 = ticks;'
  + ' }'
  + ' const s4 = await ask({ kind: "shot" });'
  /* ---- 第三段：**输入走共享内存**（那一族不回消息循环，`input` 那封消息排不上）。
          `input.kc` 在鼠标那一点画十字与圆 —— 把坐标写进共享内存，等两帧，
          读回那一点看有没有东西。 ---- */
  + ' let ink = -1; let ink2 = -1; let inw = "?";'
  + ' const ip = await units("ext/evaldraw/examples/input.kc");'
  + ' if (SH !== null && ip.main !== null && ip.main !== undefined) {'
  + '   Atomics.store(SH, 2, 200); Atomics.store(SH, 3, 80);'
  + '   Atomics.store(SH, 4, 0); Atomics.store(SH, 13, 1);'
  + '   Atomics.store(SH, 14, 1); Atomics.store(SH, 15, 1);'
  + '   await ask({ kind: "run", main: ip.main, units: ip.units ?? [], cap: 0 });'
  + '   await new Promise((r) => setTimeout(r, 300));'
  + '   const px = await ask({ kind: "pick", x: 200 });'
  + '   ink = px.err === undefined ? px.v : -2;'
  + '   inw = px.in === undefined || px.in === null ? "?" : JSON.stringify({ mx: px.in.mx, my: px.in.my });'
  /* 再把鼠标挪开（序号也推一格），同一列上就该什么都没有了 —— 这才叫"输入到了"。 */
  + '   Atomics.store(SH, 2, 60); Atomics.store(SH, 3, 80);'
  + '   Atomics.store(SH, 14, 2);'
  + '   await new Promise((r) => setTimeout(r, 250));'
  + '   const px2 = await ask({ kind: "pick", x: 200 });'
  + '   ink2 = px2.err === undefined ? px2.v : -2;'
  + ' }'
  + ' w.terminate();'
  + ' return { opened, ran, s1, s2, capped, cappedTicks, cappedFrame, s3,'
  + '   free, t1, t2, t3, t4, s4, ink, ink2, inw,'
  + '   iso: globalThis.crossOriginIsolated === true }; }';

try {
  try { await pw([S, 'open', s.url]); } catch { /* 这个名字的会话已经开着也行 */ }
  await pw([S, 'goto', s.url]);
  const r = JSON.parse(await pw([S, '--raw', 'eval', PROBE]));
  const cut = JSON.stringify(r).slice(0, 300);
  ok('Worker 里那台 WebGL2 设备开得起来（没有 DOM、没有 rAF），那块共享内存也在',
    r.opened !== undefined && r.opened.err === undefined && r.opened.dev === 'webgl2'
    && r.opened.shared !== null && r.opened.shared !== undefined,
    `${cut} iso=${r.iso}`);
  ok('按单元产物在 Worker 里跑得起来', r.ran !== undefined && r.ran.err === undefined
    && r.ran.code === 0, r.ran === undefined ? cut : `code=${r.ran.code} err=${JSON.stringify((r.ran.stderr ?? r.ran.err ?? '').slice(0, 200))}`);
  ok('Worker 里真画上了（非背景色格数够多、一条 miss 都没有）',
    r.s1 !== undefined && r.s1.err === undefined && r.s1.other > 2000
    && (r.s1.miss ?? []).length === 0,
    r.s1 === undefined ? cut : JSON.stringify(r.s1).slice(0, 200));
  /* **帧循环在 Worker 里是活的**：那一档没有 rAF，走的是 `setTimeout(…,16)` 那条
     （`gfx-gl.js` 的 `raf()`）。500ms 里 60Hz 该有三十来帧，判"多了十帧以上"就够
     （机器忙的时候也稳）。 */
  ok('帧循环在 Worker 里是活的（setTimeout 那条节拍）',
    r.s1 !== undefined && r.s2 !== undefined && r.s2.frames > r.s1.frames + 10,
    `${r.s1 === undefined ? '?' : r.s1.frames} -> ${r.s2 === undefined ? '?' : r.s2.frames}`);
  /**
   * **这一格才是任务 #39 的正事**：`selfloop.kc` 是"脚本自己拿 `refresh()` 当帧循环"
   * 那一族（语料里二十来份），主线程那一档只能被看门狗掐掉（`refresh()` 没法真等）。
   *
   * 给了帧上限（20）时它**从帧边界退出去**。数目是定死的：宿主那格节拍器进来一趟
   * 就是第 1 帧、脚本那个 `while` 里第一回 `refresh()` 只交图（口径同 CPU 备选那一档），
   * 于是从第二回起每回一帧 —— 帧号正好停在 20、`tick` 正好 19 声。退完还要**答得出话**
   * （`shot` 回来了）：那说明 Worker 的消息循环真的回来了，而不是卡在里头。
   * `other: 40` = `selfloop.kc` 那 40 格 `setpix`。
   */
  ok('自循环那一族：给了帧上限就从帧边界退出去，退完 Worker 还答得出话',
    r.capped !== undefined && r.capped.err === undefined && r.capped.code === 0
    && r.cappedFrame === 20 && r.cappedTicks >= 18 && r.cappedTicks <= 20
    && r.s3 !== undefined && r.s3.err === undefined && r.s3.frames === 20 && r.s3.other === 40,
    `帧号到 ${r.cappedFrame}、tick ${r.cappedTicks} 声、退完 shot=${JSON.stringify(r.s3).slice(0, 120)}`);
  /**
   * 不给上限时它**一直转**：500ms 里 tick 该有三十来声（60fps），再等 300ms 还在涨 ——
   * 那就是 `refresh()` 真等住了（`Atomics.wait`，页面跨源隔离所以有 SAB）。
   * 然后**写那格旗子**把它停下：tick 不动了，而 `shot` 还答得出话（Worker 活着、
   * 画布还在它手上 —— 不用 `terminate()`）。
   */
  ok('自循环那一族：不给上限就按 60fps 一直转（refresh 真等住了）',
    r.t1 > 15 && r.t2 > r.t1 + 8, `500ms ${r.t1} 声 -> 再 300ms ${r.t2} 声`);
  ok('自循环那一族：宿主写一格共享内存的旗子就能停下（不用 terminate）',
    r.t3 > 0 && r.t4 === r.t3 && r.s4 !== undefined && r.s4.err === undefined
    && r.s4.fps > 50 && r.s4.fps < 70,
    `停之后 ${r.t3} -> ${r.t4} 声、停下那一刻 fps=${r.s4 === undefined ? '?' : r.s4.fps}`);
  /**
   * **输入也走那块共享内存**：`input.kc` 在 `(mousx, mousy)` 上画十字 + 半径 24 的圆。
   * 把 `(200, 80)` 写进共享内存（不发 `input` 那封消息），跑起来再数 x=200 那一列上
   * 有几格非背景色 —— 圆在那一列上就占四十几格，鼠标要是还在 (0,0) 就一格都没有。
   * 判"按列数"而不是"读某一点"：抓屏那一块的上下方向这一层不担保。
   */
  ok('输入走那块共享内存（不发消息也到得了脚本手里）',
    r.ink >= 3 && r.ink2 === 0, `鼠标在 x=200 时那一列 ${r.ink} 格、挪到 x=60 之后 ${r.ink2} 格`
    + `、设备手里的输入 ${r.inw}`);
} finally {
  await pw([S, 'close']).catch(() => {});
  if (typeof s.close === 'function') await s.close();
}

console.log(`\n${pass} passed, ${fail} failed（EVAL 跑进 Worker）`);
process.exit(fail === 0 ? 0 : 1);
