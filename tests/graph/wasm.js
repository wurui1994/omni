#!/usr/bin/env node
// tests/graph/wasm.js —— **把那份 `.wat` 交给一个真 wasm 引擎跑**（记了很久的一笔账）
//
// 图那条 wat 腿的正确性原来由 `frontend-wat` + MIR 解释器证。那确实是一条**互不相干的
// 实现**，可它仍然在这棵树里 —— 于是"wasm 是真后端"这句话始终缺最后一环：
// **外面的引擎认不认这份 `.wat`**。设计文档里那一格一直写着"**还没跑过**"。
//
// 这台机器上没有 wabt / wasmtime，但 Node 自带 V8，而 V8 里那台 wasm 引擎与这棵树没有
// 半点关系。缺的只是"文本 -> 二进制"这一步，补在 `src/core/wasm/assemble.js`。
// 于是这条轴的判据是：
//
//   同一份 `.wat`（后端一个字都没改）→ 装成二进制 → `WebAssembly.instantiate` →
//   调 `main` → **输出与另外三条腿逐行相同**
//
// 宿主面就是后端约定的那三格导入：`print_i64` / `print_str`（实参是地址，
// 前 8 字节是长度、正文从 +8 起）/ `print_f64`。**这三格的语义在这儿重写了一遍** ——
// 那是故意的：判据要的就是"另一套宿主实现照样跑得出同一份输出"。
//
//   node tests/graph/wasm.js
//   node tests/graph/wasm.js lua        只跑名字里带 lua 的

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { backends, Gap } from '../../src/core/graph/contract.js';
import { CASES, HAND } from './cases.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
let pass = 0;
let fail = 0;
let skipped = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n${why}\n`); };

const WAT = backends().find((b) => b.name === 'wat');
const { watToWasm } = await import('../../src/core/wasm/assemble.js');

/** 宿主面那三格导入 —— 与 `backend-wat.js` 的约定同一份，实现是另写的。 */
function hostOf(out) {
  const box = { mem: null };
  const str = (addr) => {
    const view = new DataView(box.mem.buffer);
    const len = Number(view.getBigUint64(addr, true));
    let s = '';
    for (let k = 0; k < len; k++) {
      const b = view.getUint8(addr + 8 + k);
      if (b >= 0x80) throw new Error('print_str: 非 ASCII 字节（宿主面只认 ASCII）');
      s += String.fromCharCode(b);
    }
    return s;
  };
  return {
    box,
    imports: {
      omni: {
        print_i64: (x) => out.push(String(x)),
        print_f64: (x) => out.push(String(x)),
        print_str: (addr) => out.push(str(addr)),
      },
    },
  };
}

/** 一份 `.wat` -> 输出行。装不出来 / 跑炸了都往上抛。 */
async function runWat(text) {
  const out = [];
  const { box, imports } = hostOf(out);
  const bin = watToWasm(text);
  const { instance } = await WebAssembly.instantiate(bin, imports);
  // 导出名是 `mem`（`backend-wat.js` 那一行）—— 用不到字符串的模块没有内存段，那时是 null
  box.mem = instance.exports.mem ?? null;
  if (box.mem === null) {
    // 这份模块没导出内存 —— 用不到 `print_str` 的那些就是这样，正常
    box.mem = { buffer: new ArrayBuffer(0) };
  }
  instance.exports.main();
  return { out, bytes: bin.length };
}

/** 一份源码 -> 图（与 `run.js` 那几行同一条路 —— 语法表是内容寻址缓存的，不慢）。 */
function graphOf(c) {
  const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
  const diags = new Diagnostics();
  const toks = lexText(tb.grammar.lex, new SourceFile(c.file, readText(`${ROOT}${c.file}`)), diags);
  if (toks === null || diags.hasErrors()) throw new Error(`词法炸了：${diags.items[0]?.msg}`);
  const tree = glrParse(tb, toks, diags);
  if (tree === null || diags.hasErrors()) throw new Error(`语法炸了：${diags.items[0]?.msg}`);
  return c.toGraph(tree);
}

/** 一条 case：图 -> `.wat` -> 二进制 -> V8 里跑 -> 与期望输出逐行比。 */
async function check(name, g, expect) {
  let text = null;
  try {
    text = WAT.lower(g).text;
  } catch (err) {
    if (err instanceof Gap) {
      process.stdout.write(`  skip ${name}：${err.message}\n`); skipped++;
      return;
    }
    no(name, `       降级炸了：${err.message}`);
    return;
  }
  try {
    const { out, bytes } = await runWat(text);
    const got = out.join(' / ');
    const want = expect.join(' / ');
    if (got !== want) {
      no(name, `       期望 ${want}\n       得到 ${got}`);
      return;
    }
    ok(`${name} [V8 里跑出 ${got}（二进制 ${bytes} 字节）]`);
  } catch (err) {
    no(name, `       ${err.message}`);
  }
}

for (const c of CASES) {
  if (only.length > 0 && !only.some((x) => c.name.includes(x))) continue;
  let g = null;
  try {
    g = graphOf(c);
  } catch (err) {
    no(`graph/${c.name}`, `       ${err.message}`);
    continue;
  }
  await check(c.name, g, c.expect);
}
for (const c of HAND) {
  if (only.length > 0 && !only.some((x) => c.name.includes(x))) continue;
  await check(c.name, c.graph(), c.expect);
}

// ---- 那个"只收一个子集"的边界，也要有会红的一格 ----------------------------------
//
// 文件头写着"发到没见过的东西就当场报错，不许猜着编"。那句话得能被证伪：编出一份 V8 拒收的
// 二进制，错会指到最没关系的地方（V8 只会说 "invalid section"），所以这四条钉住**报错本身**。
// 顺带一条正面的：同一份文本装两遍，二进制逐字节相同（G4 那条纪律在这一层也成立）。
{
  const bad = [
    ['没见过的算子', '(module (func $f (result i32) (i32.trunc_f32_s (f32.const 1))))', '还没见过的算子'],
    ['没见过的模块层 form', '(module (tag $e))', '模块层还没见过'],
    ['只认函数那种导入', '(module (import "m" "g" (global $g i32)))', '只认 (import … (func …))'],
    ['标签不在作用域里', '(module (func $f (block $A (br $B))))', '这个标签不在作用域里'],
    ['还不认的导出种类', '(module (global $g (mut i32) (i32.const 0)) (export "g" (global $g)))', '还不认 (export'],
  ];
  for (const [label, text, want] of bad) {
    if (only.length > 0 && !only.some((x) => label.includes(x))) continue;
    let msg = null;
    try {
      watToWasm(text);
    } catch (err) {
      msg = err.message;
    }
    if (msg === null) no(`边界：${label}`, '       没报错 —— 那就是在猜着编了');
    else if (!msg.includes(want)) no(`边界：${label}`, `       报的理由不对：${msg}`);
    else ok(`边界：${label} [${msg}]`);
  }
  // 内联的 `(func $f (export "main") …)` 后端不发，所以这儿也用它发的那种写法
  const twice = ['(module (func $f (call $f)) (export "main" (func $f)))'];
  for (const t of twice) {
    const a = Buffer.from(watToWasm(t)).toString('hex');
    const b = Buffer.from(watToWasm(t)).toString('hex');
    if (a !== b) no('装两遍', '       同一份文本装两遍，二进制不一样');
    else ok(`装两遍逐字节相同（${a.length / 2} 字节）`);
  }

  /**
   * **函数表 + `call_indirect`**（"函数当值用"那条账付掉之后，这一格仍然留着）。
   * 后端现在也发这种形状了（lua 那两份 defer / method 就是），可这份**手写**模块钉的是
   * 另一句话：表下标**从局部量来**，编译期看不出是哪一个 —— 两次调用各走一格。
   * 后端发的那些下标是从 map 里取出来的，形状更绕，出错时也更难看出是装错还是发错。
   */
  {
    const wat = `(module
  (import "omni" "print_i64" (func $print (param i64)))
  (type $sig1 (func (param i64) (result i64)))
  (table 2 funcref)
  (elem (i32.const 0) $f $g)
  (func $f (param $x i64) (result i64) (return (i64.add (local.get $x) (i64.const 1))))
  (func $g (param $x i64) (result i64) (return (i64.mul (local.get $x) (i64.const 10))))
  (func $__entry
    (local $p i64)
    (local.set $p (i64.const 1))
    (call $print (call_indirect (type $sig1) (i64.const 7) (i32.wrap_i64 (local.get $p))))
    (local.set $p (i64.const 0))
    (call $print (call_indirect (type $sig1) (i64.const 7) (i32.wrap_i64 (local.get $p)))))
  (export "main" (func $__entry))
)`;
    try {
      const { out, bytes } = await runWat(wat);
      if (out.join(' / ') !== '70 / 8') no('函数表 + call_indirect', `       期望 70 / 8，得到 ${out.join(' / ')}`);
      else ok(`函数表 + call_indirect [V8 里跑出 70 / 8（二进制 ${bytes} 字节）]`);
    } catch (err) {
      no('函数表 + call_indirect', `       ${err.message}`);
    }
  }
}

// ---- WAT 前端那几份夹具：**两台引擎对账** -----------------------------------------
//
// 上面验的是"我们发出去的 `.wat`"。这一节反过来：`tests/wat/cases/*.wat` 是给**前端**写的
// 夹具（块注释、十六进制、数字下标、`local.tee`、`br_if`、`align=` / `offset=`、
// `(start …)`、内存上下界、`data` 里的串…… 后端一条都不发），`.expected` 是那条
// MIR 路印出来的。把同一份文件交给 V8，两边必须**逐行相同**。
//
// 值钱的地方：这是**反向**的判据 —— 前端读错了（比如 `align=` 当成操作数、`local.tee`
// 少留一格值），MIR 那边自成一套也能"看起来对"，只有第二台引擎才咬得住。
// 实数那几行按这棵树自己的 `fmtReal` 印（格式是**宿主**的事，不是引擎的事）。
{
  const { readdirSync } = await import('node:fs');
  const { fmtReal } = await import('../../src/core/host/native.js');
  const dir = `${ROOT}tests/wat/cases`;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.wat')).sort()) {
    const label = `wat 夹具 ${f}`;
    if (only.length > 0 && !only.some((x) => label.includes(x))) continue;
    const text = readText(`${dir}/${f}`);
    const want = readText(`${dir}/${f.replace(/\.wat$/, '.expected')}`).split('\n')
      .filter((l) => l !== '');
    const out = [];
    const box = { mem: null };
    // 用 `print_str` 却**没把内存导出去**的夹具，外面的宿主本来就读不到那块内存 ——
    // 那正是第二十一批抓出来的那个洞（夹具是给树里那条路写的，它与内存同进程）。
    // 所以这一格有名有姓地跳过，而不是假装能验。
    if (text.includes('print_str') && !/\(export\s+"[^"]*"\s+\(memory/.test(text)) {
      process.stdout.write(`  skip ${label}：这份夹具用 print_str 但没导出内存 —— 外面的宿主读不到那块内存\n`);
      skipped++;
      continue;
    }
    const str = (addr) => {
      const view = new DataView(box.mem.buffer);
      const len = Number(view.getBigUint64(addr, true));
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(view.getUint8(addr + 8 + k));
      return s;
    };
    try {
      const bin = watToWasm(text);
      const { instance } = await WebAssembly.instantiate(bin, {
        omni: {
          print_i64: (x) => out.push(String(x)),
          print_i32: (x) => out.push(String(x)),
          print_f64: (x) => out.push(fmtReal(x)),
          print_str: (a) => out.push(str(a)),
        },
      });
      box.mem = instance.exports.mem ?? instance.exports.memory ?? null;
      // 入口两种：`(start …)`（实例化时就跑了）或者导出名 main
      if (typeof instance.exports.main === 'function') instance.exports.main();
      if (out.join(' / ') !== want.join(' / ')) {
        no(label, `       期望 ${want.join(' / ')}\n       得到 ${out.join(' / ')}`);
      } else ok(`${label} [两台引擎逐行相同（${want.length} 行）]`);
    } catch (err) {
      no(label, `       ${err.message}`);
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed, ${skipped} skipped`
  + `（同一份 .wat 交给 V8 那台 wasm 引擎跑，输出与别的腿逐行相同）\n`);
if (fail > 0) process.exit(1);
