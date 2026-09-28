// tests/python/ucase.js —— 把**第六格判据**挂进轴表（薄封装，真活在 `ext/python/rt/ucase.js`）
//
// 它量的事：借来的那张 unicode 表（`Objects/unicodectype.c`，**只借这一份**）在
// **两条腿上**都与本机 python3 逐字节相同 —— 门一是原生腿（表与探针都过我们的 C 前端、
// 只链这两份），门二是 JS 腿（同一份 C -> MIR -> JS）。语料 28 个词 × 4 个映射
// （upper / lower / casefold / title），含一对多与两条上下文规矩（尾位 sigma、
// casefold 不走那一条）。账在 `ext/python/SPEC.md` §一 第 29～30 条。
//
// all.js 只会 `node tests/<这条轴>`，所以这儿 spawn 过去、退出码原样透传。
//
// **前置条件不满足就跳过，不算红**（口径与 `tests/python/freeze.js` 一致）：参考树、
// 探过的 `pyconfig.h`（`npm run py:sweep`）、clang（链接那一步）、python3（oracle）。
// 与 freeze 那条轴不同的是**不要预热过的 `obj/`** —— 那张表我们自己编。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const work = join(root, '.omni-cache', 'py-rt');
const src = process.env.OMNI_CPYTHON ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython');

function skip(why) {
  console.log(`  skip 只借 unicode 的表：大小写映射与 python3 相同（两条腿）（${why}）`);
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

if (!existsSync(join(src, 'Objects', 'unicodectype.c'))) skip(`参考树不在（${src}）`);
if (!existsSync(join(work, 'inc', 'pyconfig.h'))) skip('还没探过 pyconfig.h —— 先跑 `npm run py:sweep`');
if (spawnSync('clang', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 clang');
if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 python3');

const r = spawnSync(process.execPath, [join(root, 'ext', 'python', 'rt', 'ucase.js')],
  { cwd: root, stdio: 'inherit' });
console.log(`\n${r.status === 0 ? 1 : 0} passed, ${r.status === 0 ? 0 : 1} failed, 0 skipped`);
process.exit(r.status === 0 ? 0 : 1);
