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

import { readSexpr } from '../../src/core/sexpr/read.js';
import { readGrammar } from '../../src/core/glr/grammar.js';
import { buildTable } from '../../src/core/glr/table.js';
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

const gdiags = new Diagnostics();
const gtext = readFileSync(GRAMMAR, 'utf8');
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, gtext), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

/** 一段源码 -> 带类型的模块。语法错与类型错都抛。 */
function mod(src, stage, name = 'probe') {
  const diags = new Diagnostics();
  const file = new SourceFile(name, src);
  const toks = lexText(g.lex, file, diags);
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
  ['discard 明着拒', 'discard;', 'discard 这一刀不收'],
  ['下标这一刀不收', 'float f = u_res[0];', '下标这一刀不收'],
  ['! 只对 bool', 'bool b = !u_t;', '! 要一个 bool'],
  ['向量不能用 <', 'bool b = u_res < u_res;', '只比标量'],
  ['swizzle 重复格不能当左值', 'vec3 c = vec3(0.0); c.xx = u_res;', '同一格出现两次'],
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
  ['版本不是 330', 'void main() { }', 'frag', '只收 #version 330'],
]) {
  const head = name === '版本不是 330' ? '#version 400 core\n' : '#version 330 core\n';
  let msg = null;
  try { mod(head + src, stage); } catch (e) { msg = e.message; }
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

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
