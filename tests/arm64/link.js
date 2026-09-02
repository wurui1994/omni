/* Mach-O 的读入与并合 —— 第九刀第十一片的验收。
 *
 * 三件事分开验：
 *
 * 1. **读回来再写出去，字节不变**。这是写出器与读入器互为对账 —— 任一侧错一格，
 *    这一条就不成立（而单看写出器，只有链接器肯不肯吃这一个信号）。
 * 2. **并合的账**：两个 `.o` 里的符号偏移挪对了没有、跨文件的 `bl` 填掉了没有、
 *    填不了的（libc 的符号、`adrp` 那两格）还在不在。
 * 3. **并出来的东西能跑**：把并合的结果交给 clang 与一个 C 的 main，真跑，对结果。
 *    这一条查的是「我们填进那 26 位里的偏移是真对的」—— 记错一笔账，这里就段错误。
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MirModule, MirFunc, OP, REF_NONE, T_I64 } from '../../stage0/src/mir/ir.js';
import { genModule } from '../../stage0/src/arm64/from_mir.js';
import { writeObject } from '../../stage0/src/arm64/macho.js';
import { readObject, linkObjects } from '../../stage0/src/arm64/link.js';
import { RELOC } from '../../stage0/src/arm64/asm.js';

let failed = 0;
let total = 0;
function ok(what, cond) {
  total++;
  if (cond) return;
  failed++;
  process.stdout.write(`  FAIL ${what}\n`);
}

/** 一个收两个 long long、回一个 long long 的函数，登记进模块。 */
function fn(m, name, body) {
  const f = new MirFunc(name, [], T_I64);
  const s = [f.slot('p0', T_I64), f.slot('p1', T_I64)];
  f.params.push({ name: 'p0', t: T_I64, slot: s[0] });
  f.params.push({ name: 'p1', t: T_I64, slot: s[1] });
  m.addFunc(f);
  body(f, s[0], s[1]);
  return f;
}

const ld = (f, slot) => f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot);
const ret = (f, v) => f.emit(OP.RET, T_I64, v, REF_NONE, 0);

/** 一个模块 -> 一个 `.o` 的字节。 */
function objOf(mod) {
  const blob = genModule(mod);
  const defs = [];
  for (let k = 0; k < mod.funcs.length; k++) {
    defs.push({ name: mod.funcs[k].name, off: blob.offsets[k] });
  }
  return writeObject(blob.bytes, blob.data, [...defs, ...blob.dataSyms], blob.relocs);
}

/* ---- 甲：被调的那一边。三个函数，其中两个是自家内部的调用（同一个 .o 里已经填好了）。 */
const modA = new MirModule('a');
{
  const triple = fn(modA, 'omni_lk_triple', (f, x) =>
    ret(f, f.emit(OP.MUL, T_I64, ld(f, x), modA.consts.int(3n), 0)));
  const no = modA.funcs.indexOf(triple);
  fn(modA, 'omni_lk_add3', (f, x, y) => {
    const t = f.emit(OP.CALL, T_I64, no, f.pushArgs([ld(f, x), ld(f, x)]), 0);
    ret(f, f.emit(OP.ADD, T_I64, t, ld(f, y), 0));
  });
  /* 串常量：让甲也有 `__DATA`，好查数据节的拼接与符号偏移。 */
  fn(modA, 'omni_lk_len', (f) =>
    ret(f, f.emit(OP.CCALL, T_I64, modA.cabiNo('strlen'),
      f.pushArgs([modA.consts.str('abcdefg')]), 0)));
}

/* ---- 乙：调甲的那一边。`omni_lk_add3` 在乙这儿是**外部符号**，跨文件的 `bl`
 *      就是这一片要填的那一格；`llabs` 是 libc 的，填不了，得原样转出去。 */
const modB = new MirModule('b');
{
  fn(modB, 'omni_lk_main', (f, x, y) => {
    const s = f.emit(OP.CCALL, T_I64, modB.cabiNo('omni_lk_add3'),
      f.pushArgs([ld(f, x), ld(f, y)]), 0);
    ret(f, f.emit(OP.CCALL, T_I64, modB.cabiNo('llabs'), f.pushArgs([s]), 0));
  });
  fn(modB, 'omni_lk_len_b', (f) =>
    ret(f, f.emit(OP.CCALL, T_I64, modB.cabiNo('strlen'),
      f.pushArgs([modB.consts.str('hij')]), 0)));
}

const objA = objOf(modA);
const objB = objOf(modB);

// ---------------------------------------------------------------- 一、往返
for (const [what, obj] of [['甲', objA], ['乙', objB]]) {
  const back = readObject(obj);
  const again = writeObject(back.text, back.data, back.defs, back.relocs);
  ok(`${what}：读回来再写出去，字节不变`,
    again.length === obj.length && again.every((v, i) => v === obj[i]));
}
{
  const back = readObject(objA);
  ok('甲：三个函数的符号都读回来了',
    ['omni_lk_triple', 'omni_lk_add3', 'omni_lk_len'].every(
      (n) => back.defs.some((d) => d.name === n && d.sect === 1)));
  ok('甲：串常量的符号在数据节里', back.defs.some((d) => d.sect === 2));
  ok('甲：内部调用不留重定位（同一个 .o 里 `bl` 已经填好）',
    !back.relocs.some((r) => r.sym === 'omni_lk_triple'));
  ok('甲：strlen 是未定义的外部符号，留着一笔 BRANCH26',
    back.relocs.some((r) => r.sym === 'strlen' && r.kind === RELOC.BRANCH26));
  ok('甲：串常量的地址是 adrp+add 两笔',
    back.relocs.filter((r) => r.kind === RELOC.PAGE21).length === 1
    && back.relocs.filter((r) => r.kind === RELOC.PAGEOFF12).length === 1);
}

// ---------------------------------------------------------------- 二、并合的账
const merged = linkObjects([readObject(objA), readObject(objB)]);
{
  const aBack = readObject(objA);
  const bBack = readObject(objB);
  ok('并合：代码是两段接起来的（按 4 对齐）',
    merged.text.length === aBack.text.length + bBack.text.length);
  ok('并合：数据是两段接起来的（按 8 对齐）',
    merged.data.length === align8(aBack.data.length) + bBack.data.length);
  const find = (n) => merged.defs.find((d) => d.name === n);
  ok('并合：甲的符号偏移不变', find('omni_lk_triple').off === 0);
  ok('并合：乙的符号往后挪了甲的长度',
    find('omni_lk_main').off === aBack.text.length);
  ok('并合：跨文件的 bl 当场填掉了一笔', merged.filled === 1);
  ok('并合：omni_lk_add3 不再是未定义的符号',
    !merged.relocs.some((r) => r.sym === 'omni_lk_add3'));
  ok('并合：libc 的符号原样转出去',
    merged.relocs.filter((r) => r.sym === 'strlen').length === 2
    && merged.relocs.some((r) => r.sym === 'llabs'));
  ok('并合：adrp/add 那两对也原样转出去（页号要等绝对地址）',
    merged.relocs.filter((r) => r.kind === RELOC.PAGE21).length === 2
    && merged.relocs.filter((r) => r.kind === RELOC.PAGEOFF12).length === 2);
}
/* 同一个名字定义两次要报错 —— `ld` 说 duplicate symbol，我们也说。 */
{
  let threw = false;
  try { linkObjects([readObject(objA), readObject(objA)]); } catch { threw = true; }
  ok('并合：同一个符号定义两次要报错', threw);
}

function align8(n) {
  return n % 8 === 0 ? n : n + (8 - (n % 8));
}

// ---------------------------------------------------------------- 三、真跑
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
if (CLANG === undefined || process.arch !== 'arm64') {
  process.stdout.write(`arm64/link: ${total - failed} 条账对上（没有 clang 或不是 arm64，不跑）\n`);
  process.exit(failed === 0 ? 0 : 1);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-link-'));
try {
  const objPath = join(dir, 'merged.o');
  writeFileSync(objPath, writeObject(merged.text, merged.data, merged.defs, merged.relocs));
  const main = [
    '#include <stdio.h>',
    'extern long long omni_lk_main(long long, long long);',
    'extern long long omni_lk_add3(long long, long long);',
    'extern long long omni_lk_triple(long long, long long);',
    'extern long long omni_lk_len(long long, long long);',
    'extern long long omni_lk_len_b(long long, long long);',
    'int main(void){',
    '  printf("%lld\\n", omni_lk_triple(5, 0));',
    '  printf("%lld\\n", omni_lk_add3(5, 1));',
    '  printf("%lld\\n", omni_lk_main(-5, -1));',
    '  printf("%lld\\n", omni_lk_len(0, 0));',
    '  printf("%lld\\n", omni_lk_len_b(0, 0));',
    '  return 0;',
    '}',
  ].join('\n');
  const mainPath = join(dir, 'main.c');
  writeFileSync(mainPath, `${main}\n`);
  const progPath = join(dir, 'prog');
  execFileSync(CLANG, [mainPath, objPath, '-o', progPath], { stdio: 'pipe' });
  const out = execFileSync(progPath, [], { encoding: 'utf8' }).trim().split('\n');
  /* 期望值：triple(5)=15；add3(5,1)=triple(5)+1=16；main(-5,-1)=llabs(add3(-5,-1))
   * = llabs(-15 + -1) = 16；两个串的长度 7 与 3。 */
  const want = ['15', '16', '16', '7', '3'];
  const what = ['甲内部的乘', '甲内部的调用', '乙跨文件调甲再进 libc', '甲的串', '乙的串'];
  for (let i = 0; i < want.length; i++) ok(`跑：${what[i]}`, out[i] === want[i]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
