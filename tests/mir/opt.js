#!/usr/bin/env node
// Omni — 公共优化管线（ADR-0039）的判据轴
//
// 这条轴证两件事，别的都不证：
//
//   1. **每一格自己的判据**（`src/core/mir/opt/tests/*.test.js`）：真 .c 出的 MIR，
//      改完过 verifier、解释器答案逐字不变、指令条数真的降。
//   2. **L1 行为一致**（ADR-0039 第 5 节的第一档）：`tests/c/gen/*.c` 那 85 份，
//      `omni c run` 开与不开 `OMNI_MIR_OPT=1` 的 **stdout + 退出码必须逐字节相同**。
//
// 为什么第 2 条要用真的 CLI 跑：管线是挂在 `lang/c.js` 的 `cMir` 上的，只在库里调
// 通道函数证不了"那条命令真的走了这一格"。这条轴抓出过两个真 bug：
//   - buildCfg 不认 BRTABLE ⇒ switch 的 CFG 是错的（10-switch.c：s=7457 变 7557）
//   - `String(-0)` 是 `"0"` ⇒ 折常量把 -0.0 折成 0.0（15-float.c）
//
//   node tests/mir/opt.js
//   node tests/mir/opt.js switch      # 只跑名字里含 switch 的

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const keep = (name) => filters.length === 0 || filters.some((x) => name.includes(x));

let pass = 0, fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const bad = (label, detail) => {
  fail++; failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

/* ---------------------------------------------------- 一、每一格自己的判据 */
const UNITS = ['cfg', 'mem2reg', 'deadcode', 'rewrite', 'cse', 'dse', 'pipeline'];
for (const u of UNITS) {
  if (!keep(u)) continue;
  const r = spawnSync(process.execPath, [join(root, `src/core/mir/opt/tests/${u}.test.js`)],
    { encoding: 'utf8' });
  if (r.status === 0) ok(`opt/${u}.test.js`);
  else bad(`opt/${u}.test.js`, (r.stdout || '') + (r.stderr || ''));
}

/* ------------------------------------- 二、L1：开不开管线，行为逐字节相同 */
const gen = join(root, 'tests/c/gen');
const cases = readdirSync(gen).filter((f) => f.endsWith('.c')).sort();
const cli = join(root, 'src/cli.js');
let same = 0;
for (const c of cases) {
  if (!keep(c)) continue;
  const path = join(gen, c);
  const a = spawnSync(process.execPath, [cli, 'c', 'run', path], { encoding: 'utf8' });
  const b = spawnSync(process.execPath, [cli, 'c', 'run', path],
    { encoding: 'utf8', env: Object.assign({}, process.env, { OMNI_MIR_OPT: '1' }) });
  if (a.stdout === b.stdout && a.status === b.status) { same++; continue; }
  bad(`L1 ${c}`, `退出码 ${a.status} vs ${b.status}\n--- 不开\n${a.stdout}\n--- 开\n${b.stdout}`);
}
if (same > 0) ok(`L1 行为一致（解释器腿）：${same}/${cases.filter((c) => keep(c)).length} 份 .c 逐字节相同`);

/* ---- 三、L1：**原生腿**（真机器码，走我们自己的汇编器与链接器）也要一致。
 * 这条与上面那条不是一回事：`omni c run` 走 MIR 解释器，`omni c tcc -run` 走
 * `cMirNative` -> arm64/x86_64 的 from_mir -> 我们自己的链接器 -> 真的跑。
 * 优化改出来的新形状（比如转发之后地址计算没人用了）只有在这条腿上才会碰到后端。 */
let nsame = 0;
for (const c of cases) {
  if (!keep(c)) continue;
  const path = join(gen, c);
  const a = spawnSync(process.execPath, [cli, 'c', 'tcc', '-run', path], { encoding: 'utf8' });
  const b = spawnSync(process.execPath, [cli, 'c', 'tcc', '-run', path],
    { encoding: 'utf8', env: Object.assign({}, process.env, { OMNI_MIR_OPT: '1' }) });
  if (a.stdout === b.stdout && a.status === b.status) { nsame++; continue; }
  bad(`L1-native ${c}`, `退出码 ${a.status} vs ${b.status}\n--- 不开\n${a.stdout}\n--- 开\n${b.stdout}`);
}
if (nsame > 0) ok(`L1 行为一致（原生腿）：${nsame}/${cases.filter((c) => keep(c)).length} 份 .c 逐字节相同`);

/* ------------------------------------------------------------------ 收尾 */
process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
for (const f of failures) process.stdout.write(`\n${f}\n`);
process.exit(fail > 0 ? 1 : 0);
