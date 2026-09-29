/**
 * **EVAL 两门跑进一格 Worker**（任务 #39，口径 `docs/design/eval-realtime-gpu.md` §41）。
 *
 * 为什么要它：语料里二十几份脚本**自己在死循环里用 `refresh()` 驱动帧**
 * （`geeky/pi.kc` 的 `for(z=1;1;z+=2)`）。主线程上 `refresh()` 没法真等 —— 一等就把标签页
 * 冻住，所以那一档只有一道看门狗（1500ms 抛），那一族画不动。Worker 里**阻塞是合法的**，
 * 于是等待点可以真等：有 `SharedArrayBuffer` 就 `Atomics.wait`（跨源隔离的页面才有它，
 * §41.2 里量过），没有就忙等（误差 < 1ms，而且冻不了主线程）。
 *
 * 这一份只是**宿主那一侧的壳子**：设备与产物那两半一个字都不用改 ——
 * `studio/gfx-gl.js` 已经不认 DOM 与 rAF（§41.1），`studio/eval-live.js` 的 `runUnits`
 * 本来就只碰 `import()` 与 `process`。
 *
 * ## 消息（都带 `kind`，回的也带同一个 `kind`）
 *
 *     open  { canvas, w, h }        画布是 `transferControlToOffscreen()` 交过来的
 *     run   { main, units, assets } 跑一份按单元产物（`/api/units` 回的那几个 URL）
 *     shot  {}                      读回这一帧（判据用：非背景色几格、帧号、fps）
 *     input { v }                   推一次输入（`dev.setInput`）
 *     stop  {}                      停帧循环
 *
 * **画布只能交一次**（`transferControlToOffscreen` 在同一格 canvas 上第二次会抛），
 * 所以宿主那一侧换程序**不换 Worker**：`run` 可以发好几趟（每趟前 `dev.reset()`）。
 */

let DEV = null;
let INSTALL = null;
let LIVE = null;

/** 把这一帧的账算成几个数（判据要的就是它们，不是像素本身）。 */
function shotOf() {
  if (DEV === null) return { err: '设备还没开' };
  const s = DEV.snapshot();
  const p = DEV.perf();
  const bg = [s.bytes[0], s.bytes[1], s.bytes[2]];
  let other = 0;
  for (let i = 0; i < s.bytes.length; i += 4) {
    if (s.bytes[i] !== bg[0] || s.bytes[i + 1] !== bg[1] || s.bytes[i + 2] !== bg[2]) other += 1;
  }
  return {
    w: s.w, h: s.h, bg, other, frames: DEV.frames(), fps: p.fps, ms: p.ms,
    miss: DEV.misses(),
  };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.kind === 'open') {
      if (INSTALL === null) {
        const g = await import('./gfx-gl.js');
        INSTALL = g.installGlDevice;
      }
      DEV = INSTALL(m.canvas, m.w, m.h);
      /* **停的旗子**：脚本自己拿 `refresh()` 当帧循环那一族不回消息循环（`stop` 那封
         消息永远排不上），所以把那一块共享内存交给宿主 —— 它写 1 就能让那一族在下一格
         帧边界退出去。没跨源隔离时是 null（那一档只能 `terminate()`，见 §41.2）。 */
      self.postMessage({
        kind: 'open',
        dev: DEV === null ? null : DEV.kind,
        stop: DEV !== null && typeof DEV.stopBuf === 'function' ? DEV.stopBuf() : null,
      });
      return;
    }
    if (m.kind === 'run') {
      if (LIVE === null) LIVE = await import('./eval-live.js');
      LIVE.ensureProcess();
      globalThis.process.env.OMNI_GFX = 'host';
      if (DEV !== null) {
        DEV.reset();
        if (typeof DEV.setAssets === 'function') DEV.setAssets(m.assets ?? '');
        /* **每过一帧报一声**：脚本自己拿 `refresh()` 当帧循环的那一族**不会回来**
           （`run` 那封回信永远不发），宿主只能靠这一串 `tick` 知道它还活着。 */
        if (typeof DEV.setTick === 'function') {
          DEV.setTick((n) => { self.postMessage({ kind: 'tick', frames: n }); });
        }
        /* 帧号上限（`cap`，0 = 无上限）：给那一族一个出口，于是 `run` 能正常回信。 */
        if (typeof DEV.setCap === 'function') DEV.setCap(m.cap ?? 0);
      }
      const r = await LIVE.runUnits(m.main, m.units ?? []);
      self.postMessage({ kind: 'run', stdout: r.stdout, stderr: r.stderr, code: r.code });
      return;
    }
    if (m.kind === 'shot') { self.postMessage({ kind: 'shot', ...shotOf() }); return; }
    if (m.kind === 'input') {
      if (DEV !== null && typeof DEV.setInput === 'function') DEV.setInput(m.v);
      self.postMessage({ kind: 'input', ok: 1 });
      return;
    }
    if (m.kind === 'stop') {
      if (DEV !== null) DEV.stop();
      self.postMessage({ kind: 'stop', ok: 1 });
      return;
    }
    self.postMessage({ kind: m.kind, err: `不认识的消息 '${String(m.kind)}'` });
  } catch (e) {
    /* **错要按消息回去**，不能只丢给 `onerror`：宿主那一侧在 `await` 一格回信，
       不回的话它就那么挂着（判据里表现成超时，而不是"这一格坏了"）。 */
    self.postMessage({ kind: m === null || m === undefined ? '?' : m.kind, err: String(e && e.stack ? e.stack : e) });
  }
};
