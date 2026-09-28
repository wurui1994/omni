#!/usr/bin/env node
// Omni — 把所有测试套件跑一遍，**一条红了也继续往下跑**。
//
// 为什么要有这个文件：`test:all` 原来是十七个 `node tests/xxx/run.js` 用 `&&` 串起来的，
// 于是第一条红的套件之后全部不跑 —— 这件事在两刀里各掩住了一次真实的红
// （js-roundtrip 那次掩了 14 个套件、incr 那次掩了 7 个），而两次都是「看起来全绿」。
// 顺序执行没问题，短路有问题。
//
// 三件事是 ADR-0023 加的（增量、依赖图、日志）：
//   1. **轴级跳过**：先算这条轴的指纹（轴目录的内容 + 这条轴上一趟装载过的那些模块的内容），
//      与"上一趟绿"的指纹一样就不跑。红的轴不入册，所以跳过只会跳已经绿过的。
//   2. **日志**：每条轴的完整输出落 `.omni-cache/test/log/<轴>.log`（上一趟挪成 `.prev.log`）。
//      要看细节读文件，不再"为了看清楚而重跑一遍"。
//   3. `FORCE=1` 全部重跑；某条轴没接子进程缓存时，指纹按整棵 `src/` 算（保守，不说谎）。
//
// **轴之间并行**（S6）：量出来的账是这样的 —— 每条轴的依赖并集都是同一份 112 个模块，里头
// 含着每一门语言的前端。所以改 `frontend-jnc/lower.js` 会让 wat / cabi / js-exec 这些
// **语义上毫无关系**的轴指纹全变、全部重跑。要让它们真的分开，得先有那个薄核心（按需装）；
// 在那之前，唯一**不靠猜**就能把这一趟压下来的办法是并行。
//
// **薄核心那一步 2026-09-27 落了**（`docs/design/on-demand-loading.md`）：`cli.js` 的静态
// import 图从 173 份模块 / 3859 KB 降到 90 份 / 1586 KB —— `lang/builtin.js` 那 12 格
// （8 门语言 4 个目标）与 `lower/langs.js` 那 13 格 adapter 现在都是"用到才装"，链接器、
// 汇编器、REPL、构建引擎、MIR 解释器也按动词分了。**所以上面那笔"指纹全变"的账应该小了
// 很多，可我没重新量过** —— 量之前别把它当已解决（这一格正是"依赖并集"，不是"总时间"）。
// 并行照旧留着：它与按需装载是叠加的，不互相替代。
//
// 轴与轴之间本来就没有顺序关系，除了三处：
//   - `bootstrap/*` 往 `dist/` 写整套产物 -> 独占，而且排在最后（`solo`）；
//   - `jit` 与 `llvm` 共用 `.omni-cache/jit` -> 同一组，组内串行（`group`）；
//   - 别的每条轴自己一格 `.omni-cache/test/<轴>`（tests/work.js），互不相干。
// 并行度 `AXES`（默认 min(4, 核数-2)）；每条轴自己的预热并行度压到 `JOBS=2`，免得
// 4×4 把机器打满反而更慢。`SERIAL=1` 回到一条一条跑（诊断时用：输出是流式的）。
//
// 读结果只看最后那张表：`FAIL` 那一列是套件级的，`N passed, M failed` 是套件自己印的。
//
//   node tests/all.js            全部（慢的那几条默认不跑，见下）
//   node tests/all.js mir sexpr  只跑名字里含这些词的（点名时慢的也跑）
//   SLOW=1 node tests/all.js     连慢的那几条一起跑（提交 / 发版前那一遍）
//   FORCE=1 node tests/all.js    不看指纹，全跑
//   SERIAL=1 node tests/all.js   一条一条跑（流式输出）
//   AXES=6 node tests/all.js     并行度 6

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, renameSync, existsSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { axisFingerprint, axisState } from './lib/incr.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const force = process.env.FORCE === '1';

// 顺序照旧（快的在前、自举在最后）—— 有些套件会用到前面套件落下的缓存目录。
// `bootstrap/link.js` 排在 `bootstrap/run.js` 前面：它是那条链的**快检**（半秒，只走
// `emit-js`），而 `run.js` 是整条自举门（四分钟）。链断了这半秒就能说清断在哪一类上。
//
// `solo` = 独占（往 `dist/` 写整套产物，不能与别人同时跑，而且排在最后）；
// `group` = 同一组内串行（`jit` 与 `llvm` 共用 `.omni-cache/jit`）。没标的都能并行。
//
// `slow` = **默认不跑**。这几条的钱不是花在我们自己的代码上，是花在外部工具链与整链重做上
// （js-exec 每个用例都要 clang 编一遍运行时 184s、bootstrap 把整个编译器编一遍 5 分钟、
// js-roundtrip 把整棵树重新生成再跑全套 66s、glsl 渲图 61s）。它们盯的是"整链还成立"，
// 不是"我这一改对不对" —— 每改一行都付这笔钱是纯浪费。
// 要跑就点名（`node tests/all.js js-exec`）或者 `SLOW=1 node tests/all.js`（提交/发版前那一遍）。
const SUITES = [
  { s: 'run.js' }, { s: 'cli/tree.js' }, { s: 'cli/verbose.js' },
  { s: 'cli/build-flags.js' }, { s: 'cli/profile.js' },
  /* 构建引擎（`omni ninja`；设计在 docs/design/build-system.md）：磁盘与执行器都是注入的，
     判的是"跑了哪些命令、什么次序、第二趟跑几条" —— 一个进程都不起，一个计时都没有。 */
  { s: 'build/run.js' },
  /* 模块（ADR-0042 第一步）报错那一面：边界的价值全在"说不通的时候说人话"。
     正面那条在 sexpr 的 cases/52-modules.sx（走五条腿比 stdout）。 */
  { s: 'sexpr/modules.js' },
  /* js 腿的摇树（产物按用到的名字裁）：小了多少 + **裁前裁后逐字节相同**。
     后一条是它唯一讲得通的判据 —— 削掉的必须是没人用的。 */
  { s: 'cli/js-trim.js' },
  /* `#lang`（ADR-0037）：默认关着那一格要报、开着要真换读入器、三处打架要报"各说了什么"，
     还有一条**中性** —— 不带那一行的文件一个字节都不受影响（词法与 s-expr 读入器各加了
     "跳第一行"那一手，它们只在真有那一行时动）。 */
  { s: 'cli/lang.js' },
  { s: 'oracle/run.js' },
  { s: 'oir/run.js' },
  { s: 'cabi/run.js' }, { s: 'wat/run.js' }, { s: 'glr/run.js' }, { s: 'mir/run.js' },
  /* 公共优化管线（ADR-0039）：每一格自己的判据 + **L1 行为一致** ——
     `tests/c/gen/*.c` 那 85 份，`omni c run` 开与不开 `OMNI_MIR_OPT=1` 的 stdout
     与退出码逐字节相同。抓出过两个真 bug：buildCfg 不认 BRTABLE（switch 的 CFG 是错的）、
     `String(-0)` 是 `"0"`（把 -0.0 折成了 0.0）。 */
  { s: 'mir/opt.js' }, { s: 'mir/reloc.js' },
  /* 栈位按活跃区间复用（第一百四十四片）：两个后端的口径是"每个 MIR 值一个栈位"，
     几万条指令的函数上那是**跑不起来**级的问题 —— CPython 的
     `_PyEval_EvalFrameDefault` 451KB 的帧踩穿 8MB 栈。这一条量那张复用表本身
     （后端怎么用它由 `tests/c` 那 300 份真跑的用例兜住）。 */
  { s: 'mir/stackhome.js' },
  /* 一个 .c 一个 .js（ADR-0047）：地址在装载期才定。把基址推开再跑，stdout 与退出码
     必须与烤死地址那一版逐字节相同 —— 这道门抓出过 `printf("…")` 那个串地址在
     `castTo` 的常量折叠里丢掉"我是地址"记号（静默错地址，答案是空串）。 */
  { s: 'mir/jsmod.js' },
  /* 闭环那一条（第一百三十五片）：`.omni` -> 生成的 C -> **我们自己那台 C 前端**的
   * `.o` -> **我们自己的链接器**的可执行文件 -> 输出与解释器逐字节相同。
   * 一个外部工具都不用，所以它守的是「整条自己的路」而不是某一格。 */
  { s: 'selfc/run.js' },
  /* **借来的那十一门语言唯一的那条路**（ADR-0044）：adapter → 标准 IR → 公共 lower →
     `.sx` → 真跑一趟，输出逐行相同。节点图那一层（`src/core/graph/` + `tests/graph/`）
     随着最后一门（go）迁完一起拆掉了 —— 一件事只有一份实现。 */
  { s: 'lower/run.js' },
  /* 同一条路上的**多文件**那一轴：`import util` 里的 util 就在旁边（`drive.js` 读、
     adapter 收 `opts.also`）。这一轴在图那条路上是红的（`unbound name`），这儿是绿的。 */
  { s: 'lower/modules.js' },
  /* go 这条腿的**端到端**判据：源码 → 公共 lower → MIR 管线 → 原生，stdout 与 `go run`
     逐字节相同（46 份）。参考是别人的实现，不是我们自己的复述。 */
  { s: 'go/run.js' },
  /* R 这条腿的**两把尺子**：八份例子逐字节对本机 `Rscript`（参考是 R 自己，不是我们的
     复述），以及那份 `gram.y` 的漂移守卫（`ext/r/r.grammar` 的正本是它 —— "正本"这句话
     只有在它一直转得出来、建得出表、条数对得上的时候才成立）。
     `Rscript` 不在、或参考树不在就各自跳过那一节。 */
  { s: 'r/oracle.js' },
  { s: 'r/libr.js' },   // libR 那一档（没建出来就整轴跳过）
  /* R 的**整个运行时**过我们自己的 C 前端（ADR-0047 的 JS 路径）：`src/main` + `src/appl`
    + `src/unix` 一份一份编，判据是一个**地板**（编过的份数只许涨，现在 90/111）。
    剩下那几份按"错的那一类"印出来 —— 那张表就是下一刀的选题单。 */
  { s: 'r/rtc.js' },
  /* python 这一门的**外部尺子**：同一份 .py，我们跑一遍、本机 `python3` 跑一遍，
     stdout 逐字节相同。两条腿都量（解释器与 `--mode js`）—— 浮点转串、负数取模这些格子
     在两条腿上各有一份实现。没有 python3 的机器上它自己跳过。 */
  { s: 'python/run.js' },
  /* **借来的那份 CPython 的 C**（`Python/dtoa.c` + `Python/pystrtod.c` 原样编进来）：
     `repr(float)` 与本机 `python3` 逐字节相同，2035 个数（手挑的边界 + 定死的位模式扫描）。
     顺带是 `src/core/build/` 那台 JS ninja 的第二个生产调用者。
     没有 python3 / 参考树 / C 编译器就自己跳过。 */
  { s: 'python/rt.js' },
  /* 同一份借来的运行时的**第四把尺子**：我们编出来的那 201 份 `.o` 链成
     `_freeze_module`、真把 26 份 `.py` 冻成 `.h`（Parser + compile + ceval + marshal
     全要对），再把 `Python/frozen.c` / `Modules/getpath.c` 那两份下游编出来。
     前三把尺子最远只到"链得上"，两回真 bug（复合字面量没归零、不完整类型的 extern
     吃掉别人的初值）它们一格都看不见。要参考树 + clang + `py:sweep` 预热过的 `obj/`，
     缺哪一样就自己跳过（8s）。 */
  { s: 'python/freeze.js' },
  // 可删除测试：删一支产生式（语法那一层）。默认只跑两门小语法 ——
  // 整跑一遍是分钟级的，量出来的数与理由写在那份文件的头上。
  { s: 'grammar/delete.js' },
  { s: 'incr/run.js' }, { s: 'c/run.js' }, { s: 'c/ldscript.js' }, { s: 'c/syscall.js' },
  // 自带 libc 的九条判据（第一百四十片）。除了前两条，都要 arm64 macOS（本机自己编、
  // 自己链、自己跑，还要 codesign），别的机器上它们自己跳过 —— 不是靠这儿挑。
  { s: 'c/libc-malloc.js' }, { s: 'c/libc-self.js' },
  { s: 'c/libc-float.js' }, { s: 'c/libc-strtod.js' }, { s: 'c/libc-libm.js' },
  { s: 'c/libc-str.js' }, { s: 'c/libc-stdio.js' }, { s: 'c/libc-time.js' },
  { s: 'c/libc-signal.js' },
  { s: 'llvm/run.js', group: 'jit' }, { s: 'sexpr/run.js' }, { s: 'asy/run.js' },
  { s: 'jnc/run.js' }, { s: 'jit/run.js', group: 'jit' },
  { s: 'gpu/run.js' },
  { s: 'glsl/run.js', slow: true },
  { s: 'js-roundtrip/run.js', slow: true },
  { s: 'js-exec/run.js', slow: true },
  { s: 'bootstrap/link.js', solo: true },
  /* 自编链的第三格（14s）：`link.js` 管"编得出"、`run.js` 管整条不动点，这一门管
     **编出来的那份真跑一趟借来的语言**。三笔静静躲过全部判据的债就是这么被抓出来的
     （import 别名遮蔽、C 侧正则缺 `[\s\S]` 与 `\2`）—— 别的轴全跑在 node 源码腿上。
     不 solo：它落在 `.omni-cache/test/selfrun/`，不碰 `dist/`。 */
  { s: 'bootstrap/selfrun.js' },
  { s: 'bootstrap/run.js', solo: true, slow: true },
];
const SCRIPTS = SUITES.map((x) => x.s);

const logDir = join(process.env.OMNI_CACHE_DIR || join(root, '.omni-cache'), 'test', 'log');
mkdirSync(logDir, { recursive: true });
const state = axisState();
const serial = process.env.SERIAL === '1';
const width = Math.max(1, Number(process.env.AXES || 0)
  || Math.min(4, (os.availableParallelism?.() ?? 4) - 2));

/**
 * 跑一条轴。输出**总是**完整落进日志；终端上：串行时流式印（诊断用），并行时先攒着、
 * 跑完整块印 —— 几条轴的行交错在一起就没法读了。
 */
function runSuite(script, logPath, stream) {
  return new Promise((resolve) => {
    const log = createWriteStream(logPath);
    const buf = [];
    const p = spawn('node', [join(here, script)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      /* 并行时把每条轴自己的预热并行度压到 2：4 条轴 × 4 路预热会把机器打满，量出来反而
         更慢（S4 那次踩过一模一样的坑）。外面显式给了 JOBS 就听外面的。 */
      env: process.env.JOBS === undefined && !serial
        ? { ...process.env, JOBS: '2' } : process.env,
    });
    const tee = (chunk) => {
      if (stream) process.stdout.write(chunk);
      else buf.push(chunk);
      log.write(chunk);
    };
    p.stdout.on('data', tee);
    p.stderr.on('data', tee);
    p.on('close', (code) => log.end(() => resolve({
      code: code === null ? 1 : code, text: buf.join(''),
    })));
  });
}

/** 这一趟要跑的那些（跳过的当场决定 —— 那一步是纯算，不用排队）。 */
const jobs = [];
const results = [];
for (let i = 0; i < SUITES.length; i++) {
  const it = SUITES[i];
  const s = it.s;
  /* 名字取目录（`run.js` 是 core）。同一个目录里两支门的话，把文件名也带上 ——
   * 不然汇总里会出现两行同名的 `bootstrap`，一行 ok 一行 FAIL，看不出哪个是哪个。 */
  const dir = s.slice(0, s.indexOf('/'));
  const base = s.slice(s.indexOf('/') + 1, s.length - 3);
  const name = s === 'run.js' ? 'core'
    : SCRIPTS.filter((x) => x.startsWith(`${dir}/`)).length > 1 ? `${dir}/${base}` : dir;
  if (filters.length > 0 && !filters.some((f) => name.includes(f))) continue;
  /* 慢的那几条默认不跑（见 SUITES 上面那段）。点名（filters 非空）或者 SLOW=1 才跑 ——
     "默认一趟里不该有 5 分钟的东西"这条是量出来的：那笔钱与"我这一改对不对"无关。 */
  if (it.slow === true && filters.length === 0 && process.env.SLOW !== '1') {
    process.stdout.write(`  slow ${name}（默认不跑：SLOW=1 或点名它才跑）\n`);
    continue;
  }

  /* 指纹按**轴目录**算：`run.js` 那条轴的目录是 tests/cases + tests/run.js，所以退回整棵
   * tests/（它自己的固件在 cases/ 里）。别的轴就是 tests/<目录>。 */
  const axisDir = s === 'run.js' ? join(here, 'cases') : join(here, dir);
  const key = name.replace('/', '-');
  const logPath = join(logDir, `${key}.log`);
  const fp = axisFingerprint(key, axisDir);
  const had = state.get(key);
  if (!force && had !== null && had.code === 0 && had.fingerprint === fp) {
    process.stdout.write(`  skip ${name}（输入没变、上一趟绿；日志：${logPath}）\n`);
    results.push({ name, code: 0, ms: 0, skipped: true, at: i });
    continue;
  }
  jobs.push({
    name, key, script: s, axisDir, logPath, at: i, solo: it.solo === true, group: it.group,
  });
}

/** 一条轴跑完：入册（只有绿的）+ 记结果。 */
async function oneJob(j, stream) {
  if (existsSync(j.logPath)) renameSync(j.logPath, join(logDir, `${j.key}.prev.log`));
  if (stream) process.stdout.write(`\n=== ${j.name} ===\n`);
  else process.stdout.write(`  >>   ${j.name} 开始\n`);
  const t0 = Date.now();
  const r = await runSuite(j.script, j.logPath, stream);
  const ms = Date.now() - t0;
  if (!stream) {
    process.stdout.write(`\n=== ${j.name} === ${(ms / 1000).toFixed(1)}s`
      + `${r.code === 0 ? '' : '  FAIL'}\n${r.text}`);
  }
  results.push({ name: j.name, code: r.code, ms, skipped: false, at: j.at });
  /* 只有绿的那一趟入册。红的不记 —— 下一趟照旧重跑，不会"跳过一条红的轴"。
   * 指纹在**跑之后**重算一次：轴自己可能落下新的依赖记录（第一趟那种）。 */
  if (r.code === 0) {
    state.put(j.key, { fingerprint: axisFingerprint(j.key, j.axisDir), code: r.code, ms });
  }
}

/** 并行那一段：把同一组的轴串成一条链，链与链之间并行（链内串行）。 */
async function runChains(list) {
  const chains = [];
  const byGroup = new Map();
  for (const j of list) {
    if (j.group === undefined) { chains.push([j]); continue; }
    if (!byGroup.has(j.group)) { const c = []; byGroup.set(j.group, c); chains.push(c); }
    byGroup.get(j.group).push(j);
  }
  let at = 0;
  const worker = async () => {
    for (;;) {
      const i = at;
      at += 1;
      if (i >= chains.length) return;
      for (const j of chains[i]) {
        // eslint-disable-next-line no-await-in-loop -- 链内是故意串行的（共用一处缓存）
        await oneJob(j, false);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, chains.length) }, () => worker()));
}

const t0all = Date.now();
if (serial) {
  for (const j of jobs) {
    // eslint-disable-next-line no-await-in-loop -- SERIAL=1 就是要一条一条来
    await oneJob(j, true);
  }
} else {
  const par = jobs.filter((j) => !j.solo);
  const solo = jobs.filter((j) => j.solo);
  if (par.length > 0) {
    process.stdout.write(`\n---- ${par.length} 条轴并行（并行度 ${Math.min(width, par.length)}）----\n`);
    await runChains(par);
  }
  for (const j of solo) {
    process.stdout.write(`\n---- 独占：${j.name} ----\n`);
    // eslint-disable-next-line no-await-in-loop -- solo 就是独占，一条一条来
    await oneJob(j, true);
  }
}

/** 汇总按 SUITES 的顺序印（并行完成的次序是乱的，读起来要稳定）。 */
results.sort((a, b) => a.at - b.at);

process.stdout.write('\n---- 套件汇总 ----\n');
let bad = 0;
let skipped = 0;
for (const r of results) {
  if (r.code !== 0) bad++;
  if (r.skipped) skipped++;
  const tag = r.code === 0 ? (r.skipped ? 'skip' : 'ok  ') : 'FAIL';
  const t = r.skipped ? '' : `  (${(r.ms / 1000).toFixed(1)}s)`;
  process.stdout.write(`  ${tag} ${r.name}${t}\n`);
}
process.stdout.write(`\n${results.length - bad}/${results.length} 个套件通过`
  + `${skipped > 0 ? `（其中 ${skipped} 条跳过：输入没变）` : ''}`
  + `，总 ${((Date.now() - t0all) / 1000).toFixed(1)}s\n`);
process.stdout.write(`日志：${logDir}\n`);
process.exit(bad === 0 ? 0 : 1);
