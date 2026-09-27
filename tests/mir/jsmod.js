#!/usr/bin/env node
// Omni — JS 路径：**一个 .c 一个 .js**，地址在装载期才定（ADR-0047）
//
// 烤死地址的那一版只在"整个程序一份 MIR"时成立：data 段从 64K 起，取址就是一条
// `65552n`。一份 .c 一份 .js 之后，谁落在哪儿是**装载期**才知道的 —— 于是 module 档
// 里每个模块顶层一句 `memAlloc(span, 16)` 占好自己那一段，代码里的地址变成
// `基址 + 偏移`（`emit_js.js` 的 `moduleBase`）。
//
// 这一份判的是那件事**真的成立**：同一份 C 发两版，
//   * 烤死版（今天的路）直接 `node` 跑 —— 它是判据；
//   * module 版先 `import` 一个只占内存的"垫片"模块（冒充另一份 .c 的 data 段），
//     于是基址被推开，stdout 与退出码必须与判据**逐字节相同**。
// 最后两格是**反面**：把 `mem.data[].relocs` 抹掉、把 `addrConsts` 抹掉，答案必须变
// —— 否则这道门判不出"记录漏了"，那它就没有判据的资格。
//
//   node tests/mir/jsmod.js

import { writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { workDir } from '../work.js';
import { lowerC } from '../../src/core/frontend-c/tccgen.js';
import { emitMirJs } from '../../src/core/mir/emit_js.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RT = join(ROOT, 'src', 'core', 'mir', 'js_rt.js');
const dir = workDir('mir-jsmod');
const host = { arch: 'arm64', os: 'osx', includeDirs: [], sysIncludeDirs: [] };

let pass = 0;
let fail = 0;
const failures = [];
const ok = (m) => { pass += 1; process.stdout.write(`  ok   ${m}\n`); };
const bad = (label, detail) => {
  fail += 1;
  failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

const build = (name, src, tu) => {
  const path = join(dir, `${name}.c`);
  writeFileSync(path, src);
  return lowerC(path, src, host, [], [], tu === true ? { tu: true } : undefined).mod;
};

/**
 * 跑一个 .mjs，回「退出码 + stdout + stderr 第一行」—— 三项一起比。
 *
 * stdout **落到文件**而不是管子：被 `import` 进来的模块里调 `process.exit()`，
 * node 会把还挂在管子上的那几笔写丢掉（直接跑同一份文件反而不丢）。那是宿主的
 * 收摊次序，不是这条腿的事 —— 落文件两边都不丢，判据才可比。
 */
function run(file, tag) {
  const outFile = join(dir, `${tag}.out`);
  const fd = openSync(outFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', fd, 'pipe'] });
  } finally {
    closeSync(fd);
  }
  const err = (r.stderr || '').split('\n')[0];
  const out = readFileSync(outFile, 'utf8');
  return `code=${r.status} out=${JSON.stringify(out)}${err === '' ? '' : ` err=${err}`}`;
}

/**
 * 写一份文件并跑它。module 档发出来的模块**自己不退出**（它 `export { $run }`），
 * 所以这儿再写一个入口文件：先 `import` 一个只占内存的"垫片"（冒充另一份 .c 的
 * data 段，把基址推开 `padBytes` 字节），再调 `$run()` 退出。
 */
function emitRun(name, mir, modular, padBytes) {
  const text = emitMirJs(mir, { rtImport: RT, module: modular });
  const modFile = join(dir, `${name}.mjs`);
  writeFileSync(modFile, text);
  if (!modular) return run(modFile, name);
  const pad = join(dir, `${name}.pad.mjs`);
  writeFileSync(pad, `import { RT } from ${JSON.stringify(RT)};\nRT.memAlloc(${padBytes}, 16);\n`);
  const drv = join(dir, `${name}.drv.mjs`);
  writeFileSync(drv, `import ${JSON.stringify(pad)};\n`
    + `import { $run } from ${JSON.stringify(modFile)};\nprocess.exit($run());\n`);
  return run(drv, name);
}

/* 不写 `#include`：这条轴要判的是**地址**，libc 靠名字连（CCALL），
   手写几条原型比拖一整套头文件进来干净。 */
const P = 'int printf(const char*, ...);\n';
const cases = [
  {
    name: 'str-ptr',
    src: `${P}static const char *s = "hi";\n`
      + 'int main(void){ printf("%s|%d\\n", s, (int)s[1]); return (int)s[0]; }\n',
  },
  {
    name: 'addr-of-static',
    src: `${P}static int arr[4] = {1,2,3,4};\nstatic int *p = &arr[2];\n`
      + 'int main(void){ printf("%d %d\\n", *p, arr[0]); return *p + arr[0]; }\n',
  },
  {
    name: 'in-struct',
    src: `${P}static struct { const char *a; int n; } g = { "xy", 7 };\n`
      + 'int main(void){ printf("%s/%d\\n", g.a, g.n); return g.n + (int)g.a[1]; }\n',
  },
  {
    /* 范围指定初始化器：那几格指针是**复制**出来的（`pendingPtr` 跟着复制那一处）。 */
    name: 'range-designator',
    src: `${P}static const char *g[4] = {[0 ... 1] = "BB"};\n`
      + 'int main(void){ printf("%s%s\\n", g[0], g[1]); return (int)g[1][1]; }\n',
  },
  {
    /* 堆：`malloc` 的基址也在这张像里（`tccgen` 按 dataOff 一路排到栈顶之上），
       所以整块搬完之后 `malloc` 回的地址必须还落在自己那一段里。 */
    name: 'heap',
    src: `${P}void *malloc(unsigned long);\nvoid free(void*);\nchar *strcpy(char*, const char*);\n`
      + 'unsigned long strlen(const char*);\n'
      + 'int main(void){ char *b = malloc(32); strcpy(b, "heap");\n'
      + '  printf("%s%d\\n", b, (int)strlen(b));\n'
      + '  int *v = malloc(4 * sizeof(int)); for (int i = 0; i < 4; i++) v[i] = i * i;\n'
      + '  printf("%d%d%d%d\\n", v[0], v[1], v[2], v[3]); free(b); return v[3]; }\n',
  },
  {
    /* 影子栈：取局部量的地址、传进别的函数。栈顶那条常量也得跟着搬。 */
    name: 'stack-addr',
    src: `${P}static void bump(int *p, int n){ for (int i = 0; i < n; i++) p[i] += i; }\n`
      + 'int main(void){ int a[5] = {10,20,30,40,50}; bump(a, 5);\n'
      + '  for (int i = 0; i < 5; i++) printf("%d,", a[i]); printf("\\n"); return a[4] % 100; }\n',
  },
  {
    /* `strerror` 那块缓冲也在像里（`strerrAddr`）—— 顺手判一格。 */
    name: 'strerror-buf',
    src: `${P}char *strerror(int);\n`
      + 'int main(void){ printf("%s\\n", strerror(2)); return 7; }\n',
  },
];

/* 推开多少：一格页对齐、一格故意不对齐（`memAlloc` 的 align 16 要把它抬上去）。 */
const PADS = [3 * 65536, 100];

for (const c of cases) {
  let baked;
  try {
    baked = emitRun(`${c.name}-baked`, build(c.name, c.src), false);
  } catch (e) {
    bad(`jsmod/${c.name}`, `    烤死版就编不出来：${e.message}`);
    continue;
  }
  let allSame = true;
  for (const pad of PADS) {
    let got;
    try {
      got = emitRun(`${c.name}-mod${pad}`, build(c.name, c.src), true, pad);
    } catch (e) {
      got = `发不出来：${e.message}`;
    }
    if (got !== baked) {
      allSame = false;
      bad(`jsmod/${c.name} [推开 ${pad}]`, `    烤死版 ${baked}\n    module 版 ${got}`);
    }
  }
  if (allSame) ok(`jsmod/${c.name} [烤死版与推开的 module 版同一个 ${baked}]`);
}

/* ---- 反面两格：记录漏了必须红 ------------------------------------------------ */
{
  const src = cases[0].src;
  const baked = emitRun('neg-baked', build('neg', src), false);
  const noRel = build('neg', src);
  for (const seg of noRel.mem.data) delete seg.relocs;
  let got;
  try {
    got = emitRun('neg-norel', noRel, true, 3 * 65536);
  } catch (e) {
    got = `发不出来：${e.message}`;
  }
  const name = 'jsmod/反面：抹掉 relocs 就必须不一样';
  if (got === baked) bad(name, `    抹掉 relocs 居然还是 ${baked} —— 这道门判不出记录漏了`);
  else ok(`${name} [抹掉之后是 ${got}]`);

  const noAddr = build('neg', src);
  noAddr.addrConsts.clear();
  let got2;
  try {
    got2 = emitRun('neg-noaddr', noAddr, true, 3 * 65536);
  } catch (e) {
    got2 = `发不出来：${e.message}`;
  }
  const n2 = 'jsmod/反面：抹掉 addrConsts 就必须不一样';
  if (got2 === baked) bad(n2, `    抹掉 addrConsts 居然还是 ${baked} —— 地址常量那一半没在判`);
  else ok(`${n2} [抹掉之后是 ${got2}]`);
}

/* ---- 两份 .c 两份 .js：符号靠 import/export 接上 ---------------------------- */
/**
 * 一份"程序"由 N 份 .c 组成时，每份单独编一份 MIR、单独发一份 .js：
 *   * 谁提供哪个符号由**定义方**说（函数看 `f.thunk === null && !f.local`，
 *     数据看 `mod.dataSyms`）；
 *   * 引用方那边发成 `import`（函数是桩那一格、数据是 `mod.dataRefs` 那几条常量）；
 *   * 于是依赖关系就是 ESM 的依赖图 —— node 与浏览器自己排装载次序。
 */
function linkRun(name, units) {
  const mods = units.map((u) => ({
    name: u.name,
    file: join(dir, `${name}-${u.name}.mjs`),
    mir: build(`${name}-${u.name}`, u.src, true),
  }));
  /* 符号表：名字 -> 提供它的那份模块的路径。这一步就是"链接"。 */
  const provide = new Map();
  for (const m of mods) {
    for (const f of m.mir.funcs) {
      if (f.local === true || (f.thunk !== null && f.thunk !== undefined)) continue;
      if (!provide.has(f.name)) provide.set(f.name, m.file);
    }
    for (const [sym] of m.mir.dataSyms) if (!provide.has(sym)) provide.set(sym, m.file);
  }
  let entry = null;
  for (const m of mods) {
    /* 自己提供的那些不算"外部" —— 不然 `main` 会 import 自己。 */
    const syms = new Map();
    for (const [sym, file] of provide) if (file !== m.file) syms.set(sym, file);
    writeFileSync(m.file, emitMirJs(m.mir, { rtImport: RT, module: true, symbols: syms }));
    m.lib = !m.mir.funcIndex.has('main');
    if (!m.lib) entry = m;
  }
  if (entry === null) return '没有 main';
  const drv = join(dir, `${name}.drv.mjs`);
  /* 每份库先 `$init()`（它的"序"：`$sp` 的初值那几格），再跑有 `main` 那一份的 `$run()`。
     data 段不在这儿铺 —— 那是**装载期**的事（`import` 一到就铺好了）。 */
  const lines = [];
  let n = 0;
  for (const m of mods) {
    if (m.lib) lines.push(`import { $init as $i${n++} } from ${JSON.stringify(m.file)};`);
  }
  lines.push(`import { $run } from ${JSON.stringify(entry.file)};`);
  for (let k = 0; k < n; k++) lines.push(`$i${k}();`);
  lines.push('process.exit($run());');
  writeFileSync(drv, lines.join('\n') + '\n');
  return run(drv, name);
}

const twoUnits = [
  {
    name: 'call-across',
    units: [
      { name: 'a', src: `${P}int add(int, int);\nint main(void){ int r = add(2, 3); printf("a:%d\\n", r); return r; }\n` },
      { name: 'b', src: 'int add(int x, int y){ return x + y; }\n' },
    ],
    want: 'code=5 out="a:5\\n"',
  },
  {
    name: 'extern-var',
    units: [
      { name: 'a', src: `${P}extern int base;\nextern int arr[4];\nint main(void){ printf("%d %d %d\\n", base, arr[0], arr[3]); return base + arr[3]; }\n` },
      { name: 'b', src: 'int base = 7;\nint arr[4] = {10,20,30,40};\n' },
    ],
    want: 'code=47 out="7 10 40\\n"',
  },
  {
    /* `&arr[2]` 会在常量折叠里变成"基址 + 8"的**另一条**常量 —— 那一条也得记进
       `dataRefs`，不然它还指着本模块预留的那块空白（静默答错）。 */
    name: 'extern-inner-addr',
    units: [
      { name: 'a', src: `${P}extern int arr[4];\nint *p = &arr[2];\nint main(void){ printf("%d %d\\n", *p, arr[2]); return *p; }\n` },
      { name: 'b', src: 'int arr[4] = {10,20,30,40};\n' },
    ],
    want: 'code=30 out="30 30\\n"',
  },
  {
    /* 两份模块各有一个同名 `static` —— 文件局部，互不相干（不导出、不改名）。 */
    name: 'same-static',
    units: [
      { name: 'a', src: `${P}int bval(void);\nstatic int hid = 1;\nint main(void){ printf("%d %d\\n", hid, bval()); return hid + bval(); }\n` },
      { name: 'b', src: 'static int hid = 40;\nint bval(void){ return hid; }\n' },
    ],
    want: 'code=41 out="1 40\\n"',
  },
  {
    /* 三份：a 调 b，b 调 c，c 用自己的字符串（三份的 data 段各占一块，谁也别踩谁）。 */
    name: 'three-units',
    units: [
      { name: 'a', src: `${P}const char *cname(void);\nint bnum(void);\nint main(void){ printf("%s/%d\\n", cname(), bnum()); return bnum(); }\n` },
      { name: 'b', src: 'int cnum(void);\nint bnum(void){ return cnum() + 1; }\n' },
      { name: 'c', src: 'int cnum(void){ return 41; }\nconst char *cname(void){ return "cee"; }\n' },
    ],
    want: 'code=42 out="cee/42\\n"',
  },
  {
    /* **按值收发 struct 的跨模块调用**（ADR-0047 第十四格）：`tu` 档里这种外部函数
       不再发桩（桩转不了手给宿主），而是"没有身子、等链接" —— 调用点照旧按我们自己的
       ABI 发 CALL。R 的 `ALTCOMPLEX_ELT`（返回 `Rcomplex`）就是这一类，量出来 13 份
       `.c` 卡在这儿。 */
    name: 'struct-byval-across',
    units: [
      { name: 'a', src: `${P}typedef struct { double r; double i; } Cpx;\nCpx cmul(Cpx, Cpx);\n`
        + 'int main(void){ Cpx x = {1.5, 2.0}, y = {0.5, -1.0};\n'
        + '  Cpx z = cmul(x, y); printf("%g %g\\n", z.r, z.i); return (int)(z.r * 2); }\n' },
      { name: 'b', src: 'typedef struct { double r; double i; } Cpx;\n'
        + 'Cpx cmul(Cpx a, Cpx b){ Cpx r; r.r = a.r*b.r - a.i*b.i; r.i = a.r*b.i + a.i*b.r; return r; }\n' },
    ],
    want: 'code=5 out="2.75 -0.5\\n"',
  },
];

for (const t of twoUnits) {
  let got;
  try {
    got = linkRun(t.name, t.units);
  } catch (e) {
    got = `发不出来：${e.message}`;
  }
  if (got !== t.want) bad(`jsmod/多份/${t.name}`, `    要 ${t.want}\n    得 ${got}`);
  else ok(`jsmod/多份/${t.name} [${got}]`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
