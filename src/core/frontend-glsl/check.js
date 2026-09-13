/**
 * GLSL 子集的**类型检查与名字解析** —— ADR-0019 第一刀第二片。
 *
 * 语法那一半是数据（`glsl.grammar`，0 处冲突）。这一份做语法**办不到**的那一半，
 * 每一条都要先知道类型：
 *
 *   - swizzle 那串字母合不合法（`vec2` 没有 `.z`；`c.xxx` 是三个都取 x，合法）
 *   - 构造的元数（`vec3(a,b)` 少一格；`vec3(0.02)` 是标量铺开，合法）
 *   - 混算的提升（向量 op 标量、`int` 隐式变 `float`）
 *   - 内建函数的重载（`min(vec3, float)` 合法，`min(vec3, vec2)` 不合法）
 *   - `gl_FragCoord` 只在片元里有、`gl_VertexID`/`gl_Position` 只在顶点里有
 *
 * 出来的是一棵**带类型的树**（下面 `Expr`/`Stmt` 那两组形状），不是在原树上挂属性。
 * 理由：降级那一侧要的是「每个节点的类型已经定了」，而原树上 `(add a b)` 的类型取决于
 * 两个子节点 —— 让降级再算一遍就是把同一套规则写两遍，而两遍必然会分叉。
 *
 * ## 模块级名字都带 `glsl` 前缀
 *
 * 自举那一版把所有模块摊进同一个作用域，模块级的名字必须全局唯一（`ty`/`check` 这种
 * 名字在别处一定撞）。所以这一份里凡是导出的、模块级的，一律 `glsl*` / `GLSL_*`。
 *
 * ## 这一片**不做**的
 *
 * 降级（那是第三片）、常量折叠、死代码。
 */

import { OmniError } from '../source/diag.js';
import { castRow } from '../frontend-engine/casts.js';
import { lookupEntry } from '../frontend-engine/scopes.js';

/* ------------------------------------------------------------------ 类型 */

/**
 * 类型的形状：
 *
 *   `{k:'void'}` `{k:'bool'}` `{k:'int'}` `{k:'float'}`
 *   `{k:'vec', n:2|3|4, base:'float'|'int'|'bool'}`
 *   `{k:'mat', cols:2|3|4, rows:2|3|4}`（只有 float 矩阵 —— GLSL 里没有整数矩阵）
 *
 * 矩阵记的是**列数与行数**，不是一个 `n`：`mat2x3` 是 2 列 3 行（规范 5.6），
 * 而 `mat2` 就是 `mat2x2`。摊平的次序始终是**列优先**，第 c 列占
 * `c*rows .. c*rows+rows-1`。
 */
export const GLSL_VOID = { k: 'void' };
export const GLSL_BOOL = { k: 'bool' };
export const GLSL_INT = { k: 'int' };
export const GLSL_FLOAT = { k: 'float' };

const glslVec = (n, base) => ({ k: 'vec', n, base });
const glslMat = (cols, rows) => ({ k: 'mat', cols, rows });
/** 结构体（施工图 B13）：**平**的那一档 —— 成员是标量/向量/矩阵。名义类型，按名字比。 */
const glslStruct = (name, fields) => ({ k: 'struct', name, fields });

/** 数组（B14）。`of` 是元素类型、`n` 是常量大小。**结构性**类型（不像结构体那样名义）——
 * `vec2[4]` 与 `vec2[4]` 是同一个类型，`glslTyText` 出的字符串就是身份。
 *
 * 形参**不能叫 `of`** —— 那是自编译子集词法里的关键字（`for … of`）。属性名叫 `of`
 * 没关系，受限的只有绑定名。（这一条 `emit_llvm.js` 里写过，我在这儿又栽了一次：
 * `tests/glsl/*` 全绿而 `tests/js-roundtrip` 红了三个提交 —— 那条门才是管这个的。） */
const glslArray = (elem, n) => ({ k: 'array', of: elem, n });

/** 摊平后最多几格。`grapheq.glsl` 那 3 处都是 `vec2[4]` = 8 格，32 留了四倍余量。
 * 这个数不是保守起见随手写的：它是「变量下标落成 select 链」那条决策的代价上限。 */
const GLSL_ARR_MAX_CELLS = 32;



/** 打印出来给报错用。 */
export function glslTyText(t) {
  if (t.k === 'vec') {
    const p = t.base === 'float' ? 'vec' : t.base === 'int' ? 'ivec' : 'bvec';
    return `${p}${t.n}`;
  }
  if (t.k === 'mat') return t.cols === t.rows ? `mat${t.cols}` : `mat${t.cols}x${t.rows}`;
  /* 结构体是**名义**类型：GLSL 里两个成员完全一样但名字不同的结构体不能互相赋值，
   * 所以拿名字当身份 —— `glslSame` 比的就是这个字符串。 */
  if (t.k === 'struct') return t.name;
  if (t.k === 'array') return `${glslTyText(t.of)}[${t.n}]`;
  /* 采样器（规范 4.1.7）：`sampler1D` / `sampler2D`。 */
  if (t.k === 'sampler') return `sampler${t.dim}D`;
  return t.k;
}

const glslSame = (a, b) => glslTyText(a) === glslTyText(b);

/* ---- 函数重载（GLSL 规范 6.1）的两个小工具 ----------------------------------
 * `glslSigKey` 是**身份**：同一个名字下两份重载，形参类型串相同就是同一份
 * （规范说返回类型不参与重载，所以键里没有它）。它也是发出去的名字的后缀，
 * 所以要是个合法标识符 —— `vec3` -> `vec3`、`vec2[4]` -> `vec2_4`。
 * `glslSigText` 是给人看的那一份（错误消息里）。 */
function glslSigKey(params) {
  return params.map((p) => glslTyText(p.ty).replace(/\[(\d+)\]/g, '_$1')).join('_');
}

function glslSigText(params) {
  return params.map((p) => glslTyText(p.ty)).join(', ');
}

/** 能不能隐式转过去。与 `coerce` **逐条对齐**（那一份是真的转，这一份只是问）。 */
function glslCanCoerce(from, to) {
  if (glslSame(from, to)) return true;
  if (to.k === 'float' && from.k === 'int') return true;
  return to.k === 'vec' && to.base === 'float'
    && from.k === 'vec' && from.base === 'int' && from.n === to.n;
}

/** 标量吗（`float`/`int`/`bool`）。 */
const glslIsScalar = (t) => t.k === 'float' || t.k === 'int' || t.k === 'bool';

/** 整数那一族：`int` 与 `ivecN`。位运算与移位只认它们（规范 5.9）。 */
const glslIsIntish = (t) => t.k === 'int' || (t.k === 'vec' && t.base === 'int');


/** 这个类型的**元素**类型：`vec3` -> `float`、`ivec2` -> `int`、标量 -> 自己。 */
function glslElem(t) {
  if (t.k === 'vec') return t.base === 'float' ? GLSL_FLOAT : t.base === 'int' ? GLSL_INT : GLSL_BOOL;
  if (t.k === 'mat') return GLSL_FLOAT;
  return t;
}

/** 有几格：标量 1、`vecN` N、`matCxR` C*R、结构体是各成员之和、数组是 n 份（**摊平**数）。 */
function glslCount(t) {
  if (t.k === 'vec') return t.n;
  if (t.k === 'mat') return t.cols * t.rows;
  if (t.k === 'array') return t.n * glslCount(t.of);
  if (t.k === 'struct') {
    let n = 0;
    for (const f of t.fields) n += glslCount(f.ty);
    return n;
  }
  return 1;
}

/** 语法树里的 `(ty-vec 3)` 一类 -> 上面那种形状。`structs` 只在收 `(ty-name N)` 时要。 */
function glslTyOf(node, err, structs) {
  const h = glslHead(node);
  if (h === 'ty-void') return GLSL_VOID;
  if (h === 'ty-bool') return GLSL_BOOL;
  if (h === 'ty-int') return GLSL_INT;
  if (h === 'ty-uint') throw err(node, 'uint 这一刀不收（两份尺子里都没有）');
  if (h === 'ty-float') return GLSL_FLOAT;
  if (h === 'ty-name') {
    /* 名字能走到这儿说明 `pp.js` 的 `glslTypeNames()` 已经把它重判成 `TYPENAME` 了 ——
     * 也就是前面真有一条 `struct N {…};`。查不到只可能是这一层没登记上。 */
    const nm = glslAtom(node.items[1]);
    const t = structs === undefined ? undefined : structs.get(nm);
    if (t === undefined) throw err(node, `没见过的结构体类型 '${nm}'`);
    return t;
  }
  const n = Number(node.items[1].value);
  /* 采样器（规范 4.1.7）：**不透明**类型。`n` 是维数（1 或 2）。
   * 它只能当 uniform（与函数形参），不能算、不能构造、不能当返回值 —— 那几条在
   * 声明与表达式那两处拦（见 `decl` 的 uniform 那一格与 `binary`）。 */
  if (h === 'ty-sampler') return { k: 'sampler', dim: n };
  if (h === 'ty-vec') return glslVec(n, 'float');
  if (h === 'ty-ivec') return glslVec(n, 'int');
  if (h === 'ty-bvec') return glslVec(n, 'bool');
  /* `(ty-mat C R)`：C 列 R 行。`mat3` 在语法那侧就摊成了 `(ty-mat 3 3)`。 */
  if (h === 'ty-mat') return glslMat(n, Number(node.items[2].value));
  throw err(node, `认不出的类型 ${h}`);
}

/* ------------------------------------------------------------ 树的小工具 */

const glslHead = (n) => (n !== null && n !== undefined && n.kind === 'list'
  && n.items.length > 0 && n.items[0].kind === 'atom' ? n.items[0].value : null);

/** `(unit-add (unit-add (unit) a) b)` 这种左递归的链摊平成 `[a, b]`。 */
function glslFlatten(node, addHead, emptyHead) {
  const out = [];
  let cur = node;
  while (glslHead(cur) === addHead) {
    out.push(cur.items[2]);
    cur = cur.items[1];
  }
  if (glslHead(cur) !== emptyHead) {
    throw new OmniError(`glsl: ${addHead} 的链底该是 ${emptyHead}，是 ${glslHead(cur)}`);
  }
  out.reverse();
  return out;
}

const glslAtom = (n) => (n.kind === 'atom' || n.kind === 'string' ? n.value : null);

/* -------------------------------------------------------------- 内建函数 */

/**
 * 内建函数表。`kind` 说的是**形状**，不是一条条重载：
 *
 *   `gen1`  一个泛型参数（`float`/`vecN` 都行），回同一个类型：`sin`/`abs`/`floor`…
 *   `gen2`  两个参数，第二个可以是标量（`min(vec3, float)` 合法）：`min`/`max`/`pow`/`mod`/`step`
 *   `gen3`  三个参数，后两个（或后一个）可以是标量：`clamp`/`mix`/`smoothstep`
 *   `len`   一个泛型参数，回 `float`：`length`
 *   `dot2`  两个同型泛型参数，回 `float`：`dot`/`distance`
 *   `cross` 两个 `vec3`，回 `vec3`
 *
 * 「第二个可以是标量」这条不是我编的：GLSL 规范 8.3 里 `min`/`max`/`clamp`/`mix`/`smoothstep`
 * 都各有一组「后面几个是 float」的重载，而 `sin(x, y)` 那种不存在。
 *
 * `pow` 是从 `pretty.frag` 里量出来的（`col = pow(col, vec3(0.85))`）—— ADR 里第一版
 * 那份内建清单漏了它。
 */
const GLSL_BUILTINS = new Map([
  ['sin', 'gen1'], ['cos', 'gen1'], ['tan', 'gen1'],
  ['asin', 'gen1'], ['acos', 'gen1'], ['atan', 'gen12'],
  ['sinh', 'gen1'], ['cosh', 'gen1'], ['tanh', 'gen1'],
  ['asinh', 'gen1'], ['acosh', 'gen1'], ['atanh', 'gen1'],
  ['exp', 'gen1'], ['log', 'gen1'], ['exp2', 'gen1'], ['log2', 'gen1'],
  ['sqrt', 'gen1'], ['inversesqrt', 'gen1'],
  ['abs', 'gen1'], ['sign', 'gen1'], ['floor', 'gen1'], ['ceil', 'gen1'],
  ['trunc', 'gen1'], ['round', 'gen1'], ['roundEven', 'gen1'],
  ['fract', 'gen1'], ['normalize', 'gen1'], ['radians', 'gen1'], ['degrees', 'gen1'],
  ['pow', 'gen2'], ['mod', 'gen2'], ['min', 'gen2'], ['max', 'gen2'], ['step', 'gen2'],
  ['clamp', 'gen3'], ['mix', 'gen3'], ['smoothstep', 'gen3'],
  ['length', 'len'],
  ['dot', 'dot2'], ['distance', 'dot2'],
  ['cross', 'cross'],
  /* 几何那三条（规范 8.4）：形状与 `gen1`/`gen3` 不同 —— 都要求实参**同型**，
   * `refract` 的第三个是标量。 */
  ['reflect', 'geo2'], ['faceforward', 'geo3'], ['refract', 'refr'],
  /* `isnan`/`isinf`（规范 8.3）：一个泛型参数，回**同宽的 bool** —— `float -> bool`、
   * `vecN -> bvecN`。所以单开一格 `gen1b`，不能混进 `gen1`（那一格回的是原型）。
   * 从 `grapheq.glsl` 那 772 行里量出来的：`isnan` 7 次、`isinf` 5 次，是那份真实
   * 着色器最要紧的缺口。 */
  ['isnan', 'gen1b'], ['isinf', 'gen1b'],
  /* 导数那三条（规范 8.9，只有片元着色器有）。类型上与 `gen1` 一模一样
   * （`float -> float`、`vecN -> vecN`），所以借那一格；特别的是**语义**：
   * 它们要看邻居像素，所以在 `call` 那儿还要记一格 `mod.deriv`（两条腿据它换形状）。
   * `fwidth(p)` 是 `abs(dFdx(p)) + abs(dFdy(p))`，不是另一种导数 —— 两条腿都按这个式子展开。 */
  ['dFdx', 'gen1'], ['dFdy', 'gen1'], ['fwidth', 'gen1'],

]);

/** 导数那三条：只有片元着色器有，而且要看邻居像素（规范 8.9）。 */
const GLSL_DERIV = new Set(['dFdx', 'dFdy', 'fwidth']);

/**
 * 纹理取样（规范 8.7）。四个名字都收：`texture` 是 330 的写法，
 * `texture1D`/`texture2D` 是 120 的老写法 —— vispy 的 `colormaps/user.glsl` 用后者，
 * 而"照实收现有语料"是这一层的规矩（不收就得让用它的人改源码）。
 * 类型不走 `GLSL_BUILTINS` 那张表：第一个实参是**不透明**的采样器，那张表的泛型
 * 规则（"参数里最宽的那个"）在它身上说不通。
 */
const GLSL_TEX = new Set(['texture', 'texture1D', 'texture2D']);

/** `atan` 与 `step` 的第一个参数也可以是标量而第二个是向量吗 —— GLSL 里可以，这儿也收。 */
function glslGenType(name, tys, node, err) {
  const kind = GLSL_BUILTINS.get(name);
  const want = kind === 'gen1' || kind === 'gen1b' || kind === 'len' ? 1
    : kind === 'gen3' || kind === 'geo3' || kind === 'refr' ? 3 : 2;
  /* `atan` 是**重载**的（规范 8.1）：`atan(y_over_x)` 与 `atan(y, x)` 都合法，
   * 而 `grapheq.glsl` 两种都用。降级那一侧本来就分开处理（1 个走 `rmath "atan"`、
   * 2 个走 `rmath "atan2"`），是这张表把它钉成了 2 个 —— 那是这张表的错，不是别处。 */
  if (kind === 'gen12') {
    if (tys.length !== 1 && tys.length !== 2) {
      throw err(node, `${name} 要 1 个或 2 个实参，给了 ${tys.length}`);
    }
  } else if (tys.length !== want) {
    throw err(node, `${name} 要 ${want} 个实参，给了 ${tys.length}`);
  }
  /* 泛型那一格：参数里最宽的那个（标量算最窄）。所有非标量的必须同型。 */
  let wide = null;
  for (const t of tys) {
    if (t.k === 'float' || t.k === 'int') continue;
    if (t.k !== 'vec' || t.base !== 'float') {
      throw err(node, `${name} 的实参只能是 float 或 vecN，给了 ${glslTyText(t)}`);
    }
    if (wide === null) wide = t;
    else if (wide.n !== t.n) {
      throw err(node, `${name} 的几个向量实参宽度不一样（${glslTyText(wide)} 与 ${glslTyText(t)}）`);
    }
  }
  const gen = wide === null ? GLSL_FLOAT : wide;
  if (kind === 'len' || kind === 'dot2') {
    if (kind === 'dot2' && !glslSame(tys[0], tys[1])) {
      /* `dot` 的两个参数必须**同型** —— 标量与向量混不了。 */
      if (!(glslIsScalar(tys[0]) && glslIsScalar(tys[1]))) {
        throw err(node, `${name} 的两个实参要同型（${glslTyText(tys[0])} 与 ${glslTyText(tys[1])}）`);
      }
    }
    return GLSL_FLOAT;
  }
  if (kind === 'cross') {
    for (const t of tys) {
      if (!(t.k === 'vec' && t.n === 3 && t.base === 'float')) {
        throw err(node, `cross 的实参要是 vec3，给了 ${glslTyText(t)}`);
      }
    }
    return glslVec(3, 'float');
  }
  if (kind === 'geo2' || kind === 'geo3' || kind === 'refr') {
    /* 8.4：`reflect(I,N)`、`faceforward(N,I,Nref)`、`refract(I,N,eta)`。
     * 前两个的实参**全部同型**（float 或 vecN，都不铺开）；`refract` 的 `eta` 是标量。 */
    const many = kind === 'refr' ? tys.slice(0, 2) : tys;
    for (const t of many) {
      if (!glslSame(t, many[0])) {
        throw err(node, `${name} 的实参要同型（${glslTyText(many[0])} 与 ${glslTyText(t)}）`);
      }
    }
    if (kind === 'refr' && tys[2].k !== 'float' && tys[2].k !== 'int') {
      throw err(node, `refract 的 eta 要是标量，给了 ${glslTyText(tys[2])}`);
    }
    return many[0];
  }
  /* `gen1` 的那一个参数是标量时回标量；`gen2`/`gen3` 的第一个参数定形状。 */
  if (kind === 'gen1') return gen;
  /* `gen1b`：形状照旧，底类型换成 bool（`float -> bool`、`vecN -> bvecN`）。 */
  if (kind === 'gen1b') return gen.k === 'vec' ? glslVec(gen.n, 'bool') : GLSL_BOOL;
  const first = tys[0];
  if (first.k === 'vec') return first;
  return gen;
}

/**
 * 向量比较那一族（规范 8.6）与 `bvecN` 上的归约。它们与上面那张泛型表分开写，
 * 因为**结果类型换了一族**：比较出 `bvecN`、`all`/`any` 出 `bool`。
 *
 *   `lessThan(vecN, vecN)` -> `bvecN`（`ivecN` 也行；`equal`/`notEqual` 还收 `bvecN`）
 *   `all(bvecN)` / `any(bvecN)` -> `bool`
 *   `not(bvecN)` -> `bvecN`
 *
 * **为什么这一族现在做得了**：GLSL 这一层的向量是**摊成分量**的，一格一个方言标量，
 * 所以「逐格比较出一串 bool」不需要方言有掩码类型。方言的掩码（ADR-0019 待办 18）
 * 要的是 LLVM 腿上的原生 `<N x i1>`，那是**性能**，不是这一族的前提。
 */
const GLSL_VEC_CMP = new Map([
  ['lessThan', '<'], ['lessThanEqual', '<='],
  ['greaterThan', '>'], ['greaterThanEqual', '>='],
  ['equal', '=='], ['notEqual', '!='],
]);

const GLSL_VEC_RED = new Set(['all', 'any']);

/**
 * 位转换那两个（规范 8.4）。单开一张表的理由与矩阵那一族一样：泛型表只认 float 与 vecN，
 * 而 `intBitsToFloat` 的实参是 int/ivecN。
 *
 * `grapheq.glsl` 用它们拼 `nextUp`/`nextDown`（第 141–154 行，6 处）——「区间是真超集」
 * 这个性质的地基。宽度那一格与规范不同（规范是 32 位），理由在调用处的注释里。
 */
const GLSL_BITS = new Set(['floatBitsToInt', 'intBitsToFloat']);

/**
 * 矩阵那一族（规范 8.5）。也单开一张表：它们的实参与结果都是**矩阵**，
 * 而上面那张泛型表只认 float 与 vecN。
 *
 *   `matrixCompMult(m, m)` -> 同型（逐格乘，**不是**矩阵乘）
 *   `outerProduct(c, r)`   -> `c` 长 R、`r` 长 C，出 `matCxR`
 *   `transpose(matCxR)`    -> `matRxC`
 *   `determinant(matN)` / `inverse(matN)` -> 只对**方阵**
 */
const GLSL_MAT_FNS = new Set(['matrixCompMult', 'outerProduct', 'transpose',
  'determinant', 'inverse']);

/** 这一族的类型规则。回 `null` 表示「这个名字不属于这一族」。 */
function glslMatFnType(name, tys, node, err) {
  if (!GLSL_MAT_FNS.has(name)) return null;
  const want = name === 'matrixCompMult' || name === 'outerProduct' ? 2 : 1;
  if (tys.length !== want) throw err(node, `${name} 要 ${want} 个实参，给了 ${tys.length}`);
  if (name === 'outerProduct') {
    const [c, r] = tys;
    if (!(c.k === 'vec' && c.base === 'float') || !(r.k === 'vec' && r.base === 'float')) {
      throw err(node, `outerProduct 的实参要是 vecN（${glslTyText(c)} 与 ${glslTyText(r)}）`);
    }
    return glslMat(r.n, c.n);
  }
  for (const t of tys) {
    if (t.k !== 'mat') throw err(node, `${name} 的实参要是矩阵，给了 ${glslTyText(t)}`);
  }
  if (name === 'matrixCompMult') {
    if (!glslSame(tys[0], tys[1])) {
      throw err(node, `matrixCompMult 的两个矩阵要同型（${glslTyText(tys[0])} 与 ${glslTyText(tys[1])}）`);
    }
    return tys[0];
  }
  const m = tys[0];
  if (name === 'transpose') return glslMat(m.rows, m.cols);
  if (m.cols !== m.rows) throw err(node, `${name} 只对方阵，给了 ${glslTyText(m)}`);
  return name === 'determinant' ? GLSL_FLOAT : m;
}


/** 这一族的类型规则。回 `null` 表示「这个名字不属于这一族」。 */
function glslVecCmpType(name, tys, node, err) {
  const op = GLSL_VEC_CMP.get(name);
  if (op !== undefined) {
    if (tys.length !== 2) throw err(node, `${name} 要 2 个实参，给了 ${tys.length}`);
    const [a, b] = tys;
    if (a.k !== 'vec' || b.k !== 'vec' || a.n !== b.n || a.base !== b.base) {
      throw err(node, `${name} 的两个实参要是同型的向量（${glslTyText(a)} 与 ${glslTyText(b)}）`);
    }
    /* `<` 那四条只对数字向量；`equal`/`notEqual` 连 `bvecN` 一起收（规范 8.6）。 */
    if (a.base === 'bool' && op !== '==' && op !== '!=') {
      throw err(node, `${name} 不能作用在 bvec 上（只有 equal/notEqual 可以）`);
    }
    return glslVec(a.n, 'bool');
  }
  if (GLSL_VEC_RED.has(name)) {
    if (tys.length !== 1) throw err(node, `${name} 要 1 个实参，给了 ${tys.length}`);
    if (!(tys[0].k === 'vec' && tys[0].base === 'bool')) {
      throw err(node, `${name} 的实参要是 bvecN，给了 ${glslTyText(tys[0])}`);
    }
    return GLSL_BOOL;
  }
  if (name === 'not') {
    if (tys.length !== 1) throw err(node, `not 要 1 个实参，给了 ${tys.length}`);
    if (!(tys[0].k === 'vec' && tys[0].base === 'bool')) {
      throw err(node, `not 的实参要是 bvecN，给了 ${glslTyText(tys[0])}`
        + '（标量的逻辑非写 `!x`）');
    }
    return tys[0];
  }
  return null;
}

/* ---------------------------------------------------------- 内建变量 */

/**
 * 每一档着色器**自己**的内建变量。分档不是讲究：`gl_FragCoord` 在顶点里根本不存在，
 * 混着收下来的话「顶点里读 gl_FragCoord」这种错要到运行期才现形（而那时候只是数不对）。
 */
const GLSL_VERT_IN = new Map([['gl_VertexID', GLSL_INT]]);
const GLSL_VERT_OUT = new Map([['gl_Position', glslVec(4, 'float')]]);
const GLSL_FRAG_IN = new Map([['gl_FragCoord', glslVec(4, 'float')]]);
const GLSL_FRAG_OUT = new Map([['gl_FragDepth', GLSL_FLOAT]]);

/* ------------------------------------------------------------ 检查器 */

const GLSL_SWIZZLE_SETS = ['xyzw', 'rgba', 'stpq'];

/** 赋值那一族：语法头 -> 二元算符（`assign` 自己是纯赋值，值是 `=`）。 */
const GLSL_ASSIGN_OPS = {
  assign: '=',
  'add-assign': '+', 'sub-assign': '-', 'mul-assign': '*', 'div-assign': '/',
  'mod-assign': '%', 'band-assign': '&', 'bor-assign': '|', 'bxor-assign': '^',
  'shl-assign': '<<', 'shr-assign': '>>',
};


/* GLSL 330 的**全部**隐式转换（规范 4.1.10）：就这两行。表的形状与 jancy 那张
   （`JNC_CASTS`）一模一样，求解器是同一个（`frontend-engine/casts.js` 的 `castRow`）——
   这就是"加一门语言 = 加一张表"那句话的第一次兑现：GLSL 与 jancy 的差别在**表的内容**，
   不在两段各写一遍的 `if`。

   `cost` 这一列 GLSL 用不着（它的内建重载按精确匹配挑，不排偏序），所以不写 —— 表的列是
   **可选**的，一门语言只填它用得上的那几列。别的一律不转：悄悄转的话
   `float f = someVec3;` 这种错会变成"取第一格"。 */
const GLSL_CASTS = [
  { why: 'int -> float（规范 4.1.10）', when: (f, t) => t.k === 'float' && f.k === 'int', assign: true },
  {
    why: 'ivecN -> vecN（同一条，逐格）',
    when: (f, t) => t.k === 'vec' && t.base === 'float'
      && f.k === 'vec' && f.base === 'int' && f.n === t.n,
    assign: true,
  },
];

class GlslChecker {
  /**
   * @param stage `'vert'` 或 `'frag'` —— **由调用方给**，不猜。
   *   猜是能猜的（看有没有 `gl_Position`），但猜错的那一次会把「顶点里写了 gl_FragCoord」
   *   变成「这是一份片元着色器」，错误就此消失。
   */
  constructor(stage) {
    this.stage = stage;
    this.version = null;
    this.uniforms = new Map();
    this.ins = new Map();
    this.outs = new Map();
    this.consts = new Map();
    this.globals = new Map();   // 模块级变量（B16）：每个调用各一份，不是共享的
    this.funcs = new Map();
    /** 源码名 -> 所有重载（GLSL 规范 6.1）。挑哪一份由实参类型定，见 `pickOverload`。 */
    this.byName = new Map();
    this.locs = new Map();
    /* 结构体表（施工图 B13）：名字 -> `{k:'struct', name, fields}`。
     * 名字能进类型位是 `pp.js` 的 `glslTypeNames()` 把它重判成 `TYPENAME` 了。 */
    this.structs = new Map();
    this.scopes = [];
    this.curFunc = null;
    /* 这个模块里有没有 `discard`（规范 6.4）。两条腿都要它：快路据它开那一层 kill 掩码，
     * 参考腿据它开那一格模块级 `glsl_killed` —— 没有 discard 的着色器降出来的字节
     * 因此与从前**一字不差**（这一格是"不用就不付"）。 */
    this.discard = false;
    /* 这个模块里有没有用导数（`dFdx`/`dFdy`/`fwidth`，规范 8.9）。它比 `discard` 更"贵"：
     * 导数是**按 2×2 quad 定义的**，所以两条腿都要为它换形状（快路把 8 道排成 quad、
     * 参考腿多两个 quad 基准参数与一次"探邻居"的重跑）。没用到就一格都不改。 */
    this.deriv = false;
    /* 用了纹理取样没有（`texture` 一族）。两条腿现在还只到"类型这一层"，
     * 真取样是下一格 —— 所以降级那两侧见它就明着骂（见 lower.js / emit_llvm.js）。 */
    this.tex = false;
    this.builtinIn = stage === 'vert' ? GLSL_VERT_IN : GLSL_FRAG_IN;
    this.builtinOut = stage === 'vert' ? GLSL_VERT_OUT : GLSL_FRAG_OUT;
  }

  /** 语法树里的类型 -> 类型对象。走这一层是为了把结构体表带上。 */
  tyOf(node) {
    return glslTyOf(node, (n, m) => this.err(n, m), this.structs);
  }

  err(node, msg) {
    const at = node !== undefined && node !== null && node.span !== undefined
      ? `${node.span.file.path}:${node.span.line}: ` : '';
    return new OmniError(`${at}glsl: ${msg}`);
  }

  /** 名字表里已经有了就骂 —— 同一个名字两处声明，后面那处会悄悄遮住前面那处。 */
  claim(name, node) {
    if (this.uniforms.has(name) || this.ins.has(name) || this.outs.has(name)
      || this.consts.has(name)) {
      throw this.err(node, `'${name}' 声明过两次`);
    }
    if (this.builtinIn.has(name) || this.builtinOut.has(name)) {
      throw this.err(node, `'${name}' 是内建变量，不能自己声明`);
    }
  }

  push() { this.scopes.push(new Map()); }

  /**
   * `layout(location = N)` 记账。这一刀的驱动**自己排** uniform 与 varying 的次序
   * （见 `lower.js` 那一头），所以位置号目前只做一件事：**同一类里不许两个名字抢同一个号**。
   * 不做「按号排布局」是因为那要等 uniform block 那一片 —— 但号冲突是源码的错，
   * 现在就该拦，不然它会一直藏着。
   */
  claimLoc(kind, name, node, at) {
    const key = glslAtom(node.items[1]);
    if (key !== 'location') throw this.err(at, `layout 里这一刀只认 location，给的是 '${key}'`);
    const n = Number(glslAtom(node.items[2]));
    if (!Number.isInteger(n) || n < 0) throw this.err(at, `location 要是非负整数，给的是 ${n}`);
    const prev = this.locs.get(`${kind}:${n}`);
    if (prev !== undefined) {
      throw this.err(at, `${kind} 的 location ${n} 被 '${prev}' 与 '${name}' 抢了两次`);
    }
    this.locs.set(`${kind}:${n}`, name);
  }

  pop() { this.scopes.pop(); }

  declare(name, ty, node) {
    /* 采样器是不透明类型（规范 4.1.7）：这一刀只收它当 **uniform** —— 局部量与形参都拒。
     * 规范里形参是允许的（`vec4 f(sampler2D s)`），拒它是**这一刀的窄化**：
     * 现有语料（vispy 那 102 份、两份尺子）里一处都没有，而收了就得在两条腿上
     * 都能"把一个纹理句柄传进函数"。真遇上再放宽。 */
    if (ty.k === 'sampler') {
      throw this.err(node, `'${name}' 是 ${glslTyText(ty)}：采样器只能是 uniform`
        + '（局部量与形参这一刀不收）');
    }
    const top = this.scopes[this.scopes.length - 1];
    if (top.has(name)) throw this.err(node, `'${name}' 在同一层里声明过两次`);
    top.set(name, ty);
  }

  /**
   * 这门语言的**候选作用域序列**（ADR-0029 的 L3）。次序照 GLSL：块作用域一层层往里
   * （里面的先），外面依次是 const / global / uniform / in / out / 内建那几档。
   * 每一步自带 `get` —— 因为这几档的存法不一样（有的表里直接放类型，有的放 `{ty}`），
   * 归一这件事就写在这张表上，而不是七条 `if` 里。`label` 就是回给调用点的 `kind`。
   */
  * scopePath() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const m = this.scopes[i];
      yield { label: 'local', ns: m, get: (n) => (m.has(n) ? { ty: m.get(n) } : undefined) };
    }
    const bare = (label, m) => ({ label, ns: m, get: (n) => (m.has(n) ? { ty: m.get(n) } : undefined) });
    const wrapped = (label, m) => ({ label, ns: m, get: (n) => (m.has(n) ? { ty: m.get(n).ty } : undefined) });
    yield wrapped('const', this.consts);
    yield wrapped('global', this.globals);
    yield bare('uniform', this.uniforms);
    yield wrapped('in', this.ins);
    yield wrapped('out', this.outs);
    yield bare('builtin-in', this.builtinIn);
    yield bare('builtin-out', this.builtinOut);
  }

  /** 名字 -> `{ty, kind}`。找不到就骂 —— GLSL 没有隐式声明。 */
  lookup(name, node) {
    const hit = lookupEntry(name, { path: this.scopePath() });
    if (hit !== null) return { ty: hit.entry.ty, kind: hit.label };
    /* 另一档的内建变量：单独一句话，比「没见过这个名字」有用得多。 */
    const other = this.stage === 'vert' ? GLSL_FRAG_IN : GLSL_VERT_IN;
    const other2 = this.stage === 'vert' ? GLSL_FRAG_OUT : GLSL_VERT_OUT;
    if (other.has(name) || other2.has(name)) {
      throw this.err(node, `'${name}' 是${this.stage === 'vert' ? '片元' : '顶点'}着色器的内建变量，`
        + `这是一份${this.stage === 'vert' ? '顶点' : '片元'}着色器`);
    }
    throw this.err(node, `没见过的名字 '${name}'`);
  }

  /* ---------------------------------------------------------- 顶层 */

  unit(tree, lib) {
    for (const d of glslFlatten(tree, 'unit-add', 'unit')) this.decl(d);
    /* 库模式（`#include` 进来的那种函数库）不要求 main —— 见 `glslCheck` 的注释。 */
    if (lib === true) {
      const m0 = this.funcs.get('main');
      if (m0 !== undefined && (m0.ret.k !== 'void' || m0.params.length !== 0)) {
        throw this.err(null, 'main 得是 void main()');
      }
    } else {
      if (!this.funcs.has('main')) throw this.err(null, '没有 main');
      const m = this.funcs.get('main');
      if (m.ret.k !== 'void' || m.params.length !== 0) {
        throw this.err(null, 'main 得是 void main()');
      }
    }
    return {
      stage: this.stage,
      version: this.version,
      /* 结构体表带出去：降级与快路那两侧都要按成员**摊平**（施工图 B13）。 */
      structs: [...this.structs.values()],
      uniforms: [...this.uniforms].map(([name, ty]) => ({ name, ty })),
      ins: [...this.ins].map(([name, v]) => ({ name, ty: v.ty, interp: v.interp })),
      outs: [...this.outs].map(([name, v]) => ({ name, ty: v.ty, interp: v.interp })),
      consts: [...this.consts].map(([name, v]) => ({ name, ty: v.ty, init: v.init })),
      funcs: [...this.funcs.values()],
      globals: [...this.globals.values()],
      /* 这个模块里有没有 `discard`（见 `stmt` 里那一格）。两条腿据它决定要不要开那一层
       * kill —— 没有的话降出来的东西与从前一字不差。 */
      discard: this.discard,
      /* 用了导数没有（`dFdx`/`dFdy`/`fwidth`）。两条腿据它换形状 —— 见 `deriv` 那一格。 */
      deriv: this.deriv,
      /* 用了纹理取样没有（`texture` 一族）。降级两侧现在见它就明着骂 —— 真取样是下一格。 */
      tex: this.tex,
    };
  }

  decl(node) {
    const h = glslHead(node);
    if (h === 'version') {
      const line = glslAtom(node.items[1]);
      const m = /^#\s*version\s+(\d+)\s*(\w+)?/.exec(line);
      if (m === null) throw this.err(node, `读不懂的版本行 '${line}'`);
      const v = Number(m[1]);
      const profile = m[2] === undefined ? '' : m[2];
      /* 认不出的版本**要骂**：悄悄按 330 编，等于把「这份源码用了 400 的东西」藏起来。
       *
       * 收两档：
       *   `330` / `330 core` —— 桌面版，尺子那两份 python 脚本用的
       *   `300 es`           —— GLSL ES 3.0，`grapheq.glsl` 用的
       *
       * 这两档在**这个子集里**没有需要分开处理的地方：ES 300 与 330 core 的语法、
       * 内建面、`in`/`out` 接口都对得上（ES 没有 `gl_FragColor`，而我们本来就只走 `out`）。
       * 唯一真差别是**精度限定符在 ES 上是有语义的**（`mediump` 在移动 GPU 上可能是 fp16），
       * 而这一层一律按一种精度算 —— 那与 330 那一档的做法一致（`precision` 收下、不改计算），
       * 也与我们的参照实现（f64）和快路（f32）本来就不同宽度这件事同一个立场。
       * 「按 fp16 算」要的是另一条腿，不在这一刀里。
       *
       * `300` 不带 `es` 要骂：桌面 GLSL 没有 300 这个版本号，收下它等于替源码猜。 */
      if (v === 300 && profile !== 'es') {
        throw this.err(node, `#version 300 只存在于 GLSL ES（要写 '#version 300 es'），给的 profile 是 ${JSON.stringify(profile)}`);
      }
      if (v !== 330 && v !== 300) throw this.err(node, `只收 #version 330 与 #version 300 es，给的是 ${v}`);
      if (v === 330 && profile !== '' && profile !== 'core') {
        throw this.err(node, `#version 330 这一档只收 core profile，给的是 ${JSON.stringify(profile)}`);
      }
      this.version = v;
      this.profile = profile;
      return;
    }
    if (h === 'struct-decl') {
      /* 平结构体（施工图 B13）。按 `grapheq.glsl` 那两个的形状收：
       *   struct IV   { vec2 v; vec2 g; vec2 f; };
       *   struct Segs { vec2 s0; vec2 s1; int n; };
       * **嵌套不在这儿拒不了** —— 语法里 `field` 的类型可以是 `TYPENAME`，所以那条限制
       * 是语义的，就在这儿骂（语法保持上下文无关，别把语义塞进产生式）。 */
      const name = glslAtom(node.items[1]);
      if (this.structs.has(name)) throw this.err(node, `结构体 '${name}' 定义了两次`);
      const items = glslFlatten(node.items[2], 'fields-add', 'fields');
      const fields = [];
      const seen = new Set();
      for (const f of items) {
        const fname = glslAtom(f.items[2]);
        if (seen.has(fname)) throw this.err(f, `结构体 '${name}' 里有两个成员叫 '${fname}'`);
        seen.add(fname);
        const fty = this.tyOf(f.items[1]);
        if (fty.k === 'void') throw this.err(f, `结构体成员 '${fname}' 不能是 void`);
        if (fty.k === 'struct') {
          throw this.err(f, `这一片只收**平**结构体：成员 '${fname}' 又是一个结构体 `
            + `('${fty.name}')。嵌套要连着「成员是数组」一起做，那是另一片`);
        }
        fields.push({ name: fname, ty: fty });
      }
      if (fields.length === 0) throw this.err(node, `结构体 '${name}' 一个成员都没有`);
      this.structs.set(name, glslStruct(name, fields));
      return;
    }
    if (h === 'uniform' || h === 'uniform-at') {
      const at = h === 'uniform-at';
      const name = glslAtom(node.items[at ? 3 : 2]);
      this.claim(name, node);
      this.uniforms.set(name, this.tyOf(node.items[at ? 2 : 1]));
      if (at) this.claimLoc('uniform', name, node.items[1], node);
      return;
    }
    if (h === 'in-var' || h === 'out-var' || h === 'in-at' || h === 'out-at') {
      const at = h === 'in-at' || h === 'out-at';
      const isIn = h === 'in-var' || h === 'in-at';
      const name = glslAtom(node.items[3]);
      this.claim(name, node);
      const ty = this.tyOf(node.items[2]);
      /* 插值方式：`flat`/`smooth`/`noperspective`，没写就是 `smooth`（GLSL 的默认）。
       * llvmpipe 那边这一格是 `enum lp_interp`，是编 shader 变体时定死的常量。
       * `centroid`/`sample` 在规范里是**取样位置**而不是插值方式 —— 我们只有一个取样点
       * （像素中心），所以它们与 `smooth` 落到同一格，这是刻意的，不是漏掉。 */
      const q = glslHead(node.items[1]);
      const interp = q === 'interp-flat' ? 'flat'
        : q === 'interp-linear' ? 'linear' : 'smooth';
      (isIn ? this.ins : this.outs).set(name, { ty, interp });
      if (at) this.claimLoc(isIn ? 'in' : 'out', name, node.items[1], node);
      return;
    }
    if (h === 'precision' || h === 'invariant') {
      /* 两条都**收下不改变任何计算**：这一层的 `float` 只有一种精度（方言的 real），
       * `invariant` 说的是「两次编译要出同样的值」——我们本来就是同一份降级。
       * 收下来的理由是别让一整份着色器因为这一行而解析失败。 */
      return;
    }
    if (h === 'const-decl') {
      const name = glslAtom(node.items[2]);
      this.claim(name, node);
      const ty = this.tyOf(node.items[1]);
      this.push();
      const init = this.coerce(this.expr(node.items[3]), ty, node);
      this.pop();
      this.consts.set(name, { ty, init });
      return;
    }
    if (h === 'func' || h === 'func-proto') {
      const src = glslAtom(node.items[2]);
      const ret = this.tyOf(node.items[1]);
      const params = glslFlatten(node.items[3], 'params-add', 'params').map((p) => ({
        dir: glslHead(p.items[1]) === 'dir-out' ? 'out'
          : glslHead(p.items[1]) === 'dir-inout' ? 'inout' : 'in',
        ty: this.tyOf(p.items[2]),
        name: glslAtom(p.items[3]),
      }));
      /* **函数重载**（GLSL 规范 6.1，mesa/llvmpipe 全支持）：同一个名字可以有多份，
       * 按形参类型区分。所以「一个名字一个函数」这个假设在这儿散开成两张表：
       *   `byName`  源码名 -> 所有重载（调用点按实参类型挑）
       *   `funcs`   **发出去的名字** -> 函数（降级与快路那两侧照旧按名字唯一）
       * 发出去的名字：第一份保留源码名，后面的加 `__形参签名`；名字撞上内建的话
       * 一律加签名（`vispy` 的 `math/functions.glsl` 就重载了 `atan`）。
       * 这样单份的那些着色器降出来一个字节都不变。 */
      const sig = glslSigKey(params);
      const list = this.byName.get(src) ?? [];
      const dup = list.find((g) => g.sig === sig);
      const isBuiltin = GLSL_BUILTINS.has(src) || GLSL_VEC_CMP.has(src) || GLSL_VEC_RED.has(src)
        || GLSL_MAT_FNS.has(src) || GLSL_BITS.has(src) || GLSL_TEX.has(src) || src === 'not';
      if (h === 'func-proto') {
        if (dup === undefined) {
          const f = { name: (list.length === 0 && !isBuiltin) ? src : `${src}__${sig}`,
            src, sig, ret, params, body: null };
          list.push(f);
          this.byName.set(src, list);
          this.funcs.set(f.name, f);
        }
        return;
      }
      if (dup !== undefined && dup.body !== null) {
        throw this.err(node, `'${src}(${glslSigText(params)})' 定义了两次`);
      }
      const f = dup !== undefined ? dup
        : { name: (list.length === 0 && !isBuiltin) ? src : `${src}__${sig}`,
          src, sig, ret, params, body: null };
      if (dup === undefined) {
        list.push(f);
        this.byName.set(src, list);
      } else {
        /* 原型与定义的返回类型/形参方向必须一致 —— 那是规范要求，也是「原型在前」
         * 这件事唯一能出错的地方。 */
        f.ret = ret;
        f.params = params;
      }
      /* 先登记再查体：GLSL 里递归是**非法**的，但登记在前才能让「递归」这件事在
       * 名字解析这一层就被看见（现在的表现是「函数体里调到自己」——留到降级那一侧拦，
       * 因为那儿才知道调用图）。 */
      this.funcs.set(f.name, f);
      this.curFunc = f;
      this.push();
      for (const p of params) this.declare(p.name, p.ty, node);
      f.body = this.block(node.items[4]);
      this.pop();
    this.curFunc = null;
      return;
    }
    if (h === 'global' || h === 'global-init') {
      /* 模块级变量（B16）。GLSL 里它是**每个调用各一份**（不是共享的全局）——
       * 一个片元的 `u_x` 与另一个片元的 `u_x` 无关。所以在快路上它就是 `main` 那一层的
       * 一个落点，函数内联之后自然看得见（ADR-0019 决策十第 5 步）。
       *
       * 带初值那一档也收：规范要求全局的初值是**常量表达式**，所以「什么时候算」不是
       * 一个选择 —— 每个调用开头算一次，与不带初值那一档取零是同一个位置。 */
      const name = glslAtom(node.items[2]);
      this.claim(name, node);
      const ty = this.tyOf(node.items[1]);
      if (ty.k === 'void') throw this.err(node, `'${name}' 不能是 void`);
      let init = null;
      if (h === 'global-init') {
        this.push();
        init = this.coerce(this.expr(node.items[3]), ty, node);
        this.pop();
      }
      this.globals.set(name, { name, ty, init });
      return;
    }

    throw this.err(node, `认不出的顶层声明 ${h}`);
  }

  /* ---------------------------------------------------------- 语句 */

  block(node) {
    this.push();
    const out = glslFlatten(node.items[1], 'stmts-add', 'stmts').map((s) => this.stmt(s));
    this.pop();
    return { k: 'block', body: out };
  }

  stmt(node) {
    const h = glslHead(node);
    if (h === 'empty') return { k: 'empty' };
    if (h === 'block') return this.block(node);
    if (h === 'expr-stmt') return { k: 'expr', e: this.expr(node.items[1]) };
    if (h === 'local' || h === 'local-init' || h === 'local-const') {
      const ty = this.tyOf(node.items[1]);
      const name = glslAtom(node.items[2]);
      const init = node.items.length > 3 ? this.coerce(this.expr(node.items[3]), ty, node) : null;
      if (h === 'local-const' && init === null) throw this.err(node, `const '${name}' 没有初值`);
      this.declare(name, ty, node);
      return { k: 'decl', name, ty, init, isConst: h === 'local-const' };
    }
    /* 数组（B14）。语法只给最窄那一档（局部、常量大小、不带初值），所以这儿要骂的
     * 只剩三条 —— 加上那条**上限**，它是决策：变量下标落成 select 链，格数一大就线性
     * 劣化，所以宁可当场骂 NYI，也不悄悄生出上千路 select。 */
    if (h === 'local-arr') {
      /* 局部量**不能叫 `of`**（自编译子集的关键字）——同上。 */
      const elem = this.tyOf(node.items[1]);
      const name = glslAtom(node.items[2]);
      const n = Number(glslAtom(node.items[3]));
      if (elem.k === 'void') throw this.err(node, `'${name}' 不能是 void 的数组`);
      if (elem.k === 'array') throw this.err(node, `'${name}'：元素是数组这一档不收`);
      if (!Number.isInteger(n) || n < 1) throw this.err(node, `数组 '${name}' 的大小要是正整数`);
      const ty = glslArray(elem, n);
      const cells = glslCount(ty);
      if (cells > GLSL_ARR_MAX_CELLS) {
        throw this.err(node, `数组 '${name}' 摊平后 ${cells} 格，超过 ${GLSL_ARR_MAX_CELLS}`
          + ' —— 变量下标落成 select 链，格数一大就线性劣化，这一档先不收');
      }
      this.declare(name, ty, node);
      return { k: 'decl', name, ty, init: null, isConst: false };
    }
    /* 一条声明里多个变量（B15）：`float lo = m[0].x, hi = m[cnt - 1].y;`、`float t1, t2, e;`。
     * 摊成一串 `decl` —— 次序要紧：前一个的名字对后一个**是可见的**（GLSL 与 C 同规矩），
     * 所以一边 `declare` 一边往下走，不是先收齐名字再算初值。
     * `local-multi0` 是第一个变量不带初值那一档（`(one 名字)` 与 `(one 名字 初值)`
     * 两种形状按 `items.length` 分）。 */
    if (h === 'local-multi' || h === 'local-multi0') {
      const withInit = h === 'local-multi';
      const ty = this.tyOf(node.items[1]);
      const first = glslAtom(node.items[2]);
      const list = [];
      const init0 = withInit ? this.coerce(this.expr(node.items[3]), ty, node) : null;
      this.declare(first, ty, node);
      list.push({ k: 'decl', name: first, ty, init: init0, isConst: false });
      for (const m of glslFlatten(node.items[withInit ? 4 : 3], 'more-add', 'more')) {
        const nm = glslAtom(m.items[1]);
        const init = m.items.length > 2 ? this.coerce(this.expr(m.items[2]), ty, m) : null;
        this.declare(nm, ty, m);
        list.push({ k: 'decl', name: nm, ty, init, isConst: false });
      }
      return { k: 'multi', list };
    }
    if (h === 'ret') {
      const f = this.curFunc;
      if (f.ret.k === 'void') throw this.err(node, `${f.name} 是 void，return 不能带值`);
      return { k: 'ret', e: this.coerce(this.expr(node.items[1]), f.ret, node) };
    }
    if (h === 'ret-void') {
      if (this.curFunc.ret.k !== 'void') {
        throw this.err(node, `${this.curFunc.name} 要回一个 ${glslTyText(this.curFunc.ret)}`);
      }
      return { k: 'ret', e: null };
    }
    if (h === 'brk') return { k: 'break' };
    if (h === 'cont') return { k: 'continue' };
    if (h === 'discard') {
      /* `discard`（规范 6.4）：**只有片元着色器有**，顶点着色器里写它是错的。
       * 这一片只认它、记一格「这个模块里有 discard」——语义在两条腿上各落一次，
       * 而两边落的是**同一个模型**（llvmpipe 的 kill 掩码）：
       *   - 快路（emit_llvm.js）：多一层掩码（`killPtr`），与 break/cont/ret 同一个机制；
       *     写回颜色时把它当覆盖度递给驱动，被杀的道不写回。
       *   - 参考腿（lower.js）：一个像素一趟、标量代码，所以只要一格模块级 bool
       *     `glsl_killed` —— 出图那一头见它是真就不印这个像素。
       * 两条腿"接着算下去"的行为不同（快路把被杀的道掩掉、参考腿照算），但那不可观测：
       * 被杀的像素根本不写回。 */
      if (this.stage !== 'frag') throw this.err(node, 'discard 只能写在片元着色器里（规范 6.4）');
      this.discard = true;
      return { k: 'discard' };
    }
    if (h === 'if' || h === 'if-else') {
      const c = this.cond(node.items[1], node);
      return {
        k: 'if',
        c,
        then: this.stmt(node.items[2]),
        else: h === 'if-else' ? this.stmt(node.items[3]) : null,
      };
    }
    if (h === 'while') {
      return { k: 'while', c: this.cond(node.items[1], node), body: this.stmt(node.items[2]) };
    }
    if (h === 'do-while') {
      /* 体先走一趟才判条件 —— 与 `while` 的差别只在这一格，但语义上是「至少一趟」。 */
      const body = this.stmt(node.items[1]);
      return { k: 'dowhile', c: this.cond(node.items[2], node), body };
    }
    if (h === 'switch') return this.switchStmt(node);
    if (h === 'for') {
      /* `for` 自己一层作用域：`for (int i = ...)` 里的 `i` 出了循环就没了。 */
      this.push();
      const init = this.stmt(node.items[1]);
      const c = glslHead(node.items[2]) === 'none' ? null : this.cond(node.items[2], node);
      const step = glslHead(node.items[3]) === 'none' ? null : this.expr(node.items[3]);
      const body = this.stmt(node.items[4]);
      this.pop();
      return { k: 'for', init, c, step, body };
    }
    throw this.err(node, `认不出的语句 ${h}`);
  }

  /** 条件那一格必须是 `bool` —— GLSL 不像 C，整数不能当条件。 */
  cond(node, at) {
    const e = this.expr(node);
    if (e.ty.k !== 'bool') {
      throw this.err(at, `条件要是 bool，这儿是 ${glslTyText(e.ty)}`
        + '（GLSL 不像 C，整数不能当条件）');
    }
    return e;
  }

  /**
   * `switch`。规范 6.4：选择子是 `int`（或 `uint`），标签是**常量表达式**，
   * 穿落照 C 的规矩，`default` 可以摆在中间。
   *
   * 这儿把体拆成**按次序的组**：连着的标签算同一组，后面跟到下一个标签之前的语句就是
   * 那一组的体。分组之后穿落与 `default` 的位置都由降级那一侧一次算清（那儿有个
   * 「匹配过了」的标志位）—— 检查这一侧只管三条：选择子类型、标签重不重、
   * 第一个标签之前有没有语句。
   */
  switchStmt(node) {
    const sel = this.expr(node.items[1]);
    if (sel.ty.k !== 'int') {
      throw this.err(node, `switch 的选择子要是 int，这儿是 ${glslTyText(sel.ty)}`);
    }
    const items = glslFlatten(node.items[2], 'sw-items-add', 'sw-items');
    const groups = [];
    const seen = new Set();
    let hasDefault = false;
    this.push();
    for (const it of items) {
      const ih = glslHead(it);
      if (ih === 'sw-case' || ih === 'sw-default') {
        const label = ih === 'sw-default' ? null : this.caseLabel(it.items[1], it);
        if (label === null) {
          if (hasDefault) throw this.err(it, 'switch 里 default 出现了两次');
          hasDefault = true;
        } else {
          if (seen.has(label)) throw this.err(it, `switch 里 case ${label} 出现了两次`);
          seen.add(label);
        }
        /* 上一组已经开始收语句了，就另起一组；否则并进去（连着的标签共用一个体）。 */
        const last = groups[groups.length - 1];
        if (last === undefined || last.body.length > 0) groups.push({ labels: [label], body: [] });
        else last.labels.push(label);
        continue;
      }
      if (groups.length === 0) {
        throw this.err(it, 'switch 的第一个 case/default 之前不能有语句（规范 6.4）');
      }
      groups[groups.length - 1].body.push(this.stmt(it));
    }
    this.pop();
    return { k: 'switch', sel, groups, hasDefault };
  }

  /** case 的标签：常量整数。`-1` 那种一元负号在这儿折掉，别的常量表达式暂不收。 */
  caseLabel(node, at) {
    const e = this.expr(node);
    if (e.k === 'lit' && e.ty.k === 'int') return e.v;
    if (e.k === 'neg' && e.a.k === 'lit' && e.a.ty.k === 'int') return -e.a.v;
    throw this.err(at, 'case 的标签要是整数常量（这一刀只折字面量与它的负号）');
  }

  /* ---------------------------------------------------------- 表达式 */

  /**
   * `from` 的类型能不能当 `want` 用 —— 读 `GLSL_CASTS` 那张表（ADR-0029 的 L4）。
   * 完全一样那一格不进表：它**不发** `convert`，原样回去。
   */
  coerce(e, want, at) {
    if (glslSame(e.ty, want)) return e;
    const r = castRow(GLSL_CASTS, e.ty, want, this);
    if (r !== null && r.assign) return { k: 'convert', ty: want, of: e };
    throw this.err(at, `要一个 ${glslTyText(want)}，给的是 ${glslTyText(e.ty)}`);
  }

  expr(node) {
    const h = glslHead(node);
    if (h === 'int-lit') return { k: 'lit', ty: GLSL_INT, v: Number(glslAtom(node.items[1])) };
    if (h === 'float-lit') {
      const raw = glslAtom(node.items[1]);
      return { k: 'lit', ty: GLSL_FLOAT, v: Number(raw.replace(/[fF]$/, '')) };
    }
    if (h === 'bool-lit') {
      return { k: 'lit', ty: GLSL_BOOL, v: glslAtom(node.items[1]) === '1' };
    }
    if (h === 'name') {
      const name = glslAtom(node.items[1]);
      const r = this.lookup(name, node);
      return { k: 'ref', ty: r.ty, name, kind: r.kind };
    }
    if (h === 'paren') return this.expr(node.items[1]);
    if (h === 'member') return this.swizzle(node);
    if (h === 'construct') return this.construct(node);
    if (h === 'call') return this.call(node);
    if (h === 'neg' || h === 'lnot' || h === 'bnot') return this.unary(node, h);
    if (h === 'comma') {
      /* 逗号：左边算了就丢，整个表达式的类型是**右边**那个（规范 5.9）。
       * 左边照样要查 —— `f(), 1` 里的 `f()` 写错了得当场报，不能因为「反正要丢」就不看。 */
      const a = this.expr(node.items[1]);
      const b = this.expr(node.items[2]);
      return { k: 'comma', ty: b.ty, a, b };
    }

    if (h === 'pre-inc' || h === 'pre-dec' || h === 'post-inc' || h === 'post-dec') {
      const a = this.lvalue(node.items[1], node);
      if (a.ty.k !== 'int' && a.ty.k !== 'float') {
        throw this.err(node, `++/-- 只对 int 与 float，这儿是 ${glslTyText(a.ty)}`);
      }
      return { k: 'incdec', ty: a.ty, op: h, a };
    }
    if (h === 'cond') {
      const c = this.cond(node.items[1], node);
      const a = this.expr(node.items[2]);
      const b = this.expr(node.items[3]);
      /* 两支的类型必须能对齐。`? :` 在 GLSL 里是**表达式**，两支不同型没有意义。 */
      if (glslSame(a.ty, b.ty)) return { k: 'sel', ty: a.ty, c, a, b };
      if (a.ty.k === 'int' && b.ty.k === 'float') {
        return { k: 'sel', ty: GLSL_FLOAT, c, a: this.coerce(a, GLSL_FLOAT, node), b };
      }
      if (a.ty.k === 'float' && b.ty.k === 'int') {
        return { k: 'sel', ty: GLSL_FLOAT, c, a, b: this.coerce(b, GLSL_FLOAT, node) };
      }
      throw this.err(node, `? : 两支的类型对不齐（${glslTyText(a.ty)} 与 ${glslTyText(b.ty)}）`);
    }
    if (GLSL_ASSIGN_OPS[h] !== undefined) {
      const lhs = this.lvalue(node.items[1], node);
      if (h === 'assign') {
        return { k: 'assign', ty: lhs.ty, op: '=', lhs, rhs: this.coerce(this.expr(node.items[2]), lhs.ty, node) };
      }
      const op = GLSL_ASSIGN_OPS[h];
      /* `col *= rot(a)` 这种（`vec2 *= mat2`）合法，所以复合赋值先按二元算类型，
       * 再要求算出来的类型**就是**左边那个 —— 与 GLSL 规范 5.8 同一句话。 */
      const b = this.binTy(op, lhs.ty, this.expr(node.items[2]).ty, node);
      if (!glslSame(b, lhs.ty)) {
        throw this.err(node, `${op}= 的结果是 ${glslTyText(b)}，装不进 ${glslTyText(lhs.ty)}`);
      }
      return { k: 'assign', ty: lhs.ty, op, lhs, rhs: this.expr(node.items[2]) };
    }
    const BIN = {
      add: '+', sub: '-', mul: '*', div: '/', mod: '%',
      band: '&', bor: '|', bxor: '^', shl: '<<', shr: '>>',
      lt: '<', gt: '>', le: '<=', ge: '>=', eq: '==', ne: '!=',
      land: '&&', lor: '||', lxor: '^^',
    };
    if (BIN[h] !== undefined) return this.binary(node, BIN[h]);
    if (h === 'index') return this.index(node);
    throw this.err(node, `认不出的表达式 ${h}`);
  }

  /**
   * `a[i]`（数组取一格）、`m[K]`（矩阵取**列**）、`v[K]`（向量取一格）。
   *
   * **数组**的下标可以是任意 `int` 表达式 —— `grapheq.glsl` 的 `m[cnt - 1]`、`s[j + 1]`
   * 是数据算出来的，挡住就等于挡住那份真实着色器。落法见降级那一侧（常量下标 = 切片、
   * 变量下标 = select 链）。
   *
   * **向量与矩阵**的下标仍然必须是整数字面量：它们摊平之后是「哪几格」的静态问题，
   * 动态下标要么走数组那条路，要么在某个下标上悄悄取错一格。
   *
   * 矩阵是**列优先**（规范 5.6）：`m[0]` 是第 0 列，也就是 `mat2(a,b,c,d)` 里的 `(a,b)`。
   * 记成行就是转置，而转置在图上看不出「错」，只看得出「转过来了」。
   */
  index(node) {
    /* 局部叫 `subj` 而不是 `of`：`of` 在自举子集的词法里是关键字
     * （`docs/js-bootstrap-subset.md`），当变量名会让 `tests/js-roundtrip` 红。
     * 节点上的**属性**仍然叫 `of` —— 属性名不受那条限制。 */
    const subj = this.expr(node.items[1]);
    const at = this.expr(node.items[2]);
    if (subj.ty.k === 'array') {
      if (at.ty.k !== 'int') {
        throw this.err(node, `数组下标要是 int，这儿是 ${glslTyText(at.ty)}`);
      }
      /* 常量下标当场查越界；变量下标查不了，GLSL 规范里那也是未定义行为，
       * 我们在降级那侧夹到 [0, n-1]（不越界读别人的格子）。 */
      if (at.k === 'lit' && (at.v < 0 || at.v >= subj.ty.n)) {
        throw this.err(node, `${glslTyText(subj.ty)} 只有 ${subj.ty.n} 格，取不到第 ${at.v} 格`);
      }
      return { k: 'aindex', ty: subj.ty.of, of: subj, at };
    }
    if (at.k !== 'lit' || at.ty.k !== 'int') {
      throw this.err(node, '下标必须是整数字面量（动态下标只有数组收，见 B14）');
    }
    const k = at.v;
    if (subj.ty.k === 'mat') {
      if (k < 0 || k >= subj.ty.cols) {
        throw this.err(node, `${glslTyText(subj.ty)} 只有 ${subj.ty.cols} 列，取不到第 ${k} 列`);
      }
      /* 取出来的是一**列**，长度是**行数** —— `mat2x3[0]` 是 vec3，不是 vec2。 */
      return { k: 'matcol', ty: glslVec(subj.ty.rows, 'float'), of: subj, col: k };
    }
    if (subj.ty.k === 'vec') {
      if (k < 0 || k >= subj.ty.n) {
        throw this.err(node, `${glslTyText(subj.ty)} 只有 ${subj.ty.n} 格，取不到第 ${k} 格`);
      }
      /* 向量那一侧就是 swizzle 的一格 —— 降级那边不必多认一种节点。 */
      return { k: 'swizzle', ty: glslElem(subj.ty), of: subj, idx: [k] };
    }
    throw this.err(node, `${glslTyText(subj.ty)} 不能取下标`);
  }

  /** 能不能赋值。`uniform`/`in`/内建的输入都不能写 —— 那是 GLSL 的规矩，不是我们的选择。 */
  lvalue(node, at) {
    const e = this.expr(node);
    if (e.k === 'ref') {
      if (e.kind === 'uniform') throw this.err(at, `uniform '${e.name}' 不能赋值`);
      if (e.kind === 'in') throw this.err(at, `in '${e.name}' 不能赋值`);
      if (e.kind === 'const') throw this.err(at, `const '${e.name}' 不能赋值`);
      if (e.kind === 'builtin-in') throw this.err(at, `内建输入 '${e.name}' 不能赋值`);
      return e;
    }
    if (e.k === 'swizzle') {
      /* `v.xy = ...` 合法，但同一格不能出现两次（`v.xx = ...` 是错的）。 */
      const seen = new Set(e.idx);
      if (seen.size !== e.idx.length) throw this.err(at, 'swizzle 里同一格出现两次，不能当左值');
      return e;
    }
    /* `s[i] = ...` 与 `m[cnt - 1].y = ...`（后者是 swizzle 套在这上面，走上面那一支）。
     * 数组本身是局部变量，所以不必再查 uniform/in 那些不可写的来源。 */
    if (e.k === 'aindex') return e;
    throw this.err(at, '左边这个东西不能赋值');
  }

  /**
   * swizzle 与成员。这一刀只有 swizzle（没有结构体），所以 `.` 后面那串必须是
   * 同一套字母（`xyzw` / `rgba` / `stpq` 不能混用 —— 规范 5.5 的原话）。
   */
  swizzle(node) {
    /* 局部量**不能叫 `of`** —— 那是自编译子集词法里的关键字（`for … of`）。
     * 出来的节点属性还叫 `of`（受限的只有绑定名）。 */
    const subj = this.expr(node.items[1]);
    const s = glslAtom(node.items[2]);
    /* 结构体的成员访问走这一条（施工图 B13）：`.v` 是名字，不是 swizzle 那串字母。
     * `idx` 是**摊平之后的起始格号** —— 降级那一侧按它切片，与 `matcol` 同一个套路。 */
    if (subj.ty.k === 'struct') {
      let at = 0;
      for (const f of subj.ty.fields) {
        if (f.name === s) return { k: 'field', ty: f.ty, of: subj, at, name: s };
        at += glslCount(f.ty);
      }
      throw this.err(node, `${subj.ty.name} 没有成员 '${s}'（有 `
        + `${subj.ty.fields.map((f) => f.name).join('、')}）`);
    }
    if (subj.ty.k !== 'vec') {
      throw this.err(node, `'.${s}' 只能取向量的分量，这儿是 ${glslTyText(subj.ty)}`);
    }
    if (s.length < 1 || s.length > 4) throw this.err(node, `'.${s}' 长度只能是 1..4`);
    const set = GLSL_SWIZZLE_SETS.find((z) => [...s].every((c) => z.includes(c)));
    if (set === undefined) {
      throw this.err(node, `'.${s}' 里的字母不是同一套（xyzw / rgba / stpq 不能混用）`);
    }
    const idx = [...s].map((c) => set.indexOf(c));
    const over = idx.find((i) => i >= subj.ty.n);
    if (over !== undefined) {
      throw this.err(node, `${glslTyText(subj.ty)} 没有第 ${over + 1} 格（'.${s}'）`);
    }
    const ty = idx.length === 1 ? glslElem(subj.ty) : glslVec(idx.length, subj.ty.base);
    return { k: 'swizzle', ty, of: subj, idx };
  }

  /**
   * 构造。三条规则，都是规范 5.4 里的：
   *
   *   1. 一个标量实参 -> **铺开**（`vec3(0.02)`、`mat2(1.0)` 是单位阵的对角）
   *   2. 标量目标一个实参 -> 转换（`float(i)`、`int(f)`）
   *   3. 其余：把实参的格数**摊平**数，必须**正好**够（多了也是错 —— 规范里多了是错，
   *      少了更是错；只有「一个标量」那条例外）
   */
  construct(node) {
    const ty = this.tyOf(node.items[1]);
    const args = glslFlatten(node.items[2], 'args-add', 'args').map((a) => this.expr(a));
    if (ty.k === 'void') throw this.err(node, 'void 不能构造');
    /* 结构体的构造（规范 5.4.3）：**一个实参对一个成员**，按次序，类型要能当那个成员用。
     * 不铺开、不摊平 —— 那两条是向量/矩阵的规则，结构体没有。 */
    if (ty.k === 'struct') {
      if (args.length !== ty.fields.length) {
        throw this.err(node, `${ty.name}(...) 要 ${ty.fields.length} 个实参`
          + `（一个成员一个：${ty.fields.map((f) => f.name).join('、')}），给了 ${args.length}`);
      }
      const vals = args.map((a, ax) => this.coerce(a, ty.fields[ax].ty, node));
      return { k: 'construct', ty, args: vals };
    }
    if (glslIsScalar(ty)) {
      if (args.length !== 1) throw this.err(node, `${glslTyText(ty)}(...) 要正好一个实参`);
      const a = args[0];
      if (!glslIsScalar(a.ty)) {
        throw this.err(node, `${glslTyText(ty)}(...) 的实参要是标量，给了 ${glslTyText(a.ty)}`);
      }
      return { k: 'cast', ty, of: a };
    }
    if (args.length === 1 && glslIsScalar(args[0].ty)) {
      return { k: 'splat', ty, of: args[0] };
    }
    let have = 0;
    for (const a of args) {
      if (a.ty.k === 'mat') throw this.err(node, '拿矩阵当构造实参这一刀不收');
      have += glslCount(a.ty);
    }
    const want = glslCount(ty);
    if (have !== want) {
      throw this.err(node, `${glslTyText(ty)}(...) 要 ${want} 格，实参一共 ${have} 格`);
    }
    /* 每一格的**元素类型**也得对上：`vec3(0, 2, 4)` 三个都是 int 字面量，在 GLSL 里
     * 合法（规范 5.4.2：构造器对每个实参各做一次标量转换）。转换在这儿落成显式的
     * `cast`/`convert`，降级那一侧就不必再猜「这个 0 是 int 还是 float」。 */
    const el = glslElem(ty);
    const fixed = args.map((a) => {
      if (glslIsScalar(a.ty)) return glslSame(a.ty, el) ? a : { k: 'cast', ty: el, of: a };
      if (a.ty.k === 'vec' && a.ty.base !== el.k) {
        return { k: 'cast', ty: glslVec(a.ty.n, el.k), of: a };
      }
      return a;
    });
    return { k: 'construct', ty, args: fixed };
  }

  call(node) {
    const name = glslAtom(node.items[1]);
    const args = glslFlatten(node.items[2], 'args-add', 'args').map((a) => this.expr(a));
    /* **用户函数先挑**（GLSL 规范 6.1 的重载解析）：用户可以重载内建
     * （vispy 的 `math/functions.glsl` 就重载了 `atan`），所以按实参类型能挑出一份
     * 就走那一份；挑不出来才落到下面那几族内建。 */
    const user = this.pickOverload(name, args, node);
    if (user !== null) return user;
    const vty = glslVecCmpType(name, args.map((a) => a.ty), node, (n, m) => this.err(n, m));
    if (vty !== null) {
      /* 这一族**不提升实参**：`lessThan(ivec2, ivec2)` 是整数比较，
       * 悄悄提成 float 会把 `-1 < 0` 这种在极端值上算错。 */
      return { k: 'builtin', ty: vty, name, args };
    }
    const mty = glslMatFnType(name, args.map((a) => a.ty), node, (n, m) => this.err(n, m));
    if (mty !== null) return { k: 'builtin', ty: mty, name, args };
    /* 位转换那两个（规范 8.4）。**不走 `glslGenType`** —— 那一族只收 `float`/`vecN`，
     * 而 `intBitsToFloat` 的实参是 `int`/`ivecN`；而且它们是逐格的，宽度原样传过去。
     *
     * **宽度这一格与规范不一样，是故意的**：规范说这两个是 32 位的，因为它假定 `float`
     * 是 f32。参照腿上我们的 `real` 是 f64，所以这两个在那儿是 **64 位**的
     * （方言的 `realbits`/`bitsreal`）。那不是抄错 —— GraphEq 的两张参考图正好对着
     * 两种宽度：`_cpu.png` 是 f64 引擎出的，`_glsl.png` 是 f32 着色器出的（ADR-0019）。
     * 快路那一层是 f32，落成一条 `bitcast`，那边才是规范的 32 位语义。 */
    if (GLSL_BITS.has(name)) {
      if (args.length !== 1) throw this.err(node, `${name} 要 1 个实参，给了 ${args.length}`);
      const at = args[0].ty;
      const from = name === 'floatBitsToInt' ? 'float' : 'int';
      const isScalar = at.k === from;
      const isVec = at.k === 'vec' && at.base === from;
      if (!isScalar && !isVec) {
        const want = from === 'float' ? 'float 或 vecN' : 'int 或 ivecN';
        throw this.err(node, `${name} 的实参要是 ${want}，给了 ${glslTyText(at)}`);
      }
      const to = from === 'float' ? 'int' : 'float';
      const ty = isScalar ? (to === 'int' ? GLSL_INT : GLSL_FLOAT) : glslVec(at.n, to);
      return { k: 'bits', ty, name, args };
    }
    if (GLSL_TEX.has(name)) {
      /* 纹理取样（规范 8.7）。收四个名字：`texture`（330 的写法）与
       * `texture1D`/`texture2D`（120 的老写法，vispy 的 colormaps/user.glsl 用后者）。
       * 类型这一层的规矩很短：第一个实参必须是**对得上维数的采样器**、第二个是
       * `float`（1D）或 `vec2`（2D），回 `vec4`。
       * 采样器只有 uniform 与形参两种来处，所以这儿不必查"它是不是常量"。
       * **顶点里也收**：`texture()` 在顶点着色器里是合法的（没有隐式导数，按 LOD 0 取）——
       * 与 `dFdx` 那一族不同，那三条才是片元专属的。 */
      if (args.length !== 2) throw this.err(node, `${name} 要 2 个实参，给了 ${args.length}`);
      const st = args[0].ty;
      if (st.k !== 'sampler') {
        throw this.err(node, `${name} 的第一个实参要是采样器，给了 ${glslTyText(st)}`);
      }
      const wantDim = name === 'texture' ? st.dim : (name === 'texture1D' ? 1 : 2);
      if (st.dim !== wantDim) {
        throw this.err(node, `${name} 要 sampler${wantDim}D，给了 ${glslTyText(st)}`);
      }
      const ct = args[1].ty;
      const okCoord = st.dim === 1 ? (ct.k === 'float' || ct.k === 'int')
        : (ct.k === 'vec' && ct.n === 2 && ct.base === 'float');
      if (!okCoord) {
        throw this.err(node, `${name} 的坐标要是 ${st.dim === 1 ? 'float' : 'vec2'}，`
          + `给了 ${glslTyText(ct)}`);
      }
      this.tex = true;
      const coord = st.dim === 1 ? this.coerce(args[1], GLSL_FLOAT, node) : args[1];
      return { k: 'tex', ty: glslVec(4, 'float'), name, args: [args[0], coord] };
    }
    if (GLSL_BUILTINS.has(name)) {
      /* 导数那三条只有片元有（规范 8.9），而且要记一格「这个模块用了导数」——
       * 两条腿据它换形状（快路把 8 道排成 quad、参考腿多两个 quad 基准参数）。 */
      if (GLSL_DERIV.has(name)) {
        if (this.stage !== 'frag') {
          throw this.err(node, `${name} 只能写在片元着色器里（规范 8.9：导数要看邻居像素）`);
        }
        this.deriv = true;
      }
      const ty = glslGenType(name, args.map((a) => a.ty), node, (n, m) => this.err(n, m));
      /* 内建里 `int` 实参一律先提成 `float`（`sin(1)` 在 GLSL 里合法）。 */
      const fixed = args.map((a) => (a.ty.k === 'int' ? this.coerce(a, GLSL_FLOAT, node) : a));
      return { k: 'builtin', ty, name, args: fixed };
    }
    throw this.err(node, `没见过的函数 '${name}'`);
  }

  /**
   * 重载解析（GLSL 规范 6.1）。回 null 表示「这个名字不是用户函数」——
   * 那时调用点继续往内建那几族找。
   *
   * 挑的次序与规范一致：**先按形参个数**过一遍，再要「逐个同型」的那一份，
   * 最后才要「每一格都能隐式转过去」的那一份。剩下多份就是歧义，明着骂 ——
   * 悄悄挑一份是这一格最坏的选择（两条腿会挑到不同的那一份）。
   */
  pickOverload(name, args, node) {
    const list = this.byName.get(name);
    if (list === undefined) return null;
    const arity = list.filter((f) => f.params.length === args.length);
    if (arity.length === 0) {
      const ns = [...new Set(list.map((f) => f.params.length))].sort().join('/');
      throw this.err(node, `${name} 的形参个数是 ${ns}，给了 ${args.length}`);
    }
    if (arity.length === 1) return this.applyCall(arity[0], name, args, node);
    const exact = arity.filter((f) => f.params.every((p, i) => glslSame(p.ty, args[i].ty)));
    if (exact.length === 1) return this.applyCall(exact[0], name, args, node);
    const conv = arity.filter((f) => f.params.every((p, i) => p.dir === 'in'
      && glslCanCoerce(args[i].ty, p.ty)));
    if (conv.length === 1) return this.applyCall(conv[0], name, args, node);
    const given = args.map((a) => glslTyText(a.ty)).join(', ');
    const cands = arity.map((f) => `${name}(${glslSigText(f.params)})`).join('、');
    if (conv.length === 0) {
      throw this.err(node, `${name}(${given}) 对不上任何一份重载：${cands}`);
    }
    throw this.err(node, `${name}(${given}) 有多份重载都能对上（歧义）：${cands}`);
  }

  /** 挑定一份重载之后的实参检查。发出去的名字是 `f.name`（重载过的带签名后缀）。 */
  applyCall(f, src, args, node) {
    const fixed = args.map((a, i) => {
      const p = f.params[i];
      if (p.dir === 'in') return this.coerce(a, p.ty, node);
      /* `out`/`inout` 的实参：**必须同型**（要写回去，隐式转换没法反着来），
       * 而且必须是能写的左值 —— `f(1.0)` 那种「写回哪儿去」的问题得当场拦。 */
      if (!glslSame(a.ty, p.ty)) {
        throw this.err(node, `${src} 的第 ${i + 1} 个实参是 ${p.dir}，要正好是 `
          + `${glslTyText(p.ty)}，给的是 ${glslTyText(a.ty)}`);
      }
      if (a.k === 'ref') {
        if (a.kind === 'uniform' || a.kind === 'in' || a.kind === 'const'
          || a.kind === 'builtin-in') {
          throw this.err(node, `${src} 的第 ${i + 1} 个实参是 ${p.dir}，`
            + `但 '${a.name}' 是 ${a.kind}，写不进去`);
        }
        return a;
      }
      if (a.k === 'swizzle') {
        const seen = new Set(a.idx);
        if (seen.size !== a.idx.length) {
          throw this.err(node, `${src} 的第 ${i + 1} 个实参里 swizzle 同一格出现两次，写不进去`);
        }
        return a;
      }
      throw this.err(node, `${src} 的第 ${i + 1} 个实参是 ${p.dir}，要给一个能写的左值`);
    });
    return { k: 'call', ty: f.ret, name: f.name, args: fixed };
  }

  unary(node, h) {
    const a = this.expr(node.items[1]);
    if (h === 'lnot') {
      if (a.ty.k !== 'bool') throw this.err(node, `! 要一个 bool，这儿是 ${glslTyText(a.ty)}`);
      return { k: 'not', ty: GLSL_BOOL, a };
    }
    if (h === 'bnot') {
      /* `~` 只对整数（规范 5.9）。`ivecN` 逐格取反也合法。 */
      if (!glslIsIntish(a.ty)) {
        throw this.err(node, `~ 只对 int 或 ivecN，这儿是 ${glslTyText(a.ty)}`);
      }
      return { k: 'bnot', ty: a.ty, a };
    }
    if (a.ty.k === 'bool' || (a.ty.k === 'vec' && a.ty.base === 'bool')) {
      throw this.err(node, '负号不能作用在 bool 上');
    }
    return { k: 'neg', ty: a.ty, a };
  }

  /**
   * 二元运算的类型。这一段是这一份里最要紧的规则，逐条对着规范 5.9：
   *
   *   - 同型 -> 同型
   *   - 向量 op 标量、标量 op 向量 -> 向量（标量铺开）
   *   - `matN * vecN` -> `vecN`、`vecN * matN` -> `vecN`、`matN * matN` -> `matN`、
   *     `matN * float` -> `matN`
   *   - `%` **只对整数**（GLSL 里 float 取模要用 `mod()`）
   *   - 比较（`< > <= >=`）**只对标量**，回 `bool`
   *   - `== !=` 同型即可，回 `bool`
   *   - `&& ||` 只对 `bool`
   */
  binTy(op, a, b, node) {
    if (op === '&&' || op === '||' || op === '^^') {
      if (a.k !== 'bool' || b.k !== 'bool') {
        throw this.err(node, `${op} 两边要是 bool（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return GLSL_BOOL;
    }
    if (op === '&' || op === '|' || op === '^') {
      /* 位运算只对整数（规范 5.9）。两边同型，或者一边是标量铺开。 */
      if (!glslIsIntish(a) || !glslIsIntish(b)) {
        throw this.err(node, `${op} 只对 int 或 ivecN（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      if (a.k === 'vec' && b.k === 'vec' && a.n !== b.n) {
        throw this.err(node, `${op} 两边的宽度不一样（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return a.k === 'vec' ? a : b;
    }
    if (op === '<<' || op === '>>') {
      /* 移位的**结果类型由左边定**（规范 5.9）：右边只说移几位。
       * 左边是标量时右边也必须是标量 —— 不然「一个数移出一个向量」没有意思。 */
      if (!glslIsIntish(a) || !glslIsIntish(b)) {
        throw this.err(node, `${op} 只对 int 或 ivecN（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      if (a.k === 'int' && b.k === 'vec') {
        throw this.err(node, `${op} 左边是标量时右边也要是标量（右边是 ${glslTyText(b)}）`);
      }
      if (a.k === 'vec' && b.k === 'vec' && a.n !== b.n) {
        throw this.err(node, `${op} 两边的宽度不一样（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return a;
    }
    if (op === '==' || op === '!=') {
      if (!glslSame(a, b) && !(glslIsScalar(a) && glslIsScalar(b))) {
        throw this.err(node, `${op} 两边要同型（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return GLSL_BOOL;
    }
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      if (!glslIsScalar(a) || !glslIsScalar(b) || a.k === 'bool' || b.k === 'bool') {
        throw this.err(node, `${op} 只比标量（${glslTyText(a)} 与 ${glslTyText(b)}）`
          + '；向量要逐格比得用 lessThan 那一族（这一刀没有）');
      }
      /* 回的是 **bool** —— 不是两边提升出来的那个类型。这一格第一版写错过：
       * 写成 `int` 的话 `for (int i = 0; i < 20; i++)` 的条件就不是 bool，
       * 而条件那道检查会把它骂成「整数不能当条件」，错得离题。 */
      return GLSL_BOOL;
    }
    if (op === '%') {
      if (a.k !== 'int' || b.k !== 'int') {
        throw this.err(node, `% 只对 int（float 取模要用 mod()）`);
      }
      return GLSL_INT;
    }
    /* 算术。矩阵那几格只有 `*` 有意义。尺寸规矩照规范 5.10：
     *
     *   `matAxB * matCxD` 要 A == D，出 `matCxB`（左边的列数 = 右边的行数）
     *   `matCxR * vecC`   出 `vecR`；`vecR * matCxR` 出 `vecC`
     *   `matCxR * float`  出同型
     */
    if (a.k === 'mat' || b.k === 'mat') {
      if (op !== '*') throw this.err(node, `矩阵只支持 *（给的是 ${op}）`);
      if (a.k === 'mat' && b.k === 'mat') {
        if (a.cols !== b.rows) {
          throw this.err(node, `${glslTyText(a)} * ${glslTyText(b)} 尺寸不对`
            + `（左边 ${a.cols} 列要等于右边 ${b.rows} 行）`);
        }
        return glslMat(b.cols, a.rows);
      }
      const m = a.k === 'mat' ? a : b;
      const v = a.k === 'mat' ? b : a;
      if (v.k === 'float' || v.k === 'int') return m;
      if (v.k === 'vec' && v.base === 'float') {
        /* `m * v` 要 v 的长度 = 列数，出行数那么长；`v * m` 反过来。 */
        if (a.k === 'mat' && v.n === m.cols) return glslVec(m.rows, 'float');
        if (b.k === 'mat' && v.n === m.rows) return glslVec(m.cols, 'float');
      }
      throw this.err(node, `${glslTyText(a)} * ${glslTyText(b)} 尺寸不对`);
    }
    if (glslSame(a, b)) {
      if (a.k === 'bool' || (a.k === 'vec' && a.base === 'bool')) {
        throw this.err(node, `${op} 不能作用在 bool 上`);
      }
      return a;
    }
    if (glslIsScalar(a) && glslIsScalar(b)) return a.k === 'float' || b.k === 'float' ? GLSL_FLOAT : GLSL_INT;
    const vec = a.k === 'vec' ? a : b.k === 'vec' ? b : null;
    const other = a.k === 'vec' ? b : a;
    if (vec !== null && glslIsScalar(other) && other.k !== 'bool') {
      if (vec.base === 'bool') throw this.err(node, `${op} 不能作用在 bvec 上`);
      /* `ivec2 * float` -> `vec2`（整数向量被提成浮点向量）。 */
      if (vec.base === 'int' && other.k === 'float') return glslVec(vec.n, 'float');
      return vec;
    }
    if (a.k === 'vec' && b.k === 'vec' && a.n !== b.n) {
      throw this.err(node, `${op} 两边的向量宽度不一样（${glslTyText(a)} 与 ${glslTyText(b)}）`);
    }
    throw this.err(node, `${op} 收不下 ${glslTyText(a)} 与 ${glslTyText(b)}`);
  }

  binary(node, op) {
    const a = this.expr(node.items[1]);
    const b = this.expr(node.items[2]);
    const ty = this.binTy(op, a.ty, b.ty, node);
    return { k: 'bin', ty, op, a, b };
  }
}

/**
 * 一棵 GLSL 语法树 -> 带类型的模块。
 *
 * @param tree `glrParse` 出来的那棵
 * @param stage `'vert'` 或 `'frag'`——**由调用方给**，见 `GlslChecker` 的构造器
 * @param {{lib?: boolean}} [opts] `lib: true` 是**库模式**：不要求有 `main`。
 *   为什么要有这一档：量 vispy 那 140 份时，24 份卡在「没有 main」——而它们本来就是
 *   **函数库**（`#include` 进来用的 `math/functions.glsl` 那种）。「整份着色器」与
 *   「一份库」是两件事，检查器该分得开；分不开的时候这个语料上一句话都说不出来。
 *   库模式下**别的检查一条不少**（类型、名字、返回值都照查）。
 */
export function glslCheck(tree, stage, opts) {
  if (stage !== 'vert' && stage !== 'frag') {
    throw new OmniError(`glsl: stage 要是 'vert' 或 'frag'，给的是 '${stage}'`);
  }
  const lib = opts !== undefined && opts !== null && opts.lib === true;
  return new GlslChecker(stage).unit(tree, lib);
}
