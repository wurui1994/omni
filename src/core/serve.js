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
import { Pool, warmable } from './studio/pool.js';

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

/**
 * 跑一条 omni 命令。**先问热工人池，池子接不住再起冷子进程。**
 *
 * 账在 `studio/worker.js` 的头注里：一趟 180ms 里 110ms 是 node 启动 + 装编译器，
 * 与这份源码半点关系都没有。热起来之后同一门语言第二趟 2~11ms。
 *
 * 冷那一条一个字都没动 —— 它是**退路**：`build` / `c link` 那几格要 spawn cc、要写盘，
 * 池子不接；池子起不来时也退到这儿。于是"快"是加法，不是替换。
 */
async function runOmni(root, argv, timeoutS, pool) {
  if (pool !== undefined && pool !== null) {
    const hot = await pool.run(argv, timeoutS ?? 30);
    if (hot !== null) return { ...hot, via: 'warm' };
  }
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
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      code: r.status ?? (r.signal ? 124 : 1),
      via: 'cold',
    };
  } catch (e) {
    return { stdout: '', stderr: String(e.message), code: 1, via: 'cold' };
  }
}

/* ------------------------------------------------- 虚拟文件系统的"改过的那一层"
 *
 * 用户在 Studio 里改过的、以及新建的文件，**留在这一层**（会话内）：切走再切回来还在，
 * 新建的进目录树。仓库里一个字节都不动 —— 那是别人的工作树，编辑器不该往里写。
 *
 * 两处落点，一处是真相、一处是给编译器看的：
 *   * `EDITS`（内存）：`/api/file` 与 `/api/tree` 读它 —— 用户看到的就是这一份。
 *   * **镜像目录** `.omni-cache/work/studio-vfs/<同样的相对路径>`：编译器只会读真磁盘，
 *     所以跑之前把那一格写下去，再让它编镜像里那一份。
 *
 * 为什么镜像要**保持相对路径**：`import` 同目录的兄弟文件、`--pkgs` 那几个目录名都按
 * 路径算。代价写在明处：镜像里只有**改过的**那几份，所以一份改过的文件若 import 了
 * 没改过的兄弟，那个兄弟在镜像里不在 —— 例子都是单文件，这一条够用；不够用的那天
 * 就得整棵 copy-on-write，那是另一刀。
 */
const EDITS = new Map();

/** 落一格编辑（`PUT /api/file`）。回真正给编译器看的那条绝对路径。 */
function putEdit(root, rel, text) {
  const fs = nodeMod('node:fs');
  EDITS.set(rel, text);
  const abs = join(root, '.omni-cache', 'work', 'studio-vfs', rel);
  fs.mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
}

/** 这条路径改过吗？改过就回镜像里那条绝对路径。 */
function editedAbs(root, rel) {
  if (!EDITS.has(rel)) return null;
  return join(root, '.omni-cache', 'work', 'studio-vfs', rel);
}

/**
 * 把"新建的那几份"并进目录树。
 *
 * 只并**树里还没有的**路径（改过的那些本来就在树上）。并的时候按 `/` 一层层往下找，
 * 缺哪一层就补一格 `dir` —— 于是新建 `docs/notes/my.md` 时 `notes/` 那一层自己会出现。
 */
function mergeEdits(tree) {
  const known = new Set();
  const walkKnown = (n) => {
    if (n.kind === 'file') { known.add(n.path); return; }
    for (const k of n.children ?? []) walkKnown(k);
  };
  tree.roots.forEach(walkKnown);
  const fresh = [...EDITS.keys()].filter((p) => !known.has(p));
  if (fresh.length === 0) return tree;
  /* 深拷一层：并进去的东西不许污染缓存着的那棵树。 */
  const out = { roots: tree.roots.map((r) => ({ ...r, children: [...(r.children ?? [])] })) };
  for (const rel of fresh.sort()) {
    const segs = rel.split('/');
    /* 头一段决定挂在哪棵根上（`docs` / `ext` / `tests`）；不认的挂到第一棵根下的"新建"。 */
    let node = out.roots.find((r) => r.path === segs[0]);
    if (node === undefined) {
      node = out.roots.find((r) => r.path === '__new');
      if (node === undefined) {
        node = { name: '新建', path: '__new', kind: 'dir', children: [] };
        out.roots.unshift(node);
      }
      node.children.push({ name: segs[segs.length - 1], path: rel, kind: 'file', lang: langOf(rel), dirty: true });
      continue;
    }
    for (let i = 1; i < segs.length - 1; i += 1) {
      const sub = segs.slice(0, i + 1).join('/');
      let nx = (node.children ?? []).find((c) => c.path === sub && c.kind === 'dir');
      if (nx === undefined) {
        nx = { name: segs[i], path: sub, kind: 'dir', children: [] };
        node.children = [...(node.children ?? []), nx];
      } else {
        nx = { ...nx, children: [...(nx.children ?? [])] };
        node.children = (node.children ?? []).map((c) => (c.path === sub ? nx : c));
      }
      node = nx;
    }
    node.children = [...(node.children ?? []),
      { name: segs[segs.length - 1], path: rel, kind: 'file', lang: langOf(rel), dirty: true }];
  }
  return out;
}

/**
 * **跑一趟请求**。
 *
 * 三种来源，按这个次序：
 *   1. `body.argv` —— 整条命令递过来（`omni --client`）。一个字都不改地跑。
 *   2. `body.text` —— 编辑器现在的内容。落进 `EDITS` + 镜像，再编镜像里那一份。
 *      **顺带把它记下来**：于是"跑一趟"本身就是一次保存，切走再回来还在。
 *   3. `body.path` —— 树里那一份（改过的话走镜像）。
 */
async function runRequest(root, body, verb, extra, pool) {
  const lang = body.lang ?? extOf(body.path ?? '').slice(1);
  let path = body.path;
  if (Array.isArray(body.argv) && body.argv.length > 0) {
    return runOmni(root, body.argv, body.timeout ?? 30, pool);
  }
  if (body.text !== undefined && body.text !== null) {
    const rel = body.path && safePath(root, body.path) !== null
      ? body.path
      : `__new/live.${lang || 'txt'}`;
    path = putEdit(root, rel, body.text);
  } else if (typeof path === 'string') {
    path = editedAbs(root, path) ?? path;
  }
  if (!path) return { stdout: '', stderr: 'path 和 text 至少给一格', code: 1 };
  const argv = extra !== undefined
    ? [verb, extra, path, '-v']
    : [verb, path, '-v'];
  if (body.pkgs) argv.push('--pkgs', body.pkgs);
  return runOmni(root, argv, body.timeout ?? 30, pool);
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
  const getTree = () => { if (tree === null) tree = buildTree(root); return mergeEdits(tree); };
  /** 热工人池（`opts.pool === false` 时不建——判据那一趟是一次性的，不需要热）。 */
  const pool = opts.pool === false ? null : new Pool(root);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    try {
      /* ---- API ---- */
      if (path === '/api/health') {
        return json(res, 200, {
          ok: true, version: '0.1', legs: LEGS,
          ...(pool !== null ? { pool: pool.stat() } : {}),
        });
      }
      if (path === '/api/tree') {
        return json(res, 200, getTree());
      }
      /* **保存 / 新建**（`PUT /api/file`）：写进虚拟文件系统。
         这一支要在下面那格 GET 之前 —— 那一格不看 method。 */
      if (path === '/api/file' && req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        const rel = body.path;
        if (typeof rel !== 'string' || rel.length === 0) return json(res, 400, { error: '要 path' });
        if (rel.startsWith('/') || rel.includes('..') || rel.includes('\0')) {
          return json(res, 400, { error: '路径不合法' });
        }
        putEdit(root, rel, body.text ?? '');
        tree = null;   /* 下次 getTree 重建（新建的文件要进树）。 */
        return json(res, 200, { ok: true, path: rel });
      }
      if (path === '/api/file') {
        const rel = url.searchParams.get('path');
        /* 改过的那一份优先（用户看到的是自己改过的，不是仓库里的）。 */
        if (EDITS.has(rel)) {
          return json(res, 200, { path: rel, lang: langOf(rel), text: EDITS.get(rel), dirty: true });
        }
        const abs = safePath(root, rel);
        if (abs === null) return json(res, 404, { error: 'not found' });
        const text = readText(abs);
        return json(res, 200, { path: rel, lang: langOf(rel), text });
      }
      if (path === '/api/run' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const r = await runRequest(root, body, 'run', undefined, pool);
        return json(res, 200, r);
      }
      if (path === '/api/emit' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const r = await runRequest(root, body, 'emit', body.format ?? 'ast', pool);
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
        const r = await runOmni(root, argv, body.timeout ?? 30, pool);
        return json(res, 200, r);
      }
      /* CORS preflight */
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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
        pool,
        port: addr.port,
        host: addr.address,
        url: `http://${addr.address}:${addr.port}`,
        /* 停的时候**先收工人**：那几格是子进程，不收的话判据那一趟跑完 node 不肯退。 */
        close: () => {
          if (pool !== null) pool.stop();
          return new Promise((done) => server.close(done));
        },
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
  /* **预热**：现在就起一格工人（装编译器那 110ms 现在付，别让第一格请求付）。
     不 await —— 服务这就该能收请求了，热不热是它自己的事。 */
  if (s.pool !== null) {
    s.pool.warm().then(() => {
      stderr(`omni serve: 热工人就绪（池子 ${s.pool.size} 格；OMNI_STUDIO_WORKERS 可改）\n`);
    });
  }
  /* 常驻 —— 收到 SIGINT / SIGTERM 时优雅停。 */
  const stop = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
