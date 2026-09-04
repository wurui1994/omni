// tests/glsl/check.js —— GLSL 子集的类型检查与名字解析（ADR-0019 第一刀第二片）
//
// 三段：
//
//   一、五份尺子源码都过得去，而且**接口摸出来的形状对**（uniform/in/out/函数各几个、
//       各是什么类型）——这一条比「不报错」有用：不报错也可能是把 `vec2` 认成了 `vec3`。
//   二、一堆小探针查**具体类型**：`uv.xyx` 是 vec3、`i < 20` 是 bool、`vec2 *= mat2` 收得下……
//   三、该拒的要拒，而且报错要**说到点上**（比对报错里的关键词，不只看它抛了）。
//
//   node tests/glsl/check.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { glslPreprocess, glslTypeNames } from '../../src/core/frontend-glsl/pp.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslCheck, glslTyText } from '../../src/core/frontend-glsl/check.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(name);
  else bad(name, `    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};

/* 表走带缓存的装载（ADR-0019 决策八第 1 步）：构表在这份语法上是 559 ms、
 * 命中缓存是 8 ms。**构表本身**由 `parse.js` 那一支盯（它刻意每趟现算），
 * 这里只是要一张能用的表。 */
const { g, tb } = loadGrammarTable(GRAMMAR);

/** 一段源码 -> 带类型的模块。语法错与类型错都抛。 */
function mod(src, stage, name = 'probe') {
  const diags = new Diagnostics();
  const file = new SourceFile(name, src);
  /* 与产品那条路同一趟：预处理（对象宏）+ 类型名重判（`struct N {…}` 之后的 `N`）。
   * 少了重判，`IV x;` 里的 `IV` 还是 `ID`，结构体那一档根本分析不出来。 */
  const toks = glslTypeNames(glslPreprocess(g.lex, lexText(g.lex, file, diags), diags));
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  if (tree === null) throw new Error('分析不出树');
  return glslCheck(tree, stage);
}

/* ---- 一、五份尺子源码。 */
const FILES = [
  ['bench-vert.vert', 'vert'],
  ['bench-simple.frag', 'frag'],
  ['bench-complex.frag', 'frag'],
  ['pretty-vert.vert', 'vert'],
  ['pretty.frag', 'frag'],
];
const mods = new Map();
for (const [f, stage] of FILES) {
  try {
    const m = mod(readFileSync(join(CASES, f), 'utf8'), stage, f);
    mods.set(f, m);
    ok(`${f}：过了类型检查（${m.funcs.length} 个函数、${m.uniforms.length} 个 uniform）`);
  } catch (e) {
    bad(`${f} 过不去`, `    ${e.message.split('\n')[0]}`);
  }
}

/* 接口的形状。这几个数是从源码里数出来的，不是抄检查器的输出。 */
if (mods.has('bench-simple.frag')) {
  const m = mods.get('bench-simple.frag');
  eq('bench-simple 的接口', [
    m.uniforms.map((u) => `${u.name}:${glslTyText(u.ty)}`),
    m.outs.map((o) => `${o.name}:${glslTyText(o.ty)}`),
    m.ins.length,
    m.funcs.map((f) => f.name),
  ], [['u_resolution:vec2'], ['fragColor:vec4'], 0, ['main']]);
}
if (mods.has('pretty.frag')) {
  const m = mods.get('pretty.frag');
  eq('pretty.frag 的接口', [
    m.uniforms.map((u) => `${u.name}:${glslTyText(u.ty)}`),
    m.ins.map((i) => `${i.name}:${glslTyText(i.ty)}:${i.interp}`),
    m.consts.map((c) => `${c.name}:${glslTyText(c.ty)}`),
    m.funcs.map((f) => `${f.name}:${glslTyText(f.ret)}/${f.params.length}`),
  ], [
    ['u_res:vec2', 'u_time:float'],
    ['v_uv:vec2:smooth'],
    ['PI:float'],
    ['sdCircle:float/2', 'sdHex:float/2', 'rot:mat2/1', 'hsv2rgb:vec3/1', 'main:void/0'],
  ]);
}
if (mods.has('bench-vert.vert')) {
  const m = mods.get('bench-vert.vert');
  eq('bench-vert 是顶点着色器，没有接口声明', [m.uniforms.length, m.ins.length, m.outs.length], [0, 0, 0]);
}

/* ---- 二、具体类型。每条探针只塞一句话，取 main 里最后那条声明的类型。 */

/** `void main(){ ... T x = EXPR; }` 里 `x` 的类型文本。 */
function tyOf(decls, expr, stage = 'frag') {
  const src = `#version 330 core\n${decls}void main() {\n  ${expr}\n}\n`;
  const m = mod(src, stage);
  const body = m.funcs[m.funcs.length - 1].body.body;
  const last = body[body.length - 1];
  if (last.k === 'decl') return glslTyText(last.ty === undefined ? last.init.ty : last.ty);
  if (last.k === 'expr') return glslTyText(last.e.ty);
  return `?${last.k}`;
}

const PRE = 'uniform vec2 u_res;\nuniform float u_t;\nout vec4 fragColor;\n';
const TYPES = [
  ['swizzle 三格是 vec3', 'vec3 c = u_res.xyx;', 'vec3'],
  ['swizzle 一格是 float', 'float f = u_res.x;', 'float'],
  ['rgba 那套也认', 'vec2 v = fragColor.rg;', 'vec2'],
  ['向量 op 标量是向量', 'vec2 v = u_res * 2.0;', 'vec2'],
  ['标量 op 向量是向量', 'vec2 v = 2.0 - u_res;', 'vec2'],
  ['int 隐式提成 float', 'float f = u_t * 2;', 'float'],
  ['比较回 bool', 'bool b = u_t < 2.0;', 'bool'],
  ['== 回 bool', 'bool b = u_res == u_res;', 'bool'],
  ['gl_FragCoord 是 vec4', 'vec4 p = gl_FragCoord;', 'vec4'],
  ['length 回 float', 'float f = length(u_res);', 'float'],
  ['min(vec2, float) 回 vec2', 'vec2 v = min(u_res, 0.0);', 'vec2'],
  ['smoothstep(f,f,f) 回 float', 'float f = smoothstep(0.0, 1.0, u_t);', 'float'],
  ['mix(vec3,vec3,float) 回 vec3', 'vec3 c = mix(vec3(0.0), vec3(1.0), u_t);', 'vec3'],
  ['dot 回 float', 'float f = dot(u_res, u_res);', 'float'],
  ['vec3 标量铺开', 'vec3 c = vec3(0.02);', 'vec3'],
  ['vec4(vec3, float) 拼得起来', 'vec4 c = vec4(vec3(1.0), 1.0);', 'vec4'],
  ['float(int) 是转换', 'float f = float(3);', 'float'],
  ['mat2 * vec2 是 vec2', 'vec2 v = mat2(1.0, 0.0, 0.0, 1.0) * u_res;', 'vec2'],
  ['vec2 * mat2 是 vec2', 'vec2 v = u_res * mat2(1.0, 0.0, 0.0, 1.0);', 'vec2'],
  ['mat2 * mat2 是 mat2', 'mat2 m = mat2(1.0) * mat2(1.0);', 'mat2'],
  ['三元两支同型', 'float f = u_t < 1.0 ? 2.0 : 3.0;', 'float'],
  ['三元一支 int 一支 float', 'float f = u_t < 1.0 ? 2 : 3.0;', 'float'],
  ['pow(vec3, vec3) 回 vec3', 'vec3 c = pow(vec3(1.0), vec3(2.0));', 'vec3'],
  /* 数组（B14）。类型文本是 `元素[n]` —— 数组是**结构性**类型（不像结构体那样名义），
   * 所以两个 `vec2[4]` 是同一个类型。 */
  ['数组声明的类型是 vec2[4]', 'vec2 s[4];', 'vec2[4]'],
  ['常量下标取出元素类型', 'vec2 s[4]; vec2 e = s[2];', 'vec2'],
  ['变量下标也取出元素类型', 'vec2 s[4]; int i = 1; vec2 e = s[i];', 'vec2'],
  ['算出来的下标（grapheq 的 m[cnt-1]）', 'vec2 m[4]; int cnt = 2; vec2 e = m[cnt - 1];', 'vec2'],
  ['下标之后再 swizzle', 'vec2 m[4]; int cnt = 2; float f = m[cnt - 1].y;', 'float'],
];
for (const [name, expr, want] of TYPES) {
  try {
    const got = tyOf(PRE, expr);
    if (got === want) ok(`${name}（${want}）`);
    else bad(name, `    want ${want}\n    got  ${got}`);
  } catch (e) {
    bad(name, `    抛了：${e.message.split('\n')[0]}`);
  }
}

/* `for` 的条件是 bool —— 单独一条，因为它是第一版真错过的那一格
 * （比较回了 int，于是条件那道检查把它骂成「整数不能当条件」）。 */
try {
  mod(`#version 330 core\nout vec4 fragColor;\nvoid main() {\n`
    + `  float d = 0.0;\n  for (int i = 0; i < 20; i++) { d += 1.0; }\n`
    + `  fragColor = vec4(d);\n}\n`, 'frag');
  ok('for (int i = 0; i < 20; i++) 的条件是 bool');
} catch (e) {
  bad('for 的条件', `    抛了：${e.message.split('\n')[0]}`);
}

/* 复合赋值：`p *= rot(a)` 那一格（vec2 *= mat2）。 */
try {
  mod(`#version 330 core\nuniform float u_t;\nout vec4 fragColor;\n`
    + `mat2 rot(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }\n`
    + `void main() {\n  vec2 p = vec2(1.0);\n  p *= rot(u_t);\n  fragColor = vec4(p, 0.0, 1.0);\n}\n`, 'frag');
  ok('vec2 *= mat2 收得下（尺子里 p *= rot(a) 那一格）');
} catch (e) {
  bad('vec2 *= mat2', `    抛了：${e.message.split('\n')[0]}`);
}

/* ---- 三、该拒的。`want` 是报错里必须出现的字，光「抛了」不算过。 */
const REJECT = [
  ['vec2 没有 .z', 'vec2 v = u_res; float f = v.z;', '没有第 3 格'],
  ['xyzw 与 rgba 不能混用', 'float f = fragColor.xg;', '不是同一套'],
  ['构造少一格', 'vec3 c = vec3(1.0, 2.0);', '要 3 格'],
  ['构造多一格', 'vec2 v = vec2(1.0, 2.0, 3.0);', '要 2 格'],
  ['向量宽度不一样不能相加', 'vec2 a = u_res; vec3 b = vec3(1.0); vec3 c = a + b;', '宽度不一样'],
  ['float 装不进 vec3', 'vec3 c = u_t;', '要一个 vec3'],
  ['vec3 装不进 float', 'float f = vec3(1.0);', '要一个 float'],
  ['整数不能当条件', 'if (1) { }', '条件要是 bool'],
  ['% 不对 float', 'float f = u_t % 2.0;', '% 只对 int'],
  ['uniform 不能赋值', 'u_res = vec2(1.0);', '不能赋值'],
  ['没见过的名字', 'float f = nope;', "没见过的名字 'nope'"],
  ['没见过的函数', 'float f = nope(1.0);', "没见过的函数 'nope'"],
  ['内建函数实参个数不对', 'float f = sin(1.0, 2.0);', 'sin 要 1 个实参'],
  /* 下标本身收了（第十八片：`m[0]` 取列、`v[0]` 取一格）。还挡着的是**动态**下标 ——
   * 那要方言里有真数组才做得对。越界那一条是新加的：常量下标能在编译期查。 */
  ['动态下标还挡着', 'int i = 0;\n  float f = u_res[i];', '整数字面量'],
  ['常量下标越界要骂', 'float f = u_res[2];', '取不到第 2 格'],
  /* 数组（B14）该拒的。**变量下标不在这儿** —— 数组正是为它开的口。 */
  ['数组常量下标越界', 'vec2 s[4]; vec2 e = s[4];', '取不到第 4 格'],
  ['数组下标不是 int', 'vec2 s[4]; vec2 e = s[u_t];', '数组下标要是 int'],
  ['数组摊平格数超上限', 'mat4 big[4];', '超过 32'],
  ['void 的数组', 'void v[2];', 'void 的数组'],
  ['! 只对 bool', 'bool b = !u_t;', '! 要一个 bool'],
  ['向量不能用 <', 'bool b = u_res < u_res;', '只比标量'],
  ['swizzle 重复格不能当左值', 'vec3 c = vec3(0.0); c.xx = u_res;', '同一格出现两次'],
  /* 采样器（规范 4.1.7）是不透明类型：只收 uniform，局部量拒。 */
  ['采样器不能是局部量', 'sampler2D s;', '采样器只能是 uniform'],
  ['texture 的第一个实参要是采样器', 'vec4 c = texture(u_res, u_res);', '要是采样器'],
];
for (const [name, body, want] of REJECT) {
  if (want === null) continue;
  let msg = null;
  try {
    mod(`#version 330 core\nuniform vec2 u_res;\nuniform float u_t;\nout vec4 fragColor;\n`
      + `void main() {\n  ${body}\n}\n`, 'frag');
  } catch (e) { msg = e.message; }
  if (msg === null) bad(`该拒却收了：${name}`, '    一声没响');
  else if (!msg.includes(want)) bad(`拒得不对：${name}`, `    要含「${want}」\n    实际：${msg.split('\n')[0]}`);
  else ok(`拒：${name}`);
}

/* 分档：`gl_FragCoord` 在顶点里不存在，`gl_VertexID` 在片元里不存在 —— 报错要点名。 */
for (const [name, src, stage, want] of [
  ['顶点里读 gl_FragCoord', 'void main() { gl_Position = gl_FragCoord; }', 'vert', '是片元着色器的内建变量'],
  ['片元里读 gl_VertexID', 'out vec4 c;\nvoid main() { c = vec4(float(gl_VertexID)); }', 'frag', '是顶点着色器的内建变量'],
  ['自己声明内建名字', 'out vec4 gl_FragCoord;\nvoid main() { }', 'frag', '是内建变量，不能自己声明'],
  /* `discard` 只有片元着色器有（规范 6.4）。片元那一档现在**收**它 —— 这一行盯的是
   * "别在顶点里悄悄收下"（那会让一份顶点着色器编过却没有任何 kill 的落处）。 */
  ['顶点里 discard', 'void main() { discard; }', 'vert', 'discard 只能写在片元着色器里'],
  /* 导数那三条也只有片元有（规范 8.9）。片元那一档收 —— 见 render.js / vispy_draw.js。 */
  ['顶点里 dFdx', 'void main() { gl_Position = vec4(dFdx(1.0)); }', 'vert',
    'dFdx 只能写在片元着色器里'],
  /* `texture` 的坐标要对上采样器的维数（规范 8.7）。这两条要一个采样器 uniform，
   * 所以放在这张"整份源码"的表里，不是上面那张共用前言的。 */
  ['sampler2D 的坐标要 vec2', 'uniform sampler2D t;\nout vec4 c;\n'
    + 'void main() { c = texture(t, 0.5); }', 'frag', '坐标要是 vec2'],
  ['sampler1D 的坐标要 float', 'uniform sampler1D t;\nout vec4 c;\n'
    + 'void main() { c = texture(t, vec2(0.5)); }', 'frag', '坐标要是 float'],
  /* 维数对不上的老写法也拒：`texture2D` 收的是 sampler2D。 */
  ['texture2D 不收 sampler1D', 'uniform sampler1D t;\nout vec4 c;\n'
    + 'void main() { c = texture2D(t, vec2(0.5)); }', 'frag', '要 sampler2D'],
  ['版本不是 330', 'void main() { }', 'frag', '只收 #version 330'],
]) {
  const head = name === '版本不是 330' ? '#version 400 core\n' : '#version 330 core\n';
  let msg = null;
  try { mod(head + src, stage); } catch (e) { msg = e.message; }
  if (msg === null) bad(`该拒却收了：${name}`, '    一声没响');
  else if (!msg.includes(want)) bad(`拒得不对：${name}`, `    要含「${want}」\n    实际：${msg.split('\n')[0]}`);
  else ok(`拒：${name}`);
}

/* 版本行收两档：`330`/`330 core`（桌面，两份尺子用的）与 `300 es`（GLSL ES 3.0，
 * `grapheq.glsl` 用的）。这两档在这个子集里没有需要分开处理的地方 —— 唯一真差别是
 * 精度限定符在 ES 上有语义，而这一层一律按一种精度算（与 330 那一档同一个做法）。 */
for (const [name, head] of [
  ['#version 330', '#version 330\n'],
  ['#version 330 core', '#version 330 core\n'],
  ['#version 300 es', '#version 300 es\n'],
]) {
  try {
    mod(`${head}out vec4 c;\nvoid main() { c = vec4(1.0); }\n`, 'frag');
    ok(`收：${name}`);
  } catch (e) { bad(`该收却拒了：${name}`, `    ${String(e.message ?? e).split('\n')[0]}`); }
}

for (const [name, head, want] of [
  ['#version 300 不带 es', '#version 300\n', "只存在于 GLSL ES"],
  ['#version 300 core', '#version 300 core\n', "只存在于 GLSL ES"],
  ['#version 330 es', '#version 330 es\n', '只收 core profile'],
  ['#version 400 core', '#version 400 core\n', '只收 #version 330 与 #version 300 es'],
]) {
  let msg = null;
  try { mod(`${head}out vec4 c;\nvoid main() { c = vec4(1.0); }\n`, 'frag'); } catch (e) { msg = e.message; }
  if (msg === null) bad(`该拒却收了：${name}`, '    一声没响');
  else if (!msg.includes(want)) bad(`拒得不对：${name}`, `    要含「${want}」\n    实际：${msg.split('\n')[0]}`);
  else ok(`拒：${name}`);
}

/* 没有 main 也要骂。 */
{
  let msg = null;
  try { mod('#version 330 core\nfloat f(float x) { return x; }\n', 'frag'); } catch (e) { msg = e.message; }
  if (msg !== null && msg.includes('没有 main')) ok('拒：没有 main');
  else bad('该拒却收了：没有 main', `    ${msg === null ? '一声没响' : msg.split('\n')[0]}`);
}

/* 限定符那一族（第二十四片）：`layout(location=N)`、`precision`、`invariant`、
 * `centroid`/`sample`。**正面**只查一件事 —— 收下来之后接口的形状与不写限定符时**一样**
 * （位置号这一刀只用来查冲突，不改变布局）。 */
{
  const src = `#version 330 core
precision highp float;
layout(location = 0) out vec4 fragColor;
layout(location = 3) uniform float uK;
invariant gl_FragDepth;
centroid in vec2 vUv;
sample in float vW;
void main() { fragColor = vec4(uK + vUv.x + vW, 0.0, 0.0, 1.0); }
`;
  const m = mod(src, 'frag');
  eq('限定符：uniform 摸出来还是那一个', m.uniforms.map((u) => `${u.name}:${glslTyText(u.ty)}`), ['uK:float']);
  eq('限定符：in 摸出来两个，插值都当 smooth',
    m.ins.map((v) => `${v.name}:${glslTyText(v.ty)}:${v.interp}`), ['vUv:vec2:smooth', 'vW:float:smooth']);
  eq('限定符：out 摸出来还是那一个', m.outs.map((v) => `${v.name}:${glslTyText(v.ty)}`), ['fragColor:vec4']);
}

for (const [name, src, want] of [
  ['location 抢同一个号', `#version 330 core
layout(location = 2) uniform float a;
layout(location = 2) uniform float b;
out vec4 c;
void main() { c = vec4(a + b); }
`, '被 \'a\' 与 \'b\' 抢了两次'],
  ['layout 里不认的键', `#version 330 core
layout(binding = 0) uniform float a;
out vec4 c;
void main() { c = vec4(a); }
`, '只认 location'],
]) {
  let msg = null;
  try { mod(src, 'frag'); } catch (e) { msg = e.message; }
  if (msg === null) bad(`该拒却收了：${name}`, '    一声没响');
  else if (!msg.includes(want)) bad(`拒得不对：${name}`, `    要含「${want}」\n    实际：${msg.split('\n')[0]}`);
  else ok(`拒：${name}`);
}

/* 结构体（施工图 B13）：**平**的那一档。正面查「登记上了 + 成员访问的类型对」，
 * 负面把不收的那些逐条钉住。名字能进类型位靠 `pp.js` 的 `glslTypeNames()`。 */
{
  const src = `#version 330 core
struct IV { vec2 v; int n; };
out vec4 c;
void main() { IV a = IV(vec2(1.0, 2.0), 3); c = vec4(a.v, float(a.n), 1.0); }
`;
  try {
    const m = mod(src, 'frag');
    eq('结构体：表里登记了一个', m.structs.map((s) => s.name), ['IV']);
    eq('结构体：成员的类型与次序', m.structs[0].fields.map((f) => `${f.name}:${glslTyText(f.ty)}`),
      ['v:vec2', 'n:int']);
  } catch (e) { bad('结构体：正面这一份过不去', `    ${String(e.message ?? e).split('\n')[0]}`); }
}

for (const [name, src, want] of [
  ['嵌套结构体（语义拒，不是语法拒）', `#version 330 core
struct A { float a; };
struct B { A a; };
out vec4 c;
void main() { c = vec4(1.0); }
`, '只收**平**结构体'],
  ['成员名重复', `#version 330 core
struct A { float a; float a; };
out vec4 c;
void main() { c = vec4(1.0); }
`, "有两个成员叫 'a'"],
  ['结构体定义两次', `#version 330 core
struct A { float a; };
struct A { float b; };
out vec4 c;
void main() { c = vec4(1.0); }
`, "定义了两次"],
  ['取一个没有的成员', `#version 330 core
struct A { float a; };
out vec4 c;
void main() { A x = A(1.0); c = vec4(x.b); }
`, "没有成员 'b'"],
  ['构造的实参个数不对', `#version 330 core
struct A { float a; float b; };
out vec4 c;
void main() { A x = A(1.0); c = vec4(x.a); }
`, '要 2 个实参'],
]) {
  let msg = null;
  try { mod(src, 'frag'); } catch (e) { msg = String(e.message ?? e); }
  if (msg === null) bad(`该拒却收了：${name}`, '    一声没响');
  else if (!msg.includes(want)) bad(`拒得不对：${name}`, `    要含「${want}」\n    实际：${msg.split('\n')[0]}`);
  else ok(`拒：${name}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
