#!/usr/bin/env node
// ext/python/rt/symbols.js —— **量尺：我们出的 .o 与 clang 出的 .o，外部符号一不一样**
//
//   node ext/python/rt/symbols.js                  # 默认 Objects + Python + Parser + 核心 Modules
//   node ext/python/rt/symbols.js unicode          # 只量名字里带 unicode 的
//   node ext/python/rt/symbols.js --max-bad 3      # 放宽那道门（探路用）
//
// ## 为什么要有这一份
//
// `sweep.js` 那把尺子只回答**编得出**（出了 `.o`、没有诊断）。它管不着"编得对" ——
// 少发一个函数、把 `static` 发成外部、把一个 `extern` 的名字拼错，`.o` 照样出得来，
// 而那些要到**链接那天**才炸。这一份把那一天提前：同一份 `.c`、同一套开关，
// 我们与 clang 各出一份 `.o`，**两份的外部符号集必须一样**：
//
//   * **定义出来的**（`nm -g -U`）：一个不多、一个不少，类型也要对上；
//   * **要别人给的**（`nm -g -u`）：同样逐个对，只放过一族（见 `CC_ONLY_UNDEF`）。
//
// 这把尺子不看指令、不看优化，所以它不挑 clang 的实现自由；它盯的是**接口**——
// 一份 `.o` 对外承诺什么、又向外要什么。173 份 CPython 的 `.c` 全对上，
// 「链起来」这件事就只剩构建系统那几格了。
//
// ## 口径
//
//   * clang 那一侧的开关要与我们**语义对齐**：`-D_FORTIFY_SOURCE=0`（我们那份
//     `tccdefs.js` 就是 0，不然 clang 发的是 `__memcpy_chk` 一族）、
//     `-fno-stack-protector`（我们不发栈保护，clang 默认发 `__stack_chk_*`）。
//     这两条不是"把尺子调松"，是**让两边量的是同一件事**。
//   * 我们编不出的那几份（`sweep.js` 里的 fail）这儿**跳过** —— 那是另一把尺子的账。
//   * 门是 `--max-bad`（缺省 0）：对不上的份数超了就 exit 1。

import { existsSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesIn, flagsFor, perFileDefs, pyconfExtra } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const CLI = join(root, 'src', 'cli.js');
const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? d : argv[i + 1];
};
const NAMED = ['--src', '--inc', '--dirs', '--jobs', '--max-bad', '--cc'];
const filters = argv.filter((a, i) => !a.startsWith('-')
  && !(i > 0 && NAMED.includes(argv[i - 1])));

const SRC = argOf('--src', process.env.OMNI_CPYTHON
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython'));
const WORK = join(root, '.omni-cache', 'py-rt');
const INC = argOf('--inc', join(WORK, 'inc'));
const DIRS = argOf('--dirs', 'Objects,Python,Parser,Modules').split(',');
const ALL_MODULES = argv.includes('--all-modules');
const CC = argOf('--cc', process.env.CC ?? 'clang');
const JOBS = Number(argOf('--jobs', '4'));
/** 对不上的份数上限（棘轮）。0 = 一份都不许对不上。 */
const MAX_BAD = Number(argOf('--max-bad', '0'));

/**
 * **两边都可以有、也可以没有**的那几族（外求那一侧，两个方向都放过）。
 * 每一族都要写清"为什么这不是欠账"—— 这张表是账本，不是消音器。
 */
const SOFT = [
  {
    re: /^_(memcpy|memmove|memset|bzero)$/,
    why: '定长小块拷贝：摊成几条 load/store 或发一次调用都合规（clang 还会把 '
      + '`memset(p,0,n)` 换成 `bzero`）。量到的两个方向都有',
  },
  {
    re: /^__Py_FatalErrorFunc$/,
    why: '`Py_UNREACHABLE()` 两边落的不是同一支（`Include/pymacro.h:286-295`）：clang 走 '
      + '`__builtin_unreachable()`，我们 `__GNUC_MINOR__` 不到 4.5 又不是 `__clang__`，'
      + '落到 `Py_FatalError(…)`。**我们那支更保守**（真到了是 abort 而不是 UB）',
  },
  {
    re: /^___(isnan|isinf|isfinite|isnormal|signbit|fpclassify)[fdl]$/,
    why: 'macOS `<math.h>:159` 那道岔：`#if defined(__GNUC__) && 0 == __FINITE_MATH_ONLY__` '
      + '走头文件里那几个 `__header_always_inline`，否则发库调用。我们 `__FINITE_MATH_ONLY__` '
      + '是 1（`tccdefs.js` 的 `OS_EXTRA`，照 tcc），所以走发调用那支 —— 行为一样，慢一点。'
      + '要平掉得先有 `__builtin_inf` / `__builtin_fabs` 那一族，那是另一刀',
  },
  {
    re: /^_(copysign|fabs|sqrt|hypot|fmax|fmin|fma|round|trunc|floor|ceil)[fl]?$/,
    why: 'clang 把这几个 libm 函数当内建摊成指令（arm64 上多半一条，`fma` 就是 `fmadd`），'
      + '我们发真调用。两边算出来的是同一个数',
  },
  {
    re: /^___chkstk_darwin$/,
    why: 'clang 给大帧发的**栈探针**（darwin/arm64 的硬化措施：先踩一遍守卫页）。'
      + '我们不发 —— 少一层硬化，不改可观察行为',
  },
];
const isSoft = (n) => SOFT.some((s) => s.re.test(n));

/**
 * **一份一份记下来的已知差异**（棘轮）：在这张表里的不算门，不在的一份都不许有。
 *
 * 为什么按文件记、而不是把上面 `SOFT` 那几族再放宽：这几处差的**不是一族名字，是一段
 * 代码**（我们与 clang 走的 `#if` 不是同一支），所以要按文件写清"差的是哪一段、为什么"。
 * 一份修好了、这儿还留着，脚本会喊 —— 棘轮不许空转。
 */
const KNOWN_BAD = new Map([
  ['Python/fileutils.c',
    '`realpath` 的 `$DARWIN_EXTSN` 改名：macOS 的 `<stdlib.h>` 用 `__asm__("…")` 给它改了'
    + '符号名，我们**读掉那个名字但不改名**（tccgen 的 `skipAsmName`，那儿写了为什么）。'
    + '量过：`realpath(p, NULL)` 两个符号在本机 libSystem 上给的是同一个答案'],
  ['Python/import.c',
    '`pkgcontext` 是 `_Thread_local`：clang 出真 TLV（`__tlv_bootstrap`），我们当普通全局 ——'
    + '这条链一个线程都不起，与 `__atomic_*` 落成普通读写同一笔账。'
    + '（从前这一份还多要一个 `PyModule_FromSlotsAndSpec`：那是 `HAVE_DYNAMIC_LOADING` '
    + '被答错、动态装载那一整块没编，于是 `import_run_modexport` 成了没人引用的 static。'
    + '**那一格是这把尺子逼出来的**，已经在 `gen-pyconf.js` 里改成决定。）'],
  ['Python/pystate.c', '同 `import.c` 的第二笔（`_Thread_local` -> 普通全局）'],
  ['Python/pytime.c',
    '`__has_builtin(__builtin_available)` 那一族（`Python/pytime.c:18-20`）：clang 认，于是'
    + '`HAVE_CLOCK_GETTIME_RUNTIME` 有值、它把**带运行期回退**的两支都编进去（10.12 以下走 '
    + '`gettimeofday`）；我们不认，只编 `clock_gettime` 那一支。**本机上走的是同一条路**'],
  ['Python/pylifecycle.c',
    '同一族的另一面：`HAS_APPLE_SYSTEM_LOG` 看 `MAC_OS_X_VERSION_MIN_REQUIRED`，那一格是 '
    + '`AvailabilityMacros.h` 从 clang 给的 `__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__` '
    + '推出来的（量到 clang 给 270000），我们没有 -> 算成 0 -> apple system log 那一整块'
    + '（`os_log` 那几个名字）我们没编。下一刀：给 osx 的预定义表补上那一格'],
]);

if (!existsSync(join(SRC, 'Include', 'Python.h'))) {
  process.stdout.write(`py-rt/symbols: 参考树不在（${SRC}），跳过\n`);
  process.exit(0);
}
const PYCONF = join(INC, 'pyconfig.h');
if (!existsSync(PYCONF)) {
  mkdirSync(INC, { recursive: true });
  process.stdout.write(`py-rt/symbols: 探一份 pyconfig.h -> ${PYCONF}\n`);
  const g = spawnSync(process.execPath,
    [join(here, 'gen-pyconf.js'), '--src', SRC, '--out', PYCONF,
      '--extra', pyconfExtra(DIRS, ALL_MODULES)], { encoding: 'utf8' });
  if (g.status !== 0) {
    process.stdout.write(`py-rt/symbols: gen-pyconf 没过：\n${g.stderr}${g.stdout}`);
    process.exit(1);
  }
}

/** clang 那一侧的开关：与 `flagsFor` 一格一格对上，外加两条"语义对齐"的。 */
const ccFlags = (out, src, extra = []) => ['-c', '-std=c11', '-w',
  '-D_FORTIFY_SOURCE=0', '-fno-stack-protector',
  '-DPy_BUILD_CORE', '-D_Py_USE_GCC_BUILTIN_ATOMICS=1', ...extra,
  /* 我们那一侧的 `pyconfig.h` 是 `-I` 找得到就行（CPython 的头自己 include 它），
   * clang 这一侧同理 —— 两边找的是同一份。 */
  '-I', INC, '-I', join(src, 'Include'), '-I', join(src, 'Include', 'internal'),
  '-I', join(src, 'Objects'), '-I', join(src, 'Python'), '-I', join(src, 'Modules'),
  '-o', out];

/** 跑一条命令，回 `{ code, out, err }`。 */
function run(cmd, args) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    p.stdout.on('data', (b) => { so += String(b); });
    p.stderr.on('data', (b) => { se += String(b); });
    p.on('close', (code) => done({ code, out: so, err: se }));
    p.on('error', () => done({ code: -1, out: '', err: `起不来：${cmd}` }));
  });
}

/** `nm` 读一份 `.o`：`kind` 为 `U` 取定义出来的、`u` 取要别人给的。回名字的 Set。 */
async function syms(obj, kind) {
  const r = await run('nm', ['-g', `-${kind}`, obj]);
  if (r.code !== 0) return null;
  const out = new Set();
  for (const line of r.out.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    out.add(t.split(/\s+/).pop());
  }
  return out;
}

const only = (a, b, soft = false) => [...a].filter((x) => !b.has(x)
  && !(soft && isSoft(x))).sort();

const SYMDIR = join(WORK, 'sym');
mkdirSync(SYMDIR, { recursive: true });

/** 一份的结果：`{ name, kind: 'ok'|'bad'|'skip', why }`。 */
async function one(d, f) {
  const name = `${d}/${f}`;
  const stem = join(SYMDIR, `${d}-${f}`.replace(/[/.]/g, '-'));
  const src = join(SRC, d, f);
  const ours = `${stem}-ours.o`;
  const theirs = `${stem}-cc.o`;
  const defs = perFileDefs(name, SRC);
  const a = await run(process.execPath, [CLI, ...flagsFor(ours, INC, SRC, defs), src]);
  if (!a.out.includes(ours)) return { name, kind: 'skip', why: '我们还编不出（sweep 那把尺子的账）' };
  const b = await run(CC, [...ccFlags(theirs, SRC, defs), src]);
  if (b.code !== 0) return { name, kind: 'skip', why: `clang 自己也编不出：${b.err.split('\n')[0]}` };

  const bad = [];
  const [dOurs, dCc] = [await syms(ours, 'U'), await syms(theirs, 'U')];
  const [uOurs, uCc] = [await syms(ours, 'u'), await syms(theirs, 'u')];
  if (dOurs === null || dCc === null || uOurs === null || uCc === null) {
    return { name, kind: 'skip', why: 'nm 读不了这一份' };
  }
  const push = (what, list) => { if (list.length > 0) bad.push(`${what}：${list.join(' ')}`); };
  push('只我们定义了', only(dOurs, dCc));
  push('只 clang 定义了', only(dCc, dOurs));
  /* 外求那一侧两个方向都放过 `SOFT` 那几族（理由见它头上那张表） */
  push('只我们要', only(uOurs, uCc, true));
  push('只 clang 要', only(uCc, uOurs, true));
  if (bad.length > 0) {
    return { name, kind: KNOWN_BAD.has(name) ? 'known' : 'bad', why: bad.join('；') };
  }
  /* 记在 `KNOWN_BAD` 里、可现在对上了 —— 棘轮该往前一格（把那一条删掉） */
  if (KNOWN_BAD.has(name)) return { name, kind: 'fixed', why: '已经对上了：把 KNOWN_BAD 那一条删掉' };
  return { name, kind: 'ok', why: `${dOurs.size} 个定义 / ${uOurs.size} 个外求` };
}

const { files, skipped } = filesIn(SRC, DIRS, { allModules: ALL_MODULES, filters });
const results = [];
let next = 0;
async function worker() {
  for (;;) {
    const i = next;
    next++;
    if (i >= files.length) return;
    const r = await one(files[i][0], files[i][1]);
    results[i] = r;
    const MARK = { ok: 'ok  ', bad: 'BAD ', known: '记账', fixed: '修好', skip: 'skip' };
    process.stdout.write(`  ${MARK[r.kind]} ${r.name} :: ${r.why}\n`);
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: Math.max(1, JOBS) }, () => worker()));
const secs = ((Date.now() - t0) / 1000).toFixed(0);

const pick = (k) => results.filter((r) => r.kind === k);
const [ok, bad, known, fixed, skip] = ['ok', 'bad', 'known', 'fixed', 'skip'].map(pick);
process.stdout.write(`\n共 ${files.length} 份：**符号对上 ${ok.length}**、已知差异 ${known.length}、`
  + `对不上 ${bad.length}、跳过 ${skip.length}（${secs}s）\n`);
if (skipped.length > 0) process.stdout.write(`（另有 ${skipped.length} 份不进分母，见 scope.js）\n`);
if (known.length > 0) {
  process.stdout.write('\n已知差异（KNOWN_BAD 里有账）：\n');
  for (const r of known) process.stdout.write(`  ${r.name}\n    ${r.why}\n`);
}
if (bad.length > 0) {
  process.stdout.write('\n**对不上的（没账）**：\n');
  for (const r of bad) process.stdout.write(`  ${r.name}\n    ${r.why}\n`);
}
if (fixed.length > 0) {
  process.stdout.write('\n棘轮该往前：这几份已经对上了，把 KNOWN_BAD 里对应那条删掉\n');
  for (const r of fixed) process.stdout.write(`  ${r.name}\n`);
}
if (bad.length > MAX_BAD || fixed.length > 0) {
  process.stdout.write(`\n回归：没账的差异 ${bad.length} 份（门 ${MAX_BAD}）、`
    + `该收的账 ${fixed.length} 份\n`);
  process.exit(1);
}
process.stdout.write(`\n门：没账的差异 <= ${MAX_BAD} 份 —— 过\n`);
