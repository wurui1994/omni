// tests/c/alias-sym.js —— `__attribute__((alias("目标")))`：一个地址，两个名字
// （ADR-0017 第九刀第一百〇五片）
//
// 以前这条声明被当成「外部函数的声明」：没有函数体，于是发一个转发桩 `$ext$别名`。
// 名字错、绑定错（局部）、还多一份代码。tcc 的做法是**把别名当成目标那条符号的副本**发出去
// （`tccgen.c:8972-8983`：同一个节、同一个 value、同一个 size），代码一份、符号两条。
//
// 称三件事：
//   1. **符号表**与 `tcc -c` 逐行相同（名字 + `nm` 那个字母），而且别名与目标**同址**；
//   2. **链起来跑**：同一个单元里调别名、读别名的变量，与调目标是同一件事；
//   3. **该拒的拒**：目标还没定义就用它（前向别名）—— tcc 报
//      `unsupported forward __alias__ attribute`，我们同一句、同一行。
//
//   node tests/c/alias-sym.js

import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const OUT = join(tmpdir(), 'omni-aliassym');

const PROBE = 'int real(int x) { return x + 1; }\n'
  + 'int alias_fn(int x) __attribute__((alias("real")));\n'
  + 'int wk_alias(int x) __attribute__((weak, alias("real")));\n'
  + 'int gvar = 7;\n'
  + 'extern int gvar_alias __attribute__((alias("gvar")));\n'
  + 'int use(void) { return alias_fn(1) + gvar_alias + wk_alias(2); }\n';

const MAIN = '#include <stdio.h>\n'
  + 'int alias_fn(int x);\n'
  + 'int real(int x);\n'
  + 'int use(void);\n'
  + 'extern int gvar_alias;\n'
  + 'int main(void) {\n'
  + '  printf("%d %d %d %d\\n", real(1), alias_fn(1), gvar_alias, use());\n'
  + '  return 0;\n'
  + '}\n';

const FWD = 'int a2(int x) __attribute__((alias("a1")));\n'
  + 'int a1(int x) { return x; }\n';

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
const fwdSrc = join(OUT, 'fwd.c');
writeFileSync(src, PROBE);
writeFileSync(mainSrc, MAIN);
writeFileSync(fwdSrc, FWD);

/** `nm` 的输出：`[名字, 字母, 地址]`，按名字排序。 */
const syms = (obj) => {
  const r = spawnSync('nm', [obj], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim().split('\n')
    .map((l) => l.trim().split(/\s+/))
    .map((p) => ({ name: p[p.length - 1], kind: p[p.length - 2], at: p[0] }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
};
const shape = (ss) => ss.map((s) => `${s.name} ${s.kind}`).join('\n');

const refObj = join(OUT, 'ref.o');
const mineObj = join(OUT, 'mine.o');
/* 两边**同一串 argv**（ADR-0018 决策三）：本机那一支，连 `-b` 都不用给。 */
const ARGS = ['-B', TCC_DIR, '-c', src];
const rc = spawnSync(TCC, [...ARGS, '-o', refObj], { encoding: 'utf8' });
const mc = spawnSync(process.execPath, [CLI, 'c', 'tcc', ...ARGS, '-o', mineObj],
  { encoding: 'utf8', maxBuffer: 1 << 26 });

if (rc.status !== 0) {
  bad('尺子 tcc -c', `    ${(rc.stderr ?? '').trim().split('\n')[0]}`);
} else if (mc.status !== 0) {
  bad('我们的 c tcc -c', `    ${(mc.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  const want = syms(refObj);
  const got = syms(mineObj);
  if (want === null || got === null) {
    bad('nm 读不动', '    这台机器上的 nm 认不出 tcc 写的 ELF');
  } else if (shape(want) !== shape(got)) {
    bad('符号表与 tcc 逐行相同',
      `    tcc :\n${shape(want).split('\n').map((l) => `      ${l}`).join('\n')}\n`
      + `    ours:\n${shape(got).split('\n').map((l) => `      ${l}`).join('\n')}`);
  } else {
    ok('符号表：别名是一条真符号（`_alias_fn T`、`_gvar_alias D`），不是转发桩');
  }
  /* 同址：地址是我们自己排的，与 tcc 的不必相同，但「别名 == 目标」必须成立。 */
  if (got !== null) {
    const at = (n) => (got.find((s) => s.name === n) ?? {}).at;
    const pairs = [['_alias_fn', '_real'], ['_wk_alias', '_real'], ['_gvar_alias', '_gvar']];
    const wrong = pairs.filter(([a, b]) => at(a) === undefined || at(a) !== at(b));
    if (wrong.length > 0) {
      bad('别名与目标同址',
        wrong.map(([a, b]) => `    ${a}@${at(a)} != ${b}@${at(b)}`).join('\n'));
    } else {
      ok('别名与目标同址（函数两条、数据一条，弱的那条也一样）');
    }
  }
}

/* 链起来跑：别名与目标是同一件事。 */
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
    /* real(1)=2、alias_fn(1)=2、gvar_alias=7、use()=2+7+3=12 */
    if (r.stdout !== '2 2 7 12\n') {
      bad('链起来跑', `    要 "2 2 7 12"，得 ${JSON.stringify(r.stdout)}（status ${r.status}）`);
    } else {
      ok('别名调起来与目标同一件事（2 2 7 12）');
    }
  }
}

/* 前向别名：该拒，而且拒得与 tcc 一字不差。 */
const FWD_ARGS = ['-B', TCC_DIR, '-c', fwdSrc];
const rf = spawnSync(TCC, [...FWD_ARGS, '-o', join(OUT, 'fwd-ref.o')],
  { encoding: 'utf8' });
const mf = spawnSync(process.execPath,
  [CLI, 'c', 'tcc', ...FWD_ARGS, '-o', join(OUT, 'fwd-mine.o')],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
const line = (s) => (s ?? '').trim().split('\n')[0].replace(/^.*?fwd\.c/, `${basename(fwdSrc)}`);
if (rf.status === 0 || mf.status === 0) {
  bad('前向别名该拒', `    tcc status ${rf.status}、ours status ${mf.status}`);
} else if (line(rf.stderr) !== line(mf.stderr)) {
  bad('前向别名的报错与 tcc 相同',
    `    tcc : ${line(rf.stderr)}\n    ours: ${line(mf.stderr)}`);
} else {
  ok(`前向别名拒得与 tcc 一样（${line(mf.stderr)}）`);
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
