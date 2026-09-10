// Omni stage0 — 自举构建（内置命令 `omni bootstrap`）
//
// 为什么这是编译器自己的一个命令，而不是一串 shell：自举是这门语言的**功能**，不是维护者
// 的手艺。它得能被任何一代编译器执行（C0 在 node 上、C1 在 node 上、N1 是原生二进制），
// 所以只用封闭 ABI 里的宿主操作，不用 `mkdir -p` / `cp` / `cmp` 这些外部命令。
//
// 产物是一棵**可安装的目录树**，不是两个裸文件：
//
//   dist/src/host/omni.mjs   C1 —— 纯 JS 的永久兼容层，`node dist/src/host/omni.mjs` 直接可用
//   dist/src/host/omni       N1 —— 原生编译器
//   dist/lib/                std（json.omni …）
//   dist/runtime/            C 运行时的 .c/.h（`build` 时要 -I 它）
//   dist/jit/                ORC JIT 宿主的 C 源码（`run-jit` 时现编一次并缓存）
//   dist/build/              中间产物：omni.c（N1 的 C）、c2.mjs（C2 的产出）、omni-n2 与 omni-n2.c
//
// 中间产物刻意**不进临时目录**：链断在哪一代都要能直接翻出那一份 C 或那一份 JS 来 diff，
// 而不是去 /var/folders 里捞一个随机名字。所以 `build` 收 `--work DIR`，这里全指到 dist/build。
//
// 每一步都报墙上时间。自举是分钟级的操作，"卡在哪一步"必须一眼看得出来 —— 而其中大头是
// clang 与另一代编译器这些子进程，所以计的是墙上时间而不是 CPU 时间。
//
// 布局不是随便摆的：`installDir()` 是"镜像所在目录"，std 与 runtime 都相对它**固定两级
// 上去**（module/load.js、runtime/c_runtime.js）。把编译器直接扔在 dist/ 下，它就会去
// /lib 与 /runtime 里找东西 —— 那是布局错，不是编译器错。
//
// 四条硬门槛，任何一条不成立就非零退出：
//   1. C1 == C2            C1 再编译一次自己，逐字节相同（JS 侧不动点）
//   2. N1 emit-c  == C0    原生编译器产出的 C 与 node 上的逐字节相同
//   3. N1 emit-js == C0    同上，JS
//   4. N2 的产出 == N1 的  N1 编译出 N2，两代原生编译器的产出逐字节相同（真正的 stage2）
//
// 判据是**编译器的输出**，不是二进制镜像：链接每次都会写进新的 LC_UUID，macOS 还会对整个
// 镜像做 ad-hoc 签名，所以 `cmp` 两个原生二进制必然不同。那不是自举失败。

import {
  readText, writeText, exists, readDir, mkdirAll, nowMs, spawn, env, stdout, installDir,
} from './host/native.js';
import { join, basename } from './host/path.js';
import { dataDir } from './host/data.js';
import { RUNTIME_DIR, JIT_DIR, GL_DIR } from './runtime/c_runtime.js';
import { LIB_DIR } from './module/load.js';

/* 语法与内建表是**数据**，不进二进制：两个语法驱动的前端按布局找它们（host/data.js）。
   这里的源目录也照同一条算 —— 装好的那一份自己再 bootstrap 时，指的就是它自己带的那份。 */
const ASY_DIR = dataDir('frontend-asy', 'asy.grammar') ?? join(installDir(), '..', 'frontend-asy');
const JNC_DIR = dataDir('frontend-jnc', 'jnc.grammar') ?? join(installDir(), '..', 'frontend-jnc');

/** 文本树复制。产物要自包含，所以是复制而不是 symlink —— 打包带走才不会断。 */
function copyTree(from, to, exts) {
  mkdirAll(to);
  let n = 0;
  for (const f of readDir(from)) {
    let keep = false;
    for (const e of exts) if (f.endsWith(e)) keep = true;
    if (!keep) continue;
    writeText(join(to, f), readText(join(from, f)));
    n = n + 1;
  }
  return n;
}

/** 第一处不同的行号与两边的内容，给不动点失败时用 */
function firstDiff(a, b) {
  const xs = a.split('\n');
  const ys = b.split('\n');
  let i = 0;
  while (i < xs.length && i < ys.length && xs[i] === ys[i]) i = i + 1;
  return `first difference at line ${i + 1}\n    A: ${xs[i]}\n    B: ${ys[i]}`;
}

/**
 * 毫秒 -> 人看的时长。刻意只用 Math.trunc 和整数算术：`toFixed` 不在语言子集里，
 * 而这段代码必须能被每一代编译器编出来。
 */
function fmtMs(dt) {
  const t = Math.trunc(dt);
  if (t < 1000) return `${t}ms`;
  const tenths = Math.trunc(t / 100);
  const s = Math.trunc(tenths / 10);
  return `${s}.${tenths - s * 10}s`;
}

/**
 * @param {{source: string, outDir: string, quick: boolean,
 *          emitOf: (kind: string, path: string) => string,
 *          buildTo: (path: string, out: string, work: string) => string,
 *          pluginsFor: (core: string, dir: string) => {plugins: number, data: number}}} o
 * @returns {{pass: number, fail: number}}
 */
export function bootstrapSelf(o) {
  /* 产物**只落 dist**（ADR-0021 的 S4）：核心 `dist/omni`、C1 `dist/omni.mjs`、
     插件 `dist/plugins/`、数据 `dist/share/`。从前是 `dist/src/host/omni` 加
     `dist/src/frontend-asy` 那种"照源码树摆"的样子 —— 装好的东西里没有 src 这回事。 */
  const bin = o.outDir;
  const work = join(o.outDir, 'build');
  const name = basename(o.source);
  let pass = 0;
  let fail = 0;
  const details = [];
  const t00 = nowMs();
  // 每条结果行末尾的时间是"上一条结果到这一条之间"花的墙上时间，也就是这一步本身
  let mark = t00;
  const lap = () => {
    const now = nowMs();
    const d = now - mark;
    mark = now;
    return fmtMs(d);
  };
  const ok = (msg) => {
    pass = pass + 1;
    stdout(`  ok   ${msg}  [${lap()}]\n`);
  };
  const bad = (msg, detail) => {
    fail = fail + 1;
    details.push(`${msg}\n    ${detail}`);
    stdout(`  FAIL ${msg}  [${lap()}]\n`);
  };

  // ---- 阶段 0：安装布局
  mkdirAll(bin);
  mkdirAll(work);
  /* 数据全落 `<out>/share/`（与 `omni plugins` 抄的是同一个地方，host/data.js 按布局找）。
     从前是 `<out>/lib`、`<out>/runtime`、`<out>/src/frontend-asy` 那几处 —— 那是照着
     源码树摆的，而装好的东西里没有 src 这回事。 */
  const share = join(o.outDir, 'share');
  const libN = copyTree(LIB_DIR, join(share, 'lib'), ['.omni']);
  // asy 的那份 base（`lib/asy/*.asy`）：`import settings;` 这些从这里找（lang/asy.js 的 libDir）。
  // copyTree 是平的，所以子目录要单独来一趟。
  const libAsyN = copyTree(join(LIB_DIR, 'asy'), join(share, 'lib', 'asy'), ['.asy']);
  const rtN = copyTree(RUNTIME_DIR, join(share, 'runtime'), ['.c', '.h']);
  // JIT 宿主的 C 源码也要带走，否则 N1 的 run-jit 找不到它（布局错，不是编译器错）
  const jitN = copyTree(JIT_DIR, join(share, 'jit'), ['.c', '.h']);
  // 三维那一档的 GL 插件源码同理（cli.js 的 glPlugin 现编现用）。不带走只是**少一条腿**：
  // 那侧找不到源码就回 null，运行时走 CPU 光栅器 —— 所以这一格不进下面的计数断言。
  copyTree(GL_DIR, join(share, 'runtime-gl'), ['.c', '.h']);
  // 语法与内建表同理：它们是**数据**、不进二进制，而两个语法驱动的前端按布局找它们
  // （host/data.js）。不带走的话装好的编译器一跑 `.asy` 就报"找不到 asy 语法文件"——
  // 同样是布局错，不是编译器错。
  const gAsyN = copyTree(ASY_DIR, join(share, 'frontend-asy'), ['.grammar', '.tab']);
  const gJncN = copyTree(JNC_DIR, join(share, 'frontend-jnc'), ['.grammar']);
  const counts = `lib ${libN}+${libAsyN} files, runtime ${rtN} files, jit ${jitN} files,`
    + ` grammar ${gAsyN}+${gJncN} files`;
  if (libN > 0 && libAsyN > 0 && rtN > 0 && jitN > 0 && gAsyN > 0 && gJncN > 0) {
    ok(`layout ${o.outDir}  ${counts}`);
  } else bad(`layout ${o.outDir}`, `${counts} (all must be > 0)`);

  // ---- 阶段 1：C1 = 我 emit-js 我自己
  const c1Text = o.emitOf('js', o.source);
  const c1 = join(bin, 'omni.mjs');
  writeText(c1, c1Text);
  ok(`C1 = emit-js ${name}  ${c1Text.length} bytes -> ${c1}`);

  // ---- 阶段 2：C2 = C1 emit-js 我自己，要求与 C1 逐字节相同
  // 跑 C1 需要一个 JS 引擎。原生编译器上没有 node 就跳过这一项而不是当失败 ——
  // 那台机器上"JS 侧不动点"根本无从验证，谎报成功更糟。
  const nodeExe = env('OMNI_NODE') === undefined ? 'node' : env('OMNI_NODE');
  const probe = spawn(nodeExe, ['--version'], 'c');
  if (probe[0] !== 0) {
    stdout(`  skip C2 == C1: no JS engine ('${nodeExe}' not runnable)  [${lap()}]\n`);
  } else {
    const r = spawn(nodeExe, [c1, 'emit-js', o.source], 'c');
    // C2 的产出留在构建目录里：不动点失败时要能离线 diff 这两份 JS
    if (r[0] === 0) writeText(join(work, 'c2.mjs'), r[1]);
    if (r[0] !== 0) bad('C2 = C1 emit-js', `exit=${r[0]}\n${r[2]}`);
    else if (r[1] !== c1Text) bad('fixpoint C1 == C2', firstDiff(c1Text, r[1]));
    else ok(`fixpoint C1 == C2  ${c1Text.split('\n').length} lines`);
  }

  if (o.quick) return summarize(pass, fail, details, nowMs() - t00);

  // ---- 阶段 3：N1 = clang(我 emit-c 我自己)
  const n1 = join(bin, 'omni');
  const cc = o.buildTo(o.source, n1, work);
  ok(`N1 = ${cc}(emit-c ${name}) -> ${n1}`);

  /* ---- 阶段 3b：N1 的插件。核心里一格语言/后端都没有（ADR-0021 的 S4），所以这一步
     不是附赠品 —— 不做的话下面每一道门槛都会栽在"这份 omni 里一门语言都没装"上。
     绑的是 N1 旁边那份 `.syms`（`buildTo` 用 `--extern` 编，那时才落）。 */
  const pl = o.pluginsFor(n1, join(o.outDir, 'plugins'));
  if (pl.plugins > 0) ok(`plugins ${pl.plugins} 格 + ${pl.data} 份数据 -> ${o.outDir}/plugins`);
  else bad(`plugins -> ${o.outDir}/plugins`, '一格都没编出来');

  // ---- 阶段 4：N1 的产出必须与 C0 的逐字节相同（C 路径闭环）
  for (const kind of ['c', 'js']) {
    const ref = o.emitOf(kind, o.source);
    const r = spawn(n1, [`emit-${kind}`, o.source], 'c');
    if (r[0] !== 0) bad(`N1 emit-${kind} ${name}`, `exit=${r[0]}\n${r[2]}`);
    else if (r[1] !== ref) bad(`fixpoint N1 emit-${kind} == C0`, firstDiff(ref, r[1]));
    else ok(`fixpoint N1 emit-${kind} ${name} == C0  ${ref.length} bytes`);
  }

  // ---- 阶段 5：N2 = N1 编译出来的下一代原生编译器（真正的 stage2）
  const n2 = join(work, 'omni-n2');
  /* `--extern` 不是可选的：N2 也得把符号导出去，否则**它的**插件（就是 N1 那一套，
     绑的是同一份符号名）dlopen 不上 —— 量出来是
     `symbol not found in flat namespace '_g_CALL_LDRET'`。 */
  const built = spawn(n1, ['build', o.source, '-o', n2, '--work', work, '--extern'], 'c');
  if (built[0] !== 0 || !exists(n2)) {
    bad('N2 = N1 build (stage2)', `exit=${built[0]}\n${built[2]}`);
    return summarize(pass, fail, details, nowMs() - t00);
  }
  ok(`N2 = N1 build ${name} -> ${n2}`);
  for (const kind of ['c', 'js']) {
    const a = spawn(n1, [`emit-${kind}`, o.source], 'c');
    const b = spawn(n2, [`emit-${kind}`, o.source], 'c');
    if (a[0] !== 0 || b[0] !== 0) bad(`N2 emit-${kind}`, `N1 exit=${a[0]} N2 exit=${b[0]}\n${b[2]}`);
    else if (a[1] !== b[1]) bad(`fixpoint N1 emit-${kind} == N2`, firstDiff(a[1], b[1]));
    else ok(`fixpoint N1 emit-${kind} == N2  ${a[1].length} bytes`);
  }

  return summarize(pass, fail, details, nowMs() - t00);
}

function summarize(pass, fail, details, total) {
  stdout(`\n${pass} passed, ${fail} failed  in ${fmtMs(total)}\n`);
  if (fail > 0) stdout(`\n${details.join('\n\n')}\n`);
  return { pass, fail };
}
