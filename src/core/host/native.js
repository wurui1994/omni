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
 * 墙上时钟毫秒。刻意不是 CPU 时间：要计的是"这一步花了多久"，而其中大头是 clang
 * 和另一代编译器这些**子进程**，CPU 时间量不到它们。
 */
export function nowMs() {
  return Date.now();
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
