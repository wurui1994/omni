// tests/glsl/fns.js —— 内建函数补全：8.1/8.3 剩下的标量几条 + 8.4 几何三条 + 8.5 矩阵五条
// （ADR-0019 第二十三片）
//
// 三条腿都跑，期望值由这门自己独立算一遍。**用得出准确值的输入**：
// 方言印 real 走 `%g`（6 位有效），所以取样点一律挑「结果在二进制下是精确的」那些
// （整数、二分之一、二的幂），不精确的（`atan2`、`sinh`）先乘 1e6 再 `floor` ——
// 比的是同一个数，不是同一种排版。
//
//   node tests/glsl/fns.js

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslPreprocess, glslTypeNames } from '../../src/core/frontend-glsl/pp.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';
import { glslLower } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const OUT = join(tmpdir(), 'omni-glsl-fns');

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
  /* 与产品那条路同一趟：预处理（对象宏）+ 类型名重判（`struct N {…}` 之后的 `N`）。 */
  const toks = glslTypeNames(glslPreprocess(g.lex, lexText(g.lex, file, diags), diags));
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
  const driver = ks.map((k) => `    (print (call glsl_probe (int ${k})))`).join('\n');
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

/* ---- 一、`atan(y, x)`：从前它是**坏的**（发出去的是一参的 atan，方言当场骂） ------ */

probe('atan(y, x) 走 atan2', `
float probe(int k) {
  return floor(atan(1.0, 2.0) * 1000000.0);
}`, [0], () => Math.floor(Math.atan2(1, 2) * 1e6));

/* ---- 二、`exp2` / `log2`：rmath 里没有，展开成 pow / log ------------------------ */

probe('exp2 与 log2', `
float probe(int k) {
  return exp2(3.0) + log2(1024.0) * 100.0;
}`, [0], () => 2 ** 3 + Math.log2(1024) * 100);

/* ---- 三、双曲那六条（rmath 有，从前只是没进表） --------------------------------- */

probe('sinh / cosh / tanh / asinh / acosh / atanh', `
float probe(int k) {
  return sinh(0.0) + cosh(0.0) * 2.0 + tanh(0.0) * 4.0
    + asinh(0.0) * 8.0 + acosh(1.0) * 16.0 + atanh(0.0) * 32.0
    + floor(sinh(1.0) * 1000.0);
}`, [0], () => 0 + 1 * 2 + 0 + 0 + 0 + 0 + Math.floor(Math.sinh(1) * 1e3));

/* ---- 四、`trunc` / `round` / `roundEven`（三个的「一半」规则各不同） ------------- */

probe('trunc / round / roundEven', `
float probe(int k) {
  return trunc(-2.7) + trunc(2.7) * 2.0
    + round(2.5) * 4.0 + round(-2.5) * 8.0
    + roundEven(2.5) * 16.0 + roundEven(3.5) * 32.0 + roundEven(-2.5) * 64.0;
}`, [0], () => {
  /* `trunc` 往零、`round` 一半往远离零（C 的 round）、`roundEven` 一半取偶。
   * 这三条的差别正好在 ±2.5 那两个点上现形。 */
  const trunc = (x) => Math.trunc(x);
  const round = (x) => Math.sign(x) * Math.round(Math.abs(x));
  return trunc(-2.7) + trunc(2.7) * 2 + round(2.5) * 4 + round(-2.5) * 8
    + 2 * 16 + 4 * 32 + (-2) * 64;
});

/* ---- 五、几何那三条（8.4） ------------------------------------------------------ */

probe('reflect / faceforward', `
float probe(int k) {
  vec2 I = vec2(1.0, -1.0);
  vec2 N = vec2(0.0, 1.0);
  vec2 rf = reflect(I, N);
  vec2 ff = faceforward(N, I, N);
  return rf.x + rf.y * 2.0 + ff.x * 4.0 + ff.y * 8.0;
}`, [0], () => {
  /* d = dot(N,I) = -1；reflect = I - 2d·N = (1, 1)。
   * faceforward：dot(Nref,I) < 0 -> N，也就是 (0,1)。 */
  return 1 + 1 * 2 + 0 * 4 + 1 * 8;
});

probe('refract（含 k < 0 那一支回全 0）', `
float probe(int k) {
  vec2 N = vec2(0.0, 1.0);
  vec2 a = refract(vec2(0.0, -1.0), N, 1.0);
  vec2 b = refract(vec2(0.6, -0.8), N, 2.0);
  return a.x + a.y * 2.0 + b.x * 4.0 + b.y * 8.0;
}`, [0], () => {
  /* a：eta=1、d=-1 -> k=1 -> I - 0·N = (0,-1)。
   * b：d=-0.8、k = 1 - 4(1-0.64) = -0.44 < 0 -> 全 0（规范 8.4 明写的）。 */
  return 0 + (-1) * 2 + 0 + 0;
});

/* ---- 六、矩阵那五条（8.5） ------------------------------------------------------ */

probe('determinant / inverse（m * inverse(m) 是单位阵）', `
float probe(int k) {
  mat2 m = mat2(1.0, 0.0,   1.0, 1.0);
  mat2 im = inverse(m);
  mat2 id = m * im;
  mat3 p = mat3(2.0, 0.0, 0.0,   0.0, 4.0, 0.0,   0.0, 0.0, 8.0);
  mat3 ip = inverse(p);
  mat3 id3 = p * ip;
  return determinant(m) + determinant(p) * 2.0
    + (id[0].x + id[1].y) * 4.0 + (id[0].y + id[1].x) * 8.0
    + (id3[0].x + id3[1].y + id3[2].z) * 16.0
    + (id3[0].y + id3[1].z + id3[2].x) * 32.0;
}`, [0], () => {
  /* 取样点全挑**二进制下精确**的：错切阵（det 1、逆是整数）与 2/4/8 的对角阵
   * （逆是 0.5/0.25/0.125）。这样「单位阵」是逐位的 1 与 0，不是「约等于」。 */
  return 1 + 2 * 4 * 8 * 2 + 2 * 4 + 0 + 3 * 16 + 0;
});

probe('matrixCompMult / transpose / outerProduct', `
float probe(int k) {
  mat2 m = mat2(4.0, 2.0,   7.0, 6.0);
  mat2 cm = matrixCompMult(m, m);
  mat3x2 t = transpose(mat2x3(1.0, 2.0, 3.0,   4.0, 5.0, 6.0));
  mat2 op = outerProduct(vec2(1.0, 2.0), vec2(3.0, 4.0));
  return cm[0].x + cm[1].y * 2.0
    + t[0].x * 4.0 + t[0].y * 8.0 + t[2].y * 16.0
    + op[0].x * 32.0 + op[1].y * 64.0;
}`, [0], () => {
  /* cm 逐格乘：16 与 36。
   * transpose(mat2x3(1..6))：原来第 0 列 (1,2,3)、第 1 列 (4,5,6)；
   *   转完是 3 列 2 行，第 0 列 = 原来第 0 行 = (1,4)，第 2 列 = 原来第 2 行 = (3,6)。
   * outerProduct(c=(1,2), r=(3,4))：第 col 列 = c * r[col] -> 第 0 列 (3,6)、第 1 列 (4,8)。 */
  return 16 + 36 * 2 + 1 * 4 + 4 * 8 + 6 * 16 + 3 * 32 + 8 * 64;
});

/* ---- 七、`out` / `inout` 形参（第二十五片） -------------------------------------
 *
 * 方言里没有引用参数，所以这一族**从返回值那一头回来**：带 out 形参的函数落成
 * 「返回一个专用结构体」（返回值那几格 + 每个 out/inout 那几格），调用点拆开写回去。
 * 门查的正是「写回去了」以及「写回发生在返回之后」（copy-in/copy-out，不是引用）。 */

probe('inout / out / out+返回值 一起用', `
void addOne(inout float x) { x += 1.0; }
float split(vec2 v, out float lo, out float hi) {
  lo = min(v.x, v.y);
  hi = max(v.x, v.y);
  return hi - lo;
}
void twice(out vec2 p, in float s) { p = vec2(s, s + s); }
float probe(int k) {
  float a = 5.0;
  addOne(a);
  float lo = 0.0;
  float hi = 0.0;
  float d = split(vec2(3.0, 8.0), lo, hi);
  vec2 p = vec2(0.0);
  twice(p, 2.0);
  return a + lo * 10.0 + hi * 100.0 + d * 1000.0 + p.x * 10000.0 + p.y * 100000.0;
}`, [0], () => 6 + 3 * 10 + 8 * 100 + 5 * 1000 + 2 * 10000 + 4 * 100000);

probe('out 写回到 swizzle 的那几格', `
void fill(out float x, out float y) { x = 1.0; y = 2.0; }
float probe(int k) {
  vec3 v = vec3(9.0, 9.0, 9.0);
  fill(v.z, v.x);
  return v.x + v.y * 10.0 + v.z * 100.0;
}`, [0], () => 2 + 9 * 10 + 1 * 100);

probe('inout 是 copy-in/copy-out：写回只发生在返回那一刻', `
float bump(inout float x) {
  x = 9.0;
  return x * 2.0;
}
float probe(int k) {
  float a = 1.0;
  float r = bump(a);
  return a + r * 10.0;
}`, [0], () => 9 + 18 * 10);

/* ---- 八、该骂的明着骂 ---------------------------------------------------------- */

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

rejects('determinant 不收非方阵', `
float probe(int k) { return determinant(mat2x3(1.0)); }`, '只对方阵');

rejects('inverse 不收非方阵', `
float probe(int k) { return inverse(mat3x2(1.0))[0].x; }`, '只对方阵');

rejects('matrixCompMult 两个矩阵要同型', `
float probe(int k) { return matrixCompMult(mat2(1.0), mat3(1.0))[0].x; }`, '要同型');

rejects('reflect 的实参要同型', `
float probe(int k) { return reflect(vec2(1.0, 2.0), vec3(1.0, 2.0, 3.0)).x; }`, '宽度不一样');

rejects('refract 的 eta 要是标量', `
float probe(int k) { return refract(vec2(1.0), vec2(0.0, 1.0), vec2(1.0)).x; }`, 'eta 要是标量');

rejects('outerProduct 要两个向量', `
float probe(int k) { return outerProduct(mat2(1.0), vec2(1.0))[0].x; }`, '要是 vecN');

rejects('out 形参的实参不能是字面量', `
void fill(out float x) { x = 1.0; }
float probe(int k) { fill(1.0); return 0.0; }`, '要给一个能写的左值');

rejects('out 形参的实参不能是 const', `
const float C = 1.0;
void fill(out float x) { x = 1.0; }
float probe(int k) { fill(C); return 0.0; }`, '写不进去');

rejects('out 形参不做隐式转换', `
void fill(out float x) { x = 1.0; }
float probe(int k) { vec2 v = vec2(0.0); fill(v); return 0.0; }`, '要正好是 float');

/* ---- 九、`isnan` / `isinf`（8.3）—— `grapheq.glsl` 那 772 行最要紧的缺口 ---------
 *
 * NaN/Inf 从哪来：`sqrt(-1.0)` 出 NaN、`-log(0.0)` 出 +Inf，三条腿都得同意这两个入口。
 * （`1.0/0.0` 与 `0.0/0.0` 也能用 —— 报错的只有**整数**除零，量过。）
 *
 * 落法只用已有算符：`isnan(x)` = `x != x`、`isinf(x)` = `x == x && (x-x) != 0`。
 * 后一条**没有**写成「|x| > 最大有限值」—— 方言的 real 是 f64、GLSL 的 highp float 是
 * f32，那个阈值在两种宽度下不是同一个数。 */

probe('isnan / isinf（标量与向量）', `
float probe(int k) {
  float nan = sqrt(-1.0);
  float inf = -log(0.0);
  bvec2 v = isnan(vec2(nan, 1.0));
  return (isnan(nan) ? 1.0 : 0.0) + (isnan(1.0) ? 2.0 : 0.0)
    + (isinf(inf) ? 4.0 : 0.0) + (isinf(1.0) ? 8.0 : 0.0)
    + (isinf(nan) ? 16.0 : 0.0) + (isnan(inf) ? 32.0 : 0.0)
    + (any(v) ? 64.0 : 0.0) + (all(v) ? 128.0 : 0.0);
}`, [0], () => 1 + 4 + 64);

rejects('isnan 要 1 个实参', `
float probe(int k) { return isnan(1.0, 2.0) ? 1.0 : 0.0; }`, '要 1 个实参');

/* ---- 十、结构体（施工图 B13）：**平**的那一档，三条腿摊平之后还是同一个数 --------
 *
 * 分量摊平的次序就是成员的次序，成员访问是**切片**（起始格号由检查那一侧算好）。
 * 第一条刻意让摊平之后混着 `real` 与 `int` —— 那正是 `glslCompTys` 存在的理由。 */

probe('struct：构造 + 成员，摊平后混着 real/int', `
struct IV { vec2 v; int n; };
float probe(int k) {
  IV a = IV(vec2(1.5, 2.5), 7);
  return a.v.x + a.v.y * 2.0 + float(a.n) * 4.0;
}`, [0], () => 1.5 + 2.5 * 2 + 7 * 4);

probe('struct：当形参传（摊成 N 个标量）', `
struct P { vec2 p; float w; };
float len2(P q) { return q.p.x * q.p.x + q.p.y * q.p.y + q.w; }
float probe(int k) { return len2(P(vec2(3.0, 4.0), 0.5)); }`, [0], () => 9 + 16 + 0.5);

probe('struct：当返回值（分量类型全一样那一档）', `
struct V2 { vec2 a; vec2 b; };
V2 mk() { return V2(vec2(1.0, 2.0), vec2(4.0, 8.0)); }
float probe(int k) { V2 v = mk(); return v.a.x + v.a.y * 2.0 + v.b.x * 4.0 + v.b.y * 8.0; }`,
  [0], () => 1 + 2 * 2 + 4 * 4 + 8 * 8);

/* 返回值装的是方言的 `glsl_vN`（N 个 real），所以分量类型不全一样的结构体会把 int
 * 悄悄变成 real —— 明着骂，不悄悄算。 */
rejects('返回分量类型不一样的结构体', `
struct Segs { vec2 s0; int n; };
Segs mk() { return Segs(vec2(1.0), 2); }
float probe(int k) { Segs s = mk(); return float(s.n); }`, '返回分量类型不一样的结构体');

/* ---- 十一、数组（施工图 B14）：**变量下标**那一档 ------------------------------------
 *
 * 摊平模型里没有内存，所以：常量下标 = 切片；变量下标 = n 条 `if`（读写都是）。
 * 三条腿都得给同一个数 —— 这一节要压的正是「下标算出来才知道」那些形状，
 * 因为 `grapheq.glsl` 的 `iv_join4()` 全是这种：`s[j + 1] = s[j]`、`m[cnt - 1].y = …`。 */

probe('数组：常量下标读写', `
float probe(int k) {
  vec2 s[4];
  s[0] = vec2(1.0, 2.0); s[1] = vec2(4.0, 8.0);
  return s[0].x + s[0].y * 2.0 + s[1].x * 4.0 + s[1].y * 8.0;
}`, [0], () => 1 + 2 * 2 + 4 * 4 + 8 * 8);

probe('数组：没赋过值的格子是 0', `
float probe(int k) {
  vec2 s[4];
  return s[2].x + s[3].y + 1.0;
}`, [0], () => 1);

probe('数组：变量下标读', `
float probe(int k) {
  vec2 s[4];
  s[0] = vec2(1.0, 0.0); s[1] = vec2(2.0, 0.0);
  s[2] = vec2(4.0, 0.0); s[3] = vec2(8.0, 0.0);
  return s[k].x;
}`, [0, 1, 2, 3], (k) => [1, 2, 4, 8][k]);

probe('数组：变量下标写', `
float probe(int k) {
  vec2 s[4];
  s[k] = vec2(9.0, 0.0);
  return s[0].x + s[1].x * 2.0 + s[2].x * 4.0 + s[3].x * 8.0;
}`, [0, 1, 2, 3], (k) => 9 * [1, 2, 4, 8][k]);

probe('数组：算出来的下标（grapheq 的 m[cnt - 1]）', `
float probe(int k) {
  vec2 m[4];
  m[0] = vec2(1.0, 2.0); m[1] = vec2(3.0, 4.0); m[2] = vec2(5.0, 6.0);
  int cnt = k + 1;
  return m[cnt - 1].y;
}`, [0, 1, 2], (k) => [2, 4, 6][k]);

/* 左边是「变量下标 + swizzle」—— `grapheq.glsl` 的 `m[cnt-1].y = max(m[cnt-1].y, …)`
 * 就是这一条。只写那一格，别的格子一个都不能动。 */
probe('数组：变量下标 + swizzle 当左值', `
float probe(int k) {
  vec2 m[4];
  m[0] = vec2(1.0, 2.0); m[1] = vec2(3.0, 4.0);
  m[k].y = 99.0;
  return m[0].x + m[0].y * 10.0 + m[1].x * 100.0 + m[1].y * 1000.0;
}`, [0, 1], (k) => (k === 0 ? 1 + 99 * 10 + 3 * 100 + 4 * 1000 : 1 + 2 * 10 + 3 * 100 + 99 * 1000));

probe('数组：下标越界一格都不写、读出来是 0', `
float probe(int k) {
  vec2 s[2];
  s[0] = vec2(1.0, 0.0); s[1] = vec2(2.0, 0.0);
  s[k] = vec2(7.0, 0.0);
  return s[0].x * 10.0 + s[1].x + s[k].x * 100.0;
}`, [0, 1, 5], (k) => {
  if (k === 0) return 7 * 10 + 2 + 7 * 100;
  if (k === 1) return 1 * 10 + 7 + 7 * 100;
  return 1 * 10 + 2 + 0;
});

/* 整段插入排序 —— `iv_join4()` 的前半截逐字搬过来（`s[j].x <= key.x` 就停、
 * 否则往后挪一格）。这一条压的是「内层 `for` 的游标当下标，读和写都是」。 */
probe('数组：按 lo 插入排序（iv_join4 的前半截）', `
float probe(int k) {
  vec2 s[4];
  s[0] = vec2(3.0, 0.0); s[1] = vec2(1.0, 0.0);
  s[2] = vec2(4.0, 0.0); s[3] = vec2(2.0, 0.0);
  for (int i = 1; i < 4; i++) {
    vec2 key = s[i];
    int j = i - 1;
    for (; j >= 0; j--) { if (s[j].x <= key.x) break; s[j + 1] = s[j]; }
    s[j + 1] = key;
  }
  return s[0].x + s[1].x * 10.0 + s[2].x * 100.0 + s[3].x * 1000.0;
}`, [0], () => 1 + 2 * 10 + 3 * 100 + 4 * 1000);

rejects('数组常量下标越界', `
float probe(int k) { vec2 s[2]; return s[2].x; }`, '取不到第 2 格');

rejects('数组摊平格数超上限', `
float probe(int k) { mat4 big[4]; return big[0][0].x; }`, '超过 32');

/* ---- 十二、一条声明里多个变量（施工图 B15）-------------------------------------------
 *
 * 合成产物里那 4 行的形状（`float lo = m[0].x, hi = m[cnt - 1].y;`）。要紧的一格是
 * **次序**：前一个的名字对后一个是可见的，所以第二条用例拿 `a` 去算 `b`。 */

probe('一条声明里三个变量', `
float probe(int k) {
  float a = 1.0, b = 2.0, c = 4.0;
  return a + b * 10.0 + c * 100.0;
}`, [0], () => 1 + 20 + 400);

probe('后一个能用前一个（次序）', `
float probe(int k) {
  vec2 m[2];
  m[0] = vec2(3.0, 5.0); m[1] = vec2(7.0, 11.0);
  float lo = m[0].x, hi = m[k].y, mid = lo + hi;
  return mid;
}`, [0, 1], (k) => 3 + [5, 11][k]);

rejects('一条声明里两个变量类型不合', `
float probe(int k) { float a = 1.0, b = vec2(1.0); return a + b; }`, '要一个 float');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
