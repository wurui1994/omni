// tests/c/weak-sym.js —— `__attribute__((weak))`：符号的绑定，不是代码
// （ADR-0017 第九刀第一百〇四片）
//
// 以前 `weak` 落在 `parseAttrs` 的「不认识的属性」那一支上：括号平衡掉、什么都不改。
// 编得过，但符号表里那个名字仍旧是**强**定义 —— 两份 `.o` 一链就是 `duplicate symbol`，
// 而 C 库与 tinycc 自己都靠弱定义做「可以被盖掉的默认实现」。
//
// 尺子是 tcc 的目标文件（`tcc -c` 在所有目标上都写 ELF）。称的是两件事：
//
//   1. **符号表的形状**：`nm` 印出来的每一行（地址无关，只比名字与那个字母）必须与 tcc
//      相同。`W` 是弱的函数、`V` 是弱的数据、`T`/`D` 是强的 —— 这个字母就是 ELF 的
//      `st_info` 高四位（STB_WEAK = 2）。
//   2. **链起来能跑**：弱定义在没人盖它的时候就是普通定义，链出来的程序照常算。
//
//   node tests/c/weak-sym.js

import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const OUT = join(tmpdir(), 'omni-weaksym');

/* 三种写法都要认（属性挂在声明上、挂在定义上、挂在类型说明符前头）。 */
const PROBE = 'int wfn(int x) __attribute__((weak));\n'
  + 'int wfn(int x) { return x + 2; }\n'
  + '__attribute__((weak)) int wvar = 9;\n'
  + 'int wvar2 __attribute__((__weak__));\n'
  + 'int strong(int x) { return x + 1; }\n'
  + 'int svar = 7;\n'
  + 'static int hidden = 3;\n'
  + 'int use(void) { return wfn(1) + strong(2) + wvar + svar + hidden + wvar2; }\n';

const MAIN = '#include <stdio.h>\n'
  + 'int wfn(int x);\n'
  + 'int use(void);\n'
  + 'extern int wvar;\n'
  + 'int main(void) { printf("%d %d %d\\n", wfn(1), wvar, use()); return 0; }\n';

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (process.platform !== 'darwin' || !existsSync(TCC)) {
  process.stdout.write(`  skip 整组：尺子不在（${TCC}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const src = join(OUT, 'probe.c');
const mainSrc = join(OUT, 'main.c');
writeFileSync(src, PROBE);
writeFileSync(mainSrc, MAIN);

/** `nm` 的输出削成「名字 字母」，按名字排序 —— 地址与次序不是这一格称的东西。 */
const symLines = (obj) => {
  const r = spawnSync('nm', [obj], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim().split('\n')
    .map((l) => l.trim().split(/\s+/))
    .map((p) => `${p[p.length - 1]} ${p[p.length - 2]}`)
    .sort()
    .join('\n');
};

const refObj = join(OUT, 'ref.o');
const mineObj = join(OUT, 'mine.o');
const rc = spawnSync(TCC, ['-B', TCC_DIR, '-c', src, '-o', refObj], { encoding: 'utf8' });
const mc = spawnSync(process.execPath, [CLI, 'c-obj', src, '--format', 'elf', '-o', mineObj],
  { encoding: 'utf8', maxBuffer: 1 << 26 });

if (rc.status !== 0) {
  bad('尺子 tcc -c', `    ${(rc.stderr ?? '').trim().split('\n')[0]}`);
} else if (mc.status !== 0) {
  bad('我们的 c-obj', `    ${(mc.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  const want = symLines(refObj);
  const got = symLines(mineObj);
  if (want === null || got === null) {
    bad('nm 读不动', '    这台机器上的 nm 认不出 tcc 写的 ELF');
  } else if (want !== got) {
    bad('符号表的绑定与 tcc 相同',
      `    tcc :\n${want.split('\n').map((l) => `      ${l}`).join('\n')}\n`
      + `    ours:\n${got.split('\n').map((l) => `      ${l}`).join('\n')}`);
  } else {
    ok('符号表：弱的是 W/V、强的是 T/D、static 的是 t/d —— 与 tcc 逐行相同');
  }
}

/* 链起来跑一遍：弱定义没人盖的时候就是普通定义。两份 `.o` 都是我们编的，
 * 链接器也是我们的（第一百片起 clang 只当尺子）。 */
const mainObj = join(OUT, 'main.o');
const exe = join(OUT, 'prog');
const co = spawnSync(process.execPath, [CLI, 'c-obj', mainSrc, '--format', 'elf', '-o', mainObj],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
if (co.status !== 0) {
  bad('c-obj main.c', `    ${(co.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  const ln = spawnSync(process.execPath,
    [CLI, 'macho-link', mainObj, mineObj, '-o', exe, '-lc'],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (ln.status !== 0) {
    bad('macho-link', `    ${(ln.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
  } else {
    chmodSync(exe, 0o755);
    spawnSync('codesign', ['-f', '-s', '-', exe], { encoding: 'utf8' });
    const r = spawnSync(exe, [], { encoding: 'utf8' });
    /* wfn(1)=3、wvar=9、use()=3+3+9+7+3+0=25 */
    if (r.stdout !== '3 9 25\n') {
      bad('链起来跑', `    要 "3 9 25"，得 ${JSON.stringify(r.stdout)}（status ${r.status}）`);
    } else {
      ok('弱定义链起来照常算（3 9 25）');
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
