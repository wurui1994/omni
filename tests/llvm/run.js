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
import { RunCache } from '../lib/incr.js';
import { SUPPORTED } from './supported.js';
/* 第 10 节（会话的几批链成一个程序）直接用编译器的模块，不经 CLI：那一节要的是
   "一批 delta -> 一份产物"，而 CLI 上还没有"编一批"这个动词（J6 的最后一格才会有）。 */
import { CoreSession } from '../../src/core/sexpr/lower.js';
import { Diagnostics } from '../../src/core/source/diag.js';
import { lowerToMir } from '../../src/core/mir/from_oir.js';
import { emitLlvm } from '../../src/core/backend-llvm/emit.js';
import { runtimeSources, RUNTIME_DIR } from '../../src/core/runtime/c_runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'src', 'core', 'cli.js');
const update = process.argv.includes('--update');
const cache = new RunCache('llvm', { record: true });

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

/* `ms` 与输出上限都有默认值：产物一旦跑起来就可能不肯停（曾经一个 setjmp 的 -O2 版本
   往 /tmp 里写了 51GB）。所以这一层永远带着时限和 8MB 的上限，谁都不必自己记得加。 */
function run(args, ms = 60000) {
  /* 走 RunCache（只记依赖、不缓存，ADR-0023 的 S7）：轴级指纹要"这一趟装了哪些模块"这一份，
     不然改任何一门语言的前端都会把这条轴带着重跑。时限交给 RunCache（超时不入册），
     上限它给到 64MB；clang 与编出来的产物照旧原样跑（下面那些 spawnSync）。 */
  const r = cache.run([cli, ...args], { timeout: ms });
  return { out: r.out, err: r.err, code: r.status };
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
        /* 变参那一格要带着 `...` 发（ADR-0022 的 J4d）：少了它，C 编译器报的是
           "实参个数不对"，而真正的原因是声明少了一格。 */
        if (!ce.out.includes('extern int64_t omni_probe_sum(int64_t, ...);')) {
          detail.push('    emit c 里 omni_probe_sum 的原型没带 `...`');
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

// ------------------------------------------------- 7. 一个真的 OpenGL 程序（J4d）
//
// `glfw-tri.sx`：GLFW 开窗、legacy GL 画一个转的三角形，120 帧后自己退。它同时压住四格 ——
// `f32` 那一格（`glColor3f` 按 double 传就是错的调用约定）、字面量在调用点抽地址、
// `(ptr int)` 交出「当前」那一格、以及 `(lib …)` 一路变成 `--lib`。
//
// **为什么这一节必须存在**：入口曾经跑在 `omni_run_entry` 开的那条大栈线程上，而 macOS 上
// AppKit 只能在真主线程上首次初始化 —— `glfwInit` 当场 SIGTRAP，连缓冲里的 stdout 都丢了，
// 看起来像"一个字节都没跑"（ADR-0022 J4d）。修法是链接时把主线程的栈给到 512MB
// （`-Wl,-stack_size`），于是入口留在主线程上。这条测试就是那件事的判据。
//
// 尺寸不写死：retina 上 framebuffer 是窗口的两倍，别的机器不是。所以只查形状。
// 没有 glfw、或者机器上开不出窗（无头）就 skip —— 那不是编译器的事。
//
// 两份源码同一个程序：`.sx`（库与声明都明写）与 `.jnc`（一条 `import … with "h"` 就够，
// 声明与 1800 多个宏都从头文件里收）。**两份的输出必须逐字节相同** —— 那才说明
// "从头文件收来的签名"与"手写的签名"是同一件事。
{
  const glfw = '/opt/homebrew/lib/libglfw.dylib';
  const seen = [];
  /* 三条**原生**腿都要跑（interp 那条不在这儿：它没有 `(ccall …)`）。
     从前只跑 JIT，于是 AOT 那两条上「`(lib …)` 没接到链接命令」这件事一直没人发现 ——
     同一份源码在两条腿上要么都行要么都不行，这种不对称本身就是错。 */
  for (const [name, args] of [['glfw-tri.sx', []],
    ['glfw-tri.jnc', ['-I', '/opt/homebrew/include']]]) {
    const src = join(here, 'cabi', name);
    if (!existsSync(src) || !existsSync(glfw)) {
      process.stdout.write(`  skip ${name}：这台机器上没有 glfw\n`);
      continue;
    }
    for (const leg of ['run-jit', 'run-llvm', 'run-c']) {
      const r = run([leg, src, ...args], 180000);
      const m = /^framebuffer: ([1-9][0-9]*) ([1-9][0-9]*)\nframes: 120\n$/.exec(r.out ?? '');
      const detail = [];
      if (r.code !== 0) {
        detail.push(`    ${leg} exit=${r.code}（133 = SIGTRAP，多半又跑到别的线程上去了）`
          + `\n      ${(r.err ?? '').trim().split('\n').slice(0, 3).join('\n      ')}`);
      } else if (m === null) {
        detail.push(`    输出的形状不对：${JSON.stringify((r.out ?? '').slice(0, 200))}`);
      } else {
        seen.push(r.out);
      }
      if (detail.length > 0) bad(`${name} @ ${leg}`, detail.join('\n'));
      else ok(`${name} @ ${leg} [GLFW 开窗 + legacy GL 画 120 帧：framebuffer ${m[1]}x${m[2]}]`);
    }
  }
  /* 六次的字节要全一样 —— 那才说明"从头文件收来的签名"与"手写的签名"是同一件事，
     而且三条原生腿对同一个 C ABI 的理解没有分叉。 */
  if (seen.length === 6) {
    let same = true;
    for (const s of seen) if (s !== seen[0]) same = false;
    if (same) ok('glfw-tri [两份源码 × 三条原生腿：六次输出逐字节相同]');
    else bad('glfw-tri 六次不一致', `    ${seen.map((s) => JSON.stringify(s)).join('\n    ')}`);
  }
}

// ------------------------------------------------- 9. `opaque class` 的宿主方法（J4b 最后一步）
//
// jancy 的 `opaque class`：**对象由那一侧分配**，方法的体在宿主的 C/C++ 里
// （opaque.rst:15-29 的 `io.Serial` 就是这个形状，登记走 JNC_BEGIN_CLASS 那一串）。
// 我们照同一个形状，只把"登记"换成**按名字约定**：`Owner.method` 对着 C 符号 `Owner_method`，
// 第一个形参是那个对象（`ptr`）。宿主看不见对象的布局 —— 那正是 opaque 的意思，所以
// `host.c` 那边拿指针当键、状态放在自己的一张小表里。
//
// 这一条要证的是"同一个对象"这件事：`add(20)` 之后 `value()` 必须回 20 —— 两次调用里
// 宿主看到的必须是同一个 self。
{
  const dir = join(here, 'cabi');
  const hostC = join(dir, 'host.c');
  const tmp = mkdtempSync(join(tmpdir(), 'omni-opaque-'));
  const ext = process.platform === 'darwin' ? 'dylib' : 'so';
  const libPath = join(tmp, `libhost.${ext}`);
  const so = spawnSync('clang', ['-shared', '-fPIC', hostC, '-o', libPath], { encoding: 'utf8' });
  if (so.status !== 0) bad('opaque-host', `    dylib 编不出来：${(so.stderr ?? '').trim().split('\n')[0]}`);
  else {
    const src = join(tmp, 'opaque.jnc');
    /* 方法名不用 `get`：那是 jancy 的关键字（属性的取值器）—— 量出来的，`c.get()` 在语法上
       根本不是一次方法调用。 */
    writeFileSync(src, `import ${JSON.stringify(libPath)};\n\n`
      + 'opaque class Other {\n'
      /* 原型上的默认值（第一百六十九刀）：下面调的是 `o.add()` —— 补出来的就是这个 21，
         所以印出来还是 other 42（`Other_add` 乘 2）。 */
      + '    long add(long d = 21);\n'
      + '}\n\n'
      + 'opaque class Counter {\n'
      + '    construct(long start);\n'
      + '    long add(long d);\n'
      + '    long value();\n'
      + '\n'
      + '    void tag(variant_t v);\n'
      + '\n'
      /* `variant_t` 从宿主面**回来**（第一百七十四刀）：缓冲区那格摆在最前面、被调的函数回
         void —— 方法与属性的取值器同一条。 */
      + '    variant_t last();\n'
      + '\n'
      + '    variant_t property m_last {\n'
      + '        variant_t get();\n'
      + '    }\n'
      + '\n'
      + '    long property m_scale {\n'
      + '        long get();\n'
      + '        void set(long v);\n'
      + '    }\n'
      /* 表达式里给宿主面那格属性赋值（第一百九十三刀）：整条表达式的值是**存进去的那个值**
         （第一百一十五刀定的那一条）—— 所以 `bump(4)` 回 4，而宿主那边存的时候乘了 10，
         紧跟着读 `m_scale` 就是 40。语料里的原样是 ui_ComboBox.jnc:74。 */
      + '    long bump(long d) {\n'
      + '        return m_scale = d;\n'
      + '    }\n'
      + '}\n\n'
      /* 没写 `opaque` 的类里那格只有原型的方法（第一百八十三刀）：符号名的约定与 opaque
         那一支一模一样 —— `opaque` 说的是"布局不透明"，管的不是"体在哪儿"。 */
      /* 顶层那格只有原型的函数（第一百八十五刀）：符号名就是全名把 `$` 换成 `_`。 */
      + 'long hostAdd(long a, long b);\n\n'
      + 'namespace probe {\n'
      + 'long hostMul(long a, long b);\n'
      + '}\n\n'
      + 'class Plain {\n'
      /* 宿主面那格 construct 上的**默认值**（第一百九十一刀）：下面 `new Plain` 一个实参都不给，
         补出来的就是这个 5 —— 所以 seeded() 印 5。 */
      + '    construct(long seed = 5);\n'
      + '    long twice(long x);\n'
      + '    long seeded();\n'
      /* 同名两条里一条带体、一条只有原型（第一百八十六刀）：一个实参的那条这一层自己发，
         两个实参的那条在宿主 —— 挑哪一条跨着两边。 */
      + '    long mix(long a, long b);\n'
      + '    long mix(long a) {\n'
      + '        return a + 100;\n'
      + '    }\n'
      /* 同元、只差类型的那一对（第一百八十八刀）：收 string_t 的那条只有原型、体在宿主。 */
      /* 任何数据指针隐式转成 void*（第一百九十刀）：这儿传进去的是一格 int*。 */
      + '    long blen(void const* p, long n);\n'
      + '    long note(string_t s);\n'
      + '    long note(long n) {\n'
      + '        return n + 1;\n'
      + '    }\n'
      + '}\n\n'
      /* 基类那格 construct 在宿主（第一百九十二刀）：`basetype.construct(9)` 落成一句
         `(ccall Plain_construct $this 9)`。 */
      + 'class Kid: Plain {\n'
      + '    construct() {\n'
      + '        basetype.construct(9);\n'
      + '    }\n'
      + '}\n\n'
      + 'int main() {\n'
      + '    Counter* c = new Counter(100);\n'
      + '    c.add(20);\n'
      + '    c.add(22);\n'
      + '    long v = c.value();\n'
      + '    printf("count %d\\n", v);\n'
      + '    c.m_scale = 7;\n'
      + '    printf("scale %d\\n", c.m_scale);\n'
      + '    Other* o = new Other;\n'
      + '    printf("other %d\\n", o.add());\n'
      + '    c.tag(7);\n'
      + '    printf("last %d\\n", (long)c.last());\n'
      + '    printf("mlast %d\\n", (long)c.m_last);\n'
      /* jancy 的全局 CRT（第一百七十六刀）：`rand` 那一格文档写的是 "Maps directly to
         standard C function ``rand``"，所以发的是一句 `(ccall rand …)` —— 而 C_ABI 符号只有
         原生腿上才有（ADR-0014 的第 4 条决定），判据就得摆在这儿而不是 tests/jnc。 */
      + '    printf("rand %d\\n", rand() >= 0);\n'
      + '    Plain* q = new Plain;\n'
      + '    printf("plain %d %d\\n", q.twice(21), q.seeded());\n'
      + '    printf("top %d %d\\n", hostAdd(40, 2), probe.hostMul(6, 7));\n'
      + '    printf("mix %d %d\\n", q.mix(3, 4), q.mix(5));\n'
      + '    printf("note %d %d\\n", q.note("hi"), q.note(7));\n'
      + '    int* ip = new int;\n'
      + '    *ip = 7;\n'
      + '    printf("blen %d\\n", q.blen(ip, 4));\n'
      + '    Kid* k = new Kid;\n'
      + '    printf("kid %d\\n", k.seeded());\n'
      + '    printf("bump %d\\n", c.bump(4));\n'
      + '    printf("scale2 %d\\n", c.m_scale);\n'
      + '    return 0;\n'
      + '}\n');
    const r = run(['run-jit', src], 90000);
    const detail = [];
    if (r.code !== 0) detail.push(`    run-jit exit=${r.code}\n      ${(r.err ?? '').trim().split('\n').slice(0, 3).join('\n      ')}`);
    else if (r.out !== 'count 142\nscale 70\nother 42\ntag 1 7\nlast 142\nmlast 142\nrand 1\nplain 42 5\ntop 42 42\nmix 34 105\nnote 200 8\nblen 11\nkid 9\nbump 4\nscale2 40\n') detail.push(`    输出不对：${JSON.stringify(r.out)}（要 "count 142\\nscale 70\\nother 42\\ntag 1 7\\nlast 142\\nmlast 142\\nrand 1\\nplain 42 5\\ntop 42 42\\nmix 34 105\\nnote 200 8\\nblen 11\\nkid 9\\nbump 4\\nscale2 40\\n"）`);
    /* 生成的 `.sx` 里那两句声明也要看一眼：符号名是 `Counter_add`（`_` 不是 `$`——
       后者不是可移植的 C 标识符字符），第一个形参是 `ptr`（那个对象）。
       属性那两格同一条约定，中间多一段 `get_` / `set_`（第一百六十刀）。 */
    const sx = run(['emit', 'sx', src], 90000);
    if (sx.code !== 0) detail.push(`    emit sx 没过：${(sx.err ?? '').trim().split('\n')[0]}`);
    else if (!sx.out.includes('(cabi Counter_add i64 (ptr i64))')) {
      detail.push('    emit sx 里没有 `(cabi Counter_add i64 (ptr i64))`');
    } else if (!sx.out.includes('(cabi Counter_get_m_scale i64 (ptr))')
      || !sx.out.includes('(cabi Counter_set_m_scale void (ptr i64))')) {
      detail.push('    emit sx 里没有属性那两句 `(cabi Counter_get_m_scale …)` / `(cabi Counter_set_m_scale …)`');
    /* 回 variant 的那两格：缓冲区那格在最前面、回的是 void（第一百七十四刀）。 */
    } else if (!sx.out.includes('(cabi Counter_last void (ptr ptr))')
      || !sx.out.includes('(cabi Counter_get_m_last void (ptr ptr))')) {
      detail.push('    emit sx 里没有回 variant 那两句 `(cabi Counter_last void (ptr ptr))` / `(cabi Counter_get_m_last void (ptr ptr))`');
    /* 全局 CRT 那一族（第一百七十六刀）：`rand` 就是 C 的那一个。 */
    } else if (!sx.out.includes('(cabi rand i32 ())')) {
      detail.push('    emit sx 里没有 `(cabi rand i32 ())`');
    /* 没写 opaque 的那一格用的是同一条约定（第一百八十三刀）。 */
    } else if (!sx.out.includes('(cabi Plain_twice i64 (ptr i64))')
      || !sx.out.includes('(cabi Plain_construct void (ptr i64))')) {
      detail.push('    emit sx 里没有 `(cabi Plain_twice …)` / `(cabi Plain_construct …)`');
    /* 顶层那两格（第一百八十五刀）：命名空间里的那个名字带前缀。 */
    } else if (!sx.out.includes('(cabi hostAdd i64 (i64 i64))')
      || !sx.out.includes('(cabi probe_hostMul i64 (i64 i64))')) {
      detail.push('    emit sx 里没有 `(cabi hostAdd …)` / `(cabi probe_hostMul …)`');
    }
    if (detail.length > 0) bad('opaque-host', detail.join('\n'));
    else ok('opaque-host [opaque class 的方法与属性都降成 (ccall Owner_… self …)，两次调用同一个 self]');
  }
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------- 10. 会话的几批链成一个程序（ADR-0022 的 J6）
//
// REPL 的一批一份产物。跨批可见性在解释器上是白拿的（顶层 Env 常驻在宿主那一侧），
// 在**编译**出来的那条腿上不是：`(let base …)` 原先降成入口函数体里的一句 alloca，
// 批一结束就没了。J6 的第一件事把它提成模块级全局，第三件事让会话的一批**不发 main**
// （好几份产物摆在同一个符号空间里，第二批带 main 就是重复定义）。
//
// 这一节把三批产物 + 一个只管按顺序调 `omni_chunk_N` 的小驱动链成一个可执行文件跑起来 ——
// 于是"第二批改第一批的变量、第三批还读得到"是**真跑出来**的，不是看 IR 的形状猜的。
// 这条路不需要任何新的宿主 ABI（jit_open/jit_add 那一格还没做）：ADR 里说的
// "1–3 落完 AOT 那两条腿也能吃一串 chunk"就是这一节。
{
  const tmp = mkdtempSync(join(tmpdir(), 'omni-session-'));
  const texts = [
    '(fn f1 ((n int)) int (ret (bin "+" (var n) (int 1))))\n'
      + '(fn g1 ((n int)) int (ret (call f1 (var n))))\n'
      + '(let base int (int 100))\n(print (var base))\n',
    '(set base (bin "+" (var base) (int 1)))\n(print (var base))\n',
    '(print (bin "*" (var base) (int 2)))\n',
    '(print (call g1 (int 10)))\n',
    '(fn f1 ((n int)) int (ret (bin "*" (var n) (int 100))))\n(print (call g1 (int 10)))\n',
  ];
  const cs = new CoreSession();
  const lls = [];
  const detail = [];
  let k = 0;
  for (const t of texts) {
    k++;
    const diags = new Diagnostics();
    const delta = cs.add(t, diags);
    diags.throwIfErrors();
    const ir = emitLlvm(lowerToMir(delta), { repl: true });
    const p = join(tmp, `chunk${k}.ll`);
    writeFileSync(p, ir);
    lls.push(p);
    if (/define i32 @main\(/.test(ir)) detail.push(`    第 ${k} 批还带着包装的 main`);
    /* 第一批**定义**那一格（外部链接，后面几批要找得到），第二、三批只**声明**。
       第四、五批压根没提 `base`（它们只调 g1）—— 那正是"只声明这一批提到过的"该有的样子，
       所以这两批里一句 `@g_base` 都不该有。 */
    if (k === 1 && !ir.includes('@g_base = global i64 zeroinitializer')) {
      detail.push('    第 1 批里没有 `@g_base = global i64 zeroinitializer`');
    }
    if ((k === 2 || k === 3) && !ir.includes('@g_base = external global i64')) {
      detail.push(`    第 ${k} 批里没有 \`@g_base = external global i64\``);
    }
    if ((k === 4 || k === 5) && ir.includes('@g_base')) {
      detail.push(`    第 ${k} 批没提 base，却发了一句 @g_base`);
    }
    /* 跨批**调函数**（J6 的第二件事）与**重新定义**（第四件事）：会话里的函数调用点走
       一格函数指针全局，所以第四批里该有 `@g_fp_g1` 的一句声明（落点在第一批），
       而第五批重新定义 f1 的那一代是另一个符号（`s_f1__2`），旧代码照旧走同一格全局。 */
    if (k === 4) {
      if (!ir.includes('@g_fp_g1 = external global')) detail.push('    第 4 批里没有 `@g_fp_g1` 的声明');
      if (/define [^\n]*@s_g1\(/.test(ir)) detail.push('    第 4 批把 g1 又定义了一遍');
    }
    if (k === 5) {
      if (!/define i64 @s_f1__2\(/.test(ir)) detail.push('    第 5 批里没有第二代 `s_f1__2` 的正文');
      if (/define i64 @s_f1\(/.test(ir)) detail.push('    第 5 批把第一代 f1 又定义了一遍');
    }
  }
  writeFileSync(join(tmp, 'drv.c'), `#include <stdio.h>
void omni_host_init(int argc, char **argv);
void omni_chunk_1(void);
void omni_chunk_2(void);
void omni_chunk_3(void);
void omni_chunk_4(void);
void omni_chunk_5(void);
int omni_host_exit_code(void);
int main(int argc, char **argv) {
  omni_host_init(argc, argv);
  omni_chunk_1();
  omni_chunk_2();
  omni_chunk_3();
  omni_chunk_4();
  omni_chunk_5();
  fflush(NULL);
  return omni_host_exit_code();
}
`);
  const exe = join(tmp, 'session');
  const cc = spawnSync('clang', ['-w', '-I', RUNTIME_DIR, '-o', exe,
    join(tmp, 'drv.c'), ...runtimeSources(), ...lls, '-lm'],
  { encoding: 'utf8', timeout: 180000, maxBuffer: 8 << 20 });
  if (cc.status !== 0) {
    detail.push(`    链不起来：${(cc.stderr ?? '').trim().split('\n').slice(0, 4).join('\n      ')}`);
  } else {
    const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 });
    if (r.status !== 0) detail.push(`    跑挂了 exit=${r.status}：${(r.stderr ?? '').trim().split('\n')[0]}`);
    else if (r.stdout !== '100\n101\n202\n11\n1000\n') {
      detail.push(`    输出不对：${JSON.stringify(r.stdout)}（要 "100\\n101\\n202\\n11\\n1000\\n"）`);
    }
  }
  if (detail.length > 0) bad('session-aot', detail.join('\n'));
  else ok('session-aot [五批产物链成一个程序：跨批改变量、跨批调函数、重新定义之后旧代码也换身体]');
  rmSync(tmp, { recursive: true, force: true });
}

const rep = cache.report();
process.stdout.write(`\n${pass} passed, ${fail} failed${rep === "" ? "" : `  （${rep}）`}\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
