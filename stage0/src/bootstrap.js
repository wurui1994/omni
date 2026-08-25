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
  readText, writeText, exists, readDir, mkdirAll, mkdTemp, tmpDir, spawn, env, stdout,
} from './host/native.js';
import { join, basename } from './host/path.js';
import { RUNTIME_DIR } from './runtime/c_runtime.js';
import { LIB_DIR } from './module/load.js';

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
 * @param {{source: string, outDir: string, quick: boolean,
 *          emitOf: (kind: string, path: string) => string,
 *          buildTo: (path: string, out: string) => string}} o
 * @returns {{pass: number, fail: number}}
 */
export function bootstrapSelf(o) {
  const bin = join(o.outDir, 'src', 'host');
  const name = basename(o.source);
  let pass = 0;
  let fail = 0;
  const details = [];
  const ok = (msg) => {
    pass = pass + 1;
    stdout(`  ok   ${msg}\n`);
  };
  const bad = (msg, detail) => {
    fail = fail + 1;
    details.push(`${msg}\n    ${detail}`);
    stdout(`  FAIL ${msg}\n`);
  };

  // ---- 阶段 0：安装布局
  mkdirAll(bin);
  const libN = copyTree(LIB_DIR, join(o.outDir, 'lib'), ['.omni']);
  const rtN = copyTree(RUNTIME_DIR, join(o.outDir, 'runtime'), ['.c', '.h']);
  if (libN > 0 && rtN > 0) ok(`layout ${o.outDir}  lib ${libN} files, runtime ${rtN} files`);
  else bad(`layout ${o.outDir}`, `lib ${libN} files, runtime ${rtN} files (both must be > 0)`);

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
    stdout(`  skip C2 == C1: no JS engine ('${nodeExe}' not runnable)\n`);
  } else {
    const r = spawn(nodeExe, [c1, 'emit-js', o.source], 'c');
    if (r[0] !== 0) bad('C2 = C1 emit-js', `exit=${r[0]}\n${r[2]}`);
    else if (r[1] !== c1Text) bad('fixpoint C1 == C2', firstDiff(c1Text, r[1]));
    else ok(`fixpoint C1 == C2  ${c1Text.split('\n').length} lines`);
  }

  if (o.quick) return summarize(pass, fail, details);

  // ---- 阶段 3：N1 = clang(我 emit-c 我自己)
  const n1 = join(bin, 'omni');
  const cc = o.buildTo(o.source, n1);
  ok(`N1 = ${cc}(emit-c ${name}) -> ${n1}`);

  // ---- 阶段 4：N1 的产出必须与 C0 的逐字节相同（C 路径闭环）
  for (const kind of ['c', 'js']) {
    const ref = o.emitOf(kind, o.source);
    const r = spawn(n1, [`emit-${kind}`, o.source], 'c');
    if (r[0] !== 0) bad(`N1 emit-${kind} ${name}`, `exit=${r[0]}\n${r[2]}`);
    else if (r[1] !== ref) bad(`fixpoint N1 emit-${kind} == C0`, firstDiff(ref, r[1]));
    else ok(`fixpoint N1 emit-${kind} ${name} == C0  ${ref.length} bytes`);
  }

  // ---- 阶段 5：N2 = N1 编译出来的下一代原生编译器（真正的 stage2）
  const stage = mkdTemp(join(tmpDir(), 'omni-stage2-'));
  const n2 = join(stage, 'omni-n2');
  const built = spawn(n1, ['build', o.source, '-o', n2], 'c');
  if (built[0] !== 0 || !exists(n2)) {
    bad('N2 = N1 build (stage2)', `exit=${built[0]}\n${built[2]}`);
    return summarize(pass, fail, details);
  }
  ok(`N2 = N1 build ${name} -> ${n2}`);
  for (const kind of ['c', 'js']) {
    const a = spawn(n1, [`emit-${kind}`, o.source], 'c');
    const b = spawn(n2, [`emit-${kind}`, o.source], 'c');
    if (a[0] !== 0 || b[0] !== 0) bad(`N2 emit-${kind}`, `N1 exit=${a[0]} N2 exit=${b[0]}\n${b[2]}`);
    else if (a[1] !== b[1]) bad(`fixpoint N1 emit-${kind} == N2`, firstDiff(a[1], b[1]));
    else ok(`fixpoint N1 emit-${kind} == N2  ${a[1].length} bytes`);
  }

  return summarize(pass, fail, details);
}

function summarize(pass, fail, details) {
  stdout(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) stdout(`\n${details.join('\n\n')}\n`);
  return { pass, fail };
}
