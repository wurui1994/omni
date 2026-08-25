// Omni stage0 — 宿主原生面（封闭 ABI 的那一半，ADR-0011 决策 2 与 17）
//
// 这个文件很特别：链接器（frontend-js/link.js）**不会把它拼进程序里**。从这里导入的
// 每个名字都被映射到一个 ABI op，降级之后调的是运行时（C 侧的 omni_js_*、JS 侧的
// $js_*）。而在 node 上直接跑编译器的时候，跑的就是下面这些实现。
//
// 所以下面每个函数都必须和 backend-js/prelude.js 里对应的 $js_* 行为一致 —— 那是同一
// 语义的第二份实现（第三份在 runtime/ 的 C 里）。名字与 op 的对应表在 link.js。
//
// 不放这里的东西：路径计算（host/path.js，纯字符串）、sha256（host/sha256.js，纯计算）。
// 判据只有一条 —— 真的要问操作系统才进来。

function node(name) {
  return process.getBuiltinModule(name);
}

/* ---------------------------------------------------------------- 文件系统 */

export function readText(p) {
  return node('node:fs').readFileSync(p, 'utf8');
}

export function writeText(p, t) {
  node('node:fs').writeFileSync(p, t);
  return undefined;
}

export function exists(p) {
  return node('node:fs').existsSync(p);
}

export function readDir(p) {
  return node('node:fs').readdirSync(p);
}

export function mtimeMs(p) {
  return node('node:fs').statSync(p).mtimeMs;
}

export function fileSize(p) {
  return node('node:fs').statSync(p).size;
}

export function mkdTemp(prefix) {
  return node('node:fs').mkdtempSync(prefix);
}

/** mkdir -p。`omni bootstrap` 要摆出一棵安装布局的目录树，所以这条也得进 ABI */
export function mkdirAll(p) {
  node('node:fs').mkdirSync(p, { recursive: true });
  return undefined;
}

export function rename(a, b) {
  node('node:fs').renameSync(a, b);
  return undefined;
}

export function realPath(p) {
  return node('node:fs').realpathSync(p);
}

/* ---------------------------------------------------------------- 进程与系统 */

/** 命令行实参，不含解释器与脚本本身 */
export function args() {
  return process.argv.slice(2);
}

export function cwd() {
  return process.cwd();
}

export function env(name) {
  return process.env[name];
}

export function stdout(s) {
  process.stdout.write(s);
  return undefined;
}

export function stderr(s) {
  process.stderr.write(s);
  return undefined;
}

export function setExitCode(n) {
  process.exitCode = n === undefined ? 0 : Math.trunc(n);
  return undefined;
}

export function stdinIsTty() {
  return process.stdin.isTTY === true;
}

/**
 * 阻塞读一行，读到 EOF 给 undefined。C 侧只有阻塞读，所以这边也用 readSync
 * 而不是 readline 的事件 —— 用它的只有 REPL，那是等人打字的地方。
 */
export function readLine() {
  const fs = node('node:fs');
  const one = Buffer.alloc(1);
  const bytes = [];
  let sawEof = false;
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, one, 0, 1, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      if (e.code === 'EOF') { sawEof = true; break; }
      throw e;
    }
    if (n === 0) { sawEof = true; break; }
    if (one[0] === 10) break;
    bytes.push(one[0]);
  }
  if (sawEof && bytes.length === 0) return undefined;
  const s = new TextDecoder().decode(new Uint8Array(bytes));
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

/** 结果是 [status, stdout, stderr]；mode 'c' 全捕获 / 'o' stdout 直通 / 'i' 全直通 */
export function spawn(cmd, argv, mode) {
  const stdio = mode === 'c' ? ['ignore', 'pipe', 'pipe']
    : mode === 'o' ? ['ignore', 'inherit', 'pipe']
      : 'inherit';
  // maxBuffer 必须显式给：node 的默认是 1 MiB，而 C 侧的实现没有这个上限。
  // `omni bootstrap` 要收下另一代编译器 1.7 MB 的 stdout，默认值会 ENOBUFS。
  const r = node('node:child_process').spawnSync(cmd, argv, { encoding: 'utf8', stdio, maxBuffer: 1 << 28 });
  if (r.error !== undefined && r.error !== null) throw new Error(`cannot spawn: ${r.error.message}`);
  return [r.status === null ? 128 : r.status, r.stdout === null ? '' : r.stdout, r.stderr === null ? '' : r.stderr];
}

export function tmpDir() {
  return node('node:os').tmpdir();
}

/**
 * "运行中的程序镜像所在目录"。node 上是这个文件所在的目录（src/host），C 侧是可执行
 * 文件所在目录 —— 从这里怎么走到 runtime/ 与 lib/ 是调用方的事，两代的布局本来就不同。
 */
export function installDir() {
  const url = import.meta.url;
  const p = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url;
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

/* ---------------------------------------------------------------- 宿主里的 eval */

// `omni run` 与 REPL 是"生成 JS，在本进程里跑掉"。这件事只有 JS 宿主能做，原生构建里
// 那两个 op 是一句清楚的错误（runtime/omni_js_host.c）。放进 ABI 而不是直接写
// `new Function`，是因为编译器自己的源码要能被降级 —— `new Function` 不在语言子集里。

export function evalJs(code) {
  // eslint-disable-next-line no-new-func
  new Function(code)();
  return undefined;
}

/** 同上，但把 stdout/stderr 收进字符串；结果是 [out, err, failed] */
export function evalCaptured(code) {
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  const ex = process.exit;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  process.exit = (c) => { const e = new Error('exit'); e.$exit = c === undefined ? 0 : c; throw e; };
  let failed = false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(code)();
  } catch (e) {
    failed = true;
    // $exit 是被跑的程序自己的运行期错误（消息已经在 err 里了）；其它异常说明后端生成了坏代码
    if (e === null || e === undefined || e.$exit === undefined) {
      err.push(`omni: internal error: generated JS threw ${e && e.stack ? e.stack : String(e)}\n`);
    }
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    process.exit = ex;
  }
  return [out.join(''), err.join(''), failed];
}
