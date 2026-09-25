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
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
/**
 * 与 `ext/r/build-libR.js` 里那两行是同一条路径。
 * **不 import 那份文件**：它一加载就检查参考树、没有就 `process.exit(1)`，
 * 而这儿只想知道"编好了没有"—— 问一句话不该把整个进程带走。
 */
export const R_HOME = join(ROOT, '.omni-cache', 'r-rt', 'libR', 'home');
const R_EXEC = join(R_HOME, 'bin', 'exec', 'R');

/** libR 那一档编好了没有（`node ext/r/build-libR.js` 出来的那个 `bin/exec/R`）。 */
export const libRReady = () => existsSync(R_EXEC);

/**
 * 拿 libR 那一档跑这份脚本。回退出码；**那一档还没编**就回 `null`
 * （由调用方照旧报编译器那一档的话 —— 那句话里已经写着怎么编）。
 */
export function runWithLibR(path, argv, why) {
  if (!libRReady()) return null;
  const env = {
    ...process.env,
    R_HOME,
    R_ENABLE_JIT: '0',
    R_COMPILE_PKGS: '0',
    R_DISABLE_BYTECODE: '1',
    /* 时区表：R 启动时要读它，没有就一路 `unknown timezone` 的警告。 */
    TZDIR: process.env.TZDIR ?? '/usr/share/zoneinfo',
  };
  process.stderr.write(`omni: 编译器那一档接不住 -> 换 libR 那一档（R 自己的编译器全关：`
    + 'R_ENABLE_JIT=0 / R_COMPILE_PKGS=0 / R_DISABLE_BYTECODE=1）\n');
  if (why !== undefined && why !== null) process.stderr.write(`omni: 换档的理由 —— ${why}\n`);
  const r = spawnSync(R_EXEC, ['--vanilla', '--no-echo', '-f', path], { env, stdio: 'inherit' });
  if (r.error !== undefined && r.error !== null) {
    process.stderr.write(`omni: libR 那一档起不来：${r.error.message}\n`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}
