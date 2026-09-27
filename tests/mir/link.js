#!/usr/bin/env node
// Omni — MIR 层的链接器（ADR-0047 的"第 2 道坎"）
//
// 判的是一件事：**两份翻译单元链起来，跑出的数与"拼成一份"编出来的一样。**
// 尺子选"拼成一份"而不是手写一个期望值 —— 那样这道门同时钉住"链接没改语义"。
//
// 两份各带一条自己的静态串（`tag = "A"` / `"B"`），所以：
//   * 两份的 data 段都得在（少一份就读到 0）；
//   * 各自的指针得各指各的（搬 B 的 data 时漏一条就指到 A 的字节上）。
//
//   node tests/mir/link.js

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workDir } from '../work.js';
import { lowerC } from '../../src/core/frontend-c/tccgen.js';
import { runMirModule } from '../../src/core/mir/interp.js';
import { linkMir, linkAll } from '../../src/core/mir/link.js';
import { verifyMir } from '../../src/core/mir/verify.js';

const dir = workDir('mir-link');
const host = { arch: 'arm64', os: 'osx', includeDirs: [], sysIncludeDirs: [] };
const OIR = { structs: [], funcs: [] };

let pass = 0;
let fail = 0;
const failures = [];
const ok = (m) => { pass += 1; process.stdout.write(`  ok   ${m}\n`); };
const bad = (label, detail) => {
  fail += 1;
  failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

const build = (name, src) => {
  const path = join(dir, name);
  writeFileSync(path, src);
  return lowerC(path, src, host, [], []).mod;
};

/* `bee` 在 a.c 里只有声明（于是那儿是一格桩），定义在 b.c 里；两份各有自己的静态串。 */
const A = 'int bee(int x);\nstatic const char *tag = "A";\n'
  + 'int main(void){ return bee(20) + (int)tag[0]; }\n';
/* 库那一份也得陪一个 `main`（这条腿上没有 `main` 就编不过）—— 链的时候丢掉它。 */
const B = 'static const char *tag = "B";\nint bee(int x){ return x + (int)tag[0]; }\n'
  + 'int main(void){ return 0; }\n';
/* 尺子：同一份源码拼成一格翻译单元（静态量重名，所以 b 那一份的 `tag` 换个名字 ——
   拼一份时它们是同一个作用域，而分两份时各自是文件局部的）。 */
const ONE = 'static const char *tagB = "B";\nint bee(int x){ return x + (int)tagB[0]; }\n'
  + 'static const char *tag = "A";\nint main(void){ return bee(20) + (int)tag[0]; }\n';

const want = runMirModule(OIR, build('one.c', ONE));

{
  const name = 'link/两份链起来';
  let got;
  try {
    const m = linkMir(build('a.c', A), build('b.c', B));
    const diags = { errors: [], error() { this.errors.push([...arguments]); }, hasErrors() { return this.errors.length > 0; } };
    verifyMir(m, diags);
    if (diags.hasErrors()) {
      bad(name, `    链完过不了 verifier：${JSON.stringify(diags.errors[0])}`);
    } else {
      got = runMirModule(OIR, m);
      if (got !== want) bad(name, `    链完得 ${got}，拼成一份是 ${want}`);
      else ok(`${name} [与拼成一份都是 ${want}]`);
    }
  } catch (e) {
    bad(name, `    ${e.stack.split('\n').slice(0,4).join('\n    ')}`);
  }
}

/* 反面：B 的 data 段不搬（把它的整块像留在 64K 处），那它的串就压在 A 的 data 上 ——
   答案必须变。这一格红了说明这道门判不出"B 的 data 没搬"。 */
{
  const name = 'link/反面：B 的 data 不搬就必须不一样';
  let got;
  try {
    const a = build('a.c', A);
    const b = build('b.c', B);
    /* 把两张表清空 = "忘了搬" —— 于是 `shiftImage` 什么都改不了。 */
    for (const seg of b.mem.data) seg.relocs = [];
    b.addrConsts.clear();
    got = runMirModule(OIR, linkMir(a, b));
  } catch (e) {
    got = `报错：${e.message.split('\n')[0]}`;
  }
  if (String(got) === String(want)) bad(name, `    忘了搬居然也得 ${want}`);
  else ok(`${name} [搬了是 ${want}、忘了搬是 ${got}]`);
}

/* **同名的 `static`**：C 里它们是文件局部的，两份各有一个 `helper` 合法 ——
   链的时候该给其中一个改名，不是报"重复定义"（`src/main` 那 99 份里这种撞车 10 个名字）。
   尺子照旧是"拼成一份"（那时手工改名，与链接器自己挂后缀等价）。 */
{
  const name = 'link/同名的 static 各算一个';
  const SA = 'int bee(int x);\nstatic int helper(void){ return 3; }\n'
    + 'int main(void){ return bee(10) + helper(); }\n';
  const SB = 'static int helper(void){ return 5; }\n'
    + 'int bee(int x){ return x + helper(); }\nint main(void){ return 0; }\n';
  const SONE = 'static int helperB(void){ return 5; }\n'
    + 'int bee(int x){ return x + helperB(); }\n'
    + 'static int helper(void){ return 3; }\n'
    + 'int main(void){ return bee(10) + helper(); }\n';
  const w = runMirModule(OIR, build('sone.c', SONE));
  let got;
  try {
    got = runMirModule(OIR, linkMir(build('sa.c', SA), build('sb.c', SB)));
  } catch (e) {
    got = `报错：${e.message.split('\n')[0]}`;
  }
  if (String(got) !== String(w)) bad(name, `    链完得 ${got}，拼成一份是 ${w}`);
  else ok(`${name} [与拼成一份都是 ${w}]`);
}

/* **两份用的 C 符号不一样**：B 的每条 `CCALL` 都要按新表改号，少这一步就会调到
   A 表里另一个函数上（静默调错函数，最难查的一种）。 */
{
  const name = 'link/两份的 C 符号表各不相同';
  const CA = 'unsigned long strlen(const char *s);\nint bee(int x);\n'
    + 'int main(void){ return bee(2) + (int)strlen("abcd"); }\n';
  const CB = 'int abs(int v);\nint bee(int x){ return abs(-7) + x; }\nint main(void){ return 0; }\n';
  const CONE = 'int abs(int v);\nunsigned long strlen(const char *s);\n'
    + 'int bee(int x){ return abs(-7) + x; }\n'
    + 'int main(void){ return bee(2) + (int)strlen("abcd"); }\n';
  const w = runMirModule(OIR, build('cone.c', CONE));
  let got;
  try {
    got = runMirModule(OIR, linkMir(build('ca.c', CA), build('cb.c', CB)));
  } catch (e) {
    got = `报错：${e.message.split('\n')[0]}`;
  }
  if (String(got) !== String(w)) bad(name, `    链完得 ${got}，拼成一份是 ${w}`);
  else ok(`${name} [与拼成一份都是 ${w}]`);
}

/* **三份**：`linkAll` 从左往右折。三份各带一条自己的静态串 —— 一条都不许串。 */
{
  const name = 'link/三份一起链';
  const TA = 'int f2(int); int f3(int);\nstatic const char *t = "A";\n'
    + 'int main(void){ return f2(1) + f3(2) + (int)t[0]; }\n';
  const TB = 'static const char *t = "B";\nint f2(int x){ return x + (int)t[0]; }\n'
    + 'int main(void){ return 0; }\n';
  const TC = 'static const char *t = "C";\nint f3(int x){ return x + (int)t[0]; }\n'
    + 'int main(void){ return 0; }\n';
  const TONE = 'static const char *tb = "B";\nint f2(int x){ return x + (int)tb[0]; }\n'
    + 'static const char *tc = "C";\nint f3(int x){ return x + (int)tc[0]; }\n'
    + 'static const char *t = "A";\nint main(void){ return f2(1) + f3(2) + (int)t[0]; }\n';
  const w = runMirModule(OIR, build('tone.c', TONE));
  let got;
  try {
    got = runMirModule(OIR, linkAll([build('ta.c', TA), build('tb.c', TB), build('tc.c', TC)]));
  } catch (e) {
    got = `报错：${e.message.split('\n')[0]}`;
  }
  if (String(got) !== String(w)) bad(name, `    链完得 ${got}，拼成一份是 ${w}`);
  else ok(`${name} [与拼成一份都是 ${w}]`);
}

/* **跨单元的 extern 变量**：函数那一侧有桩可换，变量那一侧只能回填那条地址常量。
   两份都读写它（B 里加一次），所以"两份各有一块"那种错法会被算出来的数抓住。 */
{
  const name = 'link/跨单元的 extern 变量';
  const EA = 'extern int shared;\nint bump(void);\n'
    + 'int main(void){ shared = 10; bump(); return shared; }\n';
  const EB = 'int shared;\nint bump(void){ shared = shared + 5; return shared; }\n'
    + 'int main(void){ return 0; }\n';
  const EONE = 'int shared;\nint bump(void){ shared = shared + 5; return shared; }\n'
    + 'int main(void){ shared = 10; bump(); return shared; }\n';
  const w = runMirModule(OIR, build('eone.c', EONE));
  let got;
  try {
    got = runMirModule(OIR, linkMir(build('ea.c', EA), build('eb.c', EB)));
  } catch (e) {
    got = `报错：${e.message.split('\n')[0]}`;
  }
  if (String(got) !== String(w)) bad(name, `    链完得 ${got}，拼成一份是 ${w}`);
  else ok(`${name} [与拼成一份都是 ${w}]`);
}

/* 重复定义要报（两份都有 `bee` 的真定义）。 */
{
  const name = 'link/重复定义当场报';
  const B2 = 'int bee(int x){ return x; }\nint main(void){ return bee(1); }\n';
  let msg = '（没报）';
  try {
    linkMir(build('a2.c', B2), build('b2.c', B2));
  } catch (e) {
    msg = e.message;
  }
  if (msg.includes('重复定义')) ok(`${name} [${msg}]`);
  else bad(name, `    想要一句"重复定义"，实得：${msg}`);
}

/* **过真管子那一趟**（`lang/c.js` 的 `cMirLink`）：读文件、lower 每一份、链、
   查未定义符号、过 verifier、再跑一遍优化。上面几格用的是裸 `lowerC`，所以这一格
   钉的是"优化器与 verifier 也收得下链完的那一份"。 */
{
  const name = 'link/过 cMirLink 那条真管子';
  const { cMirLink } = await import('../../src/core/lang/c.js');
  const PA = 'int bee(int);\nextern int shared;\nstatic const char *t = "A";\n'
    + 'int main(void){ shared = 4; return bee(3) + (int)t[0] + shared; }\n';
  const PB = 'int shared;\nstatic const char *t = "B";\n'
    + 'int bee(int x){ shared = shared + 1; return x + (int)t[0]; }\nint main(void){ return 0; }\n';
  const PONE = 'int shared;\nstatic const char *tb = "B";\n'
    + 'int bee(int x){ shared = shared + 1; return x + (int)tb[0]; }\n'
    + 'static const char *t = "A";\n'
    + 'int main(void){ shared = 4; return bee(3) + (int)t[0] + shared; }\n';
  const pa = join(dir, 'pa.c');
  const pb = join(dir, 'pb.c');
  writeFileSync(pa, PA);
  writeFileSync(pb, PB);
  const w = runMirModule(OIR, build('pone.c', PONE));
  let got;
  try {
    got = runMirModule(OIR, cMirLink([pa, pb], [], [], [], undefined, undefined));
  } catch (e) {
    got = `报错：${e.message.split('\n')[0]}`;
  }
  if (String(got) !== String(w)) bad(name, `    链完得 ${got}，拼成一份是 ${w}`);
  else ok(`${name} [与拼成一份都是 ${w}]`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
