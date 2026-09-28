#!/usr/bin/env node
// ext/python/rt/selflink.js —— **全自己那条链**：借来的运行时进产物，一个外部工具都不用
//
//   node ext/python/rt/selflink.js          # 缺 ELF 那批 .o 就自己编（~100s），再链、再跑
//   node ext/python/rt/selflink.js --keep   # 编好的 .o 留着（默认也留，这一格只是说明）
//
// ## 与第五格判据（`embed.js`）的分工
//
// `embed.js` 的三问都借了外面的手：链接器是 clang。这一份把最后那一格也收回来 ——
//   * `.c` -> `.o`：**我们自己那台 C 前端**（`--format elf --os osx`：我们的链接器吃 ELF 的
//     `.o`，输出才是 Mach-O，这是 tcc 的老路）；
//   * `.o` -> `.a`：**我们自己打的**（`src/core/link/ar.js` 的 `writeArchive`）——
//     macOS 的 `ar` 只认 Mach-O 成员，喂它 ELF 的 `.o` 它一声警告就把成员全丢掉，
//     出一份 96 字节的空库（真踩过，所以这一格必须自己来）；
//   * `.a` + 我们发的代码 -> 可执行文件：**我们自己的链接器**（`macho_exe.js`，`omni build`
//     默认那一路，`via self`）。
//
// 门：产物真跑一趟，输出与本机 python3 的同一句话**逐字节相同**。
// 这一门不进轴表（要现编 202 份 `.o`，~100s）—— 它是"这条链还成立"的那种判据，手跑。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { cpus, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesIn, flagsFor, GENERATED, incDirFor, perFileFlags } from './scope.js';
import { readArchive, writeArchive } from '../../../src/core/link/ar.js';
import { readObject } from '../../../src/core/link/elf.js';
import { readSymbols } from '../../../src/core/link/pe_load.js';

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
const OBJ = join(WORK, 'obj-elf');
const OUT = join(WORK, 'selflink');
const INC = incDirFor(WORK, false);
const say = (s) => process.stdout.write(`${s}\n`);
const skip = (why) => { say(`py-rt/selflink: ${why} —— 跳过`); process.exit(0); };

if (!existsSync(join(SRC, 'Include', 'Python.h'))) skip(`参考树不在（${SRC}）`);
if (!existsSync(join(INC, 'pyconfig.h'))) skip('还没探过 pyconfig.h（先 `npm run py:sweep`）');
if (!existsSync(join(WORK, 'gen', 'config.c'))) skip('没有生成出来的 config.c（先 `npm run py:freeze`）');
if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 python3');
mkdirSync(OBJ, { recursive: true });
mkdirSync(OUT, { recursive: true });

/** 要编哪些：口径与四把尺子共用的 `scope.js` 同一张名单，外加三份生成的与那层薄皮。 */
function workList() {
  const { files } = filesIn(SRC, ['Objects', 'Python', 'Parser', 'Modules'], {});
  const jobs = [];
  for (const [d, f] of files) {
    const name = `${d}/${f}`;
    if (GENERATED.has(name)) continue;
    jobs.push({ name, src: join(SRC, d, f), o: join(OBJ, `${d}-${f}`.replace(/[/.]/g, '-') + '.o') });
  }
  jobs.push({ name: 'Modules/config.c', src: join(WORK, 'gen', 'config.c'), o: join(OBJ, 'Modules-config-c.o') });
  for (const n of ['Python/frozen.c', 'Modules/getpath.c']) {
    const i = n.indexOf('/');
    jobs.push({ name: n, src: join(SRC, n.slice(0, i), n.slice(i + 1)), o: join(OBJ, `${n.replace(/[/.]/g, '-')}.o`) });
  }
  /* 那层薄皮（`embed-boot.c`）—— 语言层要的"初始化收成一个 C ABI 函数"那一格。 */
  jobs.push({ name: 'Programs/_freeze_module.c', src: join(here, 'embed-boot.c'), o: join(OBJ, 'omni-embed-boot.o') });
  return jobs;
}

/** 一份 `.c` 过我们自己的 C 前端，出 **ELF 格式**的 `.o`（我们的链接器吃的就是它）。 */
function ourCC(j) {
  return new Promise((res) => {
    const flags = flagsFor(j.o, INC, SRC, [...perFileFlags(j.name, SRC), '--format', 'elf', '--os', 'osx']);
    const p = spawn(process.execPath, [CLI, ...flags, j.src], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => res(code === 0 && existsSync(j.o) ? null
      : (err.split('\n').find((l) => /error:/.test(l)) ?? `exit=${code}`).slice(0, 140)));
  });
}

const t0 = Date.now();
const jobs = workList();
const todo = jobs.filter((j) => !existsSync(j.o));
say(`py-rt/selflink: ${jobs.length} 份要编，手上已有 ${jobs.length - todo.length} 份`);
if (todo.length > 0) {
  const width = Math.max(2, Math.min(6, cpus().length - 2));
  let at = 0;
  const bad = [];
  const worker = async () => {
    for (;;) {
      const i = at;
      at += 1;
      if (i >= todo.length) return;
      // eslint-disable-next-line no-await-in-loop -- 这就是那个 worker 的循环
      const why = await ourCC(todo[i]);
      if (why !== null) bad.push(`${todo[i].name}：${why}`);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  say(`cc: ${todo.length - bad.length}/${todo.length} 份编出来了（ELF，并行 ${width}，`
    + `${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  for (const b of bad.slice(0, 5)) say(`  编不出 ${b}`);
  if (bad.length > 0) process.exit(1);
}

/* ---- 我们自己打那份 `.a`（谁定义了什么由 ELF 的 `.symtab` 说） ---- */
const members = [];
for (const f of readdirSync(OBJ).filter((x) => x.endsWith('.o')).sort()) {
  const buf = readFileSync(join(OBJ, f));
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const syms = readSymbols(readObject(bytes))
    .filter((s) => s.name !== '' && s.bind === 1 && s.shndx !== 0).map((s) => s.name);
  members.push({ name: f, bytes, syms });
}
const LIB = join(OUT, 'libomnipython.a');
const arBytes = writeArchive(members);
writeFileSync(LIB, arBytes);
const back = readArchive(arBytes);
const namesOk = back.members.length === members.length
  && back.members.every((m, i) => m.name === members[i].name);
say(`ar（我们自己打的）：${(arBytes.length / 1048576).toFixed(1)}M，${members.length} 份成员、`
  + `${back.index === null ? 0 : back.index.syms.length} 条索引；读回来对得上：${namesOk ? '是' : '否'}`);
if (!namesOk || back.index === null) { say('py-rt/selflink: 我们打的那份自己读不回来'); process.exit(1); }

/* ---- 一份方言（adapter 将来发的形状），过 `omni build` 的**自带链接器** ---- */
const SX = join(OUT, 'probe.sx');
const EXE = join(OUT, 'probe');
const CODE = "print('42'.zfill(5)); print(7**80); print(repr(0.1+0.2))";
writeFileSync(SX, `;; 生成的（ext/python/rt/selflink.js）—— 全自己那条链的被试者
(module
  (lib "${LIB}")
  (cabi omni_py_boot i32 (ptr))
  (cabi PyRun_SimpleString i32 (ptr))
  (cabi omni_py_fini i32 ())

  (main
    (let rc int (ccall omni_py_boot (str "${join(SRC, 'Lib')}")))
    (expr (ccall PyRun_SimpleString (str "${CODE}")))
    (expr (ccall omni_py_fini))))
`);
/* `OMNI_CC` 要空着 —— 有它就走外部 cc，那就不是这一门在量的东西了。 */
const env = { ...process.env };
delete env.OMNI_CC;
const b = spawnSync(process.execPath, [CLI, 'build', SX, '-o', EXE], { encoding: 'utf8', cwd: root, env });
const blog = ((b.stderr ?? '') + (b.stdout ?? '')).split('\n').filter((l) => l.trim() !== '');
if (b.status !== 0 || !existsSync(EXE)) {
  say(`py-rt/selflink: omni build（自带链接器）没过：\n${blog.slice(-6).join('\n')}`);
  process.exit(1);
}
say(`ld（我们自己的链接器）：${blog[blog.length - 1]}`);

const got = spawnSync(EXE, [], { encoding: 'utf8', cwd: root });
const want = spawnSync('python3', ['-c', CODE], { encoding: 'utf8' });
const a = (got.stdout ?? '').trimEnd();
const w = (want.stdout ?? '').trimEnd();
const ok = got.status === 0 && a === w;
say('');
if (!ok) {
  say(`门：没过（exit=${got.status}）\n    我们：${JSON.stringify(a.slice(0, 200))}\n    py  ：${JSON.stringify(w)}`);
} else {
  say(`门：**全自己那条链** —— 我们的 C 前端出 ELF \`.o\`、我们打的 \`.a\`、我们的链接器`
    + `（${(statSync(EXE).size / 1048576).toFixed(1)}M），跑出来与 python3 逐字节相同`);
  say(`    ${w.split('\n').join(' / ')}`);
}
say(`（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
process.exit(ok ? 0 : 1);


