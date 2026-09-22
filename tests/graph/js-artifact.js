#!/usr/bin/env node
/* **图那条 js 腿的自足产物**（第一百五十一片）：`build --engine graph --backend js` 落出来的
 * 那份 `.mjs`，`node` 直接跑得起来，而且跑出来的字节与**本进程那条腿**一样。
 *
 * 为什么这条判据非有不可：产物里那十四个钩子是**文本**（`src/core/graph/js_rt.js`），
 * 而解释器那侧是**代码**（`src/core/graph/eval.js`）。两个消费者、两种形状 ——
 * 分叉的风险不靠"小心"防，靠这条判据钉住：印法（列表 `[a, b]`、记录 `{k = v}`、
 * 多值空格分开、缺键/越界报什么）改了一处忘了另一处，这里当场红。
 *
 * 语言只挑**还在图上的那几门**（现在只剩 go，ADR-0044）：它的例子覆盖了
 * 记录 / 列表 / map / 多值 / 转换 / 切片 / 早退 / scope-exit 那几族，够压住钩子的每一格。
 *
 *   node tests/graph/js-artifact.js [过滤词...]
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const WORK = join(ROOT, '.omni-cache', 'work', 'graph-js-artifact');
mkdirSync(WORK, { recursive: true });

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;
const failures = [];
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => {
  fail++;
  failures.push(`${what}\n${why}`);
  process.stdout.write(`  FAIL ${what}\n`);
};

const run = (args) => spawnSync(process.execPath, args, {
  encoding: 'utf8', timeout: 120000, maxBuffer: 8 << 20,
});

/** 还在图那一层的那几门的例子（ADR-0044：迁走的语言在这一层不存在了）。 */
const cases = [];
for (const lang of ['go']) {
  const dir = join(ROOT, 'ext', lang, 'examples');
  for (const f of readdirSync(dir).sort()) {
    if (f.startsWith('.')) continue;
    if (filters.length > 0 && !filters.some((x) => f.includes(x) || lang.includes(x))) continue;
    cases.push({ lang, name: f, path: join(dir, f) });
  }
}

for (const c of cases) {
  const art = join(WORK, `${c.lang}-${c.name.replace(/\./g, '_')}.mjs`);
  /* 一、落产物。`--lang` 明着给：后缀猜得出来，但判据不该依赖猜。 */
  const b = run([CLI, 'build', c.path, '--engine', 'graph', '--lang', c.lang,
    '--backend', 'js', '-o', art]);
  if (b.status !== 0) {
    bad(`${c.lang}/${c.name} 落产物`, `    rc=${b.status}\n${(b.stderr || '').slice(0, 400)}`);
    continue;
  }
  /* 二、**node 直接跑那份产物**（自足这句话的全部内容就是这一行不需要别的东西）。 */
  const got = run([art]);
  /* 三、本进程那条腿跑同一份源码 —— 两边的 stdout 必须逐字节相同。 */
  const want = run([CLI, 'run', c.path, '--engine', 'graph', '--lang', c.lang, '--backend', 'js']);
  if (want.status !== 0) {
    bad(`${c.lang}/${c.name} 本进程那条腿`, `    rc=${want.status}\n${(want.stderr || '').slice(0, 300)}`);
    continue;
  }
  if (got.status !== 0) {
    bad(`${c.lang}/${c.name} node 跑产物`, `    rc=${got.status}\n${(got.stderr || '').slice(0, 400)}`);
    continue;
  }
  if (got.stdout !== want.stdout) {
    bad(`${c.lang}/${c.name} 两条腿输出不同`,
      `    产物：${JSON.stringify((got.stdout || '').slice(0, 200))}\n`
      + `    本进程：${JSON.stringify((want.stdout || '').slice(0, 200))}`);
    continue;
  }
  ok(`${c.lang}/${c.name}（${(got.stdout || '').split('\n').length - 1} 行输出，产物与本进程逐字节相同）`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed（三门语言 × 落产物 + node 跑 + 比对）\n`);
if (fail > 0) process.stdout.write(`\n${failures.join('\n\n')}\n`);
process.exit(fail === 0 ? 0 : 1);
