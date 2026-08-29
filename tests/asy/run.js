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
//   2b. **tol/ 是带容差的那一节**：超越函数转手宿主的数学库（C 走 libm、JS 走 Math.*），
//      而量过 libm 与 V8 有 43% 的结果位不同、26% 连 `%.15g` 都不同，拿 bc -l 当参考时
//      **两边都不是正确舍入的**。标准库有的东西不自己写，所以这一族的契约是：腿与腿之间、
//      以及与真 asy 之间，都只要求最后一位十进制差不超过 1。
//   3. **bad/ 里的必须被拒绝，且拒在正确的理由上**。这一刀故意没做的东西（
//      triple、复数幂、**标准库**模块（`import graph;` —— 用户自己写的
//      模块第二十五刀通了）、`unravel`/`include`/参数化模块、两个模块里同名的 struct、
//      隐式缩放、宿主数学库里没有的那些内建函数（`gamma`/`erf`/`Jn` 那一族 —— C99 有
//      erf 但 JS 的 Math 没有，要用就得自己实现，这一刀不做）、给切片赋值、
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

import { readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { ASY_NOPE } from '../../stage0/src/frontend-asy/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const cmd = (args, cwd, extraEnv) => {
  const opts = { encoding: 'utf8', cwd };
  if (extraEnv !== undefined) opts.env = { ...process.env, ...extraEnv };
  const r = spawnSync(process.execPath, [cli, ...args], opts);
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
const ALL_LEGS = [
  { tag: 'run', args: (p) => ['run', p] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
  { tag: 'run-llvm', args: (p) => ['run-llvm', p] },
];

/**
 * **默认只跑两条腿**（`OMNI_LEGS=all` 跑齐五条，提交前的那一遍与 tests/bootstrap 用它）。
 * 理由是量出来的：一次 CLI 调用里 node 自己的启动就 0.21s，五条腿 × 四十个用例
 * 是 74s，而其中 run-c / interp / interp --mir 三条在这条轴上**从来不是第一个报错的人**
 * —— 它们盯的是"腿与腿分叉"，那是 tests/sexpr 与 tests/oir 的活。这条轴盯的是
 * asy 前端，所以默认留下 `run`（最快的那条，当基准）与 `run-llvm`（优先级最高的后端）。
 * 一致性因此不是"不查"，是"不在每次迭代里查"。
 */
const LEGS = process.env.OMNI_LEGS === 'all' ? ALL_LEGS
  : ALL_LEGS.filter((l) => l.tag === 'run' || l.tag === 'run-llvm');

/** 计时：每一节印一行。慢下来要当场看得见，不然只会越来越慢。 */
const t0 = Date.now();
let tMark = t0;
const lap = (what) => {
  const now = Date.now();
  process.stdout.write(`  --   ${what} ${((now - tMark) / 1000).toFixed(1)}s\n`);
  tMark = now;
};

/** 报告里那句"几方一致"要跟真的跑了几条腿对上 —— 默认那两条就写它们的名字 */
const NWAY = LEGS.length === ALL_LEGS.length ? '五方' : `${LEGS.length} 方`;
const AGREE = LEGS.length === ALL_LEGS.length ? '五方一致' : LEGS.map((l) => l.tag).join(' == ');

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

  if (bad.length === 0) ok(`cases/${name} [${AGREE} == ${name}.expected${judged}]`);
  else no(`cases/${name}`, bad.join('\n'));
}
lap('cases');

if (asyBin === null) {
  process.stdout.write('  skip asy 二进制不在（装 asymptote 或设 ASY_BIN 就会拿它逐字节判分）\n');
}

// --------------------------- 2b. tol/：超越函数那一节 —— 腿之间与对 asy 都只要求**容差**
//
// 超越函数（exp/log/trig）不能进 cases/：它们转手宿主的数学库（C 那条腿是 libm，
// JS 那条腿是 Math.*），而量过 libm 与 V8 在这一族上 43% 的结果位不同、26% 连 `%.15g`
// 都不同，用 bc -l 当高精度参考时**两边都不是正确舍入的**（ADR-0014 那一节）。
// 标准库有的东西不自己写，所以这条容差是明码标价买来的：
//   - 腿与腿之间也只按容差比（run/interp 走 Math.*，run-c/run-llvm 走 libm）；
//   - 与真 asy 同样按容差比（asy 自己也是转手平台的 libm）。
// 非数字的片段仍然要求逐字节相同 —— 松的只有浮点数那一处。
// 容差的单位是**印出来的最后一位**：`%.15g` 有 15 位有效数字，所以允许的差就是
// 10^(exp-14) 的 1.5 倍（1 个十进制步长，留半格给两边各自的舍入）。写成相对误差会
// 在 mantissa 靠近 1 还是 9 时松紧不一，那是含糊的；这里按十进制步长算，说得清。
//
// 切词把 `(` `,` `)` 也当分隔符（而且**留在词里**照旧逐字节比）：pair 印出来是
// `(0.79…,0.027…)` 一整块，按空白切的话 Number() 得到 NaN，两边只差最后一位也会判成不同。
// tol/cgamma.asy（复数 gamma）就是这么撞上的。
const tolToks = (s) => s.trim().split(/([(),])|\s+/).filter((t) => t !== undefined && t !== '');
const tolSame = (a, b) => {
  const xs = tolToks(a);
  const ys = tolToks(b);
  if (xs.length !== ys.length) return false;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === ys[i]) continue;
    const x = Number(xs[i]);
    const y = Number(ys[i]);
    if (x !== x || y !== y) return false;
    const scale = Math.max(Math.abs(x), Math.abs(y));
    if (scale === 0) return false;
    const step = Math.pow(10, Math.floor(Math.log10(scale)) - 14);
    if (Math.abs(x - y) > 1.5 * step) return false;
  }
  return true;
};

for (const f of readdirSync(join(here, 'tol')).filter(isCase).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.asy');
  const dir = join(here, 'tol');
  const path = join(dir, f);
  const expected = read(join(dir, `${name}.expected`));
  const bad = [];

  const first = cmd(LEGS[0].args(path), dir);
  if (first.code !== 0) bad.push(`    ${LEGS[0].tag} exit=${first.code}\n${first.err}`);
  let exact = true;
  for (const leg of LEGS.slice(1)) {
    const r = cmd(leg.args(path), dir);
    if (r.code !== 0) { bad.push(`    ${leg.tag} exit=${r.code}\n${r.err}`); continue; }
    if (r.out !== first.out) exact = false;
    if (!tolSame(r.out, first.out)) {
      bad.push(`    ${leg.tag} 与 ${LEGS[0].tag} 超出容差\n      ${LEGS[0].tag}: ${JSON.stringify(first.out)}\n      ${leg.tag}: ${JSON.stringify(r.out)}`);
    }
  }
  if (expected === null) bad.push('    缺 .expected');
  else if (!tolSame(first.out, expected)) {
    bad.push(`    超出容差\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(first.out)}`);
  }
  let tjudged = '';
  if (asyBin !== null) {
    const r = spawnSync(asyBin, ['-noV', path], { encoding: 'utf8', cwd: dir });
    const real = (r.stdout ?? '') + (r.stderr ?? '');
    if ((r.status ?? 1) !== 0) bad.push(`    真 asy 自己就跑不过 exit=${r.status}\n${real}`);
    else if (!tolSame(real, first.out)) {
      bad.push(`    与真 asy 超出容差\n      asy:  ${JSON.stringify(real)}\n      omni: ${JSON.stringify(first.out)}`);
    } else tjudged = real === first.out ? ' ~= asy -noV（逐字节）' : ' ~= asy -noV（容差内）';
  }
  if (bad.length === 0) ok(`tol/${name} [${NWAY}${exact ? '逐字节一致' : '容差内一致'}${tjudged}]`);
  else no(`tol/${name}`, bad.join('\n'));
}
lap('tol');

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
lap('bad');

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
lap('strict');

// ------------------------------------------- 5. draw/：EPS 五方一致 + 真 asy 的 EPS 判分
//
// 绘图那一节的用例是**纯 asy 源码**（没有 `import asy_builtins;`）：我们这边靠
// `OMNI_ASY_BUILTINS=1` 把内建面隐式引进来（真 asy 那边它本来就是运行时自带的），
// 于是同一个文件两边都能跑，判分的人还是真 asy。
// 比的是 EPS **正文**：`%%Creator` 与 `%%CreationDate` 两行滤掉（后者是时间戳，
// 前者我们写的是自己的名字）。我们的 shipout 印到标准输出，asy 那边写文件。

const epsBody = (s) => s.split('\n').filter((l) => !l.startsWith('%%Creator')
  && !l.startsWith('%%CreationDate')).join('\n');

for (const f of readdirSync(join(here, 'draw')).filter(isCase).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.asy');
  const dir = join(here, 'draw');
  const path = join(dir, f);
  const expected = read(join(dir, `${name}.expected`));
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
    const out = join(mkdtempSync(join(tmpdir(), 'omni-asy-')), name);
    const r = spawnSync(asyBin, ['-noV', '-f', 'eps', '-o', out, path], { encoding: 'utf8', cwd: dir });
    const real = read(`${out}.eps`);
    if ((r.status ?? 1) !== 0 || real === null) {
      bad.push(`    真 asy 自己就没出 EPS exit=${r.status}\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
    } else if (epsBody(real) !== epsBody(first.out)) {
      bad.push(`    与真 asy 的 EPS 正文不同\n      asy:  ${JSON.stringify(epsBody(real))}\n      omni: ${JSON.stringify(epsBody(first.out))}`);
    } else judged = ' == asy -f eps';
  }

  if (bad.length === 0) ok(`draw/${name} [${AGREE} == ${name}.expected${judged}]`);
  else no(`draw/${name}`, bad.join('\n'));
}
lap('draw');

process.stdout.write(`\n${pass} passed, ${fail} failed  （腿：${LEGS.map((l) => l.tag).join(', ')}`
  + `${LEGS.length === ALL_LEGS.length ? '' : '，OMNI_LEGS=all 跑齐五条'}，总 ${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
