/**
 * **EVAL 两门（`.pss` / `.kc`）在 `omni serve` 那一档也跑在页面上** ——
 * 编译在服务端，**跑在浏览器的 WebGL2 上**（`docs/design/omni-serve-studio.md` §4.6）。
 *
 * 为什么要这一份：这两门语言的正事是**实时**。从前 serve 那一档是"产物在 node 那侧的工人里
 * 跑完，页面取回一帧表面贴上" —— 那是一张**静态图**，帧循环、输入、vsync 一格都没有，
 * 而页面上明明有一台 WebGL2 设备（单体 HTML 那一档用的就是它）。
 *
 * 这一份就是把那台设备接到 serve 那一档上，三步：
 *
 *   1. 服务端 `POST /api/units`（跑 `omni emit js <文件> --units --gfx host`）——
 *      落成**一目录按单元产物**：`ev_rt_<内容哈希>.js`（GL 状态机那一层，所有脚本共用）、
 *      入口那一份（几 KB）、`omni_rt.js`（编译器运行时，一目录一份）与一份启动器。
 *      画图那几格落成 `$gfx_call`/`$gfx_frame_fn`，它们找的是 `globalThis.__OMNI_GFX`；
 *   2. 页面把那台 WebGL2 设备装到 `__OMNI_GFX`（`gfx-gl.js` 的 `installGlDevice`）；
 *   3. `import(启动器 URL)` 跑一趟 —— 帧函数交给设备之后，帧循环是页面的
 *      `requestAnimationFrame`，于是**它是活的**；共用那两份由浏览器按 URL 缓存，
 *      每跑一趟过网的只有入口那几 KB（13KB 对 247KB）。
 *
 * 那份 JS 的宿主是照 node 写的（`process.env` / `process.stdout.write` / `process.exit`），
 * 所以这儿要一格**最小的 `process`**。单体 HTML 那一档页面上已经有一整套了
 * （`host/browser.js` 的 `installProcessShim`）—— 有就不动它，只把输出接出来。
 */

/** 收 stdout/stderr 的那一格（跑之前挂上，跑完摘掉）。 */
let SINK = null;

/**
 * 最小的 `process`：只装**那份产物真的会碰**的几格。
 *
 * 已经有一格（单体那一档）就不换 —— 换掉的话编译器那半边的状态就断了。
 */
function ensureProcess() {
  const wr = (s, err) => {
    if (SINK !== null) SINK(String(s), err);
    return true;
  };
  const cur = globalThis.process;
  if (cur !== undefined && cur !== null && typeof cur === 'object' && cur.env !== undefined) {
    /* 有了。把两条出口**包一层**（原来那一格照旧写它的，我们顺手抄一份给面板）。 */
    for (const [k, err] of [['stdout', false], ['stderr', true]]) {
      const s = cur[k];
      if (s === undefined || s === null || s.$wrapped === true) continue;
      const orig = typeof s.write === 'function' ? s.write.bind(s) : null;
      cur[k] = {
        $wrapped: true,
        write: (x) => { wr(x, err); return orig === null ? true : orig(x); },
        isTTY: false,
      };
    }
    return cur;
  }
  globalThis.process = {
    env: {},
    argv: ['omni', 'live'],
    platform: 'browser',
    pid: 1,
    exit: (c) => {
      const e = new Error(`exit ${c ?? 0}`);
      e.$exit = c ?? 0;
      throw e;
    },
    stdout: { $wrapped: true, write: (s) => wr(s, false), isTTY: false },
    stderr: { $wrapped: true, write: (s) => wr(s, true), isTTY: false },
    on: () => undefined,
  };
  return globalThis.process;
}

/**
 * 跑一份**按单元产物**（`/api/units` 回的那条启动器 URL）。
 *
 * 为什么是 `import(URL)` 而不是"把整份 JS 发过来再 eval"：启动器只有两百来字节，它
 * `import` 的那几份里**运行时那两格是所有脚本共用的**（`ev_rt_<内容哈希>.js` 与
 * `omni_rt.js`）—— 浏览器按 URL 缓存，于是每跑一趟真正过网的只有入口那几 KB
 * （量过：13KB 对 247KB，`docs/design/omni-serve-studio.md` §9.3）。
 *
 * 入口与启动器的名字里带内容哈希，所以"改一行再跑"一定是新 URL（模块登记表按 URL 记，
 * 名字不变的话页面拿到的还是上一份 —— 踩过这一格才把入口也按内容起名）。
 *
 * 回 `{ stdout, stderr, code }` —— 与 `/api/run` 那一格同一个形状，UI 那一侧两条腿
 * 走同一段代码。`process.exit(n)` 抛出来的那一格按 `code` 收下（不是错）。
 */
const SEEN = new Set();

export async function runUnits(mainUrl, units = []) {
  const outs = [];
  const errs = [];
  SINK = (s, err) => (err ? errs : outs).push(s);
  let code = 0;
  try {
    /* **换一个程序先清那张"具名函数当值用"的单件表**（`$fnOnesReset`，见 prelude 里
       那一格的注）：它按名字记、记的是闭着上一个程序模块作用域的薄适配器，而运行时
       那一份模块在这一页里**按 URL 只有一份**。不清的话第二份脚本会拿到第一份的
       适配器，调到上一个程序那份从没初始化的全局上 —— 不报错、帧还在涨、一个像素
       都不画（`text.kc` 就是这么被吃掉的）。 */
    if (typeof globalThis.$fnOnesReset === 'function') globalThis.$fnOnesReset();
    if (SEEN.has(mainUrl)) {
      /* **同一份内容再跑一趟**：URL 一个字都没变 ⇒ 模块登记表命中 ⇒ `import` **不会再执行**
         （量出来的样子是"过网 0 字节、可是一帧都没画"）。那时把各家的 `omni_init_…`
         按次序再调一遍就行：运行时那一层的全局清零、入口那一份把帧函数重新交给设备。 */
      for (const u of units) {
        const m = await import(u.url);
        const f = m[`omni_init_${u.name}`];
        if (typeof f === 'function') f();
      }
    } else {
      SEEN.add(mainUrl);
      await import(mainUrl);
    }
  } catch (e) {
    if (e !== null && e !== undefined && e.$exit !== undefined) code = e.$exit;
    else { errs.push(String(e && e.stack ? e.stack : e)); code = 1; }
  } finally {
    SINK = null;
  }
  return { stdout: outs.join(''), stderr: errs.join(''), code };
}

/** 装一台 WebGL2 设备（单体那一档页面上已经挂好了；serve 那一档现取现装）。 */
export async function installer() {
  if (typeof window.__OMNI_INSTALL_GL === 'function') return window.__OMNI_INSTALL_GL;
  const m = await import('./gfx-gl.js');
  return m.installGlDevice;
}

export { ensureProcess };
