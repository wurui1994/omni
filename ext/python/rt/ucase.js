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
// 读数（这台机器）：那张表编出来的 `.o` **175KB**，链完只欠 libc 的 `printf` / `strlen`；
// 表与探针**两份都过我们自己的 C 前端** —— 不必先 `py:sweep` 把 201 份预热出来，
// 要的只是参考树里那两份文件（`Objects/unicodectype.c` + `unicodetype_db.h`）。
//
// ## 门
//
// 语料里每一个词的四个映射（upper / lower / casefold / title）与本机 python3 **逐字节相同**。
// 没有参考树 / clang（链接那一步）/ python3 / 没探过 `pyconfig.h` 就说清并跳过（不假装绿）。
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagsFor, incDirFor, perFileFlags } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const CLI = join(root, 'src', 'cli.js');
const SRC = process.env.OMNI_CPYTHON ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython');
const WORK = join(root, '.omni-cache', 'py-rt');
const OUT = join(WORK, 'ucase');
const INC = incDirFor(WORK, false);
const CC = process.env.CC ?? 'clang';
const say = (s) => process.stdout.write(`${s}\n`);
const skip = (why) => { say(`py-rt/ucase: ${why} —— 跳过`); process.exit(0); };

if (!existsSync(join(SRC, 'Objects', 'unicodectype.c'))) skip(`参考树不在（${SRC}）`);
if (!existsSync(join(INC, 'pyconfig.h'))) skip('还没探过 pyconfig.h（先 `npm run py:sweep`）');
if (spawnSync(CC, ['--version'], { encoding: 'utf8' }).status !== 0) skip(`本机没有 ${CC}`);
if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 python3');

/* 编一份 `.o`：过**我们自己的 C 前端**，一格外部编译器都不用。 */
const ourCC = (src, obj, rel) => spawnSync(process.execPath, [CLI,
  ...flagsFor(obj, INC, SRC, perFileFlags(rel, SRC)), src], { encoding: 'utf8' });
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

/* 二、只与**那一份**借来的 `.o` 链（链得上就说明那几个函数真是纯的）。 */
const BIN = join(OUT, 'ucase-probe');
const ld = spawnSync(CC, ['-o', BIN, OBJ, TABLE], { encoding: 'utf8' });
if (ld.status !== 0 || !existsSync(BIN)) {
  say(`py-rt/ucase: 链不起来（说明那一份不是纯的，还牵着别的符号）：\n${(ld.stderr ?? '').split('\n').slice(0, 8).join('\n')}`);
  process.exit(1);
}
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

/* 五、**JS 那条腿**：同一份借来的 C 过我们的 C 前端 -> MIR -> JS（`c run-js`）。
 *
 * 一份翻译单元（那条路上没有链接器），所以走 `ucase-js-probe.c`（把表 include 进来）。
 * `--stack-size`：那张表里有个几千格的 switch，发出来是**几千层嵌套**的标号块，
 * V8 **解析**时按嵌套深度递归 —— 默认栈不够（记在 SPEC 第 29 条，是 emit_js 的真缺口）。
 */
const jsArgs = flagsFor(OBJ, INC, SRC, perFileFlags('Objects/unicodectype.c', SRC)).slice(2, -2);
const js = spawnSync(process.execPath, ['--stack-size=4000', CLI, 'c', 'run-js',
  ...jsArgs, '-I', SRC, join(here, 'ucase-js-probe.c'), '--', ...WORDS], { encoding: 'utf8' });
if (js.status !== 0) {
  say(`py-rt/ucase: JS 那条腿跑不起来（exit=${js.status}）：\n${(js.stderr ?? '').split('\n').slice(0, 6).join('\n')}`);
  process.exit(1);
}
const jsBad = compare(js.stdout ?? '');
bad += jsBad;
say(`门二（JS 腿：同一份 C -> MIR -> JS）：${jsBad === 0 ? '逐字节相同' : `${jsBad} 个不同`}`);

say('');
say(`两门都过 = 借来的那张表在**两条腿上**都与 python3 相同（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
if (bad === 0) {
  say('账：只借了 Objects/unicodectype.c（纯函数 + 那张表），**没借运行时** ——'
    + ' 不用 Py_Initialize，产物里多的就是那张表。');
}
process.exit(bad === 0 ? 0 : 1);
