// ext/r/adapter.js —— **R 的树 → 标准 IR**（ADR-0044 §1.2）
//
// 语法那一半照 R 自己的 `gram.y` 复刻（见 `ext/r/r.grammar` 文件头）。这一半是**映射**：
// 那棵 CST 上的节点 → 标准 IR，语义降级交给 `src/core/lower/` 那一份公共降级器。
//
// ## R 这门语言要 adapter 自己消化的五件事
//
//   1. **函数是值**。`f <- function(n) …` 在树上是一格赋值，不是声明。所以顶层扫一遍：
//      右边是 `(fn …)` 的赋值提升成 `{kind:'fn'}`，别的落进 `main`。
//   2. **最后一句就是返回值**（没有 `return` 也要返）。`return(x)` 在 R 里是**一次调用**，
//      不是语句 —— 两条都在这儿摆平（`tailOf`）。尾位上的 `if` 要往两支里钻，
//      不能囫囵包成一格 `ternary`：`if (n == 0) return(1)` 那种只有一支带值。
//   3. **没有声明**。`acc <- 0` 既是赋值也是"第一次出现"（与 awk 同一格），所以扫一遍
//      被赋值的名字，在段顶上补一串 `let`。
//   4. **类型**。方言那一层不推导只检查，所以"这个名字装的是什么"必须在这儿答完。
//      R 的数其实只有 double，这儿按**字面量的写法**分：没有小数点没有指数的是 `int`
//      （`5`、`1:n`、`42L`），带小数点或指数的是 `real`。判据是那几份例子的输出
//      （`cat(15)` 要印 `15` 而不是 `15.0`），与 awk 那一格同一个取舍。
//   5. **下标从 1 起**。`x[i]` → `aget(x, i-1)`，字面量当场折掉。`x[["k"]]` 是字典
//      （R 的 `list` 带名字用就是关联表），`x[i]` 是数组 —— 靠上面第 4 条推出来的类型分。
//
// ## 明说的不足（**不猜**）
//
//   1. **不做向量化**。R 里 `c(1,2) + 1` 是逐元素加、`if (c(TRUE,FALSE))` 是取第一格
//      加一句警告 —— 这一批一律当标量算。这不是"以后补一格函数"的事，是整套值模型
//      （长度回收、`NA` 的传播、属性）的事，得单独一版。
//   2. **不做懒求值**（promise / `missing()` / `substitute()`）、**不做属性**
//      （`names` / `dim` / `class`）、**不做 S3 / S4 / R5 分派**、**不做环境**
//      （`<<-` 当普通赋值）、**不做 `...`**。
//   3. `NA` / `NaN` / `Inf` 认得出记号但落不下来 —— 方言里没有"缺失"这一格。
//   4. 内建只认下面 `BUILTINS` 那一张表，表外的名字当用户函数调（调不到就是链接期的错）。

import { isList, tag, kids, leaf } from '../../src/core/lower/cst.js';
import { RMATH_LIB, rmathSig } from './rt/ffi.js';

/* ─── R 的数值运行时：**R 自己的 C 代码** ────────────────────────────────────
 *
 * `round(0.5)` 在 R 里是 `0`（到偶），`round(2.675, 2)` 是 `2.67`（二进制里 2.675 比它看
 * 起来小一点）。这些不是"我们算错了"能修的东西 —— 它们**就是** `r-source/src/nmath/fround.c`
 * 那段代码的行为。所以这一族一律转发过去：`ext/r/build.js` 把 `src/nmath` 的 121 份 `.c`
 * 编成 `libomniRmath`，签名由 `rt/ffi.js` 从**同一次构建生成的** `Rmath.h` 读出来（不手抄）。
 *
 * 这张表只说三件事。R 的可选实参在 C 那侧是必填的（`dnorm(x)` → `dnorm4(x, 0, 1, 0)`：
 * 均值、标准差、要不要取对数），补的值照 R 的文档。
 *
 *   sym   —— `Rmath.h` 里的名字（**不一定与 R 的函数同名**：`dnorm` 在头里是 `dnorm4`）
 *   fill  —— 实参表；`null` 是"这一格由 R 那边的位置实参填"，别的是缺省值。长度 = C 的元数 */
const RMATH = new Map([
  /* 取整与精度（`fround.c` / `fprec.c` / `ftrunc.c` / `fsign.c`）—— 整件事的起点 */
  ['round', { sym: 'fround', fill: [null, 0] }],
  ['signif', { sym: 'fprec', fill: [null, 6] }],
  ['trunc', { sym: 'ftrunc', fill: [null] }],
  ['sign', { sym: 'sign', fill: [null] }],
  /* 两格取大小。R 的 `max`/`min` 收任意多格（那要向量），所以这儿只登记 `pmax`/`pmin`
     的两格形式 —— 名字不一样就不会与"以后做了向量"的那一版撞。 */
  ['pmax', { sym: 'fmax2', fill: [null, null] }],
  ['pmin', { sym: 'fmin2', fill: [null, null] }],
  /* Gamma 那一族（`gamma.c` / `lgamma.c` / `polygamma.c` / `beta.c` / `choose.c`） */
  ['gamma', { sym: 'gammafn', fill: [null] }],
  ['lgamma', { sym: 'lgammafn', fill: [null] }],
  ['digamma', { sym: 'digamma', fill: [null] }],
  ['trigamma', { sym: 'trigamma', fill: [null] }],
  ['beta', { sym: 'beta', fill: [null, null] }],
  ['lbeta', { sym: 'lbeta', fill: [null, null] }],
  ['choose', { sym: 'choose', fill: [null, null] }],
  ['lchoose', { sym: 'lchoose', fill: [null, null] }],
  ['log1p', { sym: 'log1p', fill: [null] }],
  ['expm1', { sym: 'expm1', fill: [null] }],
  /* 分布那一族。`lower.tail = TRUE` → 1、`log = FALSE` → 0，照 R 的默认值补。
     **随机数那一族（`r*`）刻意不在这张表里**：它们要 `set.seed` 那套状态，而 R 的发生器在
     解释器里，standalone 这一份的流不一样 —— 接上去是"看着像对、每个数都不一样"。 */
  ['dnorm', { sym: 'dnorm4', fill: [null, 0, 1, 0] }],
  ['pnorm', { sym: 'pnorm5', fill: [null, 0, 1, 1, 0] }],
  ['qnorm', { sym: 'qnorm5', fill: [null, 0, 1, 1, 0] }],
  ['dbinom', { sym: 'dbinom', fill: [null, null, null, 0] }],
  ['pbinom', { sym: 'pbinom', fill: [null, null, null, 1, 0] }],
  ['dpois', { sym: 'dpois', fill: [null, null, 0] }],
  ['ppois', { sym: 'ppois', fill: [null, null, 1, 0] }],
  ['dgamma', { sym: 'dgamma', fill: [null, null, 1, 0] }],
  ['pgamma', { sym: 'pgamma', fill: [null, null, 1, 1, 0] }],
  ['dbeta', { sym: 'dbeta', fill: [null, null, null, 0] }],
  ['pbeta', { sym: 'pbeta', fill: [null, null, null, 1, 0] }],
  ['dt', { sym: 'dt', fill: [null, null, 0] }],
  ['pt', { sym: 'pt', fill: [null, null, 1, 0] }],
  ['dchisq', { sym: 'dchisq', fill: [null, null, 0] }],
  ['pchisq', { sym: 'pchisq', fill: [null, null, 1, 0] }],
  ['besselI', { sym: 'bessel_i', fill: [null, null, 1], take: 2 }],
  ['besselJ', { sym: 'bessel_j', fill: [null, null] }],
  ['besselK', { sym: 'bessel_k', fill: [null, null, 1], take: 2 }],
  ['besselY', { sym: 'bessel_y', fill: [null, null] }],
]);

/** 这一趟真用到的 nmath 符号 —— 模块里只发**用到的**那几条 `(cabi …)`。 */
const cabiUsed = new Set();

/**
 * `is.na` 一族。回的是 C 的 `int`，所以外面要包一格 `!= 0` 才是布尔。
 * `is.finite` 用的是 **R 自己的** `R_finite`（nmath 里有），别的三格是我们那份
 * `rt/omni_rna.c`（R 那边它们在解释器里）。
 */
const PRED = new Map([
  /* 这两格**没有**载荷问题（`Inf` 就是 `Inf`），所以照旧按值过。 */
  ['is.infinite', 'omni_r_is_infinite'],
  ['is.finite', 'R_finite'],
]);

const NUM_STR = 'r_num_str';

/**
 * **生成出来的辅助函数之间的依赖，明写成一张表。**
 *
 * 原来这儿是"往 `needFn` 里加，然后多扫几轮直到不再长" —— 那个写法出过一次真错：
 * `r_cat_vec` 在被生成的那一刻才点 `r_num_str`，而 `r_num_str` 被生成的那一刻才点
 * `r_is_na` / `r_is_nan`，于是最后那两格的 `(cabi …)` 没发出来，`NA` 被当成普通 NaN 印成
 * `NaN`。症状是**静默答错**，而根因藏在"第几轮扫到"里 —— 那种错不该靠多扫一轮去躲。
 *
 * 现在的规矩：用到哪一格就 `useFn` 它，**发之前先按这张表闭包一遍**。
 * 于是"生成的次序"不再是一件要想的事。
 */
const FN_DEPS = new Map([
  ['r_na', []],
  ['r_is_na', []],
  ['r_is_nan', []],
  ['r_num_str', ['r_is_na', 'r_is_nan']],
  ['r_cat_vec', ['r_num_str']],
  ['r_cat_lgl', ['r_is_na']],
  ['r_sum', []],
  ['r_mean', ['r_sum']],
  ['r_max', []],
  ['r_min', []],
  ['r_vec_pick', []],
  ['r_vec_mask', ['r_is_na', 'r_na']],
  ['r_rev', []],
  ['r_seq_along', []],
  ['r_which', ['r_is_na']],
]);

/* ─── 类型（标准 IR 的类型描述，§1.2） ─────────────────────────────────── */

const INT = { kind: 'int' };
const REAL = { kind: 'real' };
const STR = { kind: 'string' };
const BOOL = { kind: 'bool' };
const arrOf = (value) => ({ kind: 'arr', elem: value });   /* 只给字典的值类型用了 */
/** R 的 `list` 带名字用就是关联表 —— 键一律是串。 */
const dictOf = (value) => ({ kind: 'map', key: STR, value });

/**
 * R 的名字规整成方言收得下的形状：`.` 是 R 里合法的名字字符（`is.null` / `max.2`），
 * 方言那侧不收。反引号那一支已经由词法层剥干净（`(string SYMBOL "`")`），
 * 所以这儿只管字符替换。与 `ext/chez/adapter` 把 `-` / `?` / `!` 换成 `_` 是同一手。
 */
const mangle = (s) => String(s).replace(/[.]/g, '_');

/** `(sym x)` / `(str x)` / 裸记号都要认（形参表、命名实参那几处是后者）。 */
const nameOf = (x) => {
  const t = tag(x);
  if (t === 'sym' || t === 'str') return leaf(kids(x)[0]);
  return leaf(x);
};

/* ─── 字面量 ───────────────────────────────────────────────────────────── */

/** R 的关键字里 `TRUE` / `FALSE` / `NA` / `Inf` / `NaN` 都是 NUM_CONST（gram.y:2176）。 */
const CONSTS = new Map([
  ['TRUE', { kind: 'bool', value: true }],
  ['FALSE', { kind: 'bool', value: false }],
]);

/**
 * R 的三格"非数"。它们**不是字面量** —— `NA` 的位模式（NaN + 低 32 位 1954）写不进
 * `(real …)`，方言里也没有位重解释那一格。所以由 `rt/omni_rna.c` 那三个函数答，
 * 与 `round` 走 `fround` 是同一条路：拿不到的东西不自己编一个近似的。
 *
 * `NA_integer_` / `NA_character_` / `NA_complex_` **没接**：整数与串的 NA 在 R 那边是
 * 另外两种表示（`INT_MIN` 与一格特殊的 CHARSXP），而我们还没有"带缺失的整数/串"这一层。
 */
const NONNUM = new Map([
  ['NaN', 'omni_r_nan'],
  ['Inf', 'omni_r_posinf'],
]);

/**
 * **R 的 double 按指针过 FFI，不按值。**
 *
 * `NA_real_` 是"带 1954 载荷的 NaN"（*R Internals* §1.3），而那个载荷**按值过 N-API 会被
 * V8 规范化掉**（`napi_create_double` 那一步）。量出来的三格：
 *   * C 里直接调：`is_na=1 is_nan=0`（对）
 *   * 按值过一趟 `(ccall omni_r_na)`：`is_na=1 is_nan=1`（NA 变成了普通 NaN）
 *   * **按指针**（`(pnew (ptr real) 1)` + `(ccall … (var p))`）：`1 0`，而且 `pload` 出来
 *     的那格 JS 数再 `pstore` 回另一段内存，还是 `1 0` —— 载荷分毫不动
 *
 * 所以 `NA` 这一族走 `(ptr real)`：值留在线性内存里，两边按位读写，绕开装箱那一步。
 * 三格封在下面那三个**生成出来的函数**里（`r_na` / `r_is_na` / `r_is_nan`），
 * 调用点照旧写 `NA` / `is.na(x)` —— 指针那套不往上冒。
 */
const PTR_REAL = { kind: 'ptr', inner: REAL };

/**
 * **R 的数值向量 = 一段线性内存，长度存在 0 号槽里。**
 *
 * 为什么不是 `(arr real)`：那一格后端落成 JS 数组，而**只装 double 的 JS 数组会把 NaN
 * 的载荷抹掉**（V8 的 PACKED_DOUBLE_ELEMENTS 必须规范化 NaN —— 那种数组里"洞"本身就是
 * 一个特殊 NaN）。于是 `c(1, NA, 3)` 会印成 `1 NaN 3`。量出来的五种存法与判据在
 * `tests/r/oracle.js` 第三节。
 *
 * 为什么长度存在槽里、而不是另开一个结构体：向量要能当**一个值**进出函数（形参、返回值、
 * 存进字典），而结构体那条路要多一份 `(struct …)` 声明与 `fld` / `fldset`。
 * 长度写在头上是 R 自己的做法（SEXP 的 header 里就有 length），而且一格 double 装得下
 * 2^53 以内的长度 —— 比任何真向量都长。
 *
 *   槽 0      长度（按 double 存）
 *   槽 1..n   元素
 */
const RVEC = PTR_REAL;
/**
 * **逻辑向量**跟数值向量同一个存法（`(ptr real)`，1.0 / 0.0 / NA），只在这一侧的类型上
 * 多带一个记号 —— 差别只在**印法**：R 印 `TRUE` / `FALSE` / `NA`，不印 `1` / `0`。
 * `typeToSx` 只看 `kind` 与 `inner`，所以这个记号不会漏到 `.sx` 里去。
 */
const RLGL = { kind: 'ptr', inner: REAL, lgl: true };
const isVecTy = (t) => t !== undefined && t !== null && t.kind === 'ptr';
const isLglTy = (t) => isVecTy(t) && t.lgl === true;
/** 第 i 格元素的地址（`i` 从 0 数，所以要 +1 跳过长度那一格）。 */
const vecAt = (v, i) => call1('padd', v, i.kind === 'int'
  ? { kind: 'int', value: i.value + 1 }
  : b('+', i, { kind: 'int', value: 1 }));
const vecGet = (v, i) => ({ kind: 'deref', expr: vecAt(v, i) });
const vecSet = (v, i, x) => ({ kind: 'assign', target: { kind: 'deref', expr: vecAt(v, i) }, value: x });
const vecLen = (v) => call1('toint', { kind: 'deref', expr: v });
/**
 * 开一格长度为 `n` 的向量、绑到名字 `nm` 上：`n+1` 个槽，0 号写长度。回那两条语句。
 * `n` 是一格 int 表达式（字面量就折一下）。
 */
function vecNewAs(nm, n) {
  const v = { kind: 'name', name: nm };
  const slots = n.kind === 'int' ? { kind: 'int', value: n.value + 1 } : b('+', n, { kind: 'int', value: 1 });
  return [
    { kind: 'let', name: nm, type: RVEC, init: call1('pnew', tyArg(RVEC), slots) },
    { kind: 'assign', target: { kind: 'deref', expr: v }, value: asReal(n, INT) },
  ];
}
const NA_FNS = new Map([
  ['r_na', 'omni_r_na_into'],
  ['r_is_na', 'omni_r_is_na_p'],
  ['r_is_nan', 'omni_r_is_nan_p'],
]);
/** 这一趟要发哪几格生成出来的辅助函数。 */
const needFn = new Set();
const useFn = (name) => { needFn.add(name); return name; };

/**
 *
 */

/** 一格 NUM_CONST 的文本 → 标准 IR 的字面量。写法定类型，见文件头第 4 条。 */
function numLit(text) {
  const t = String(text);
  const c = CONSTS.get(t);
  if (c !== undefined) return c;
  if (NONNUM.has(t)) {
    const sym = NONNUM.get(t);
    cabiUsed.add(sym);
    rmathSig(sym);
    return { kind: 'ccall', sym, args: [] };
  }
  if (t === 'NA' || t === 'NA_real_') {
    return { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] };
  }
  if (t.startsWith('NA_')) {
    throw new Error(`r->IR: ${t} 还没接 —— 整数与串的 NA 在 R 那边是另外两种表示`
      + '（`INT_MIN` 与一格特殊的 CHARSXP），而我们还没有"带缺失的整数/串"那一层');
  }
  if (t.endsWith('i')) throw new Error(`r->IR: 复数还没接：${t}`);
  if (t.endsWith('L')) return { kind: 'int', value: Number(t.slice(0, -1)) };
  if (/^0[xX]/.test(t)) return { kind: 'int', value: Number(t) };
  if (t.includes('.') || /[eE]/.test(t)) return { kind: 'real', value: Number(t) };
  return { kind: 'int', value: Number(t) };
}

/* ─── 内建（表外的名字当用户函数调） ──────────────────────────────────────
 *
 * 这张表是**判据**，不是方便：R 的内建在树上与用户函数完全同形（`length(x)` 与 `f(x)`
 * 一个形状），分开它们只能靠名字。表外的名字照调 —— 于是"哪些内建接上了"这件事
 * 有一处说法，而不是散在 `exprOf` 的一串 if 里。
 */
const BUILTINS = new Set([
  'cat', 'paste', 'paste0', 'c', 'list', 'length', 'nchar', 'return', 'is.null',
  'as.integer', 'as.numeric', 'as.character', 'abs', 'seq_len', 'is.na', 'is.nan',
  'sum', 'mean', 'max', 'min', 'rev', 'seq_along', 'which',
  /* libm 那一族：R 自己这几个也是直接调 libm（不在 nmath 里），所以落方言的 `rmath`。
     一格实参、回 double —— `log(x, base)` 那种两格的**当场报**（R 那一档是 `log(x)/log(b)`，
     而"替它算"与"照它算"是两件事）。 */
  'sqrt', 'exp', 'log', 'log2', 'log10', 'floor', 'ceiling',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
]);

/** R 的名字 → `rmath` 那一格的名字（多半同名，`ceiling` 与 `log2`/`log10` 不同）。 */
const LIBM = new Map([
  ['sqrt', 'sqrt'], ['exp', 'exp'], ['log', 'log'], ['log2', 'log2'], ['log10', 'log10'],
  ['floor', 'floor'], ['ceiling', 'ceil'],
  ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'],
  ['asin', 'asin'], ['acos', 'acos'], ['atan', 'atan'],
  ['sinh', 'sinh'], ['cosh', 'cosh'], ['tanh', 'tanh'],
]);

/* ─── 扫一段：哪些名字被写过、写进去的是什么 ────────────────────────────── */

/** `<-` / `<<-` / `:=` / `=` 都是赋值（前三个是 LEFT_ASSIGN，第四个是 EQ_ASSIGN）。 */
const ASSIGN_OPS = new Set(['<-', '<<-', ':=', '=']);
const isAssign = (x) => (tag(x) === 'bin' && ASSIGN_OPS.has(String(leaf(kids(x)[0]))))
  || tag(x) === 'bin-rev';

/** 一格赋值 → `{target, value}`（`->` / `->>` 那两格实参是反的，见 gram.y:498）。 */
function assignParts(x) {
  const [, a, b] = kids(x);
  return tag(x) === 'bin-rev' ? { target: b, value: a } : { target: a, value: b };
}

/** 走遍一棵子树，每格赋值回调一次。 */
function eachAssign(x, fn) {
  if (!isList(x)) return;
  if (isAssign(x)) fn(assignParts(x));
  for (const k of kids(x)) eachAssign(k, fn);
}

/** 用 `[[…]]` 读写过的名字 —— R 的 `list` 这么用就是关联表（见文件头第 5 条）。 */
function dictNames(x, out = new Set()) {
  if (!isList(x)) return out;
  if (tag(x) === 'sub2' && tag(kids(x)[0]) === 'sym') out.add(nameOf(kids(x)[0]));
  for (const k of kids(x)) dictNames(k, out);
  return out;
}

/* ─── 类型推断 ─────────────────────────────────────────────────────────── */

/** 两格数值类型合起来：有一格是 real 就是 real（`1 + 0.5`）。 */
const joinNum = (a, b) => (a.kind === 'real' || b.kind === 'real' ? REAL : INT);

/** 一格表达式装的是什么。`types` 是这一段边推边查的那张表。 */
function typeOfExpr(x, types) {
  switch (tag(x)) {
    case 'num': {
      const v = numLit(leaf(kids(x)[0]));
      if (v.kind === 'bool') return BOOL;
      /* `NA` 走生成出来的 `r_na()`、`NaN` / `Inf` 走 ccall —— 三格回的都是 double */
      return v.kind === 'real' || v.kind === 'ccall' || v.kind === 'call' ? REAL : INT;
    }
    case 'str': return STR;
    case 'paren': return typeOfExpr(kids(x)[0], types);
    case 'sym': return types.get(mangle(nameOf(x))) ?? INT;
    case 'block': {
      const ks = kids(x);
      return ks.length === 0 ? INT : typeOfExpr(ks[ks.length - 1], types);
    }
    case 'if': {
      const ks = kids(x);
      return typeOfExpr(ks[1], types);
    }
    case 'un': {
      const op = String(leaf(kids(x)[0]));
      return op === '!' ? BOOL : typeOfExpr(kids(x)[1], types);
    }
    case 'sub1': {
      const a = types.get(mangle(nameOf(kids(x)[0])));
      if (!isVecTy(a)) return INT;
      /* 下标是向量 → 挑出来的还是一格向量（逻辑/数值随被挑的那个走）。 */
      const ks = kids(x).slice(1).map((k) => kids(k)[0]).filter((k) => k !== undefined);
      if (ks.length === 1 && isVecTy(typeOfExpr(ks[0], types))) return a;
      return REAL;
    }
    case 'sub2': {
      const d = types.get(mangle(nameOf(kids(x)[0])));
      if (d !== undefined && d.kind === 'map') return d.value;
      if (isVecTy(d)) return REAL;
      return INT;
    }
    case 'bin': {
      const op = String(leaf(kids(x)[0]));
      /* **向量那一问要摆在最前**：`xs > 2` 回的是**逻辑向量**，不是一格布尔 ——
         摆在 `return BOOL` 后面的话永远到不了（`sum(xs > 2)` 就会说"实参不是向量"）。 */
      if (VEC_OPS.has(op)) {
        const a = typeOfExpr(kids(x)[1], types);
        const c2 = typeOfExpr(kids(x)[2], types);
        if (isVecTy(a) || isVecTy(c2)) return VEC_CMP.has(op) ? RLGL : RVEC;
      }
      if (['<', '>', '<=', '>=', '==', '!=', '&', '&&', '|', '||'].includes(op)) return BOOL;
      if (ASSIGN_OPS.has(op)) return typeOfExpr(kids(x)[2], types);
      if (op === ':') return RVEC;
      /* `/` 一律实数除；`^` 走 `R_pow`、`%%` / `%/%` 走那条 floor 的算法 —— 三者都回 double */
      if (op === '/' || op === '^' || op === '**' || op === '%%' || op === '%/%') return REAL;
      return joinNum(typeOfExpr(kids(x)[1], types), typeOfExpr(kids(x)[2], types));
    }
    case 'bin-rev': return typeOfExpr(kids(x)[1], types);
    case 'call': return typeOfCall(x, types);
    default: return INT;
  }
}

/** 一次调用的结果类型。内建各自说，用户函数按"这门语言的数"算（见文件头第 4 条）。 */
function typeOfCall(x, types) {
  const fn = tag(kids(x)[0]) === 'sym' ? nameOf(kids(x)[0]) : null;
  const args = argsOf(x).map((a) => a.value).filter((v) => v !== null);
  /* R 自己的 C 那一族回的都是 `double` —— 这是 nmath 的形状，不是我们的选择。
     第一格实参是向量时逐元素，于是回的是一格向量（`sqrt(xs)` / `round(xs, 1)`）。 */
  if (fn !== null && RMATH.has(fn)) {
    return args.length > 0 && isVecTy(typeOfExpr(args[0], types)) ? RVEC : REAL;
  }
  if (fn !== null && PRED.has(fn)) return BOOL;
  if (fn === 'is.na' || fn === 'is.nan') return BOOL;
  switch (fn) {
    case 'paste': case 'paste0': case 'as.character': return STR;
    case 'length': case 'nchar': case 'as.integer': return INT;
    case 'as.numeric': return REAL;
    case 'is.null': return BOOL;
    case 'sum': case 'mean': case 'max': case 'min': return REAL;
    /* 这三格进出都是向量（`which` 回的是位置，所以是数值向量，不是逻辑向量）。 */
    case 'rev': case 'seq_along': case 'which': return RVEC;
    /* 这一批第一格是向量就逐元素（`sqrt(xs)`），标量进标量出。 */
    case 'sqrt': case 'exp': case 'log': case 'log2': case 'log10':
    case 'floor': case 'ceiling':
    case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan':
    case 'sinh': case 'cosh': case 'tanh':
      return args.length > 0 && isVecTy(typeOfExpr(args[0], types)) ? RVEC : REAL;
    case 'abs': return args.length === 0 ? INT : typeOfExpr(args[0], types);
    case 'return': return args.length === 0 ? INT : typeOfExpr(args[0], types);
    /* `c(TRUE, FALSE)` 在 R 里是**逻辑**向量（印 `TRUE` / `FALSE`），`c(1, 2)` 是数值向量。
       混着写（`c(TRUE, 1)`）R 会往数值那边收，所以"每一格都是逻辑"才算逻辑。 */
    case 'c': return args.length > 0 && args.every((a) => {
      const t = typeOfExpr(a, types);
      return t.kind === 'bool' || isLglTy(t);
    }) ? RLGL : RVEC;
    case 'list': return dictOf(INT);
    default: return INT;
  }
}

/**
 * 一段（函数体 / 顶层）里每个名字装什么。
 *
 * 次序要紧（与 `ext/awk/adapter.js` 同一条）：字典先定（它决定 `m[["k"]]` 的类型），
 * 再定别的。同一个名字写过多次而类型不同时**后写的赢** —— 例子里不出现，
 * 真出现了那是这门语言要单独定的一条规矩，不该在这儿悄悄挑一个。
 */
function inferTypes(body, params) {
  const types = new Map();
  for (const p of params) types.set(p, INT);
  const dicts = dictNames(body);
  for (const d of dicts) {
    const writes = [];
    eachAssign(body, ({ target, value }) => {
      if (tag(target) === 'sub2' && mangle(nameOf(kids(target)[0])) === mangle(d)) writes.push(value);
    });
    const vt = writes.length === 0 ? INT
      : (writes.some((w) => typeOfExpr(w, types).kind === 'string') ? STR
        : writes.map((w) => typeOfExpr(w, types)).reduce(joinNum, INT));
    types.set(mangle(d), dictOf(vt));
  }
  /* **两遍**（转到不动点）。两边互相要对方：`for (x in xs)` 里 `x` 的类型要问 `xs`，
     而 `xs` 的类型来自一句赋值；反过来 `t <- t + x` 里 `t` 要问 `x`。
     一遍下来必有一头是空的（症状是降级那一层报"t 是 int、赋的值是 real"），
     所以扫两遍：第一遍定住那些不依赖循环量的名字，第二遍把循环量与跟着它的名字定住。 */
  for (let round = 0; round < 2; round++) inferRound(body, params, types);
  return types;
}

/** `inferTypes` 的一遍（见那边"两遍"的账）。 */
function inferRound(body, params, types) {
  forNames(body, types);
  /* 同一个名字写过多次：**串赢、其次实数赢**（`t <- 0` 之后 `t <- t + 2.5`，t 是 double）。
     R 那边这不是"类型"而是"这一刻装着什么"，而方言那侧一个名字只有一种类型 ——
     所以取能装下所有写的那一种。 */
  const rank = (t) => (t.kind === 'string' ? 3 : (isVecTy(t) || t.kind === 'map' ? 3
    : (t.kind === 'real' ? 2 : 1)));
  eachAssign(body, ({ target, value }) => {
    if (tag(target) !== 'sym') return;
    const name = mangle(nameOf(target));
    if (params.includes(name)) return;
    const t0 = typeOfExpr(value, types);
    const t = t0.kind === 'bool' ? INT : t0;        // 条件的值装进量里当 0/1
    const had = types.get(name);
    if (had === undefined || rank(t) > rank(had)) types.set(name, t);
  });
}

/** `for (v in seq)` 里那个 `v`：区间是 int，序列是它的元素类型。 */
function isRangeHead(seq) {
  return tag(seq) === 'bin' && String(leaf(kids(seq)[0])) === ':';
}

function forNames(x, types) {
  if (!isList(x)) return;
  if (tag(x) === 'for') {
    const fc = kids(x)[0];
    const v = mangle(nameOf(kids(fc)[0]));
    const seq = kids(fc)[1];
    /* `for (v in a:b)` 落成计数循环（见 `forOf`），循环量是 int —— 这一格要跟那边对齐，
       不能问 `typeOfExpr`（那边答的是"`a:b` 当值用时是一格向量"）。 */
    const st = isRangeHead(seq) ? INT : typeOfExpr(seq, types);
    const want = isVecTy(st) ? REAL : st;   /* 向量上遍历，循环量是一格 double */
    const had = types.get(v);
    /* **第二遍要能盖掉第一遍** —— 第一遍时那格序列可能还没定型（`for (x in xs)` 里的 `xs`
       是后面一句赋值定的），于是 `x` 先按 int 记下。只往"装得下"的方向走，不往回。 */
    if (had === undefined || (had.kind === 'int' && want.kind === 'real')) types.set(v, want);
  }
  for (const k of kids(x)) forNames(k, types);
}

/* ─── 实参表 ───────────────────────────────────────────────────────────── */

/**
 * `(call f (arg e) (named-arg (sym k) e) …)` → `[{name, value}]`。
 *
 * 空的 `(arg)` 是 R 里真有的一格（`x[, 1]` / `f(a, )`），所以 `value` 可以是 null。
 * **只有一格而且是空的，那就是"没有实参"** —— R 的语法里 `f()` 走的正是
 * `sublist -> sub` 加 `sub -> ε`（gram.y:545/549），所以 `list()` 与 `f()` 都长这样。
 */
function argsOf(x) {
  const out = [];
  for (const a of kids(x).slice(1)) {
    if (tag(a) === 'arg') out.push({ name: null, value: kids(a)[0] ?? null });
    else if (tag(a) === 'named-arg') {
      const ks = kids(a);
      out.push({ name: nameOf(ks[0]), value: ks[1] ?? null });
    }
  }
  if (out.length === 1 && out[0].name === null && out[0].value === null) return [];
  return out;
}

/** 位置实参（命名的挑出去）。 */
const posArgs = (x) => argsOf(x).filter((a) => a.name === null).map((a) => a.value);
/** 一格命名实参的值（没有回 undefined）。 */
const namedArg = (x, k) => argsOf(x).find((a) => a.name === k)?.value;

/* ─── 表达式 ───────────────────────────────────────────────────────────── */

const b = (op, left, right) => ({ kind: 'binop', op, left, right });
const call1 = (name, ...args) => ({ kind: 'builtin', name, args });
/** 一格类型当实参用（`(anew (arr int) N)` 的第一格）—— 与 `ext/chez/adapter/expr.js` 同一格。 */
const tyArg = (type) => ({ kind: 'type', type });

/** 临时量的名字。一趟 `rToIR` 里从 0 起（出来的 `.sx` 要能进快照，不许带上一趟的号）。 */
let tmpN = 0;
const fresh = (p) => `r_${p}${tmpN++}`;

/**
 * 一格值变成 `double`（nmath 的每一格实参都是 f64）。
 * 已经是实数的**不包 `toreal`** —— 包了照样对，但 `.sx` 里会多出一层
 * `(toreal (real 0.5))` 这种明显的废话，而那种废话读的人会当成有意思的东西。
 */
const asReal = (e, ty) => {
  if (e.kind === 'real') return e;
  if (e.kind === 'int') return { kind: 'real', value: e.value };
  /* `TRUE` / `FALSE` 在 R 里当数用就是 1 / 0（`sum(c(TRUE,TRUE))` 是 2）。
     方言里 bool 与 real 之间没有转换，所以摊成一格三元。 */
  if (e.kind === 'bool') return { kind: 'real', value: e.value ? 1 : 0 };
  if (ty !== undefined && ty.kind === 'bool') {
    return { kind: 'ternary', cond: e, then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 } };
  }
  if (ty !== undefined && ty.kind === 'real') return e;
  return call1('toreal', e);
};

/**
 * 转发到 R 自己的 C：`(ccall sym …)`。
 *
 * 摆位的规矩与 R 的形参一样：**位置实参从左往右填格子，没填到的格子取缺省值**。
 * 于是 `dnorm(1)` → `dnorm4(1, 0, 1, 0)`、`dnorm(1, 2)` → `dnorm4(1, 2, 1, 0)`，
 * 而 `pnorm(q, mean, sd, lower.tail)` 那第四格在 R 里**本来就是** `lower.tail` ——
 * 按位置盖掉缺省值不是网开一面，是照 R 的形参表。
 *
 *   spec.fill —— 一格一个缺省值；`null` = 没有缺省值（R 那边必给）
 *   spec.take —— R 那边最多许给几格位置实参（默认 = 格子数）。只有"R 的形参与 C 的形参
 *                不是一一对应"的那几格要写它：`besselI(x, nu, expon.scaled)` 的第三格在
 *                R 里是 TRUE/FALSE，在 C 里是 1/2 —— 按位置传过去就是静默答错，所以只收两格。
 */
function rmathCall(rname, spec, args, argTys) {
  const need = spec.fill.filter((f) => f === null).length;
  const take = spec.take ?? spec.fill.length;
  if (args.length < need) {
    throw new Error(`r->IR: ${rname}() 至少要 ${need} 格实参（给了 ${args.length}）`);
  }
  if (args.length > take) {
    throw new Error(`r->IR: ${rname}() 这一批只接 ${take} 格位置实参（给了 ${args.length}）——`
      + ` 再往后那几格在 ${spec.sym}() 那侧的口径与 R 的形参不是一一对应的，`
      + '收下再忽略就是静默答错');
  }
  /* 签名从那份生成出来的头里查，查不到当场报（`rt/ffi.js` 会说清是名字错还是版本错）。
     顺手核一遍元数：表里 `fill` 的长度必须等于 C 那边的形参个数 —— 这一格是**这张表与
     那棵源码树之间的锁**（R 改了某个函数的元数，这儿就会报，而不是传错参数）。 */
  const sig = rmathSig(spec.sym);
  if (sig.params.length !== spec.fill.length) {
    throw new Error(`r->IR: ${spec.sym}() 在 Rmath.h 里收 ${sig.params.length} 格，`
      + `而这张表按 ${spec.fill.length} 格摆 —— RMATH 那一行与参考树走散了`);
  }
  cabiUsed.add(spec.sym);
  const out = spec.fill.map((f, i) => {
    const e = i < args.length ? args[i] : { kind: 'int', value: f };
    /* `i32` 那几格是 R 的 `lower.tail` / `log` 旗子，按整数走；别的一律 double。 */
    const ty = i < args.length ? argTys[i] : undefined;
    return sig.params[i] === 'i32' ? e : asReal(e, ty);
  });
  return { kind: 'ccall', sym: spec.sym, args: out };
}


/** 下标从 1 起 → 从 0 起。字面量当场折掉（`x[1]` 出 `aget(x, 0)` 而不是 `1-1`）。 */
function zeroBased(e) {
  if (e.kind === 'int') return { kind: 'int', value: e.value - 1 };
  return b('-', e, { kind: 'int', value: 1 });
}

/**
 * 一格值变成串。
 *
 * **实数走 `sgen(x, 7)`（`%.7g` 再去尾随零）** —— 这是 R 的 `cat` 对 double 的口径
 * （`getOption("digits")` 默认 7）。原来这儿一律 `tostr`，于是 `cat(dnorm(1))` 印
 * `0.24197072451914337` 而 R 印 `0.2419707` —— 差的不是精度，是"印几位"这条规矩。
 *
 * 明说还欠的一格：R 在**定点与科学记数之间按哪个短**挑（`scipen`），所以
 * `cat(1e5)` 是 `1e+05` 而 `%.7g` 给 `100000`；`cat(123456789)` 是 `123456789` 而
 * `%.7g` 给 `1.234568e+08`。那条挑法在 `src/main/format.c`（解释器那半边）里，
 * 这一版没做 —— 量过：这两种形状要么整数、要么 ≥1e5，例子里都不在这一档。
 */
const asStr = (x, types) => {
  const t = typeOfExpr(x, types);
  if (t.kind === 'string') return exprOf(x, types);
  if (t.kind === 'real') {
    return { kind: 'call', fn: { kind: 'name', name: useFn(NUM_STR) }, args: [exprOf(x, types)] };
  }
  /* 布尔在 R 里印 `TRUE` / `FALSE`（不是 `true` / `false`）—— 那是这门语言的写法。 */
  if (t.kind === 'bool') {
    return {
      kind: 'ternary',
      cond: exprOf(x, types),
      then: { kind: 'string', value: 'TRUE' },
      else_: { kind: 'string', value: 'FALSE' },
    };
  }
  return call1('tostr', exprOf(x, types));
};

/** `x[…]` / `x[[…]]` 的读：按对象的类型分数组还是字典（见文件头第 5 条）。 */
function indexRead(x, types) {
  const obj = kids(x)[0];
  const keys = kids(x).slice(1).map((a) => kids(a)[0]).filter((k) => k !== undefined);
  if (keys.length !== 1) throw new Error(`r->IR: 多维下标（x[i, j]）还没接（这儿给了 ${keys.length} 格）`);
  const ot = typeOfExpr(obj, types);
  const o = exprOf(obj, types);
  if (ot.kind === 'map') return call1('dget', o, exprOf(keys[0], types));
  if (isVecTy(ot)) {
    /* 下标本身是**向量**那两档（R 里 `xs[xs > 2]` 与 `xs[c(1,3)]` 都是天天写的形状）：
       逻辑向量按掩码挑、数值向量按位置挑，各走一格生成出来的辅助函数。 */
    const kt = typeOfExpr(keys[0], types);
    if (isVecTy(kt)) {
      const helper = isLglTy(kt) ? 'r_vec_mask' : 'r_vec_pick';
      return { kind: 'call', fn: { kind: 'name', name: useFn(helper) }, args: [o, exprOf(keys[0], types)] };
    }
    return vecGet(o, zeroBased(exprOf(keys[0], types)));
  }
  throw new Error(`r->IR: ${nameOf(obj)} 上的下标读不知道是数组还是表 —— 推出来是 ${ot.kind}`);
}

function exprOf(x, types, want) {
  switch (tag(x)) {
    case 'num': return numLit(leaf(kids(x)[0]));
    case 'str': return { kind: 'string', value: leaf(kids(x)[0]) };
    case 'sym': return { kind: 'name', name: mangle(nameOf(x)) };
    case 'paren': return exprOf(kids(x)[0], types);
    case 'sub1': case 'sub2': return indexRead(x, types);
    case 'call': return callOf(x, types, undefined, want);
    case 'pipe': {
      /* `x |> f(…)` 就是 `f(x, …)`（R 在语法动作 `xxpipe` 里当场展开，gram.y:495）。 */
      const [lhs, rhs] = kids(x);
      if (tag(rhs) !== 'call') throw new Error('r->IR: `|>` 右边必须是一次调用（R 自己也这么要求）');
      const e = callOf(rhs, types, exprOf(lhs, types));
      return e;
    }
    case 'un': {
      const op = String(leaf(kids(x)[0]));
      const operand = kids(x)[1];
      if (op === '!') return { kind: 'unop', op: '!', operand: condOf(operand, types) };
      if (op === '-' || op === '+') {
        /* 向量上的一元 `-` 逐元素（`-xs`）—— 方言的 `un` 只吃 int / real。 */
        if (isVecTy(typeOfExpr(operand, types))) {
          return op === '+' ? exprOf(operand, types)
            : vecMap1(exprOf(operand, types), (e) => ({ kind: 'unop', op: '-', operand: e }));
        }
        return { kind: 'unop', op, operand: exprOf(operand, types) };
      }
      throw new Error(`r->IR: 一元 \`${op}\` 还没接`);
    }
    case 'if': {
      /* 表达式位上的 `if` → `ternary`。**只有两支齐全**才行：R 里少一支的值是
         `NULL`（不可见），而方言里没有那一格 —— 当场报，别默默塞一个 0。 */
      const [c, t, e] = kids(x);
      if (e === undefined) throw new Error('r->IR: 表达式位上的 `if` 缺 `else` —— R 那一档的值是 NULL，方言里没有这一格');
      return {
        kind: 'ternary', cond: condOf(c, types), then: exprOf(t, types), else_: exprOf(e, types),
      };
    }
    case 'bin': {
      const [opN, l, r] = kids(x);
      const op = String(leaf(opN));
      if (ASSIGN_OPS.has(op)) throw new Error('r->IR: 表达式位上的赋值还没接（R 里它有值）');
      /* `&&` / `||` 两边当条件看；`&` / `|` 在 R 里是**向量化**的那一对，标量上同解。 */
      if (op === '&&' || op === '&') return b('&&', condOf(l, types), condOf(r, types));
      if (op === '||' || op === '|') return b('||', condOf(l, types), condOf(r, types));
      /* `^` 交给 R 自己的 `R_pow`（`src/nmath/mlutils.c`）—— 它对整数指数走反复平方、
         对 `1^x` 与 `x^0` 有明文特例，而 `pow()` 在这几格上与 R 不一样。 */
      if (op === '^' || op === '**') {
        const vp = vecBin(op, l, r, types);
        if (vp !== null) return vp;
        return powOf(asReal(exprOf(l, types), typeOfExpr(l, types)), asReal(exprOf(r, types), typeOfExpr(r, types)));
      }
      /* `%%` 与 `%/%`：**照 R 文档的定义算**（`x - floor(x/y)*y` / `floor(x/y)`），
         于是结果随**除数**取号（`-7 %% 3` 是 2，C 的 `%` 给 -1）。
         这两格 nmath 里没有（R 的 `myfmod` 在解释器那半边 `src/main/arith.c` 里），
         所以是我们按它公开的口径写的 —— 不是抄过来的，也不是 C 的口径。 */
      if (op === '%%' || op === '%/%') {
        /* 一边是向量就逐元素 —— 这两格与 `^` 都走 `vecBin` 里的 `numBin`。 */
        const vm = vecBin(op, l, r, types);
        if (vm !== null) return vm;
        return modOf(op, asReal(exprOf(l, types), typeOfExpr(l, types)), asReal(exprOf(r, types), typeOfExpr(r, types)));
      }
      if (op === ':') return vecSeq(exprOf(l, types), typeOfExpr(l, types), exprOf(r, types), typeOfExpr(r, types));
      if (op === '$' || op === '@' || op === '::' || op === ':::' || op === '~' || op === '?') {
        throw new Error(`r->IR: \`${op}\` 还没接`);
      }
      /* **向量化**：一边是向量就逐元素算（R 里这是常态，不是特例）。 */
      {
        const vt = vecBin(op, l, r, types);
        if (vt !== null) return vt;
      }
      /* **数值提升**：R 里 `/` 一律回 double，别的算符只要有一边是 double 就回 double
         （`NA + 1` 也走这条 —— `NA` 是 double）。方言那侧要求两边同型，所以提升在这儿做。
         比较也一样：`1 > 0.5` 两边得先对齐。 */
      const lt = typeOfExpr(l, types);
      const rt = typeOfExpr(r, types);
      const le = exprOf(l, types);
      const re = exprOf(r, types);
      const numeric = ['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!='].includes(op);
      if (numeric && (op === '/' || lt.kind === 'real' || rt.kind === 'real')
          && lt.kind !== 'string' && rt.kind !== 'string') {
        return b(op, asReal(le, lt), asReal(re, rt));
      }
      return b(op, le, re);
    }
    default:
      throw new Error(`r->IR: 这一格表达式还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/**
 * 逐元素那一族算符。`^` / `%%` / `%/%` 不在里头 —— 它们各自走 `R_pow` 与那条 floor 的算法，
 * 向量化要另摆一层（明写：没做）。
 */
const VEC_OPS = new Set(['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!=', '^', '**', '%%', '%/%']);

/**
 * 一格算符在**两个已经是 double 的值**上怎么算。标量那条路与 `vecBin` 里逐元素那条路
 * 共用这一处 —— 不然 `xs^2` 与 `x^2` 会算成两回事（`^` 必须是 R 的 `R_pow`）。
 */
const powOf = (x, y) => {
  /* `^` 交给 R 自己的 `R_pow`（`src/nmath/mlutils.c`）—— 它对整数指数走反复平方、
     对 `1^x` 与 `x^0` 有明文特例，而 `pow()` 在这几格上与 R 不一样。 */
  cabiUsed.add('R_pow');
  rmathSig('R_pow');
  return { kind: 'ccall', sym: 'R_pow', args: [x, y] };
};
const modOf = (op, x, y) => {
  const q = call1('rmath', { kind: 'strlit', value: 'floor' }, b('/', x, y));
  return op === '%/%' ? q : b('-', x, b('*', q, y));
};
const numBin = (op, x, y) => {
  if (op === '^' || op === '**') return powOf(x, y);
  if (op === '%%' || op === '%/%') return modOf(op, x, y);
  return b(op, x, y);
};

/**
 * **逐元素映射**：一格向量进、一格向量出（`sqrt(xs)` / `-xs` / `abs(xs)` / `round(xs, 1)`）。
 *
 * `mk(elem)` 给"一格 double 上怎么算" —— 与标量那条路**用同一处算法**（`numBin` 那条规矩
 * 在一元这边也管）。`pre` 是要摆在循环前面的语句（比如把 `round(xs, d)` 的 `d` 存进临时量：
 * 循环里要读好多遍，不能求好多遍）。
 */
function vecMap1(vecE, mk, pre = []) {
  const src = fresh('mv');
  const nm = fresh('mn');
  const out = fresh('mo');
  const i = fresh('mi');
  const vr = (x) => ({ kind: 'name', name: x });
  return {
    kind: 'block-expr',
    stmts: [
      ...pre,
      { kind: 'let', name: src, type: RVEC, init: vecE },
      { kind: 'let', name: nm, type: INT, init: vecLen(vr(src)) },
      ...vecNewAs(out, vr(nm)),
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: b('<', vr(i), vr(nm)),
        post: { kind: 'assign', target: vr(i), value: b('+', vr(i), { kind: 'int', value: 1 }) },
        body: [vecSet(vr(out), vr(i), mk(vecGet(vr(src), vr(i))))],
      },
    ],
    value: vr(out),
  };
}

/**
 * **向量化**：一边是向量就逐元素算。回 `null` 表示"两边都是标量，不是我的活"。
 *
 * R 的回收规则：结果长度取**长的那个**，短的那一边从头再来（`c(1,2,3,4) + c(10,20)` 是
 * `11 22 13 24`）。R 在长的不是短的整数倍时还会**警告**，我们不发警告 —— 那要一条
 * 输出通道，而这一版没有（明写在 SPEC 里）。
 *
 * 落成一格 `block-expr`：先把两边存进临时量（**一次求值** —— 循环里要读好多遍），
 * 再开结果数组，`while` 填，最后拿那格临时量当值。
 */
/** `is.na(x)` 那一问（走按指针的生成函数 —— 载荷按值过 N-API 会丢）。 */
const naQ = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [e] });

/**
 * `a:b` 当**值**用时造出来的那一格向量（`for (v in a:b)` 不走这儿 —— 那边是计数循环）。
 *
 * 按 R 的口径：步长是 ±1、**两头都含**，而 `b < a` 时是**倒着数**（`5:1` 是 `5 4 3 2 1`；
 * `1:0` 是 `1 0` —— 那是 R 里有名的一格坑，所以这儿不当空向量）。
 * 长度 `floor(|b-a|) + 1`，于是 `1.5:3` 是 `1.5 2.5`（R 也是两格）。
 */
function vecSeq(loE, loT, hiE, hiT) {
  const lo = fresh('sl');
  const hi = fresh('sh');
  const nm = fresh('sn');
  const out = fresh('so');
  const i = fresh('si');
  const vr = (x) => ({ kind: 'name', name: x });
  const up = b('>=', vr(hi), vr(lo));
  return {
    kind: 'block-expr',
    stmts: [
      /* 两头**先存进临时量** —— 长度与每一格都要读它们，不能求两遍（`f():g()` 会有副作用）。 */
      { kind: 'let', name: lo, type: REAL, init: asReal(loE, loT) },
      { kind: 'let', name: hi, type: REAL, init: asReal(hiE, hiT) },
      {
        kind: 'let',
        name: nm,
        type: INT,
        init: b('+', call1('toint', { kind: 'ternary', cond: up, then: b('-', vr(hi), vr(lo)), else_: b('-', vr(lo), vr(hi)) }), { kind: 'int', value: 1 }),
      },
      ...vecNewAs(out, vr(nm)),
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: b('<', vr(i), vr(nm)),
        post: { kind: 'assign', target: vr(i), value: b('+', vr(i), { kind: 'int', value: 1 }) },
        body: [vecSet(vr(out), vr(i), {
          kind: 'ternary',
          cond: up,
          then: b('+', vr(lo), asReal(vr(i), INT)),
          else_: b('-', vr(lo), asReal(vr(i), INT)),
        })],
      },
    ],
    value: vr(out),
  };
}

function vecBin(op, l, r, types) {
  if (!VEC_OPS.has(op)) return null;
  const lt = typeOfExpr(l, types);
  const rt = typeOfExpr(r, types);
  if (!isVecTy(lt) && !isVecTy(rt)) return null;
  if (lt.kind === 'string' || rt.kind === 'string') {
    throw new Error(`r->IR: \`${op}\` 的一边是向量、另一边是串 —— 这一格还没接`);
  }
  const side = (e, ty, name) => {
    /* 标量那一边不入数组：循环里直接读那格临时量（省一次 anew 与一趟 aset）。 */
    const isVec = isVecTy(ty);
    return {
      isVec,
      name,
      decl: {
        kind: 'let', name, type: isVec ? RVEC : REAL, init: isVec ? e : asReal(e, ty),
      },
    };
  };
  const a = side(exprOf(l, types), lt, fresh('vl'));
  const c = side(exprOf(r, types), rt, fresh('vr'));
  const nm = fresh('vn');
  const out = fresh('vo');
  const i = fresh('vi');
  const vr = (x) => ({ kind: 'name', name: x });
  /* 每一边的长度**先存进一格 int**（`vecLen` 是一次内存读 + 一次转换，摆在循环里就是每元素一次）。
     量出来的（bench/r/run.js，2026-09-25）：`vec.R` 原生腿 2.0s → 0.66s。 */
  const lens = [a, c].filter((x) => x.isVec).map((x) => ({ x, nm: fresh('vk') }));
  const lenOf = (x) => vr(lens.find((e) => e.x === x).nm);
  /* 结果长度：两边都是向量取大的，只有一边是向量就是它的长度 */
  const len = a.isVec && c.isVec
    ? { kind: 'ternary', cond: b('>=', lenOf(a), lenOf(c)), then: lenOf(a), else_: lenOf(c) }
    : lenOf(a.isVec ? a : c);
  /* 取第 i 格：标量就是它自己；向量按 `i % 它的长度`（回收）——
     **只有一边是向量时那个取模是废的**（结果长度就是它的长度，`i` 一定在范围里），所以省掉。 */
  const oneVec = !(a.isVec && c.isVec);
  const at = (x) => {
    if (!x.isVec) return vr(x.name);
    return vecGet(vr(x.name), oneVec ? vr(i) : b('%', vr(i), lenOf(x)));
  };
  return {
    kind: 'block-expr',
    stmts: [
      a.decl,
      c.decl,
      ...lens.map((e) => ({ kind: 'let', name: e.nm, type: INT, init: vecLen(vr(e.x.name)) })),
      { kind: 'let', name: nm, type: INT, init: len },
      ...vecNewAs(out, vr(nm)),
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: b('<', vr(i), vr(nm)),
        post: { kind: 'assign', target: vr(i), value: b('+', vr(i), { kind: 'int', value: 1 }) },
        /* 比较那几格在 R 里回**逻辑向量**：1.0 / 0.0 / NA，印成 `TRUE` / `FALSE` / `NA`。
           NA 那一格得按 R 的口径传下去 —— `NA > 2` 与 `NaN > 2` 都是 NA（不是 FALSE），
           而 `is.na` 对这两格都真，所以一问就够。 */
        body: [VEC_CMP.has(op) ? {
          kind: 'if',
          cond: b('||', naQ(at(a)), naQ(at(c))),
          then: [vecSet(vr(out), vr(i), { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] })],
          else_: [vecSet(vr(out), vr(i), { kind: 'ternary', cond: b(op, at(a), at(c)), then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 } })],
        } : vecSet(vr(out), vr(i), numBin(op, at(a), at(c)))],
      },
    ],
    value: vr(out),
  };
}
const VEC_CMP = new Set(['<', '<=', '>', '>=', '==', '!=']);

/** 条件。R 要求条件是逻辑值（不像 C 收 0/1），所以这儿只在**字面量**上折一格。 */
function condOf(x, types) {
  if (tag(x) === 'paren') return condOf(kids(x)[0], types);
  const t = typeOfExpr(x, types);
  if (t.kind === 'bool') return exprOf(x, types);
  /* 数当条件：R 的规矩是"不是 0 就是真"（`if (1)` 合法）。 */
  if (t.kind === 'int' || t.kind === 'real') {
    return b('!=', exprOf(x, types), { kind: t.kind, value: 0 });
  }
  throw new Error(`r->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}

/* ─── 调用（内建在这儿分岔） ───────────────────────────────────────────── */

/**
 * 一次调用。`extra` 是 `|>` 塞到第一位的那格实参。
 * 内建**不是调用** —— 它们落成方言的算子（与 chez 的 `vector-ref` 落 `aget` 同一条）。
 */
function callOf(x, types, extra, want) {
  const fnNode = kids(x)[0];
  const fn = tag(fnNode) === 'sym' ? nameOf(fnNode) : null;
  const args = posArgs(x);
  const all = extra === undefined ? args : [null, ...args];
  const ev = (i) => (all[i] === null ? extra : exprOf(all[i], types));
  const n = all.length;

  /* `is.na` / `is.nan`：走那两格按指针的生成函数（载荷不能按值过，见 `PTR_REAL` 那段）。 */
  if (fn === 'is.na' || fn === 'is.nan') {
    if (n !== 1) throw new Error(`r->IR: ${fn}() 要正好一格实参（给了 ${n}）`);
    const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
    const name = useFn(fn === 'is.na' ? 'r_is_na' : 'r_is_nan');
    return { kind: 'call', fn: { kind: 'name', name }, args: [asReal(ev(0), t)] };
  }

  /* `is.finite` / `is.infinite`：C 回 int，包一格 `!= 0` 成布尔。 */
  if (fn !== null && PRED.has(fn)) {
    if (n !== 1) throw new Error(`r->IR: ${fn}() 要正好一格实参（给了 ${n}）`);
    const sym = PRED.get(fn);
    cabiUsed.add(sym);
    rmathSig(sym);
    const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
    return b('!=', { kind: 'ccall', sym, args: [asReal(ev(0), t)] }, { kind: 'int', value: 0 });
  }

  /* **R 自己的 C 先问一遍**（摆在 BUILTINS 之前）：这一族的答案不由我们给。 */
  if (fn !== null && RMATH.has(fn)) {
    const tys = all.map((a) => (a === null ? REAL : typeOfExpr(a, types)));
    const args = all.map((a, i) => ev(i));
    /* 第一格是向量就逐元素（`round(xs, 1)` / `dnorm(xs)`）：别的实参先存进临时量 ——
       循环里每一圈都要读，不能求好多遍。**只在第一格上逐元素** —— R 这一族其实是多头回收的
       （`round(xs, c(1,2))`），那要再摆一层，所以别的格也是向量时当场报，不假装。 */
    if (isVecTy(tys[0])) {
      const pre = [];
      const rest = args.slice(1).map((e, k) => {
        if (isVecTy(tys[k + 1])) {
          throw new Error(`r->IR: ${fn}() 只在第一格实参上逐元素（第 ${k + 2} 格也是向量 —— 多头回收还没接）`);
        }
        const nm = fresh('ma');
        pre.push({ kind: 'let', name: nm, type: REAL, init: asReal(e, tys[k + 1]) });
        return { kind: 'name', name: nm };
      });
      return vecMap1(args[0], (el) => rmathCall(fn, RMATH.get(fn), [el, ...rest], [REAL, ...rest.map(() => REAL)]), pre);
    }
    return rmathCall(fn, RMATH.get(fn), args, tys);
  }

  if (fn !== null && BUILTINS.has(fn)) {
    switch (fn) {
      case 'return':
        throw new Error('r->IR: `return()` 只能摆在语句位上（这儿在表达式里）');
      case 'length': {
        if (n !== 1) throw new Error('r->IR: length() 要一格实参');
        const t = all[0] === null ? INT : typeOfExpr(all[0], types);
        if (t.kind === 'map') return call1('dlen', ev(0));
        return vecLen(ev(0));
      }
      case 'nchar':
        if (n !== 1) throw new Error('r->IR: nchar() 要一格实参');
        return call1('slen', ev(0));
      case 'paste0': case 'paste': {
        /* `paste` 的默认 `sep` 是一个空格，`paste0` 是空串（R 的文档）。
           接起来的是**串**，所以数要先 `tostr` —— 与 awk 的 `cat` 那一格同一条。 */
        const sepNode = namedArg(x, 'sep');
        let sep = fn === 'paste0' ? '' : ' ';
        if (sepNode !== undefined) {
          if (tag(sepNode) !== 'str') throw new Error('r->IR: paste() 的 sep= 只接串字面量');
          sep = leaf(kids(sepNode)[0]);
        }
        if (n === 0) return { kind: 'string', value: '' };
        const parts = all.map((a, i) => (a === null ? call1('tostr', extra) : asStr(a, types)));
        return parts.reduce((acc, p) => b('+', sep === ''
          ? acc : b('+', acc, { kind: 'string', value: sep }), p));
      }
      case 'c': {
        /* `c(…)` 造一格向量，并且**摊平**实参里的向量（`c(xs, 4)` 是 R 的常用写法）。
           方言里"造"与"填"是两件事（`pnew` 只给槽数，写要 `pstore`，而那是语句），
           所以回一格 `block-expr`：先跑几句，再拿那格临时量当值。

           长度是**运行期**才知道的（向量那几格要问槽 0），所以先把向量实参存进临时量
           （一次求值），长度按"标量算 1、向量算它的长度"加起来，再拿一格写指针 `k` 填。 */
        if (n === 0) throw new Error('r->IR: `c()` 不带实参（空向量）还没接');
        /* **一律 double** —— R 的 `c(10, 20, 30)` 是 double 向量（要 integer 得写 `10L`）。
           这一格原来按实参推 int/real，于是 `c(1, 2) + 0.5` 会在元素类型上打架。 */
        const vr = (nm) => ({ kind: 'name', name: nm });
        const pre = [];
        const parts = all.map((a, i) => {
          const t = a === null ? REAL : typeOfExpr(a, types);
          if (!isVecTy(t)) return { vec: false, value: asReal(ev(i), t) };
          const nm = fresh('ci');
          pre.push({ kind: 'let', name: nm, type: RVEC, init: ev(i) });
          return { vec: true, name: nm };
        });
        /* 总长度：标量那几格是常数，先加起来（`.sx` 里就少一串 `(bin "+" … (int 1))`）。 */
        const flat = parts.filter((p) => !p.vec).length;
        const len = parts.filter((p) => p.vec)
          .reduce((acc, p) => b('+', acc, vecLen(vr(p.name))), { kind: 'int', value: flat });
        const tmp = fresh('vec');
        const stmts = [...pre, ...vecNewAs(tmp, len)];
        const out = vr(tmp);
        if (parts.every((p) => !p.vec)) {
          /* 全是标量：下标是字面量，不必要那格写指针。 */
          parts.forEach((p, i) => stmts.push(vecSet(out, { kind: 'int', value: i }, p.value)));
          return { kind: 'block-expr', stmts, value: out };
        }
        const k = fresh('ck');
        stmts.push({ kind: 'let', name: k, type: INT, init: { kind: 'int', value: 0 } });
        const bump = { kind: 'assign', target: vr(k), value: b('+', vr(k), { kind: 'int', value: 1 }) };
        for (const p of parts) {
          if (!p.vec) {
            stmts.push(vecSet(out, vr(k), p.value), bump);
            continue;
          }
          const j = fresh('cj');
          stmts.push({
            kind: 'for',
            init: { kind: 'let', name: j, type: INT, init: { kind: 'int', value: 0 } },
            cond: b('<', vr(j), vecLen(vr(p.name))),
            post: { kind: 'assign', target: vr(j), value: b('+', vr(j), { kind: 'int', value: 1 }) },
            body: [vecSet(out, vr(k), vecGet(vr(p.name), vr(j))), bump],
          });
        }
        return { kind: 'block-expr', stmts, value: out };
      }
      case 'list': {
        if (n !== 0) throw new Error('r->IR: `list(…)` 带实参（有名字的表）还没接 —— 只接 `list()` 造空表');
        /* 空表的**值类型**这一层答不出来（R 里它就是空的），所以听上游那格 `want`——
           也就是"这个名字装什么"那张表推出来的（见 `inferTypes` 的 dicts 那一段）。 */
        return call1('dnew', tyArg(want !== undefined && want.kind === 'map' ? want : dictOf(INT)));
      }
      case 'is.null': {
        /* `is.null(m[["k"]])` 是 R 里问"这张表有没有这个键"的写法（缺键回 NULL）。
           **只认这一种形状** —— 别的 `is.null` 当场报，不假装。 */
        if (n !== 1 || all[0] === null || tag(all[0]) !== 'sub2') {
          throw new Error('r->IR: is.null() 只接 `is.null(x[["k"]])` 那一种形状（问表里有没有这个键）');
        }
        const obj = kids(all[0])[0];
        const key = kids(kids(all[0])[1])[0];
        return { kind: 'unop', op: '!', operand: call1('dhas', exprOf(obj, types), exprOf(key, types)) };
      }
      case 'sqrt': case 'exp': case 'log': case 'log2': case 'log10':
      case 'floor': case 'ceiling':
      case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan':
      case 'sinh': case 'cosh': case 'tanh': {
        if (n !== 1) {
          throw new Error(`r->IR: ${fn}() 这一批只接一格实参（给了 ${n}）——`
            + ' 两格那一档（`log(x, base)`）要我们替它算，而"替它算"与"照它算"是两件事');
        }
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        const sym = { kind: 'strlit', value: LIBM.get(fn) };
        if (isVecTy(t)) return vecMap1(ev(0), (e) => call1('rmath', sym, e));
        return call1('rmath', sym, asReal(ev(0), t));
      }
      case 'sum': case 'mean': case 'max': case 'min': {
        /* 向量那一档走生成出来的函数；标量那一档（`max(a, b)`）归 `pmax`/`pmin` 那张表。 */
        if (n !== 1) {
          throw new Error(`r->IR: ${fn}() 这一批只接一格向量实参（给了 ${n}）——`
            + ' 两格数取大小写 `pmax` / `pmin`（R 的 `max(a, b)` 要"任意多格实参"那一层）');
        }
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (!isVecTy(t)) throw new Error(`r->IR: ${fn}() 的实参不是向量（是 ${t.kind}）`);
        const name = useFn({
          sum: 'r_sum', mean: 'r_mean', max: 'r_max', min: 'r_min',
        }[fn]);
        return { kind: 'call', fn: { kind: 'name', name }, args: [ev(0)] };
      }
      case 'as.integer': return call1('toint', ev(0));
      case 'as.numeric': return call1('toreal', ev(0));
      case 'as.character': return call1('tostr', ev(0));
      case 'abs': {
        const t = all[0] === null ? INT : typeOfExpr(all[0], types);
        if (isVecTy(t)) return vecMap1(ev(0), (e) => call1('rmath', { kind: 'strlit', value: 'fabs' }, e));
        if (t.kind === 'real') return call1('rmath', { kind: 'strlit', value: 'fabs' }, ev(0));
        /* 整数上的 `abs`：方言里没有这一格算子，落成一格三元 */
        return { kind: 'ternary', cond: b('<', ev(0), { kind: 'int', value: 0 }), then: { kind: 'unop', op: '-', operand: ev(0) }, else_: ev(0) };
      }
      case 'rev': case 'seq_along': case 'which': {
        if (n !== 1) throw new Error(`r->IR: ${fn}() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? INT : typeOfExpr(all[0], types);
        if (!isVecTy(t)) throw new Error(`r->IR: ${fn}() 的实参不是向量（是 ${t.kind}）`);
        if (fn === 'which' && !isLglTy(t)) {
          throw new Error('r->IR: which() 的实参要是逻辑向量（R 里它就是"哪几格为真"）');
        }
        return { kind: 'call', fn: { kind: 'name', name: useFn(`r_${fn}`) }, args: [ev(0)] };
      }
      case 'cat':
        throw new Error('r->IR: `cat()` 只能摆在语句位上（这儿在表达式里）');
      case 'seq_len':
        throw new Error('r->IR: seq_len() 只在 `for (v in seq_len(n))` 那一格接了');
      default:
        throw new Error(`r->IR: 内建 ${fn} 在表里却没有落法 —— BUILTINS 与这个 switch 走散了`);
    }
  }
  if (fn === null) throw new Error('r->IR: 只接"名字 + 实参"那种调用（函数值还没接）');
  return { kind: 'call', fn: { kind: 'name', name: mangle(fn) }, args: all.map((a, i) => ev(i)) };
}

/**
 * `cat(…)` → 一串 `write`。
 *
 * **为什么不是 `print`**：方言的 `print` 自带换行，而 R 的 `cat` 不带（换行要自己写
 * `"\n"`）。那两件事差一个字节，而例子的判据是**逐字节**对 `Rscript` ——
 * 所以这儿老老实实按 `cat` 的语义发：各实参按 `sep` 连起来，一格不多。
 */
function catOf(x, types) {
  const args = posArgs(x);
  const sepNode = namedArg(x, 'sep');
  let sep = ' ';
  if (sepNode !== undefined) {
    if (tag(sepNode) !== 'str') throw new Error('r->IR: cat() 的 sep= 只接串字面量');
    sep = leaf(kids(sepNode)[0]);
  }
  /* 向量那一格要一个循环，所以这儿发的是**语句**（不是先攒一串串再写）：
     `cat(xs)` 在 R 里把元素按 `sep` 连起来印，而元素个数是运行期才知道的。 */
  const out = [];
  args.forEach((a, i) => {
    if (i > 0 && sep !== '') {
      out.push({ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'string', value: sep }] });
    }
    if (isVecTy(typeOfExpr(a, types))) {
      out.push({
        kind: 'expr-stmt',
        expr: {
          kind: 'call',
          fn: { kind: 'name', name: useFn(isLglTy(typeOfExpr(a, types)) ? 'r_cat_lgl' : 'r_cat_vec') },
          args: [exprOf(a, types), { kind: 'string', value: sep }],
        },
      });
      return;
    }
    out.push({ kind: 'builtin-stmt', name: 'write', args: [asStr(a, types)] });
  });
  return { kind: 'block', stmts: out };
}

/* ─── 语句 ─────────────────────────────────────────────────────────────── */

/** 赋值的左边 → 一条语句（数组/表的下标写落 `aset` / `dset`，标量落 `assign`）。 */
function assignOf(x, types) {
  const { target, value } = assignParts(x);
  const t = tag(target);
  if (t === 'sym') {
    const name = mangle(nameOf(target));
    const want = types.get(name);
    const vt = typeOfExpr(value, types);
    let v = exprOf(value, types, want);
    /* 名字定成了 double、这一句给的是整数 → 提升。R 里 `t <- 0` 之后 `t <- t + 2.5` 是一回事
       （那格量一直是 double），而方言那侧一个名字只有一种类型，所以写的时候对齐。 */
    if (want !== undefined && want.kind === 'real' && vt.kind === 'int') v = asReal(v, vt);
    return { kind: 'assign', target: { kind: 'name', name }, value: v };
  }
  if (t === 'sub1' || t === 'sub2') {
    const obj = kids(target)[0];
    const keys = kids(target).slice(1).map((a) => kids(a)[0]).filter((k) => k !== undefined);
    if (keys.length !== 1) throw new Error('r->IR: 多维下标的写（x[i, j] <- …）还没接');
    const ot = typeOfExpr(obj, types);
    const o = exprOf(obj, types);
    if (ot.kind === 'map') {
      return { kind: 'builtin-stmt', name: 'dset', args: [o, exprOf(keys[0], types), exprOf(value, types)] };
    }
    if (isVecTy(ot)) {
      return vecSet(o, zeroBased(exprOf(keys[0], types)), asReal(exprOf(value, types), typeOfExpr(value, types)));
    }
    throw new Error(`r->IR: ${nameOf(obj)} 上的下标写不知道是数组还是表 —— 推出来是 ${ot.kind}`);
  }
  throw new Error(`r->IR: 这一格赋值的左边还没接：${t}`);
}

/** `for (v in seq)` → 一格计数循环。`continue` 照跑步进，所以步进要摆在 `post` 上。 */
function forOf(x, types) {
  const fc = kids(x)[0];
  const v = mangle(nameOf(kids(fc)[0]));
  const seq = kids(fc)[1];
  const body = stmtsOf(kids(x)[1], types);
  const name = { kind: 'name', name: v };
  const step = { kind: 'assign', target: name, value: b('+', name, { kind: 'int', value: 1 }) };

  /* `a:b` 那一档：R 最常见的循环头，直接落成"从 a 数到 b"。 */
  if (tag(seq) === 'bin' && String(leaf(kids(seq)[0])) === ':') {
    const [, lo, hi] = kids(seq);
    return {
      kind: 'for',
      init: { kind: 'assign', target: name, value: exprOf(lo, types) },
      cond: b('<=', name, exprOf(hi, types)),
      post: step,
      body,
    };
  }
  /* `seq_len(n)` 是 `1:n` 的"n 可能是 0"那一版（R 里 `1:0` 会倒着走 —— 那是个真坑）。 */
  if (tag(seq) === 'call' && tag(kids(seq)[0]) === 'sym' && nameOf(kids(seq)[0]) === 'seq_len') {
    const hi = posArgs(seq)[0];
    return {
      kind: 'for',
      init: { kind: 'assign', target: name, value: { kind: 'int', value: 1 } },
      cond: b('<=', name, exprOf(hi, types)),
      post: step,
      body,
    };
  }
  /* 向量上的遍历：一格计数循环，体的第一句把元素绑到循环量上。
     序列**先存进临时量** —— 不然 `for (x in c(…))` 每转一圈都会重造那格向量。 */
  if (isVecTy(typeOfExpr(seq, types))) {
    const src = fresh('seq');
    const idx = fresh('si');
    const vr = (nm) => ({ kind: 'name', name: nm });
    return {
      kind: 'block',
      stmts: [
        { kind: 'let', name: src, type: RVEC, init: exprOf(seq, types) },
        {
          kind: 'for',
          init: { kind: 'let', name: idx, type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', vr(idx), vecLen(vr(src))),
          post: { kind: 'assign', target: vr(idx), value: b('+', vr(idx), { kind: 'int', value: 1 }) },
          body: [
            { kind: 'assign', target: name, value: vecGet(vr(src), vr(idx)) },
            ...body,
          ],
        },
      ],
    };
  }
  throw new Error('r->IR: `for (v in …)` 只接 `a:b` / `seq_len(n)` / 一格向量'
    + '（数组上的遍历要先有向量那一层，见 adapter 文件头第 1 条）');
}

/** 一格语句。`(block …)` 摊平成一格 block。 */
function stmtOf(x, types) {
  switch (tag(x)) {
    case 'block': return { kind: 'block', stmts: kids(x).map((k) => stmtOf(k, types)) };
    case 'bin': {
      if (isAssign(x)) return assignOf(x, types);
      return { kind: 'expr-stmt', expr: exprOf(x, types) };
    }
    case 'bin-rev': return assignOf(x, types);
    case 'if': {
      const [c, t, e] = kids(x);
      return {
        kind: 'if',
        cond: condOf(c, types),
        then: stmtsOf(t, types),
        else_: e === undefined ? null : stmtsOf(e, types),
      };
    }
    case 'while': return { kind: 'while', cond: condOf(kids(x)[0], types), body: stmtsOf(kids(x)[1], types) };
    /* `repeat { … }` 就是 `while (true) { … }`（R 里它只能靠 `break` 出来）。 */
    case 'repeat': return { kind: 'while', cond: { kind: 'bool', value: true }, body: stmtsOf(kids(x)[0], types) };
    case 'for': return forOf(x, types);
    case 'break': return { kind: 'break', label: null };
    case 'next': return { kind: 'continue', label: null };
    case 'call': {
      const fnNode = kids(x)[0];
      const fn = tag(fnNode) === 'sym' ? nameOf(fnNode) : null;
      /* `cat()` 与 `return()` 在 R 里都是**调用**，落到的却是语句（见文件头第 2 条）。 */
      if (fn === 'cat') return catOf(x, types);
      if (fn === 'return') {
        const vs = posArgs(x);
        return { kind: 'return', values: vs.length === 0 ? [] : [exprOf(vs[0], types)] };
      }
      return { kind: 'expr-stmt', expr: exprOf(x, types) };
    }
    case 'paren': return stmtOf(kids(x)[0], types);
    default:
      return { kind: 'expr-stmt', expr: exprOf(x, types) };
  }
}

/** 一格"体"（可能是 `{…}`，也可能是单独一句）→ 一串语句。 */
function stmtsOf(x, types) {
  if (tag(x) === 'block') return kids(x).map((k) => stmtOf(k, types));
  return [stmtOf(x, types)];
}

/* ─── 尾位（R 的"最后一句就是返回值"） ────────────────────────────────── */

/**
 * 函数体 → 一串语句，**最后一句变成 `return`**。
 *
 * 往 `if` 的两支里钻，不囫囵包成 `ternary`：`if (n == 0) return(1)` 那种只有一支带值
 * （另一支往下走到后面的语句），包成三元就要求两支都有值 —— 那是一条假的要求。
 * `for` / `while` / 赋值 结尾的函数在 R 里回的是不可见的 `NULL`，那时不补 `return`。
 */
function tailBody(node, types) {
  const list = tag(node) === 'block' ? kids(node) : [node];
  if (list.length === 0) return [];
  const head = list.slice(0, -1).map((k) => stmtOf(k, types));
  return [...head, ...tailOf(list[list.length - 1], types)];
}

/** 尾位上的一格东西 → 一串语句（带 `return` 的那种）。 */
function tailOf(x, types) {
  switch (tag(x)) {
    case 'block': return tailBody(x, types);
    case 'paren': return tailOf(kids(x)[0], types);
    case 'if': {
      const [c, t, e] = kids(x);
      return [{
        kind: 'if',
        cond: condOf(c, types),
        then: tailOf(t, types),
        else_: e === undefined ? null : tailOf(e, types),
      }];
    }
    /* 这几格在 R 里的值是不可见的 NULL —— 不补 `return`，照常当语句。 */
    case 'for': case 'while': case 'repeat': case 'break': case 'next':
      return [stmtOf(x, types)];
    case 'bin': case 'bin-rev':
      if (isAssign(x)) return [stmtOf(x, types)];
      return [{ kind: 'return', values: [exprOf(x, types)] }];
    case 'call': {
      const fnNode = kids(x)[0];
      const fn = tag(fnNode) === 'sym' ? nameOf(fnNode) : null;
      if (fn === 'cat' || fn === 'return') return [stmtOf(x, types)];
      return [{ kind: 'return', values: [exprOf(x, types)] }];
    }
    default:
      return [{ kind: 'return', values: [exprOf(x, types)] }];
  }
}

/* ─── 顶层 ─────────────────────────────────────────────────────────────── */

/**
 * 补出来那格 `let` 的初值。
 *
 * 数与串有零值（公共降级器的 `lower/ty.js` 那张表给），**数组与表没有** ——
 * 那一格必须由这门语言答（`(arr int) 这一格还没有零值` 就是它在报）。
 * R 里"没赋值过的向量"本来也没有意义，所以给一格空的最诚实：后面那句赋值会盖掉它。
 */
function zeroInit(t) {
  /* 向量的零值是**空向量**：开一格槽（就是那个长度），紧跟的 `zeroStmts` 往里写 0。
     `(ptr real)` 在公共层没有零值（`lower/ty.js` 会当场报）—— 这一格必须由这门语言答。 */
  if (isVecTy(t)) return call1('pnew', tyArg(RVEC), { kind: 'int', value: 1 });
  if (t.kind === 'map') return call1('dnew', tyArg(t));
  return null;
}

/** 补出来那格 `let` 之后紧跟的初始化语句（向量要现开一格空的 —— `let` 的初值给不出来）。 */
function zeroStmts(name, t) {
  if (!isVecTy(t)) return [];
  const v = { kind: 'name', name };
  return [{ kind: 'assign', target: { kind: 'deref', expr: v }, value: { kind: 'real', value: 0 } }];
}

/**
 * 那格"数怎么印"的辅助函数，**用到了才发**。
 *
 * R 印 double 有三处特例：`NA` 印 `NA`、`NaN` 印 `NaN`、无穷印 `Inf` / `-Inf`，
 * 剩下的才是 7 位有效数字。这三格判在 C 那侧（`is.na` 对 NaN 也真，所以要先问
 * `is.nan` 才分得开 NA 与 NaN），而"印法"这件事是**每个 cat 都要做一遍**的 ——
 * 所以落成一个函数发一次，而不是在每个调用点摊开一串三元（那样 `.sx` 读不动）。
 */
function numStrDecl() {
  cabiUsed.add('omni_r_is_infinite');
  rmathSig('omni_r_is_infinite');
  const x = { kind: 'name', name: 'x' };
  /* NA / NaN 那两问走按指针的生成函数；无穷那一问没有载荷，按值就行。 */
  const q = (name) => ({ kind: 'call', fn: { kind: 'name', name: useFn(name) }, args: [x] });
  const c = (sym) => b('!=', { kind: 'ccall', sym, args: [x] }, { kind: 'int', value: 0 });
  const ret = (v) => ({ kind: 'return', values: [{ kind: 'string', value: v }] });
  return {
    kind: 'fn',
    name: NUM_STR,
    params: [{ name: 'x', type: REAL }],
    ret: STR,
    body: [
      /* `is.na` 对 NA 与 NaN 都真 —— 先问 `is.nan` 才分得开这两格 */
      {
        kind: 'if',
        cond: q('r_is_na'),
        then: [{ kind: 'if', cond: q('r_is_nan'), then: [ret('NaN')], else_: null }, ret('NA')],
        else_: null,
      },
      {
        kind: 'if',
        cond: c('omni_r_is_infinite'),
        then: [
          {
            kind: 'if',
            cond: b('>', x, { kind: 'real', value: 0 }),
            then: [ret('Inf')],
            else_: null,
          },
          ret('-Inf'),
        ],
        else_: null,
      },
      { kind: 'return', values: [call1('sgen', x, { kind: 'int', value: 7 })] },
    ],
  };
}

/**
 * 那三格**按指针**走的辅助函数（`r_na` / `r_is_na` / `r_is_nan`），用到了才发。
 *
 * 形状都一样：开一格 `(ptr real)` 的一元缓冲，把值写进去（或者让 C 写进去），
 * 再按位读回来。理由在 `PTR_REAL` 那段账上 —— `NA` 的载荷按值过 N-API 会丢。
 */
function naFnDecl(name) {
  const sym = NA_FNS.get(name);
  cabiUsed.add(sym);
  rmathSig(sym);
  const p = { kind: 'name', name: 'p' };
  const alloc = {
    kind: 'let', name: 'p', type: PTR_REAL,
    init: { kind: 'builtin', name: 'pnew', args: [tyArg(PTR_REAL), { kind: 'int', value: 1 }] },
  };
  if (name === 'r_na') {
    return {
      kind: 'fn', name, params: [], ret: REAL,
      body: [
        alloc,
        { kind: 'expr-stmt', expr: { kind: 'ccall', sym, args: [p] } },
        { kind: 'return', values: [{ kind: 'deref', expr: p }] },
      ],
    };
  }
  return {
    kind: 'fn',
    name,
    params: [{ name: 'x', type: REAL }],
    ret: BOOL,
    body: [
      alloc,
      /* 写进线性内存 —— 这一步之后那格值就不再经过装箱了 */
      { kind: 'assign', target: { kind: 'deref', expr: p }, value: { kind: 'name', name: 'x' } },
      {
        kind: 'return',
        values: [b('!=', { kind: 'ccall', sym, args: [p] }, { kind: 'int', value: 0 })],
      },
    ],
  };
}

/**
 * 向量那几格**生成出来的**辅助函数（用到才发）。
 *
 * 为什么是生成的函数而不是在调用点摊开：`sum` / `cat` 这几格都要一个 `while`，摊在调用点上
 * `.sx` 就读不动了（而 `.sx` 是这条路上唯一人能读、能 diff、能进快照的中间产物）。
 * 这与 `ext/go/go-rt.js` 给 go 发运行时是同一条路。
 */
function vecFnDecl(name) {
  const v = { kind: 'name', name: 'v' };
  const i = { kind: 'name', name: 'i' };
  const acc = { kind: 'name', name: 's' };
  /* **长度先存进一格 int**，循环条件读它 —— 不然每转一圈都要 `(toint (pload v))`，
     那是一次内存读 + 一次转换。量出来的（bench/r/run.js，2026-09-25）：
     `vec.R` 上光这一条就是 2.0s → 0.66s。 */
  const len = { kind: 'name', name: 'n' };
  const declLen = (from) => ({ kind: 'let', name: 'n', type: INT, init: vecLen(from ?? v) });
  const elem = vecGet(v, i);
  const loop = (body, from) => ({
    kind: 'for',
    init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: from } },
    cond: b('<', i, len),
    post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
    body,
  });
  const P = [{ name: 'v', type: RVEC }];

  if (name === 'r_sum') {
    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [
        declLen(),
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 0 } },
        loop([{ kind: 'assign', target: acc, value: b('+', acc, elem) }], 0),
        { kind: 'return', values: [acc] },
      ],
    };
  }
  if (name === 'r_mean') {
    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [{
        kind: 'return',
        values: [b('/', { kind: 'call', fn: { kind: 'name', name: 'r_sum' }, args: [v] },
          call1('toreal', vecLen(v)))],
      }],
    };
  }
  if (name === 'r_max' || name === 'r_min') {
    const op = name === 'r_max' ? '>' : '<';
    return {
      kind: 'fn', name, params: P, ret: REAL,
      /* 空向量在 R 里回 `-Inf` / `Inf` 并且**发一句警告**；这一版没有警告那条通道，
         所以空向量这一格当场报（在 `r_sum` 之外唯一与 R 不同的地方，明写在 SPEC）。 */
      body: [
        declLen(),
        { kind: 'let', name: 's', type: REAL, init: vecGet(v, { kind: 'int', value: 0 }) },
        loop([{
          kind: 'if',
          cond: b(op, elem, acc),
          then: [{ kind: 'assign', target: acc, value: elem }],
          else_: null,
        }], 1),
        { kind: 'return', values: [acc] },
      ],
    };
  }
  if (name === 'r_cat_vec') {
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'sep', type: STR }],
      ret: { kind: 'void' },
      body: [declLen(), loop([
        {
          kind: 'if',
          cond: b('>', i, { kind: 'int', value: 0 }),
          then: [{ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'name', name: 'sep' }] }],
          else_: null,
        },
        {
          kind: 'builtin-stmt',
          name: 'write',
          args: [{ kind: 'call', fn: { kind: 'name', name: NUM_STR }, args: [elem] }],
        },
      ], 0)],
    };
  }
  if (name === 'r_rev') {
    /* `rev(xs)` —— 倒着抄一遍。 */
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        loop([vecSet(out, i, vecGet(v, b('-', b('-', len, i), { kind: 'int', value: 1 })))], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_seq_along') {
    /* `seq_along(xs)` 是 `1:length(xs)`（但 `length` 为 0 时 R 回零长向量 —— 见 SPEC）。 */
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        loop([vecSet(out, i, asReal(b('+', i, { kind: 'int', value: 1 }), INT))], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_which') {
    /* `which(m)` —— 为真的那几格的**位置**（从 1 起）。R 里 `NA` 不算（直接丢），
       与 `xs[m]` 不同 —— 那边 `NA` 会挑出一格 `NA`。两趟：先数几格，再填。 */
    const out = { kind: 'name', name: 'o' };
    const k = { kind: 'name', name: 'k' };
    const c = { kind: 'name', name: 'c' };
    const hit = b('&&', { kind: 'unop', op: '!', operand: naQ(vecGet(v, i)) }, b('!=', vecGet(v, i), { kind: 'real', value: 0 }));
    const loopA = (body, init) => ({
      kind: 'for', init, cond: b('<', i, len), post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) }, body,
    });
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
        { kind: 'let', name: 'c', type: INT, init: { kind: 'int', value: 0 } },
        loopA([{ kind: 'if', cond: hit, then: [{ kind: 'assign', target: c, value: b('+', c, { kind: 'int', value: 1 }) }], else_: null }],
          { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        ...vecNewAs('o', c),
        { kind: 'let', name: 'k', type: INT, init: { kind: 'int', value: 0 } },
        loopA([{
          kind: 'if',
          cond: hit,
          then: [
            vecSet(out, k, asReal(b('+', i, { kind: 'int', value: 1 }), INT)),
            { kind: 'assign', target: k, value: b('+', k, { kind: 'int', value: 1 }) },
          ],
          else_: null,
        }], { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_vec_pick') {
    /* `xs[c(1,3)]` —— 按位置挑（下标从 1 起，所以减 1）。结果长度就是下标那个向量的长度。 */
    const ix = { kind: 'name', name: 'ix' };
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'ix', type: RVEC }],
      ret: RVEC,
      body: [
        declLen(ix),
        ...vecNewAs('o', len),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, len),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, vecGet(v, b('-', call1('toint', vecGet(ix, i)), { kind: 'int', value: 1 })))],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_vec_mask') {
    /* `xs[xs > 2]` —— 按逻辑向量挑。掩码短了**从头再来**（R 的回收规则在这儿也管），
       掩码里的 `NA` 在 R 里挑出**一格 NA**（不是"跳过"），所以数与填都把它算上。
       两趟：先数出结果有几格（长度要在 `pnew` 之前知道），再填。 */
    const m = { kind: 'name', name: 'm' };
    const out = { kind: 'name', name: 'o' };
    const k = { kind: 'name', name: 'k' };
    const c = { kind: 'name', name: 'c' };
    const mi = vecGet(m, b('%', i, { kind: 'name', name: 'nm' }));
    const loopV = (body, init) => ({
      kind: 'for',
      init,
      cond: b('<', i, len),
      post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
      body,
    });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'm', type: RVEC }],
      ret: RVEC,
      body: [
        /* 两个长度都先存进 int（循环条件与回收那一格各要读一次）。 */
        declLen(),
        { kind: 'let', name: 'nm', type: INT, init: vecLen(m) },
        /* `i` 在函数体上先声明一次 —— 两趟都用它，摆在 `for` 的 init 里的话第二趟就看不见了。 */
        { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
        { kind: 'let', name: 'c', type: INT, init: { kind: 'int', value: 0 } },
        loopV([{
          kind: 'if',
          cond: b('||', naQ(mi), b('!=', mi, { kind: 'real', value: 0 })),
          then: [{ kind: 'assign', target: c, value: b('+', c, { kind: 'int', value: 1 }) }],
          else_: null,
        }], { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        ...vecNewAs('o', c),
        { kind: 'let', name: 'k', type: INT, init: { kind: 'int', value: 0 } },
        loopV([{
          kind: 'if',
          cond: naQ(mi),
          then: [
            vecSet(out, k, { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] }),
            { kind: 'assign', target: k, value: b('+', k, { kind: 'int', value: 1 }) },
          ],
          else_: [{
            kind: 'if',
            cond: b('!=', mi, { kind: 'real', value: 0 }),
            then: [
              vecSet(out, k, vecGet(v, i)),
              { kind: 'assign', target: k, value: b('+', k, { kind: 'int', value: 1 }) },
            ],
            else_: null,
          }],
        }], { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_cat_lgl') {
    /* 逻辑向量的印法：`TRUE` / `FALSE` / `NA` 三档（存的是 1.0 / 0.0 / NA）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'sep', type: STR }],
      ret: { kind: 'void' },
      body: [declLen(), loop([
        {
          kind: 'if',
          cond: b('>', i, { kind: 'int', value: 0 }),
          then: [{ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'name', name: 'sep' }] }],
          else_: null,
        },
        {
          kind: 'if',
          cond: naQ(elem),
          then: [{ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'string', value: 'NA' }] }],
          else_: [{
            kind: 'builtin-stmt',
            name: 'write',
            args: [{
              kind: 'ternary',
              cond: b('!=', elem, { kind: 'real', value: 0 }),
              then: { kind: 'string', value: 'TRUE' },
              else_: { kind: 'string', value: 'FALSE' },
            }],
          }],
        },
      ], 0)],
    };
  }
  if (name === NUM_STR) return numStrDecl();
  throw new Error(`r->IR: 不认识的辅助函数 ${name}`);
}

/**
 * 按 `FN_DEPS` 把要发的那批函数闭包起来，回**倒序**的名字表
 * （`decls.unshift` 一个一个往前插，所以倒着给才是正序）。
 * 表里没登记的名字当场报 —— 那说明有人加了一格辅助函数却忘了写它依赖谁。
 */
function closeFns(want) {
  const out = new Set();
  const visit = (name) => {
    if (out.has(name)) return;
    const deps = FN_DEPS.get(name);
    if (deps === undefined) throw new Error(`r->IR: 辅助函数 ${name} 没登记在 FN_DEPS 里`);
    out.add(name);
    for (const d of deps) visit(d);
  };
  for (const n of want) visit(n);
  return [...out].sort().reverse();
}

/** 这条语句（或它里头）有没有一格**带值的** `return`。 */function hasValueReturn(s) {
  if (s === null || s === undefined) return false;
  if (s.kind === 'return') return s.values.length > 0;
  for (const k of ['then', 'else_', 'body', 'stmts']) {
    const v = s[k];
    if (Array.isArray(v) && v.some((y) => hasValueReturn(y))) return true;
  }
  if (s.kind === 'for' && (hasValueReturn(s.init) || hasValueReturn(s.post))) return true;
  return false;
}

/** 一格函数（`(fn (formals …) 体)`）→ 标准 IR 的 `fn`。 */
function fnDecl(name, node, types) {
  const formals = kids(node)[0];
  const params = kids(formals).map((f) => mangle(nameOf(kids(f)[0])));
  for (const f of kids(formals)) {
    if (kids(f).length > 1) {
      throw new Error(`r->IR: 形参默认值（${name} 的 ${nameOf(kids(f)[0])}=…）还没接 ——`
        + ' R 里它是一格 promise，在函数体里才求值（见 adapter 文件头第 2 条不足）');
    }
  }
  const body = kids(node)[1];
  const local = inferTypes(body, params);
  const stmts = tailBody(body, local);
  const decls = [];
  for (const [n, t] of local) {
    if (params.includes(n)) continue;
    decls.push({ kind: 'let', name: n, type: t, init: zeroInit(t) });
    decls.push(...zeroStmts(n, t));
  }
  const all = [...decls, ...stmts];
  /* 回什么：拿最后那一格带值的 `return` 里的表达式类型算（`local` 已经推完了）。 */
  const ret = all.some((s) => hasValueReturn(s)) ? returnType(body, local) : { kind: 'void' };
  return {
    kind: 'fn',
    name,
    params: params.map((p) => ({ name: p, type: local.get(p) ?? INT })),
    ret,
    body: all,
  };
}

/** 函数回的是什么：body 里所有"尾位表达式"与 `return(x)` 的类型合起来（串赢）。 */
function returnType(body, types) {
  const seen = [];
  const walkTail = (x) => {
    switch (tag(x)) {
      case 'block': { const ks = kids(x); if (ks.length > 0) walkTail(ks[ks.length - 1]); return; }
      case 'paren': walkTail(kids(x)[0]); return;
      case 'if': { const ks = kids(x); walkTail(ks[1]); if (ks[2] !== undefined) walkTail(ks[2]); return; }
      case 'for': case 'while': case 'repeat': case 'break': case 'next': return;
      case 'bin': case 'bin-rev': if (isAssign(x)) return; seen.push(typeOfExpr(x, types)); return;
      case 'call': {
        const fn = tag(kids(x)[0]) === 'sym' ? nameOf(kids(x)[0]) : null;
        if (fn === 'cat') return;
        seen.push(typeOfCall(x, types));
        return;
      }
      default: seen.push(typeOfExpr(x, types));
    }
  };
  walkTail(body);
  /* `return(x)` 那一族：走遍整棵树把它们也算进来。 */
  const walkAll = (x) => {
    if (!isList(x)) return;
    if (tag(x) === 'call' && tag(kids(x)[0]) === 'sym' && nameOf(kids(x)[0]) === 'return') {
      const vs = posArgs(x);
      if (vs.length > 0) seen.push(typeOfExpr(vs[0], types));
    }
    for (const k of kids(x)) walkAll(k);
  };
  walkAll(body);
  if (seen.length === 0) return INT;
  if (seen.some((t) => t.kind === 'string')) return STR;
  if (seen.some((t) => isVecTy(t) || t.kind === 'map')) return seen.find((t) => isVecTy(t) || t.kind === 'map');
  if (seen.some((t) => t.kind === 'real')) return REAL;
  if (seen.every((t) => t.kind === 'bool')) return BOOL;
  return INT;
}

/**
 * 一棵 R 的 GLR 树（`(program 项…)`）→ 标准 IR 的模块。
 *
 * **函数是值**（文件头第 1 条）：顶层那些 `名字 <- function(…) …` 提升成 `fn`，
 * 别的落进 `main`。提升要先走一遍 —— `main` 里的类型推断会问"这个调用回什么"，
 * 而那要函数表先在（`fact` 递归调自己就是这一格）。
 */
export function rToIR(tree) {
  if (tag(tree) !== 'program') throw new Error('r->IR: 这不是 (program …)');
  tmpN = 0;
  cabiUsed.clear();
  needFn.clear();
  const items = kids(tree);
  const fns = [];
  const rest = [];
  for (const item of items) {
    if (isAssign(item)) {
      const { target, value } = assignParts(item);
      if (tag(target) === 'sym' && tag(value) === 'fn') {
        fns.push({ name: mangle(nameOf(target)), node: value });
        continue;
      }
    }
    rest.push(item);
  }
  const decls = fns.map((f) => fnDecl(f.name, f.node, new Map()));
  /* 顶层剩下的那些：拼成一格假的 `(block …)` 交给同一条推断与同一条降级。 */
  const mainBlock = { kind: 'list', items: [{ kind: 'atom', value: 'block' }, ...rest] };
  const types = inferTypes(mainBlock, []);
  const stmts = rest.map((k) => stmtOf(k, types));
  const lets = [];
  for (const [n, t] of types) {
    lets.push({ kind: 'let', name: n, type: t, init: zeroInit(t) });
    lets.push(...zeroStmts(n, t));
  }
  decls.push({ kind: 'main', body: [...lets, ...stmts] });
  /* 生成出来的辅助函数：**先按 `FN_DEPS` 闭包**，再一次发完（次序与"谁先被点到"无关）。
     摆在 `main` 之前、按名字排 —— 出来的 `.sx` 要能进快照。 */
  for (const name of closeFns(needFn)) {
    decls.unshift(NA_FNS.has(name) ? naFnDecl(name) : vecFnDecl(name));
  }

  /* **自动 FFI 的那几行**（模块头上）。只发这一趟真用到的符号 —— 一份 271 条声明的头
     全发出来的话，`.sx` 会被 271 行 `(cabi …)` 淹掉，而没用到的那些还要求链接期真有它们。
     次序照名字排：出来的 `.sx` 要能进快照，不能随 Map 的插入序变。 */
  const ffi = [];
  if (cabiUsed.size > 0) {
    ffi.push({ kind: 'lib', name: RMATH_LIB });
    for (const sym of [...cabiUsed].sort()) {
      const sig = rmathSig(sym);
      ffi.push({ kind: 'cabi', sym, ret: sig.ret, params: sig.params });
    }
  }
  return { kind: 'module', decls: [...ffi, ...decls] };
}





