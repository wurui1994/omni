#!/usr/bin/env node
// Omni — **自己编出来的那份，真跑一趟借来的语言**（自编链的第三格判据）
//
// 为什么要这一门：`bootstrap/link.js` 管"链是绿的"（`emit-js` 回 0、没有 `error:`），
// `bootstrap/run.js` 管整条自举的不动点。两者之间缺一格 —— **编得出来 ≠ 跑得对**，
// 而这棵树上这两件事真的会分开。2026-09-27 一天里撞到三笔，全都长期绿着：
//
//   1. `frontend-js/rename.js` 的 import 别名改写不认局部遮蔽（`import { span as mkSpan }`
//      + 函数体内 `const span`）—— 自编产物读**任何**借来的语言都炸在词法器里，
//      报 `TypeError: not a function`（没有位置、没有名字）。
//   2. C 侧正则不收 `[\s\S]` 那族（字符类里的否定类转义）。
//   3. C 侧正则不收反向引用 `\2`（python 的字符串字面量靠它认收尾引号）。
//
// 三笔都躲过了全部判据，因为：`check:self` 只看"编得出"，而别的轴全跑在 **node 源码腿**上。
// 借来的语言那条路最长（GLR 词法 + 语法 → adapter → 公共 lower → 后端），所以拿它当探针
// 最划算：一份 `.py` 跑通，上面三格里任何一格坏了都会当场响。
//
// 判据形状：**同一份例子，两边跑，逐字节相同**。左边是 node 源码腿（`src/core/cli.js`），
// 右边是我们自己编出来的那份 JS 产物。参照不是"期望文件"而是**源码腿自己** —— 这一门盯的
// 是"编出来的那份与源码那份一不一样"，不是"答案对不对"（答案对不对是 tests/python 与
// tests/lower 的活，它们有外部尺子）。
//
//   node tests/bootstrap/selfrun.js
//   node tests/bootstrap/selfrun.js py      只跑名字里含 py 的那几格

import { spawnSync } from 'node:child_process';
import { writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workDir } from '../work.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const work = workDir('selfrun');
const SELF = join(work, 'self.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;
const ok = (name, note) => { pass++; process.stdout.write(`  ok   ${name}${note ? ` ${note}` : ''}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* 例子挑的是**每门语言最全的那一份**（与 tests/lower 用的同一批文件）：
   `.py` 与 `.go` 各走一条 adapter，`.sx` 是**对照** —— 它不经过借来那条路，
   所以一旦只有它绿，就说明坏的是 adapter 那一段而不是整条链。 */
const CASES = [
  ['py', 'ext/python/examples/strmethods.py'],
  ['go', 'ext/go/examples/basics.go'],
  ['sx', 'tests/sexpr/cases/01-core.sx'],
];

/** 跑一趟，回 `{ code, out }`（stdout 原样，stderr 只在失败时印）。 */
function run(argv) {
  const r = spawnSync(process.execPath, argv,
    { encoding: 'utf8', cwd: root, maxBuffer: 1 << 28, timeout: 180000 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/* 第一步：把编译器自己编成一份 JS 产物。**落在仓库里**（`.omni-cache/test/selfrun/`）——
   产物要靠 `treeRoot()`（往上找 `package.json` / `.git`）去找语法文件与 `ext/python/lib`，
   放到 `/tmp` 底下那一格会指到别处（踩过：`ENOENT: /ext/python/python.grammar`）。 */
const emit = run([CLI, 'emit-js', CLI]);
if (emit.code !== 0 || emit.out.length === 0) {
  bad('emit-js src/core/cli.js', `    退出码 ${emit.code}\n${emit.err.split('\n').slice(0, 6).join('\n')}`);
} else {
  writeFileSync(SELF, emit.out);
  ok('emit-js src/core/cli.js', `[${(statSync(SELF).size / 1048576).toFixed(1)}M -> ${SELF.slice(root.length + 1)}]`);
}

/* 第二步：同一份例子两边跑，逐字节比。产物那一侧只在 `emit-js` 成功时才有意义。 */
if (fail === 0) {
  for (const [tag, rel] of CASES) {
    const name = `${tag} ${rel}`;
    if (filters.length > 0 && !filters.some((f) => name.includes(f))) continue;
    const src = run([CLI, 'run', '--mode', 'js', rel]);
    const self = run([SELF, 'run', '--mode', 'js', rel]);
    if (src.code !== 0) {
      /* 源码腿自己就红：这一门说不出话（它比的是"两边一不一样"）。照实报，别算成产物的错。 */
      bad(name, `    源码腿退出码 ${src.code} —— 这一门比的是两边一不一样，先修那一边\n${src.err.split('\n').slice(0, 4).join('\n')}`);
      continue;
    }
    if (self.code !== src.code || self.out !== src.out) {
      const a = src.out.split('\n');
      const b = self.out.split('\n');
      let d = 0;
      while (d < a.length && d < b.length && a[d] === b[d]) d++;
      bad(name, `    退出码 ${src.code} vs ${self.code}，第 ${d + 1} 行起不同\n`
        + `      源码腿: ${JSON.stringify(a[d] ?? null)}\n`
        + `      自编的: ${JSON.stringify(b[d] ?? null)}\n`
        + (self.err ? `    自编那份的 stderr: ${self.err.split('\n').slice(0, 4).join('\n')}\n` : ''));
      continue;
    }
    const n = src.out === '' ? 0 : src.out.replace(/\n$/, '').split('\n').length;
    ok(name, `[源码腿 == 自编产物，${n} 行]`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + '  （同一份例子：node 源码腿 == 我们自己编出来的那份 JS 产物）\n');
process.exitCode = fail > 0 ? 1 : 0;
