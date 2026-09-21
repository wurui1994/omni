/**
 * 单体 HTML 那一份的**编译器一侧**（`docs/design/omni-serve-studio.md` §5）。
 *
 * 一件事：把 `/api/*` 那几条**在页面里自己答掉**，形状与 `omni serve` 逐字相同。
 * 于是 `studio.js`（UI）一行都不用分叉 —— 它只认 `window.__OMNI_LOCAL`。
 *
 * ## 这条腿能跑什么
 *
 * **图那一条**（`--engine graph`：go / nim / v / lua / mojo / cpp / awk / basic /
 * scheme / lisp 那十一门），因为它从头到尾只用封闭 ABI 上的那几格，而
 * `host/browser.js` 全答得出来。`.sx` / `.asy` / `.jnc` / `.c` 那几条走的是
 * `cli.js` 里那台机器（模块级全局 + 子进程 cc），页面上答一句"这一步要 serve" ——
 * 那是事实，不是欠账：浏览器里没有 `fork`。
 *
 * ## 为什么不 import `cli.js`
 *
 * 那份文件末尾就 `main(procArgs())` —— import 它等于当场跑一趟。图那一层的入口
 * （`graph/run.js` 的 `runGraphFile`）本来就是导出的，直接用它。
 */

import { runGraphFile, graphBackendNames } from '../core/graph/run.js';
import { borrowedExts } from '../core/graph/run.js';
import { langOf, safePath, buildTree, shellToArgv } from '../core/studio/shared.js';
import {
  mountFiles, readText, writeText, exists, takeOutput, setArgs, setExitCode, exitCode,
} from '../core/host/browser.js';

/** 图那一条腿吃得下的后缀（`borrowedExts()` 是权威，不在这儿抄第二张表）。 */
let GRAPH_EXTS = null;
function graphExts() {
  if (GRAPH_EXTS === null) GRAPH_EXTS = new Set(borrowedExts());
  return GRAPH_EXTS;
}

const extOf = (p) => (p.lastIndexOf('.') < 0 ? '' : p.slice(p.lastIndexOf('.')));

/**
 * 跑一条 omni 命令。回 `{ stdout, stderr, code }` —— 与服务那侧 `runOmni` 同一个形状。
 *
 * 只认 `run`（与 `--engine graph` 隐含）：`build` 要链接器与 cc，`emit` 的那十几种
 * 格式住在 `cli.js` 的巨型 switch 里。认不了的**明着说要 serve**，不假装。
 */
function runArgv(argv) {
  const verb = argv[0];
  const rest = argv.slice(1);
  if (verb !== 'run') {
    return {
      stdout: '',
      stderr: `omni ${verb}: 单体 HTML 这一份只做 \`run\`（图那一条腿）。\n`
        + 'build / emit / c 要子进程与链接器 —— 那一档请用 `omni serve`。\n',
      code: 2,
    };
  }
  const path = rest.find((a) => !a.startsWith('-'));
  if (path === undefined) return { stdout: '', stderr: 'omni run: 要一个文件\n', code: 2 };
  if (!exists(path)) return { stdout: '', stderr: `omni run: 找不到 ${path}\n`, code: 1 };
  if (!graphExts().has(extOf(path))) {
    return {
      stdout: '',
      stderr: `omni run ${path}: 单体 HTML 这一份只跑图那一条腿（${[...graphExts()].join(' ')}）。\n`
        + `${extOf(path)} 那一条走的是 cli.js 里那台机器 —— 请用 \`omni serve\`。\n`,
      code: 2,
    };
  }
  setArgs(argv);
  setExitCode(0);
  takeOutput();                                  /* 上一趟的残留一律清掉 */
  let code = 0;
  try {
    code = runGraphFile(path, rest);
  } catch (e) {
    const [o, r] = takeOutput();
    return { stdout: o, stderr: `${r}${e.message ?? e}\n`, code: 1 };
  }
  const [out, err] = takeOutput();
  return { stdout: out, stderr: err, code: code === 0 ? exitCode() : code };
}

/**
 * 页面里的那台"服务"。签名与 `fetch` 的前两个实参一样，回的是**已经解好的 JSON** ——
 * `studio.js` 里 `api()` 那一格本来就只用这两样。
 */
async function localApi(path, init) {
  const body = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : {};
  const q = path.indexOf('?');
  const route = q < 0 ? path : path.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : path.slice(q + 1));

  if (route === '/api/health') {
    return { ok: true, version: '0.1', legs: ['graph'], standalone: true };
  }
  if (route === '/api/tree') return buildTree('');
  if (route === '/api/file') {
    const rel = params.get('path');
    if (safePath('', rel) === null) throw new Error(`${rel} 不在白名单里`);
    return { path: rel, lang: langOf(rel), text: readText(rel) };
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
  if (route === '/api/shell') {
    const line = String(body.line ?? '').trim();
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

/* 装上内联的那张表，再把这台"服务"挂到 UI 认的那一格上。
   `graphBackendNames()` 提早叫一次是为了让"有哪几条腿"这件事在健康检查之前就定了。 */
if (typeof window !== 'undefined') {
  mountFiles(window.__OMNI_VFS ?? {});
  window.__OMNI_LOCAL = localApi;
  window.__OMNI_BACKENDS = graphBackendNames();
}

export { localApi, runArgv };
