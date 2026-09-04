// tests/glsl/pp.js —— GLSL 的预处理：**只有对象宏**（ADR-0019 施工图 A11 的最窄那一档）
//
// 收的这一档是从 `grapheq.glsl` 那 772 行**数出来**的：8 处 `#define` 全是对象宏，
// 没有函数宏、没有 `#if`/`#ifdef`/`#include`。所以这一门的正面用例照那 8 个的形状写
// （含 `NO_GAP` 那种「宏体里引用另一个宏」与 `INF (1.0 / 0.0)` 那种带括号的表达式），
// 负面用例把不收的那些逐条钉住。
//
// 三条腿都跑：预处理是 token 级的，出来的东西与「手写展开后的源码」应当一字不差 ——
// 所以这一门顺带比一条**等价源码**的降级结果，比「印出来的数一样」更强。
//
//   node tests/glsl/pp.js

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslPreprocess } from '../../src/core/frontend-glsl/pp.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';
import { glslLower } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const OUT = join(tmpdir(), 'omni-glsl-pp');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* 表走带缓存的装载（ADR-0019 决策八第 1 步）：构表在这份语法上是 559 ms、
 * 命中缓存是 8 ms。十四支门各构一遍表，等于每跑一趟全套白花 14 × 559 ms。 */
const { g, tb } = loadGrammarTable(GRAMMAR);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 完整的一趟：词法 -> **预处理** -> 语法 -> 检查 -> 降级。 */
function lower(src) {
  const diags = new Diagnostics();
  const file = new SourceFile('probe.frag', src);
  const toks = glslPreprocess(g.lex, lexText(g.lex, file, diags), diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslLower(glslCheck(tree, 'frag'));
}

const SHELL = (body) => `#version 330 core
out vec4 fragColor;
${body}
void main() { fragColor = vec4(probe(0), 0.0, 0.0, 1.0); }
`;

/* ---- 一、展开出来的东西与手写展开后的源码**逐字节**相同 ------------------------
 *
 * 这一条比「两边印出的数一样」强：预处理是 token 级的替换，所以降出来的方言文本
 * 应当一字不差。差了就说明替换动了别的东西（span、次序、括号）。 */

function same(name, withMacros, expanded) {
  let a = null;
  let b = null;
  try { a = lower(SHELL(withMacros)); } catch (e) { bad(`${name}［带宏那份跑不动］`, `    ${String(e.message ?? e).split('\n')[0]}`); return; }
  try { b = lower(SHELL(expanded)); } catch (e) { bad(`${name}［手写展开那份跑不动］`, `    ${String(e.message ?? e).split('\n')[0]}`); return; }
  if (a !== b) {
    /* 印第一处不同，别把两份都糊上来。 */
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    bad(name, `    第 ${i} 个字节起不一样\n    宏  ${JSON.stringify(a.slice(i, i + 60))}\n    手写 ${JSON.stringify(b.slice(i, i + 60))}`);
  } else ok(`${name}：降出来的方言逐字节相同（${a.length} 字节）`);
}

same('对象宏', `
#define TWO 2.0
float probe(int k) { return TWO * 3.0; }`, `
float probe(int k) { return 2.0 * 3.0; }`);

same('宏体里引用另一个宏（grapheq 的 NO_GAP 那种）', `
#define BIG 3.402823466e+38
#define NO_GAP vec2(BIG, -BIG)
float probe(int k) { vec2 v = NO_GAP; return v.x + v.y; }`, `
float probe(int k) { vec2 v = vec2(3.402823466e+38, -3.402823466e+38); return v.x + v.y; }`);

same('宏体是带括号的表达式（grapheq 的 INF / QNAN 那种）', `
#define INF (1.0 / 0.0)
#define QNAN (0.0 / 0.0)
float probe(int k) { return (isinf(INF) ? 1.0 : 0.0) + (isnan(QNAN) ? 2.0 : 0.0); }`, `
float probe(int k) { return (isinf((1.0 / 0.0)) ? 1.0 : 0.0) + (isnan((0.0 / 0.0)) ? 2.0 : 0.0); }`);

same('没被 #define 过的名字一个都不动', `
#define TWO 2.0
float probe(int k) { float three = 3.0; return three * TWO; }`, `
float probe(int k) { float three = 3.0; return three * 2.0; }`);

/* ---- 二、真跑一遍：`INF`/`QNAN` 这两个宏一展开就能用 --------------------------
 *
 * 这一条钉的是上一片那条更正：**报错的只有整数除零**，实数除零走 IEEE。
 * 所以 grapheq 的 `#define INF (1.0 / 0.0)` 不需要额外一格。三条腿都得同意。 */

const glsl = `
#define BIG 3.402823466e+38
#define INF (1.0 / 0.0)
#define QNAN (0.0 / 0.0)
#define TOL 1e-9
float probe(int k) {
  return (isinf(INF) ? 1.0 : 0.0) + (isnan(QNAN) ? 2.0 : 0.0)
    + (isinf(BIG) ? 4.0 : 0.0) + (TOL < 1.0 ? 8.0 : 0.0);
}`;
const want = String(1 + 2 + 0 + 8);
for (const [tag, extra] of [['JS', []], ['C', ['--backend', 'c']], ['LLVM', ['--backend', 'llvm']]]) {
  const lib = lower(SHELL(glsl)).trimEnd();
  const p = join(OUT, `inf-${tag}.sx`);
  writeFileSync(p, `${lib.slice(0, -1)}\n  (main\n    (print (call glsl_probe (int 0))))\n)\n`);
  const r = spawnSync(process.execPath, [CLI, 'run', p, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) bad(`INF / QNAN 宏［${tag} 腿］跑不动`, `    ${(r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
  else if (r.stdout.trim() !== want) bad(`INF / QNAN 宏［${tag} 腿］`, `    要 ${want}，得 ${r.stdout.trim()}`);
  else ok(`INF / QNAN 宏［${tag} 腿］= ${want}（实数除零走 IEEE，只有整数除零报错）`);
}

/* ---- 三、不收的那些明着骂（说清「收的是哪一档」，不是「语法错误」） -------------- */

function rejects(name, src, wantMsg) {
  let msg = null;
  try { lower(src); } catch (e) { msg = String(e.message ?? e); }
  if (msg === null) bad(name, '    一声没骂就收下了');
  else if (!msg.includes(wantMsg)) bad(name, `    骂的是别的：${msg.split('\n').slice(0, 3).join(' / ')}`);
  else ok(`${name}［${wantMsg}］`);
}

rejects('函数宏', SHELL(`
#define SQ(x) ((x) * (x))
float probe(int k) { return SQ(3.0); }`), '不收函数宏');

rejects('同一个宏定义两次', SHELL(`
#define TWO 2.0
#define TWO 3.0
float probe(int k) { return TWO; }`), '定义了两次');

rejects('#if', SHELL(`
#if 1
float probe(int k) { return 1.0; }
#endif`), '不收 "#if"');

rejects('#ifdef', SHELL(`
#ifdef FOO
float probe(int k) { return 1.0; }
#endif`), '不收 "#ifdef"');

rejects('#undef', SHELL(`
#define TWO 2.0
#undef TWO
float probe(int k) { return 1.0; }`), '不收 "#undef"');

/* 没给查找口子的时候 `#include` 照旧骂 —— `pp.js` 自己不碰文件系统。 */
rejects('#include（这一趟没给查找口子）', SHELL(`
#include "x.glsl"
float probe(int k) { return 1.0; }`), '不收 "#include"');

/**
 * `#include` 的三条：**进来的宏与函数都能用**、**同一份只进来一次**、**成环要骂**。
 *
 * 查找口子是这儿现搭的一张表（`pp.js` 不碰文件系统），所以这一门不落任何文件。
 */
function ppInclude(name, src, tab) {
  const d = new Diagnostics();
  const open = (n) => (tab[n] === undefined ? null : { path: n, text: tab[n] });
  try {
    const toks = glslPreprocess(g.lex, lexText(g.lex, new SourceFile('probe.frag', src), d), d, { open });
    d.throwIfErrors();
    return { toks };
  } catch (e) {
    return { err: String(e.message) };
  }
}

{
  const src = SHELL(`
#include "lib.glsl"
float probe(int k) { return HALF + lib_one(); }`);
  const r = ppInclude('include', src, {
    'lib.glsl': '#define HALF 0.5\nfloat lib_one() { return 1.0; }\n',
  });
  if (r.err !== undefined) bad('#include：进来的宏与函数', `    ${r.err.split('\n')[0]}`);
  else {
    const txt = r.toks.map((t) => (t.node === undefined ? t.type : String(t.node.value))).join(' ');
    if (txt.includes('lib_one') && txt.includes('0.5')) ok('#include：进来的宏与函数都能用');
    else bad('#include：进来的宏与函数', `    展开出来是：${txt.slice(0, 120)}`);
  }
}

{
  /* 同一份被两条链引到 —— 第二遍整份跳过，不然「宏定义了两次」。 */
  const r = ppInclude('twice', SHELL(`
#include "a.glsl"
#include "b.glsl"
float probe(int k) { return HALF; }`), {
    'a.glsl': '#include "c.glsl"\n',
    'b.glsl': '#include "c.glsl"\n',
    'c.glsl': '#define HALF 0.5\n',
  });
  if (r.err === undefined) ok('#include：同一份只进来一次（菱形也行）');
  else bad('#include：同一份只进来一次', `    ${r.err.split('\n')[0]}`);
}

{
  const r = ppInclude('cycle', SHELL(`
#include "a.glsl"
float probe(int k) { return 1.0; }`), {
    'a.glsl': '#include "b.glsl"\n',
    'b.glsl': '#include "a.glsl"\n',
  });
  if (r.err !== undefined && r.err.includes('成环')) ok('#include：成环要骂［成环］');
  else bad('#include：成环要骂', `    ${r.err === undefined ? '收了' : r.err.split('\n')[0]}`);
}

{
  const r = ppInclude('missing', SHELL(`
#include "nope.glsl"
float probe(int k) { return 1.0; }`), {});
  if (r.err !== undefined && r.err.includes('找不到')) ok('#include：找不到要骂［找不到］');
  else bad('#include：找不到要骂', `    ${r.err === undefined ? '收了' : r.err.split('\n')[0]}`);
}

rejects('拿关键字当宏名', SHELL(`
#define float double
float probe(int k) { return 1.0; }`), '不能拿它当宏名');

/* 上下文无关的替换（与 C 预处理器同）：宏名取成 `x` 之后 `v.x` 也会被换掉，
 * 然后语法那一侧骂。这不是这一片的 bug —— 预处理器不认识成员访问。钉住它是为了
 * 免得以后有人「顺手修一下」，把预处理器改成认识语法的东西。 */
rejects('宏名取成分量名会连 v.x 一起换掉（与 C 同，钉住这个行为）', SHELL(`
#define x 9.0
float probe(int k) { vec2 v = vec2(1.0, 2.0); return v.x; }`), "expected ID");

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
