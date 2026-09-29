#!/usr/bin/env node
/**
 * tests/worker —— **EVAL 两门跑进一格 Worker**（任务 #39，口径 `docs/design/eval-realtime-gpu.md` §41）。
 *
 * 为什么单开一份判据：这一条是"**真浏览器 + `omni serve`**"那一格 —— 与 `tests/studio`
 * 不一样（那儿端的是单体 HTML、没有服务），也与 `tests/serve` 不一样（那儿只敲 HTTP、
 * 没有浏览器）。Worker 那条路要三样一起在：服务（`/eval-worker.js` 与 `/api/units`
 * 都是它发的）、真 WebGL2、以及**画布 `transferControlToOffscreen()` 交给 Worker**。
 *
 * 判的是十件事（前八件自己起 Worker，后两件**照人那样用 Studio 那一页**）：
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
 *   8. **输入也走那块共享内存**（`input.kc`：把鼠标写进去，那一列上就出现了十字与圆）；
 *   9. **整条路**：在树上点开 `selfloop.kc` 按「跑」，状态栏上有 fps、页面上一台设备都没有
 *      （那就是"真的交给了 Worker"）；
 *  10. 一页**只开一格 Worker**（`wkOpen` 不许重入 —— 那一格坑查了四趟判据）。
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

   **回信按 `id` 配对**：脚本自己拿 `refresh()` 当帧循环的那一族**不会回来**
   （`run` 那封回信永远不发），Worker 靠 `tick` 报活。所以两件事都要：`tick` 不占回信的
   位子（它没有 `id`），而回信按来信那格 `id` 找人 —— 按"队头那个等着的人"配的话，
   那一封没来的回信会让之后每一封都错位。 */
const PROBE = 'async () => {'
  + ' const w = new Worker("/eval-worker.js", { type: "module" });'
  + ' const wait = new Map();'
  + ' let nid = 0;'
  + ' let ticks = 0;'
  + ' let lastFrame = 0;'
  + ' w.onmessage = (e) => {'
  + '   const d = e.data;'
  + '   if (d !== null && d !== undefined && d.kind === "tick") { ticks += 1; lastFrame = d.frames; return; }'
  + '   const f = wait.get(d.id); if (f !== undefined) { wait.delete(d.id); f(d); }'
  + ' };'
  + ' const ask = (m, tr) => { const id = ++nid;'
  + '   return new Promise((res) => { wait.set(id, res); w.postMessage({ ...m, id }, tr ?? []); }); };'
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
  /* **等第一帧真画完再抓**（`run` 回信只说"程序体跑完了"，画是宿主那格节拍器下一跳干的
     —— 不等的话偶尔抓到一张全黑，判据红在"真画上了"那一格）。 */
  + ' let s1 = await ask({ kind: "shot" });'
  + ' for (let i = 0; i < 60 && s1.frames < 1; i++) {'
  + '   await new Promise((r) => setTimeout(r, 20));'
  + '   s1 = await ask({ kind: "shot" });'
  + ' }'
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

/**
 * 第二段是**整条路**：不自己起 Worker，而是照人那样用 Studio 那一页 —— 在树上点开
 * `selfloop.kc`、按「跑」，然后看状态栏。`studio.js` 那一侧现在优先把 EVAL 两门交给
 * Worker（`wkOpen`），所以这一格判的是"那条接线真的接上了"：
 *
 *   * 状态栏先是 **`ok · Nms`**：这一族的 `run` **是回得来的** —— 产物入口把帧函数交给
 *     设备（`gfxframefn`）就返回了，脚本那个 `while(1)` 是在**帧函数里头**转的，
 *     不是在程序体里。（`在跑 …` 那句留给"程序体自己就不返回"的形状。）
 *   * 一秒后状态栏上**有 fps**（数是从 `tick` 里带回来的 —— 那一族答不出 `perf`）；
 *   * 预览栏里那格 canvas 在，而**页面上一台设备都没有**（`globalThis.__OMNI_GFX`
 *     是空的）—— 那就是"真的走了 Worker 那条腿"的证据。
 *
 * 从前这一族在页面上只能被看门狗掐掉（1500ms 抛一格错，画面就停在那儿）。
 */
const PAGE = 'async () => {'
  + ' const sleep = (ms) => new Promise((res) => setTimeout(res, ms));'
  /* **把递给 Worker 的消息记下来**（点「跑」之前就包上）：红的时候要分清"页面没发"、
     "发给了另一格 Worker"与"那边没动"。`open` 出现两回就是重入那一格坑的指纹。 */
  + ' const sent = [];'
  + ' const OW = window.Worker;'
  + ' window.Worker = class extends OW { constructor(u, o) { super(u, o);'
  + '   const op = this.postMessage.bind(this);'
  + '   this.postMessage = (m, tr) => { sent.push(String(m === null ? "?" : m.kind));'
  + '     return op(m, tr); }; } };'
  + ' const seg = document.querySelector(\'.seg [data-mode="ide"]\');'
  + ' if (seg !== null) seg.click();'
  + ' const path = "ext/evaldraw/examples/selfloop.kc";'
  + ' for (let i = 0; i < 12; i++) {'
  + '   const rows = [...document.querySelectorAll("#tree-body .row")];'
  + '   const f = rows.find((r) => r.title === path);'
  + '   if (f !== undefined) { f.click(); break; }'
  + '   const d = rows.find((r) => !r.classList.contains("file")'
  + '     && path.startsWith(r.title + "/") && r.getAttribute("aria-expanded") !== "true");'
  + '   if (d === undefined) return { err: "树上找不到那一份 .kc" };'
  + '   d.click();'
  + '   await sleep(30);'
  + ' }'
  /* **等到编辑框里真有那份源码**：路径先亮、文本后到。这一步少了的话按「跑」递过去的是
     空缓冲（页面按"改过了"把空文本当暂存递上去）—— 服务照样回 0，但那份程序什么都不干，
     于是判据看见的是"跑起来了却一帧都没有"。第一次就栽在这儿。 */
  + ' for (let i = 0; i < 150; i++) {'
  + '   if (document.querySelector("#cur-path").textContent === path'
  + '     && /refresh/.test(document.querySelector("#edit").value)) break;'
  + '   await sleep(20);'
  + ' }'
  + ' const btn = document.querySelector("#btn-run");'
  + ' if (btn.disabled) return { err: "跑不动（RUNNABLE 里没有 kc？）" };'
  + ' btn.click();'
  + ' let st1 = "";'
  + ' for (let i = 0; i < 240; i++) {'
  + '   st1 = document.querySelector("#status").textContent;'
  + '   if (st1 !== "跑…" && st1 !== "") break;'
  + '   await sleep(25);'
  + ' }'

  /* fps 要等两样：Worker 那边攒够半秒才结算一次，页面这边每半秒读一回 ——
     所以**盯着状态栏等**（最多 3 秒），别按死时间睡（机器忙的时候 1.2 秒不够）。 */
  + ' let st2 = "";'
  + ' for (let i = 0; i < 60; i++) {'
  + '   st2 = document.querySelector("#status").textContent;'
  + '   if (/fps/.test(st2)) break;'
  + '   await sleep(50);'
  + ' }'
  + ' const cv = document.querySelector("#preview canvas") !== null;'
  /* 分清走的是哪条腿：主线程那台设备会把自己挂在 `globalThis.__OMNI_GFX` 上，
     Worker 那一档页面上一台都没有。 */
  + ' const dev = globalThis.__OMNI_GFX !== undefined && globalThis.__OMNI_GFX !== null;'
  + ' const wk = globalThis.__OMNI_WK;'
  + ' let pr = "?";'
  + ' if (wk !== undefined && wk !== null) {'
  + '   pr = await new Promise((res) => {'
  + '     const h = (e) => { if (e.data !== null && e.data.id === 987654) {'
  + '       wk.w.removeEventListener("message", h); res(JSON.stringify(e.data)); } };'
  + '     wk.w.addEventListener("message", h);'
  + '     wk.w.postMessage({ kind: "perf", id: 987654 });'
  + '     setTimeout(() => res("没回话（那边在转）"), 800); });'
  + ' }'
  + ' const acct = wk === undefined || wk === null ? "?"'
  + '   : JSON.stringify({ frames: wk.frames, fps: Math.round(wk.fps * 10) / 10, ms: wk.ms,'
  + '     waiting: wk.wait.size });'
  + ' return { st1, st2, cv, dev, acct, pr, sent }; }';

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
  /* ---- 整条路：Studio 那一页自己把 EVAL 两门交给 Worker（见 `PAGE` 的头注）。 ---- */
  await pw([S, 'goto', s.url]);
  const g = JSON.parse(await pw([S, '--raw', 'eval', PAGE]));
  ok('Studio 那一页：点开自循环那一族按「跑」，它是活的（从前只能被看门狗掐掉）',
    g.err === undefined && g.cv === true && g.dev === false
    && (String(g.st1).startsWith('ok') || String(g.st1).startsWith('在跑'))
    && /fps/.test(String(g.st2)),
    `err=${g.err ?? '-'} 第一句「${g.st1}」 一秒后「${g.st2}」 画布=${g.cv}`
    + ` 页面上有设备=${g.dev} 那条腿的账=${g.acct} 直接问那边=${g.pr}`
    + ` 递过去的消息=${JSON.stringify(g.sent)}`);
  /* **只许开一格 Worker**：`open` 递了两回就是 `wkOpen` 重入（画布是后开那格的、`run`
     发给了前一格 —— 表现成"跑起来了但一帧都不动"）。这一格是那次查错留下的尺子。 */
  ok('Studio 那一页：一页只开一格 Worker（`wkOpen` 不许重入）',
    (g.sent ?? []).filter((k) => k === 'open').length === 1,
    `递过去的消息=${JSON.stringify(g.sent)}`);
} finally {
  await pw([S, 'close']).catch(() => {});
  if (typeof s.close === 'function') await s.close();
}

console.log(`\n${pass} passed, ${fail} failed（EVAL 跑进 Worker）`);
process.exit(fail === 0 ? 0 : 1);
