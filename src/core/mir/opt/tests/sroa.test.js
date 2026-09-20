/**
 * SROA（`decompose user`）的判据。**只在原生腿上量** —— 这一格只认 `FRAME`
 * （C 与线性内存无关：那个 `$sp` 影子栈是 wasm/js/解释器那几条腿的事）。
 *
 * 判四件事：
 *   1. 帧上那一块（数组/struct）真被拆成槽位：`MLOAD`/`MSTORE` 换成 `LOAD`/`STORE`
 *   2. **地址逃逸的不许拆**（`&t[0]` 交给别人）
 *   3. **变量下标的不许拆**（`t[i]` —— 格子说不清）
 *   4. 换完过 `verifyMir`，而且**幂等**
 *
 * 为什么不在这儿跑解释器对答案：原生 MIR 的入口是 `cMirNative`，它出来的东西要真机器码
 * 才跑得动。行为那一层由 `tests/mir/opt.js` 的 L1 原生腿那条守（85 份 .c 逐字节相同）——
 * 第一版 SROA 按 ref 而不是按**别名身份**分组，就是那条判据抓出来的（十几份对不上）。
 *
 * 跑：`node src/core/mir/opt/tests/sroa.test.js`
 */

import { sroa } from '../sroa.js';
import { deadcode } from '../deadcode.js';
import { OP_NAMES } from '../../ir.js';
import { cMirNative, cSysInclude } from '../../../lang/c.js';
import { verifyMir } from '../../verify.js';
import { writeFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); fails++; } };
function opCount(fn) {
  const c = {};
  for (const o of fn.op) { const n = OP_NAMES[o]; c[n] = (c[n] || 0) + 1; }
  return c;
}

const SRC = `
void sink(int *p);

/* 拆得掉：帧上一个数组，只按常量下标读写，地址不外传 */
int plain(int n) { int t[3]; t[0] = n; t[1] = n + 1; t[2] = t[0] + t[1]; return t[2]; }

/* 拆得掉：struct 的字段（也是常量偏移） */
int fields(int n) { struct { int a, b; } s; s.a = n; s.b = n * 2; return s.a + s.b; }

/* **不许拆**：地址交给了别人 */
int escaped(int n) { int t[2]; t[0] = n; sink(t); return t[0]; }

/* **不许拆**：下标是变量，格子说不清 */
int varidx(int n) { int t[4]; for (int i = 0; i < 4; i++) t[i] = i; return t[n & 3]; }

int main(void) { return plain(1) + fields(2) + escaped(3) + varidx(1); }
void sink(int *p) { p[0] = p[0] + 1; }
`;

const path = '/tmp/omni-mir-sroa-test.c';
writeFileSync(path, SRC);

const opts = { includeDirs: [], sysIncludeDirs: cSysInclude(), arch: 'arm64', os: 'osx' };
const { mod } = cMirNative(path, opts, []);
const before = {};
for (const f of mod.funcs) before[f.name] = opCount(f);

let changed = 0;
for (const fn of mod.funcs) { changed += sroa(fn, mod) || 0; deadcode(fn, mod); }
const after = {};
for (const f of mod.funcs) after[f.name] = opCount(f);

console.log('== SROA（原生腿）');
for (const n of ['plain', 'fields', 'escaped', 'varidx']) {
  console.log(`  ${n}: MLOAD ${before[n].MLOAD || 0}→${after[n].MLOAD || 0}`
    + `，MSTORE ${before[n].MSTORE || 0}→${after[n].MSTORE || 0}`
    + `，LOAD ${before[n].LOAD || 0}→${after[n].LOAD || 0}`
    + `，STORE ${before[n].STORE || 0}→${after[n].STORE || 0}`);
}
ok(changed > 0, `一共换了 ${changed} 条访存`);
ok((after.plain.MLOAD || 0) === 0 && (after.plain.MSTORE || 0) === 0, 'plain 里的按址访存全拆成槽位了');
ok((after.fields.MLOAD || 0) === 0 && (after.fields.MSTORE || 0) === 0, 'fields 里的字段全拆成槽位了');
ok((after.escaped.MSTORE || 0) === (before.escaped.MSTORE || 0)
   && (after.escaped.MLOAD || 0) === (before.escaped.MLOAD || 0), 'escaped 一条都没拆（地址逃逸了）');
ok((after.varidx.MSTORE || 0) === (before.varidx.MSTORE || 0), 'varidx 一条都没拆（下标是变量）');

const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 4).join(' / ') : ''));

let again = 0;
for (const fn of mod.funcs) again += sroa(fn, mod) || 0;
ok(again === 0, `再跑一遍换 0 条（幂等），实得 ${again}`);

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
