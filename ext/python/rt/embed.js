#!/usr/bin/env node
// ext/python/rt/embed.js —— **第五格判据：借来的那份运行时，被我们自己编出来的代码当库调**
//
//   node ext/python/rt/embed.js        # 编 embed-probe.c、与那 202 份 .o 链、跑、与 python3 比
//
// ## 与第四把尺子（`freeze.js`）的分工
//
// `freeze.js` 量的是**别人写的 main**（CPython 自己的 `Programs/_freeze_module.c`）跑得对；
// 这一格量的是**我们要走的那条路**：语言层将来发出来的代码就是"建对象、调方法、取回串"，
// 所以先拿一份手写的 C 把那条路走通 —— `.py` → 我们的 IR → C 之后，发的就是这样的调用。
// 这一格立住之后，剩下的是 adapter 怎么发（SPEC §二 第 0 刀 (c)）。
//
// ## 口径
//
//   * `.o` 从 `.omni-cache/py-rt/obj/` 拿（先跑 `npm run py:sweep` 与 `npm run py:freeze`
//     —— 后者会把 `Modules/config.c` / `Python/frozen.c` / `Modules/getpath.c` 那三份补上）。
//   * 探针那一份**必须过我们自己的 C 前端**（这才是这一格的被试者）；链接器用 clang。
//   * 期望值不写死：同一句话交给本机 python3，**逐字节相同**才算过。
//   * 没有参考树 / 没 clang / 没 python3 / `.o` 不齐 —— 说清并跳过（exit 0），不假装绿。
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const OUT = join(WORK, 'embed');
const CC = argOf('--cc', process.env.CC ?? 'clang');
const say = (s) => process.stdout.write(`${s}\n`);
const skip = (why) => { say(`py-rt/embed: ${why} —— 跳过`); process.exit(0); };

if (!existsSync(join(SRC, 'Include', 'Python.h'))) skip(`参考树不在（${SRC}）`);
if (!existsSync(join(INC, 'pyconfig.h'))) skip('还没探过 pyconfig.h（先 `npm run py:sweep`）');
if (spawnSync(CC, ['--version'], { encoding: 'utf8' }).status !== 0) skip(`本机没有 ${CC}`);
if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 python3');

/**
 * 那批 `.o`（口径与四把尺子共用的 `scope.js` 同一张名单）。`GENERATED` 那三份
 * （`Modules/config.c` / `Python/frozen.c` / `Modules/getpath.c`）的 `.o` 与树上的文件同名，
 * 所以这一圈已经把它们收进来了 —— 它们是第四把尺子那一趟落下的，少了就说"先跑 py:freeze"。
 */
function ourObjects() {
  const { files } = filesIn(SRC, ['Objects', 'Python', 'Parser', 'Modules'], {});
  const out = [];
  const miss = [];
  for (const [d, f] of files) {
    const name = `${d}/${f}`;
    const o = join(OBJ, `${d}-${f}`.replace(/[/.]/g, '-') + '.o');
    if (existsSync(o)) out.push(o);
    else miss.push(GENERATED.has(name) ? `${name}（生成的那份）` : name);
  }
  /* `Modules/config.c` 树上没有（它是 `config.c.in` 生成的），所以名单里不会有它 ——
   * 那份 `.o` 是第四把尺子（`freeze.js`）落在 `obj/` 里的，`_PyImport_Inittab` 就在里头。 */
  const conf = join(OBJ, 'Modules-config-c.o');
  if (existsSync(conf)) out.push(conf);
  else miss.push('Modules/config.c（生成的那份）');
  return { out, miss };
}

const t0 = Date.now();
const { out: objs, miss } = ourObjects();
if (miss.length > 0) {
  say(`py-rt/embed: 少 ${miss.length} 份 .o：${miss.slice(0, 3).join('，')}`);
  say('            先跑 `npm run py:sweep`，再跑 `npm run py:freeze`');
  process.exit(1);
}
say(`py-rt/embed: 手上有 ${objs.length} 份 .o`);

/* 1) 探针那一份过**我们自己的 C 前端**（标准库的路径用 `-D` 给，见 embed-probe.c 的注）。 */
mkdirSync(OUT, { recursive: true });
const PROBE = join(here, 'embed-probe.c');
const POBJ = join(OUT, 'embed-probe.o');
const flags = flagsFor(POBJ, INC, SRC, [...perFileFlags('Programs/_freeze_module.c', SRC),
  `-DPY_LIB_DIR="${join(SRC, 'Lib')}"`]);
const cc = spawnSync(process.execPath, [CLI, ...flags, PROBE], { encoding: 'utf8' });
if (cc.status !== 0 || !existsSync(POBJ)) {
  const diag = ((cc.stderr ?? '') + (cc.stdout ?? '')).split('\n')
    .filter((l) => /error:/.test(l)).slice(0, 6).join('\n');
  say(`py-rt/embed: 我们编不出探针：\n${diag || '编不出'}`);
  process.exit(1);
}
say('cc: embed-probe.c —— 我们自己编出来的');

/* 2) 链（链接器用 clang —— 这一格量的不是链接器）。 */
const BIN = join(OUT, 'embed-probe');
const ld = spawnSync(CC, ['-o', BIN, POBJ, ...objs], { encoding: 'utf8' });
if (ld.status !== 0 || !existsSync(BIN)) {
  say(`py-rt/embed: 链不起来：\n${(ld.stderr ?? '').split('\n').slice(0, 8).join('\n')}`);
  process.exit(1);
}
say(`ld: ${BIN} —— ${(statSync(BIN).size / 1048576).toFixed(1)}M`);

/* 3) 跑，与本机 python3 的同一句话比（期望值不写死）。 */
const got = spawnSync(BIN, [], { encoding: 'utf8' });
const want = spawnSync('python3', ['-c',
  "print('42'.zfill(5))\nprint('42'.center(7, '*'))\nprint(7 ** 80)\nprint(repr(0.1 + 0.2))\n"],
{ encoding: 'utf8' });
const gs = (got.stdout ?? '').trimEnd().split('\n');
const ws = (want.stdout ?? '').trimEnd().split('\n');
const WHAT = ['str.zfill（unicodeobject.c）', 'str.center（unicodeobject.c）',
  '7**80（longobject.c —— 我们自己的 int 是 64 位，只能是它在答）', 'repr(0.1+0.2)（dtoa.c）'];
let bad = got.status === 0 ? 0 : 1;
if (got.status !== 0) say(`run: 跑不起来（exit=${got.status}）：${(got.stderr ?? got.stdout ?? '').trim().split('\n')[0]}`);
for (let i = 0; i < ws.length; i += 1) {
  if (gs[i] === ws[i]) { say(`ok: ${WHAT[i]} -> ${ws[i]}`); continue; }
  bad += 1;
  say(`不同: ${WHAT[i]}\n      我们：${gs[i]}\n      py  ：${ws[i]}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
say('');
say(`门一：${ws.length} 格与本机 python3 逐字节相同 —— ${bad === 0 ? '过' : '没过'}（${secs}s）`);
say(`账：产物 ${(statSync(BIN).size / 1048576).toFixed(1)}M（`
  + `这一问的初始化还要读磁盘上的 Lib —— 下面那一问就是堵这个缺口的）`);

/* ---- 第二问：**产物自带标准库**（`encodings` 冻进来、搜索路径留空、不读磁盘） ---- */

/** 冻一格：用第四把尺子那一趟链出来的 `_freeze_module`（**我们自己编的那份**）。 */
function freeze(name, rel, hdr) {
  rmSync(hdr, { force: true });   /* 不删就会拿上一趟的头比，报一片绿（量到过） */
  const r = spawnSync(FREEZER, [name, join(SRC, 'Lib', rel), hdr], { encoding: 'utf8' });
  return r.status === 0 && existsSync(hdr) && statSync(hdr).size > 0
    ? null : `${name}：exit=${r.status} ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`;
}

const FREEZER = join(WORK, 'freeze', '_freeze_module');
const FZ = join(OUT, 'fz');
let bad2 = 0;
if (!existsSync(FREEZER)) {
  say(`门二：跳过（${FREEZER} 不在 —— 先跑 \`npm run py:freeze\`）`);
} else {
  mkdirSync(FZ, { recursive: true });
  const MODS = [
    ['encodings', 'encodings/__init__.py', 'encodings.h'],
    ['encodings.aliases', 'encodings/aliases.py', 'encodings.aliases.h'],
    ['encodings.utf_8', 'encodings/utf_8.py', 'encodings.utf_8.h'],
    ['encodings.ascii', 'encodings/ascii.py', 'encodings.ascii.h'],
    ['encodings.latin_1', 'encodings/latin_1.py', 'encodings.latin_1.h'],
  ];
  for (const [name, rel, hdr] of MODS) {
    const why = freeze(name, rel, join(FZ, hdr));
    if (why !== null) { say(`py-rt/embed: 冻不出来 ${why}`); bad2 += 1; }
  }
  const P2 = join(here, 'embed-frozen-probe.c');
  const O2 = join(OUT, 'embed-frozen-probe.o');
  const B2 = join(OUT, 'embed-frozen-probe');
  if (bad2 === 0) {
    const cc2 = spawnSync(process.execPath, [CLI,
      ...flagsFor(O2, INC, SRC, [...perFileFlags('Programs/_freeze_module.c', SRC), '-I', FZ]),
      P2], { encoding: 'utf8' });
    if (cc2.status !== 0 || !existsSync(O2)) {
      const diag = ((cc2.stderr ?? '') + (cc2.stdout ?? '')).split('\n')
        .filter((l) => /error:/.test(l)).slice(0, 6).join('\n');
      say(`py-rt/embed: 我们编不出自带标准库那一份：\n${diag || '编不出'}`);
      bad2 += 1;
    }
  }
  if (bad2 === 0) {
    const ld2 = spawnSync(CC, ['-o', B2, O2, ...objs], { encoding: 'utf8' });
    if (ld2.status !== 0 || !existsSync(B2)) {
      say(`py-rt/embed: 自带标准库那一份链不起来：\n${(ld2.stderr ?? '').split('\n').slice(0, 6).join('\n')}`);
      bad2 += 1;
    }
  }
  if (bad2 === 0) {
    /* `cwd` 特意换到 `/`：**万一**它还在偷偷读磁盘上的标准库，这一格会把它照出来。 */
    const g2 = spawnSync(B2, [], { encoding: 'utf8', cwd: '/' });
    const w2 = spawnSync('python3', ['-c', "print('42'.zfill(5))\nprint(7 ** 80)\n"],
      { encoding: 'utf8' });
    const a = (g2.stdout ?? '').trimEnd();
    const b = (w2.stdout ?? '').trimEnd();
    if (g2.status !== 0 || a !== b) {
      bad2 += 1;
      say(`门二：没过（exit=${g2.status}）\n      我们：${JSON.stringify(a.slice(0, 200))}`
        + `\n      py  ：${JSON.stringify(b)}`);
    } else {
      say(`门二：**产物自带标准库** —— 搜索路径留空（cwd 换到 /），`
        + `不靠磁盘上的 Lib，答案与 python3 相同（产物 ${(statSync(B2).size / 1048576).toFixed(1)}M）`);
    }
  }
}

/* ---- 门三：**产品那条路** —— `omni build` 一份方言，`(lib …)` 摞上借来的那份 `.a` ----
 *
 * 前两问的链接命令是这份脚本自己拼的；这一问走的是**语言层真正要走的那条路**：
 *   一份 `.sx`（adapter 将来发的就是这个形状）→ `omni build` → 产物里带着借来的运行时。
 * 方言那三格早就有（`(lib …)` / `(cabi …)` / `(ccall …)`，`sexpr/lower.js`），
 * 这一问量的是它们与借来的那份 `.a` 接得上。
 *
 * 一处口径要讲清：`OMNI_CC=clang`。我们自己那台链接器（`macho_exe.js`）吃的是
 * **ELF 那种 `.o`**（tcc 的老路：内部表示是 ELF，输出才是 Mach-O），而 `obj/` 里那 202 份
 * 是 Mach-O 的 `.o` —— 所以自带链接器这一路要先有"借来的那些 `.c` 编成 ELF `.o`"那一刀。
 * 这一格是真缺口，记在 SPEC 里，不在这儿假装。
 */
let bad3 = 0;
if (!existsSync(FREEZER)) {
  say('门三：跳过（要先 `npm run py:freeze`）');
} else {
  const A = join(OUT, 'libomnipython.a');
  const bootO = join(OUT, 'embed-boot.o');
  const bootBad = spawnSync(process.execPath, [CLI,
    ...flagsFor(bootO, INC, SRC, perFileFlags('Programs/_freeze_module.c', SRC)),
    join(here, 'embed-boot.c')], { encoding: 'utf8' });
  if (bootBad.status !== 0 || !existsSync(bootO)) {
    say(`py-rt/embed: 我们编不出那层薄皮（embed-boot.c）：\n${(bootBad.stderr ?? '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join('\n')}`);
    bad3 += 1;
  } else {
    rmSync(A, { force: true });
    const ar = spawnSync('ar', ['rcs', A, ...objs, bootO], { encoding: 'utf8' });
    if (ar.status !== 0) { say(`py-rt/embed: ar 打不出 ${A}：\n${ar.stderr}`); bad3 += 1; }
  }
  const SX = join(OUT, 'probe.sx');
  const EXE = join(OUT, 'probe');
  if (bad3 === 0) {
    /* 这一份**自己一句都不印** —— 印的全是借来的运行时（`print`），于是可以与
     * python3 的同一句话逐字节比（我们的 `print` 与 CPython 的 stdout 是两个缓冲区，
     * 混在一起次序就不定了）。 */
    writeFileSync(SX, `;; 生成的（ext/python/rt/embed.js 门三）—— adapter 将来发的就是这个形状
(module
  (lib "${A}")
  (cabi omni_py_boot i32 (ptr))
  (cabi PyRun_SimpleString i32 (ptr))
  (cabi omni_py_fini i32 ())

  (main
    (let rc int (ccall omni_py_boot (str "${join(SRC, 'Lib')}")))
    (expr (ccall PyRun_SimpleString (str "print('42'.zfill(5)); print(7**80); print(repr(0.1+0.2))")))
    (expr (ccall omni_py_fini))))
`);
    const b = spawnSync(process.execPath, [CLI, 'build', SX, '-o', EXE],
      { encoding: 'utf8', cwd: root, env: { ...process.env, OMNI_CC: CC } });
    if (b.status !== 0 || !existsSync(EXE)) {
      say(`py-rt/embed: omni build 没过：\n${((b.stderr ?? '') + (b.stdout ?? '')).split('\n').slice(-6).join('\n')}`);
      bad3 += 1;
    }
  }
  if (bad3 === 0) {
    const g3 = spawnSync(EXE, [], { encoding: 'utf8', cwd: root });
    const w3 = spawnSync('python3', ['-c',
      "print('42'.zfill(5)); print(7**80); print(repr(0.1+0.2))"], { encoding: 'utf8' });
    const a3 = (g3.stdout ?? '').trimEnd();
    const b3 = (w3.stdout ?? '').trimEnd();
    if (g3.status !== 0 || a3 !== b3) {
      bad3 += 1;
      say(`门三：没过（exit=${g3.status}）\n      我们：${JSON.stringify(a3.slice(0, 200))}`
        + `\n      py  ：${JSON.stringify(b3)}`);
    } else {
      say(`门三：**\`omni build\` 出来的产物调借来的运行时** —— 三行与 python3 逐字节相同`
        + `（${(statSync(EXE).size / 1048576).toFixed(1)}M；方言那三格 (lib)/(cabi)/(ccall)）`);
    }
  }
}

say('');
const allOk = bad === 0 && bad2 === 0 && bad3 === 0;
say(`门：三问都过才算过 —— ${allOk ? '过' : '没过'}`
  + `（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
process.exit(allOk ? 0 : 1);
