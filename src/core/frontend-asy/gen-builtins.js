#!/usr/bin/env node
// 从 asymptote 自己的源码生成 asy 的内建绑定表（builtins.tab）。
//
// 为什么要生成而不是手写：asy 的内建函数在它那边本来就是**数据** ——
//   - `runmath.in` 里是带签名的声明（`Int ceil(real x)` / `real fmod(real x, real y)`），
//   - `builtin.cc` 里是 `addRealFunc(sin,SYM(sin))` 这一族（直通 libm 的那些）。
// 手抄一份就等于把别人的表复制进我们的代码里，下次 asy 升级没人知道差了什么。
// 支持一门语言的成本应该是「读它的表」，不是「在降级器里写一堆分支」。
//
//   node src/core/frontend-asy/gen-builtins.js [asymptote 源码目录] > builtins.tab
//
// 默认源码目录：`$ASY_SRC`，或 `~/Documents/Lang/reference/asymptote`（按家目录拼）。
// 「实现在哪」那一列是**我们的**策略（这个文件里的 POLICY），不是从 asy 抄的：
//   rmath = 核心方言白名单（转手宿主的数学库：C 走 libm、JS 走 Math.*）
//   nope  = 还没做（报错里说清是哪一个）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/* 缺省路径按家目录拼 —— 仓库里不留任何人的家目录（`$ASY_SRC` / 命令行第一个实参先赢）。 */
const src = process.argv[2] ?? process.env.ASY_SRC
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'asymptote');

const POLICY = new Map([
  ['sqrt', ['rmath', 'sqrt']],
  ['fabs', ['rmath', 'fabs']],
  ['abs', ['rmath', 'fabs', 'real']],
  ['floor', ['rmath', 'floor']],
  ['ceil', ['rmath', 'ceil']],
  ['round', ['rmath', 'round']],
  ['fmod', ['rmath', 'fmod']],
  // 超越函数也是 rmath：C 那条腿转手 libm，JS 那条腿转手 Math.*。标准库有的东西
  // 不自己写；代价是这一族只保证容差（见 src/runtime/omni_math.c 的头注）。
  ['sin', ['rmath', 'sin']],
  ['cos', ['rmath', 'cos']],
  ['tan', ['rmath', 'tan']],
  ['asin', ['rmath', 'asin']],
  ['acos', ['rmath', 'acos']],
  ['atan', ['rmath', 'atan']],
  ['atan2', ['rmath', 'atan2']],
  ['sinh', ['rmath', 'sinh']],
  ['cosh', ['rmath', 'cosh']],
  ['tanh', ['rmath', 'tanh']],
  ['asinh', ['rmath', 'asinh']],
  ['acosh', ['rmath', 'acosh']],
  ['atanh', ['rmath', 'atanh']],
  ['exp', ['rmath', 'exp']],
  ['expm1', ['rmath', 'expm1']],
  ['log', ['rmath', 'log']],
  ['log10', ['rmath', 'log10']],
  ['log1p', ['rmath', 'log1p']],
  ['cbrt', ['rmath', 'cbrt']],
  ['hypot', ['rmath', 'hypot']],
]);

// asy 的类型名 -> 我们表里的写法。只收标量数学那一族；别的（pair/path/picture…）
// 归它们自己的表，那是绘图层那一刀的事。
const TY = new Map([['real', 'real'], ['Int', 'int']]);

const rows = new Map();
const add = (name, args, ret) => {
  if (rows.has(name)) return;         // 第一处声明为准（asy 那边重载的先不管，见下）
  const pol = POLICY.get(name) ?? ['nope', '-'];
  // POLICY 的第三项是**返回类型的覆盖**：asy 那边重载的名字（`abs`）在 runmath.in 里
  // 先撞上 int 那一支，而这张表一行只放一个签名，所以钉住我们要的那一支。
  rows.set(name, {
    name, arity: args.length, ret: pol[2] === undefined ? ret : pol[2],
    kind: pol[0], impl: pol[1],
  });
};

// 1) runmath.in：`RET NAME(FORMALS)` 顶到行首，下一行是 `{`
const mathIn = join(src, 'runmath.in');
if (!existsSync(mathIn)) {
  process.stderr.write(`找不到 ${mathIn}（给我 asymptote 源码目录，或设 ASY_SRC）\n`);
  process.exit(1);
}
const lines = readFileSync(mathIn, 'utf8').split('\n');
for (const line of lines) {
  const m = /^(Int|real) ([A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s*$/.exec(line);
  if (m === null) continue;
  const ret = TY.get(m[1]);
  const args = [];
  let ok = true;
  for (const raw of m[3].split(',')) {
    const a = raw.trim();
    if (a === '') continue;
    const t = a.split(' ')[0];
    if (!TY.has(t)) { ok = false; break; }
    args.push(TY.get(t));
  }
  if (!ok || ret === undefined) continue;
  add(m[2], args, ret);
}

// 2) builtin.cc：addRealFunc(f,SYM(name)) / addRealFunc<f>(ve,SYM(name)) / addRealFunc2 /
//    addRealIntFunc<f>(ve,SYM(name),…)
const bc = readFileSync(join(src, 'builtin.cc'), 'utf8');
for (const m of bc.matchAll(/addRealFunc\(([A-Za-z_][A-Za-z0-9_]*),SYM\(([A-Za-z_][A-Za-z0-9_]*)\)\)/g)) {
  add(m[2], ['real'], 'real');
}
for (const m of bc.matchAll(/addRealFunc<[A-Za-z_][A-Za-z0-9_]*>\(ve,SYM\(([A-Za-z_][A-Za-z0-9_]*)\)\)/g)) {
  add(m[1], ['real'], 'real');
}
for (const m of bc.matchAll(/addRealFunc2\(ve,\s*[A-Za-z_:<>0-9]+,\s*SYM\(([A-Za-z_][A-Za-z0-9_]*)\)\)/g)) {
  add(m[1], ['real', 'real'], 'real');
}
for (const m of bc.matchAll(/addRealIntFunc<[A-Za-z_][A-Za-z0-9_]*>\(ve,\s*SYM\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
  add(m[1], ['real', 'int'], 'real');
}

const names = [...rows.keys()].sort();
const out = [];
out.push('# asy 的内建实数函数 —— **绑定表**，不是代码。这个文件是**生成的**：');
out.push('#   node src/core/frontend-asy/gen-builtins.js [asymptote 源码目录] > builtins.tab');
out.push('# 来源是 asy 自己的两份数据：runmath.in 里带签名的声明，与 builtin.cc 里');
out.push('# `addRealFunc(sin,SYM(sin))` 那一族（直通 libm 的那些）。asy 也是一张表，不是语法。');
out.push('#');
out.push('# 列：名字  实参个数  返回类型  实现在哪  实现的符号');
out.push('#   rmath = 核心方言的 (rmath "…" …) 白名单 —— **转手宿主的数学库**：C 那条腿是 libm，');
out.push('#           JS 那条腿是 Math.*。sqrt（IEEE 强制正确舍入）、fabs/floor/ceil/round/fmod');
out.push('#           （精确运算）、pow（量过逐位相同）逐字节一致；超越函数只保证容差，');
out.push('#           它们的用例走 tests/asy/tol/ 那一节（腿之间、与真 asy 都按最后一位十进制差 1）。');
out.push('#   nope  = 还没做（见到就报错，报错里说清是哪一个）');
out.push('#');
out.push('# 返回类型是 asy 声明里写的：floor/ceil/round 回 int，其余回 real；');
out.push('# `abs` 按实参分 int/real/pair（那三条分支在降级器里，它要看实参类型）。');
out.push('# asy 还会把每个 `real f(real)` 自动抬成 `real[] f(real[])`（addRealFunc 一次注册');
out.push('# 两条）。那是绑定层的**通用规则**，将来是这张表上加一列，不是逐个函数的活儿。');
for (const n of names) {
  const r = rows.get(n);
  out.push(`${n.padEnd(11)}${r.arity} ${r.ret.padEnd(4)} ${r.kind.padEnd(5)} ${r.impl}`);
}
process.stdout.write(out.join('\n') + '\n');
