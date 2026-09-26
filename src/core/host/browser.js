// Omni stage0 — 宿主的**第四条腿：浏览器**（`docs/design/omni-serve-studio.md` §5）
//
// 封闭 ABI（ADR-0011 决策 2 与 17）今天有四份实现：
//
//   node      `host/native.js`
//   JS 产物   `backend-js/prelude.js` 的 `$js_*`
//   原生      `runtime/omni_js_host.c` 的 `omni_js_*`
//   浏览器    **这一份**
//
// 名字与 op 的对照表在 `frontend-js/link.js`（那份不进产物，只登记"名字 -> op"），
// 所以换宿主**编译器本体一行不改** —— 39 个引用方照旧写 `./host/native.js`，
// 单体 HTML 的打包脚本（`tools/bundle-studio.mjs`）把那个模块 id 指到这儿。
//
// ## 三档，写在明处
//
// * **能做**：读写文件（读那张内联的表，写落内存）、stdout/stderr（写进页面的输出区）、
//   时钟、`env`、`args`、`cwd`、`evalJs`、real 的排版那一族。
// * **写是会话内的**：改过的源码与编译缓存（glr 表）都在内存里，刷新页面就没了。
//   这不是偷工：浏览器里没有一处"该落在哪儿"的答案，而**内容寻址的缓存在内存里一样对**。
// * **做不到，明着拒**：`spawn` / `spawnIn`（没有子进程）、`pluginLoad`（没有 dlopen）、
//   `readLine`（没有阻塞读）。所以这条腿上能跑的是**解释器与图那几条腿**，原生那一档
//   在页面上只能给出"这一步要 serve"。这是**事实，不是欠账** —— 浏览器里没有 `fork`。
//
// ## 纯计算那 15 格**不在这儿**
//
// i32 运算、dynamic 标签、real 的六种排版、`eval`、按名字调 op、函数值那两格 ——
// 那些一行 node 都不碰，所以摊在 `host/pure.js` 里，两条腿共用同一份。
// 手抄第二份 `fmtFixed` 等于给"同一个 double 打印出同一串字符"多开一条会分叉的路。

export {
  i32Op, i32ToU, i32Wrap, typeTag, hasJsEngine, evalJs,
  fmtReal, fmtFixed, fmtSci, fmtGen, fmtRealG, reprReal,
  callJsOp, wrapFn, callFnValue,
} from './pure.js';

/* ---------------------------------------------------------------- 虚拟文件系统
 *
 * 一张 `路径 -> 正文` 的表。**内联进来的那份是打包脚本塞的**（`window.__OMNI_VFS`）——
 * 设计文档 §5 里那句"抽离 node 依赖，虚拟文件系统除外"就是这一格：它本来就该内联。
 *
 * 路径**规范化**到"不带前导斜杠的相对路径"：`langs.js` 的 `treeRoot()` 从
 * `installDir()` 往上数三层，在这条腿上得到空串，于是语法文件的路径长成 `/ext/go/…`。
 * 与其去改那一处（它在自编译轴上），不如在这儿把两种写法收成一种。
 */
const FILES = new Map();
const MTIME = new Map();
let STAMP = 1;

/** `/ext/a`、`./ext/a`、`ext//a` 一律收成 `ext/a`。 */
function norm(p) {
  let s = String(p);
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * 把内联的那张表装进来（打包出来的那份 HTML 在跑编译器之前调它）。
 *
 * 分开成一格函数而不是在模块顶上读 `window`：判据那一趟（`tests/studio`）在 node 上
 * 跑这条腿，那儿没有 `window`。
 */
export function mountFiles(table) {
  for (const k of Object.keys(table)) {
    FILES.set(norm(k), table[k]);
    MTIME.set(norm(k), STAMP);
  }
  STAMP += 1;
  return undefined;
}

/* **内联的那张表要在任何模块的模块体跑起来之前就装上**（撞过一次）。
 *
 * 为什么：`cli.js` 的**模块体里**就有一句 `registerBuiltins(pluginApi())`，而它会去扫
 * `ext/<名字>/omni-ext.json`（`ext.js` 的 `scanExts`）。表还没装的时候 `extDirs()` 一个
 * 目录都找不着 —— 于是那三格 JS 扩展（lua / gsl-shell / tiny）**一格都没登记**，页面上
 * 报的是"不认识 basics.lua 这种扩展名"，而那门语言的代码就在同一份 HTML 里。
 *
 * 靠得住的理由：打包脚本把 `window.__OMNI_VFS = {…}` 摆在所有 `__M[…] = …` 之后、
 * `__req(入口)` 之前 —— 那几行只是函数赋值，真跑是从 `__req` 开始的。
 * `browser-main.js` 里那句 `mountFiles` 照旧留着（判据那趟在 node 上跑，没有 window），
 * 装两遍是幂等的。 */
if (typeof window !== 'undefined' && window.__OMNI_VFS !== undefined
  && window.__OMNI_VFS !== null) {
  mountFiles(window.__OMNI_VFS);
}

/** 这条腿上所有文件的路径（`/api/tree` 那一侧用不到，判据用得到）。 */
export function listFiles() {
  return [...FILES.keys()];
}

export function readText(p) {
  const k = norm(p);
  const t = FILES.get(k);
  if (t === undefined) throw new Error(`ENOENT: ${k}（浏览器这条腿上只有内联的那张表）`);
  return t;
}

export function writeText(p, t) {
  const k = norm(p);
  FILES.set(k, t);
  MTIME.set(k, STAMP);
  STAMP += 1;
  return undefined;
}

/* 字节口径那两条：这条腿上的"串"就是 JS 串，而内联的表也是 JS 串 —— 所以**与文本同一格**。
   写清楚差在哪：node 那侧 latin1 一个字符一个字节，是为了 C 的 `FILE` 是字节流；
   浏览器这条腿跑不了 C 那一档（没有 cc、没有链接器），于是那条差别在这儿不存在。 */
export function readBinary(p) { return readText(p); }
export function writeBinary(p, t) { return writeText(p, t); }

export function exists(p) {
  const k = norm(p);
  if (FILES.has(k)) return true;
  return isDir(k);
}

/** 目录 = "有文件的路径以它开头"。表里不存目录本身（省一格状态，也省一格会走样的状态）。 */
export function isDir(p) {
  const k = norm(p);
  if (FILES.has(k)) return false;
  if (k === '') return true;
  const pre = `${k}/`;
  for (const f of FILES.keys()) if (f.startsWith(pre)) return true;
  return false;
}

export function readDir(p) {
  const k = norm(p);
  const pre = k === '' ? '' : `${k}/`;
  const out = new Set();
  for (const f of FILES.keys()) {
    if (!f.startsWith(pre)) continue;
    const rest = f.slice(pre.length);
    const i = rest.indexOf('/');
    out.add(i < 0 ? rest : rest.slice(0, i));
  }
  return [...out].sort();
}

export function mtimeMs(p) { return MTIME.get(norm(p)) ?? 0; }
export function fileSize(p) { return readText(p).length; }

/** mkdir -p：这张表里没有"空目录"这回事，所以什么都不用做。 */
export function mkdirAll() { return undefined; }

export function mkdTemp(prefix) {
  const d = `${norm(prefix)}${STAMP}`;
  STAMP += 1;
  return d;
}

export function rename(a, b) {
  const t = readText(a);
  writeText(b, t);
  FILES.delete(norm(a));
  return undefined;
}

export function removeFile(p) {
  const k = norm(p);
  if (!FILES.has(k)) throw new Error(`ENOENT: ${k}`);
  FILES.delete(k);
  return undefined;
}

export function realPath(p) { return norm(p); }

/* ---------------------------------------------------------------- 进程与系统 */

let ARGS = [];
const ENV = new Map([
  /* 缓存落在内存里那棵 `/.omni-cache` 下。明着给一格是因为 `cache.js` 的 `treeRoot()`
     靠"往上找 package.json / .git"认根 —— 这条腿上那两样都不在表里。 */
  ['OMNI_CACHE_DIR', '.omni-cache'],
  /* **当库用**：`core/cli.js` 见到这一格就不自己 `main(procArgs())`。
     单体 HTML 那一份就是靠它把整台驱动 import 进来的（`studio/browser-main.js` 调
     `runCli`），于是十一门 + `.sx`/`.omni`/`.asy`/`.jnc`/`.js`/`.wat` 走的是**同一份
     dispatch**，页面上不再有第二套"这条腿支持哪几门"的表。 */
  ['OMNI_AS_LIB', '1'],
  /* CLI 自己那格开发期时限会到点给整个进程一枪 —— 在页面上那是把 Studio 打死。
     这条腿的时限只记不管（`runTimeout` / `deadlinePassed`），由 `browser-main.js`
     在两趟之间报。 */
  ['OMNI_TIMEOUT', '0'],
  ['OMNI_BUILD_TIMEOUT', '0'],
]);

/** 这一趟的实参（`browser-main.js` 在每次跑之前设）。 */
export function setArgs(a) { ARGS = [...a]; return undefined; }

export function args() { return [...ARGS]; }
export function cwd() { return ''; }
export function env(name) { return ENV.get(name); }
/**
 * 写环境量。**两处都要写**：我们自己这张表，以及——只在**我们那格 `process` 没装上**的时候
 * ——真的 `process.env`。
 *
 * 为什么有第二处：`omni run` 最后一步是 `evalJs(发射出来的那份 JS)`，而那份产物读环境量走的
 * 是 `process.env`（prelude 的 `$js_env`）。判据那一趟（`tests/studio`）拿 node 当壳子跑这条
 * 腿，`globalThis.process` 已经在，于是下头那句 `installProcessShim()` 被跳过 —— 编译器这一侧
 * `setEnv('OMNI_GFX_OUT_DEFAULT', …)` 只落进 `ENV`，产物一格都看不见，图就落回老名字
 * `frame.png`（撞过一次：两门 `.js` 在这条腿上与 node 那侧差一个文件名）。
 *
 * `SHIMMED` 那一格是防自递归：装上的那份 `process.env` 是个 Proxy，它的 `set` 回头调这儿。
 */
export function setEnv(name, value) {
  ENV.set(name, value);
  if (!SHIMMED && typeof process !== 'undefined' && process !== null
    && typeof process.env === 'object' && process.env !== null) {
    process.env[name] = value;
  }
  return undefined;
}

/* ---- 输出：两格可换的收集器 ----
 * 页面上"输出区"与"shell"是同一份数据的两种印法，所以这儿只收一份，怎么印是 UI 的事。
 * 与 node 那侧的差别只有一处：那边直接写 fd，这边写进数组。 */
let OUT = [];
let ERR = [];

export function stdout(s) { OUT.push(s); return undefined; }
export function stderr(s) { ERR.push(s); return undefined; }
export function stdoutBytes(s) { return stdout(s); }
export function stderrBytes(s) { return stderr(s); }

/** 取走这一趟的两股输出并清空。回 `[stdout, stderr]`。 */
export function takeOutput() {
  const o = OUT.join('');
  const e = ERR.join('');
  OUT = [];
  ERR = [];
  return [o, e];
}

let EXIT_CODE = 0;
export function setExitCode(n) {
  EXIT_CODE = n === undefined ? 0 : Math.trunc(Number(n));
  return undefined;
}
export function exitCode() { return EXIT_CODE; }

export function stdinIsTty() { return false; }


/** 没有阻塞读 —— 回 EOF 而不是抛：调用方（REPL）本来就会把 undefined 当"到头了"。 */
export function readLine() { return undefined; }

/* ---------------------------------------------- 给 JS 产物那条腿的一格 `process`
 *
 * `omni run` 在有 JS 引擎的宿主上，最后一步是 `evalJs(发射出来的那份 JS)`（`cli.js` 的
 * `case 'run'`）。那份 JS 自带的宿主是 **`backend-js/prelude.js` 的 138 格 `$js_*`**，
 * 而那一份是**照 node 的形状写的**：`$flush` 直接写 `process.stdout.write`。
 * 于是页面上每跑一门语言都是一句 `process is not defined` ——
 * **十八门全红，而 node 那侧的判据一格都看不见**（node 上真有 `process`）。
 *
 * 治法不是给 prelude 写第二份（那是 6600 行、且会与 node 那份分叉），而是**在这条腿上
 * 摆一格同形状的 `process`**，每一格都落到这份文件自己的收集器/内存文件系统上 ——
 * 换宿主不改产物，与 ADR-0011 决策 2 是同一个路数（名字不变，实现按腿换）。
 *
 * **故意不给**的三格：`on`（prelude 的退出钩子会去挂 `process.on('exit')`）、
 * `dlopen`（`host/ffi_host.js` 拿它判"能不能挂 addon"）、`getBuiltinModule`
 * 里除报错之外的任何行为 —— 它们背后的那几路在浏览器上本来就走不了，
 * 让它当场说一句人话，比静默走 node 的老路好。
 */
/**
 * `process.getBuiltinModule('node:fs')` 那几格的**门面**：每一格都落到这份文件自己的
 * 内存文件系统上。
 *
 * 为什么必须有：`omni run x.js` 最后一步是 eval 发射出来的 JS，而那份 JS 里凡是碰文件的
 * op（`$js_fs_*`）在 prelude 里都是 `$node("node:fs").…` —— 于是**图形设备**
 * （`ext/js/lib/ege.js` 的 `writeBinary`）在页面上第一句就报"没有 node 的内建模块"。
 * 门面接到同一张内存表上之后，产物那条腿与编译器本体**共用同一个文件系统**：
 * 程序写下的那一帧表面，`/api/gfx` 立刻读得到。
 *
 * 只给产物真用到的那几格（照 `backend-js/prelude.js` 里 `$node(` 的调用点数出来的）。
 * 字节口径：这条腿上"串就是字节"（见上头 `readBinary` 的注），所以 `latin1` / `utf8`
 * 两种编码回的都是同一个串 —— 这与 node 那侧的差别写在 `readBinary` 的头注里。
 */
const NODE_FACADE = {
  'node:fs': {
    readFileSync: (p) => readText(p),
    writeFileSync: (p, t) => writeText(p, String(t)),
    existsSync: (p) => exists(p),
    readdirSync: (p) => readDir(p),
    statSync: (p) => ({
      mtimeMs: mtimeMs(p),
      size: fileSize(p),
      isDirectory: () => isDir(p),
      isFile: () => !isDir(p),
    }),
    mkdirSync: (p) => mkdirAll(p),
    mkdtempSync: (pre) => mkdTemp(pre),
    renameSync: (a, b) => rename(a, b),
    unlinkSync: (p) => removeFile(p),
    realpathSync: (p) => realPath(p),
  },
  /* `Buffer` 在这条腿上就是**串**：产物拿它只做两件事 —— 包一层再写文件、量字节数。 */
  'node:buffer': {
    Buffer: {
      from: (t) => String(t),
      alloc: (n) => '\u0000'.repeat(n),
      byteLength: (t) => {
        let n = 0;
        for (const ch of String(t)) {
          const c = ch.codePointAt(0);
          n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        }
        return n;
      },
    },
  },
  'node:os': { tmpdir: () => tmpDir() },
};

let SHIMMED = false;

function installProcessShim() {
  const shim = {
    stdout: { write(s) { stdout(typeof s === 'string' ? s : String(s)); return true; } },
    stderr: { write(s) { stderr(typeof s === 'string' ? s : String(s)); return true; } },
    stdin: { isTTY: false },
    env: new Proxy({}, {
      get: (_t, k) => env(String(k)),
      set: (_t, k, v) => { setEnv(String(k), String(v)); return true; },
      has: (_t, k) => env(String(k)) !== undefined,
    }),
    cwd,
    uptime: () => performance.now() / 1000,
    hrtime: { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
    resourceUsage: () => ({ maxRSS: 0 }),
    /* `process.exit(n)`：这条腿上没有"退出进程"，但**语义要在** —— 抛一格带 `$exit` 的
       错（prelude 自己的 `$js_eval_captured` 用的就是这个约定），`browser-main.js` 的
       `runArgv` 见着它就把它当退出码，而不是当"内部错误"。 */
    exit(n) {
      setExitCode(n);
      const e = new Error(`exit ${n === undefined ? 0 : n}`);
      e.$exit = n === undefined ? 0 : Math.trunc(Number(n));
      throw e;
    },
    getBuiltinModule(name) {
      const m = NODE_FACADE[String(name)];
      if (m !== undefined) return m;
      throw new Error(`浏览器这条腿上没有 node 的内建模块（产物问的是 ${name}）——`
        + ' 读写文件那几格已经在封闭 ABI 里，真要 fs/child_process 就得 `omni serve`');
    },
  };
  Object.defineProperty(shim, 'argv', { get: () => ['omni', installDir(), ...args()] });
  Object.defineProperty(shim, 'exitCode', { get: () => exitCode(), set: (n) => setExitCode(n) });
  globalThis.process = shim;
  SHIMMED = true;
}

if (typeof globalThis.process === 'undefined') installProcessShim();
/* `Buffer` 产物里是**当全局用**的（prelude 的 `$js_fs_write_bytes` 那几格直接写
   `Buffer.from(…)`，不走 `node:buffer`）—— 少这一格，页面上报的是 `Buffer is not defined`。 */
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = NODE_FACADE['node:buffer'].Buffer;
}

/* ---- 做不到的那几格：明着拒 ----
 * 拒得响而不是悄悄回个空：后者会让人以为"编译器坏了"，而真相是"浏览器里没有 fork"。 */

export function spawn(cmd) {
  throw new Error(`浏览器这条腿上没有子进程（要跑 ${cmd}）—— `
    + '原生那一档（cc / 链接 / 跑可执行文件）要 `omni serve`');
}

export function spawnIn(cmd) { return spawn(cmd); }

export function pluginsOk() { return false; }

export function pluginLoad(path) {
  throw new Error(`浏览器这条腿上没有插件加载（${path}）：没有 dlopen。`
    + '插件是 C 那条腿的事（dlopen + omni_plugin_init）');
}

/**
 * 一趟"跑"的墙上时限。**这条腿上只能记下来，管不了** —— 页面是单线程的，
 * 解释器同步跑起来之后事件循环一格都不转，没有第二根线程能动手
 * （Worker 里跑的是另一份内存，杀不了这一份）。
 *
 * 不假装：记下来，让 `browser-main.js` 在**两趟之间**报"上一趟超了"。真要硬时限就得把
 * 整个编译器搬进 Worker —— 那是另一刀，账记在设计文档 §8。
 */
let DEADLINE_MS = 0;
export function runTimeout(ms, msg) {
  DEADLINE_MS = ms > 0 ? Date.now() + ms : 0;
  return undefined;
}
/** 这一趟有没有超出时限（`browser-main.js` 跑完之后问一次）。 */
export function deadlinePassed() { return DEADLINE_MS > 0 && Date.now() > DEADLINE_MS; }

export function tmpDir() { return 'tmp'; }

export function nowMs() { return Date.now(); }

/** 峰值常驻内存：浏览器不给。回 0 —— `-v` 那一栏会印 0，比印一个猜的数诚实。 */
export function maxRssBytes() { return 0; }

export function upMs() { return Math.trunc(performance.now()); }

export function localStamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * "运行中的程序镜像所在目录"。这条腿上是**源码布局里的那一格**（`src/core/host`），
 * 因为内联的那张表就是按源码树的路径存的 —— `langs.js` 的 `treeRoot()` 从这儿往上
 * 数三层拿到根，`ext/<lang>/*.grammar` 才找得到。
 */
export function installDir() { return 'src/core/host'; }

/**
 * 跑一段 JS 并把两股输出收进字符串；结果是 `[out, err, failed]`。
 *
 * 与 node 那份的差别：那边换掉 `process.stdout.write`，这边换掉**我们自己这两格收集器**
 * （`$js_*` 的输出最终都落到 `stdout`/`stderr` 上）。所以被跑的产物里若真有
 * `console.log`，这儿收不到 —— 我们的后端不生成那东西。
 */
export function evalCaptured(code) {
  const so = OUT;
  const se = ERR;
  OUT = [];
  ERR = [];
  let failed = false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(code)();
  } catch (e) {
    failed = true;
    if (e === null || e === undefined || e.$exit === undefined) {
      ERR.push(`omni: internal error: generated JS threw ${e && e.stack ? e.stack : String(e)}\n`);
    }
  }
  const out = OUT.join('');
  const err = ERR.join('');
  OUT = so;
  ERR = se;
  return [out, err, failed];
}
