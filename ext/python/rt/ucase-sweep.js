#!/usr/bin/env node
// ext/python/rt/ucase-sweep.js —— **整张表过一遍**：1112064 个码点 × upper/lower/casefold
//
// 这一份是查表那一刀（`ext/python/lib/ucase.py` + `ext/python/rt/ucase.tab`）的**总判据**：
// 同一份 `.py` 我们跑一遍、本机 python3 跑一遍，**逐字节**比。抽样过不了关 ——
// 尾位 sigma、ß -> SS、ﬃ -> FFI、İ、ǅ 这些格子分布很散，28 个词那种抽样恰好全落在
// 两版共有行为上（第 29 条那一格的教训）。
//
// 写成**一格 while 循环**而不是一百万条语句：后者编译期就撑不住（量过：3365 条语句
// 那一趟 30s 的看门狗就掐了），循环那一份 6.8s 跑完。
//
// 代理项（surrogate）那一段跳过：python3 自己 `print(chr(0xD800))` 就抛
// `UnicodeEncodeError`，那不是这一格要量的事。
//
//   npm run py:ucase-sweep
//   node ext/python/rt/ucase-sweep.js --step 7      只走每 7 个码点（快看一眼，1.2s）

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(ROOT, 'src', 'core', 'cli.js');
const argv = process.argv.slice(2);
const at = argv.indexOf('--step');
const STEP = at < 0 ? 1 : Number(argv[at + 1]);

const py = `def main():
    cp = 1
    while cp < 1114112:
        if cp < 55296 or cp > 57343:
            c = chr(cp)
            print(cp, c.upper(), c.lower(), c.casefold())
        cp = cp + ${STEP}
main()
`;
const dir = mkdtempSync(join(tmpdir(), 'omni-ucase-sweep-'));
const file = join(dir, 'sweep.py');
writeFileSync(file, py);

const t0 = Date.now();
const want = spawnSync('python3', [file], { encoding: 'utf8', maxBuffer: 1 << 30 });
if (want.status !== 0) {
  process.stderr.write(`python3 那一趟没过：${(want.stderr ?? '').slice(0, 300)}\n`);
  process.exit(1);
}
const tPy = Date.now() - t0;

const t1 = Date.now();
/* 看门狗关掉：这一趟本来就要几秒（`OMNI_TIMEOUT` 默认 30s 是给"一个程序"的预算）。 */
const got = spawnSync(process.execPath, [CLI, 'run', '--mode', 'js', file], {
  encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, OMNI_TIMEOUT: '0' },
});
const tUs = Date.now() - t1;
if (got.status !== 0) {
  process.stderr.write(`我们这一趟没过：${(got.stderr ?? '').slice(0, 400)}\n`);
  process.exit(1);
}

const a = want.stdout;
const b = got.stdout;
const rows = a.split('\n').length - 1;
if (a === b) {
  process.stdout.write(`ok   整张表过一遍：**${rows} 个码点** × upper / lower / casefold，`
    + `与 python3 逐字节相同（步长 ${STEP}；python3 ${(tPy / 1000).toFixed(1)}s、`
    + `我们 ${(tUs / 1000).toFixed(1)}s）\n`);
  process.exit(0);
}
/* 不同就把**头三处**指出来（逐行比，不印整条河）。 */
const la = a.split('\n');
const lb = b.split('\n');
let shown = 0;
for (let i = 0; i < Math.max(la.length, lb.length) && shown < 3; i++) {
  if (la[i] === lb[i]) continue;
  process.stderr.write(`第 ${i + 1} 行：python3 是 ${JSON.stringify(la[i])}，`
    + `我们是 ${JSON.stringify(lb[i])}\n`);
  shown += 1;
}
process.stderr.write(`FAIL 整张表那一趟对不上（${rows} 个码点里至少 ${shown} 处）\n`);
process.exit(1);
