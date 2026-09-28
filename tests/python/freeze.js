// tests/python/freeze.js —— 把**第四把尺子**挂进轴表（薄封装，真活在 `ext/python/rt/freeze.js`）
//
// 为什么要这一层：那把尺子原来只在 `package.json` 的 `py:freeze` 里，于是 `tests/all.js`
// 从来跑不到它 —— 而它是四把尺子里**唯一量"跑得对"的那一把**（前三把最远只到"链得上"）。
// 它量的是：我们自己编出来的那 201 份 CPython 的 `.o` 链成 `_freeze_module`、
// 真把那 26 份 `.py` 冻成 `.h`（要 Parser + compile + ceval + marshal 全对），
// 再顺手把 `Python/frozen.c` / `Modules/getpath.c` 那两份下游编出来。
//
// all.js 只会 `node tests/<这条轴>`，所以这儿 spawn 过去、退出码原样透传。
//
// **前置条件不满足就跳过，不算红**（口径与 `tests/python/rt.js` 一致）：
//   * 参考树不在 —— 那把尺子自己会说并 exit 0；
//   * `.omni-cache/py-rt/obj/` 里那批 `.o` 不在（要先 `npm run py:sweep`，两分钟）——
//     这儿先判掉，因为那把尺子对这一情形是 exit 1（它当命令行工具用时该报错，
//     当轴用时不该把"缓存没预热"记成"编译器坏了"）。
//   * 没有 clang（链接与 oracle 那侧都要）。
// `--oracle` 那一路（与 clang 编的逐字节比）这条轴**不带**：它要 `py:symbols` 缓下来的
// 那 199 份 clang `.o`，预热成本比这条轴自己大一个量级。要比就手跑 `npm run py:freeze -- --oracle`。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const work = join(root, '.omni-cache', 'py-rt');
const src = process.env.OMNI_CPYTHON ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython');

function skip(why) {
  console.log(`  skip 借来的 CPython 运行时真跑一趟（${why}）`);
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

if (!existsSync(join(src, 'Include', 'Python.h'))) skip(`参考树不在（${src}）`);
if (spawnSync('clang', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 clang');
if (!existsSync(join(work, 'inc', 'pyconfig.h'))) skip('还没探过 pyconfig.h —— 先跑 `npm run py:sweep`');
const objs = existsSync(join(work, 'obj'))
  ? readdirSync(join(work, 'obj')).filter((x) => x.endsWith('.o')).length : 0;
if (objs < 150) skip(`obj/ 里只有 ${objs} 份 .o —— 先跑 \`npm run py:sweep\``);

const r = spawnSync(process.execPath, [join(root, 'ext', 'python', 'rt', 'freeze.js')],
  { cwd: root, stdio: 'inherit' });
const ok = r.status === 0;
console.log(`\n${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed, 0 skipped`);
process.exit(ok ? 0 : 1);
