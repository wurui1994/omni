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

const HEAD = `def main():
    cp = 1
    while cp < 1114112:
        if cp < 55296 or cp > 57343:
            c = chr(cp)
`;
const TAIL = `        cp = cp + ${STEP}
main()
`;
/* 两趟。
   一：**四个映射**（`.upper()` / `.lower()` / `.casefold()`，一格码点一行）。
   二：**尾位 sigma 那两条上下文规矩**（`ucase.tab` 里那两位标志）—— 一格一格地把码点摆在
   Σ 的后面与前面，看那个 Σ 小写成 σ 还是 ς。头一版的探针就是在这儿错的（写成"Σ 在开头"，
   而那条规矩要求"前面有 cased"，于是那一位恒等）；**单字符那一趟量不到它**：
   独一格 Σ 走的是"前面什么都没有"那条路，1112064 个码点照旧全绿。 */
const PASSES = [
  ['四个映射（upper / lower / casefold）',
    `${HEAD}            print(cp, c.upper(), c.lower(), c.casefold())\n${TAIL}`],
  ['尾位 sigma 的前位与后位',
    `${HEAD}            print(cp, ("\\u03b1\\u03a3" + c).lower(), ("\\u03b1" + c + "\\u03a3").lower())\n${TAIL}`],
  /* 三：**title / capitalize / swapcase**。`("a" + c).title()` 那一格是词边界那条规矩
     （上一格 `a` 是 cased，所以这一格该走小写而不是首字母大写）—— 单独一格字符量不到它。 */
  ['title / capitalize / swapcase',
    `${HEAD}            print(cp, c.title(), c.capitalize(), c.swapcase(), ("a" + c).title())\n${TAIL}`],
  /* 四：**分类那一族**。`("A"+c).isupper()` / `("a"+c).islower()` 那两格是"有至少一格
     cased、而且没有反过来的那一档"那条口径 —— 单独一格字符量不到它
     （`"ǅA".isupper()` 是 False，而 `"ǅ"` 与 `"A"` 单独看都不红）。 */
  ['分类那一族（isalpha / isdigit / … / isupper / islower）',
    `${HEAD}            print(cp, c.isalpha(), c.isdigit(), c.isdecimal(), c.isnumeric(), c.isalnum(), c.isspace(), c.isupper(), c.islower(), ("A" + c).isupper(), ("a" + c).islower())\n${TAIL}`],
];

const dir = mkdtempSync(join(tmpdir(), 'omni-ucase-sweep-'));
let bad = 0;
let rows = 0;
for (let i = 0; i < PASSES.length; i++) {
  const [what, src] = PASSES[i];
  const file = join(dir, `sweep${i}.py`);
  writeFileSync(file, src);

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
    process.stderr.write(`我们这一趟没过（${what}）：${(got.stderr ?? '').slice(0, 400)}\n`);
    process.exit(1);
  }

  const a = want.stdout;
  const b = got.stdout;
  rows = a.split('\n').length - 1;
  if (a === b) {
    process.stdout.write(`ok   ${what}：**${rows} 个码点**与 python3 逐字节相同`
      + `（步长 ${STEP}；python3 ${(tPy / 1000).toFixed(1)}s、我们 ${(tUs / 1000).toFixed(1)}s）\n`);
    continue;
  }
  /* 不同就把**头三处**指出来（逐行比，不印整条河）。 */
  const la = a.split('\n');
  const lb = b.split('\n');
  let shown = 0;
  for (let k = 0; k < Math.max(la.length, lb.length) && shown < 3; k++) {
    if (la[k] === lb[k]) continue;
    process.stderr.write(`  ${what} 第 ${k + 1} 行：python3 是 ${JSON.stringify(la[k])}，`
      + `我们是 ${JSON.stringify(lb[k])}\n`);
    shown += 1;
  }
  process.stderr.write(`FAIL ${what}（${rows} 个码点里至少 ${shown} 处对不上）\n`);
  bad += 1;
}
process.exit(bad === 0 ? 0 : 1);
