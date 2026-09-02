#!/usr/bin/env node
/* C -> MIR -> 真机器码，**native 口径**（ADR-0017 第九刀第十九片）。
 *
 * 这一条是把两头接起来的第一条：前端（`lowerCNative`）出的 MIR 里没有线性内存 ——
 * 局部量的帧是一条 `FRAME`，`&x` 是真地址 —— 后端（arm64 / x86_64）把它编成机器码，
 * 写成 `.o`，交给 clang 与一份手写的 `main.c` 链起来，**在真机器上跑**。
 *
 * oracle 是 **clang 自己**：同一份 `.c` 加同一份 `main.c`，一边用我们的后端、一边整份交给
 * clang，两边的 stdout 逐字节比。这比写死期望值强得多 —— 期望值是「C 的语义」，
 * 而 clang 比我手算可靠。
 *
 * 用例都只用**局部量、形参、指针、数组、struct、递归、控制流**：字符串字面量与全局量
 * 还没落到符号上（那是下一片），前端会明着报，本文件末尾有一组用例专门查这件事。
 *
 * 跑法：`node tests/c/native.js`
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lowerCNative } from '../../stage0/src/frontend-c/tccgen.js';
import { verifyMir } from '../../stage0/src/mir/verify.js';
import { genModule as genArm64 } from '../../stage0/src/arm64/from_mir.js';
import { genModule as genX64 } from '../../stage0/src/x64/from_mir.js';
import { writeObject } from '../../stage0/src/link/macho.js';

const HOST = { readFile: () => null, includeDirs: [], dirname: () => '.', join: (a, b) => `${a}/${b}` };

/* 每条用例是一个 `long long probeN(void)`。名字由下标给，于是一份源码里装得下所有用例，
 * 一次前端、一次后端、一次链接 —— clang 跑三次而不是三十次。 */
const CASES = [
  ['局部量与算术', 'long long a = 7, b = 35; return a * b - 5;'],
  ['取地址：写进去要看得见', 'int x = 3; int *p = &x; *p = 42; return x;'],
  ['取形参的地址', 'return helper_addr(17);'],
  ['帧上的数组', 'int a[5]; int i; long long s = 0;'
    + ' for (i = 0; i < 5; i++) a[i] = i * i;'
    + ' for (i = 0; i < 5; i++) s += a[i]; return s;'],
  ['指针走数组', 'int a[4]; int *p = a; a[0] = 1; a[1] = 2; a[2] = 4; a[3] = 8;'
    + ' return p[0] + *(p + 1) + *(p + 2) + p[3];'],
  ['帧上的 struct，地址传给别人', 'struct P q; q.x = 3; q.y = 4; return sq(&q);'],
  ['两块不串味', 'int u = 100, v = 7; swap(&u, &v); return u * 1000 + v;'],
  ['递归：每一层一个帧', 'return fib(20);'],
  ['递归里取地址', 'return depth(6);'],
  ['double 落在帧上', 'double d = 2.5; double *p = &d; *p = *p * 4; return (long long) d;'],
  ['char 数组：自己数长度', 'char s[8]; int i; s[0] = 104; s[1] = 105; s[2] = 33; s[3] = 0;'
    + ' for (i = 0; s[i] != 0; i++) ; return i;'],
  ['switch 与嵌套块', 'int i; long long s = 0;'
    + ' for (i = 0; i < 6; i++) { switch (i) { case 0: case 1: s += 1; break;'
    + ' case 2: { int t = i * 10; s += t; break; } default: s -= i; } } return s;'],
  ['union 在帧上', 'union U u; u.i = 0x41424344; return u.b[0] + u.b[3];'],
  ['二维数组', 'int m[3][3]; int i, j; long long s = 0;'
    + ' for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) m[i][j] = i * 3 + j;'
    + ' for (i = 0; i < 3; i++) s += m[i][i]; return s;'],
  /* 串常量（第二十片）：字节进 __DATA 的一个符号，值是**符号的地址**。 */
  ['串常量：按字节读', 'char *p = "hi!"; return p[0] * 100 + p[2];'],
  ['串常量：末尾有 0', 'char *p = "abcd"; int n = 0; while (p[n] != 0) n++; return n;'],
  ['串常量：sizeof 是数组的大小', 'return sizeof("abcd");'],
  ['串常量：地址交给真的 strlen', 'return (long long) strlen("hello, world");'],
  ['串常量：指针算术', 'char *p = "abcdef"; return *(p + 3) - *p;'],
];

const SUPPORT = `struct P { int x; int y; };
union U { int i; unsigned char b[4]; };
extern unsigned long strlen(const char *);
long long helper_addr(int n) { int *p = &n; *p = *p + 1; return n * 2; }
long long sq(struct P *p) { return (long long) p->x * p->x + (long long) p->y * p->y; }
void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }
long long fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
long long depth(int n) { long long here = n; long long *p = &here;
  if (n == 0) return 0; return *p + depth(n - 1); }
`;

let src = SUPPORT;
for (let i = 0; i < CASES.length; i++) src += `long long probe${i}(void) { ${CASES[i][1]} }\n`;

const mainSrc = ['extern long long probe0(void);'];
for (let i = 1; i < CASES.length; i++) mainSrc.push(`extern long long probe${i}(void);`);
mainSrc.push('extern int printf(const char *, ...);');
mainSrc.push('int main(void) {');
for (let i = 0; i < CASES.length; i++) mainSrc.push(`  printf("%lld\\n", probe${i}());`);
mainSrc.push('  return 0;\n}');
const MAIN = mainSrc.join('\n');

// ---------------------------------------------------------------- 前端
let failed = 0;
let total = 0;
const fail = (what, ours, want) => {
  failed++;
  process.stdout.write(`  FAIL ${what}\n    ours ${ours}\n    want ${want}\n`);
};

const { mod } = lowerCNative('probe.c', src, HOST);
const errs = verifyMir(mod);
if (errs.length > 0) {
  process.stdout.write(`c/native: MIR 不良构：\n  ${errs.join('\n  ')}\n`);
  process.exit(1);
}
/* native 这条腿上**一格线性内存都不该有**。这一条不是形式：只要 `mod.mem` 非空，
 * 就说明有东西又落回偏移上去了，而那种指针在真机器上指向 64K 那个地址。 */
total++;
if (mod.mem !== null) fail('native 的模块没有线性内存', JSON.stringify(mod.mem), 'null');

// ---------------------------------------------------------------- 后端 + 真跑
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
if (CLANG === undefined) {
  process.stdout.write('c/native: 没找到 clang，跳过\n');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-cnative-'));
try {
  const srcPath = join(dir, 'probe.c');
  const mainPath = join(dir, 'main.c');
  writeFileSync(srcPath, src);
  writeFileSync(mainPath, MAIN);

  /* oracle：整份交给 clang（本机架构就够 —— C 的语义与架构无关）。 */
  const oraclePath = join(dir, 'oracle');
  execFileSync(CLANG, [srcPath, mainPath, '-o', oraclePath], { stdio: 'pipe' });
  const want = execFileSync(oraclePath, [], { encoding: 'utf8' }).trim().split('\n');
  if (want.length !== CASES.length) {
    process.stdout.write(`c/native: oracle 印了 ${want.length} 行，用例 ${CASES.length} 条\n`);
    process.exit(1);
  }

  const legs = [{ arch: 'x86_64', gen: genX64, cc: ['-arch', 'x86_64'] }];
  /* arm64 那条腿只在 Apple Silicon 上跑得起来（x86_64 那条靠 Rosetta，反过来没有）。 */
  if (process.arch === 'arm64') legs.unshift({ arch: 'arm64', gen: genArm64, cc: ['-arch', 'arm64'] });

  for (const leg of legs) {
    const blob = leg.gen(mod);
    const defs = [];
    for (let k = 0; k < mod.funcs.length; k++) {
      defs.push({ name: mod.funcs[k].name, off: blob.offsets[k] });
    }
    const objPath = join(dir, `probe-${leg.arch}.o`);
    writeFileSync(objPath, writeObject(blob.bytes, blob.data,
      [...defs, ...blob.dataSyms], blob.relocs, leg.arch));
    const progPath = join(dir, `prog-${leg.arch}`);
    execFileSync(CLANG, [...leg.cc, mainPath, objPath, '-o', progPath], { stdio: 'pipe' });
    const out = execFileSync(progPath, [], { encoding: 'utf8' }).trim().split('\n');
    for (let i = 0; i < CASES.length; i++) {
      total++;
      if (out[i] === want[i]) continue;
      fail(`${leg.arch}：${CASES[i][0]}`, out[i], want[i]);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 边界
/* 还要线性内存的那些东西必须**明着报**。悄悄发出去会得到一个指着 64K 的指针 ——
 * 那种错在解释器上看不出来，在真机器上是段错误，而且现场离原因很远。 */
for (const [what, code] of [
  ['带初值的全局量', 'int g = 7;\nlong long f(void) { return g; }'],
  ['变长数组', 'int n = 4; int a[n]; a[0] = 1; return a[0];'],
  ['非 ASCII 的串常量', 'char *p = "\\xe4\\xb8\\x96"; return p[0];'],
]) {
  total++;
  const body = code.indexOf('\n') >= 0 ? code : `long long f(void) { ${code} }`;
  let threw = false;
  try {
    lowerCNative('bad.c', body, HOST);
  } catch { threw = true; }
  if (!threw) fail(`「${what}」还要线性内存，可是没报错`, '没报', '报');
}

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
if (failed !== 0) process.exitCode = 1;
