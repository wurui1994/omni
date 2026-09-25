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

// ABI 上**不问操作系统**的那 15 格（i32 运算、dynamic 标签、real 的排版、eval、
// 按名字调 op、函数值那两格）摊在 `pure.js` 里，这儿原样转手出去 —— 浏览器那条腿
// （`host/browser.js`）用的是**同一份**，不是手抄的第二份。引用方一行不改：
// `link.js` 认的是"从 `core/host/native.js` 导入的名字"，它从不读这份文件的内容。
export {
  i32Op, i32ToU, i32Wrap, typeTag, hasJsEngine, evalJs,
  fmtReal, fmtFixed, fmtSci, fmtGen, fmtRealG, reprReal,
  callJsOp, wrapFn, callFnValue,
} from './pure.js';

// 下面全是**真的要问操作系统**的那一半，所以只在 node 上成立。
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

/* C 那条腿的 `fopen` 用的两条（ADR-0017 第八刀第十片）。与上面两条的差别只有一处：
 * **一个字符一个字节**（latin1），不是 UTF-8。C 的 `FILE` 是字节流，而线性内存里
 * 存的也是字节 —— 中间过一遍 UTF-8 解码就会把非 ASCII 的字节改掉。 */

export function readBinary(p) {
  return node('node:fs').readFileSync(p, 'latin1');
}

/**
 * 写一份字节。`mode` 给了的话只在**新建**那一刻生效，而且照旧过 umask ——
 * 与 `open(…, O_CREAT, mode)` 一样（`open` 那一层要它：tinycc 写可执行文件时
 * 给的是 0777，本机 umask 022，落下来是 0755）。
 */
export function writeBinary(p, t, mode) {
  const opts = mode === undefined ? undefined : { mode };
  node('node:fs').writeFileSync(p, Buffer.from(t, 'latin1'), opts);
  return undefined;
}

export function exists(p) {
  return node('node:fs').existsSync(p);
}

export function readDir(p) {
  return node('node:fs').readdirSync(p);
}

/* 是不是目录。不存在也回 false —— 调用方要的是"能不能往里走"，不是"这条路存不存在"。
   刻意问文件系统而不是看名字：srcStamp 原先按"名字里有没有点"猜，装好的那份里编译器
   自己就叫 `omni`（没有后缀），于是它被当成目录走进去 —— readdir 一个普通文件。 */
export function isDir(p) {
  const fs = node('node:fs');
  if (!fs.existsSync(p)) return false;
  return fs.statSync(p).isDirectory();
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

/** 删一个文件。不在就抛 —— 与 `unlink(2)` 一样，「不在」是错，不是成功。 */
export function removeFile(p) {
  node('node:fs').unlinkSync(p);
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

/**
 * 往宿主的环境里**设**一格。与 `env` 是一对，加它的理由是 ADR-0015 那一节：
 * asy 的输出格式是**运行期**的值，CLI 的 `-f svg` 要做的事就是"设那一格"，
 * 之后不论是本进程 eval 的 JS、spawn 出去的 node、还是链好的可执行文件，
 * 读到的都是同一格（子进程继承环境）—— 产物里一个字节都不用记住格式。
 */
export function setEnv(name, value) {
  process.env[name] = value;
}

export function stdout(s) {
  process.stdout.write(s);
  return undefined;
}

export function stderr(s) {
  process.stderr.write(s);
  return undefined;
}


/* C 那条腿的输出是**字节**，不是字符（ADR-0017 第八刀第十二片）。
 * 上面那两条把一个 JS 串按 UTF-8 编出去 —— 对 asy/jancy 是对的（那儿的串是真的
 * JS 串），对 C 是错的：C 的「串」已经是一串字节了（一个字符一个字节，latin1），
 * 再按 UTF-8 编一遍就成了 `漢` -> `303 246 302 274 302 242`。
 * 所以字节那一路自己一扇门，两侧各写各的，谁也不必将就谁。 */
export function stdoutBytes(s) {
  process.stdout.write(Buffer.from(s, 'latin1'));
  return undefined;
}

export function stderrBytes(s) {
  process.stderr.write(Buffer.from(s, 'latin1'));
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
  return spawnRun(cmd, argv, mode, null);
}

/**
 * 与 `spawn` 只差一格：把 `input` 那段文本**喂进子进程的 stdin**（空串 = 不喂）。
 *
 * 为什么另开一个而不是给 `spawn` 加参数：`spawn` 有二十来个调用点，而它在**封闭 ABI**
 * 上——改形状要二十处一起动，多一条只是多一条。加它的理由是 ADR-0019 决策八：
 * 「IR 走 stdin，磁盘上一个字节都不写」。
 *
 * 一个前提写在明处：这一侧**先把 input 写完再读 stdout**，所以被调的那一边要先把 stdin
 * 读干再往 stdout 写（`glsl_host.c` 的 `slurp_stdin` 正是这样）。不满足、而且两个方向都
 * 超过一个管道缓冲（64 KB）时会死锁。
 */
export function spawnIn(cmd, argv, mode, input) {
  return spawnRun(cmd, argv, mode, input === undefined || input === '' ? null : input);
}

/**
 * 一趟"跑"的墙上时限（`omni run --timeout`）。`ms <= 0` = 撤掉时限。
 *
 * 为什么这一格必须在宿主里：`run` 的"跑"有**两种**形态，而两种都只有宿主能中断 ——
 *   - 子进程：`spawn` 出 node / 链好的可执行文件。时限就是 `spawnSync` 的 `timeout`，
 *     到点它替我们把孩子杀掉，然后**正常返回**（回 124），上面那层还活着去印那句话。
 *   - 本进程：`evalJs` 与解释器在**同一根线程**上同步跑完。那时候事件循环一格都不转，
 *     `setTimeout` 永远不会响 —— 只有另一根线程能在那时候动手。所以是 worker：
 *     它有自己的线程与事件循环，到点自己把那句话写进 fd 2，再给整个进程一枪。
 *
 * 两个出口的退出码**不一样**，而且没法一样：子进程那一路是 124（与 timeout(1) 同一个
 * 约定），本进程那一路只能 SIGKILL（137）—— 被杀的进程没有机会再设自己的退出码。
 *
 * worker 那把枪比时限晚 GRACE 毫秒：子进程那一路到点先返回，那段窗口留给上面那层
 * 印字与退出，不然两边会抢着说话。**这段窗口现在还多担一件事**（第一百五十五片）：
 * 超时那一趟的 profile 也要印出来（`profFoldedFinish` 那五张表），所以从 500ms 抬到
 * 1500ms —— 抬的理由写在这儿，不是随手调的数。
 */
const TIMEOUT_GRACE_MS = 1500;
/** TERM 与 KILL 之间的宽限：被杀的那一方拿这段时间把 profile 写完（见 runTimeout）。 */
const TIMEOUT_KILL_GRACE_MS = 2000;
let DEADLINE_MS = 0;

export function runTimeout(ms, msg) {
  if (ms <= 0) {
    DEADLINE_MS = 0;
    return undefined;
  }
  DEADLINE_MS = Date.now() + ms;
  /* worker 的源码里不能用 `require`（父这边是 ESM，eval 出来的 worker 也是），
   * 所以两处都走 `process.getBuiltinModule` —— 与这个文件顶上的 `node()` 同一条路。
   * 直接 `writeSync(2, …)` 而不是 `console.error`：写的是真的那个 fd，不过 worker
   * 自己那条转发到父进程的管子（枪响之后没人再去抽它）。
   *
   * **先 TERM、后 KILL**（第一百五十五片）：SIGKILL 内核不给接，于是"超时那一趟"的
   * profile 一个字节都落不下来 —— 而那正是最需要它的一趟（卡在哪儿只有它看得见）。
   * SIGTERM 接得住：我们自己的运行时会把折叠栈写完再走（`omni_prof.c` 的 `pf_on_term`），
   * node 这一侧在**事件循环转得动**的时候也能接。宽限到了还没死才补 KILL 那一枪 ——
   * JS 死循环里处理函数进不来（单线程），所以那一枪必须留着。 */
  const src = "const d = process.getBuiltinModule('node:worker_threads').workerData;"
    + 'setTimeout(() => {'
    + "process.getBuiltinModule('node:fs').writeSync(2, d.msg);"
    + "try { process.kill(process.pid, 'SIGTERM'); } catch (e) { /* 已经走了 */ }"
    + 'setTimeout(() => {'
    + "try { process.kill(process.pid, 'SIGKILL'); } catch (e) { /* 已经走了 */ }"
    + '}, d.grace);'
    + '}, d.ms);';
  const { Worker } = node('node:worker_threads');
  const w = new Worker(src, {
    eval: true,
    workerData: { ms: ms + TIMEOUT_GRACE_MS, msg, grace: TIMEOUT_KILL_GRACE_MS },
  });
  /* unref 只是"别拿它吊着父进程的事件循环"——线程照跑，定时器照响。 */
  w.unref();
  return undefined;
}

/**
 * **谁在收着输出**（`OMNI_CAPTURE=1`）：常驻工人（`studio/worker.js`）把
 * `process.stdout.write` 换成了收集器，而 `stdio: 'inherit'` 的孩子**绕过它直接写 fd 1** ——
 * 那一格在工人里正是 NDJSON 协议的通道。症状（量出来的）：Studio 上 `.asy` 跑出来
 * `code=0` 而输出是空的（整份 EPS 漏进了协议管子，池子那侧只能把它当坏帧丢掉）。
 *
 * 所以这一档下：孩子的两股输出都走 `pipe`，拿到之后**从这一侧的 write 递出去** ——
 * 于是它落进收集器里；给调用方的那两格照旧空着（`'o'` 与默认两种 mode 本来就是
 * "已经出去了"的语义，不能改，不然上面那层会把同一段话印两遍）。
 * stdin 也从 `inherit` 收成 `ignore`：孩子一伸手就会吃掉协议的字节。
 */
const CAPTURED = () => env('OMNI_CAPTURE') === '1';

function spawnRun(cmd, argv, mode, feed) {
  const cap = CAPTURED();
  const stdio = mode === 'c' ? ['ignore', 'pipe', 'pipe']
    : mode === 'o' ? ['ignore', 'inherit', 'pipe']
      : ['inherit', 'inherit', 'inherit'];
  if (cap) {
    for (let i = 0; i < 3; i++) if (stdio[i] === 'inherit') stdio[i] = i === 0 ? 'ignore' : 'pipe';
  }
  if (feed !== null) stdio[0] = 'pipe';
  // maxBuffer 必须显式给：node 的默认是 1 MiB，而 C 侧的实现没有这个上限。
  // `omni bootstrap` 要收下另一代编译器 1.7 MB 的 stdout，默认值会 ENOBUFS。
  const opts = { encoding: 'utf8', stdio, maxBuffer: 1 << 28 };
  if (feed !== null) opts.input = feed;
  /* 时限是**剩下的那一段**，不是全额：`run` 在 spawn 之前还编了一趟。已经到点就给 1ms
   * （给 0 在 node 那边等于"不限"）。 */
  if (DEADLINE_MS > 0) {
    const left = DEADLINE_MS - Date.now();
    opts.timeout = left > 0 ? left : 1;
    /* **SIGTERM 而不是 SIGKILL**（第一百五十五片）：孩子若是我们自己的产物，它接得住这一枪
     * 并且会把 profile 写完（`omni_prof.c` 的 `pf_on_term`）。不接的（外来的 cc、别人的
     * 程序）由 worker 那把 KILL 兜底 —— 那一枪照旧在，只是晚了一格宽限。 */
    opts.killSignal = 'SIGTERM';
  }
  const r = node('node:child_process').spawnSync(cmd, argv, opts);
  /* 收着输出那一档（见 `CAPTURED`）：本来 `inherit` 的那两格现在在手里，递给这一侧的
     write —— 落进收集器。**递出去的就不再回给调用方**（`'o'` 与默认 mode 的语义是
     "已经出去了"），不然同一段话会被印两遍。 */
  const forward = (out, err) => {
    if (!cap) return [out, err];
    let o = out;
    let e = err;
    if (mode !== 'c') {
      if (o !== null && o !== undefined && o !== '') { process.stdout.write(o); o = ''; }
      if (mode !== 'o' && e !== null && e !== undefined && e !== '') { process.stderr.write(e); e = ''; }
    }
    return [o === null || o === undefined ? '' : o, e === null || e === undefined ? '' : e];
  };
  if (r.error !== undefined && r.error !== null) {
    /* 时限那一枪不是"起不来"：node 把它记成 ETIMEDOUT。回 124 —— 与 timeout(1) 同一个
     * 约定，让上面那层能把"超时"和"程序自己失败了"分开说。 */
    if (r.error.code === 'ETIMEDOUT') {
      const [o, e] = forward(r.stdout, r.stderr);
      return [124, o, e];
    }
    throw new Error(`cannot spawn: ${r.error.message}`);
  }
  {
    const [o, e] = forward(r.stdout, r.stderr);
    return [r.status === null ? 128 : r.status, o, e];
  }
}

export function tmpDir() {
  return node('node:os').tmpdir();
}

/**
 * 墙上时钟毫秒。刻意不是 CPU 时间：要计的是"这一步花了多久"，而其中大头是 clang
 * 和另一代编译器这些**子进程**，CPU 时间量不到它们。
 */
export function nowMs() {
  return Date.now();
}

/**
 * 到此刻为止的**峰值**常驻内存，字节。
 *
 * 为什么值得占一格宿主 ABI：这条腿上墙上时间的大头常常不是 CPU 而是内存压力 —— 量出来的，
 * emit-c 编译器自己一趟是 35.6s 墙 / 25.9s 用户 / **峰值 1.56 GB**、页回收 147 万，
 * 同一步在不同轮次能差两倍。没有这个数，"慢"就只能靠猜。
 *
 * 单位统一成**字节**：node 的 `resourceUsage().maxRSS` 是 KB（所有平台一样，node 自己归一
 * 过），而 C 那侧 `getrusage` 的 `ru_maxrss` 在 macOS 上是字节、在 Linux 上是 KB ——
 * 两个宿主各自在自己那一侧换成字节，别把这个坑留给调用方。
 */
export function maxRssBytes() {
  return process.resourceUsage().maxRSS * 1024;
}

/**
 * 进程起来到此刻，**毫秒**（整数）。
 *
 * 为什么值得占一格宿主 ABI：`-v` 那几行印的是"每一步花了多久"，而外面 `time` 看到的
 * `real` 总比它们的和大一截 —— 差的就是**宿主自己的启动**（node 加载 + 把整棵编译器
 * import 进来）。没有这一格，那一截只能猜，于是"哪儿慢"的账永远差一块。
 *
 * 两侧的起点刻意不同、也只能不同：node 这边是进程启动（`process.uptime()`），C 那边是
 * `omni_host_init`（main 的第一行）—— 原生腿的 pre-main 本来就近似为零。
 */
export function upMs() {
  return Math.trunc(process.uptime() * 1000);
}

/**
 * 插件加载（ADR-0021 的 S4）：**这条腿上没有**。
 *
 * node 没有同步的 ESM import（`import()` 是异步的，而驱动整条是同步的），所以开发时
 * 这条腿只有内建那一套 —— 装着什么就是编进来的那些。产品是 C 那条腿：它有 `dlopen`，
 * 扫目录、按文件名认、`dlsym("omni_plugin_init")` 全是同步的。
 * 拒得响而不是悄悄当"没装"：后者会让人以为插件坏了。
 */
/**
 * 这条腿装得动插件吗（ADR-0021 的 S4）。
 *
 * 有了它，"装了插件但这条腿加载不了"就能**在用到那门语言的时候**才响 —— 而不是一开机
 * 就把整个编译器噎住。量出来的：dist/plugins 里放一格插件之后，`C2 = C1 emit-js`
 * 那道不动点当场红了（omni.mjs 一启动就抛），而它跟那门语言半点关系都没有。
 */
export function pluginsOk() {
  return false;
}

export function pluginLoad(path) {
  throw new Error(`node 这条腿上没有插件加载（${path}）：装着的就是编进来的那些；`
    + '插件是 C 那条腿的事（dlopen + omni_plugin_init）');
}

/**
 * **本地时间**的日历字段，14 位数字：`YYYYMMDDHHMMSS`（月 01-12、日 01-31，全部补零）。
 *
 * 为什么是一个字符串而不是一串数：`__DATE__` / `__TIME__` 要六个字段是**同一个瞬间**的
 * （tcc 在那儿只 `time()` 一次），一个字段一次调用会横跨秒边界；而回一个 list 就要走
 * `list<dynamic>` 那套宏（那一格只在生成的 TU 里存在，见 omni_js_host.h）。
 * 排版**不在这里**做 —— tcc 那两句 snprintf 的格式是编译器的事（frontend-c/tccpp.js），
 * 宿主只负责"读一次时钟"。
 *
 * 为什么非要一个宿主 op：`new Date()` 不在我们自己那个 JS 前端认的构造之列（只认
 * Array / Map / Set / Error 与本文件里声明的类），tccpp.js 里直接写它会让**自举那一路**
 * 编不过（tests/mir 的 lower/cli.js 当场报 'new Date' is not supported）。
 */
export function localStamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * "运行中的程序镜像所在目录"。node 上是这个文件所在的目录（src/host），C 侧是可执行
 * 文件所在目录 —— 从这里怎么走到 runtime/ 与 lib/ 是调用方的事，两代的布局本来就不同。
 */
export function installDir() {
  const url = import.meta.url;
  let p = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url;
  /* **盘符前那个斜杠**：Windows 上 `import.meta.url` 是 `file:///C:/…`，切掉 `file://`
   * 剩下的是 `/C:/Users/…` —— 那不是一条能用的 Windows 路径。于是 sysroot / share /
   * 插件全都找不着，量到的原话是
   *   `没有 x86_64-win32 那一份 sysroot —— 自己给一份：--sysroot DIR`
   * 而 `src/sysroot/win32` 明明就在那儿。`fileURLToPath` 干的就是这件事，这儿手做一遍：
   * 宿主这一层要能在没有 node 的腿上原样搬过去，所以不 import `node:url`。 */
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  /* 两种分隔符都认（第 win-c-backend 刀）：编出来的那份核心在 Windows 上，这一格拿到的
   * 是 `C:\omni\bin\omni.exe`（argv[0]，见 backend-c 里 `import.meta.url` 那一格）——
   * 只找 '/' 的话一个都找不到、回 '.'，于是 sysroot / share / 插件全部落到当前目录旁边去找。
   * 量到的原话是 `没有 arm64-win32 那一份 sysroot`，以及紧接着一条更难看的
   * `ENOENT: cannot read directory 'C:/Users/All Users/Application Data'`
   * —— 那是 `srcStamp()` 从 `.` 的上一层开始往下走，撞上了 Windows 的那个拒绝访问的交接点。 */
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '.' : p.slice(0, i);
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

