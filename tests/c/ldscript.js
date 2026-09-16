#!/usr/bin/env node
/* ld 脚本读得对（`src/core/link/ldscript.js`，照 tcc 的 `tcc_load_ldscript`）。
 *
 * 为什么值得单独一份：`-lc` 在 glibc 上落到的是一份**文本**，
 * `GROUP ( libc.so.6 libc_nonshared.a AS_NEEDED ( ld-linux.so.2 ) )`。这一层错一格，
 * 症状是链接时「找不到 'atexit'」或者装载时「undefined symbol: stdout」——
 * 离病根隔了两层，所以在这儿先钉住。
 *
 * 这台机器上有 `/usr/lib/libc.so` 的话，顺带拿**真的那一份**走一遍（macOS 上没有，
 * 就只跑手写的那几例）。
 *
 *   node tests/c/ldscript.js
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseLdScript } from '../../src/core/link/ldscript.js';

let pass = 0;
let fail = 0;
const eq = (what, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass++; process.stdout.write(`  ok   ${what}\n`); return; }
  fail++;
  process.stdout.write(`  FAIL ${what}\n    got  ${a}\n    want ${b}\n`);
};

/* glibc 那一份的形状（Arch 的容器里量到的原文，路径是绝对的）。 */
eq('GROUP + AS_NEEDED 全收（次序照原文）',
  parseLdScript('OUTPUT_FORMAT(elf64-x86-64)\nGROUP ( /usr/lib/libc.so.6 /usr/lib/libc_nonshared.a  AS_NEEDED ( /usr/lib/ld-linux-x86-64.so.2 ) )\n'),
  ['/usr/lib/libc.so.6', '/usr/lib/libc_nonshared.a', '/usr/lib/ld-linux-x86-64.so.2']);

eq('INPUT 与 GROUP 一样收', parseLdScript('INPUT ( libfoo.so libbar.a )'),
  ['libfoo.so', 'libbar.a']);

eq('`-lfoo` 也是一项（`ld_add_file` 头两个字符那一支）',
  parseLdScript('GROUP ( -lc -lgcc_s )'), ['-lc', '-lgcc_s']);

eq('OUTPUT_FORMAT / TARGET 的括号吃掉、内容不要',
  parseLdScript('TARGET(elf64-x86-64) OUTPUT_FORMAT(elf64-x86-64, elf64-x86-64, elf64-x86-64)\nGROUP ( a.so )'),
  ['a.so']);

eq('注释不算内容', parseLdScript('/* 一句话 */ GROUP ( a.so /* 再一句 */ b.a )'),
  ['a.so', 'b.a']);

/* 不是脚本的那些都要回 `null` —— 调用方靠这一格决定「当二进制读」。 */
eq('ELF 的头不是脚本', parseLdScript('\x7fELF\x02\x01\x01'), null);
eq('`!<arch>` 不是脚本', parseLdScript('!<arch>\n'), null);
eq('空文件不是脚本', parseLdScript(''), null);
eq('认不出的命令回 null（tcc 那儿是报错）', parseLdScript('SECTIONS { . = 0; }'), null);
eq('括号没闭上回 null', parseLdScript('GROUP ( a.so'), null);

/* 这台机器上真有那一份的话，看它至少点到一个 `libc.so.` 开头的东西。 */
if (existsSync('/usr/lib/libc.so')) {
  const names = parseLdScript(readFileSync('/usr/lib/libc.so', 'utf8'));
  const okReal = names !== null && names.some((n) => n.includes('libc.so.'));
  eq('真的 /usr/lib/libc.so 点到了 libc.so.N', okReal, true);
  process.stdout.write(`       （量到的：${JSON.stringify(names)}）\n`);
} else {
  process.stdout.write('  skip 这台机器上没有 /usr/lib/libc.so（macOS 就是这样）\n');
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
