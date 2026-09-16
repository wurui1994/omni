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

process.stdout.write(`\n${pass} passed, ${fail} failed, ${skipped} skipped`
  + `（同一份 .wat 交给 V8 那台 wasm 引擎跑，输出与别的腿逐行相同）\n`);
if (fail > 0) process.exit(1);
