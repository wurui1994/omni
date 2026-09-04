// tests/glsl/fast.js —— 快路的**对账门**（ADR-0019 决策六，开工单第 4 步的前一半）
//
// 「对账门先立、下限门后立」—— 顺序反了就会为了数字牺牲正确性。所以这一门只查一件事：
//
//   **快路（8 道 f32 -> LLVM IR -> clang）与参照实现（标量摊分量 -> 核心方言 -> JS 腿）
//   在同样的取样点上算出同样的四个通道。**
//
// 容差：相对 `1e-5`。两边的算术**本来就不同精度**（f32 对 f64），所以逐字节相同是错的
// 期望；`1e-5` 是 f32 的有效位数（约 7 位十进制）留一位余量。
//
// 顺带印一行 MPix/s（1024²）—— 这是数，不是断言。下限门等第 3 步（框架那一半）做完再立。
//
// 第四段是 **v2（进程内 ORC JIT）**（决策七开工单第 2、3 步）：同一份 `frag.ll` 换装载
// 方式，与 v1 **逐字节**比，外加一条「编一个变体 ≤ 20 ms」的预算门 —— 那才是复刻
// llvmpipe 的路径，clang AOT 是支路。
//
//   node tests/glsl/fast.js

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { readSexpr } from '../../src/core/sexpr/read.js';
import { readGrammar } from '../../src/core/glr/grammar.js';
import { buildTable } from '../../src/core/glr/table.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';
import { glslLower } from '../../src/core/frontend-glsl/lower.js';
import { glslEmitLlvm } from '../../src/core/frontend-glsl/emit_llvm.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');
const DRIVER = join(here, 'fast_driver.c');
const OUT = join(tmpdir(), 'omni-glsl-fast');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/** 与 `fast_driver.c` 里那两行**一字不差**的取样点。 */
const SX = [0.5, 511.5, 0.5, 511.5, 100.5, 1023.5, 37.5, 700.5];
const SY = [0.5, 0.5, 511.5, 511.5, 200.5, 1023.5, 900.5, 13.5];
const RES = 1024;

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function checked(path) {
  const src = readFileSync(path, 'utf8');
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(path, src), diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslCheck(tree, 'frag');
}

const mod = checked(join(CASES, 'bench-simple.frag'));

/* ---- 一、参照实现（标量 -> 核心方言 -> JS 腿）在取样点上的值 ---------------- */

const lib = glslLower(mod).trimEnd();
const driver = SX.map((x, i) => `    (let p${i} glsl_v4 (call glsl_frag (real ${x}) (real ${SY[i]}) (real ${RES}.0) (real ${RES}.0)))\n`
  + `    (print (fld (var p${i}) c0))\n    (print (fld (var p${i}) c1))\n`
  + `    (print (fld (var p${i}) c2))\n    (print (fld (var p${i}) c3))`).join('\n');
const sxPath = join(OUT, 'ref.sx');
writeFileSync(sxPath, `${lib.slice(0, -1)}\n  (main\n${driver})\n)\n`);
const refRun = spawnSync(process.execPath, [CLI, 'run', sxPath], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (refRun.status !== 0) {
  bad('参照实现跑不动', `    ${(refRun.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  ok('参照实现（标量 -> 方言 -> JS 腿）跑起来了');
}
const ref = (refRun.stdout ?? '').trim().split('\n').map(Number);

/* ---- 二、快路（8 道 f32 -> LLVM IR -> clang） ------------------------------- */

const llPath = join(OUT, 'frag.ll');
writeFileSync(llPath, glslEmitLlvm(mod));
const exe = join(OUT, 'fast');
const cc = process.env.OMNI_CLANG ?? 'clang';
/* 没有 clang 就**跳过整门**（`OMNI_CLANG` 可指一个）。快路本来就是 LLVM 那条路，
 * 没有 clang 谈不上 —— 但那不该让别的门连带红。 */
if (spawnSync(cc, ['--version'], { encoding: 'utf8' }).status !== 0) {
  process.stdout.write(`  skip 没有 ${cc}（快路要它；OMNI_CLANG 可指一个）\n\n0 passed, 0 failed\n`);
  process.exit(0);
}
const build = spawnSync(cc, ['-O2', '-w', DRIVER, llPath, '-lm', '-o', exe], { encoding: 'utf8' });
if (build.status !== 0) {
  bad('快路编不过', `    ${(build.stderr ?? '').trim().split('\n').slice(0, 6).join('\n    ')}`);
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
ok('快路编出来了（emit_llvm -> clang -O2）');

const sam = spawnSync(exe, ['samples', String(RES)], { encoding: 'utf8' });
/* v2（第四段）要与它**逐字节**比 —— 同一份 IR 换装载方式，答案不许变。 */
let v1Samples = null;
if (sam.status !== 0) {
  bad('快路跑不动', `    ${(sam.stderr ?? '').trim().slice(0, 200)}`);
} else {
  v1Samples = sam.stdout;
  const got = sam.stdout.trim().split('\n').flatMap((l) => l.trim().split(/\s+/).map(Number));
  if (ref.length !== got.length) {
    bad('两边的数不一样多', `    参照 ${ref.length} 个、快路 ${got.length} 个`);
  } else {
    const bads = [];
    for (let i = 0; i < ref.length; i++) {
      const a = ref[i];
      const b = got[i];
      const rel = Math.abs(a - b) / Math.max(1e-6, Math.abs(a));
      if (!(rel <= 1e-5)) bads.push(`第 ${i} 个（像素 ${Math.floor(i / 4)} 通道 ${i % 4}）：参照 ${a}、快路 ${b}（相对差 ${rel.toExponential(2)}）`);
    }
    if (bads.length > 0) bad('逐取样点对账', bads.slice(0, 6).map((s) => `    ${s}`).join('\n'));
    else ok(`逐取样点对账：8 个像素 × 4 通道，相对差都 ≤ 1e-5`);
  }
}

/* ---- 三、下限门（决策六：没有下限的性能表只是记录，不是验收） ------------------
 *
 * `100` 是这么来的：同一类算术、同一台机、`clang -O2` 手写 8 道 f32 量到的天花板是
 * 178 MPix/s（`soa_ceiling.c`），留 40% 余量。llvmpipe 单核 Simple 是 160～315，
 * 所以这一档只是「进了同一个量级」，不是终点。
 *
 * **这道门是在对账门绿了之后才立的**（开工单第 4 步那句话）：反过来的话，
 * 输出全 0 那一版会以 277 MPix/s 通过 —— 那一版 clang 把大半计算删了。 */
const FLOOR = Number(process.env.OMNI_GLSL_FLOOR ?? 100);
const bench = spawnSync(exe, ['bench', String(RES), '3'], { encoding: 'utf8' });
if (bench.status === 0) {
  const mp = /MPix\/s (\S+)/.exec(bench.stdout);
  const ms = /ms (\S+)/.exec(bench.stdout);
  const got = mp === null ? 0 : Number(mp[1]);
  const line = `快路 ${RES}²：${ms === null ? '?' : ms[1]} ms、${got} MPix/s`;
  if (got >= FLOOR) ok(`${line} ≥ 下限 ${FLOOR}（天花板 178；参照实现那条路的框架上限是 32.77）`);
  else {
    bad(`${line} < 下限 ${FLOOR}`,
      '    快路的意义就是这个数。低于下限说明形状还不对 —— 别调下限，去查形状\n'
      + '    （ADR-0019 决策六：着色器那一半 SoA、框架那一半每 quad 一个掩码）。');
  }
} else {
  bad('快路的 bench 跑不动', `    ${(bench.stderr ?? '').trim().slice(0, 200)}`);
}

/* ---- 四、快路 v2（进程内 ORC JIT）—— 这条才是「复刻 llvmpipe」 -------------------
 *
 * 同一份 `frag.ll`，换一种装载方式：不 exec 一个编好的二进制，而是把文本 IR 送进
 * ORC，惰性物化，查到地址就跳进去（`src/jit/omni_jit.c`）。这与 `tests/jit` 那条轴
 * 是同一条纪律：**换装载方式，答案不许变。**
 *
 * 驱动这一半仍然是 clang 出的 IR 一起拼进去 —— 真 llvmpipe 里框架是 AOT 的原生码、
 * 只有着色器过 JIT，所以「框架搬进宿主、靠进程符号搜索连过去」是后面一格。这里先把
 * 「着色器 IR 过 ORC 出的答案与过 clang 出的答案一致」钉住。
 *
 * 三处只有真跑起来才会发现的坑（ADR-0019「量：v2 的编译耗时」那一节）：
 *   - clang 出的 `declare @glsl_frag8` 与我们的 `define` 在**同一份 `.ll`** 里算重复定义
 *   - clang 带的 `"probe-stack"="__chkstk_darwin"` 会让 ORC 直接
 *     `LLVM ERROR: Unsupported stack probing method` 而 abort
 *   - 两边**都** `declare` 的 intrinsic（驱动的量化用 `llvm.maxnum.v8f32`、我们的 `||`
 *     也用它）：文本 IR 里两条 `declare` 的属性列表不一样就算 `invalid redefinition`
 * 所以拼之前要剥这三样。我们自己发射的 IR 一个函数属性都不带，不需要剥。 */

/** 把 clang 出的驱动 IR 改造成「能与我们的 frag 拼在一份 `.ll` 里」的样子。 */
function jitReady(text, frag) {
  /* frag 里已经 declare 过的，驱动那一侧就得让位 —— 留下的是**没有属性**那一条。 */
  const mine = new Set([...frag.matchAll(/^declare\s+.*?(@[\w.]+)\(/gm)].map((m) => m[1]));
  return text.split('\n')
    .filter((l) => !/^declare\s+void\s+@glsl_frag8\b/.test(l))
    .filter((l) => {
      const m = /^declare\s+.*?(@[\w.]+)\(/.exec(l);
      return m === null || !mine.has(m[1]);
    })
    .join('\n')
    .replaceAll('"probe-stack"="__chkstk_darwin" ', '');
}

const drvLl = join(OUT, 'drv.ll');
const emitDrv = spawnSync(cc, ['-O2', '-w', '-emit-llvm', '-S', DRIVER, '-o', drvLl], { encoding: 'utf8' });
const combPath = join(OUT, 'comb.ll');
const emptyPath = join(OUT, 'empty.ll');
writeFileSync(emptyPath, 'define i32 @main(i32 %c, ptr %v) {\nentry:\n  ret i32 0\n}\n');

/** ORC 宿主的路径：`run-jit --verbose` 自己会印出来（内容寻址缓存，第二次起是 cache hit）。 */
function jitHost() {
  const probe = spawnSync(process.execPath,
    [CLI, 'run-jit', join(root, 'tests', 'cases', '02_numeric.omni'), '--verbose'],
    { encoding: 'utf8' });
  const m = /jit host\s+(?:cache hit|built.*->)\s+(\S+)/.exec(probe.stderr ?? '');
  if (m !== null) return m[1];
  return { why: (probe.stderr ?? '').trim().split('\n').filter((l) => /llvm-config|libLLVM|jit host/.test(l))[0] ?? 'run-jit 没有印出宿主路径' };
}

/** 跑一次宿主，返回 [退出码, stdout, 墙钟 ms, stderr]。
 *
 * `--` 之前是宿主自己的位置参数（`.ll`、可选的符号名），之后才是**给被调 main 的**
 * 命令行参数。少了这个 `--`，`samples` 会被当成要查的符号名（第一版就是这么红的：
 * `Symbols not found: [ _samples ]`）。 */
function jitRun(host, ll, args) {
  const t0 = process.hrtime.bigint();
  const argv = args.length === 0 ? [ll] : [ll, '--', ...args];
  const r = spawnSync(host, argv, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return [r.status, r.stdout ?? '', Number(process.hrtime.bigint() - t0) / 1e6, r.stderr ?? ''];
}

const host = jitHost();
if (emitDrv.status !== 0) {
  bad('驱动编不成 IR', `    ${(emitDrv.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
} else if (typeof host !== 'string') {
  process.stdout.write(`  skip v2（ORC）：${host.why}\n`);
} else {
  const frag = readFileSync(llPath, 'utf8');
  writeFileSync(combPath, `${jitReady(readFileSync(drvLl, 'utf8'), frag)}\n${frag}`);
  const [code, out, , err] = jitRun(host, combPath, ['samples', String(RES)]);
  if (code !== 0) {
    bad('v2（ORC）跑不动', `    exit=${code}\n    ${err.trim().split('\n').slice(0, 4).join('\n    ')}`);
  } else {
    const got = out.trim().split('\n').flatMap((l) => l.trim().split(/\s+/).map(Number));
    /* 与 v1 比的是**字节相同**，不是容差内相同：同一份 IR、同一个 LLVM，
     * 只是装载方式不同 —— 有任何差就说明装载这一步改了语义。 */
    if (v1Samples === null) bad('v2 没法与 v1 比', '    v1 那一段没跑出数来');
    else if (out.trim() !== v1Samples.trim()) {
      bad('v2（ORC）与 v1（clang AOT）不是同一个答案',
        `    同一份 IR 换装载方式，输出必须逐字节相同\n    v1 ${JSON.stringify(v1Samples.trim().slice(0, 80))}\n    v2 ${JSON.stringify(out.trim().slice(0, 80))}`);
    } else ok('v2（ORC）与 v1（clang AOT）逐字节相同：换装载方式，答案没变');

    const bads = [];
    for (let i = 0; i < ref.length && i < got.length; i++) {
      const rel = Math.abs(ref[i] - got[i]) / Math.max(1e-6, Math.abs(ref[i]));
      if (!(rel <= 1e-5)) bads.push(`第 ${i} 个：参照 ${ref[i]}、v2 ${got[i]}（相对差 ${rel.toExponential(2)}）`);
    }
    if (bads.length > 0) bad('v2 逐取样点对账', bads.slice(0, 6).map((s) => `    ${s}`).join('\n'));
    else ok('v2 逐取样点对账：8 个像素 × 4 通道，与参照实现相对差都 ≤ 1e-5');

    /* ---- 编译耗时的门（决策七开工单第 2 步）--------------------------------------
     *
     * 立在**运行时路径**（ORC）上。开工单原话是「clang 那条也立、红得对」，改了：
     * 长期红的门是噪声，而 clang AOT 本来就不是运行时路径 —— 它的数在这儿只印出来
     * 做对照，不断言。
     *
     * 量法照 ADR 那一节：`空模块` 摊掉进程启动 + LLJIT 初始化，差值才是编译。
     * `samples` 模式只做一次 8 道调用，执行在编译面前可忽略（量到 0.04 ms）。
     * 每边取 5 次最小值 —— 第一次总是冷的（页缓存 + dyld）。 */
    const minOf = (n, f) => { let b = Infinity; for (let i = 0; i < n; i++) { const t = f(); if (t < b) b = t; } return b; };
    const base = minOf(5, () => jitRun(host, emptyPath, [])[2]);
    const full = minOf(5, () => jitRun(host, combPath, ['samples', String(RES)])[2]);
    const compileMs = full - base;
    const BUDGET = Number(process.env.OMNI_GLSL_JIT_BUDGET ?? 20);
    const line = `v2 编一个变体：${compileMs.toFixed(1)} ms（装载 ${full.toFixed(1)} - 空模块基线 ${base.toFixed(1)}）`;
    if (compileMs <= BUDGET) ok(`${line} ≤ 预算 ${BUDGET} ms（llvmpipe 编一个片元变体是 1～20 ms）`);
    else {
      bad(`${line} > 预算 ${BUDGET} ms`,
        '    这是**交互式**路径的耗时：改一个开关就换一个变体。超了不是「慢一点」，是卡一下。\n'
        + '    别调预算 —— 先看是不是发射的 IR 体量涨了（成本跟机器码体量成正比，不跟 IR 字节数）。');
    }

    const [bcode, bout] = jitRun(host, combPath, ['bench', String(RES), '3']);
    if (bcode === 0) {
      const mp = /MPix\/s (\S+)/.exec(bout);
      process.stdout.write(`  数    v2（ORC）${RES}²：${mp === null ? '?' : mp[1]} MPix/s（v1 那条的下限门是 ${FLOOR}）\n`);
    }
  }
}

/* ---- 五、bool 那一格：三条路在同一份带 bool 的着色器上对齐 ----------------------
 *
 * `bench-bool.frag` 把 bool 的每一种来路都用上（比较、`&&`/`||`/`!`、`?:`、
 * `isnan`/`isinf`、`lessThan` 那一族、`all`/`any`）。三条路各自算一遍：
 *
 *   参照实现（f64、只算 `?:` 的一支）  vs  v1（clang AOT）  vs  v2（ORC）
 *
 * 与参照实现比是**容差**（f32 对 f64），v1 与 v2 之间是**逐字节**。
 * `?:` 在快路上两支都算，所以这一份里故意留了一处「不该走的那支会出 Inf」
 * （`uv.x > 0.0 ? 1.0/uv.x : 0.0`）—— `select` 是逐道取值，算出来的那格选不中。
 *
 * uniform 签名必须与 `bench-simple.frag` 一样（`fast_driver.c` 的 in 布局是钉死的）。 */
if (typeof host === 'string' && emitDrv.status === 0) {
  const bmod = checked(join(CASES, 'bench-bool.frag'));

  const blib = glslLower(bmod).trimEnd();
  const bdrv = SX.map((x, i) => `    (let p${i} glsl_v4 (call glsl_frag (real ${x}) (real ${SY[i]}) (real ${RES}.0) (real ${RES}.0)))\n`
    + `    (print (fld (var p${i}) c0))\n    (print (fld (var p${i}) c1))\n`
    + `    (print (fld (var p${i}) c2))\n    (print (fld (var p${i}) c3))`).join('\n');
  const bsx = join(OUT, 'bool-ref.sx');
  writeFileSync(bsx, `${blib.slice(0, -1)}\n  (main\n${bdrv})\n)\n`);
  const bref = spawnSync(process.execPath, [CLI, 'run', bsx], { encoding: 'utf8', maxBuffer: 1 << 26 });

  const bll = join(OUT, 'bool.ll');
  writeFileSync(bll, glslEmitLlvm(bmod));
  const bexe = join(OUT, 'bool-fast');
  const bbuild = spawnSync(cc, ['-O2', '-w', DRIVER, bll, '-lm', '-o', bexe], { encoding: 'utf8' });

  if (bref.status !== 0) {
    bad('bool：参照实现跑不动', `    ${(bref.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
  } else if (bbuild.status !== 0) {
    bad('bool：快路编不过', `    ${(bbuild.stderr ?? '').trim().split('\n').slice(0, 6).join('\n    ')}`);
  } else {
    ok('bool：三条路都编出来了（参照实现 + emit_llvm）');
    const want = bref.stdout.trim().split('\n').map(Number);
    const b1 = spawnSync(bexe, ['samples', String(RES)], { encoding: 'utf8' });
    const bcomb = join(OUT, 'bool-comb.ll');
    const bfrag = readFileSync(bll, 'utf8');
    writeFileSync(bcomb, `${jitReady(readFileSync(drvLl, 'utf8'), bfrag)}\n${bfrag}`);
    const [c2, o2, , e2] = jitRun(host, bcomb, ['samples', String(RES)]);

    if (b1.status !== 0) bad('bool：v1 跑不动', `    ${(b1.stderr ?? '').trim().slice(0, 200)}`);
    else {
      const got = b1.stdout.trim().split('\n').flatMap((l) => l.trim().split(/\s+/).map(Number));
      const bads = [];
      for (let i = 0; i < want.length && i < got.length; i++) {
        const rel = Math.abs(want[i] - got[i]) / Math.max(1e-6, Math.abs(want[i]));
        if (!(rel <= 1e-5)) bads.push(`第 ${i} 个（像素 ${Math.floor(i / 4)} 通道 ${i % 4}）：参照 ${want[i]}、快路 ${got[i]}`);
      }
      if (want.length !== got.length) bad('bool：两边的数不一样多', `    参照 ${want.length} 个、快路 ${got.length} 个`);
      else if (bads.length > 0) bad('bool：v1 与参照实现对账', bads.slice(0, 6).map((s) => `    ${s}`).join('\n'));
      else ok('bool：v1 与参照实现逐取样点对账（比较 / && || ! / ?: / isnan / isinf / lessThan / all any）');
    }
    if (c2 !== 0) bad('bool：v2（ORC）跑不动', `    exit=${c2}\n    ${e2.trim().split('\n').slice(0, 4).join('\n    ')}`);
    else if (b1.status === 0 && o2.trim() !== b1.stdout.trim()) {
      bad('bool：v2 与 v1 不是同一个答案',
        `    v1 ${JSON.stringify(b1.stdout.trim().slice(0, 80))}\n    v2 ${JSON.stringify(o2.trim().slice(0, 80))}`);
    } else ok('bool：v2（ORC）与 v1 逐字节相同');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
