// tests/glsl/parse.js —— GLSL 子集的语法表与五份尺子源码（ADR-0019 第一刀）
//
// 这一门只查**语法**：表里剩几个冲突、五份源码各分析出几棵树、几处形状。
// 类型检查与降级还没有，所以这儿一个字都不提它们。
//
// 五份源码是从两份尺子脚本里**原样抄**的（`tests/glsl/cases/`）：
//
//   bench-vert.vert / bench-simple.frag / bench-complex.frag  <- ~/Downloads/benchmark.py
//   pretty-vert.vert / pretty.frag                            <- ~/Downloads/pretty_render.py
//
// 抄进仓库是因为尺子脚本在仓库外（`~/Downloads`），门不能依赖它在不在。抄的时候
// **一个字符都没改** —— 改了就不是尺子了。
//
//   node tests/glsl/parse.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSexpr } from '../../src/core/sexpr/read.js';
import { readGrammar } from '../../src/core/glr/grammar.js';
import { buildTable } from '../../src/core/glr/table.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { printSexpr } from '../../src/core/sexpr/print.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslTypeNames } from '../../src/core/frontend-glsl/pp.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* ---- 一、构表。语法写错了这一步就抛，所以它自己就是一条断言。 */
const gdiags = new Diagnostics();
const gtext = readFileSync(GRAMMAR, 'utf8');
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, gtext), gdiags), gdiags);
if (gdiags.errorCount() > 0) {
  process.stdout.write(`  FAIL 语法文件读不了\n${gdiags.format()}\n`);
  process.exit(1);
}
const tb = buildTable(g);
ok(`构表：${tb.states.length} 个状态，${tb.conflicts.length} 处冲突留给 GLR`);

/** 一份源码 -> 树（或者 null）。诊断一律算错。 */
function parse(name) {
  const path = join(CASES, name);
  const diags = new Diagnostics();
  const file = new SourceFile(path, readFileSync(path, 'utf8'));
  const toks = glslTypeNames(lexText(g.lex, file, diags));
  if (diags.errorCount() > 0) return { err: `词法：${diags.format()}` };
  const tree = glrParse(tb, toks, diags);
  if (diags.errorCount() > 0) return { err: `分析：${diags.format()}`, toks: toks.length };
  if (tree === null) return { err: '分析不出树', toks: toks.length };
  return { tree, toks: toks.length };
}

/* ---- 二、五份尺子源码各分析出**唯一**一棵树。
 *
 * 「唯一」不是我这儿判的 —— GLR 驱动遇到两棵都活到接受的树会自己报错（它不猜）。
 * 所以这一条过了就等于「这份语法在这五份源码上没有歧义」。 */
const FILES = [
  'bench-vert.vert',
  'bench-simple.frag',
  'bench-complex.frag',
  'pretty-vert.vert',
  'pretty.frag',
];
const trees = new Map();
for (const f of FILES) {
  const r = parse(f);
  if (r.err !== undefined) bad(`${f} 分析不了`, `    ${r.err}`);
  else {
    trees.set(f, r.tree);
    ok(`${f}：${r.toks} 个 token，唯一一棵树`);
  }
}

/* ---- 三、几处形状。挑的都是**容易悄悄错**的那几格。 */
const text = (n) => printSexpr([n]);

/** 一小段源码当一份「片元着色器」解析，回它的文本形状。
 *
 * 印出来是**多行**的（`printSexpr` 会缩进），而下面那些断言查的是子串，所以先把
 * 空白压成一个空格 —— 不压的话「形状对了但换了行」也会红，那种红是假的。 */
function shape(src) {
  const diags = new Diagnostics();
  const file = new SourceFile('probe.frag', src);
  const toks = glslTypeNames(lexText(g.lex, file, diags));
  if (diags.errorCount() > 0) return `词法错：${diags.format()}`;
  const tree = glrParse(tb, toks, diags);
  if (diags.errorCount() > 0) return `分析错：${diags.format()}`;
  if (tree === null) return '没有树';
  return text(tree).replace(/\s+/g, ' ');
}

const SHAPES = [
  /* 优先级：`*` 紧过 `+`。写错这一格出来的图会是**另一张画**，而且不报错。 */
  {
    name: '优先级：a + b * c 是 add(a, mul(b, c))',
    src: 'void main() { float x = a + b * c; }\n',
    want: (s) => s.includes('(add (name a) (mul (name b) (name c)))'),
  },
  {
    name: '优先级：a * b + c 是 add(mul(a, b), c)',
    src: 'void main() { float x = a * b + c; }\n',
    want: (s) => s.includes('(add (mul (name a) (name b)) (name c))'),
  },
  /* 一元负号紧过乘：`-a * b` 是 `(-a) * b`。 */
  {
    name: '一元负号紧过乘',
    src: 'void main() { float x = -a * b; }\n',
    want: (s) => s.includes('(mul (neg (name a)) (name b))'),
  },
  /* swizzle 是左结合的成员取用，`uv.xyx * 3.0` 里 `.` 紧过 `*`。 */
  {
    name: 'swizzle 紧过乘：uv.xyx * 3.0',
    src: 'void main() { vec3 c = uv.xyx * 3.0; }\n',
    want: (s) => s.includes('(mul (member (name uv) xyx)'),
  },
  /* 构造与调用是两条不同的规则：`vec3(...)` 是 construct、`sin(...)` 是 call。 */
  {
    name: 'vec3(...) 是构造、sin(...) 是调用',
    src: 'void main() { vec3 c = vec3(sin(x)); }\n',
    want: (s) => s.includes('(construct (ty-vec 3)') && s.includes('(call sin'),
  },
  /* 三元比 `?:` 里的 `==` 松：`(gl_VertexID == 1) ? 3.0 : -1.0`。
   * 括号在源码里就有，这一格查的是**不带括号**时也这么分。 */
  {
    name: '三元比 == 松：a == 1 ? x : y',
    src: 'void main() { float v = a == 1 ? x : y; }\n',
    want: (s) => s.includes('(cond (eq (name a) (int-lit 1)) (name x) (name y))'),
  },
  /* 赋值右结合、且比三元松。 */
  {
    name: '赋值比三元松：v = a ? x : y',
    src: 'void main() { v = a ? x : y; }\n',
    want: (s) => s.includes('(assign (name v) (cond (name a) (name x) (name y)))'),
  },
  /* `1e10` 是浮点，不是 `1` 后面跟个名字 `e10`。 */
  {
    name: '1e10 是一个浮点字面量',
    src: 'void main() { float d = 1e10; }\n',
    want: (s) => s.includes('(float-lit 1e10)'),
  },
  /* `2.0/3.0` 里两个浮点各自成形（`pretty.frag` 里真有这一行）。 */
  {
    name: '2.0/3.0 是两个浮点相除',
    src: 'void main() { float t = 2.0/3.0; }\n',
    want: (s) => s.includes('(div (float-lit 2.0) (float-lit 3.0))'),
  },
  /* `for` 的三格。 */
  {
    name: 'for 的三格：init / cond / step',
    src: 'void main() { for (int i = 0; i < 20; i++) { } }\n',
    want: (s) => s.includes('(for (local-init (ty-int) i (int-lit 0))')
      && s.includes('(lt (name i) (int-lit 20))')
      && s.includes('(post-inc (name i))'),
  },
  /* 复合赋值。`col += ...` 与 `p *= rot(a)` 两份尺子里都有。 */
  {
    name: '复合赋值 += 与 *=',
    src: 'void main() { col += a; p *= b; }\n',
    want: (s) => s.includes('(add-assign (name col) (name a))')
      && s.includes('(mul-assign (name p) (name b))'),
  },
  /* 接口声明三种，外加插值限定。 */
  {
    name: 'uniform / in / out 三种接口声明',
    src: 'uniform vec2 u_res;\nin vec2 v_uv;\nout vec4 fragColor;\nvoid main() { }\n',
    want: (s) => s.includes('(uniform (ty-vec 2) u_res)')
      && s.includes('(in-var () (ty-vec 2) v_uv)')
      && s.includes('(out-var () (ty-vec 4) fragColor)'),
  },
  {
    name: 'flat in 收得下（插值方式留给降级那一侧）',
    src: 'flat in vec2 v_uv;\nvoid main() { }\n',
    want: (s) => s.includes('(in-var (interp-flat) (ty-vec 2) v_uv)'),
  },
  /* `#version` 整行一个 token。 */
  {
    name: '#version 330 core 整行一个 token',
    src: '#version 330 core\nvoid main() { }\n',
    want: (s) => s.includes('(version "#version 330 core")')
      || s.includes('(version #version 330 core)'),
  },
  /* 注释与块注释都吃掉。 */
  {
    name: '// 与 /* */ 两种注释都吃掉',
    src: 'void main() { /* a */ float x = 1.0; // b\n }\n',
    want: (s) => s.includes('(local-init (ty-float) x (float-lit 1.0))'),
  },
  /* `discard` 这一刀不实现，但语法里有一条 —— 不然它会被当成「一个叫 discard 的变量」
   * 悄悄收下（量过：`(expr-stmt (name discard))`）。「不收」这句话要由降级那一侧明着说，
   * 不能靠语法碰巧不认。 */
  {
    name: 'discard 是一条语句，不是一个变量名',
    src: 'void main() { discard; }\n',
    want: (s) => s.includes('(discard)'),
  },
  /* 结构体（施工图 B13）。名字进类型位靠的是 `pp.js` 的 `glslTypeNames()` 把后面的
   * `IV` 重判成 `TYPENAME` —— 语法这一层看到的是两种不同的记号，所以没有歧义。 */
  {
    name: 'struct 声明 + 用它当类型 + 构造',
    src: 'struct IV { vec2 v; int n; };\nIV mk() { return IV(vec2(1.0), 3); }\nvoid main() { IV a = mk(); }\n',
    want: (s) => s.includes('(struct-decl IV (fields-add (fields-add (fields) (field (ty-vec 2) v)) (field (ty-int) n)))')
      && s.includes('(construct (ty-name IV)')
      && s.includes('(local-init (ty-name IV) a'),
  },
  /* **上一次就栽在这一格**：给 `type` 加 `(-> (ID) …)` 之后 `length(v)` 被当成构造。
   * 现在声明了结构体也不会 —— `length` 没被重判，它还是 `ID`，走的是调用那条规则。 */
  {
    name: '声明了 struct 之后 length(v) 还是调用（上一次的回归点）',
    src: 'struct IV { vec2 v; };\nvoid main() { float L = length(vec2(1.0)); }\n',
    want: (s) => s.includes('(call length'),
  },
  /* 数组（B14）第 1 步。收的正是 `grapheq.glsl` 那 3 处的形状，一个字不多。
   * 取下标那一侧**没有新规则** —— 复用第十八片给 `m[0]` 取矩阵列时加的 `index`。 */
  {
    name: '局部数组声明 + 常量下标 + 变量下标',
    src: 'void main() { vec2 s[4]; s[0] = vec2(1.0); int i = 2; s[i] = s[i - 1]; }\n',
    want: (s) => s.includes('(local-arr (ty-vec 2) s 4)')
      && s.includes('(index (name s) (int-lit 0))')
      && s.includes('(index (name s) (name i))'),
  },
  /* 一条声明里多个变量（B15）—— 合成产物里那 4 行的形状。 */
  {
    name: '一条声明里三个变量',
    src: 'void main() { float a = 1.0, b = 2.0, c = 3.0; }\n',
    want: (s) => s.includes('(local-multi (ty-float) a (float-lit 1.0)')
      && s.includes('(one b (float-lit 2.0))')
      && s.includes('(one c (float-lit 3.0))'),
  },
];

for (const c of SHAPES) {
  const s = shape(c.src);
  if (c.want(s)) ok(c.name);
  else bad(c.name, `    得到：${s.slice(0, 400)}`);
}

/* ---- 四、该拒的要拒。语法不收的东西**必须报错**，不能悄悄分析成别的形状。 */
const REJECT = [
  { name: '采样器（这一刀不收）', src: 'uniform sampler2D t;\nvoid main() { }\n' },
  { name: '缺分号', src: 'void main() { float x = 1.0 }\n' },
  /* 平结构体收了，别的形状照旧不收 —— 见 `struct-decl` 那条规则上的注释。
   *
   * **嵌套结构体不在这儿拒**：`field -> (type ID ";")` 里 `type` 可以是 `TYPENAME`，
   * 所以「成员是另一个结构体」在语法上是通的。那条限制是**语义**的，由检查那一侧骂 ——
   * 语法保持上下文无关，别把语义塞进产生式里。 */
  { name: 'struct 顺带声明一个变量', src: 'struct S { float a; } s;\nvoid main() { }\n' },
  { name: '成员是数组', src: 'struct S { float a[3]; };\nvoid main() { }\n' },
  /* 数组只收最窄那一档（见 `local-decl` 上的注释）：带初值、大小不是字面量、
   * 模块作用域的，全不收。 */
  { name: '数组带初值', src: 'void main() { vec2 s[4] = vec2(0.0); }\n' },
  { name: '数组大小不是字面量', src: 'void main() { const int N = 4; vec2 s[N]; }\n' },
  { name: '模块作用域的数组', src: 'vec2 s[4];\nvoid main() { }\n' },
];
for (const c of REJECT) {
  const s = shape(c.src);
  if (s.startsWith('词法错') || s.startsWith('分析错') || s === '没有树') ok(`拒：${c.name}`);
  else bad(`该拒却收了：${c.name}`, `    ${s.slice(0, 300)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
