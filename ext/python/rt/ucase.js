#!/usr/bin/env node
// ext/python/rt/ucase.js —— **第六格判据：只借 unicode 的表，大小写映射与 python3 相同**
//
//   node ext/python/rt/ucase.js            # 编、链、跑、与本机 python3 比
//
// ## 为什么单开一格
//
// `.upper()` / `.lower()` / `.casefold()` / `.title()` 在非 ASCII 上要 unicode 的**表**
// （SPEC §一 第 28 条：那一族现在报"还没接"）。这一份量的是**借法**：
// 只借 `Objects/unicodectype.c`（那几个 `_PyUnicode_To*Full` / `_PyUnicode_Is*` 是纯函数，
// 查 `unicodetype_db.h` 那张表），**不借整份运行时** —— 不用 Py_Initialize，也不用 21M 产物。
// UTF-8 的解与编那一半是我们自己的（"串怎么表示"的算术）。
//
// 读数（这台机器）：那张表编出来的 `.o` **178KB**（ELF），链完只欠 libc 的 `printf` / `strlen`；
// 表与探针**两份都过我们自己的 C 前端、由我们自己的链接器链** —— 不必先 `py:sweep`
// 把 201 份预热出来，也**不要外部 cc**；要的只是参考树里那两份文件
// （`Objects/unicodectype.c` + `unicodetype_db.h`）与一份 python3 当 oracle。
//
// ## 三门
//
// 一、**原生腿**：语料里每个词的四个映射（upper / lower / casefold / title）与 python3 逐字节相同。
// 二、**JS 腿**：同一份借来的 C 过我们的 C 前端 -> MIR -> JS（`c run-js`），同样逐字节相同。
// 三、**方言层**：`(lib 那份 .a)` + `(cabi)` + `(pnew)` + `(ccall)` 自己调它，全自己一条链。
// 没有参考树 / python3 / 没探过 `pyconfig.h` 就说清并跳过（不假装绿）。
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive } from '../../../src/core/link/ar.js';
import { readObject } from '../../../src/core/link/elf.js';
import { readSymbols } from '../../../src/core/link/pe_load.js';
import { flagsFor, incDirFor, perFileFlags } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const CLI = join(root, 'src', 'cli.js');
const SRC = process.env.OMNI_CPYTHON ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython');
const WORK = join(root, '.omni-cache', 'py-rt');
const OUT = join(WORK, 'ucase');
const INC = incDirFor(WORK, false);
const say = (s) => process.stdout.write(`${s}\n`);
const skip = (why) => { say(`py-rt/ucase: ${why} —— 跳过`); process.exit(0); };

if (!existsSync(join(SRC, 'Objects', 'unicodectype.c'))) skip(`参考树不在（${SRC}）`);
if (!existsSync(join(INC, 'pyconfig.h'))) skip('还没探过 pyconfig.h（先 `npm run py:sweep`）');
if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 python3');

/* 编一份 `.o`：过**我们自己的 C 前端**，一格外部编译器都不用。
   `--format elf` 是给**我们自己的链接器**用的（tcc 的老路：内部表示 ELF、输出才是 Mach-O）。 */
const ourCC = (src, obj, rel) => spawnSync(process.execPath, [CLI,
  ...flagsFor(obj, INC, SRC, [...perFileFlags(rel, SRC), '--format', 'elf']), src],
{ encoding: 'utf8' });
const diagOf = (r) => ((r.stderr ?? '') + (r.stdout ?? '')).split('\n')
  .filter((l) => /error:/.test(l)).slice(0, 6).join('\n');

/* 一、两份都过**我们自己那台 C 前端**：探针是我们写的，表是借来的（一格没改）。 */
const t0 = Date.now();
mkdirSync(OUT, { recursive: true });
const OBJ = join(OUT, 'ucase-probe.o');
const cc = ourCC(join(here, 'ucase-probe.c'), OBJ, 'Programs/_freeze_module.c');
if (cc.status !== 0 || !existsSync(OBJ)) {
  say(`py-rt/ucase: 我们编不出探针：\n${diagOf(cc) || '编不出'}`);
  process.exit(1);
}
const TABLE = join(OUT, 'unicodectype.o');
const tb = ourCC(join(SRC, 'Objects', 'unicodectype.c'), TABLE, 'Objects/unicodectype.c');
if (tb.status !== 0 || !existsSync(TABLE)) {
  say(`py-rt/ucase: 我们编不出借来的那份表：\n${diagOf(tb) || '编不出'}`);
  process.exit(1);
}

/* 二、只与**那一份**借来的 `.o` 链（链得上就说明那几个函数真是纯的），
   链的是**我们自己的链接器**（`c link`，`--stdlib` 带 libc）—— 一个外部工具都不用。 */
const BIN = join(OUT, 'ucase-probe');
const ld = spawnSync(process.execPath, [CLI, 'c', 'link', OBJ, TABLE, '-o', BIN, '--stdlib', '-q'],
  { encoding: 'utf8' });
if (ld.status !== 0 || !existsSync(BIN)) {
  say(`py-rt/ucase: 链不起来（说明那一份不是纯的，还牵着别的符号）：\n${((ld.stderr ?? '') + (ld.stdout ?? '')).split('\n').slice(0, 8).join('\n')}`);
  process.exit(1);
}
chmodSync(BIN, 0o755);
say(`cc: 探针与借来的那份表**都过我们自己的 C 前端**`
  + `（表的 .o ${(statSync(TABLE).size / 1024).toFixed(0)}KB）；ld: 只这两份`
  + `（产物 ${(statSync(BIN).size / 1024).toFixed(0)}KB）`);

/* 三、语料。每一格后面注的是"它照出哪一条规矩"。 */
const WORDS = [
  'abc', 'Hello World', 'ABC123',              // ASCII 那一档（别弄坏）
  'äöü', 'ÄÖÜ', 'Ünïcödé',                     // 一对一的映射
  'Straße', 'STRASSE',                         // ß -> SS（长度变了）
  'İstanbul', 'ｉ',                             // 带点的 I（一个码点变两个）
  'ǅungla', 'Ǆ', 'ǆ',                          // 三档大小写（title 与 upper 不同）
  'ﬁn', 'ﬄ',                                   // 合字：casefold 会拆开
  'ΣΣΣ', 'ΌΣΟΣ', 'Σ', 'ΑΣ.', 'Σ1Σ',            // 希腊文尾位 sigma（上下文相关）
  'ЖЖЖ', 'Ёлка',                               // 西里尔
  'ﬅ', 'ǰ', 'ΐ',                               // 一个码点变好几个
  '中文字符串', '🐍a', '',                        // 没有大小写之分的、星际面、空串
];


/* 四、两边各跑一趟，逐字节比。 */
const pyOut = () => spawnSync('python3', ['-c',
  'import sys\n'
  + 'for w in sys.argv[1:]:\n'
  + '    print("|".join([w.upper(), w.lower(), w.casefold(), w.title()]))\n', ...WORDS],
{ encoding: 'utf8' }).stdout ?? '';
const WANT = pyOut().split('\n');

/** 一条腿的读数与 python3 比，回"几个词不同"。 */
const compare = (out) => {
  const gs = out.split('\n');
  let n = 0;
  for (let i = 0; i < WORDS.length; i += 1) {
    if (gs[i] === WANT[i]) continue;
    n += 1;
    if (n <= 6) say(`  不同 ${JSON.stringify(WORDS[i])}\n       我们：${gs[i]}\n       py  ：${WANT[i]}`);
  }
  return n;
};

const got = spawnSync(BIN, WORDS, { encoding: 'utf8' });
if (got.status !== 0) { say(`py-rt/ucase: 探针跑不起来（exit=${got.status}）`); process.exit(1); }
let bad = compare(got.stdout ?? '');
say(`门一（原生腿）：${WORDS.length} 个词 × 4 个映射（upper/lower/casefold/title）与本机 python3`
  + ` —— ${bad === 0 ? '逐字节相同' : `${bad} 个不同`}`);

/* 四之二、**整张表**过一遍：0..0x10FFFF（跳开代理区）每个码点的四个映射。
 *
 * 28 个词照的是"那几条规矩"，这一门照的是"那张表一格都没错"。
 * 但两侧的 **Unicode 版本未必一样**（量到：参考树是 CPython 3.16.0a0 / Unicode 18，
 * 本机 python3 是 3.14.7 / Unicode 16）—— 新版加的大小写对，老 python3 上是"没有映射"。
 * 所以这一门**不是比摘要**，而是：按 256 格一块比摘要找出有差异的块，再在块里逐码点比，
 * **每一条差异都必须是"python3 那侧回原样、我们这侧给出了映射"**（= 新版加的那种）。
 * 反方向（我们没映射而 python3 有）才是真 bug。 */
const BLK = 256;
const ourBlocks = (spawnSync(BIN, ['--blocks'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n');
const pyBlocks = (spawnSync('python3', ['-c',
  'M = 0xFFFFFFFF\n'
  + 'out = []\n'
  + `for base in range(0, 0x110000, ${BLK}):\n`
  + '    h = 2166136261\n'
  + `    for cp in range(base, base + ${BLK}):\n`
  + '        if 0xD800 <= cp <= 0xDFFF: continue\n'
  + '        c = chr(cp)\n'
  + '        for s in (c.upper(), c.lower(), c.casefold(), c.title()):\n'
  + '            for b in s.encode():\n'
  + '                h = ((h ^ b) * 16777619) & M\n'
  + '            h = ((h ^ 0x7C) * 16777619) & M\n'
  + '    out.append(f"{base} {h}")\n'
  + 'print("\\n".join(out))\n'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n');
const hotBlocks = [];
for (let i = 0; i < Math.max(ourBlocks.length, pyBlocks.length); i += 1) {
  if (ourBlocks[i] !== pyBlocks[i]) hotBlocks.push(i * BLK);
}
let newerOnly = 0;
let realDiff = 0;
for (const base of hotBlocks) {
  const cps = [];
  for (let cp = base; cp < base + BLK; cp += 1) {
    if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF)) continue;   // NUL 当不了 argv
    cps.push(cp);
  }
  const ws = cps.map((c) => String.fromCodePoint(c));
  const g = (spawnSync(BIN, ws, { encoding: 'utf8' }).stdout ?? '').split('\n');
  const p = (spawnSync('python3', ['-c',
    'import sys\n'
    + 'for w in sys.argv[1:]:\n'
    + '    print("|".join([w.upper(), w.lower(), w.casefold(), w.title()]))\n', ...ws],
  { encoding: 'utf8' }).stdout ?? '').split('\n');
  for (let k = 0; k < cps.length; k += 1) {
    if (g[k] === p[k]) continue;
    /* python3 那侧四格全是原字符 = 它这一版**没有**这格的映射。 */
    if (p[k] === [ws[k], ws[k], ws[k], ws[k]].join('|')) { newerOnly += 1; continue; }
    realDiff += 1;
    if (realDiff <= 6) {
      say(`  真差异 U+${cps[k].toString(16).toUpperCase().padStart(4, '0')}`
        + `  我们 ${JSON.stringify(g[k])}  py ${JSON.stringify(p[k])}`);
    }
  }
}
bad += realDiff;
const uni = (spawnSync('python3', ['-c', 'import unicodedata; print(unicodedata.unidata_version)'],
  { encoding: 'utf8' }).stdout ?? '').trim();
say(`门一之二（整张表 1112064 个码点 × 4 个映射）：${realDiff === 0 ? '没有真差异' : `${realDiff} 格真差异`}`
  + `（${hotBlocks.length} 个块对不上、${newerOnly} 格是**借来的表比本机 python3 新**`
  + `${uni === '' ? '' : ` —— 本机 Unicode ${uni}`}）`);

/* 五、**JS 那条腿**：同一份借来的 C 过我们的 C 前端 -> MIR -> JS（`c run-js`）。
 *
 * 一份翻译单元（那条路上没有链接器），所以走 `ucase-js-probe.c`（把表 include 进来）。
 * 那张表里有个 2348 格的 switch，降下来是 2350 层嵌套 —— `emit_js` 现在对这种函数
 * **改走平铺发法**（`for(;;) switch ($pc)`，`FLAT_AT`），所以这一门**不再要 `--stack-size`**
 * （从前不加就是 V8 解析期爆栈，账在 SPEC 第 30 条）。 */
const jsArgs = flagsFor(OBJ, INC, SRC, perFileFlags('Objects/unicodectype.c', SRC)).slice(2, -2);
const js = spawnSync(process.execPath, [CLI, 'c', 'run-js',
  ...jsArgs, '-I', SRC, join(here, 'ucase-js-probe.c'), '--', ...WORDS], { encoding: 'utf8' });
if (js.status !== 0) {
  say(`py-rt/ucase: JS 那条腿跑不起来（exit=${js.status}）：\n${(js.stderr ?? '').split('\n').slice(0, 6).join('\n')}`);
  process.exit(1);
}
const jsBad = compare(js.stdout ?? '');
bad += jsBad;
say(`门二（JS 腿：同一份 C -> MIR -> JS）：${jsBad === 0 ? '逐字节相同' : `${jsBad} 个不同`}`);

/* 六、**方言层调得通吗**：`(lib 那份 .a)` + `(cabi)` + `(pnew)` + `(ccall)`。
 *
 * 这一门量的是"语言层怎么用那张表"那一刀的前提 —— 不是我们自己写的 C 去调它，
 * 而是**方言写的程序**去调它，而且**一个外部工具都不用**：借来的表过我们的 C 前端
 * 出 ELF `.o`、我们自己的 `writeArchive` 打成 `.a`、我们自己的链接器按需取用。
 * 三格要照顾：
 *   * 出参缓冲走 `(pnew (ptr int) N)`（方言里**没有** `(addr 局部量)`）；
 *   * 方言的 `int` 是 8 字节、没有 u32 —— 一格装两个 `Py_UCS4`，自己拆（小端）；
 *   * 裸 `.o` 自带链接器不收（位置实参得是 `.o`/`.a`，`--dylib` 那一路按后缀分派），
 *     所以先打成 `.a` —— 成员是我们自己发的 ELF，`syms` 由 `.symtab` 说。
 */
const LIB = join(OUT, 'libucase.a');
{
  /* 那份表的 `.o` 已经是 ELF（门一要它，自带链接器吃的就是 ELF）。
     打成 `.a` 才进得去：`c link` 对 `--dylib` 的参数按后缀分派，`.a` 走按需取用。
     `syms` 由 `.symtab` 说 —— 没有符号索引，按需取用就取不出成员。 */
  const buf = readFileSync(TABLE);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const syms = readSymbols(readObject(bytes))
    .filter((s) => s.name !== '' && s.bind === 1 && s.shndx !== 0).map((s) => s.name);
  const ar = writeArchive([{ name: 'unicodectype.o', bytes, syms }]);
  writeFileSync(LIB, ar);
  const back = readArchive(ar);
  if (back.index === null || back.index.syms.length === 0) {
    say('py-rt/ucase: 我们打的那份 .a 没有符号索引（按需取用就取不出成员）');
    process.exit(1);
  }
}
const CPS = [65, 223, 912, 0x3A3, 20013];         // A / ß / ΐ / Σ / 中
const sx = [
  '(module',
  `  (lib ${JSON.stringify(LIB)})`,
  '  (cabi _PyUnicode_ToUpperFull i32 (i32 ptr))',
  '  (fn lo32 ((w int)) int (ret (bin "&" (var w) (int 4294967295))))',
  '  (fn hi32 ((w int)) int (ret (bin "u>>" (var w) (int 32))))',
  '  (main',
  ...CPS.flatMap((cp, k) => [
    /* 一格码点一块新的缓冲（`pnew` 是零初始化的）—— `ToUpperFull` 只写它回的那 n 格，
       共用一块的话剩下的格子里是上一次的残留，那是它的语义，不是 bug。 */
    `    (let out${k} (ptr int) (pnew (ptr int) (int 2)))`,
    `    (let n${k} int (ccall _PyUnicode_ToUpperFull (int ${cp}) (var out${k})))`,
    `    (let a${k} int (pload (var out${k})))`,
    `    (let b${k} int (pload (padd (var out${k}) (int 1))))`,
    `    (print (var n${k}))`,
    `    (print (call lo32 (var a${k})))`,
    `    (print (call hi32 (var a${k})))`,
    `    (print (call lo32 (var b${k})))`,
  ]),
  '    ))',
].join('\n');
const SX = join(OUT, 'ucase-probe.sx');
writeFileSync(SX, `${sx}\n`);
/* `OMNI_CC` 要空着 —— 有它就走外部 cc，那这一门就不是"全自己一条链"了。 */
const sxEnv = { ...process.env };
delete sxEnv.OMNI_CC;
const sxRun = spawnSync(process.execPath, [CLI, 'run-c', SX], { encoding: 'utf8', env: sxEnv });
/* 期望值是 python3 算的：`chr(cp).upper()` 的码点，补到 3 格（ToUpperFull 只写 n 格，
   剩下的是 `pnew` 给的零）。 */
const sxWant = spawnSync('python3', ['-c',
  'import sys\n'
  + 'for a in sys.argv[1:]:\n'
  + '    cs = [ord(c) for c in chr(int(a)).upper()]\n'
  + '    print("\\n".join(str(x) for x in [len(cs)] + (cs + [0, 0, 0])[:3]))\n',
  ...CPS.map(String)], { encoding: 'utf8' });
const sxBad = (sxRun.stdout ?? '').trim() === (sxWant.stdout ?? '').trim() ? 0 : 1;
if (sxBad !== 0) {
  say(`  方言那一门不同：\n    我们：${JSON.stringify((sxRun.stdout ?? '').trim())}`
    + `\n    py  ：${JSON.stringify((sxWant.stdout ?? '').trim())}`
    + `${sxRun.status === 0 ? '' : `\n    （exit=${sxRun.status}）${(sxRun.stderr ?? '').split('\n').slice(0, 4).join('\n')}`}`);
}
bad += sxBad;
say(`门三（方言调它，全自己一条链：我们的 C 前端 -> ELF .o -> 我们的 ar -> 我们的链接器，`
  + `${CPS.length} 个码点的 upper）：${sxBad === 0 ? '与 python3 相同' : '不同'}`);

say('');
say(`三门都过 = 借来的那张表在原生腿、JS 腿、**方言层**上都与 python3 相同`
  + `（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
if (bad === 0) {
  say('账：只借了 Objects/unicodectype.c（纯函数 + 那张表），**没借运行时** ——'
    + ' 不用 Py_Initialize，产物里多的就是那张表。');
}
process.exit(bad === 0 ? 0 : 1);
