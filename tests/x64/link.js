/* x86_64 的读入与并合（第九刀第十七片）。
 *
 * 与 `tests/arm64/link.js` 同一套三段验法：往返、并合的账、真跑。差别在**填哪一格**上：
 * x86_64 的 `call` 是四字节相对偏移、从**下一条指令**算起，而 arm64 的 `bl` 是 26 位、
 * 单位 4 字节、从**本条**算起。两边都只填「同一节内的相对跳转」，取数据地址的那几种
 * 一律转出去（理由见 `link.js` 头上那段）。
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MirModule, MirFunc, OP, REF_NONE, T_I64 } from '../../src/core/mir/ir.js';
import { genModule } from '../../src/core/x64/from_mir.js';
import { writeObject } from '../../src/core/link/macho.js';
import { readObject, linkObjects } from '../../src/core/link/link.js';
import { RELOC } from '../../src/core/x64/asm.js';

let failed = 0;
let total = 0;
function ok(what, cond) {
  total++;
  if (cond) return;
  failed++;
  process.stdout.write(`  FAIL ${what}\n`);
}

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

function objOf(mod) {
  const blob = genModule(mod);
  const defs = [];
  for (let k = 0; k < mod.funcs.length; k++) {
    defs.push({ name: mod.funcs[k].name, off: blob.offsets[k] });
  }
  return writeObject(blob.bytes, blob.data, [...defs, ...blob.dataSyms], blob.relocs,
    'x86_64', blob.dataAlign, { rodata: blob.rodata, bssSize: blob.bssSize });
}

/* ---- 甲：被调的那一边（内部调用一条、串常量一条）。 */
const modA = new MirModule('a');
{
  const triple = fn(modA, 'omni_xl_triple', (f, xs) =>
    ret(f, f.emit(OP.MUL, T_I64, ld(f, xs), modA.consts.int(3n), 0)));
  const tno = modA.funcs.indexOf(triple);
  fn(modA, 'omni_xl_add3', (f, xs, ys) => {
    const v = f.emit(OP.CALL, T_I64, tno, f.pushArgs([ld(f, xs)]), 0);
    ret(f, f.emit(OP.ADD, T_I64, v, ld(f, ys), 0));
  });
  fn(modA, 'omni_xl_len', (f) =>
    ret(f, f.emit(OP.CCALL, T_I64, modA.cabiNo('strlen'),
      f.pushArgs([modA.consts.str('abcdefg')]), 0)));
}

/* ---- 乙：跨文件调甲，再进 libc。 */
const modB = new MirModule('b');
{
  fn(modB, 'omni_xl_main', (f, xs, ys) => {
    const s = f.emit(OP.CCALL, T_I64, modB.cabiNo('omni_xl_add3'),
      f.pushArgs([ld(f, xs), ld(f, ys)]), 0);
    ret(f, f.emit(OP.CCALL, T_I64, modB.cabiNo('llabs'), f.pushArgs([s]), 0));
  });
  fn(modB, 'omni_xl_len_b', (f) =>
    ret(f, f.emit(OP.CCALL, T_I64, modB.cabiNo('strlen'),
      f.pushArgs([modB.consts.str('hij')]), 0)));
}

const objA = objOf(modA);
const objB = objOf(modB);

// ---- 一、往返
for (const [what, obj] of [['甲', objA], ['乙', objB]]) {
  const back = readObject(obj);
  ok(`${what}：读回来认得出是 x86_64`, back.arch === 'x86_64');
  const again = writeObject(back.text, back.data, back.defs, back.relocs, 'x86_64');
  ok(`${what}：读回来再写出去，字节不变`,
    again.length === obj.length && again.every((v, i) => v === obj[i]));
}
{
  const back = readObject(objA);
  /* 模块内的调用**也留一笔重定位**（第九刀第一百二十七片起，与 arm64 那一份同一条）。
   * 量过尺子：tcc 哪怕被调的就在同一个 `.o` 里也发那一条。 */
  ok('甲：内部调用也留一笔 BRANCH（与 tcc 同：同一个 .o 里也走符号）',
    back.relocs.some((r) => r.sym === 'omni_xl_triple' && r.kind === RELOC.BRANCH));
  ok('甲：strlen 留着一笔 BRANCH',
    back.relocs.some((r) => r.sym === 'strlen' && r.kind === RELOC.BRANCH));
  ok('甲：串常量的地址是一笔 SIGNED（x86 一条 lea 就够，不像 arm64 要两条）',
    back.relocs.filter((r) => r.kind === RELOC.SIGNED).length === 1);
}

// ---- 二、并合的账
const merged = linkObjects([readObject(objA), readObject(objB)]);
{
  const aBack = readObject(objA);
  const bBack = readObject(objB);
  ok('并合：架构跟着走', merged.arch === 'x86_64');
  ok('并合：代码是两段接起来的', merged.text.length === aBack.text.length + bBack.text.length);
  const find = (n) => merged.defs.find((d) => d.name === n);
  ok('并合：甲的符号偏移不变', find('omni_xl_triple').off === 0);
  ok('并合：乙的符号往后挪了甲的长度', find('omni_xl_main').off === aBack.text.length);
  /* 填掉的是**两笔**：甲自己那笔内部的 `call` 与乙跨文件调甲那一笔 ——
   * 「同一个 .o 里」与「跨文件」在这一层同一条路。 */
  ok('并合：内部与跨文件的 call 一共填掉两笔', merged.filled === 2);
  ok('并合：omni_xl_add3 不再是未定义的符号',
    !merged.relocs.some((r) => r.sym === 'omni_xl_add3'));
  ok('并合：libc 的符号原样转出去',
    merged.relocs.filter((r) => r.sym === 'strlen').length === 2
    && merged.relocs.some((r) => r.sym === 'llabs'));
  ok('并合：取数据地址的那两笔也原样转出去',
    merged.relocs.filter((r) => r.kind === RELOC.SIGNED).length === 2);
}
{
  let threw = false;
  try { linkObjects([readObject(objA), readObject(objA)]); } catch { threw = true; }
  ok('并合：同一个符号定义两次要报错', threw);
}

// ---- 三、真跑
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
if (CLANG === undefined) {
  process.stdout.write(`x64/link: ${total - failed} 条账对上（没有 clang，不跑）\n`);
  process.exit(failed === 0 ? 0 : 1);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-x64link-'));
try {
  const objPath = join(dir, 'merged.o');
  writeFileSync(objPath, writeObject(merged.text, merged.data, merged.defs, merged.relocs,
    'x86_64'));
  const main = [
    '#include <stdio.h>',
    'extern long long omni_xl_triple(long long, long long);',
    'extern long long omni_xl_add3(long long, long long);',
    'extern long long omni_xl_main(long long, long long);',
    'extern long long omni_xl_len(long long, long long);',
    'extern long long omni_xl_len_b(long long, long long);',
    'int main(void){',
    '  printf("%lld\\n", omni_xl_triple(5, 0));',
    '  printf("%lld\\n", omni_xl_add3(5, 1));',
    '  printf("%lld\\n", omni_xl_main(-5, -1));',
    '  printf("%lld\\n", omni_xl_len(0, 0));',
    '  printf("%lld\\n", omni_xl_len_b(0, 0));',
    '  return 0;',
    '}',
  ].join('\n');
  const mainPath = join(dir, 'main.c');
  writeFileSync(mainPath, `${main}\n`);
  const progPath = join(dir, 'prog');
  execFileSync(CLANG, ['-arch', 'x86_64', mainPath, objPath, '-o', progPath], { stdio: 'pipe' });
  const out = execFileSync(progPath, [], { encoding: 'utf8' }).trim().split('\n');
  const want = ['15', '16', '16', '7', '3'];
  const what = ['甲内部的乘', '甲内部的调用', '乙跨文件调甲再进 libc', '甲的串', '乙的串'];
  for (let i = 0; i < want.length; i++) ok(`跑：${what[i]}`, out[i] === want[i]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
