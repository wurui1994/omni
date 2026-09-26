/**
 * `ext/r/libr-run.js` —— **编译器那一档接不住时，`omni run` 自己换到 libR 那一档**。
 *
 * 为什么要有它：那一档的跑法本来是一长串手敲的环境变量与路径
 *
 *   R_HOME=.omni-cache/r-rt/libR/home R_ENABLE_JIT=0 \
 *     .omni-cache/r-rt/libR/home/bin/exec/R --vanilla --no-echo -f 那份脚本
 *
 * —— 一条命令里四件事要记对，记错一件就报得莫名其妙。而这四件事**没有一件是用户该决定的**：
 * `R_HOME` 是我们自己编出来的那一份、`--vanilla` 是"别读用户的 .Rprofile"、
 * JIT 那两格是 ADR-0046 定死的。所以 `omni run x.R` 一句就够：编译器那一档接得住就走它
 * （快 17~76 倍），接不住就自己换到这一档，并把"为什么换"印在 stderr 上（不闷着）。
 *
 * **R 自己那个编译器一格都不用**（ADR-0046，用户明说过"依赖二进制里面不能用 R 编译器的
 * 部分"）：这儿把三格都摆死 ——
 *
 *   R_ENABLE_JIT=0        跑的时候不即时编译（`compiler` 包那一层）
 *   R_COMPILE_PKGS=0      装包的时候不字节编译
 *   R_DISABLE_BYTECODE=1  连**执行**字节码那一路也关掉（`bcEval` 不进，走 AST 那条）
 *
 * 前两格是"不产生字节码"，第三格是"就算包里带着也不跑它" —— 三格一起摆才是真的不借。
 *
 * ## 为什么这一份只用封闭 ABI
 *
 * 这份文件在 `langs.js` 的 `runFallback` 上，也就是**从 `src/cli.js` 走得到** ——
 * 而那条路整棵树要能被我们自己那台 JS 前端降级（`tests/mir/run.js` 的 `lower/cli.js`
 * 那道门）。`node:child_process` / `node:fs` / `node:path` / `node:url` 都不在那个子集里
 * （ADR-0011 决策 2），所以起子进程走 `host/native.js` 的 `spawn`、问文件在不在走
 * `exists`、路径就是字符串拼 `/`（`lower/drive.js` 的 `dirOf` 同一条口径）。
 *
 * 环境变量走 `setEnv` 而不是给 `spawn` 递一张表：那张表在**封闭 ABI** 上（二十来个
 * 调用点），为这一处改它的形状不值当。`setEnv` 改的是本进程的环境，子进程继承下去 ——
 * 而这一句之后本进程只剩"等孩子、回退出码"，改了也没人再看。
 */
import { exists, spawn, stderr, env, setEnv } from '../../src/core/host/native.js';
/* 树根在 `host/treeroot.js` 上（**不是** `langs.js`：那一份 import 这一份，
   从那儿要树根就成了一个 import 环，而自举那道门不收环）。 */
import { treeRoot } from '../../src/core/host/treeroot.js';

/**
 * 与 `ext/r/build-libR.js` 里那两行是同一条路径。
 * **不 import 那份文件**：它一加载就检查参考树、没有就 `process.exit(1)`，
 * 而这儿只想知道"编好了没有"—— 问一句话不该把整个进程带走。
 *
 * 是**函数**不是常量：见上面那段环的账（常量要在模块求值期算，那时候环还没合上）。
 */
export const rHome = () => `${treeRoot()}/.omni-cache/r-rt/libR/home`;
const rExec = () => `${rHome()}/bin/exec/R`;

/** libR 那一档编好了没有（`node ext/r/build-libR.js` 出来的那个 `bin/exec/R`）。 */
export const libRReady = () => exists(rExec());

/**
 * 拿 libR 那一档跑这份脚本。回退出码；**那一档还没编**就回 `null`
 * （由调用方照旧报编译器那一档的话 —— 那句话里已经写着怎么编）。
 */
export function runWithLibR(path, argv, why) {
  if (!libRReady()) return null;
  setEnv('R_HOME', rHome());
  setEnv('R_ENABLE_JIT', '0');
  setEnv('R_COMPILE_PKGS', '0');
  setEnv('R_DISABLE_BYTECODE', '1');
  /* 时区表：R 启动时要读它，没有就一路 `unknown timezone` 的警告。 */
  const tz = env('TZDIR');
  if (tz === undefined || tz === null || tz === '') setEnv('TZDIR', '/usr/share/zoneinfo');
  /**
   * **字符那一档的 locale**：不设就是 `C`，那时 R 的 `print` 把非 ASCII 按八进制转义印出来
   * （量出来的，2026-09-26：`print("合计")` 这一档印 `[1] "\345\220\210\350\256\241"`，
   * 而 `Rscript` 印 `[1] "合计"` —— 这一档的承诺是"接不住就换档，答案照旧对"，
   * 那一行是把承诺破了）。系统装的 R 在 macOS 上是自己从 CFLocale 拿 `zh_CN` 的，
   * 我们这份自己编的没有那一段。
   *
   * 只补 `LC_CTYPE`、只在三格都没设的时候补：`LC_COLLATE` 不动（那一格管的是排序次序 ——
   * 这一档的 `sort` 明说只认按字节比的 radix，把它挪到 locale 次序上是另一回事），
   * 用户自己设了就照他的。值取 `UTF-8` 而不是 `en_US.UTF-8`：macOS 上认，而且不挑语言。
   */
  const hasLoc = (k) => { const v = env(k); return v !== undefined && v !== null && v !== ''; };
  if (!hasLoc('LC_ALL') && !hasLoc('LC_CTYPE') && !hasLoc('LANG')) setEnv('LC_CTYPE', 'UTF-8');
  stderr('omni: 编译器那一档接不住 -> 换 libR 那一档（R 自己的编译器全关：'
    + 'R_ENABLE_JIT=0 / R_COMPILE_PKGS=0 / R_DISABLE_BYTECODE=1）\n');
  if (why !== undefined && why !== null) stderr(`omni: 换档的理由 —— ${why}\n`);
  /* `'i'` = 三个流全直通：这一档的 stdout 就是用户要的输出，不经我们的手。 */
  const r = spawn(rExec(), ['--vanilla', '--no-echo', '-f', path], 'i');
  return r[0] === null || r[0] === undefined ? 1 : r[0];
}
