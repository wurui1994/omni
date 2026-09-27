// tests/python/run.js —— python 这一门的**外部尺子**：同一份 .py，我们跑一遍、本机
// `python3` 跑一遍，**stdout 逐字节相同**才算过。
//
// 为什么判据长这样：python 是别人的语言，我们没有资格自己写期望值。CPython 就在那儿 ——
// 参考是别人的实现，不是我们的复述（与 `tests/go/run.js` 一条规矩）。
//
// 三档结果，各有各的含义，不许糊在一起：
//   * `ok`   —— 两边逐字节相同。
//   * `skip` —— 我们**明说还没接**（报错里带"还没接"），或者本机 python3 自己也跑不动
//               （这棵参考树是 3.16.0a0，`lazy import` / `except A, B:` 在 3.14 上是语法错）。
//   * `FAIL` —— 编得出来、跑得起来，但**答得不一样**，或者崩了。那是真错。
//
// **默认量两条腿**：`--mode js`（发 JS 再跑）与 `omni build`（发 C 再编再跑）——
// 两条都是**编出来的**，也就是这门语言的去处（主线是编到 C，JS 那条走同一条管线）。
// 解释器那条最慢、最不重要，默认不跑；要它就 `--legs interp,js,c`。
// 为什么至少两条：浮点转串、负数取模这些格子**每条腿各有一份实现**
// （`backend-js/prelude.js` / `runtime/omni_fmt.c`），只量一条等于只量了一半。
//
// 挑着跑：`node tests/python/run.js kwargs listops`（名字里带这几个字的例子）。

import { execFile, execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const examples = join(root, 'ext', 'python', 'examples');
const out = join(root, '.omni-cache', 'py-e2e');
mkdirSync(out, { recursive: true });

/** 一趟命令，两条流一起收（报错也是输出的一部分）。同步那一版只给"问一句版本"用。 */
function run(cmd, args, timeout = 120000) {
  return execFileSync(cmd, args, {
    cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * **异步那一版** —— 并行靠它。`execFileSync` 是把整条事件循环按住的，
 * 拿它去"并行"只会排着跑（量出来的：改成池子之后一分五十六，与排着跑一个数）。
 * 出错时把 stdout / stderr 一起交给上头（判"还没接"要看那两条流）。
 */
function runP(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: root, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err === null) { resolve(stdout); return; }
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

let pass = 0;
let fail = 0;
let skip = 0;

/**
 * **挑着跑**（`node tests/python/run.js kwargs listops` / `--legs interp,c`）。
 *
 * 为什么要有：整套是 26 份例子 × 3 条腿，一趟三分钟 —— 改一格东西要等三分钟才知道结果，
 * 那就没人会在改完之后立刻跑它。口径与 `tests/glr/run.js` 一条：不带参数照旧跑全套。
 *
 * 判据这件事不打折：**提交之前跑全套**。挑着跑是改的过程里用的。
 */
const argv = process.argv.slice(2);
const legsArg = (() => {
  const i = argv.indexOf('--legs');
  return i >= 0 && i + 1 < argv.length ? argv[i + 1].split(',') : null;
})();
const filters = argv.filter((a) => !a.startsWith('--') && a !== legsArg?.join(','));
/**
 * **默认只跑 `--mode js` 这一条**（`--legs js,c` 才带上 C，`--legs interp,js,c` 才带解释器）。
 *
 * 为什么够：三条腿走的是**同一条编译管线**（python → 标准 IR → MIR），只有最后一段
 * 发射不同。语义上答错的那几格几乎都在管线里，js 这一条就照得出来；C 那条腿每份例子要多
 * 一次"编 C + 链"（量出来一份两三秒），提交之前带上它（`--legs js,c`）就够。
 *
 * **真正的低效不在腿数上，在每份例子都重起一个进程**：`print(1)` 这么一份
 * `node src/cli.js run --mode js` 要 **1.59s**，其中 node 自己启动 0.54s，
 * 剩下 **~1.05s 是我们这台编译器每个进程都要重付的**（整棵 `src/core` 的模块加载 +
 * 语法表）。26 份例子就是 27 秒白付。**下一刀是把这一格去掉**：一个进程里把编译器
 * 加载一次、循环编所有例子（`drive.js` 的 `sxTextOf` 那条口子），而不是靠并行去盖住它。
 */
const LEGS = legsArg ?? ['js'];

const files = readdirSync(examples).filter((f) => f.endsWith('.py')).sort()
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));

/**
 * 一份例子量一遍（两条腿），**把话攒起来最后一起印** —— 因为下面要几份一起跑。
 * 计数也攒在回值里，不动外头那三个（并行改共享的计数是自找的麻烦）。
 */
async function oneFile(f) {
  const log = [];
  let p = 0;
  let bad = 0;
  let sk = 0;
  const src = join(examples, f);
  let want = null;
  try {
    want = await runP('python3', [src]);
  } catch (e) {
    const why = String(e.stderr || e.message).trim().split('\n').pop();
    log.push(`  skip ${f}（本机 python3 自己跑不了它：${why?.slice(0, 80)}）`);
    return { log, p, bad, sk: sk + 1 };
  }
  /* 三条腿：默认（解释器）、`--mode js`（发 JS 再跑）、`build`（发 C 再编再跑）。 */
  for (const leg of LEGS) {
    let got = null;
    try {
      if (leg === 'c') {
        const exe = join(out, f.slice(0, -3));
        await runP('node', [join(root, 'src', 'cli.js'), 'build', src, '-o', exe], 300000);
        got = await runP(exe, []);
      } else {
        got = await runP('node', [join(root, 'src', 'cli.js'), 'run', src,
          ...(leg === 'js' ? ['--mode', 'js'] : [])]);
      }
    } catch (e) {
      const all = String(e.stdout || '') + String(e.stderr || e.message);
      if (/还没接/.test(all)) {
        const why = all.split('\n').filter((x) => x.trim()).pop();
        log.push(`  skip ${f} [${leg}]（缺口：${why?.slice(0, 96)}）`);
        sk += 1;
        continue;
      }
      log.push(`  FAIL ${f} [${leg}] 跑不起来：${all.split('\n').filter((x) => x.trim()).pop()?.slice(0, 120)}`);
      bad += 1;
      continue;
    }
    if (got === want) {
      p += 1;
      log.push(`  ok   ${f} [${leg}]（与 python3 逐字节相同，${want.split('\n').length - 1} 行）`);
    } else {
      bad += 1;
      const [g, w] = firstDiff(got, want);
      log.push(`  FAIL ${f} [${leg}] 输出不同\n       我们：${JSON.stringify(g)}\n       py  ：${JSON.stringify(w)}`);
    }
  }
  return { log, p, bad, sk };
}

/**
 * **几份例子一起跑**。一份例子两条腿大约 5 秒（那一秒多是 `omni build` 里我们自己编 C），
 * 26 份排着跑就是两分多钟 —— 那种长度的套件没人会在改完之后立刻跑它。
 *
 * 一处要当心：`.omni-cache` 里那几格运行时的目标文件是**按内容寻址**共享的，
 * 几个 `build` 同时**第一次**去生成它就会撞（量到过 `ENOENT … rt-stage-self/omni_js.o`）。
 * 所以**头一份先单独跑**把那几格暖上，剩下的才并行。
 */
async function main() {
  const tally = (r) => { pass += r.p; fail += r.bad; skip += r.sk; r.log.forEach((l) => console.log(l)); };
  if (files.length === 0) { console.log('  （没有对得上的例子）'); return; }
  tally(await oneFile(files[0]));
  const rest = files.slice(1);
  /* 池子宽度：核数 - 2，封在 8（`OMNI_JOBS=N` 可以按住）。留两核给 node 自己与 cc。 */
  const width = Math.max(1, Number(process.env.OMNI_JOBS)
    || Math.min(8, (cpus().length || 4) - 2));
  let next = 0;
  const workers = new Array(Math.min(width, rest.length)).fill(0).map(async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= rest.length) return;
      tally(await oneFile(rest[i]));
    }
  });
  await Promise.all(workers);
}

/** 第一处不同的那一行（全印出来没人读）。 */
function firstDiff(a, b) {
  const xs = a.split('\n');
  const ys = b.split('\n');
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    if (xs[i] !== ys[i]) return [`第 ${i + 1} 行：${xs[i] ?? '(没有了)'}`, `第 ${i + 1} 行：${ys[i] ?? '(没有了)'}`];
  }
  return [a.slice(0, 80), b.slice(0, 80)];
}

await main();

const py = (() => {
  try { return run('python3', ['--version']).trim(); } catch { return '（没有 python3）'; }
})();
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped  （尺子：${py}）`);
process.exit(fail === 0 ? 0 : 1);
