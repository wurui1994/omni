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
import { linkMir } from '../../src/core/mir/link.js';
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

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
