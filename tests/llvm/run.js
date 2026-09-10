#!/usr/bin/env node
// Omni — LLVM 后端（第十二条测试轴，ADR-0014 决策 3 第一阶段）
//
// 第一阶段只降标量：i64 / f64 / bool / void。所以这条轴要同时钉两件事，缺一件都不行：
//
//   1. **能降的必须给出同一个答案**：`run-llvm` == `interp` == `run-c`，
//      stdout / stderr / 退出码三样都比。错误路径也在里面（除零那份 case 走的是
//      IR 里的 @omni_ll_div 辅助函数 -> omni_error -> 退出码 70）。
//   2. **不能降的必须报错，而且报在正确的理由上**。这是 WAT 轴 `bad/` 那条规矩的翻版：
//      边界是划出来的，不是忘了做。所以「哪些 case 现在能降」写成一张显式清单 ——
//      支持面扩大时必须来改这张表，而不是让它悄悄漂移。
//
//   node tests/llvm/run.js
//   node tests/llvm/run.js --update      # 重写 IR 快照

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SUPPORTED } from './supported.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'src', 'core', 'cli.js');
const update = process.argv.includes('--update');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const bad = (label, detail) => {
  fail++;
  failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

/** 第一阶段能降的那些在 supported.js 里 —— tests/jit 也读同一份，见那个文件的头 */

function run(args) {
  const r = spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

/** 缓存里那个 omni-jit 宿主（第 5 节的 JIT 那一路要它）。没编过就回 null，那一路按 skip 处理。 */
function findJitHost() {
  const jitRoot = join(root, '.omni-cache', 'jit');
  const hosts = [];
  try {
    for (const d of readdirSync(jitRoot)) {
      const p = join(jitRoot, d, 'omni-jit');
      if (existsSync(p)) hosts.push(p);
    }
  } catch { /* 没这个目录就是没编过 */ }
  if (hosts.length === 0) return null;
  return hosts.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
const jitHost = findJitHost();

// ------------------------------------------------- 1. 三方一致（llvm / interp / c）

for (const rel of SUPPORTED) {
  const src = join(root, rel);
  const name = basename(rel);
  const ll = run(['run-llvm', src]);
  const ip = run(['interp', src]);
  const c = run(['run-c', src]);
  const detail = [];
  if (ll.out !== ip.out) detail.push(`    stdout 与 interp 不同\n      interp ${JSON.stringify(ip.out)}\n      llvm   ${JSON.stringify(ll.out)}`);
  if (ll.out !== c.out) detail.push(`    stdout 与 omni-c 不同\n      omni-c ${JSON.stringify(c.out)}\n      llvm   ${JSON.stringify(ll.out)}`);
  if (ll.code !== ip.code || ll.code !== c.code) {
    detail.push(`    退出码不同：llvm ${ll.code}, interp ${ip.code}, omni-c ${c.code}`);
  }
  // 错误路径：诊断走 stderr，也要一样（除零那份就在这里被卡住）
  if (ll.err !== c.err) detail.push(`    stderr 与 omni-c 不同\n      omni-c ${JSON.stringify(c.err)}\n      llvm   ${JSON.stringify(ll.err)}`);
  if (detail.length > 0) bad(`three-way/${name}`, detail.join('\n'));
  else ok(`three-way/${name} [llvm == interp == omni-c] exit=${ll.code}, ${ll.out.length} bytes`);
}

// ------------------------------------------------- 2. 边界：降不了的要报错

const others = [];
for (const f of readdirSync(join(root, 'tests', 'cases')).sort()) {
  if (!/\.(omni|omnid|omnis)$/.test(f)) continue;
  const rel = join('tests', 'cases', f);
  if (!SUPPORTED.includes(rel)) others.push(rel);
}

let declined = 0;
const wrong = [];
for (const rel of others) {
  const r = run(['emit-llvm', join(root, rel)]);
  if (r.code === 0) { wrong.push(`    ${rel} 居然降下来了 —— 要么真支持了（那就加进 SUPPORTED），要么是在悄悄给错答案`); continue; }
  // 报错必须说清是阶段边界，而不是随便崩一个
  if (!r.err.includes('llvm 后端目前不支持')) wrong.push(`    ${rel} 报错的理由不对：${JSON.stringify(r.err.slice(0, 120))}`);
  else declined++;
}
if (wrong.length > 0) bad('boundary/declared', wrong.join('\n'));
else ok(`boundary/declared [${declined} 份 case 被明确拒绝，理由都是阶段边界]`);

// ------------------------------------------------- 3. IR 形状快照

// 选 02-control：结构化控制流拆成基本块是这一层唯一会出错又不容易看出来的地方
// （层数算错、汇合点接错、死块没落标签），快照能一眼看出来。
const snapSrc = join(root, 'tests', 'wat', 'cases', '02-control.wat');
const snapPath = join(here, 'snapshots', '02-control.ll');
const got = execFileSync('node', [cli, 'emit-llvm', snapSrc], { encoding: 'utf8' });
if (update) {
  writeFileSync(snapPath, got);
  ok(`snapshot/02-control [written] ${got.split('\n').length - 1} lines`);
} else if (!existsSync(snapPath)) {
  bad('snapshot/02-control', `    缺快照 ${snapPath}（用 --update 生成）`);
} else {
  const want = readFileSync(snapPath, 'utf8');
  if (want === got) ok(`snapshot/02-control [== snapshots/02-control.ll] ${got.split('\n').length - 1} lines`);
  else {
    const wl = want.split('\n');
    const gl = got.split('\n');
    let i = 0;
    while (i < wl.length && i < gl.length && wl[i] === gl[i]) i++;
    bad('snapshot/02-control', `    第 ${i + 1} 行起不同\n    want: ${JSON.stringify(wl[i])}\n    got:  ${JSON.stringify(gl[i])}`);
  }
}

// ------------------------------------------------- 4. C 那条腿的外部符号（ADR-0022 的 J4）
//
// `tests/c/sys/*.c` 是**外部符号最密的一组**：`printf` 那一族（变参）、`stdout`/`stderr`
// （外部全局量）、`write`/`open`（真 syscall 包装）、`setjmp`。这一节钉的是「LLVM 这条腿
// 调真 libc 的结果与 `omni c run` 逐字节相同」——
// 三样都比：stdout、stderr、退出码。
//
// 为什么不并进第 1 节：那一节的输入是 omni/wat/sx，走 `run-llvm`（自带 host 与线性内存）；
// 这一组走的是 `emit llvm x.c` + `clang -x ir`，MIR 是**认真地址**的那一种（`c.toMirNative`），
// 没有 host、没有线性内存 —— 两种模块在这一层是两条路，混在一张表里会看不出坏在哪条。
//
// **两个优化档都跑**（`-O0` 与 `-O2`）：这一层发出去的 IR 要在优化之后还是同一个答案，
// 而「少了一位属性/少了一个 volatile」这一类错**只在开优化之后才露出来** ——
// `04-setjmp.c` 就是这么被抓着的：`-O0` 逐字节相同，而 `-O1` 起 LLVM 把跳回来还要用的
// 局部量提到了寄存器里，跳成一个不停印的死循环。所以跑的时候一律**带时限、带上限**：
// 死循环不该把测试机的磁盘写满。
const sysDir = join(root, 'tests', 'c', 'sys');
const OPT_LEVELS = ['-O0', '-O2'];
const RUN_MS = 20000;
const OUT_CAP = 1 << 20;   // 1MB：这一组用例的输出都是几十字节，超出就是跑飞了
/** 跑一个可执行文件，带时限与输出上限。 */
function runBin(path) {
  const r = spawnSync(path, [], { encoding: 'utf8', timeout: RUN_MS, maxBuffer: OUT_CAP });
  const why = r.error === undefined || r.error === null ? null : r.error.code ?? String(r.error.message);
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status, why };
}
if (existsSync(sysDir)) {
  const tmp = mkdtempSync(join(tmpdir(), 'omni-llvm-c-'));
  for (const f of readdirSync(sysDir).sort()) {
    if (!f.endsWith('.c')) continue;
    const src = join(sysDir, f);
    const irPath = join(tmp, `${f}.ll`);
    const em = run(['emit', 'llvm', src]);
    if (em.code !== 0) { bad(`c-extern/${f}`, `    emit llvm 没过：${em.err.trim().split('\n')[0]}`); continue; }
    writeFileSync(irPath, em.out);
    const c = run(['c', 'run', src]);
    const detail = [];
    let shape = '';
    for (const opt of OPT_LEVELS) {
      const binPath = join(tmp, `${f}${opt}.bin`);
      const cc = spawnSync('clang', ['-x', 'ir', opt, irPath, '-o', binPath], { encoding: 'utf8' });
      if (cc.status !== 0) {
        detail.push(`    clang -x ir ${opt} 没过：${(cc.stderr ?? '').trim().split('\n').slice(0, 3).join('\n      ')}`);
        continue;
      }
      const ll = runBin(binPath);
      if (ll.why !== null) { detail.push(`    ${opt} 没能正常跑完：${ll.why}（时限 ${RUN_MS}ms、输出上限 ${OUT_CAP} 字节）`); continue; }
      if (ll.out !== c.out) detail.push(`    ${opt} stdout 与 omni-c 不同\n      omni-c ${JSON.stringify(c.out.slice(0, 200))}\n      llvm   ${JSON.stringify(ll.out.slice(0, 200))}`);
      if (ll.err !== c.err) detail.push(`    ${opt} stderr 与 omni-c 不同\n      omni-c ${JSON.stringify(c.err.slice(0, 200))}\n      llvm   ${JSON.stringify(ll.err.slice(0, 200))}`);
      if (ll.code !== c.code) detail.push(`    ${opt} 退出码不同：llvm ${ll.code}, omni-c ${c.code}`);
      shape = `exit=${ll.code}, ${ll.out.length}+${ll.err.length} bytes`;
    }
    if (detail.length > 0) bad(`c-extern/${f}`, detail.join('\n'));
    else ok(`c-extern/${f} [llvm == omni-c @ ${OPT_LEVELS.join(' ')}] ${shape}`);
  }
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------- 5. 源码里声明的外部 C 符号（J4b）
//
// `(cabi 名字 返回类型 (形参类型…))` + `(ccall 名字 实参…)`：与 `hir/c_abi.js` 那张构建期的
// 封闭表是两回事 —— 这两个形式说的是「这个模块要调这几个 C 符号」，名字与签名从**源码**来。
// jancy 的 `opaque class` 宿主方法要的就是这条路。
//
// 这一节走 **JIT** 那一路（`--lib`，J5）：host.c 编成 dylib 装进来，符号是**运行期**解析的。
// 为什么不顺手也走一遍 AOT：`.sx` 模块的 IR 还要整份 omni 运行时（`omni_print_int` 那些）
// 才链得上，而那件事第 1 节的 `run-llvm` 已经在钉了 —— 这一节要证的是**外部符号那一格**，
// JIT 那一路把它证完了。C 那条腿另外用一条文本判据钉住（extern 原型 + 不带 marshaler 的调用）。
{
  const dir = join(here, 'cabi');
  const src = join(dir, 'probe.sx');
  const hostC = join(dir, 'host.c');
  const want = existsSync(join(dir, 'probe.expected')) ? readFileSync(join(dir, 'probe.expected'), 'utf8') : null;
  if (want === null) bad('cabi-decl', '    缺 tests/llvm/cabi/probe.expected');
  else {
    const tmp = mkdtempSync(join(tmpdir(), 'omni-cabi-'));
    const irPath = join(tmp, 'probe.ll');
    const em = run(['emit-llvm', src]);
    const detail = [];
    if (em.code !== 0) detail.push(`    emit-llvm 没过：${em.err.trim().split('\n')[0]}`);
    else {
      writeFileSync(irPath, em.out);
      const ext = process.platform === 'darwin' ? 'dylib' : 'so';
      const libPath = join(tmp, `libhost.${ext}`);
      const so = spawnSync('clang', ['-shared', '-fPIC', hostC, '-o', libPath], { encoding: 'utf8' });
      if (so.status !== 0) detail.push(`    dylib 编不出来：${(so.stderr ?? '').trim().split('\n')[0]}`);
      else if (jitHost === null) process.stdout.write('  skip cabi-decl：缓存里找不到 omni-jit 宿主\n');
      else {
        const r = spawnSync(jitHost, [irPath, '--lib', libPath], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 });
        if ((r.stdout ?? '') !== want) detail.push(`    jit --lib 的输出不对\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(r.stdout)}\n      err  ${JSON.stringify((r.stderr ?? '').slice(0, 200))}`);
      }
      /* C 那条腿：原型要发出来（少了它生成的 `.c` 里就是一次没有声明的调用），
         而调用点**不许**套 marshaler（`omni_cabi_*` 是 dynamic 域那条路的东西）。 */
      const ce = run(['emit', 'c', src]);
      if (ce.code !== 0) detail.push(`    emit c 没过：${ce.err.trim().split('\n')[0]}`);
      else {
        if (!ce.out.includes('extern int64_t omni_probe_add(int64_t, int64_t);')) {
          detail.push('    emit c 里没有 omni_probe_add 的 extern 原型');
        }
        if (!ce.out.includes('extern void omni_probe_hi(void);')) {
          detail.push('    emit c 里没有 omni_probe_hi 的 extern 原型');
        }
        if (ce.out.includes('omni_cabi_i64(') || ce.out.includes('omni_cabi_of_i64(')) {
          detail.push('    emit c 把 marshaler 套在了已经是机器值的实参上（raw 那一位没生效）');
        }
      }
    }
    if (detail.length > 0) bad('cabi-decl', detail.join('\n'));
    else ok('cabi-decl [(cabi …)/(ccall …)：jit --lib 调到宿主的 C 函数，C 那条腿发原型且不套 marshaler]');
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------- 6. 源码里说要装哪个动态库（J4c）
//
// `(lib "…")`：与 jancy 的 `.jncx`（一个 zip，把声明和编译好的扩展库封在一起）换了一条路 ——
// 「有哪些符号」由源码里的 `(cabi …)` 说，「它们的体在哪儿」由 `(lib …)` 说。于是不需要一种
// 新的文件格式，而 jnc 那侧写 `import "libfoo.dylib"` 就落在这一句上。
//
// 这一条钉的是**整条链**：源码 -> OIR -> MIR -> `runViaJit` 把它变成 `omni-jit --lib`。
// 所以它走 `run-jit`（一条命令，不手工给开关）—— 手工给 `--lib` 的那一路在第 5 节。
// 库的路径是运行时才知道的（临时目录），所以 `.sx` 由测试自己写出来。
{
  const dir = join(here, 'cabi');
  const hostC = join(dir, 'host.c');
  const tmp = mkdtempSync(join(tmpdir(), 'omni-lib-'));
  const ext = process.platform === 'darwin' ? 'dylib' : 'so';
  const libPath = join(tmp, `libhost.${ext}`);
  const so = spawnSync('clang', ['-shared', '-fPIC', hostC, '-o', libPath], { encoding: 'utf8' });
  if (so.status !== 0) bad('lib-decl', `    dylib 编不出来：${(so.stderr ?? '').trim().split('\n')[0]}`);
  else {
    const sxPath = join(tmp, 'uselib.sx');
    writeFileSync(sxPath, '(module\n'
      + `  (lib ${JSON.stringify(libPath)})\n`
      + '  (cabi omni_probe_add i64 (i64 i64))\n'
      + '  (main\n'
      + '    (print (ccall omni_probe_add (int 20) (int 22)))))\n');
    const r = run(['run-jit', sxPath]);
    const detail = [];
    if (r.code !== 0) detail.push(`    run-jit exit=${r.code}\n      ${(r.err ?? '').trim().split('\n').slice(0, 2).join('\n      ')}`);
    else if (r.out !== '42\n') detail.push(`    输出不对：${JSON.stringify(r.out)}（要 "42\\n"）`);
    /* 预登记的系统库（`hir/c_abi.js` 的 C_SYSLIBS）走的是另一条：不 dlopen 路径，
       而是让宿主去问进程的动态符号表（`--dl`）—— macOS 上 libSystem 连磁盘上的文件都不是。 */
    const sysPath = join(tmp, 'uselibm.sx');
    writeFileSync(sysPath, '(module\n'
      + '  (lib "libm")\n'
      + '  (cabi sqrt f64 (f64))\n'
      + '  (main\n'
      + '    (print (ccall sqrt (real 2.25)))))\n');
    const r2 = run(['run-jit', sysPath]);
    if (r2.code !== 0) detail.push(`    (lib "libm") 那一路 exit=${r2.code}\n      ${(r2.err ?? '').trim().split('\n').slice(0, 2).join('\n      ')}`);
    else if (r2.out !== '1.5\n') detail.push(`    (lib "libm") 的输出不对：${JSON.stringify(r2.out)}（要 "1.5\\n"）`);
    if (detail.length > 0) bad('lib-decl', detail.join('\n'));
    else ok('lib-decl [(lib …) 一路变成 omni-jit 的 --lib / --dl：第三方库与预登记的系统库各一条]');
  }
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
