// bench/ir/build.js —— **把 lua 编成原生**：两档链接（分离 .o vs llvm-link 全内联）
//
// 这一份把编译流程单独拿出来，是因为**链接方式本身是要量的变量**：
//   plain : mlir → .ll，运行时单独 .o，clang 链 —— 运行时调用是跨模块的，内联不了
//   link  : 运行时也出 .ll，`llvm-link` 合成一个模块再 -O2 —— 快路能被内联进循环体
//
// 上一轮 `-flto` 报 1.00x 是**假的**：`.ll` 那一侧没走 LTO 通道，内联从来没发生。
// 判据换成"汇编里还有没有 bl _omni_val_add"，不看编译器有没有收下那个开关。

import { luaToMlir } from '../../src/core/ir/emit-mlir.js';
import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const LLVM = '/opt/homebrew/opt/llvm/bin';
// **最后一步要用同一版 clang**：homebrew 的 llvm-link（23.1）写出的属性组，
// Apple 那版 clang（21）读不回来（`unterminated attribute group`）。
// 这一条是踩出来的：版本错位会让整条 link 档静默失败。
const CLANG = `${LLVM}/clang`;
const RT_H = `${process.cwd()}/src/core/ir/lua-rt.h`;

let _tb = null, _g = null;
function grammar() {
  if (_tb === null) { const r = loadGrammarTable('ext/lua/lua.grammar'); _tb = r.tb; _g = r.g; }
  return { tb: _tb, g: _g };
}

/** lua 源码 → MLIR 文本 */
export function toMlir(name, src) {
  const { tb, g } = grammar();
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(name, src), diags);
  const tree = glrParse(tb, toks, { diags });
  return luaToMlir(tree);
}

/** 运行时的两种形态（按需造一次） */
export function buildRuntime(work) {
  execSync(`mkdir -p ${work}`);
  const c = `${work}/rt.c`;
  writeFileSync(c, `#include "${RT_H}"\n`);
  execSync(`${CLANG} -O2 -c ${c} -o ${work}/rt.o`);
  // 出 LLVM IR 文本，给 llvm-link 用
  execSync(`${CLANG} -O2 -S -emit-llvm ${c} -o ${work}/rt.ll`);
  return { obj: `${work}/rt.o`, ll: `${work}/rt.ll` };
}

/**
 * 编一个例子。mode: 'plain' | 'link'
 * 回 { bin, stages: {…ms}, mlirBytes }
 */
export function build(name, src, work, rt, mode = 'link') {
  const t0 = Date.now();
  const mlir = toMlir(name, src);
  const tEmit = Date.now() - t0;
  const mf = `${work}/${name}.mlir`;
  writeFileSync(mf, mlir);

  const t1 = Date.now();
  execSync(`${LLVM}/mlir-translate --mlir-to-llvmir ${mf} > ${work}/${name}.ll`);
  const tTranslate = Date.now() - t1;

  const bin = `${work}/${name}_${mode}`;
  const t2 = Date.now();
  let linkedLl = null;
  if (mode === 'plain') {
    execSync(`${CLANG} -O2 ${work}/${name}.ll ${rt.obj} -o ${bin} -lm 2>/dev/null`);
  } else {
    // 合成一个模块 → 整体 -O2（运行时因此能被内联进热循环）
    linkedLl = `${work}/${name}_linked.ll`;
    execSync(`${LLVM}/llvm-link ${work}/${name}.ll ${rt.ll} -S -o ${linkedLl}`);
    execSync(`${CLANG} -O2 ${linkedLl} -o ${bin} -lm 2>/dev/null`);
  }
  const tLink = Date.now() - t2;

  return { bin, linkedLl, stages: { emit: tEmit, translate: tTranslate, link: tLink }, mlirBytes: mlir.length };
}

/** 汇编里还剩几个运行时调用（内联到底有没有发生 —— 这是判据，不看开关） */
export function countRtCalls(bin) {
  try {
    const asm = execSync(`objdump -d ${bin} 2>/dev/null`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = asm.match(/bl\s+\S+\s+<_omni_\w+>/g) ?? [];
    const byName = {};
    for (const one of m) {
      const nm = one.match(/<_(omni_\w+)>/)?.[1] ?? '?';
      byName[nm] = (byName[nm] ?? 0) + 1;
    }
    return { total: m.length, byName };
  } catch { return { total: -1, byName: {} }; }
}
