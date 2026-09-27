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

import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const examples = join(root, 'ext', 'python', 'examples');
const out = join(root, '.omni-cache', 'py-e2e');
mkdirSync(out, { recursive: true });

/** 一趟命令，两条流一起收（报错也是输出的一部分）。 */
function run(cmd, args, timeout = 120000) {
  return execFileSync(cmd, args, {
    cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
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
 * **默认只跑"编出来的"那两条腿：`--mode js` 与 `omni build` 的 C。**
 *
 * 主线是**编到 C**（SPEC §一之二），而 JS 那条腿走的是同一条编译管线（IR → MIR → JS 后端）。
 * 解释器那条腿最慢、也最不重要 —— 它不是这门语言的去处。要量它就明着写
 * `--legs interp,js,c`。
 */
const LEGS = legsArg ?? ['js', 'c'];

const files = readdirSync(examples).filter((f) => f.endsWith('.py')).sort()
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));
for (const f of files) {
  const src = join(examples, f);
  let want = null;
  try {
    want = run('python3', [src]);
  } catch (e) {
    const why = String(e.stderr || e.message).trim().split('\n').pop();
    console.log(`  skip ${f}（本机 python3 自己跑不了它：${why?.slice(0, 80)}）`);
    skip++;
    continue;
  }
  /* 三条腿：默认（解释器）、`--mode js`（发 JS 再跑）、`build`（发 C 再编再跑）。 */
  for (const leg of LEGS) {
    let got = null;
    try {
      if (leg === 'c') {
        const exe = join(out, f.slice(0, -3));
        run('node', [join(root, 'src', 'cli.js'), 'build', src, '-o', exe], 300000);
        got = run(exe, []);
      } else {
        got = run('node', [join(root, 'src', 'cli.js'), 'run', src,
          ...(leg === 'js' ? ['--mode', 'js'] : [])]);
      }
    } catch (e) {
      const all = String(e.stdout || '') + String(e.stderr || e.message);
      if (/还没接/.test(all)) {
        const why = all.split('\n').filter((x) => x.trim()).pop();
        console.log(`  skip ${f} [${leg}]（缺口：${why?.slice(0, 96)}）`);
        skip++;
        continue;
      }
      console.log(`  FAIL ${f} [${leg}] 跑不起来：${all.split('\n').filter((x) => x.trim()).pop()?.slice(0, 120)}`);
      fail++;
      continue;
    }
    if (got === want) {
      pass++;
      console.log(`  ok   ${f} [${leg}]（与 python3 逐字节相同，${want.split('\n').length - 1} 行）`);
    } else {
      fail++;
      const [g, w] = firstDiff(got, want);
      console.log(`  FAIL ${f} [${leg}] 输出不同\n       我们：${JSON.stringify(g)}\n       py  ：${JSON.stringify(w)}`);
    }
  }
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

const py = (() => {
  try { return run('python3', ['--version']).trim(); } catch { return '（没有 python3）'; }
})();
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped  （尺子：${py}）`);
process.exit(fail === 0 ? 0 : 1);
