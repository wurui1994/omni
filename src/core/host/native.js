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

// 这两个 import 只在 node 上成立，而这个文件在 node 上才被执行 —— 降级之后它整个不参与
// 编译（链接器只登记"名字 -> op"）。callJsOp 靠它们把 prelude 当自己的实现跑起来。
import { JS_PRELUDE } from '../backend-js/prelude.js';
import { JS_ABI } from '../hir/js_abi.js';

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

/* ---------------------------------------------------------------- i32 的运算
 * ADR-0013 第三刀：**解释器要 32 位整数运算，而方言里没有这一格**。
 *
 * 方言只有 `int`（i64，宿主表示是 BigInt）与 `real`（f64）。于是 MIR 解释器里
 * 每一次 i32 加法都是一次 BigInt 分配 —— 量出来那是它最大的一笔成本（BBP 上 23.6 s）。
 * 而 JS 引擎对 32 位整数是有快路的（Smi + `| 0` + `Math.imul`），只是那三个算符
 * **不在封闭子集里**（编译器自己的源码要能被自己编译）。
 *
 * 所以把它们收成宿主 op —— 这正是 `native.js` 存在的理由（`js_eval`、`js_type_tag`、
 * `js_fmt_real` 都是同一类：方言表达不出、而两代产物各有一份实现的东西）。
 * 量过一把：过一次函数调用与直接写算符**一样快**（20 M 次 24 ms vs 25 ms，V8 会内联），
 * 而 BigInt 那一版是 360 ms —— 15 倍，这一刀的全部收益就在这儿。
 *
 * 值的口径：进出都是**规范形的 int32**（-2^31 .. 2^31-1 的整数，JS 的 number）。
 * 除零**不在这里查** —— 调用方（解释器）要先报那条运行期错误，两条腿的消息才一致。
 */
export function i32Op(op, a, b) {
  switch (op) {
    case '+': return (a + b) | 0;
    case '-': return (a - b) | 0;
    // 32 位乘法只有 Math.imul 是对的：`a * b` 先在 double 里丢精度，再 `| 0` 已经错了
    case '*': return Math.imul(a, b);
    case '/': return (a / b) | 0;
    case '%': return (a % b) | 0;
    case 'u/': return ((a >>> 0) / (b >>> 0)) | 0;
    case 'u%': return ((a >>> 0) % (b >>> 0)) | 0;
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    // 移位的计数掩码 31（wasm 的 i32.shl 就是 count mod 32，tcc 那边同样掩码）
    case '<<': return a << (b & 31);
    case '>>': return a >> (b & 31);
    case 'u>>': return (a >>> (b & 31)) | 0;
    default: throw new Error(`i32Op: 不认识的运算 ${op}`);
  }
}

/** 位当**无符号** 32 位读：回一个 [0, 2^32) 的 number。无符号比较与除法都过它。 */
export function i32ToU(x) {
  return x >>> 0;
}

/** 一个 double 折成 int32（ECMAScript 的 ToInt32）。浮点 -> i32 的转换过它 ——
 *  NaN 与无穷落成 0，与解释器从前那句 `Number.isFinite(…) ? asIntN(32, …) : 0` 同值。 */
export function i32Wrap(x) {
  return x | 0;
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
 * 印字与退出，不然两边会抢着说话。
 */
const TIMEOUT_GRACE_MS = 500;
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
   * 自己那条转发到父进程的管子（枪响之后没人再去抽它）。 */
  const src = "const d = process.getBuiltinModule('node:worker_threads').workerData;"
    + 'setTimeout(() => {'
    + "process.getBuiltinModule('node:fs').writeSync(2, d.msg);"
    + "process.kill(process.pid, 'SIGKILL');"
    + '}, d.ms);';
  const { Worker } = node('node:worker_threads');
  const w = new Worker(src, { eval: true, workerData: { ms: ms + TIMEOUT_GRACE_MS, msg } });
  /* unref 只是"别拿它吊着父进程的事件循环"——线程照跑，定时器照响。 */
  w.unref();
  return undefined;
}

function spawnRun(cmd, argv, mode, feed) {
  const stdio = mode === 'c' ? ['ignore', 'pipe', 'pipe']
    : mode === 'o' ? ['ignore', 'inherit', 'pipe']
      : ['inherit', 'inherit', 'inherit'];
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
    opts.killSignal = 'SIGKILL';
  }
  const r = node('node:child_process').spawnSync(cmd, argv, opts);
  if (r.error !== undefined && r.error !== null) {
    /* 时限那一枪不是"起不来"：node 把它记成 ETIMEDOUT。回 124 —— 与 timeout(1) 同一个
     * 约定，让上面那层能把"超时"和"程序自己失败了"分开说。 */
    if (r.error.code === 'ETIMEDOUT') {
      return [124, r.stdout === null || r.stdout === undefined ? '' : r.stdout,
        r.stderr === null || r.stderr === undefined ? '' : r.stderr];
    }
    throw new Error(`cannot spawn: ${r.error.message}`);
  }
  return [r.status === null ? 128 : r.status, r.stdout === null ? '' : r.stdout, r.stderr === null ? '' : r.stderr];
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
  const p = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url;
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

/* ---------------------------------------------------------------- 宿主里的 eval */

// `omni run` 与 REPL 是"生成 JS，在本进程里跑掉"。这件事只有 JS 宿主能做，原生构建里
// 那两个 op 是一句清楚的错误（runtime/omni_js_host.c）。放进 ABI 而不是直接写
// `new Function`，是因为编译器自己的源码要能被降级 —— `new Function` 不在语言子集里。

/**
 * 这个宿主有没有 JS 引擎。node 上有，原生构建上没有 —— `omni run` 靠它决定走"生成 JS
 * 在本进程里跑掉"还是走 C 路径，而不是撞上 js_eval 那句错误。宿主的错误不是可以 catch
 * 的异常，所以能力必须**先问**，不能试了再说。
 */
export function hasJsEngine() {
  return true;
}

/**
 * dynamic 的运行期标签名（"int" / "real" / "list" / "dict" / "set" / "function" …）。
 * 解释器要靠它认出一个 dynamic 里装的是什么（ADR-0013）：`instanceof Map` 不在语言子集里
 * （ADR-0011 决策 15），而 C 侧本来就有标签，所以这件事只能是一条 ABI op。
 * 名字必须与 prelude 的 $dynTag 逐字相同 —— 它们会进错误消息。
 */
export function typeTag(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  switch (typeof v) {
    case 'boolean': return 'bool';
    case 'bigint': return 'int';
    case 'number': return 'real';
    case 'string': return 'string';
    case 'function': return 'function';
    default:
      if (v instanceof Map) return 'dict';
      if (v instanceof Set) return 'set';
      if (Array.isArray(v)) return 'list';
      return 'function';  // 闭包记录 { fp, c_* }
  }
}

/**
 * 在**宿主的全局作用域**里跑一段 JS，回它的值。
 *
 * 间接 eval 而不是 `new Function`：后者的函数体是一层函数作用域，片段里的
 * `function u_f(){}` 与 `var g_x` 都关在里面，下一次调用看不见。REPL 的 js 引擎要的
 * 恰好是相反的一件事 —— 一批输入编出一份产物片段，装进同一个全局作用域，于是上一批的
 * 函数与全局量这一批还在（增量）。整程序的 `omni run` 在这一点上无所谓，两种都跑得掉。
 * 也不用直接 eval：那种在调用者的词法作用域里跑，同样进不了全局。
 */
export function evalJs(code) {
  // eslint-disable-next-line no-eval
  const indirect = eval;
  return indirect(code);
}

/**
 * real 的两种文本化，作为宿主 op（ADR-0013）。
 *
 * 为什么是 op 而不是解释器里的一份 JS：语言的 print 与 repr 在两代产物里已经各有一份
 * 实现（prelude 的 $fmt_g/$repr_real 与 runtime 的 omni_str_real/omni_repr_real），
 * 解释器再写第三份，就等于给"同一个 double 打印出同一串字符"这件事多开一条会分叉的路。
 * 收成 op 之后，解释器在哪个宿主上就用那个宿主的那一份 —— 和后端逐字节一致是构造性的。
 *
 * 这一份（node 宿主）是 $fmt_g 的同一套算法：C 的 %.6g，-4 <= exp < P 用定点，
 * 否则指数形式，去掉尾随零。
 */
function fmtG(x, P) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const exp = Number(x.toExponential(P - 1).split('e')[1]);
  if (exp >= -4 && exp < P) {
    let s = x.toFixed(Math.max(0, P - 1 - exp));
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  const parts = x.toExponential(P - 1).split('e');
  let m = parts[0];
  if (m.indexOf('.') >= 0) m = m.replace(/0+$/, '').replace(/\.$/, '');
  const sign = parts[1][0] === '-' ? '-' : '+';
  const digits = parts[1].replace(/^[+-]/, '').padStart(2, '0');
  return m + 'e' + sign + digits;
}

/** print / to_string 上的 real：%.6g */
export function fmtReal(x) {
  return fmtG(x, 6);
}

/**
 * `(sfix E N)` 上的 real：C 的 `%.Nf`（ADR-0016 第八刀）。
 *
 * **不能用 `toFixed`**：那两者只在**恰好一半**上不一样，而那一处不是罕见情形 ——
 * `0.125` 到两位，C 给 `0.12`（就近取偶，IEEE-754 的默认舍入），JS 给 `0.13`
 * （ECMA-262 规定"两个都最近时取较大的 n"）。挑的是 **C 那一边**：jancy 的 printf
 * 底下就是 C 的 printf，而"jancy 不向方言妥协"这条纪律要的是 jancy 的答案。
 *
 * 于是这里按**精确值**算：double 就是 `m * 2^e`（m、e 都是整数），所以 `|x| * 10^N`
 * 是一个精确的有理数 `num / den`，取整与判"是否正好一半"都用 BigInt 做，没有浮点误差。
 */
export function fmtFixed(x, p) {
  const f = Number(p);
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const hi = dv.getUint32(0);
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(dv.getUint32(4));
  const be = (hi >>> 20) & 0x7ff;
  let e;
  if (be === 0) e = -1074;                      // 次正规数：没有那个隐含的 1
  else { m |= 1n << 52n; e = be - 1075; }
  let k;
  if (e >= 0) k = m * (1n << BigInt(e)) * 10n ** BigInt(f);
  else {
    const den = 1n << BigInt(-e);
    const num = m * 10n ** BigInt(f);
    k = num / den;
    const r2 = (num % den) * 2n;
    // 就近取偶：正好一半时只在 k 是奇数的时候进位
    if (r2 > den || (r2 === den && (k & 1n) === 1n)) k += 1n;
  }
  let s = k.toString();
  if (f > 0) {
    if (s.length <= f) s = s.padStart(f + 1, '0');
    s = `${s.slice(0, s.length - f)}.${s.slice(s.length - f)}`;
  }
  return neg ? `-${s}` : s;
}

/**
 * `(ssci E N)` 上的 real：C 的 `%.Ne`（ADR-0016 第三十刀）。
 *
 * 与 `fmtFixed` 同一条纪律（按精确值算、就近取偶），只是"小数点在哪"换了：`%e` 要的是
 * `d.dddde±dd` —— 整数部分**正好一位**，所以先把十进制的那一位数出来（`k`），再对
 * `|x| / 10^(k-N)` 取整，收到 N+1 位数字。
 *
 * 数 `k` 不走 `Math.log10`（10 的整数次幂附近它会差一格），走精确值：`e >= 0` 时
 * `m * 2^e` 本身就是整数，位数一数就有；`e < 0` 时 `m / 2^f = m * 5^f / 10^f`，于是
 * `m * 5^f` 的位数减去 `f` 就是答案。
 *
 * 进位能把 N+1 位顶成 N+2 位（`%.2e` 的 `9.999` 是 `1.00e+01`），那时指数加一。
 */
export function fmtSci(x, p) {
  const f = Number(p);
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  let ds;
  let k = 0;
  if (a === 0) ds = '0'.repeat(f + 1);
  else {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, a);
    const hi = dv.getUint32(0);
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(dv.getUint32(4));
    const be = (hi >>> 20) & 0x7ff;
    let e;
    if (be === 0) e = -1074;                      // 次正规数：没有那个隐含的 1
    else { m |= 1n << 52n; e = be - 1075; }
    if (e >= 0) k = (m << BigInt(e)).toString().length - 1;
    else k = (m * 5n ** BigInt(-e)).toString().length - 1 + e;
    const s = k - f;
    let num = m;
    let den = 1n;
    if (e >= 0) num *= 1n << BigInt(e); else den = 1n << BigInt(-e);
    if (s >= 0) den *= 10n ** BigInt(s); else num *= 10n ** BigInt(-s);
    let q = num / den;
    const r2 = (num % den) * 2n;
    // 就近取偶：正好一半时只在 q 是奇数的时候进位
    if (r2 > den || (r2 === den && (q & 1n) === 1n)) q += 1n;
    if (q >= 10n ** BigInt(f + 1)) { q /= 10n; k += 1; }
    ds = q.toString();
  }
  let s = f > 0 ? `${ds.slice(0, 1)}.${ds.slice(1)}` : ds;
  const ae = k < 0 ? -k : k;
  // 指数**至少两位**、符号一定印（C99 7.19.6.1）
  s += `e${k < 0 ? '-' : '+'}${ae < 10 ? `0${ae}` : `${ae}`}`;
  return neg ? `-${s}` : s;
}

/**
 * `(sgen E N)` / `(sgenk E N)` 上的 real：C 的 `%.Ng` / `%#.Ng`（ADR-0016 第三十一刀）。
 *
 * C99 7.19.6.1 把 `%g` 定义**在 `%e` 与 `%f` 之上**，所以这里也照那个次序搭：
 *   1. `P = N == 0 ? 1 : N`（精度 0 在 C 里等于 1）；
 *   2. `X` 是"按 `%.{P-1}e` 印出来会用的指数"—— 注意是**舍入之后**那个（`%.2g` 的 99.9
 *      舍成 `1.0e+02`，X 是 2 而不是 1），所以只能先真的印一遍 `%e` 再读它的指数；
 *   3. `-4 <= X < P` 时用 `%.{P-1-X}f`，否则用 `%.{P-1}e`；
 *   4. 没写 `#` 时**去掉小数部分的尾随零**（点后面空了连点一起去）；`#` 就是"不去"。
 *
 * 第 4 步是 `%g` 与方言里 `(tostr E N)` 的差别所在 —— 那一条永远去零，等于只有这里的
 * `keep = false` 那一支。
 */
export function fmtGen(x, p, keep) {
  const P = Number(p) === 0 ? 1 : Number(p);
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  const es = fmtSci(x, BigInt(P - 1));
  const X = Number(es.slice(es.indexOf('e') + 1));
  const s = (X >= -4 && X < P) ? fmtFixed(x, BigInt(P - 1 - X)) : es;
  const ei = s.indexOf('e');
  let m = ei < 0 ? s : s.slice(0, ei);
  if (keep) {
    // `#` 这一支还带着 `%f` / `%e` 上那条"小数点一定印"：`%#.0g` 印 1.5 是 `2.`、
    // `%#.1g` 印 100 是 `1.e+02`（选中的样式精度是 0 时点会没了，这里补回来）
    if (m.indexOf('.') < 0) return ei < 0 ? `${m}.` : `${m}.${s.slice(ei)}`;
    return s;
  }
  if (m.indexOf('.') >= 0) {
    while (m.endsWith('0')) m = m.slice(0, -1);
    if (m.endsWith('.')) m = m.slice(0, -1);
  }
  return ei < 0 ? m : m + s.slice(ei);
}

/** `(tostr E N)` 上的 real：N 位有效数字。位数是 int，也就是 BigInt，这里转一次 */
export function fmtRealG(x, p) {
  return fmtG(x, Number(p));
}

/** repr 上的 real：15/16/17 位里第一个能往返的，末尾补 ".0" 让类型也往返 */
export function reprReal(x) {
  for (let p = 15; p <= 17; p++) {
    const s = fmtG(x, p);
    if (Number(s) === x) return reprTail(s);
  }
  return reprTail(fmtG(x, 17));
}

function reprTail(s) {
  return /[.eE]/.test(s) ? s : `${s}.0`;
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

/* ------------------------------------------------------------ 按名字调一条 op
 * 解释器（ADR-0013）唯一的出口：它手里的 op 名字是运行期的值，而两个后端里 op 调用
 * 都是编译期展开的。降级之后这一条走 js_call_op —— 两个后端各自按 JS_ABI 表生成那个
 * 分派函数（emit.js 的 callOpDispatch）。
 *
 * node 这一份刻意**就是 prelude 自己**：prelude.js 导出的是源码文本，这里把它跑起来，
 * 取出那 138 个 $js_* 当实现。于是"解释执行"和"编译成 JS 再执行"用的是同一份代码，
 * 一个字符都不会分叉 —— 决策 5 的做法在这里是最省的：省掉 138 份手抄的包装。
 */
const JS_OPS = (() => {
  const entries = Object.entries(JS_ABI).filter(([, a]) => a.js !== '$js_call_op');
  // 按 **op 名字** 建表（不是 $ 前缀的实现名）：调用点手里拿的是 op 名字，每次调用再拼一次
  // `$${name}` 是白花的字符串拼接 —— 这条路每个 JS op 都要过。
  const pick = entries.map(([n, a]) => `${JSON.stringify(n)}: typeof ${a.js} === 'function' ? ${a.js} : null`);
  // eslint-disable-next-line no-new-func
  return new Function(`${JS_PRELUDE}\nreturn {${pick.join(',')}};`)();
})();

export function callJsOp(name, args) {
  const f = JS_OPS[name];
  if (!f) throw new Error(`no such op: ${name}`);
  return f(...args);
}

/**
 * 解释器造出来的函数值，补成这一代的闭包记录（ADR-0013 决策 3）。
 *
 * 只有这一代需要：在 node 上直接跑源码的时候，解释器的 lambda 就是个裸 JS 函数，而宿主库
 * 那些回调 op 调函数值走的是 `f.fp(f, args)`（prelude 的 $callFn、C 的 omni_js_call）。
 * 编译出来的两代里 lambda 本来就是 `{ fp, c_* }` / 闭包记录，所以那两边 js_wrap_fn 是恒等。
 */
export function wrapFn(f) {
  return { fp: (self, args) => f(self, args) };
}

/** 调一个函数值：实参是一条 list（JS 的函数在 Omni 里只有这一个签名） */
export function callFnValue(f, args) {
  if (f === null || f === undefined) throw new Error('call of a null function value');
  return f.fp(f, args);
}
