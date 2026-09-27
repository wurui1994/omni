#!/usr/bin/env node
// Omni — MIR：**data 段搬得动吗**（ADR-0047 的"第 2 道坎"，MIR 层链接器的前置门）
//
// 线性内存那条腿上地址是**烤成数**的：`static const char *s = "hi";` 落成
// `data @65552 8 bytes 1800010000000000`（里头是 `"hi"` 的地址），取址落成
// `const k5 i64 65552`。两份模块的 data 段各自从 64K 起，**合并就得搬其中一份** ——
// 而搬完之后这两样都得跟着加同一个差。MIR 里因此有两张表：
//
//   * `mem.data[].relocs = [{at, size}]` —— 这一段里哪几格装的是地址；
//   * `addrConsts` —— 哪几条 i64 常量其实是地址。
//
// 这一份判的就是**那两张表够不够**：同一份 C 编两遍，一份原样跑、一份照两张表整块
// 搬 64K 再跑，答案必须相同。最后一格是**反面**：故意不打那一条数据重定位，答案必须
// 变 —— 否则这道门根本不会因为"记录漏了"而红，那它就没有判据的资格。
//
//   node tests/mir/reloc.js

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workDir } from '../work.js';
import { lowerC } from '../../src/core/frontend-c/tccgen.js';
import { runMirModule } from '../../src/core/mir/interp.js';

const dir = workDir('mir-reloc');
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

const build = (path, src) => {
  writeFileSync(path, src);
  return lowerC(path, src, host, [], []).mod;
};

/** 读/写那 8 个字节（小端）—— data 段里的指针就是这么躺着的。 */
const rd8 = (bytes, at) => {
  let v = 0n;
  for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
};
const wr8 = (bytes, at, v) => {
  const n = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i += 1) bytes[at + i] = Number((n >> BigInt(i * 8)) & 255n);
};

/**
 * 照那两张表把 data 段整块搬 `d` 字节。**链接器要做的就是这件事**（再加上"把两份的
 * 段拼起来"与"符号改名"），所以这儿的三步与那一刀一一对应：
 *   1. 每一段的落点 `off` 加 `d`；
 *   2. 段里每一条 `relocs` 指的那 8 个字节加 `d`（`skipRelocs` 那一档故意不做）；
 *   3. 每一条地址常量的值加 `d`。
 * 顺带把页数抬够 —— 搬完之后最高那一格字节要落在内存里。
 */
function shift(mir, skipRelocs = false) {
  /* **搬到所有东西的后头去**：这条腿上影子栈与堆是按 `dataOff` 一路算出来的，
     那几格基址不在 `addrConsts` 里（它们不是"加一个差"能对的东西，见那张表的账）。
     所以差取"现有内存的整数页数"—— 搬完之后 data 段落在栈与堆之上的空地里，
     不会被栈写花。链接器真干这件事时是重算整块布局，这儿只要证"两张表够用"。 */
  const d = mir.mem.min * 65536;
  for (const seg of mir.mem.data) {
    seg.off += d;
    if (skipRelocs) continue;
    for (const r of seg.relocs ?? []) wr8(seg.bytes, r.at, rd8(seg.bytes, r.at) + BigInt(d));
  }
  for (const ref of mir.addrConsts) {
    const c = mir.consts.items[ref];
    c.text = String(BigInt(c.text) + BigInt(d));
  }
  let top = 0;
  for (const seg of mir.mem.data) top = Math.max(top, seg.off + seg.bytes.length);
  const need = Math.ceil(top / 65536) + 1;
  if (mir.mem.min < need) mir.mem.min = need;
  return mir;
}

const cases = [
  {
    name: 'str-ptr',
    src: 'static const char *s = "hi";\nint main(void){ return (int)s[0] + (int)s[1]; }\n',
  },
  {
    name: 'addr-of-static',
    src: 'static int arr[4] = {1,2,3,4};\nstatic int *p = &arr[2];\nint main(void){ return *p + arr[0]; }\n',
  },
  {
    name: 'in-struct',
    src: 'static struct { const char *a; int n; } g = { "xy", 7 };\n'
      + 'int main(void){ return g.n + (int)g.a[1]; }\n',
  },
  {
    /* 范围指定初始化器：那几格指针是**复制**出来的（`pendingPtr` 跟着复制那一处）。
       漏掉那一句的症状是第二格搬完之后指着搬之前的地方 —— 正好由这一格判出来。 */
    name: 'range-designator',
    src: 'static const char *g[4] = {[0 ... 1] = "BB"};\n'
      + 'int main(void){ return (int)g[0][0] + (int)g[1][1]; }\n',
  },
  {
    /* 纯数：一条记录都没有，可搬完照样得对（地址常量那一半还在用 —— `a` 的地址）。 */
    name: 'plain-numbers',
    src: 'static int a[3] = {11,22,33};\nint main(void){ return a[0] + a[2]; }\n',
  },
];

for (const c of cases) {
  const path = join(dir, `${c.name}.c`);
  let before;
  let after;
  try {
    before = runMirModule(OIR, build(path, c.src));
    after = runMirModule(OIR, shift(build(path, c.src)));
  } catch (e) {
    bad(`reloc/${c.name}`, `    跑不起来：${e.message}`);
    continue;
  }
  if (before !== after) {
    bad(`reloc/${c.name}`, `    原样 ${before}、搬到后头之后 ${after} —— 两张表不够`);
  } else {
    ok(`reloc/${c.name} [原样与搬到内存后头都是 ${before}]`);
  }
}

/* **反面那一格**：故意不打数据重定位。`str-ptr` 那份搬完之后 `s` 还指着搬之前的
   那两个字节，而那儿已经不是 `"hi"` 了（原处的字节没人再写），所以答案必须变。
   这一格红了说明这道门判不出"记录漏了"—— 那比哪一格失败都严重。 */
{
  const name = 'reloc/反面：不打重定位就必须不一样';
  const src = 'static const char *s = "hi";\nint main(void){ return (int)s[0] + (int)s[1]; }\n';
  const path = join(dir, 'neg.c');
  const good = runMirModule(OIR, build(path, src));
  let broken;
  try {
    broken = runMirModule(OIR, shift(build(path, src), true));
  } catch (e) {
    /* 指到没铺过的那一页上去，解释腿当场报也算"不一样"—— 记录漏了看得见。 */
    broken = `报错：${e.message.split('\n')[0]}`;
  }
  if (String(broken) === String(good)) {
    bad(name, `    不打重定位居然也得 ${good} —— 这道门判不出记录漏了`);
  } else {
    ok(`${name} [打了是 ${good}、不打是 ${broken}]`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
