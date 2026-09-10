#!/usr/bin/env node
// Omni — 自编译那条**链**必须是绿的（第六条轴的快检，0.5 秒）
//
// 这一门是 `tests/bootstrap/ratchet.js` 的接班人。那个是**棘轮**：自编译链当时是红的，
// 它管着三类债（模块作用域重名 243、`import * as` 4、缺 ABI op 8）不许长大，并且写着
// 「链通了（exit 0）也骂 —— 那时候该把这一门删掉」。链现在通了（那三类都是 0），
// 于是棘轮的活干完了，换成这一门：**同一个动作、相反的判据**。
//
//   两条断言：
//     1. `omni emit-js src/core/cli.js` 回 0
//     2. stderr 里一条 `error:` 都没有
//
// 为什么不直接删掉、只留 `bootstrap/run.js`：那条整门要跑四分钟（C0 -> C1 -> C2 的不动点、
// 逐用例对照、C 路径与 stage2）。链断了的话，这半秒就能说清断在哪一类上 —— 所以失败时按
// 旧棘轮那四类分好再报，一个新长出来的拦路虎不会混在别的话里。
//
//   node tests/bootstrap/link.js

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* 只走**链那一步**（`emit-js`），不编 C、不跑。整条自举门在 `run.js` 里。 */
const r = spawnSync(process.execPath, [CLI, 'emit-js', CLI],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const errText = r.stderr ?? '';
const lines = errText.split('\n').filter((l) => l.includes('error:'));

/* 分类只在**失败**时用：告诉人断在哪一类上。四类照旧（前三类是还完的那三笔债，
   第四类是"这三类之外" —— 那才是新长出来的拦路虎）。 */
const dup = lines.filter((l) => l.includes('is declared at module scope in both'));
const ns = lines.filter((l) => l.includes('namespace import'));
const abi = lines.filter((l) => l.includes('is not part of the native host surface')
  || l.includes('is not in the C ABI table'));
const other = lines.filter((l) => !dup.includes(l) && !ns.includes(l) && !abi.includes(l));

if (r.status !== 0) {
  const cls = [['模块作用域重名', dup], ['import * as', ns], ['缺 ABI op', abi], ['别的', other]]
    .filter(([, pool]) => pool.length > 0)
    .map(([name, pool]) => `    ${name} ${pool.length} 条：\n`
      + pool.slice(0, 3).map((l) => `      ${l.trim()}`).join('\n'))
    .join('\n');
  bad(`自编译链断了（exit ${r.status}）`,
    `${cls === '' ? '    stderr 里没有 error: 行 —— 看 stderr 的头几行' : cls}\n`
    + '    这条链是自举的第一步（C0 emit-js -> C1），断了 bootstrap/run.js 一定也是红的。');
} else {
  ok(`omni emit-js src/core/cli.js 回 0（${(r.stdout ?? '').length} 字节）`);
  if (lines.length > 0) {
    bad(`回了 0 但 stderr 里有 ${lines.length} 条 error:`,
      lines.slice(0, 3).map((l) => `      ${l.trim()}`).join('\n'));
  } else {
    ok('stderr 里一条 error: 都没有');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
