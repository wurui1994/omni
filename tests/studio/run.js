#!/usr/bin/env node
/**
 * tests/studio —— **单体 HTML** 那一层的判据（`docs/design/omni-serve-studio.md` §6）。
 *
 * 量的是三件事，一件也不多：
 *
 *   1. **拼得出来**：`tools/bundle-studio.mjs` 跑通，且 HTML 里 CSS / JS 都内联了。
 *   2. **不依赖 node**：拼出来那份文件的**代码那一段**（内联的文件表之前）里，
 *      一个 `getBuiltinModule` / `require(` / `process.` 都不许有。
 *      为什么按位置切：内联的文档与例子里**会**出现 `node:fs` 这种字样（它们是数据，
 *      不是代码），整份 grep 必然假红。
 *   3. **真能跑**：拿 node 当浏览器壳子（塞一格 `window`），跑几个例子，
 *      **stdout 与本地 `omni run --engine graph` 逐字节相同**。
 *      这一条是这一层唯一的真判据 —— 换宿主不许换答案。
 *
 * 不装无头浏览器：那会带一整套依赖进来，而"页面长得对不对"只有人看得出来。
 */
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const work = join(root, '.omni-cache', 'work', 'studio-judge');

let pass = 0, fail = 0;
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${note ? ` —— ${note}` : ''}`); }
};

/* ---------------------------------------------------------------- 1. 拼得出来 */

const out = join('.omni-cache', 'work', 'studio-judge', 'omni-studio.html');
mkdirSync(work, { recursive: true });
execFileSync('node', [join(root, 'tools', 'bundle-studio.mjs'), '-o', out],
  { cwd: root, encoding: 'utf8', timeout: 180000 });
const html = readFileSync(join(root, out), 'utf8');

ok('拼出一份 HTML', html.length > 100000, `${html.length} 字节`);
ok('CSS 内联了（没有外链）', html.includes('<style>') && !html.includes('<link'));
ok('JS 内联了（没有外链）', !html.includes('src="/studio.js"'));
ok('内联了文件表', html.includes('window.__OMNI_VFS'));

/* ---------------------------------------------------------------- 2. 不依赖 node */

const vfsAt = html.indexOf('window.__OMNI_VFS = ');
const code = html.slice(0, vfsAt);
/**
 * 代码段里**不许有** `getBuiltinModule` —— 那是"这份东西还在问 node 要模块"的唯一硬标志。
 *
 * 两处**刻意排除**，各有理由：
 *
 *   * `backend-js/prelude.js` 那一格。它导出的是**一大段源码文本**（JS 产物那条腿的宿主，
 *     `$js_*` 那 138 格），在 bundle 里是个字符串常量，浏览器里连 parse 都轮不到它。
 *     真去调它才会炸 —— 而"单体 HTML 只跑图那条腿"本来就写在设计文档 §5 里。
 *   * `process.`。`path.js` 的 `resolve` 里有一句 `process.cwd()`，`sroa.js` 里有个
 *     `OMNI_SROA_STAT` 的调试开关 —— 两处都在函数体里，页面上走不到。
 *
 * 排除靠**切掉那一格模块**（从它的登记行到下一格登记行），不是靠"数得对不对" ——
 * 数字会随代码长而漂，而边界不会。
 */
const PRELUDE_AT = code.indexOf('__M["src/core/backend-js/prelude.js"]');
const afterPrelude = code.indexOf('\n__M["', PRELUDE_AT + 1);
const codeNoPrelude = PRELUDE_AT < 0 ? code
  : code.slice(0, PRELUDE_AT) + (afterPrelude < 0 ? '' : code.slice(afterPrelude));
ok('内联了 prelude（那一格是数据，不是代码）', PRELUDE_AT >= 0);
const nBuiltin = codeNoPrelude.split('getBuiltinModule').length - 1;
ok('除 prelude 之外没有 getBuiltinModule', nBuiltin === 0, `出现 ${nBuiltin} 次`);

/* ---------------------------------------------------------------- 3. 真能跑 */

/**
 * 把内联的那一段 JS 抠出来，前面塞一格 `window`，写成一份 `.mjs` —— node 就是浏览器壳子。
 *
 * 为什么能这么干：浏览器那条腿（`host/browser.js`）碰的全局只有 `window`（装文件表）
 * 与 `performance`（`upMs`），两样 node 上都有（前者我们自己塞）。
 * 于是这一趟跑的**就是页面上要跑的那份代码**，不是另一份。
 */
const a = html.indexOf('<script type="module">') + '<script type="module">'.length;
const b = html.indexOf('</script>', a);
const shell = join(work, 'shell.mjs');
writeFileSync(shell,
  'globalThis.window = globalThis;\n'
  + `${html.slice(a, b)}\n`
  + 'const r = await window.__OMNI_LOCAL("/api/run",\n'
  + '  { body: JSON.stringify({ argv: ["run", process.argv[2]] }) });\n'
  + 'process.stdout.write(r.stdout);\n'
  + 'process.stderr.write(r.stderr);\n'
  + 'process.exitCode = r.code;\n');

/**
 * 挑的例子：一门语言一份、都秒级（"判据要用最小的那一条"）。
 *
 * **对照那一趟要带 `--engine graph`**：`omni run x.lua` 默认走的是 lua 那台字节码 VM，
 * 与浏览器这条腿（图那一层）不是同一台机器。不带它就是拿两台机器互比。
 * `.lua` 不在名单里也是同一件事：lua->graph 那份映射还有缺口（`sumto` 那一格），
 * 而那是 lua 前端的账，不是这一层的。
 */
const CASES = [
  'ext/go/examples/basics.go',
  'ext/chez/examples/basics.ss',
  'ext/awk/examples/basics.awk',
  'ext/nim/examples/basics.nim',
  'ext/vlang/examples/basics.v',
  'ext/sbcl/examples/basics.lisp',
];

for (const c of CASES) {
  let want = null;
  try {
    want = execFileSync('node', [join(root, 'src', 'cli.js'), 'run', c, '--engine', 'graph'],
      { cwd: root, encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    ok(`${c}（本地那一趟先得通）`, false, String(e.message).slice(0, 200));
    continue;
  }
  let got = null;
  try {
    const r = await execFile('node', [shell, c], { cwd: root, encoding: 'utf8', timeout: 180000 });
    got = r.stdout;
  } catch (e) {
    ok(`${c} 在浏览器那条腿上逐字节相同`, false,
      `跑不起来：${String(e.stderr ?? e.message).slice(0, 300)}`);
    continue;
  }
  ok(`${c} 在浏览器那条腿上逐字节相同`, got === want,
    `${JSON.stringify(got.slice(0, 120))} != ${JSON.stringify(want.slice(0, 120))}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
