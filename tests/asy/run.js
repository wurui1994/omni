#!/usr/bin/env node
// Omni — asymptote 前端（第十五条测试轴，ADR-0014 的第二道门槛）
//
// 第一道门槛是"读得进"（tests/glr 那条轴：84/84 个标准模块只出一棵树）；这一条是
// **跑得对**，而且判分的人不是我：
//
//   1. **五方一致**：cases/*.asy 经 asy 前端降到核心方言，再在 run / run-c / interp /
//      interp --mir / run-llvm 上跑，五条腿逐字节相同，且等于 .expected。
//   2. **.expected 是真 asy 的输出**：装了 asymptote 就当场用 `asy -noV` 重新生成一遍
//      比对 —— 期望值不是我写的，是量出来的。没装就跳过这一节并打印 skip（这条轴仍然
//      靠 .expected 把答案钉住，不会因为环境缺工具就什么都不查）。
//   3. **bad/ 里的必须被拒绝，且拒在正确的理由上**。这一刀故意没做的东西（
//      triple、复数幂、**标准库**模块（`import graph;` —— 用户自己写的
//      模块第二十五刀通了）、`unravel`/`include`/参数化模块、两个模块里同名的 struct、
//      隐式缩放、超越函数、给切片赋值、
//      多维数组、循环条件里的 `? :`、字符串的 `reverse`/`insert`/`split`、
//      函数里用文件级的 pair/记录/数组变量（标量的那些第二十四刀通了）、
//      struct 的三条边界 —— 自引用字段、把方法当值取出来、`operator init` 的另两种
//      形态（带形参的文件级那份、非 void 的那份）、`autounravel` 的**变量**（函数那半边
//      第二十八刀通了））都在这里，
//      每条都带 ASY_NOPE 前缀 —— "还没做"和"做错了"必须能一眼分开。
//   4. **strict/ 里的是 asy 自己就不收的**（后缀 `x++`、pair 上的 `<` 和 `%`、
//      `length(int[])`、按不存在的形参名给命名实参、歧义的重载、
//      引用后面才声明的函数、`write` 一个 struct、给 pair 的分量赋值、
//      没有 `void operator init` 的 struct 上写 `A(…)`、在 struct 声明之前拿它当类型、
//      只定义了 `operator <` 就写 `<=`、声明 `operator &&`（asy 那边是 syntax error）、
//      函数里引用后面才声明的文件级变量、`access m;` 之后裸用模块里的名字、
//      给 `explicit real` 的槽喂一个 int、用户转换**串两次**（用户接用户、内建提升接用户）、
//      隐式位置用 `operator ecast`、用户转换与内建提升打平、
//      在 struct 前面用它体里 `autounravel` 的名字 ——
//      后十四条是第十四、十五、二十一、二十三、二十四、二十五、二十六、二十七、
//      二十八刀加的）：
//      我们要拒，而且装了 asy 的话真 asy 也要拒。这一节盯的是"比 asy 多接受一门语言"
//      ——那种漏洞不会让任何用例输出不同，只会让"等价"两个字变虚。
//
//   node tests/asy/run.js
//   node tests/asy/run.js arith
//   ASY_BIN=/opt/homebrew/bin/asy node tests/asy/run.js

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ASY_NOPE } from '../../stage0/src/frontend-asy/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const cmd = (args, cwd) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };
const want = (f) => (!filters.length || filters.some((x) => f.includes(x)));

/**
 * 用例目录里那些 `mod_*.asy` 不是用例，是**被 import 的模块**（第二十五刀）。
 * 而三节测试都在**用例文件自己的目录里**跑（cwd = 那个目录）：asy 的模块是按 CWD 找的
 * （量过：`asy -noV sub/user.asy` 里的 `import mm;` 找不到 sub/mm.asy），所以判分的那个
 * asy 与我们必须站在同一个目录里，不然这一条根本没法比。
 */
const isCase = (f) => f.endsWith('.asy') && !f.startsWith('mod_');

/** 五条腿，跟 tests/sexpr 那条轴同一份名单 —— 那边喂 .sx，这边喂 .asy */
const LEGS = [
  { tag: 'run', args: (p) => ['run', p] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
  { tag: 'run-llvm', args: (p) => ['run-llvm', p] },
];

/** 真 asy 在不在。装了就用它当判分的人，没装就把这一节标成 skip。 */
function findAsy() {
  const cands = [process.env.ASY_BIN, 'asy', '/opt/homebrew/bin/asy', '/usr/local/bin/asy'];
  for (const c of cands) {
    if (c === undefined || c === null || c === '') continue;
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (r.error === undefined || r.error === null) return c;
  }
  return null;
}
const asyBin = findAsy();

// ------------------------------------------------- 1+2. cases/：五方一致 + 真 asy 判分

for (const f of readdirSync(join(here, 'cases')).filter(isCase).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.asy');
  const dir = join(here, 'cases');
  const path = join(dir, f);
  const expected = read(join(here, 'cases', `${name}.expected`));
  const bad = [];

  const first = cmd(LEGS[0].args(path), dir);
  if (first.code !== 0) bad.push(`    ${LEGS[0].tag} exit=${first.code}\n${first.err}`);
  for (const leg of LEGS.slice(1)) {
    const r = cmd(leg.args(path), dir);
    if (r.code !== 0) { bad.push(`    ${leg.tag} exit=${r.code}\n${r.err}`); continue; }
    if (r.out !== first.out) {
      bad.push(`    ${leg.tag} 与 ${LEGS[0].tag} 不同\n      ${LEGS[0].tag}: ${JSON.stringify(first.out)}\n      ${leg.tag}: ${JSON.stringify(r.out)}`);
    }
  }
  if (expected === null) bad.push('    缺 .expected');
  else if (first.out !== expected) {
    bad.push(`    对不上期望值\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(first.out)}`);
  }

  let judged = '';
  if (asyBin !== null) {
    const r = spawnSync(asyBin, ['-noV', path], { encoding: 'utf8', cwd: dir });
    const real = (r.stdout ?? '') + (r.stderr ?? '');
    if ((r.status ?? 1) !== 0) bad.push(`    真 asy 自己就跑不过 exit=${r.status}\n${real}`);
    else if (real !== first.out) {
      bad.push(`    与真 asy 逐字节比对不同\n      asy:  ${JSON.stringify(real)}\n      omni: ${JSON.stringify(first.out)}`);
    } else judged = ' == asy -noV';
  }

  if (bad.length === 0) ok(`cases/${name} [五方一致 == ${name}.expected${judged}]`);
  else no(`cases/${name}`, bad.join('\n'));
}

if (asyBin === null) {
  process.stdout.write('  skip asy 二进制不在（装 asymptote 或设 ASY_BIN 就会拿它逐字节判分）\n');
}

// ------------------------------------------------- 3. bad/：拒绝，理由正确，且带 ASY_NOPE

for (const f of readdirSync(join(here, 'bad')).filter(isCase).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.asy');
  const exp = read(join(here, 'bad', `${name}.expected`));
  if (exp === null) { no(`bad/${name}`, `    缺 ${name}.expected`); continue; }
  const msg = exp.trim();
  if (!msg.startsWith(ASY_NOPE)) {
    no(`bad/${name}`, `    期望值没带 "${ASY_NOPE}" —— 这一节收的是"刻意还没做"，不是"写错了"`);
    continue;
  }
  const r = cmd(['run', join(here, 'bad', f)], join(here, 'bad'));
  if (r.code === 0) { no(`bad/${name}`, '    居然通过了 —— 这条边界是刻意划的'); continue; }
  if (!r.err.includes(msg)) {
    no(`bad/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(msg)}\n      got:  ${JSON.stringify(r.err.split('\n')[0])}`);
    continue;
  }
  ok(`bad/${name} [拒绝：${msg.slice(ASY_NOPE.length + 1)}]`);
}

// ------------------------------------------- 4. strict/：asy 自己就不收，我们也不能收
//
// bad/ 收的是"这一刀还没做"（消息带 ASY_NOPE）。这一节收的是另一件事：**asy 自己就报错**
// 的写法（例如后缀 `x++` —— 量过 asy 说 "postfix expressions are not allowed"）。
// 判分的人还是真 asy：装了就要求它**也**失败。这一节盯的是"我们比 asy 多接受了一门语言"
// 这类漏洞 —— 那种漏洞不会让任何用例输出不同，只会让人以为等价。

for (const f of readdirSync(join(here, 'strict')).filter(isCase).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.asy');
  const dir = join(here, 'strict');
  const p = join(dir, f);
  const exp = read(join(here, 'strict', `${name}.expected`));
  if (exp === null) { no(`strict/${name}`, `    缺 ${name}.expected`); continue; }
  const msg = exp.trim();
  const r = cmd(['run', p], dir);
  if (r.code === 0) { no(`strict/${name}`, '    我们收下了，而 asy 不收 —— 那就是多接受了一门语言'); continue; }
  if (!r.err.includes(msg)) {
    no(`strict/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(msg)}\n      got:  ${JSON.stringify(r.err.split('\n')[0])}`);
    continue;
  }
  let judged = '';
  if (asyBin !== null) {
    const a = spawnSync(asyBin, ['-noV', p], { encoding: 'utf8', cwd: dir });
    if ((a.status ?? 1) === 0) { no(`strict/${name}`, '    真 asy 居然收了 —— 这条边界划错了'); continue; }
    judged = '；真 asy 也拒';
  }
  ok(`strict/${name} [拒绝${judged}]`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
