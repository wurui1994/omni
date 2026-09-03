// tests/c/sym-order.js —— 符号表里那几条的次序
// （ADR-0017 第九刀第一百二十六片）
//
// tcc 自己不排符号（`tccelf.c:862` 那段注释：「TCC cannot sort it while generating
// the code」），只在写出去之前按绑定分成局部/非局部两段（`sort_syms`），**段里保持
// 建符号的次序**。所以量出来的次序就是源码里被提到的次序 —— 量过 x86_64-linux：
//
//   局部： L.3 L.4 sv helper        非局部： q c p gv main
//
// 我们从前是三堆分开攒的（函数、全局量、串常量），于是变成 `helper sv str…`。
// 这道门比的是**整张符号表的次序**：每条只看「绑定/类型/落在哪一节」，名字只在
// 两边都不是串常量的时候比 —— tcc 叫 `L.N`、我们叫 `omni_str_N`（那是另一片的事），
// osx 上还给符号加下划线。
//
//   node tests/c/sym-order.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-sym-order');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/** tinycc 的源码在哪儿：交叉目录的 `config.mak` 里记着（`-B` 要用它）。 */
function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const SRC = tccSrc();
if (SRC === null) {
  process.stdout.write(`  skip 整组：交叉编译器还没建（${CROSS}）\n`);
  process.exit(0);
}

/**
 * 一个 ELF `.o` 的 `.symtab`：按表里的次序，每条一行文本。
 *
 * 每条是「名字/绑定/类型/节号」。串常量的名字换成 `<str>` —— 两边叫法不同，
 * 这道门不比它（`pre` 是 osx 那个下划线）。
 */
function readSyms(path, pre) {
  const b = readFileSync(path);
  const shoff = Number(b.readBigUInt64LE(0x28));
  const shnum = b.readUInt16LE(0x3c);
  const shstrndx = b.readUInt16LE(0x3e);
  const at = (i) => shoff + i * 64;
  const nameAt = (base, n) => {
    let e = base + n;
    while (b[e] !== 0) e++;
    return b.toString('latin1', base + n, e);
  };
  const shstrOff = Number(b.readBigUInt64LE(at(shstrndx) + 24));
  const secs = [];
  for (let i = 0; i < shnum; i++) {
    secs.push({
      no: i,
      name: nameAt(shstrOff, b.readUInt32LE(at(i))),
      off: Number(b.readBigUInt64LE(at(i) + 24)),
      size: Number(b.readBigUInt64LE(at(i) + 32)),
      info: b.readUInt32LE(at(i) + 44),
    });
  }
  const st = secs.find((s) => s.name === '.symtab');
  const str = secs.find((s) => s.name === '.strtab');
  const rows = [];
  for (let o = st.off; o < st.off + st.size; o += 24) {
    const raw = nameAt(str.off, b.readUInt32LE(o));
    const info = b[o + 4];
    /* 串常量：tcc 的 `L.数字`、我们的 `omni_str_数字`（osx 上都带那个下划线）。 */
    const isStr = /^_?L\.\d+$/.test(raw) || /^_?omni_str_\d+$/.test(raw);
    let name = isStr ? '<str>' : raw;
    /* osx 上符号名前面有一个下划线 —— 比之前先剥掉。 */
    if (!isStr && pre !== '' && name.startsWith(pre)) name = name.slice(pre.length);
    rows.push(`${name}/b${info >> 4}t${info & 15}/s${b.readUInt16LE(o + 6)}`);
  }
  return { rows, locals: st.info };
}

const PROBES = [
  {
    /* 量过的那一格：`const` 指针与它初值里的串、`const int`、非 const 的指针、
     * `static` 全局、`static` 函数、`main` —— 局部与非局部两段都不止一条。 */
    name: '常量、静态量、函数各几条',
    src: 'const char *const q = "S";\nconst int c = 7;\nchar *p = "P";\n'
      + 'static int sv = 1;\nint gv = 2;\n'
      + 'static int helper(int x) { return x + sv; }\n'
      + 'int main(void) { return c + q[0] + p[0] + helper(gv); }\n',
  },
  {
    /* 先用后定义：`later` 的符号是在**调用它的那一行**建的，所以它排在 `main` 后面
     * 那条全局量之前。这一格盯的是「第一次被提到」而不是「第几个被定义」。 */
    name: '先调用后定义的函数',
    src: 'int main(void) { extern int later(void); return later(); }\n'
      + 'int tail = 3;\nint later(void) { return tail; }\n',
  },
  {
    /* 一条串常量也没有、只有函数：两段里各一条，比的是 FILE 与节符号那几格没错位。 */
    name: '只有两个函数',
    src: 'static int a(void) { return 1; }\nint main(void) { return a(); }\n',
  },
];

const CASES = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', pre: '' },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', pre: '' },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', pre: '_' },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const t of CASES) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
    continue;
  }
  const B = t.os === 'win32' ? `-B${join(SRC, 'win32')}` : `-B${SRC}`;
  for (let i = 0; i < PROBES.length; i++) {
    const pr = PROBES[i];
    const tag = `${t.name} / ${pr.name}`;
    const c = join(OUT, `p${i}.c`);
    writeFileSync(c, pr.src);
    const ro = join(OUT, `ref-${t.name}-${i}.o`);
    /* 两边**同一串 argv**（ADR-0018 决策三）：只差一个 `-b` —— tcc 那边是一个目标
     * 一个可执行文件，我们只有一个，得把目标说出来。 */
    const ARGS = [B, '-c', c];
    const r = spawnSync(tcc, [...ARGS, '-o', ro], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad(tag, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const mo = join(OUT, `our-${t.name}-${i}.o`);
    const a = spawnSync(process.execPath,
      [CLI, 'c', 'tcc', '-b', `${t.arch}-${t.os}`, ...ARGS, '-o', mo],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (a.status !== 0) {
      bad(tag, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const want = readSyms(ro, t.pre);
    const got = readSyms(mo, t.pre);

    /* 一、整张表的次序 —— 逐条。 */
    if (want.rows.join(' ') !== got.rows.join(' ')) {
      bad(`${tag} 的符号次序`,
        `    tcc : ${want.rows.join(' ')}\n    ours: ${got.rows.join(' ')}`);
    } else ok(`${tag}：${got.rows.length} 条符号的次序对得上`);

    /* 二、`sh_info`（前面有几条局部的）—— 分段那一刀切在同一处。 */
    if (want.locals !== got.locals) {
      bad(`${tag} 的 .symtab sh_info`, `    tcc : ${want.locals}\n    ours: ${got.locals}`);
    } else ok(`${tag}：sh_info（局部符号 ${got.locals} 条）`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
