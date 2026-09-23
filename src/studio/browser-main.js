/**
 * 单体 HTML 那一份的**编译器一侧**（`docs/design/omni-serve-studio.md` §5）。
 *
 * 一件事：把 `/api/*` 那几条**在页面里自己答掉**，形状与 `omni serve` 逐字相同。
 * 于是 `studio.js`（UI）一行都不用分叉 —— 它只认 `window.__OMNI_LOCAL`。
 *
 * ## 这条腿能跑什么
 *
 * **整台驱动**（`core/cli.js` 的 `runCli`）—— 与终端上的 `omni` 是同一份 dispatch：
 * 借来的那九门（go / nim / v / awk / basic / mojo / cpp / scheme / lisp）加上
 * `.sx` / `.omni` / `.asy` / `.jnc` / `.js` / `.wat` / `.glsl` 那几条自家前端。
 *
 * 真跑不动的只有**要子进程或 dlopen 的那几格**：原生构建（cc / 链接 / 跑可执行文件）、
 * `.lua`（它的主人是一格原生插件）。那几格由 `host/browser.js` 的 `spawn` /
 * `pluginLoad` 当场报一句"这一步要 serve" —— 是事实，不是欠账：浏览器里没有 `fork`。
 *
 * ## 为什么可以 import `cli.js` 了
 *
 * 那份文件末尾是 `if (env('OMNI_AS_LIB') !== '1') main(procArgs())`，而这条腿的
 * `env` 表里那一格**默认是 '1'**（`host/browser.js`）—— 与 `omni serve` 的热工人
 * （`core/studio/worker.js`）同一手。从前这儿手写了"借来的那几门怎么跑"，那是第二份
 * 实现：一门语言迁了路、或者多一条命令，页面就悄悄落后一截。
 */

/* 整台驱动。**import 它等于把编译器装进这一页**（`OMNI_AS_LIB` 见上）。 */
import { runCli } from '../core/cli.js';
import { langOf, safePath, buildTree, shellToArgv } from '../core/studio/shared.js';
import {
  mountFiles, readText, readBinary, writeText, exists, takeOutput, setArgs, setExitCode,
  deadlinePassed,
} from '../core/host/browser.js';
/* 网页那一侧的纯函数那一半（高亮 / markdown / EPS -> SVG / GLSL）。
   `studio.js` 平时 `import` 它，可单体 HTML 是一份 `file://` 的文件 ——
   那条路上 `import './render.js'` 是**跨源请求**，浏览器直接拦掉。
   所以这儿把它整个挂到 window 上，打包脚本把 `studio.js` 那条 import 改成读这一格。 */
import * as render from './render.js';
import { installGlDevice } from './gfx-gl.js';

const extOf = (p) => (p.lastIndexOf('.') < 0 ? '' : p.slice(p.lastIndexOf('.')));

/**
 * 跑一条 omni 命令。回 `{ stdout, stderr, code }` —— 与服务那侧 `runOmni` 同一个形状。
 *
 * 与热工人（`core/studio/worker.js` 的 `handle`）是同一段：清两股输出、`runCli`、
 * 把收集器里的东西取走。`OmniError` 已经在 `runCli` 里印成一句话了，能漏到这儿的
 * 是**我们自己的 bug**或者这条腿明着拒的那几格（`spawn` / `pluginLoad`）——
 * 照实印，别糊成"跑失败了"。
 */
function runArgv(argv) {
  setArgs(argv);
  setExitCode(0);
  takeOutput();                                  /* 上一趟的残留一律清掉 */
  let code = 0;
  try {
    code = runCli(argv);
  } catch (e) {
    const [o, r] = takeOutput();
    /* `$exit` 是产物那条腿里"我要退出进程"的约定（`host/browser.js` 那格 `process.exit`
       抛的就是它）—— 那不是错，是退出码。 */
    if (e !== null && e !== undefined && e.$exit !== undefined) {
      return { stdout: o, stderr: r, code: e.$exit };
    }
    return { stdout: o, stderr: `${r}${e && e.message ? e.message : e}\n`, code: 1 };
  }
  const [out, err] = takeOutput();
  /* 时限这条腿只记不管（页面是单线程的，跑起来之后没人能动手）—— 在两趟之间说一句。 */
  const late = deadlinePassed() ? 'omni: 上一趟超出了时限（页面里管不住，只能事后说）\n' : '';
  return { stdout: out, stderr: `${err}${late}`, code: typeof code === 'number' ? code : 1 };
}

/**
 * 页面里的那台"服务"。签名与 `fetch` 的前两个实参一样，回的是**已经解好的 JSON** ——
 * `studio.js` 里 `api()` 那一格本来就只用这两样。
 */
async function localApi(path, init) {
  const body = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : {};
  const method = (init !== undefined && init.method) || 'GET';
  const q = path.indexOf('?');
  const route = q < 0 ? path : path.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : path.slice(q + 1));

  if (route === '/api/health') {
    return { ok: true, version: '0.1', legs: ['borrowed'], standalone: true };
  }
  if (route === '/api/tree') return buildTree('');
  if (route === '/api/file' && method === 'PUT') {
    /* **保存 / 新建**：写进内存里那张表。刷新页面就没了 —— 单体 HTML 没有别的落点，
       而"会话内还在"已经够用（设计文档 §5 的"写是会话内的"那一档）。 */
    const rel = body.path;
    if (typeof rel !== 'string' || rel.length === 0) throw new Error('要 path');
    writeText(rel, body.text ?? '');
    return { ok: true, path: rel };
  }
  if (route === '/api/file') {
    const rel = params.get('path');
    if (safePath('', rel) === null && !exists(rel)) throw new Error(`${rel} 不在白名单里`);
    return { path: rel, lang: langOf(rel), text: readText(rel) };
  }
  /** **一帧图**（图形设备那一族）—— 与 `serve.js` 的 `/api/gfx` 同一个形状。
   *  默认是 PNG（原样把字节交出去，页面自己解 —— `render.js` 的 `pngToRgba`）；
   *  `.rgba` 那个备选出口才切头报 `w`/`h`。这条腿上图就在内存里那张表里（`writeBinary` 落进去的）。 */
  if (route === '/api/gfx') {
    const rel = params.get('path') ?? '';
    const png = rel.endsWith('.png');
    if (rel.includes('..') || !rel.startsWith('.omni-cache/gfx/') || !(png || rel.endsWith('.rgba'))) {
      throw new Error('只认 .omni-cache/gfx/ 底下的 .png 或 .rgba');
    }
    const raw = readBinary(rel);
    if (png) return { kind: 'png', bytes: raw };
    const nl = raw.indexOf('\n');
    const m = nl < 0 ? null : /^#rgba (\d+) (\d+)$/.exec(raw.slice(0, nl));
    if (m === null) throw new Error('这份表面没有 #rgba 头');
    return { kind: 'rgba', w: Number(m[1]), h: Number(m[2]), bytes: raw.slice(nl + 1) };
  }
  if (route === '/api/run' || route === '/api/emit') {
    if (Array.isArray(body.argv) && body.argv.length > 0) return runArgv(body.argv);
    let p = body.path;
    if (body.text !== undefined && body.text !== null) {
      /* 改过的源码落一格**内存里的**暂存（后缀要对 —— 语言是按后缀认的）。 */
      p = `.omni-cache/work/studio-live${extOf(body.path ?? `.${body.lang ?? 'txt'}`)}`;
      writeText(p, body.text);
    }
    if (!p) return { stdout: '', stderr: 'path 和 text 至少给一格\n', code: 1 };
    return runArgv(['run', p, '-v']);
  }
  if (route === '/api/repl') {
    /* 控制台那一档要常驻会话（`src/core/repl.js` 的 `Session` 在服务进程里活着）。
       单体这一份**明着说**，不假装：它连解释器都没拼进来（拼的是图那一条腿）。 */
    return {
      out: '',
      err: '控制台这一档要 `omni serve` —— 单体 HTML 里没有常驻会话。\n',
      ok: false,
      incomplete: false,
      vars: [],
    };
  }
  if (route === '/api/shell') {    const line = String(body.line ?? '').trim();
    if (line.length === 0) return { stdout: '', stderr: '', code: 0 };
    const argv = shellToArgv(line);
    if (argv === null) {
      return {
        stdout: '',
        stderr: `omni: 不认识 '${line.split(/\s+/)[0]}'\n`,
        code: 127,
      };
    }
    return runArgv(argv);
  }
  throw new Error(`单体 HTML 这一份没有 ${route}`);
}

/* 装上内联的那张表，再把这台"服务"挂到 UI 认的那一格上。 */
if (typeof window !== 'undefined') {
  mountFiles(window.__OMNI_VFS ?? {});
  window.__OMNI_LOCAL = localApi;
  window.__OMNI_RENDER = render;
  /* **图形设备（WebGL2）那一格**：EVAL 两门语言（`.pss` / `.kc`）在浏览器里的默认设备。
     这儿只把"装设备"这件事挂出去（要一格 canvas）—— 谁有 canvas 谁装：UI 那边是预览区、
     判据那边是自己建一格。装完之后 `globalThis.__OMNI_GFX` 就是它，产物一行不改。
     口径见 `docs/design/eval-realtime-gpu.md`。 */
  window.__OMNI_INSTALL_GL = installGlDevice;
}

export { localApi, runArgv };
