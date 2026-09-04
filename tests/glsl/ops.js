// tests/glsl/ops.js —— 运算符补全：位运算、移位、`^^`、六种复合赋值（ADR-0019 第二十片）
//
// 与 `stmt.js` 同一个套路：一个 `float probe(int k)`，期望值由这门**自己独立算一遍**。
// 这一门的参照实现有个额外的好处：**JS 的 `& | ^ << >>` 本来就是 32 位的**，
// 而 GLSL 的 `int` 也是 32 位二补数 —— 所以 JS 那一行就是规范那一行。
// 方言的 `int` 是 64 位，`1 << 31` 差在哪儿由降级那侧的 `(x << 32) >> 32` 兜住（第二十片）。
//
//   node tests/glsl/ops.js

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';
import { glslLower } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const OUT = join(tmpdir(), 'omni-glsl-ops');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* 表走带缓存的装载（ADR-0019 决策八第 1 步）：构表在这份语法上是 559 ms、
 * 命中缓存是 8 ms。十四支门各构一遍表，等于每跑一趟全套白花 14 × 559 ms。 */
const { g, tb } = loadGrammarTable(GRAMMAR);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function lower(src) {
  const diags = new Diagnostics();
  const file = new SourceFile('probe.frag', src);
  const toks = lexText(g.lex, file, diags);
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

function runLeg(name, glsl, ks, extra) {
  const lib = lower(SHELL(glsl)).trimEnd();
  const driver = ks.map((k) => `    (print (call glsl_probe ${k < 0 ? `(un "-" (int ${-k}))` : `(int ${k})`}))`).join('\n');
  const sx = `${lib.slice(0, -1)}\n  (main\n${driver})\n)\n`;
  const p = join(OUT, `${name}.sx`);
  writeFileSync(p, sx);
  const r = spawnSync(process.execPath, [CLI, 'run', p, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ') };
  return { lines: r.stdout.trim().split('\n') };
}

function probe(name, glsl, ks, ref) {
  const want = ks.map((k) => String(ref(k)));
  for (const [tag, extra] of [['JS', []], ['C', ['--backend', 'c']], ['LLVM', ['--backend', 'llvm']]]) {
    const r = runLeg(`${name.replace(/[^\w]/g, '_')}-${tag}`, glsl, ks, extra);
    if (r.err !== undefined) { bad(`${name}［${tag} 腿］跑不动`, `    ${r.err}`); continue; }
    const diff = [];
    for (let i = 0; i < want.length; i++) {
      if (r.lines[i] !== want[i]) diff.push(`k=${ks[i]}：要 ${want[i]}，得 ${r.lines[i]}`);
    }
    if (diff.length > 0) bad(`${name}［${tag} 腿］`, diff.map((d) => `    ${d}`).join('\n'));
    else ok(`${name}［${tag} 腿］${want.length} 个数逐字节相同`);
  }
}

/* ---- 一、`& | ^ ~` --------------------------------------------------------- */

probe('位运算 & | ^ ~', `
float probe(int k) {
  int a = k & 12;
  int b = k | 3;
  int c = k ^ 5;
  int d = ~k;
  return float(a + b * 2 + c * 4 + d * 8);
}`, [0, 1, 7, 15, -1, -8], (k) => {
  const a = k & 12;
  const b = k | 3;
  const c = k ^ 5;
  const d = ~k;
  return a + b * 2 + c * 4 + d * 8;
});

/* ---- 二、移位（含 `1 << 31` 那一格：方言 int 是 64 位，必须截回来） -------------
 *
 * 印出来的数**故意压小**（`/ 65536`）：方言印 real 走的是 `%g` 那一档，
 * 上亿的数会印成 `1.07374e+09`，那样比的就不是移位而是排版了。压小之后
 * `1 << 31` 与「没截的 64 位结果」仍然分得开 —— 一个 -32768、一个 +32768。 */

probe('移位 <<（1 << 31 要回绕成负数）', `
float probe(int k) {
  int hi = 1 << k;
  return float(hi / 65536);
}`, [16, 17, 20, 30, 31], (k) => Math.trunc((1 << k) / 65536));

probe('移位 >>（负数是算术右移）', `
float probe(int k) {
  int lo = -1024 >> k;
  return float(lo);
}`, [0, 1, 3, 10, 11], (k) => -1024 >> k);

/* ---- 三、六种复合赋值 ------------------------------------------------------ */

probe('复合赋值 %= &= |= ^= <<= >>=', `
float probe(int k) {
  int a = k; a %= 7;
  int b = k; b &= 12;
  int c = k; c |= 3;
  int d = k; d ^= 5;
  int e = 1; e <<= k; e /= 65536;
  int f = -1024; f >>= 3;
  return float(a) + float(b) * 2.0 + float(c) * 4.0 + float(d) * 8.0
    + float(e) * 16.0 + float(f) * 0.25;
}`, [16, 20, 31], (k) => {
  const a = k % 7;
  const b = k & 12;
  const c = k | 3;
  const d = k ^ 5;
  const e = Math.trunc((1 << k) / 65536);
  const f = -1024 >> 3;
  return a + b * 2 + c * 4 + d * 8 + e * 16 + f * 0.25;
});

/* ---- 四、`^^`（逻辑异或，GLSL 有 C 没有） ---------------------------------- */

probe('逻辑异或 ^^', `
float probe(int k) {
  bool x = k > 2;
  bool y = k < 5;
  return (x ^^ y) ? 1.0 : 0.0;
}`, [0, 3, 4, 9], (k) => (((k > 2) !== (k < 5)) ? 1 : 0));

/* ---- 五、优先级：位运算三层 + 移位比加减低 ---------------------------------- */

probe('优先级（| 低于 ^ 低于 &、<< 低于 +）', `
float probe(int k) {
  int a = 1 | 2 & 3;
  int b = 1 ^ 3 & 1;
  int c = 1 << 2 + 3;
  int d = k | 8 ^ 4 & 12;
  return float(a + b * 8 + c * 64 + d * 4096);
}`, [0, 1, 5], (k) => {
  const a = 1 | (2 & 3);
  const b = 1 ^ (3 & 1);
  const c = 1 << (2 + 3);
  const d = k | (8 ^ (4 & 12));
  return a + b * 8 + c * 64 + d * 4096;
});

/* ---- 六、`ivecN` 上逐格 + 标量铺开 ----------------------------------------- */

probe('ivec2 上的位运算（逐格 + 标量铺开）', `
float probe(int k) {
  ivec2 v = ivec2(k, k + 1);
  ivec2 m = v & ivec2(6, 3);
  ivec2 s = v | 8;
  return float(m.x + m.y * 4 + s.x * 16 + s.y * 256);
}`, [0, 2, 7], (k) => {
  const m = [k & 6, (k + 1) & 3];
  const s = [k | 8, (k + 1) | 8];
  return m[0] + m[1] * 4 + s[0] * 16 + s[1] * 256;
});

/* ---- 七、向量比较那一族 + all/any/not（规范 8.6，第二十二片） ------------------
 *
 * 这一族**不需要方言有掩码类型**：GLSL 这一层的向量是摊成分量的，逐格比出来就是一串
 * bool。方言掩码（待办 18）要的是 LLVM 腿上的原生 `<N x i1>` —— 那是性能，不是前提。 */

probe('lessThan / equal / all / any / not', `
float probe(int k) {
  vec3 a = vec3(1.0, 2.0, 3.0);
  vec3 b = vec3(3.0, 2.0, 1.0);
  bvec3 lt = lessThan(a, b);
  bvec3 eq = equal(a, b);
  bvec3 n = not(lt);
  float r = 0.0;
  if (lt.x) r += 1.0;
  if (lt.y) r += 2.0;
  if (lt.z) r += 4.0;
  if (any(eq)) r += 8.0;
  if (all(eq)) r += 16.0;
  if (n.z) r += 32.0;
  return r;
}`, [0], () => {
  const a = [1, 2, 3];
  const b = [3, 2, 1];
  const lt = a.map((x, i) => x < b[i]);
  const eq = a.map((x, i) => x === b[i]);
  const n = lt.map((x) => !x);
  let r = 0;
  if (lt[0]) r += 1;
  if (lt[1]) r += 2;
  if (lt[2]) r += 4;
  if (eq.some((x) => x)) r += 8;
  if (eq.every((x) => x)) r += 16;
  if (n[2]) r += 32;
  return r;
});

probe('整个向量比（== 是每格都等、!= 是有一格不等）', `
float probe(int k) {
  ivec2 a = ivec2(k, 2);
  ivec2 b = ivec2(1, 2);
  float r = 0.0;
  if (a == b) r += 1.0;
  if (a != b) r += 2.0;
  bvec2 le = lessThanEqual(a, ivec2(1, 1));
  if (le.x) r += 4.0;
  if (le.y) r += 8.0;
  return r;
}`, [0, 1, 5], (k) => {
  const a = [k, 2];
  const b = [1, 2];
  let r = 0;
  if (a[0] === b[0] && a[1] === b[1]) r += 1;
  else r += 2;
  if (a[0] <= 1) r += 4;
  if (a[1] <= 1) r += 8;
  return r;
});

/* ---- 八、逗号表达式（第二十四片） ---------------------------------------------
 *
 * 逗号单独一层 `cexpr`，不塞进 `expr`：**实参表也用逗号**，塞进去 `f(a, b)` 就成了
 * 真歧义。规范也是这么分的（`expression` 有逗号、`assignment_expression` 没有）。 */

probe('逗号：左边算了就丢，值是右边那个', `
float probe(int k) {
  int i = 0;
  int j = 0;
  for (i = 0; i < 4; i++, j += 2) { }
  int m = (i = 7, i + 1);
  return float(i) + float(j) * 10.0 + float(m) * 100.0;
}`, [0], () => {
  /* `for` 的更新格里两件事都要发生：i 走到 4、j 走到 8。
   * `(i = 7, i + 1)` 的值是右边那个 8，而 i 真的被改成了 7。 */
  return 7 + 8 * 10 + 8 * 100;
});

/* ---- 九、该骂的明着骂 ------------------------------------------------------ */

function rejects(name, glsl, want) {
  let msg = null;
  try {
    lower(SHELL(glsl));
  } catch (e) {
    msg = String(e.message ?? e);
  }
  if (msg === null) bad(name, '    一声没骂就收下了');
  else if (!msg.includes(want)) bad(name, `    骂的是别的：${msg.split('\n')[0]}`);
  else ok(`${name}［${want}］`);
}

rejects('~ 不能作用在 float 上', `
float probe(int k) { return ~1.5; }`, '~ 只对 int 或 ivecN');

rejects('& 不能作用在 float 上', `
float probe(int k) { return float(1.0 & 2.0); }`, '只对 int 或 ivecN');

rejects('移位左边是标量时右边不能是向量', `
float probe(int k) { ivec2 s = ivec2(1, 2); return float((k << s).x); }`,
'左边是标量时右边也要是标量');

rejects('两边宽度不一样', `
float probe(int k) { ivec2 a = ivec2(1, 2); ivec3 b = ivec3(1, 2, 3); return float((a & b).x); }`,
'宽度不一样');

rejects('^^ 只对 bool', `
float probe(int k) { return float(k ^^ 1); }`, '两边要是 bool');

rejects('lessThan 不收标量', `
float probe(int k) { return lessThan(1.0, 2.0) ? 1.0 : 0.0; }`,
'要是同型的向量');

rejects('lessThan 不收 bvec', `
float probe(int k) { bvec2 a = bvec2(true, false); return all(lessThan(a, a)) ? 1.0 : 0.0; }`,
'不能作用在 bvec 上');

rejects('all 要 bvec', `
float probe(int k) { return all(vec2(1.0, 2.0)) ? 1.0 : 0.0; }`,
'要是 bvecN');

rejects('not 不收标量（标量写 !x）', `
float probe(int k) { return not(true) ? 1.0 : 0.0; }`,
'not 的实参要是 bvecN');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
