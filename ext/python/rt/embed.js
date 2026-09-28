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
import { existsSync, mkdirSync, statSync } from 'node:fs';
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
say(`门：${ws.length} 格与本机 python3 逐字节相同 —— ${bad === 0 ? '过' : '没过'}（${secs}s）`);
/* 顺手记一笔"整份运行时进产物"的账：产物多大、进门多久（`.o` 全进去了，标准库还在磁盘上）。 */
if (bad === 0) {
  say(`账：产物 ${(statSync(BIN).size / 1048576).toFixed(1)}M；`
    + `标准库仍在磁盘上（初始化要 encodings）—— 要去掉它得把那几份 .py 也冻进来`);
}
process.exit(bad === 0 ? 0 : 1);
