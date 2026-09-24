#!/usr/bin/env node
/**
 * tests/studio —— **单体 HTML** 那一层的判据（`docs/design/omni-serve-studio.md` §6）。
 *
 * 量的是三件事，一件也不多：
 *
 *   1. **拼得出来**：`tools/bundle-studio.mjs` 跑通，且 HTML 里 CSS / JS 都内联了。
 *   2. **不依赖 node**：拼出来那份文件的**代码那一段**（内联的文件表之前）里，
 *      一个 `getBuiltinModule` / `require(` / `process.` 都不许有。
 *      为什么按位置切：内联的文档与例子里**会**出现 `node:fs` 这种字样（它们是数据，
 *      不是代码），整份 grep 必然假红。
 *   3. **真能跑**：拿 node 当浏览器壳子（塞一格 `window`），跑几个例子，
 *      **stdout 与本地 `omni run` 逐字节相同**。
 *      这一条是这一层唯一的真判据 —— 换宿主不许换答案。
 *   4. **真浏览器里也得跑**：`playwright-cli` 开这份页面，控制台一条错都不许有，
 *      同样那十八门的 stdout 还得逐字节相同。第 3 条看不见"浏览器独有的红"
 *      （node 上有 `process`，页面上没有）—— 那一类红两次都是靠这一条才现形的。
 *
 * 不装无头浏览器的依赖：`playwright-cli` 是台机器上的工具，没装就跳过第 4 条（会印出来）。
 */
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const work = join(root, '.omni-cache', 'work', 'studio-judge');

let pass = 0, fail = 0;
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${note ? ` —— ${note}` : ''}`); }
};

/* ---------------------------------------------------------------- 1. 拼得出来 */

const out = join('.omni-cache', 'work', 'studio-judge', 'omni-studio.html');
mkdirSync(work, { recursive: true });
execFileSync('node', [join(root, 'tools', 'bundle-studio.mjs'), '-o', out],
  { cwd: root, encoding: 'utf8', timeout: 180000 });
const html = readFileSync(join(root, out), 'utf8');

ok('拼出一份 HTML', html.length > 100000, `${html.length} 字节`);
/* **外链一格都不许剩**：`file://` 上取外部文件是跨源请求，浏览器直接拦
   （`已拦截跨源请求：…（原因：CORS 请求不是 http）`）。判的是"有没有 href 指向别的文件"，
   不是"有没有 `<link>`" —— 图标那一格是 `data:` 的内联 SVG，它不取任何东西。 */
const links = html.match(/<link[^>]*>/g) ?? [];
ok('CSS 内联了（没有外链）', html.includes('<style>')
  && links.every((l) => /href="data:/.test(l)), links.join(' ').slice(0, 200));
ok('JS 内联了（没有外链）', !html.includes('src="/studio.js"'));
ok('内联了文件表', html.includes('window.__OMNI_VFS'));
/* **`</script>` 只许有两个**（编译器那一段 + UI 那一段）。
   多出来的那个会把 script 提前收掉，后半截当 HTML 读 —— 页面白屏。
   来源是内联的**数据**：`ext/html/examples/02-canvas.html` 是一份真网页，里头就有一个。
   闸在 `tools/bundle-studio.mjs` 的 `vfsText`（`<` 一律写成 `\u003c`）。 */
const nEnd = (html.match(/<\/script>/g) ?? []).length;
ok('`</script>` 恰好两个（文件表没把 script 收掉）', nEnd === 2, `出现 ${nEnd} 次`);

/**
 * **每份语法都要有一张构好的 LR 表跟着**（`tools/bundle-studio.mjs` 的 `collectGlrTables`）。
 *
 * 为什么是判据而不是优化：表在 `glr/load.js` 里是内容寻址缓存的，而浏览器那条腿的缓存根
 * 是内存里那棵 `.omni-cache`（刷新就空）—— 没打包进去的话，页面上**每换一门语言**就要
 * 现构一张表。量出来（在浏览器壳子里跑第一趟）：`.jnc` 82ms -> **4482ms**、
 * `.asy` 1046 -> 1909ms、`.go` 58 -> 153ms。
 *
 * 判的是"一份语法一张表"这条对应关系，不是数字 —— 加一门语言时这一格会自己红。
 *
 * 切那一段用 **`lastIndexOf` 找行首那句赋值**：`window.__OMNI_VFS` 这串字样在别处
 * （`host/browser.js` 的自动挂载与它的头注）也出现，`indexOf` 会切到注释里去。
 */
{
  const AT = '\nwindow.__OMNI_VFS = ';
  const s = html.lastIndexOf(AT) + AT.length;
  const e = html.indexOf(';\n__req(', s);
  const vfs = JSON.parse(html.slice(s, e).replace(/\\u003c/g, '<'));
  const keys = Object.keys(vfs);
  const grammars = keys.filter((k) => k.endsWith('.grammar'));
  const tables = keys.filter((k) => k.startsWith('.omni-cache/glr/') && k.endsWith('/table.txt'));
  ok('每份语法都有一张构好的 LR 表打包进来了',
    grammars.length > 0 && tables.length >= grammars.length,
    `${grammars.length} 份语法、${tables.length} 张表`);
}

/* ---------------------------------------------------------------- 2. 不依赖 node */

const vfsAt = html.indexOf('window.__OMNI_VFS = ');
const code = html.slice(0, vfsAt);
/**
 * 代码段里**不许有** `getBuiltinModule` —— 那是"这份东西还在问 node 要模块"的唯一硬标志。
 *
 * 两处**刻意排除**，各有理由：
 *
 *   * `backend-js/prelude.js` 那一格。它导出的是**一大段源码文本**（JS 产物那条腿的宿主，
 *     `$js_*` 那 138 格），在 bundle 里是个字符串常量，浏览器里连 parse 都轮不到它。
 *     真去调它才会炸 —— 而"单体 HTML 只跑图那条腿"本来就写在设计文档 §5 里。
 *   * `process.`。`sroa.js` 里有个 `OMNI_SROA_STAT` 的调试开关 —— 在函数体里，页面上
 *     走不到。（`path.js` 的 `resolve` 从前也在这一列，现在它问的是封闭 ABI 的 `cwd()`：
 *     浏览器那条腿上根本没有 `process`，而 `LIB_DIR` 正是 `resolve` 算出来的 ——
 *     少了那一改，页面上 `import "std/turtle.omni"` 报 `no such module`。）
 *
 * 排除靠**切掉那一格模块**（从它的登记行到下一格登记行），不是靠"数得对不对" ——
 * 数字会随代码长而漂，而边界不会。
 */
const PRELUDE_AT = code.indexOf('__M["src/core/backend-js/prelude.js"]');
const afterPrelude = code.indexOf('\n__M["', PRELUDE_AT + 1);
const codeNoPrelude = PRELUDE_AT < 0 ? code
  : code.slice(0, PRELUDE_AT) + (afterPrelude < 0 ? '' : code.slice(afterPrelude));
ok('内联了 prelude（那一格是数据，不是代码）', PRELUDE_AT >= 0);
const nBuiltin = codeNoPrelude.split('getBuiltinModule').length - 1;
ok('除 prelude 之外没有 getBuiltinModule', nBuiltin === 0, `出现 ${nBuiltin} 次`);

/**
 * **UI 那一段也不许 import**（2026-09-22 漏过一次）。
 *
 * `studio.js` 把纯函数那一半分出去成了 `render.js`，于是它多了一条 `import … from
 * './render.js'` —— 服务那条路上没事，`file://` 上那是跨源请求，页面白着开不起来。
 * 上面第 3 节跑的是**第一段**（编译器那一侧），碰不到这一格，所以这儿单独判：
 * 拼出来的 UI 段里一条 import 都不许有，并且它得是从 `window.__OMNI_RENDER` 拿的
 * （`tools/bundle-studio.mjs` 的 `uiScript`）。
 */
{
  const ua = html.indexOf('<script type="module">', html.indexOf('window.__OMNI_VFS'));
  const uiSeg = ua < 0 ? '' : html.slice(ua, html.indexOf('</script>', ua));
  ok('UI 那一段一条 import 都没有', uiSeg.length > 1000 && !/(?:^|\n)[ \t]*import[\s({'"]/.test(uiSeg),
    (uiSeg.match(/(?:^|\n)[ \t]*import[\s({'"][^\n]*/) ?? ['段子没找到'])[0]);
  ok('UI 那一段从 window 上拿 render', uiSeg.includes('window.__OMNI_RENDER'));
  /**
   * **画廊在这一份里只摆它跑得动的**。
   *
   * 单体 HTML 挂的是整台 `runCli`（图那条腿 + `.js`），`.asy` 与 `.omni` 跑不了 ——
   * 摆上去就是一排红字，而展示模式的正事恰恰是"好看的例子摆出来"。所以 `renderGallery`
   * 按 `window.__OMNI_LOCAL` 在不在过一遍，剩下 glsl（WebGL 自己画）、html（iframe）
   * 与 **gfx（`.js` 真跑一趟，把那一帧表面贴到 canvas 上）**三类。
   * 这儿判两格：那道闸在拼出来的 UI 段里、且剩下的那几格确实一个服务都不用。
   */
  ok('画廊那道闸在（按 __OMNI_LOCAL 过一遍）', uiSeg.includes('__OMNI_LOCAL'));
  const { GALLERY } = await import(join(root, 'src', 'studio', 'gallery.js'));
  const offline = GALLERY.filter((g) => g.kind === 'glsl' || g.kind === 'html' || g.kind === 'gfx');
  const served = GALLERY.filter((g) => g.kind === 'asy' || g.kind === 'svg');
  ok('单体里剩下的画廊卡片一个服务都不用', offline.length >= 4
    && offline.every((g) => /\.(frag|vert|glsl|html|js)$/.test(g.path))
    && offline.length + served.length === GALLERY.length,
    `${offline.length} 格不用服务、${served.length} 格要服务、共 ${GALLERY.length}`);
}

/* ---------------------------------------------------------------- 3. 真能跑 */

/**
 * 把内联的那一段 JS 抠出来，前面塞一格 `window`，写成一份 `.mjs` —— node 就是浏览器壳子。
 *
 * 为什么能这么干：浏览器那条腿（`host/browser.js`）碰的全局只有 `window`（装文件表）
 * 与 `performance`（`upMs`），两样 node 上都有（前者我们自己塞）。
 * 于是这一趟跑的**就是页面上要跑的那份代码**，不是另一份。
 */
const a = html.indexOf('<script type="module">') + '<script type="module">'.length;
const b = html.indexOf('</script>', a);
const shell = join(work, 'shell.mjs');
writeFileSync(shell,
  'globalThis.window = globalThis;\n'
  + `${html.slice(a, b)}\n`
  + 'const r = await window.__OMNI_LOCAL("/api/run",\n'
  + '  { body: JSON.stringify({ argv: ["run", process.argv[2]] }) });\n'
  + 'process.stdout.write(r.stdout);\n'
  + 'process.stderr.write(r.stderr);\n'
  + 'process.exitCode = r.code;\n');

/**
 * 挑的例子：一门语言一份、都秒级（"判据要用最小的那一条"）。
 *
 * **两趟走的是同一台机器**：本地那一趟与浏览器这一趟都是
 * `adapter → 标准 IR → 公共 lower → .sx → OIR → 解释器`（ADR-0044）。
 * `.lua` 不在名单里：它默认走的是 lua 自己那台字节码 VM，拿它对照就是两台机器互比。
 */
const CASES = [
  /* 借来的那九门（adapter → 标准 IR → 公共 lower → `.sx` → OIR → 解释器） */
  'ext/go/examples/basics.go',
  'ext/chez/examples/basics.ss',
  'ext/awk/examples/basics.awk',
  'ext/nim/examples/basics.nim',
  'ext/vlang/examples/basics.v',
  'ext/sbcl/examples/basics.lisp',
  'ext/cpp/examples/basics.cpp',
  'ext/freebasic/examples/basics.bas',
  'ext/mojo/examples/basics.mojo',
  /* `ext/` 里那三格**用 JS 写的扩展**（`lang/builtin-web.js` 静态带进来的那几份）：
     少了它们，页面上报的是"不认识 basics.lua 这种扩展名"，而代码就在同一份 HTML 里。
     `.lua` 在这儿两边**是同一台机器**（node 那条腿也走 ext/lua 这份 JS 前端）。 */
  'ext/lua/examples/basics.lua',
  'ext/gsl-shell/examples/basics.lua',
  'ext/tiny/tests/hello.tiny',
  /* 自家那几门前端 —— 这一批是"单体只跑借来的语言"那条限制作废的证据 */
  'tests/sexpr/cases/01-core.sx',
  'tests/wat/cases/01-numeric.wat',
  'tests/js-exec/cases/01-expr.js',
  'tests/jnc/cases/01-pointers.jnc',
  'tests/asy/cases/01-arith.asy',
  'ext/omni/examples/koch.omni',
  /* **图形设备那一族**（`ext/js/lib/ege.js`）：stdout 上只有一行指针
     （`#gfx png …`），像素在那份 PNG 里 —— 两条腿上那一行要逐字节相同，
     而"图真在那儿"由后头真浏览器那一节判（它把那一帧取回来解开贴 canvas）。 */
  'ext/js/examples/01-shapes.js',
  'ext/js/examples/03-lissajous.js',
  /* **EVAL 那两门**（polydraw `.pss` / evaldraw `.kc`，同一份语法两张宿主表）：
     `.pss` 那格是"只算不画"（算术逐条核对）、`.kc` 那格用的是**方言里那格
     `(gfxframe …)`** —— 它在浏览器上走的是内存 VFS 与"Buffer 就是串"那条路，
     少一格就只有这儿会红（表面本身由后头真浏览器那一节取回来判）。 */
  'ext/polydraw/examples/01-arith.pss',
  'ext/polydraw/examples/02-gl.pss',
  'ext/evaldraw/examples/draw2d.kc',
  /* **C 那一侧的那套库**（`ext/jnc/lib/ege.jnc`）：一格画图、一格纯计算。
     画图那一格走的是方言 `(gfxframe …)` 的**指针那一档**（帧缓冲是 `int fb[N]`）。 */
  'ext/jnc/examples/01-shapes.jnc',
  'ext/jnc/examples/03-compute.jnc',
];

const WANT = new Map();
for (const c of CASES) {
  const refArgv = [join(root, 'src', 'cli.js'), 'run', c];
  try {
    WANT.set(c, execFileSync('node', refArgv, { cwd: root, encoding: 'utf8', timeout: 120000 }));
  } catch (e) {
    ok(`${c}（本地那一趟先得通）`, false, String(e.message).slice(0, 200));
  }
}

for (const c of CASES) {
  const want = WANT.get(c);
  if (want === undefined) continue;
  let got = null;
  try {
    const r = await execFile('node', [shell, c], { cwd: root, encoding: 'utf8', timeout: 180000 });
    got = r.stdout;
  } catch (e) {
    ok(`${c} 在浏览器那条腿上逐字节相同`, false,
      `跑不起来：${String(e.stderr ?? e.message).slice(0, 300)}`);
    continue;
  }
  ok(`${c} 在浏览器那条腿上逐字节相同`, got === want,
    `${JSON.stringify(got.slice(0, 120))} != ${JSON.stringify(want.slice(0, 120))}`);
}

/* ------------------------------------------------------------ 4. 真浏览器里也得跑 */

/**
 * **上面那一趟 node 当壳子看不见浏览器独有的那一类红**（2026-09-23 撞了两次）：
 *
 *   * `arm64/from_mir.js` 的**模块作用域**里有一句 `process.env.OMNI_EMIT_STAT` ——
 *     node 上有 `process`，那一趟绿；浏览器上第一段 module script 在那儿整个中断，
 *     于是 `window.__OMNI_LOCAL` / `__OMNI_RENDER` 一格都没装上，页面白屏。
 *   * `omni run` 最后一步是 `evalJs(发射出来的那份 JS)`，而那份 JS 的宿主
 *     （`backend-js/prelude.js`）是照 node 写的 —— 页面上**十八门全报**
 *     `process is not defined`，而 node 壳子里一门都不报。
 *
 * 所以这一节拿**真浏览器**跑：起一格只端 dist 的静态服务，`playwright-cli` 开页面，
 * 判两件事 —— 控制台一条错都没有、十八门的 stdout 与本地 `omni run` 逐字节相同。
 *
 * `playwright-cli` 不在仓库的依赖里（它是台机器上的工具），没装就**明着跳过**：
 * 判据不许因为环境缺一件东西就假红，但也不许假绿 —— 跳过会印出来。
 */
{
  let havePw = true;
  try { execFileSync('playwright-cli', ['--version'], { encoding: 'utf8', timeout: 20000 }); }
  catch { havePw = false; }
  if (!havePw) {
    console.log('  skip 真浏览器那一趟（这台机器上没有 playwright-cli）');
  } else {
    const srv = createServer((req, res) => {
      try {
        const body = readFileSync(join(work, req.url.split('?')[0].replace(/^\//, '')));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(body);
      } catch { res.writeHead(404); res.end('no'); }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/omni-studio.html`;
    const S = '-s=studio-judge';
    /* **必须是异步的那一档**（撞过一次）：服务就在这个进程里，`execFileSync` 一挡住事件
       循环，页面那边一个字节都收不到 —— 浏览器 60s 后报 `navigating … TimeoutError`。 */
    const pw = async (args) => (await execFile('playwright-cli', args,
      { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })).stdout;
    try {
      try { await pw([S, 'open', url]); } catch { /* 这个名字的会话已经开着也行 */ }
      await pw([S, 'goto', url]);
      const con = await pw([S, 'console', 'error']);
      ok('真浏览器里控制台一条错都没有', /Errors: 0/.test(con), con.trim().slice(0, 200));
      const probe = `async () => { const out = {}; for (const c of ${JSON.stringify(CASES)}) {`
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + ' { body: JSON.stringify({ argv: ["run", c] }) });'
        + ' out[c] = { o: r.stdout, e: r.stderr, code: r.code }; } return out; }';
      const got = JSON.parse(await pw([S, '--raw', 'eval', probe]));
      for (const c of CASES) {
        const want = WANT.get(c);
        if (want === undefined) continue;
        const g = got[c];
        ok(`${c} 在真浏览器里逐字节相同`, g !== undefined && g.o === want && g.code === 0,
          g === undefined ? '这一格没跑' : `code=${g.code} err=${JSON.stringify(g.e.slice(0, 160))}`);
      }
      /**
       * **图形设备那一格在真浏览器里是真跑通的**：跑一份例子，按它印出来的那行
       * 指针去 `/api/gfx` 取那一帧，**解开那份 PNG**（页面那一格解码器，
       * `render.pngToRgba`），再判"像素正好是 w*h*4 个字节、而且不是一张全黑"。
       *
       * 为什么要判"不全黑"：图是设备的产物，长度对、头对，都可能是一张没画上东西的
       * 空画布（`putpixel` 的裁剪写错一个符号就是那样）。
       *
       * **两份例子走的是两条不同的路**，所以两格都要判：
       *   * `.js` 那份的设备在**库**里（`ext/js/lib/ege.js`，用封闭 ABI 的 writeBinary）；
       *   * `.kc` 那份的设备在**方言**里（`(gfxframe …)` → `$gfx_frame`，走 node:fs 的门面
       *     与"Buffer 就是串"那条路）—— 它只有在真浏览器里才会现形。
       */
      for (const [f, why] of [['ext/js/examples/01-shapes.js', 'js 的 ege 库'],
        ['ext/evaldraw/examples/draw2d.kc', '方言的 gfxframe']]) {
        const gp = 'async () => { const r = await window.__OMNI_LOCAL("/api/run",'
          + ` { body: JSON.stringify({ argv: ["run", ${JSON.stringify(f)}] }) });`
          + ' const m = /#gfx (png|rgba) (\\S+) (\\d+) (\\d+)/.exec(r.stdout || "");'
          + ' if (m === null) return { err: (r.stderr || "没印指针").slice(0, 200) };'
          + ' const s = await window.__OMNI_LOCAL("/api/gfx?path=" + encodeURIComponent(m[2]));'
          + ' const img = s.kind === "png" ? window.__OMNI_RENDER.pngToRgba(s.bytes)'
          + '   : { w: s.w, h: s.h, body: s.bytes };'
          + ' let nz = 0; for (let i = 0; i < img.body.length; i += 4)'
          + '   if ((img.body.charCodeAt(i) | img.body.charCodeAt(i+1) | img.body.charCodeAt(i+2)) > 40) nz++;'
          + ' return { kind: s.kind, w: img.w, h: img.h, n: img.body.length, nz }; }';
        const gr = JSON.parse(await pw([S, '--raw', 'eval', gp]));
        ok(`真浏览器里图形设备交出了一帧图（${why}）`, gr.err === undefined
          && gr.kind === 'png' && gr.n === gr.w * gr.h * 4 && gr.nz > 1000,
        JSON.stringify(gr).slice(0, 200));
      }
      /**
       * **WebGL2 那一档设备**（浏览器里的默认，`docs/design/eval-realtime-gpu.md` 第 2.2 节）：
       * 页面自己建一格 canvas 装上设备（`window.__OMNI_INSTALL_GL`），把 `OMNI_GFX` 打到
       * `host`（于是画图落成 `(gfxcall …)`），跑一份 `.kc`，再 `readPixels` 回来判。
       *
       * 判的是**像素**，不是"跑通了没报错"：
       *   * 左上角那一格是背景色（脚本第一句 `cls(16,24,32)`）—— 清屏真的过了 GPU；
       *   * 有几千格是别的颜色 —— 图元真的画上了（顶点 -> 三角形/线段 -> 光栅化）。
       * 这一格是"默认直通 GPU"那条口径的判据 —— CPU 备选那一档在 tests/lower 里判。
       *
       * **要等一帧**：浏览器这一档的帧循环在 `requestAnimationFrame` 上（产物在主线程
       * 同步跑，不许 `while`），所以 `/api/run` 回来的那一刻**还没有画** ——
       * 等一次 rAF 再 `readPixels`。这一条踩过一次（判据红：整幅全黑）。
       */
      const wp = 'async () => {'
        + ' const c = document.createElement("canvas");'
        + ' c.style.position = "fixed"; c.style.left = "-9999px";'
        + ' document.body.appendChild(c);'
        + ' const dev = window.__OMNI_INSTALL_GL(c, 320, 240);'
        + ' globalThis.process.env.OMNI_GFX = "host";'
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + '   { body: JSON.stringify({ argv: ["run", "ext/evaldraw/examples/draw2d.kc"] }) });'
        + ' if (r.code !== 0) return { err: (r.stderr || "").slice(0, 300) };'
        + ' await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));'
        + ' const s = dev.snapshot();'
        + ' dev.stop();'
        + ' const bg = [s.bytes[0], s.bytes[1], s.bytes[2]];'
        + ' let other = 0;'
        + ' for (let i = 0; i < s.bytes.length; i += 4) {'
        + '   if (s.bytes[i] !== bg[0] || s.bytes[i+1] !== bg[1] || s.bytes[i+2] !== bg[2]) other++;'
        + ' }'
        + ' return { kind: dev.kind, frames: dev.frames(), w: s.w, h: s.h, bg, other }; }';
      const wr = JSON.parse(await pw([S, '--raw', 'eval', wp]));
      ok('真浏览器里 WebGL2 设备画出了这一帧（默认那一档）',
        wr.err === undefined && wr.kind === 'webgl2'
        && wr.bg !== undefined && wr.bg[0] === 16 && wr.bg[1] === 24 && wr.bg[2] === 32
        && wr.other > 2000,
        JSON.stringify(wr).slice(0, 240));
      /**
       * **实时那一格**（`requestAnimationFrame` 的帧循环）：产物把每帧那一格函数交给设备
       * （方言的 `(gfxframefn …)`），页面用 rAF 反复调 —— 所以"跑了几帧"不是我们数的，
       * 是浏览器按刷新率给的。
       *
       * 判三件事：**帧真的在往前走**（等 700ms，60Hz 上大约 42 帧，帧号要 > 3）、
       * `frames.kc` 画的圆随帧数长大（半径 = 帧数×20 —— 于是"金色格数"比头一帧大一截）、
       * **性能账真的在结算**（`dev.perf()`：fps > 0 且每帧耗时是个有限的数）——
       * 状态栏显示的就是这两个数（`studio.js` 的 `liveFpsStart`），它是"实时是核心"
       * 那条口径的判据。跑完 `stop()`，不让它一直在那儿画。
       */
      const rp = 'async () => {'
        + ' const c = document.createElement("canvas");'
        + ' c.style.position = "fixed"; c.style.left = "-9999px";'
        + ' document.body.appendChild(c);'
        + ' const dev = window.__OMNI_INSTALL_GL(c, 320, 240);'
        + ' globalThis.process.env.OMNI_GFX = "host";'
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + '   { body: JSON.stringify({ argv: ["run", "ext/evaldraw/examples/frames.kc"] }) });'
        + ' if (r.code !== 0) return { err: (r.stderr || "").slice(0, 300) };'
        + ' const f0 = dev.frames();'
        + ' await new Promise((res) => setTimeout(res, 700));'
        + ' const f1 = dev.frames();'
        + ' const p = dev.perf();'
        + ' const s = dev.snapshot();'
        + ' dev.stop();'
        + ' let gold = 0;'
        + ' for (let i = 0; i < s.bytes.length; i += 4) {'
        + '   if (s.bytes[i] > 200 && s.bytes[i+1] > 150 && s.bytes[i+2] < 120) gold++;'
        + ' }'
        + ' return { f0, f1, gold, fps: p.fps, ms: p.ms }; }';
      const rr = JSON.parse(await pw([S, '--raw', 'eval', rp]));
      ok('真浏览器里帧循环是活的（rAF 驱动、static 跨帧）',
        rr.err === undefined && rr.f1 > 3 && rr.gold > 4000,
        JSON.stringify(rr).slice(0, 240));
      ok('真浏览器里 fps 与每帧耗时是量出来的（状态栏显示的那两个数）',
        rr.err === undefined && rr.fps > 0 && Number.isFinite(rr.ms) && rr.ms >= 0,
        JSON.stringify(rr).slice(0, 240));
      /**
       * **输入那一族**（`mousx`/`mousy`/`bstatus`/`keystatus[k]`）：造真事件
       * （`dispatchEvent`），判设备收到了、而且**那一帧的图跟着变**。
       *
       * 这儿先 `dev.stop()` 再 `dev.step()` 走一帧：`input.kc` 里"消掉一次点击/一次按键"
       * （`bstatus--`、`keystatus[k]=0`）只在紧接着的那一帧成立，用 rAF 连着跑判不住
       * （帧号会在我们造事件的时候往前走）。
       *
       * 判三格：那一帧里十字/实心圆在鼠标位置上、方向键那条白线在、**再走一帧之后
       * 白线没了**（写回设备真的生效 —— 这是"一格 op 也能写宿主状态"那条设计的判据）。
       */
      const ip = 'async () => {'
        + ' const c = document.createElement("canvas");'
        + ' c.style.position = "fixed"; c.style.left = "-9999px";'
        + ' document.body.appendChild(c);'
        + ' const dev = window.__OMNI_INSTALL_GL(c, 320, 240);'
        + ' globalThis.process.env.OMNI_GFX = "host";'
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + '   { body: JSON.stringify({ argv: ["run", "ext/evaldraw/examples/input.kc"] }) });'
        + ' if (r.code !== 0) return { err: (r.stderr || "").slice(0, 300) };'
        + ' dev.stop();'
        + ' const b = c.getBoundingClientRect();'
        + ' const mk = (t, o) => c.dispatchEvent(new MouseEvent(t,'
        + '   Object.assign({ clientX: b.left + 200, clientY: b.top + 80, bubbles: true }, o)));'
        + ' mk("mousemove", {}); mk("mousedown", { button: 0 });'
        + ' window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowUp" }));'
        + ' const inp = dev.input();'
        + ' dev.step();'
        + ' const s1 = dev.snapshot();'
        + ' dev.step();'
        + ' const s2 = dev.snapshot();'
        + ' const px = (s, x, y) => { const o = (y * 320 + x) * 4;'
        + '   return [s.bytes[o], s.bytes[o+1], s.bytes[o+2]]; };'
        + ' const white = (s) => { let n = 0; for (let x = 20; x < 300; x++) {'
        + '   const p = px(s, x, 20); if (p[0] > 200 && p[1] > 200 && p[2] > 200) n++; } return n; };'
        + ' return { mx: Math.round(inp.mx), my: Math.round(inp.my), bst: inp.bst,'
        + '   dot: px(s1, 200, 80), w1: white(s1), w2: white(s2) }; }';
      const ir = JSON.parse(await pw([S, '--raw', 'eval', ip]));
      ok('真浏览器里输入那一族是活的（鼠标/按键位/键盘 + 写回去消掉一次）',
        ir.err === undefined && ir.mx === 200 && ir.my === 80 && ir.bst === 1
        && ir.dot !== undefined && ir.dot[0] > 200 && ir.dot[1] > 150 && ir.dot[2] < 120
        && ir.w1 > 200 && ir.w2 === 0,
        JSON.stringify(ir).slice(0, 240));
      /**
       * **GL 立即模式那一族在 WebGL2 上**（`02-gl.pss`：三角形 + LINE_LOOP + 矩阵栈里的
       * QUADS + POINTS）。判的是几格挑出来的像素，期望值**取自 CPU 备选那一档**
       * （`ext/polydraw/gl-rt.js` 跑出来的表面），容差 ±40：
       *   * 两边是两个光栅器（GPU 的 Gouraud vs 重心坐标），**不逐字节比** ——
       *     逐字节是同一条腿内的口径，跨渲染器拿来比会得出假结论；
       *   * 但"顶点变换 + 矩阵栈 + 顶点色插值"对不对，这几格像素说得清。
       * 另外数一行点：`GL_POINTS` 那 40 个点落在 y=234 上。
       */
      const gp2 = 'async () => {'
        + ' const c = document.createElement("canvas");'
        + ' c.style.position = "fixed"; c.style.left = "-9999px";'
        + ' document.body.appendChild(c);'
        + ' const dev = window.__OMNI_INSTALL_GL(c, 320, 240);'
        + ' globalThis.process.env.OMNI_GFX = "host";'
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + '   { body: JSON.stringify({ argv: ["run", "ext/polydraw/examples/02-gl.pss"] }) });'
        + ' if (r.code !== 0) return { err: (r.stderr || "").slice(0, 300) };'
        + ' await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));'
        + ' const s = dev.snapshot();'
        + ' dev.stop();'
        + ' const px = (x, y) => { const o = (y * 320 + x) * 4;'
        + '   return [s.bytes[o], s.bytes[o+1], s.bytes[o+2]]; };'
        + ' let dots = 0;'
        + ' for (let x = 0; x < 320; x++) { const p = px(x, 209);'
        + '   if (p[0] > 200 && p[1] > 200 && p[2] > 200) dots++; }'
        + ' return { mid: px(160, 120), red: px(100, 160), cyan: px(175, 160),'
        + '   green: px(160, 70), dots }; }';
      const gr2 = JSON.parse(await pw([S, '--raw', 'eval', gp2]));
      const near = (got, want) => got !== undefined
        && Math.abs(got[0] - want[0]) <= 40 && Math.abs(got[1] - want[1]) <= 40
        && Math.abs(got[2] - want[2]) <= 40;
      ok('真浏览器里 GL 立即模式画在 WebGL2 上（变换 + 矩阵栈 + 顶点色插值）',
        gr2.err === undefined && near(gr2.mid, [67, 119, 69]) && near(gr2.red, [211, 44, 0])
        && near(gr2.cyan, [0, 204, 230]) && near(gr2.green, [20, 213, 22]) && gr2.dots > 20,
        JSON.stringify(gr2).slice(0, 240));
      /**
       * **Studio 那一页本身**（不是绕开 UI 调 `/api/run`）：在树上点开一份 `.kc`、
       * 按"跑"，预览栏里该是**那格 WebGL2 画布**，而且帧循环在转。
       *
       * 这一条判的是 UI 那一段线接上了没有：后缀认不认（`LANG_OF`）、跑不跑得动
       * （`RUNNABLE`）、设备有没有在跑之前摆好（`OMNI_GFX=host` + `reset()`）、
       * 跑完那一栏有没有被"这一趟没有图"那条分支收掉。
       */
      const up = 'async () => {'
        + ' const sleep = (ms) => new Promise((res) => setTimeout(res, ms));'
        + ' document.querySelector(\'.seg [data-mode="ide"]\').click();'
        + ' const path = "ext/evaldraw/examples/frames.kc";'
        + ' for (let i = 0; i < 12; i++) {'
        + '   const rows = [...document.querySelectorAll("#tree-body .row")];'
        + '   const f = rows.find((r) => r.title === path);'
        + '   if (f !== undefined) { f.click(); break; }'
        + '   const d = rows.find((r) => !r.classList.contains("file")'
        + '     && path.startsWith(r.title + "/") && r.getAttribute("aria-expanded") !== "true");'
        + '   if (d === undefined) return { err: "树上找不到那一份 .kc（后缀没收进 TREE_ROOTS？）" };'
        + '   d.click();'
        + '   await sleep(20);'
        + ' }'
        + ' for (let i = 0; i < 100; i++) {'
        + '   if (document.querySelector("#cur-path").textContent === path) break;'
        + '   await sleep(20);'
        + ' }'
        + ' const lang = document.querySelector("#cur-lang").textContent;'
        + ' const btn = document.querySelector("#btn-run");'
        + ' if (btn.disabled) return { err: "跑不动（RUNNABLE 里没有这门？）lang=" + lang };'
        + ' btn.click();'
        + ' for (let i = 0; i < 200; i++) {'
        + '   const s = document.querySelector("#status").textContent;'
        + '   if (s === "ok" || s.startsWith("exit") || s === "失败") break;'
        + '   await sleep(25);'
        + ' }'
        + ' const status = document.querySelector("#status").textContent;'
        + ' await sleep(300);'
        + ' const dev = globalThis.__OMNI_GFX;'
        + ' const cv = document.querySelector("#preview canvas");'
        + ' const inPreview = cv !== null;'
        + ' const s = dev.snapshot === undefined ? null : dev.snapshot();'
        + ' let gold = 0;'
        + ' if (s !== null) { for (let i = 0; i < s.bytes.length; i += 4) {'
        + '   if (s.bytes[i] > 200 && s.bytes[i+1] > 150 && s.bytes[i+2] < 120) gold++; } }'
        + ' if (dev.stop !== undefined) dev.stop();'
        + ' return { lang, status, kind: dev.kind, inPreview, frames: dev.frames(), gold }; }';
      const ur = JSON.parse(await pw([S, '--raw', 'eval', up]));
      ok('Studio 那一页：点开 .kc 按「跑」，预览就是活的 WebGL2 画布',
        ur.err === undefined && ur.lang === 'kc' && ur.status.startsWith('ok')
        && ur.kind === 'webgl2' && ur.inPreview === true && ur.frames > 3 && ur.gold > 4000,
        JSON.stringify(ur).slice(0, 260));
      /**
       * **可编程管线**（`04-shader.pss`：`@v`/`@f` 区段 + `glsetshader` + `glgetuniformloc`
       * + `gluniform1f` + `glquad`）。这一族在 CPU 备选那一档是**明着拒**的，所以它的判据
       * 只能在这儿 —— 判的是像素：
       *   * 那一帧**铺满**（满屏四边形：背景色一格都不剩）；
       *   * 片元着色器真在算（左右两侧的红/蓝分量按 `p.x` / `p.y` 变，不是一片纯色）；
       *   * uniform 真喂进去了（`t = numframes/60`，几帧之后中心的红分量变过）。
       */
      const sp = 'async () => {'
        + ' const c = document.createElement("canvas");'
        + ' c.style.position = "fixed"; c.style.left = "-9999px";'
        + ' document.body.appendChild(c);'
        + ' const dev = window.__OMNI_INSTALL_GL(c, 320, 240);'
        + ' dev.reset();'
        + ' globalThis.process.env.OMNI_GFX = "host";'
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + '   { body: JSON.stringify({ argv: ["run", "ext/polydraw/examples/04-shader.pss"] }) });'
        + ' if (r.code !== 0) return { err: (r.stderr || "").slice(0, 300) };'
        + ' dev.stop();'
        + ' dev.step();'
        + ' const s1 = dev.snapshot();'
        + ' for (let i = 0; i < 40; i++) dev.step();'
        + ' const s2 = dev.snapshot();'
        + ' const px = (s, x, y) => { const o = (y * 320 + x) * 4;'
        + '   return [s.bytes[o], s.bytes[o+1], s.bytes[o+2]]; };'
        + ' let black = 0;'
        + ' for (let i = 0; i < s1.bytes.length; i += 4) {'
        + '   if (s1.bytes[i] === 0 && s1.bytes[i+1] === 0 && s1.bytes[i+2] === 0) black++; }'
        + ' return { left: px(s1, 20, 120), right: px(s1, 300, 120),'
        + '   mid1: px(s1, 160, 120), mid2: px(s2, 160, 120), black }; }';
      const sr = JSON.parse(await pw([S, '--raw', 'eval', sp]));
      ok('真浏览器里可编程管线跑通（@v/@f 区段 + glsetshader + uniform + glquad）',
        sr.err === undefined && sr.black === 0
        && sr.right !== undefined && sr.right[1] > sr.left[1] + 100
        && sr.mid1 !== undefined && sr.mid1[0] !== sr.mid2[0],
        JSON.stringify(sr).slice(0, 260));
      /**
       * **着色器 + 立即模式的几何**（`05-shader-geom.pss`）：几何还是 `glBegin`/`glVertex`
       * 发的，但顶点走脚本自己的顶点着色器 —— 所以判的是三件事：
       *   * 那个四边形真画上了（中心非黑、画布角上是黑的 —— 它只占中间六成）；
       *   * **顶点色插到片元里了**（左下偏红、右下偏绿）；
       *   * **矩阵真进了 `u_mvp`**（转 45 帧 = 90 度之后，左下那一格的颜色变了）。
       */
      const gp3 = 'async () => {'
        + ' const c = document.createElement("canvas");'
        + ' c.style.position = "fixed"; c.style.left = "-9999px";'
        + ' document.body.appendChild(c);'
        + ' const dev = window.__OMNI_INSTALL_GL(c, 320, 240);'
        + ' dev.reset();'
        + ' globalThis.process.env.OMNI_GFX = "host";'
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + '   { body: JSON.stringify({ argv: ["run", "ext/polydraw/examples/05-shader-geom.pss"] }) });'
        + ' if (r.code !== 0) return { err: (r.stderr || "").slice(0, 300) };'
        + ' dev.stop();'
        + ' dev.step();'
        + ' const s1 = dev.snapshot();'
        + ' for (let i = 0; i < 45; i++) dev.step();'
        + ' const s2 = dev.snapshot();'
        + ' const px = (s, x, y) => { const o = (y * 320 + x) * 4;'
        + '   return [s.bytes[o], s.bytes[o+1], s.bytes[o+2]]; };'
        + ' return { mid: px(s1, 160, 120), corner: px(s1, 8, 8),'
        + '   lb: px(s1, 125, 158), rb: px(s1, 195, 158), lb2: px(s2, 125, 158) }; }';
      const gr3 = JSON.parse(await pw([S, '--raw', 'eval', gp3]));
      const lum = (p) => p[0] + p[1] + p[2];
      ok('真浏览器里着色器 + 立即模式的几何（顶点色插值 + 矩阵进 u_mvp）',
        gr3.err === undefined && lum(gr3.mid) > 60 && lum(gr3.corner) === 0
        && gr3.lb[0] > gr3.lb[1] + 60 && gr3.rb[1] > gr3.rb[0] + 60
        && lum(gr3.lb2) !== lum(gr3.lb),
        JSON.stringify(gr3).slice(0, 260));
      /**
       * **纹理那一族**（`06-texture.pss`）：CPU 上算一张 64×64 的棋盘 + 渐变、
       * `glsettex(0, buf, …, KGL_BGRA32+KGL_NEAREST+KGL_CLAMP_TO_EDGE)` 上传成纹理、
       * `glactivetexture`+`glbindtexture` 挑好、片元里 `uniform sampler2D tex0` 采样它。
       * 判的是三件事（都是"这条路真通了"才成立的）：
       *   * 采到的是**那张图**：左上角的红分量小、右上角大（红随 x 涨）；
       *   * 棋盘真在（**扫一行**看蓝分量的最大最小 —— 蓝就是那格棋盘，0 或 255；
       *     取两个定点会碰上"正好同一格"，第一版就是这么假红的）；
       *   * uniform 真喂进去了（`t` 变了之后**偏离中心**那一格的颜色变过 —— 采样坐标
       *     是绕中心缩放的，所以中心那一点是它的不动点，取中心永远看不出变化）。
       */
      const tp = 'async () => {'
        + ' const c = document.createElement("canvas");'
        + ' c.style.position = "fixed"; c.style.left = "-9999px";'
        + ' document.body.appendChild(c);'
        + ' const dev = window.__OMNI_INSTALL_GL(c, 320, 240);'
        + ' dev.reset();'
        + ' globalThis.process.env.OMNI_GFX = "host";'
        + ' const r = await window.__OMNI_LOCAL("/api/run",'
        + '   { body: JSON.stringify({ argv: ["run", "ext/polydraw/examples/06-texture.pss"] }) });'
        + ' if (r.code !== 0) return { err: (r.stderr || "").slice(0, 300) };'
        + ' dev.stop();'
        + ' dev.step();'
        + ' const s1 = dev.snapshot();'
        + ' for (let i = 0; i < 20; i++) dev.step();'
        + ' const s2 = dev.snapshot();'
        + ' const px = (s, x, y) => { const o = (y * 320 + x) * 4;'
        + '   return [s.bytes[o], s.bytes[o+1], s.bytes[o+2]]; };'
        + ' let bmin = 999, bmax = -1;'
        + ' for (let x = 0; x < 320; x++) { const b = px(s1, x, 120)[2];'
        + '   if (b < bmin) bmin = b; if (b > bmax) bmax = b; }'
        + ' return { lt: px(s1, 10, 10), rt: px(s1, 310, 10), bmin, bmax,'
        + '   off1: px(s1, 210, 150), off2: px(s2, 210, 150) }; }';
      const tr = JSON.parse(await pw([S, '--raw', 'eval', tp]));
      const lum2 = (p) => p[0] + p[1] + p[2];
      ok('真浏览器里纹理那一族（数组 -> (gfxtex …) -> sampler2D tex0）',
        tr.err === undefined && tr.rt !== undefined
        && tr.rt[0] > tr.lt[0] + 100
        && tr.bmax - tr.bmin > 200
        && lum2(tr.off1) !== lum2(tr.off2),
        JSON.stringify(tr).slice(0, 260));
    } finally {
      try { await pw([S, 'close']); } catch { /* 关不掉不该把判据判红 */ }
      srv.close();
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
