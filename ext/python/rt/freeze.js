#!/usr/bin/env node
// ext/python/rt/freeze.js —— **第四把尺子：我们编出来的那份运行时，真跑一趟**
//
//   node ext/python/rt/freeze.js             # 链出 `_freeze_module`、把 frozen 头冻出来
//   node ext/python/rt/freeze.js --oracle    # 再与 clang 编的同一套**逐字节**比
//                                            # （要先跑过 `npm run py:symbols`，它把 clang 的 .o 缓在 sym/）
//
// ## 为什么要有这一份
//
// 前三把尺子最远只到"链得上"（`sweep` 编得出、`symbols` 接口对得上、`link` 摞得起来）。
// 都过了还可能**跑起来错** —— 量过两回：复合字面量没归零、不完整类型的 extern 把别人的
// 初值吃掉，三把尺子一格都看不见，而 CPython 一初始化就 assert。
//
// 被试者挑的是 CPython 自己的 `Programs/_freeze_module.c`：它是构建系统那一步要的工具
// （把一份 `.py` 编成字节码摞成 `.h`），一进门就 `Py_InitializeFromInitConfig`，
// 跑完要 **Parser + compile + ceval + marshal** 全都对。它还顺手把
// `Python/frozen.c` / `Modules/getpath.c` 那两份的输入生成出来 —— 那两份是
// `py:sweep` 分母里最后两份编不出的。
//
// ## 口径
//
//   * `.o` 从 `.omni-cache/py-rt/obj/` 拿（**先跑 `npm run py:sweep`**），缺了就说。
//   * 三份构建系统产物我们自己站着做：`Modules/config.c`（`gen-config.js` 按
//     `config.c.in` 生成）、`Modules/getpath_noop.c`（CPython 给这一步的空实现）、
//     `Programs/_freeze_module.c`（**它自己**定义那五个 frozen 符号 —— 自举环就这么破）。
//   * 冻哪几份、名字与源码路径**照 `Makefile.pre.in` 里那几条规则读**，不写死。
//   * 参考树只读：头一律落 `.omni-cache/py-rt/gen/Python/frozen_modules/`。
//   * 门：那几份头一份都不许少；`--oracle` 时还要与 clang 编的同一套出的**逐字节相同**。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesIn, flagsFor, GENERATED, incDirFor, perFileFlags } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const CLI = join(root, 'src', 'cli.js');
const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? d : argv[i + 1];
};
const SRC = argOf('--src', process.env.OMNI_CPYTHON
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython'));
const WORK = join(root, '.omni-cache', 'py-rt');
const OBJ = join(WORK, 'obj');
const INC = incDirFor(WORK, false);
const OUT = join(WORK, 'freeze');
const GEN = join(WORK, 'gen');
const HDR = join(GEN, 'Python', 'frozen_modules');
const CC = argOf('--cc', process.env.CC ?? 'clang');
const ORACLE = argv.includes('--oracle');
const say = (s) => process.stdout.write(`${s}\n`);

if (!existsSync(join(SRC, 'Include', 'Python.h'))) {
  say(`py-rt/freeze: 参考树不在（${SRC}），跳过`);
  process.exit(0);
}
if (!existsSync(join(INC, 'pyconfig.h'))) {
  say('py-rt/freeze: 还没探过 pyconfig.h —— 先跑一趟 `npm run py:sweep`');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
mkdirSync(HDR, { recursive: true });

/** 那 199 份 `.o` 的路径（口径与三把尺子共用的 `scope.js` 同一张名单）。 */
function ourObjects() {
  const { files } = filesIn(SRC, ['Objects', 'Python', 'Parser', 'Modules'], {});
  const out = [];
  const miss = [];
  for (const [d, f] of files) {
    const name = `${d}/${f}`;
    if (GENERATED.has(name)) continue;
    const o = join(OBJ, `${d}-${f}`.replace(/[/.]/g, '-') + '.o');
    if (existsSync(o)) out.push(o);
    else miss.push(name);
  }
  return { out, miss };
}

/** 用我们自己的 C 前端编一份 `.c`。回 null = 过，回一串 = 那几行诊断。 */
function ourCC(srcFile, objFile, name) {
  const r = spawnSync(process.execPath,
    [CLI, ...flagsFor(objFile, INC, SRC, perFileFlags(name, SRC)), srcFile],
    { encoding: 'utf8' });
  const diag = ((r.stderr ?? '') + (r.stdout ?? '')).split('\n')
    .filter((l) => /error:|warning:/.test(l));
  return r.status === 0 && existsSync(objFile) ? null : (diag.join('\n') || '编不出');
}

/** 同一份 `.c` 交给 clang（`--oracle` 那一路要一份对照）。 */
function ccCC(srcFile, objFile, name) {
  const flags = flagsFor(objFile, INC, SRC, perFileFlags(name, SRC))
    .filter((a) => a !== 'c' && a !== 'obj');
  const r = spawnSync(CC, ['-c', ...flags, srcFile], { encoding: 'utf8' });
  return r.status === 0 && existsSync(objFile) ? null : (r.stderr ?? '编不出');
}

/**
 * **冻哪几份**：照 `Makefile.pre.in` 里那几条规则读（`:1728` 起）——
 *   `\t$(FREEZE_MODULE) <模块名> $(srcdir)/<源码> Python/frozen_modules/<名字>.h`
 * 两种前缀（`FREEZE_MODULE` 与 `FREEZE_MODULE_BOOTSTRAP`）对我们是一回事：
 * 我们手上这一份 `_freeze_module` 本来就是"不带 frozen 表"的那一种。
 */
function frozenList() {
  const mk = readFileSync(join(SRC, 'Makefile.pre.in'), 'utf8');
  const re = /^\t\$\(FREEZE_MODULE(?:_BOOTSTRAP)?\)\s+(\S+)\s+\$\(srcdir\)\/(\S+)\s+Python\/frozen_modules\/(\S+\.h)\s*$/gm;
  const out = [];
  for (const m of mk.matchAll(re)) out.push({ name: m[1], src: m[2], hdr: m[3] });
  if (out.length < 20) {
    throw new Error(`py-rt/freeze: Makefile.pre.in 里只读出 ${out.length} 条冻结规则 —— 那几条规则的形状变了`);
  }
  return out;
}

const t0 = Date.now();
const { out: objs, miss } = ourObjects();
say(`py-rt/freeze: 手上有 ${objs.length} 份 .o`);
if (miss.length > 0) {
  say(`            少 ${miss.length} 份 —— 先跑一趟 \`npm run py:sweep\`：${miss.slice(0, 3).join(' ')}`);
  process.exit(1);
}

/* 三份构建系统产物。`config.c` 现生成（照 `config.c.in`），另两份在参考树里。
   **这一格只用 bootstrap 那张 inittab**：它要的是"冻 frozen 头"，链的是核心那 199 份 `.o`
   —— 给它整份运行时那张名单的话 `config.c` 会引用 76 个 `PyInit_`，而 `Setup.stdlib.in`
   那一族的 `.o` 不在这一趟里，链接缺一大片（试过一次，别再试）。整份运行时那张 inittab
   是第五格判据（`embed.js --runtime`）的事。 */
const CONF = join(GEN, 'config.c');
const g = spawnSync(process.execPath, [join(here, 'gen-config.js'), '--src', SRC, '--out', CONF],
  { encoding: 'utf8' });
if (g.status !== 0) {
  say(`py-rt/freeze: gen-config 没过：\n${g.stderr}${g.stdout}`);
  process.exit(1);
}
const EXTRA = [
  /* `config.c` 的 `.o` 按 `obj/` 的命名规矩落（`Modules-config-c.o`）—— 第三把尺子
   * （`link.js`）就能把它一起摞进去，于是那 7 个"有账的"缺口少一个。 */
  { name: 'Modules/config.c', src: CONF, o: join(OBJ, 'Modules-config-c.o') },
  { name: 'Modules/getpath_noop.c', src: join(SRC, 'Modules', 'getpath_noop.c'), o: join(OUT, 'getpath_noop.o') },
  { name: 'Programs/_freeze_module.c', src: join(SRC, 'Programs', '_freeze_module.c'), o: join(OUT, '_freeze_module.o') },
];
for (const e of EXTRA) {
  const bad = ourCC(e.src, e.o, e.name);
  if (bad !== null) {
    say(`py-rt/freeze: 我们编不出 ${e.name}：\n${bad}`);
    process.exit(1);
  }
}

/** 链一份出来（链接器用 clang —— 那一步不是这把尺子在量的东西）。 */
function link(bin, objects) {
  const r = spawnSync(CC, ['-o', bin, ...objects], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(bin)) {
    say(`py-rt/freeze: 链不起来：\n${(r.stderr ?? '').split('\n').slice(0, 8).join('\n')}`);
    process.exit(1);
  }
  return statSync(bin).size;
}
const BIN = join(OUT, '_freeze_module');
const size = link(BIN, [...objs, ...EXTRA.map((e) => e.o)]);
say(`ld: ${BIN} —— ${(size / 1048576).toFixed(1)}M`);

/* 真跑一趟：把那几十份 `.py` 冻成 `.h`（参考树只读，所以落 .omni-cache）。 */
const list = frozenList();
const bad = [];
for (const it of list) {
  const hdr = join(HDR, it.hdr);
  /* **先删掉上一趟的那一份**：不删的话这一趟崩了也还有一个旧文件躺着，
   * 下面"与 clang 逐字节相同"就会拿旧文件去比、报一片绿。量到过一次（别再犯）。 */
  rmSync(hdr, { force: true });
  const r = spawnSync(BIN, [it.name, join(SRC, it.src), hdr], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(hdr) || statSync(hdr).size === 0) {
    bad.push(`${it.name} —— exit=${r.status} ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`);
  }
}
say(`run: ${list.length - bad.length}/${list.length} 份 frozen 头冻出来了 -> ${HDR}`);
for (const b of bad) say(`  失败 ${b}`);

/* **那两份最后编不出的现在编得出了吗** —— 这才是这一趟的下游收成：
 * `Python/frozen.c` 与 `Modules/getpath.c` 要的就是刚冻出来的那些头
 * （`-I` 由 `scope.js` 的 `perFileFlags` 给，见那儿的注）。 */
const downstream = [];
for (const name of ['Python/frozen.c', 'Modules/getpath.c']) {
  const [d, f] = [name.slice(0, name.indexOf('/')), name.slice(name.indexOf('/') + 1)];
  const o = join(OBJ, `${d}-${f}`.replace(/[/.]/g, '-') + '.o');
  const r = ourCC(join(SRC, d, f), o, name);
  downstream.push({ name, bad: r });
  say(`cc: ${name} —— ${r === null ? '编出来了' : `还编不出\n${r}`}`);
}

/* `--oracle`：clang 编的同一套（`py:symbols` 把它们缓在 `sym/*-cc.o`）出的头，
 * 与我们这一份**逐字节**比。判据强在这儿：不只是"跑起来不崩"，是**编出来的字节码一样**。 */
let diff = null;
if (ORACLE) {
  const SYM = join(WORK, 'sym');
  const ccObjs = objs.map((o) => join(SYM, `${o.split('/').pop().replace(/\.o$/, '')}-cc.o`));
  const lack = ccObjs.filter((o) => !existsSync(o));
  if (lack.length > 0) {
    say(`py-rt/freeze: --oracle 要 clang 那一套 .o（少 ${lack.length} 份）—— 先跑 \`npm run py:symbols\``);
    process.exit(1);
  }
  const ccExtra = EXTRA.map((e) => ({ ...e, o: e.o.replace(/\.o$/, '-cc.o') }));
  for (const e of ccExtra) {
    const r = ccCC(e.src, e.o, e.name);
    if (r !== null) {
      say(`py-rt/freeze: clang 编不出 ${e.name}（oracle 那一侧）：\n${r}`);
      process.exit(1);
    }
  }
  const ccBin = join(OUT, '_freeze_module-cc');
  link(ccBin, [...ccObjs, ...ccExtra.map((e) => e.o)]);
  const ccHdr = join(OUT, 'hdr-cc');
  mkdirSync(ccHdr, { recursive: true });
  let same = 0;
  const off = [];
  for (const it of list) {
    const a = join(HDR, it.hdr);
    const b = join(ccHdr, it.hdr);
    rmSync(b, { force: true });
    const r = spawnSync(ccBin, [it.name, join(SRC, it.src), b], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(b) || !existsSync(a)) { off.push(`${it.name}（oracle 那侧没出来）`); continue; }
    if (readFileSync(a).equals(readFileSync(b))) same += 1;
    else off.push(it.name);
  }
  diff = off;
  say(`oracle: ${same}/${list.length} 份与 clang 编的同一套**逐字节相同**`);
  for (const o of off) say(`  不同 ${o}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const ok = bad.length === 0 && downstream.every((d) => d.bad === null)
  && (diff === null || diff.length === 0);
say('');
say(`门：${list.length} 份 frozen 头 + 那两份下游${ORACLE ? ' + 与 clang 逐字节相同' : ''}`
  + ` —— ${ok ? '过' : '没过'}（${secs}s）`);
process.exit(ok ? 0 : 1);



