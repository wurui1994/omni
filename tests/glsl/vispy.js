#!/usr/bin/env node
// Omni — vispy 那 102 份 GLSL 的**前端门**（ADR-0019 施工图 A11/B13）
//
// 这一支的身份与 `examples.js`（31 个 GraphEq preset 对着真 GPU 比像素）不同：
// 它比的不是像素，是**收不收**。vispy 的 `vispy/glsl/` 是一份现成的、别人写的、
// 网状 include 的着色器库 —— 拿它当「GLSL 的哪些特性还差」的尺子，比自己造用例诚实：
// 少一条特性就有一批文件编不过，而编过多少是个数。
//
// 口径：词法 -> 预处理（含 `#include`/`#if` 一族） -> 语法 -> 检查（**库模式**）。
// 库模式（`{lib: true}`）不要求有 `main` —— 这些文件大半是函数库，被别的着色器 include。
//
// 门槛是**棘轮**：`BUDGET` 里记着「现在还编不过的那几份 + 为什么」。修好一条特性就把
// 相应的行删掉；新写的代码让某一份从绿变红，这一支立刻红 —— 那正是棘轮要防的。
//
// vispy 不在就整支跳过（它是 `uv pip install vispy` 装的，不是这棵树的一部分）。
//   node tests/glsl/vispy.js
//   OMNI_VISPY=/path/to/vispy/glsl node tests/glsl/vispy.js

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { glslPreprocess, glslTypeNames } from '../../src/core/frontend-glsl/pp.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const bad = (label, detail) => {
  fail++;
  process.stdout.write(`  FAIL ${label}\n${detail}\n`);
};

/** vispy 的 `glsl/` 目录在哪儿。给了环境变量就用它，否则问 python 的 site-packages。 */
function vispyDir() {
  const env = process.env.OMNI_VISPY;
  if (env !== undefined && env !== '' && existsSync(env)) return env;
  for (const py of ['python3', 'python']) {
    try {
      const out = execSync(`${py} -c "import vispy, os; print(os.path.dirname(vispy.__file__))"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const d = join(out, 'glsl');
      if (existsSync(d)) return d;
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 还编不过的那几份：**文件名 -> 为什么**。
 *
 * 每一行都是一句「差哪条特性」，不是「先记着」。修好一条就删一行 ——
 * 这张表的长度就是「照着 llvmpipe 补齐」还剩多少。
 */
const BUDGET = new Map([
  /* **vispy 自己的笔误**，不是我们缺特性：`antialias/cap-round.glsl:27` 写的是
   * `lenght(vec2(dx,dy))`。任何 GL 编译器都会拒它（那一份显然没被真编过），
   * 所以这一行**永远留着** —— 它是"照实拒"的证据，不是待办。 */
  ['antialias/cap-round.glsl', 'vispy 自己拼错了函数名（第 27 行 `lenght`）—— 真 GL 编译器一样拒'],
  /* 同一档：`transforms/translate.glsl:14` 与 `:29` 是 `vec3(x,y,z) + translate_translate);`
   * —— **多一个右括号**。也是 vispy 自己的笔误，不是我们缺特性。 */
  ['transforms/translate.glsl', 'vispy 自己多写了一个 `)`（第 14、29 行）—— 真 GL 编译器一样拒'],
  /* 采样器那一族（`sampler1D`/`sampler2D` + `texture()`）。llvmpipe 那边是
   * `lp_bld_sample*` 一整块（软件纹理取样、双线性、mip），这一刀还没到那儿。 */
  ['colormaps/user.glsl', '纹理：`uniform sampler1D` 与 texture() 还没接（llvmpipe 的 lp_bld_sample*）'],
  ['colormaps/colormaps.glsl', '纹理：同上（`uniform sampler2D`）'],
]);

const dir = vispyDir();
if (dir === null) {
  process.stdout.write('  skip vispy 没装（uv pip install vispy），整支跳过\n');
  process.stdout.write('\n0 passed, 0 failed, 1 skipped\n');
  process.exit(0);
}

const { g, tb } = loadGrammarTable(GRAMMAR);

/** 递归收集 `.glsl`。 */
function walk(d, out) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.glsl')) out.push(p);
  }
  return out;
}

/** `#include "math/functions.glsl"` 的查找：先按引用者的目录，再按 vispy 的 glsl 根。 */
function open(name, from) {
  for (const base of [dirname(from), dir]) {
    const p = join(base, name);
    if (existsSync(p)) return { path: p, text: readFileSync(p, 'utf8') };
  }
  return null;
}

/**
 * 一份文件走一趟前端。回 null 是过了，回一句话是没过。
 *
 * 阶段（`frag` 还是 `vert`）**按内容猜**：这些文件不带扩展名上的区分，而检查器要知道
 * `gl_FragColor` 那一族合不合法。带 `gl_Frag`/`discard` 的当片段，别的当顶点 ——
 * 库文件两种都不带，当顶点更宽松（顶点里不许用的东西更少）。
 */
function frontend(path) {
  const src = readFileSync(path, 'utf8');
  const stage = /gl_Frag|\bdiscard\b/.test(src) ? 'frag' : 'vert';
  const diags = new Diagnostics();
  try {
    const file = new SourceFile(path, src);
    const toks = glslPreprocess(g.lex, lexText(g.lex, file, diags), diags, { open });
    diags.throwIfErrors();
    const tree = glrParse(tb, glslTypeNames(toks), diags);
    diags.throwIfErrors();
    glslCheck(tree, stage, { lib: true });
    diags.throwIfErrors();
    return null;
  } catch (e) {
    return String(e.message ?? e).split('\n')[0].trim();
  }
}

const files = walk(dir, []).sort();
const failed = new Map();
for (const p of files) {
  const why = frontend(p);
  const name = p.slice(dir.length + 1);
  if (why === null) {
    if (BUDGET.has(name)) bad(`${name} [预算里说编不过，实际编过了]`, '    把它从 BUDGET 里删掉');
    else pass++;
    continue;
  }
  failed.set(name, why);
  if (BUDGET.has(name)) skip++;
  else bad(name, `    ${why}`);
}

/* 一行汇总：过了多少、预算里还有多少、以及**没进预算却红了**的那几份（真回归）。 */
process.stdout.write(`\nvispy ${dir}\n`);
process.stdout.write(`  ${files.length} 份 .glsl：${pass} 过、${skip} 在预算里、${fail} 红\n`);
if (failed.size > 0) {
  /* 按原因归类印出来 —— 「还差哪条特性」这一问要一眼看得见。 */
  const byWhy = new Map();
  for (const [name, why] of failed) {
    /* 归类的键：把「哪个文件哪一行」剥掉，只留「差什么」。行号那一格有时是
     * `undefined`（span 没带位置），所以两种都剥。 */
    const k = why.replace(/^\S*?\.glsl:(?:\d+|undefined)(?::\d+)?:\s*/, '')
      .replace(/'[^']*'/g, "'…'").slice(0, 90);
    if (!byWhy.has(k)) byWhy.set(k, []);
    byWhy.get(k).push(name);
  }
  process.stdout.write('  还编不过的，按原因：\n');
  for (const [k, names] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
    process.stdout.write(`    ${String(names.length).padStart(3)} × ${k}\n`);
    process.stdout.write(`        ${names.slice(0, 3).join(' ')}${names.length > 3 ? ' …' : ''}\n`);
  }
}
process.stdout.write(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail > 0 ? 1 : 0);
