#!/usr/bin/env node
// tests/graph/cli.js —— **`omni run --engine graph` 那条命令的门**
//
// `tests/graph/run.js` 量的是"图 × 后端"（库里直接调）；这一份量的是**用户敲的那条命令**：
// 引擎怎么选、语言怎么定、`--backend` 那四条在不在、错了报什么、退出码是几。
//
// 为什么要单独一份：矩阵绿不代表命令能用。这条轴上量过一次教训 —— `--backend interp`
// 会把 `run` 改写成另一个动词，`--engine graph` 要是摆在那张表**后面**就永远走不到
// （与 `.c` 那一处是同一个 bug）。那种事只有从命令行敲一遍才看得见。
//
//   node tests/graph/cli.js
//   node tests/graph/cli.js lua        只跑名字里带 lua 的那几格

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 落出来那份 `.wat` 要交给真引擎跑一遍 —— 这一份把文本装成二进制（V8 才认）
import { watToWasm } from '../../src/core/wasm/assemble.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/core/cli.js');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;

/** 敲一条命令，回 `{ code, out, err }`（out 按行切好，末尾空行去掉）。 */
function omni(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT });
  const out = (r.stdout ?? '').split('\n');
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return { code: r.status ?? 1, out, err: r.stderr ?? '' };
}

/**
 * 一格判据：命令 + 期望退出码 + 期望输出行（`null` = 不比）+ 期望 stderr 里有的那句话。
 * 输出**逐行比**（那是这条轴唯一的判据），stderr 只查"有没有那句人话"。
 */
function check(name, args, want) {
  if (only.length > 0 && !only.some((x) => name.includes(x))) return;
  const got = omni(args);
  const bad = [];
  if (got.code !== want.code) bad.push(`退出码 期望 ${want.code} 得到 ${got.code}`);
  if (want.out !== undefined && want.out !== null
    && JSON.stringify(got.out) !== JSON.stringify(want.out)) {
    bad.push(`输出 期望 ${JSON.stringify(want.out)} 得到 ${JSON.stringify(got.out)}`);
  }
  if (want.head !== undefined && got.out[0] !== want.head) {
    bad.push(`第一行 期望 ${JSON.stringify(want.head)} 得到 ${JSON.stringify(got.out[0])}`);
  }
  if (want.says !== undefined && !got.err.includes(want.says)) {
    bad.push(`stderr 里应该有「${want.says}」，实际是 ${JSON.stringify(got.err.slice(0, 120))}`);
  }
  if (bad.length === 0) { pass++; process.stdout.write(`  ok   ${name}\n`); return; }
  fail++;
  process.stdout.write(`  FAIL ${name}\n${bad.map((b) => `       ${b}\n`).join('')}`);
}

const BASICS = ['15', '120', '7', 'ok'];

// ---- 1) 四条腿各跑一门语言（同一份期望输出 —— 那是矩阵里那条判据的命令行版）
check('lua × interp（默认后端）', ['run', 'ext/lua/examples/basics.lua', '--engine', 'graph'],
  { code: 0, out: BASICS });
check('cpp × wat', ['run', 'ext/cpp/examples/basics.cpp', '--engine', 'graph', '--backend', 'wat'],
  { code: 0, out: BASICS });
check('nim × js', ['run', 'ext/nim/examples/basics.nim', '--engine', 'graph', '--backend', 'js'],
  { code: 0, out: BASICS });
/* 这一格从前点的是 chez —— 那门语言 2026-09-22 迁到公共降级器之后在图这一层不存在了
   （ADR-0044），所以换成还在图上的一门。判的东西一个字没变：`sx` 那条腿只序列化。 */
check('mojo × sx（只序列化，第一行是 (graph）',
  ['run', 'ext/mojo/examples/basics.mojo', '--engine', 'graph', '--backend', 'sx'],
  { code: 0, head: '(graph' });

// ---- 2) 语言怎么定：后缀是默认，`--lang` 盖过它
check('go 按后缀', ['run', 'ext/go/examples/intmath.go', '--engine', 'graph'],
  { code: 0, out: ['15', '120'] });
/* `--lang` 盖过后缀这条规矩不变，只是找一对**都还在图上**的语言来押它：
   `.mojo` 的文件按 `--lang nim` 读 —— 那份语法读不下去，报的是"语法说不通"。
   （从前这一格是 `.lisp` 当 chez 读，两门都迁走了。） */
check('--lang 盖过后缀（.mojo 当 nim 读 -> nim 的语法不认它）',
  ['run', 'ext/mojo/examples/basics.mojo', '--engine', 'graph', '--lang', 'nim'],
  { code: 1 });
check('后缀不认得就报清单', ['run', 'README.md', '--engine', 'graph'],
  { code: 1, says: '这个后缀不认得' });
check('--lang 打错就报认得的那些', ['run', 'ext/lua/examples/basics.lua', '--engine', 'graph', '--lang', 'gsl-no-such'],
  { code: 1, says: '认得的是' });

// ---- 2b) 方言：gsl-shell 与 lua 共用 `.lua`，只能 `--lang` 点名（这就是 --lang 的来由）
check('--lang gsl-shell 读 lua 的例子（继承那份语法 = 基语言一个字都不少）',
  ['run', 'ext/lua/examples/basics.lua', '--engine', 'graph', '--lang', 'gsl-shell'],
  { code: 0, out: BASICS });
{
  /**
   * **方言那一格的判据，两面都要**：
   *   1. `--lang gsl-shell` 认短 lambda（`|x| expr`）—— 那两条产生式是它存在的全部理由
   *      （量出来的：它那 186 份语料里 41 份用这个写法）；
   *   2. **lua 不认**它 —— 假接受比报错坏，所以同一份文件按 lua 读必须干净地报语法错。
   * 这一格原来是"还没接，报 unexpected |"，`ext/gsl-shell/gsl-shell.grammar` 落地那天反过来了。
   */
  const f = join(tmpdir(), 'omni-gsl-lambda.lua');
  writeFileSync(f, 'local f = |x| x + 1\nprint(f(1))\n');
  check('gsl-shell 认短 lambda', ['run', f, '--engine', 'graph', '--lang', 'gsl-shell'],
    { code: 0, out: ['2'] });
  check('lua 不认短 lambda（同一份文件，按后缀就是 lua）', ['run', f, '--engine', 'graph'],
    { code: 1, says: 'unexpected "|"' });

  /**
   * **词法也能叠**那一格（`(lex …)` 在方言里能加）：LuaJIT 带 FFI 的虚数 `1i` 是**记号**
   * 那一层的事（lj_lex.c:105-106 + lj_strscan.c:419-437），产生式加不出来。
   * 两面都要：gsl-shell 读得进去（语料因此 176 → 186/186），lua 仍在词法上就分不开它；
   * 而读进去之后**映射当场报一句有名有姓的话** —— 图这一层没有复数这格值，
   * `Number("1i")` 是 NaN，落成 const 就是个看不出错的错答案。
   */
  const g = join(tmpdir(), 'omni-gsl-imag.lua');
  writeFileSync(g, 'print(1i)\n');
  check('gsl-shell 的 1i 读得进来，但映射说清了它接不住',
    ['run', g, '--engine', 'graph', '--lang', 'gsl-shell'], { code: 1, says: '没有复数' });
  check('lua 连 1i 都不认（词法就分不开）', ['run', g, '--engine', 'graph'],
    { code: 1, says: "unexpected NAME 'i'" });
}

// ---- 3) 缺口不是失败：有名有姓，退出码 3（与"程序自己跑错了"分开）
//
// 原来这一格用的是 `awk × wat`（那时它欠着"一格量既装过串也装过数"）。种类那一趟
// 补上"`nil` 是还没定、不是是数"之后 awk 那份通了 —— **wat 那条腿的语言例子全绿**，
// 于是这条判据得另找一格真欠着的形状。挑"实数 -> 串"（WAT_SHAPES 第四条，f64 的
// 十进制是另一件事），临时写一份最小的源文件 —— 例子目录里没有欠着的了。
{
  const rf = join(tmpdir(), 'omni-real-cat.lua');
  writeFileSync(rf, 'print("x=" .. 1.5)\n');
  check('实数转串在 wat 上是一格有名有姓的缺口（退出码 3）',
    ['run', rf, '--engine', 'graph', '--backend', 'wat'], { code: 3, says: '接不住' });
}

// ---- 4) 开关本身错了也要有一句人话
check('--backend 打错就报那四条', ['run', 'ext/lua/examples/basics.lua', '--engine', 'graph', '--backend', 'llvm'],
  { code: 1, says: 'interp / sx / js / wat' });
check('--engine 打错就报那两台', ['run', 'ext/lua/examples/basics.lua', '--engine', 'wasm'],
  { code: 1, says: '现在两台' });
check('--engine graph 没给文件', ['run', '--engine', 'graph'], { code: 1, says: '要一个源文件' });

// ---- 5) `run --help` 里得真有那几行（**声明了就得能用**的反面：能用就得写清）
{
  const h = omni(['run', '--help']);
  const want = ['--engine graph', '--backend 这一层有四条', '--lang'];
  const miss = want.filter((w) => !h.out.join('\n').includes(w));
  if (miss.length === 0) { pass++; process.stdout.write('  ok   run --help 里有 graph 那一段\n'); } else {
    fail++;
    process.stdout.write(`  FAIL run --help 里缺：${miss.join(' / ')}\n`);
  }
}

// ---- 6) `build --engine graph`：产物那一侧。**有产物的落文件，没有的说清为什么没有**
{
  const wat = join(tmpdir(), 'omni-graph-basics.wat');
  check('build wat 落一份 .wat',
    ['build', 'ext/cpp/examples/basics.cpp', '--engine', 'graph', '--backend', 'wat', '-o', wat],
    { code: 0, says: 'built' });
  if (only.length === 0 || only.some((x) => 'build wat 落一份 .wat'.includes(x))) {
    const text = readFileSync(wat, 'utf8');
    const okHead = text.startsWith('(module');
    const okImp = text.includes('(import "omni" "print_i64"');
    if (okHead && okImp) { pass++; process.stdout.write('  ok   落出来的 .wat 是一份模块（带宿主面那几格导入）\n'); } else {
      fail++;
      process.stdout.write(`  FAIL 落出来的 .wat 不像模块：${JSON.stringify(text.slice(0, 60))}\n`);
    }
    /**
     * **落出来的那份东西，真引擎认不认**（命令行这一侧的那条判据）。
     * `tests/graph/wasm.js` 已经在图那一层验过 76 份，这儿验的是**用户手里那个文件**：
     * `omni build` 写出去的 `.wat` 装成二进制、V8 跑一遍，输出还是那四行。
     * 用同步的 `new WebAssembly.Module/Instance`（这条轴是同步的）。
     */
    try {
      const out = [];
      const mem = { m: null };
      const str = (addr) => {
        const view = new DataView(mem.m.buffer);
        const len = Number(view.getBigUint64(addr, true));
        return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(mem.m.buffer, addr + 8, len));
      };
      const inst = new WebAssembly.Instance(new WebAssembly.Module(watToWasm(text)), {
        omni: {
          print_i64: (x) => out.push(String(x)),
          print_f64: (x) => out.push(String(x)),
          print_str: (a) => out.push(str(a)),
        },
      });
      mem.m = inst.exports.mem ?? null;
      inst.exports.main();
      if (out.join(' / ') === BASICS.join(' / ')) {
        pass++;
        process.stdout.write(`  ok   落出来的 .wat 交给 V8 那台 wasm 引擎跑，还是 ${BASICS.join(' / ')}\n`);
      } else {
        fail++;
        process.stdout.write(`  FAIL 落出来的 .wat 在 V8 里跑出别的：${out.join(' / ')}\n`);
      }
    } catch (err) {
      fail++;
      process.stdout.write(`  FAIL 落出来的 .wat 真引擎不认：${err.message}\n`);
    }
  }
  /**
   * **产物按后缀定**：`-o x.wasm` 落的是**二进制**（真引擎吃的就是它）。
   * 判据不是"文件在那儿"，是那份二进制**从文件里读出来能在 V8 里跑出同一份输出** ——
   * 前四个字节还得是 wasm 的魔数（`\0asm`）。
   */
  const wasm = join(tmpdir(), 'omni-graph-basics.wasm');
  check('build -o *.wasm 落一份二进制',
    ['build', 'ext/cpp/examples/basics.cpp', '--engine', 'graph', '--backend', 'wat', '-o', wasm],
    { code: 0, says: 'wat -> wasm 二进制' });
  if (only.length === 0 || only.some((x) => 'build -o *.wasm 落一份二进制'.includes(x))) {
    try {
      const bin = readFileSync(wasm);
      const magic = [...bin.slice(0, 4)].join(',') === '0,97,115,109';
      const out = [];
      const box = { m: null };
      const str = (addr) => {
        const view = new DataView(box.m.buffer);
        const len = Number(view.getBigUint64(addr, true));
        return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(box.m.buffer, addr + 8, len));
      };
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bin), {
        omni: {
          print_i64: (x) => out.push(String(x)),
          print_f64: (x) => out.push(String(x)),
          print_str: (a) => out.push(str(a)),
        },
      });
      box.m = inst.exports.mem ?? null;
      inst.exports.main();
      if (magic && out.join(' / ') === BASICS.join(' / ')) {
        pass++;
        process.stdout.write('  ok   落出来的 .wasm 有魔数、V8 直接吃，输出照旧\n');
      } else {
        fail++;
        process.stdout.write(`  FAIL 落出来的 .wasm 不对：魔数 ${magic} 输出 ${out.join(' / ')}\n`);
      }
    } catch (err) {
      fail++;
      process.stdout.write(`  FAIL 落出来的 .wasm 跑不起来：${err.message}\n`);
    }
  }
  const sx = join(tmpdir(), 'omni-graph-basics.sx');
  check('build sx 落一份序列化',
    ['build', 'ext/lua/examples/basics.lua', '--engine', 'graph', '--backend', 'sx', '-o', sx],
    { code: 0, says: 'built' });
  /* 从前这一格判的是"说清为什么落不了"。钩子有文本版之后（`graph/js_rt.js`）那句话作废：
     现在它落一份**自足的 `.mjs`**，`node` 直接跑。产物与本进程那条腿逐行相同这一条
     由 `tests/graph/js-artifact.js` 钉（三门语言的全部例子）。 */
  const mjs = join(tmpdir(), 'omni-graph-basics.mjs');
  check('build js 落一份自足的 .mjs',
    ['build', 'ext/lua/examples/basics.lua', '--engine', 'graph', '--backend', 'js', '-o', mjs],
    { code: 0, says: '自足' });
  check('build interp 说清它没有产物',
    ['build', 'ext/lua/examples/basics.lua', '--engine', 'graph', '--backend', 'interp'],
    { code: 1, says: '它就是 graph.eval' });
}

process.stdout.write(`\n${pass} passed, ${fail} failed（omni run --engine graph）\n`);
if (fail > 0) process.exit(1);
