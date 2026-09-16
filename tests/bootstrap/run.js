#!/usr/bin/env node
// Omni — 自举测试（第六条测试轴）
//
// 前五条轴测的都是"编译器 C0（node 直接跑 src/core）输出对不对"。这一条测的是**编译器
// 自己**：让 C0 编译自己得到 C1，再让 C1 编译自己得到 C2。
//
//   C0 = node src/core/cli.js
//   C1 = node <C0 emit-js src/core/cli.js>
//   C2 = node <C1 emit-js src/core/cli.js>
//
// 要求：
//   1. C1 == C2 逐字节相同（不动点 —— 说明 C1 是个和 C0 语义等价的编译器）
//   2. 每个 js-exec / omni 用例，C1 的产物和 C0 的产物逐字节相同
//   3. C 路径与 stage2：交给编译器的内置命令 `omni bootstrap`（src/core/bootstrap.js）——
//      它摆出可安装的产物树、验证 N1 的产出等于 C0、并让 N1 编译出 N2 再比对两代的产出
//
//   node tests/bootstrap/run.js
//   node tests/bootstrap/run.js -q     只测 JS 侧的不动点，跳过逐用例对照与 C 路径

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const quick = process.argv.includes('-q');
const cli = join(root, 'src', 'core', 'cli.js');
const dir = workDir('boot');

// 自举这条路上的 C **必须带优化**，与 cli.js 的默认档（-O0，为了迭代速度）分开。
// 量出来的：-O0 编出来的 N1 一跑 `emit-c cli.js` 就 SIGSEGV（那份编译器的降级是深递归，
// -O0 的栈帧大得多，机器默认 8MB 的主线程栈不够）。真正的修法是给这个进程要一条更大的栈，
// 那是另一刀；这里先把档位钉住，免得"自举过不过"取决于一个为了跑得快而调的默认值。
// 显式给了 OMNI_OPT 就听显式的（子进程都继承 process.env，所以这一句管到底）。
if (process.env.OMNI_OPT === undefined || process.env.OMNI_OPT === '') process.env.OMNI_OPT = '2';

// C1/C2 是"另一个安装位置的编译器"，得按安装布局摆：std 的根是 installDir()/../../lib
// （module/load.js），而 installDir() 在 node 上就是镜像所在目录。摆错了 import "std/..."
// 就找不到 —— 那是布局问题，不是编译器问题。
const binDir = join(dir, 'src', 'host');
mkdirSync(binDir, { recursive: true });
symlinkSync(join(root, 'src', 'lib'), join(dir, 'lib'));

const node = (args) => {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => {
  pass++;
  process.stdout.write(`  ok   ${msg}\n`);
};
const bad = (msg, detail) => {
  fail++;
  failures.push(`${msg}\n${detail}`);
  process.stdout.write(`  FAIL ${msg}\n`);
};

// ---- 阶段 1/2：C0 -> C1 -> C2 -------------------------------------------------
/* **这两代都要额外的堆**（量出来的，第二十六批）：C1 编 C2 那一步在 node 默认的老年代
 * （这台机器上约 2 GB）里 OOM —— 崩在 `Mark-Compact … 1990.7 MB … last resort`。
 * 给 3072 MB 就过，出来的 C2 是 19,099,746 字节；4096 与 8192 出的是**同一份**，
 * 所以瓶颈是"够不够"，不是"给多少变多少"。
 *
 * 记在这儿而不是悄悄加：**这是编译器自己的内存账**（C1 是生成出来的 JS，比 C0 费内存），
 * 哪天那笔账还了，这一格该往回调。 */
const HEAP_MB = 3072;
const stages = [];
let prev = ['node', cli]; // C0 的调用方式：node src/core/cli.js
for (const gen of [1, 2]) {
  const t0 = Date.now();
  const r = node([`--max-old-space-size=${HEAP_MB}`, ...prev.slice(1), 'emit-js', cli]);
  const ms = Date.now() - t0;
  if (r.code !== 0 || !r.out) {
    bad(`C${gen} = C${gen - 1} emit-js cli.js`, `    exit=${r.code}\n${r.err}`);
    break;
  }
  const path = join(binDir, `omni-c${gen}.mjs`);
  writeFileSync(path, r.out);
  stages.push({ gen, path, text: r.out, ms });
  ok(`C${gen} = C${gen - 1} emit-js cli.js  ${r.out.length} bytes, ${(ms / 1000).toFixed(1)}s`);
  prev = ['node', path];
}

// ---- 阶段 3：不动点 -----------------------------------------------------------
if (stages.length === 2) {
  const [c1, c2] = stages;
  if (c1.text === c2.text) ok(`fixpoint C1 == C2  ${c1.text.split('\n').length} lines`);
  else {
    const a = c1.text.split('\n');
    const b = c2.text.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    bad('fixpoint C1 == C2', `    first difference at line ${i + 1}\n    C1: ${a[i]}\n    C2: ${b[i]}`);
  }
}

// ---- 阶段 4：逐用例，C1 的产物必须和 C0 的产物相同 -----------------------------
const c1 = stages[0];
if (c1 && !quick) {
  const inputs = [];
  const jsDir = join(root, 'tests', 'js-exec', 'cases');
  for (const f of readdirSync(jsDir).filter((x) => x.endsWith('.js')).sort()) {
    inputs.push({ name: `js-exec/${basename(f, '.js')}`, path: join(jsDir, f) });
  }
  const omniDir = join(root, 'tests', 'cases');
  for (const f of readdirSync(omniDir).filter((x) => x.endsWith('.omni')).sort()) {
    inputs.push({ name: `cases/${basename(f, '.omni')}`, path: join(omniDir, f) });
  }

  for (const { name, path } of inputs) {
    const ref = node([cli, 'emit-js', path]);
    const via = node([c1.path, 'emit-js', path]);
    if (ref.code !== 0) {
      bad(name, `    C0 itself failed: exit=${ref.code}\n${ref.err}`);
      continue;
    }
    if (via.code !== 0) {
      bad(name, `    C1 exit=${via.code}\n${via.err}`);
      continue;
    }
    if (via.out !== ref.out) {
      bad(name, `    C0 ${ref.out.length} bytes != C1 ${via.out.length} bytes`);
      continue;
    }
    ok(`${name}  C0 == C1  ${ref.out.length} bytes`);
  }

  // C1 真的能跑一个 .omni 程序（不只是产出文本）
  const sample = join(omniDir, '01_basics.omni');
  const expected = readFileSync(join(omniDir, '01_basics.expected'), 'utf8');
  const r = node([c1.path, 'run', sample]);
  if (r.code === 0 && expected.includes(r.out.trim().split('\n')[0])) ok('C1 run cases/01_basics');
  else bad('C1 run cases/01_basics', `    exit=${r.code}\n${r.out}${r.err}`);
}

// ---- 阶段 5：C 路径 + stage2 -----------------------------------------------
// 这一段**不再自己实现**：自举是编译器的内置命令（`omni bootstrap`，见 src/core/bootstrap.js），
// 测试只负责调用它并检查退出码。它比这里原来那段多做两件事 —— 摆出可安装的产物树、
// 让 N1 编译出 N2 并比对两代原生编译器的产出（真正的 stage2）。
if (c1 && !quick) {
  const r = node([cli, 'bootstrap', '-o', join(dir, 'dist')]);
  for (const line of r.out.split('\n')) {
    if (line.trim()) process.stdout.write(`    ${line.trim()}\n`);
  }
  if (r.code === 0) ok('omni bootstrap  layout + C1/C2 + C path + stage2');
  else bad('omni bootstrap', `    exit=${r.code}\n${r.err}`);

  // ---- 阶段 6：原生编译器上的 `run` --------------------------------------------
  // 那一代没有 JS 引擎，`run` 于是走 C 路径（cli.js 里先问 hasJsEngine 再决定）。
  // 门槛是**逐字节等于 node 上 run 的输出**：换了执行方式不等于换了语义。
  // 产物只落 dist：核心就是 `dist/omni`（ADR-0021 的 S4；从前是 dist/src/host/omni）
  const n1 = join(dir, 'dist', 'omni');
  if (r.code === 0) {
    const sample2 = join(root, 'tests', 'cases', '01_basics.omni');
    const ref = spawnSync('node', [cli, 'run', sample2], { encoding: 'utf8' });
    const via = spawnSync(n1, ['run', sample2], { encoding: 'utf8' });
    if (via.status !== 0) bad('N1 run cases/01_basics', `    exit=${via.status}\n${via.stderr}`);
    else if (via.stdout !== ref.stdout) bad('N1 run == C0 run', `    C0 ${ref.stdout.length} bytes != N1 ${via.stdout.length} bytes`);
    else ok(`N1 run cases/01_basics == C0 run  ${ref.stdout.length} bytes`);
  }

  // ---- 阶段 7：原生编译器上的解释器 -----------------------------------------------
  // 这一代既没有 JS 引擎也不一定有 cc，`interp` 是它唯一不依赖外部工具的执行路径
  // （ADR-0013）。门槛同上：逐字节等于 node 上 run 的输出。解释器本身在这一代里
  // 是 C —— 这条门槛因此也是"解释器能被自己的后端编译出来"的证明。
  if (r.code === 0) {
    const sample3 = join(root, 'tests', 'cases', '08_container_stress.omni');
    const ref = spawnSync('node', [cli, 'run', sample3], { encoding: 'utf8' });
    const via = spawnSync(n1, ['interp', sample3], { encoding: 'utf8' });
    if (via.status !== 0) bad('N1 interp cases/08_container_stress', `    exit=${via.status}\n${via.stderr}`);
    else if (via.stdout !== ref.stdout) bad('N1 interp == C0 run', `    C0 ${ref.stdout.length} bytes != N1 ${via.stdout.length} bytes`);
    else ok(`N1 interp cases/08_container_stress == C0 run  ${ref.stdout.length} bytes`);
  }

  // ---- 阶段 8：原生编译器上的 WAT 前端 -------------------------------------------
  // 新前端最容易踩的坑不是逻辑错，是**用了封闭 ABI 之外的东西**（ADR-0011 决策 2）：
  // node 上 `labels.findLastIndex(...)` 照跑，原生构建里它变成"在 list 上取属性"当场报错。
  // 量过一次，就是这么掉进去的 —— 所以让 N1 亲自读一遍 .wat，这类洞只有这条门槛能守。
  if (r.code === 0) {
    const sample4 = join(root, 'tests', 'wat', 'cases', '01-numeric.wat');
    const ref = spawnSync('node', [cli, 'interp', sample4], { encoding: 'utf8' });
    const via = spawnSync(n1, ['interp', sample4], { encoding: 'utf8' });
    if (via.status !== 0) bad('N1 interp wat/01-numeric', `    exit=${via.status}\n${via.stderr}`);
    else if (via.stdout !== ref.stdout) bad('N1 interp wat == C0 interp', `    C0 ${JSON.stringify(ref.stdout)}\n    N1 ${JSON.stringify(via.stdout)}`);
    else ok(`N1 interp wat/01-numeric == C0 interp  ${ref.stdout.length} bytes`);
  }

  // ---- 阶段 9：原生编译器上的 GLR ------------------------------------------------
  // 同一条理由（见阶段 8），换一段更险的代码：GLR 那四个文件里 Map/Set 用得比 WAT 前端多，
  // 还有 `[...set].sort()`、对象展开 `{...g}`、`Array.prototype.find/filter` 这些容易越界的
  // 写法。三步都要跟 C0 逐字节相同：构表、分析出树、真歧义要报错 ——
  // 错误路径跟成功路径一样容易踩封闭 ABI（诊断格式化那一段全是字符串操作）。
  if (r.code === 0) {
    const gExpr = join(root, 'tests', 'glr', 'grammars', 'expr.grammar');
    const gDang = join(root, 'tests', 'glr', 'grammars', 'dangling.grammar');
    const inExpr = join(dir, 'glr-expr.in');
    const inAmbig = join(dir, 'glr-ambig.in');
    writeFileSync(inExpr, '-1+2*3^4^5\n');
    writeFileSync(inAmbig, 'if a then if b then x else y\n');
    const both = (label, args, wantFail) => {
      const ref = spawnSync('node', [cli, ...args], { encoding: 'utf8' });
      const via = spawnSync(n1, args, { encoding: 'utf8' });
      const refOut = wantFail ? ref.stderr : ref.stdout;
      const viaOut = wantFail ? via.stderr : via.stdout;
      if (wantFail ? via.status === 0 : via.status !== 0) {
        bad(`N1 ${label}`, `    exit=${via.status} (wanted ${wantFail ? 'failure' : 'success'})\n${via.stderr}`);
      } else if (viaOut !== refOut) {
        bad(`N1 ${label} == C0`, `    C0 ${JSON.stringify(refOut)}\n    N1 ${JSON.stringify(viaOut)}`);
      } else {
        ok(`N1 ${label} == C0  ${refOut.length} bytes`);
      }
    };
    both('glr-table expr', ['glr-table', gExpr], false);
    both('glr expr', ['glr', gExpr, inExpr], false);
    both('glr dangling (ambiguous)', ['glr', gDang, inAmbig], true);

    // 再加一条 jancy：`(prefer N)` 和按偏好剪支那段只在**声明过偏好**的语法上才走到，
    // expr/dangling 两份都没声明，等于那段代码在原生构建里从没被碰过。顺带压一遍
    // 632 状态的构表（前三条的表都只有几十个状态，Map 的负载完全不是一个量级）。
    // `C1* c;` 是那三处真歧义之一 —— 它非要走剪支才能只剩一棵树。
    //
    // 这一条要 14s（node 1.8s + 原生 9s，另有 clang 那边的常数）：原生构表比 node 慢 5 倍，
    // 慢在 Map 上。这个比值本身是要记住的数 —— C 后端的 Map/Set 是待优化项，不是这条门槛的问题。
    const gJnc = join(root, 'src', 'core', 'frontend-jnc', 'jnc.grammar');
    const inJnc = join(dir, 'glr-jnc.in');
    writeFileSync(inJnc, 'class C1 { int m_x; }\nC1* c;\nint f(int a) { return a * 2; }\n');
    both('glr jnc (prefer)', ['glr', gJnc, inJnc], false);

    // 还有一条 asymptote：`(fuse ID "operator" ...)` 那条词法规则**只有这份语法用**，
    // 于是 matchFuse 在原生构建里一次都没被碰过 —— 那段全是 startsWith / charCodeAt /
    // 模板串拼接，正是封闭 ABI 最容易漏的一类。输入里三样东西各占一条：算符重载的声明、
    // 把算符当值传、`new T[]{...}` 那处靠优先级消掉的歧义。
    const gAsy = join(root, 'src', 'core', 'frontend-asy', 'asy.grammar');
    const inAsy = join(dir, 'glr-asy.in');
    writeFileSync(inAsy, 'real operator +(real a, real b) { return a; }\nx = fold(operator ^^, a);\nreal[] d = new real[] {1, 2};\n');
    both('glr asy (fuse)', ['glr', gAsy, inAsy], false);
  }

  // ---- 阶段 10：原生编译器上的 MIR 与增量缓存 -----------------------------------
  // MIR 在这条门槛之前**从没在原生构建里跑过** —— 它一进来就抓到 `ir.js` 里的
  // `kind | (log << 5)`：封闭 ABI 的 js_bitop 只对 bigint 成立，而这些量在 JS 子集里
  // 全是 real，于是 node 上照跑、原生构建里报「bitwise '>' requires bigint operands」。
  // 这正是阶段 8/9 那条理由的第三次复现：新代码的洞不在逻辑里，在**用了子集外的东西**。
  if (r.code === 0) {
    const caseMir = join(root, 'tests', 'cases', '01_basics.omni');
    const ref = spawnSync('node', [cli, 'interp', caseMir, '--mir'], { encoding: 'utf8' });
    const via = spawnSync(n1, ['interp', caseMir, '--mir'], { encoding: 'utf8' });
    if (via.status !== 0) bad('N1 interp --mir cases/01_basics', `    exit=${via.status}\n${via.stderr}`);
    else if (via.stdout !== ref.stdout) bad('N1 interp --mir == C0', `    C0 ${JSON.stringify(ref.stdout)}\n    N1 ${JSON.stringify(via.stdout)}`);
    else ok(`N1 interp --mir cases/01_basics == C0  ${ref.stdout.length} bytes`);

    // 非 ASCII 那条路单列一条：UTF-8 的编解码在 `interp/builtin.js` 里是手写的
    // （TextEncoder 不在封闭 ABI 里），而它整段只有非 ASCII 才走到 —— 上面那份用例
    // 一个字节都碰不到它。切在多字节字符中间是刻意的：非法序列的落法也要两代一致。
    const u8 = join(dir, 'utf8.omni');
    writeFileSync(u8, 'string s = "héllo 中文 😀";\nprint(s.length);\nprint(s);\nprint(s.byteAt(1));\nprint(s.substr(6, 3));\n');
    const uRef = spawnSync('node', [cli, 'interp', u8], { encoding: 'utf8' });
    const uVia = spawnSync(n1, ['interp', u8], { encoding: 'utf8' });
    if (uVia.status !== 0) bad('N1 interp utf8', `    exit=${uVia.status}\n${uVia.stderr}`);
    else if (uVia.stdout !== uRef.stdout) bad('N1 interp utf8 == C0', `    C0 ${JSON.stringify(uRef.stdout)}\n    N1 ${JSON.stringify(uVia.stdout)}`);
    else ok(`N1 interp utf8 == C0  ${uRef.stdout.length} bytes`);

    // LLVM 后端也只有这条门槛能证它在封闭 ABI 里成立（它是新代码，而且原生构建里
    // 走的是另一套 Map/字符串实现）。比的是**发出来的 IR 文本**，不是跑的结果 ——
    // 文本一样就说明降级的每一步在两代里都一样；跑的结果由 tests/llvm 那条轴管。
    // 用 02_numeric 而不是 01_basics：第一阶段只降标量，01_basics 里有容器，会被拒。
    const caseLl = join(root, 'tests', 'cases', '02_numeric.omni');
    const llRef = spawnSync('node', [cli, 'emit-llvm', caseLl], { encoding: 'utf8' });
    const llVia = spawnSync(n1, ['emit-llvm', caseLl], { encoding: 'utf8' });
    if (llVia.status !== 0) bad('N1 emit-llvm cases/02_numeric', `    exit=${llVia.status}\n${llVia.stderr}`);
    else if (llVia.stdout !== llRef.stdout) bad('N1 emit-llvm == C0', `    C0 ${llRef.stdout.length} bytes != N1 ${llVia.stdout.length} bytes`);
    else ok(`N1 emit-llvm cases/02_numeric == C0  ${llRef.stdout.length} bytes`);

    // 第二阶段（字符串）也要一条：`[2 x i64]` 的 ABI 之外，字符串常量要经 utf8Bytes
    // 发成一段 `[N x i8]`，而那个函数是**两个后端共用**的（host/utf8.js）。
    // 挑这份 case 是因为它里面有 CJK 与 emoji：非 ASCII 才走得到多字节那几支，
    // 而那几支只用加乘取模写（封闭 ABI 没有位运算），两代算出不同字节的话
    // 症状是「原生编译器发的 IR 里字符串是乱码」—— node 上永远看不出来。
    const caseStr = join(root, 'tests', 'sexpr', 'cases', '02-strings.sx');
    const sRef = spawnSync('node', [cli, 'emit-llvm', caseStr], { encoding: 'utf8' });
    const sVia = spawnSync(n1, ['emit-llvm', caseStr], { encoding: 'utf8' });
    if (sVia.status !== 0) bad('N1 emit-llvm sexpr/02-strings', `    exit=${sVia.status}\n${sVia.stderr}`);
    else if (sVia.stdout !== sRef.stdout) bad('N1 emit-llvm strings == C0', `    C0 ${sRef.stdout.length} bytes != N1 ${sVia.stdout.length} bytes`);
    else ok(`N1 emit-llvm sexpr/02-strings == C0  ${sRef.stdout.length} bytes`);

    // SIMD 第一阶段（ADR-0014 门槛 6）。这条门槛的原生风险不在向量本身，在**宽度的编码**：
    // `t` 的高 3 位放的是宽度的对数，而 mkType/typeLanes 只能用乘除取模算（封闭 ABI 的
    // js_bitop 只对 bigint 成立，ADR-0011 决策 2）。两代算出不同的宽度，症状是
    // 「原生编译器发的 IR 里 <4 x double> 变成了 <1 x double>」—— node 上永远看不出来。
    // 两条腿都比：LLVM 那条是 `<N x T>` + insert/extract，C 那条是 typedef + 标量化助手。
    const caseSimd = join(root, 'tests', 'sexpr', 'cases', '03-simd.sx');
    for (const cmd of ['emit-llvm', 'emit-c']) {
      const vRef = spawnSync('node', [cli, cmd, caseSimd], { encoding: 'utf8' });
      const vVia = spawnSync(n1, [cmd, caseSimd], { encoding: 'utf8' });
      if (vVia.status !== 0) bad(`N1 ${cmd} sexpr/03-simd`, `    exit=${vVia.status}\n${vVia.stderr}`);
      else if (vVia.stdout !== vRef.stdout) bad(`N1 ${cmd} simd == C0`, `    C0 ${vRef.stdout.length} bytes != N1 ${vVia.stdout.length} bytes`);
      else ok(`N1 ${cmd} sexpr/03-simd == C0  ${vRef.stdout.length} bytes`);
    }

    // 缓冲 + kernel/dispatch（ADR-0014 门槛 7）。三条腿都比：C 与 LLVM 是 CPU 那一半，
    // SPIR-V 是 GPU 那一半。SPIR-V 这条在原生构建里的风险很具体 —— 那份发射器全靠
    // Map 记 id、靠字符串拼指令，而原生构建里 Map 与字符串是另一套实现（封闭 ABI）。
    // 两代发出不同的 id 编号或不同的装饰顺序，症状是「原生编译器发的模块 spirv-as 不认」
    // 或者更糟：认了，但描述符绑到了别的 binding 上。node 上永远看不出来。
    const caseBuf = join(root, 'tests', 'sexpr', 'cases', '04-buffers.sx');
    for (const cmd of ['emit-llvm', 'emit-c']) {
      const bRef = spawnSync('node', [cli, cmd, caseBuf], { encoding: 'utf8' });
      const bVia = spawnSync(n1, [cmd, caseBuf], { encoding: 'utf8' });
      if (bVia.status !== 0) bad(`N1 ${cmd} sexpr/04-buffers`, `    exit=${bVia.status}\n${bVia.stderr}`);
      else if (bVia.stdout !== bRef.stdout) bad(`N1 ${cmd} buffers == C0`, `    C0 ${bRef.stdout.length} bytes != N1 ${bVia.stdout.length} bytes`);
      else ok(`N1 ${cmd} sexpr/04-buffers == C0  ${bRef.stdout.length} bytes`);
    }
    for (const kn of ['saxpy', 'bump']) {
      const gRef = spawnSync('node', [cli, 'emit-spirv', caseBuf, '--kernel', kn], { encoding: 'utf8' });
      const gVia = spawnSync(n1, ['emit-spirv', caseBuf, '--kernel', kn], { encoding: 'utf8' });
      if (gVia.status !== 0) bad(`N1 emit-spirv ${kn}`, `    exit=${gVia.status}\n${gVia.stderr}`);
      else if (gVia.stdout !== gRef.stdout) bad(`N1 emit-spirv ${kn} == C0`, `    C0 ${gRef.stdout.length} bytes != N1 ${gVia.stdout.length} bytes`);
      else ok(`N1 emit-spirv ${kn} == C0  ${gRef.stdout.length} bytes`);
    }

    // ---- 核心 S 表达式方言 + $*k 摊平（ADR-0014 决策 1）
    // 走的是整条链：mini 的 grammar -> `omni glr`（摊平在这里）-> 核心方言文本 ->
    // `omni run`（sexpr/lower.js 在这里）。两代都得给同一份文本、同一份输出。
    // 分两条断言而不是一条：文本对不上是摊平错了，文本对了输出不对是降级错了 ——
    // 一条断言看不出是哪头。
    const gMini = join(root, 'tests', 'glr', 'grammars', 'mini.grammar');
    const inMini = join(root, 'tests', 'sexpr', 'mini', '01-basics.mini');
    const sxRef = spawnSync('node', [cli, 'glr', gMini, inMini], { encoding: 'utf8' });
    const sxVia = spawnSync(n1, ['glr', gMini, inMini], { encoding: 'utf8' });
    if (sxVia.status !== 0) bad('N1 glr mini', `    exit=${sxVia.status}\n${sxVia.stderr}`);
    else if (sxVia.stdout !== sxRef.stdout) bad('N1 glr mini == C0', `    C0 ${JSON.stringify(sxRef.stdout)}\n    N1 ${JSON.stringify(sxVia.stdout)}`);
    else {
      const sx = join(dir, 'mini.sx');
      writeFileSync(sx, sxVia.stdout);
      const runRef = spawnSync('node', [cli, 'run', sx], { encoding: 'utf8' });
      const runVia = spawnSync(n1, ['run', sx], { encoding: 'utf8' });
      if (runVia.status !== 0) bad('N1 run mini.sx', `    exit=${runVia.status}\n${runVia.stderr}`);
      else if (runVia.stdout !== runRef.stdout) bad('N1 run mini.sx == C0', `    C0 ${JSON.stringify(runRef.stdout)}\n    N1 ${JSON.stringify(runVia.stdout)}`);
      else ok(`N1 glr mini -> run .sx == C0  ${sxRef.stdout.length} + ${runRef.stdout.length} bytes`);
    }

    // ---- ORC JIT（ADR-0014 决策 3 第二阶段）
    // 宿主是 C 代码，不由 Omni 编译；这条门槛管的是 cli.js 里那段新的 Omni 子集代码
    // （findLlvmConfig / buildJitHost / runViaJit：llvm-config 的三次 spawn、内容寻址
    // 缓存键、一串 -I/-L 参数拼装）。而且它顺带证了 dist/jit/ 真被带走了 ——
    // 布局漏一个目录的症状是"原生那一代根本没有 JIT"，node 上永远看不出来。
    // 环境里没有 libLLVM 就跳过：这条轴不该让整条自举链变成"必须装 LLVM"。
    const caseJit = join(root, 'tests', 'cases', '02_numeric.omni');
    const jitRef = spawnSync('node', [cli, 'run-jit', caseJit], { encoding: 'utf8' });
    if (jitRef.status !== 0 && /llvm-config|libLLVM|jit host/.test(jitRef.stderr)) {
      ok('N1 run-jit  skipped (no libLLVM in this environment)');
    } else {
      const jitVia = spawnSync(n1, ['run-jit', caseJit], { encoding: 'utf8' });
      if (jitVia.status !== 0) bad('N1 run-jit cases/02_numeric', `    exit=${jitVia.status}\n${jitVia.stderr}`);
      else if (jitVia.stdout !== jitRef.stdout) bad('N1 run-jit == C0', `    C0 ${JSON.stringify(jitRef.stdout)}\n    N1 ${JSON.stringify(jitVia.stdout)}`);
      else ok(`N1 run-jit cases/02_numeric == C0  ${jitRef.stdout.length} bytes`);
    }
  }

  // 增量：这一条钉的不是"跑得通"，是**缓存键在两代之间相同**。键是 hash16(规范化文本)，
  // 而 hash16 只用加乘取模、刻意不用位运算，就是为了 node 与原生给出同一个值
  // （见 host/hash.js 文件头）。哪天它们分叉，N1 写下的缓存条目 C0 就认不出来，
  // 而那种 bug 不会报错 —— 只会表现成"缓存永远不命中"。所以逐字节对。
  // 两代各用自己的缓存目录，否则第二个跑的那个会去命中第一个写的条目。
  if (r.code === 0) {
    const caseIncr = join(root, 'tests', 'cases', '01_basics.omni');
    const cacheRef = join(dir, 'incr-c0');
    const cacheVia = join(dir, 'incr-n1');
    const args = ['incr', caseIncr, '--list', '--cache'];
    const ref = spawnSync('node', [cli, ...args, cacheRef], { encoding: 'utf8' });
    const via = spawnSync(n1, [...args, cacheVia], { encoding: 'utf8' });
    if (via.status !== 0) bad('N1 incr cases/01_basics', `    exit=${via.status}\n${via.stderr}`);
    else if (via.stdout !== ref.stdout) bad('N1 incr == C0 incr', `    C0 ${JSON.stringify(ref.stdout)}\n    N1 ${JSON.stringify(via.stdout)}`);
    else {
      // 再跑一遍：条目是原生这一代自己写的，它必须认得（落盘 + 读回 + 键复算）
      const warm = spawnSync(n1, [...args, cacheVia], { encoding: 'utf8' });
      const line = warm.stdout.trim().split('\n').pop();
      if (!/ hit=(\d+) miss=0 /.test(line)) bad('N1 incr warm', `    第二遍应该全命中，实得 ${JSON.stringify(line)}`);
      else ok(`N1 incr cases/01_basics == C0  ${ref.stdout.length} bytes，第二遍 ${line}`);
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
