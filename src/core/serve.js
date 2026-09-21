/**
 * `omni serve` —— 常驻服务 + Omni Studio 那一页（`docs/design/omni-serve-studio.md`）。
 *
 * **这一份是驱动那一侧的东西，不是编译器的一部分。** 它只在 node 上跑：
 * 没有哪条腿需要把 HTTP 服务编进去，所以 `node:http` **不进封闭宿主 ABI**，
 * 这儿用 `process.getBuiltinModule` 在运行期取（与 `prelude.js` 的 `$node` 同一条路数）。
 * 好处是这份文件仍旧留在 JS 子集里 —— `check:self`（`emit js/c src/cli.js`）照样过。
 *
 * **安全**：默认只听 `127.0.0.1`。这是一格**没有任何鉴权**的本地服务，而它能让请求方
 * 编译并运行代码 —— 换句话说，谁连得上就能在这台机器上执行东西。所以：
 *   * `--host` 写成别的地址（`0.0.0.0`）时**明着警告**；
 *   * 读文件只在仓库里、只在白名单那几棵子树下，`..` 一律拒。
 *
 * 一趟请求怎么跑编译器：**每个请求一个子进程**（`node src/cli.js …`）。
 * 为什么不是进程内重入：`cli.js` 有一堆模块级全局（`VERBOSE` / `SRC_SX` / `IMPORTS`
 * 那一族），并发重入会互相串味；子进程还顺手把"时限"与"崩了不影响服务"两件事解决了。
 * 代价是每趟一次 node 启动（量出来 ~100ms），实时模式那一档（250ms 防抖）吃得下。
 */

import { readText, exists, isDir, stderr } from './host/native.js';
import { join, dirname } from './host/path.js';
/* 白名单、后缀表、路径闸、目录树、等效命令 —— 那五样**与单体 HTML 共用**
   （`src/studio/browser-main.js` 从同一份拿），所以住在 `studio/shared.js`。 */
import { extOf, langOf, safePath, buildTree, shellToArgv, EQUIV } from './studio/shared.js';

/* 老调用方（`tests/serve/run.js`）照旧从这儿拿这三格：服务是它们的一个入口。 */
export { safePath, buildTree, shellToArgv };

/** node 的内建模块（运行期取，不 import —— 见文件头那段"为什么"）。 */
const nodeMod = (name) => process.getBuiltinModule(name);

/** 这一版的能力清单（`/api/health` 回它）。 */
const LEGS = ['interp', 'graph', 'js', 'c', 'wat', 'native'];

/**
 * 仓库根：**从这份文件自己的位置算**（`src/core/serve.js` 往上两层）。
 *
 * 为什么不用 `installDir()`：那一格是"运行中的程序镜像所在目录"（`process.argv[1]` 的
 * 目录），而 `node -e …` / 别人 import 我们时那一格根本不指着这个仓库。
 * `import.meta.url` 是这份文件**自己**在哪儿，永远是对的。
 * 这份文件不进静态模块图（cli.js 那边是动态 import），所以用 `import.meta` 不影响自举。
 */
function repoRoot() {
  const here = dirname(new URL(import.meta.url).pathname);
  return dirname(dirname(here));
}

/* ---- MIME / 静态文件 ---- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function mimeOf(path) { return MIME[extOf(path)] ?? 'application/octet-stream'; }

/* ---- HTTP 服务 ---- */

/** 一格 JSON 响应（自动 Content-Type + CORS）。 */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/** 读完 body（POST 那几条用）。上限 2MB —— 一份源码的长度。 */
function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => { len += c.length; if (len > 2e6) { bad(new Error('body too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', bad);
  });
}

/** 跑一条 omni 命令（子进程，带时限）。 */
function runOmni(root, argv, timeoutS) {
  const cp = nodeMod('node:child_process');
  const cli = join(root, 'src', 'cli.js');
  try {
    const r = cp.spawnSync(process.execPath, [cli, ...argv], {
      cwd: root,
      encoding: 'utf8',
      timeout: (timeoutS ?? 30) * 1000,
      env: { ...process.env, OMNI_TIMEOUT: String(timeoutS ?? 30) },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? (r.signal ? 124 : 1) };
  } catch (e) {
    return { stdout: '', stderr: String(e.message), code: 1 };
  }
}

/**
 * **跑一趟请求**。
 *
 * 如果 body 里有 `text`（编辑器改过的源码），先落一格暂存文件再编。暂存走
 * `host/cache.js` 的 `scratchDir`：用完就该没了。
 */
function runRequest(root, body, verb, extra) {
  const fs = nodeMod('node:fs');
  const p = join(root, '.omni-cache', 'work', 'serve-tmp');
  const lang = body.lang ?? extOf(body.path ?? '').slice(1);
  let path = body.path;
  /* **整条 argv 递过来那一档**（`omni --client …` 走的就是这条）：一个字都不改地跑。
     这一条是"服务面是同一个编译器的另一个入口"那句话的落点 —— 服务这侧不重拼命令。 */
  if (Array.isArray(body.argv) && body.argv.length > 0) {
    return runOmni(root, body.argv, body.timeout ?? 30);
  }
  if (body.text !== undefined && body.text !== null) {
    /* 改过的源码落暂存（后缀要对 —— 前端按后缀选）。 */
    try { fs.mkdirSync(p, { recursive: true }); } catch { /* 已存在 */ }
    const ext = body.path ? extOf(body.path) : (lang === 'go' ? '.go' : `.${lang}`);
    const tmp = join(p, `live${ext}`);
    fs.writeFileSync(tmp, body.text, 'utf8');
    path = tmp;
  }
  if (!path) return { stdout: '', stderr: 'path 和 text 至少给一格', code: 1 };
  const argv = extra !== undefined
    ? [verb, extra, path, '-v']
    : [verb, path, '-v'];
  if (body.pkgs) argv.push('--pkgs', body.pkgs);
  return runOmni(root, argv, body.timeout ?? 30);
}


/**
 * 起服务。回一个 `{ server, close() }` —— `close()` 是优雅停。
 *
 * 为什么不直接 `http.createServer(...).listen()`：判据那一趟要拿到 port（`server.address().port`），
 * 而且要能在跑完之后关掉。
 */
export function startServer(opts) {
  const http = nodeMod('node:http');
  const root = opts.root ?? repoRoot();
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const studioDir = join(root, 'src', 'studio');
  let tree = null;
  const getTree = () => { if (tree === null) tree = buildTree(root); return tree; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    try {
      /* ---- API ---- */
      if (path === '/api/health') {
        return json(res, 200, { ok: true, version: '0.1', legs: LEGS });
      }
      if (path === '/api/tree') {
        return json(res, 200, getTree());
      }
      if (path === '/api/file') {
        const rel = url.searchParams.get('path');
        const abs = safePath(root, rel);
        if (abs === null) return json(res, 404, { error: 'not found' });
        const text = readText(abs);
        return json(res, 200, { path: rel, lang: langOf(rel), text });
      }
      if (path === '/api/run' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const r = runRequest(root, body, 'run');
        return json(res, 200, r);
      }
      if (path === '/api/emit' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const r = runRequest(root, body, 'emit', body.format ?? 'ast');
        return json(res, 200, r);
      }
      if (path === '/api/shell' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const line = String(body.line ?? '').trim();
        if (line.length === 0) return json(res, 200, { stdout: '', stderr: '', code: 0 });
        const argv = shellToArgv(line);
        if (argv === null) {
          return json(res, 200, {
            stdout: '',
            stderr: `omni: 不认识 '${line.split(/\s+/)[0]}' —— 认的是 omni 与 `
              + `${[...Object.keys(EQUIV)].join(' / ')}\n`,
            code: 127,
          });
        }
        const r = runOmni(root, argv, body.timeout ?? 30);
        return json(res, 200, r);
      }
      /* CORS preflight */
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }
      /* ---- 静态文件：Studio ---- */
      const file = path === '/' ? '/index.html' : path;
      const abs = join(studioDir, file.replace(/^\/+/, ''));
      if (abs.includes('..') || !exists(abs) || isDir(abs)) {
        return json(res, 404, { error: 'not found' });
      }
      const ct = mimeOf(abs);
      const body = ct.includes('text') || ct.includes('javascript') || ct.includes('json') || ct.includes('svg')
        ? readText(abs) : nodeMod('node:fs').readFileSync(abs);
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (e) {
      json(res, 500, { error: String(e.message ?? e) });
    }
  });

  return new Promise((ok) => {
    server.listen(port, host, () => {
      const addr = server.address();
      ok({
        server,
        port: addr.port,
        host: addr.address,
        url: `http://${addr.address}:${addr.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * `omni serve` 的入口（`cli.js` 那边认 `key: 'serve'` 调这里）。
 */
export async function cmdServe(rest) {
  const pi = rest.indexOf('--port');
  const hi = rest.indexOf('--host');
  const port = pi >= 0 ? Number(rest[pi + 1]) : 7111;
  const host = hi >= 0 ? rest[hi + 1] : '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    stderr(`omni serve: ⚠ 正在监听 ${host} —— 这个服务**没有鉴权**，`
      + '连得上就能编译并运行代码。确认这是你想要的。\n');
  }
  const s = await startServer({ port, host });
  stderr(`omni serve: ${s.url}\n`);
  if (rest.includes('--open')) {
    try { nodeMod('node:child_process').execSync(`open ${s.url}`); } catch { /* */ }
  }
  /* 常驻 —— 收到 SIGINT / SIGTERM 时优雅停。 */
  const stop = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
