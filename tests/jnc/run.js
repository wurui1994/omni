#!/usr/bin/env node
// Omni — jancy 前端（第十五条测试轴，ADR-0016 分步 8 的验收）
//
// 这条轴与 tests/asy 那条是**两条不同的纪律**。asy 那边有 oracle（`/opt/homebrew/bin/asy
// -noV`），所以每一条都要"量"；jancy 的 `jnc` 要 LLVM + axl 才编得出来，我们不装它 ——
// 用户定的是「只借用 jancy 的完整语法和形式」。所以这边每一条期望输出都由我们自己写，
// 而**每一条都要在源文件的注释里注明出处**（引哪一份文档、哪一条 `.llk` 规则、哪一份语料）。
//
// 语法那一半不在这里：`stage0/src/frontend-jnc/jnc.grammar` 在 tests/glr/run.js 的
// `cases/jnc` 那一组里量（526/528 份真实 `.jnc` 唯一成树）。这里量的是**降级**。
//
// 三件事：
//   1. cases/*.jnc 在 run / run-c / interp / interp --mir / run-llvm 五条腿上逐字节相同，
//      且等于 .expected。五方一致比对上期望值更强 —— 指针在这五条腿上是**两套实现**
//      （arena 模拟 vs 真指针，ADR-0016），逐字节相同不是巧合。
//   2. rt/*.jnc 在五条腿上报**同一句**运行期错误。
//   3. bad/*.jnc 必须被拒绝，且拒在正确的理由上。这一组是那些边界的本体：多维数组、
//      数组之间的赋值、`threadlocal`、对 string 的模块级变量取地址、`%p`、
//      `unsafe` 之外的 thin 转换、64 位的无符号整数、`%zd` 那一族的长度修饰、函数类型的
//      typedef、`sizeof`（要方言的布局先认整数宽度）、`dynamic countof`（要 fat 指针带的
//      范围）、从一个要先求值的东西上问枚举成员、枚举的底类型是另一个枚举（要枚举之间的基类链）、
//      `using namespace`（要查名从一条线变成一张图）、类的基类（要对象头与虚表）、
//      类里的 `destruct`（jancy 自己的文档就说它是 GC 在不确定的时刻调的，disposable.rst:17）、
//      类里的 `get` / `set`（要属性那一套）、构造的**重载**（要重载决议）、
//      格式化字面量 `$"…"`（要在降级里回头解析一小段源码）、二进制字面量 `0x"61 62"` 与
//      `__FILE__` 那族预定义宏（前者要字节宽度、后者要编译期环境）、
//      没写初值的函数指针（方言的函数值那一格没有空值）、函数指针的**字段**（方言的结构体
//      字段放不下函数值，而虚表要落的正是这一格）、`function**`、`~()` 的部分应用、
//      一个字段都没有的 struct（卡在方言那一侧：`(struct S )` 要方言认零个字段），
//      加七条 jancy 自己也拒的（命名项之后不能再写
//      位置项、`double` 上的 `&=`、int 到枚举的隐式转换、非 0 的 int 到 bitflag 枚举、
//      `countof` 作用在指针上、`assert` 的第二个实参不是字面量、给类的变量赋值）。（`? :`、不换行的 printf、条件真值化曾经在
//      这一组里，第三到第五刀把它们做掉之后转到了 cases/；`&x` 是第九刀、定长数组是第十刀、
//      模块级变量是第十一刀、值语义的结构体是第十二刀、结构体按值传与按值回是第十三刀、
//      花括号初值是第十四刀、不看顺序的名字是第十五刀、指针的地址是第十六刀，现在各在
//      cases/09-addr.jnc、cases/10-arrays.jnc、cases/11-globals.jnc、cases/12-structs.jnc、
//      cases/13-struct-args.jnc、cases/14-curly.jnc、cases/15-forward.jnc、
//      cases/16-ptrptr.jnc；`new T { … }` 是第二十五刀、`static` 的局部量是第二十六刀、
//      整数与 `%s` 上的精度加 `%*d` 是第二十七刀、`%.*f` 是第二十八刀、`+` / 空格 / `#`
//      三个标志是第二十九刀、`%e` / `%E` 是第三十刀、`%g` / `%G` 是第三十一刀、`%u` 是
//      第三十二刀、无符号的 8 / 16 / 32 位是第三十三刀、字面量的进制是第三十四刀、
//      位运算与移位的复合赋值是第三十五刀、`switch` 是第三十六刀、bool 参与整数运算是
//      第三十七刀、`typedef` 是第三十八刀、`enum` 是第三十九刀、`break2` / `continue2` 与
//      switch 里的 continue 是第四十一刀（方言的层号是第四十刀）、带步进的 for 里的 continue
//      是第四十二刀、printf 的长度修饰是第四十四刀、`countof` 是第四十五刀、指针比大小是
//      第四十六刀、`bitflag enum` 是第四十七刀、编译期整数求值是第四十八刀、`assert` 是
//      第四十九刀、int 到枚举的显式转换是第五十刀、`namespace` 是第五十一刀、`class` 是
//      第五十二刀、`construct` 与 `static construct` 是第五十三刀、相邻字面量的拼接是
//      第五十四刀、函数指针（`function*` / `function thin*`）是第五十五刀，在
//      cases/24-new-curly.jnc、
//      cases/25-static-local.jnc、cases/26-printf-prec.jnc、cases/27-printf-star-prec.jnc、
//      cases/28-printf-flags.jnc、cases/29-printf-sci.jnc、cases/30-printf-gen.jnc、
//      cases/31-printf-u.jnc、cases/32-unsigned.jnc、cases/33-radix.jnc、
//      cases/34-bitassign.jnc、cases/35-switch.jnc、cases/36-bool-int.jnc、
//      cases/37-typedef.jnc、cases/38-enum.jnc、cases/39-breakn.jnc、cases/40-forcont.jnc、
//      cases/41-printf-len.jnc、cases/42-countof.jnc、cases/43-ptrcmp.jnc、
//      cases/44-bitflag.jnc、cases/45-constfold.jnc、cases/46-assert.jnc、
//      cases/47-enumcast.jnc、cases/48-namespace.jnc、cases/49-class.jnc、
//      cases/50-construct.jnc、cases/51-litcat.jnc、cases/52-fnptr.jnc。）
//
//      bad/ 里有**四种**拒，别混：一种是"还没长出来"（做掉就落地）；一种是**这一层不做**
//      （printf-conv-p：`%p` 要观测裸地址，而五条腿上那不是同一个数；ptrcmp-mixed：不同型的
//      两个指针 jancy 那边其实过得去 —— 它自己的 TODO 记着这个检查没做 —— 而这一层降级用的
//      是按元素算差的 `psub`，元素不一样大时"差几个元素"没有意义）；一种是**C 自己的
//      未定义行为**（printf-plus-hex 的 `%+x`、printf-alt-u 的 `%#u`、bitflag-neg 的
//      `bitflag enum { A = -1 }` —— jancy 算下一格的那句 `2 << getHiBitIdx64(-1)` 在 C++ 里
//      是移位越界、const-shift-wide 的 `1 << 64` —— C99 6.5.7p3；四条都没有可对的答案）；
//      一种是**jancy 自己也拒**（enum-from-int 的 int 到枚举、bitflag-from-int 的非 0 int 到
//      bitflag 枚举、curly-after-named、bitassign-real、countof-ptr、assert-msg-expr 的
//      `assert(C, 一个表达式)`、class-var-assign 的 `a = b`（两边都是类的**变量** ——
//      type_class.rst:19 那句 "You cannot assign varibles or fields of class types"）
//      —— 这几条落地了也还是拒，
//      只是理由要对得上 jancy 的那一句）。
//
//   node tests/jnc/run.js
//   node tests/jnc/run.js pointers

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const cmd = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });
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

const LEGS = [
  { tag: 'run', args: (p) => ['run', p] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
  { tag: 'run-llvm', args: (p) => ['run-llvm', p] },
];

const list = (sub, ext) => readdirSync(join(here, sub)).filter((x) => x.endsWith(ext)).sort();

// ------------------------------------------------- 1. cases/：五条腿一致 + 对上期望值

for (const f of list('cases', '.jnc')) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const src = join(here, 'cases', f);
  const expected = read(join(here, 'cases', `${name}.expected`));
  const bad = [];
  const first = cmd(LEGS[0].args(src));
  if (first.code !== 0) bad.push(`    ${LEGS[0].tag} exit=${first.code}\n${first.err}`);
  for (const leg of LEGS.slice(1)) {
    const r = cmd(leg.args(src));
    if (r.code !== 0) { bad.push(`    ${leg.tag} exit=${r.code}\n${r.err}`); continue; }
    if (r.out !== first.out) {
      bad.push(`    ${leg.tag} 与 ${LEGS[0].tag} 不同\n      ${LEGS[0].tag}: ${JSON.stringify(first.out)}\n      ${leg.tag}: ${JSON.stringify(r.out)}`);
    }
  }
  if (expected === null) bad.push('    缺 .expected');
  else if (first.out !== expected) {
    bad.push(`    对不上期望值\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(first.out)}`);
  }
  if (bad.length === 0) ok(`cases/${name} [五方一致 == ${name}.expected]`);
  else no(`cases/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 2. rt/：运行期错误，五条腿同一句话

for (const f of list('rt', '.jnc')) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const exp = read(join(here, 'rt', `${name}.expected`));
  if (exp === null) { no(`rt/${name}`, `    缺 ${name}.expected`); continue; }
  const bad = [];
  for (const leg of LEGS) {
    const r = cmd(leg.args(join(here, 'rt', f)));
    if (r.code === 0) { bad.push(`    ${leg.tag} 居然跑完了 —— 这里该报运行期错误`); continue; }
    if (!r.err.includes(exp.trim())) {
      bad.push(`    ${leg.tag} 的消息不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.trim())}`);
    }
  }
  if (bad.length === 0) ok(`rt/${name} [五条腿同一句：${exp.trim()}]`);
  else no(`rt/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 3. bad/：拒绝，且理由正确
//
// 一条腿就问得清（这些都是降级期拒的），所以只跑 `run`。

for (const f of list('bad', '.jnc')) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const exp = read(join(here, 'bad', `${name}.expected`));
  if (exp === null) { no(`bad/${name}`, `    缺 ${name}.expected`); continue; }
  const r = cmd(['run', join(here, 'bad', f)]);
  if (r.code === 0) { no(`bad/${name}`, '    居然通过了 —— 这条边界是刻意划的'); continue; }
  if (!r.err.includes(exp.trim())) {
    no(`bad/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.trim())}`);
    continue;
  }
  ok(`bad/${name} [拒绝：${exp.trim()}]`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
