// src/core/ir/emit-mlir.js —— **Lua CST → MLIR 文本**（动态值版）
//
// 所有 lua 值是一个 64 位 NaN-boxed `OVal`（= i64）。
// 算术、比较、IO 全部调用 C 运行时（lua-rt.h 里的 omni_val_* 函数）。
// MLIR 层只做控制流和变量绑定，不做类型分派。
//
// 路径：lua CST → 这份 → MLIR（llvm 方言）→ mlir-translate → LLVM IR → clang + lua-rt.o → 可执行

import { tag, kids, leaf, isList } from '../graph/fromtree.js';

const MLIR_PRELUDE = `module {
  llvm.func @omni_val_add(i64, i64) -> i64
  llvm.func @omni_val_sub(i64, i64) -> i64
  llvm.func @omni_val_mul(i64, i64) -> i64
  llvm.func @omni_val_div(i64, i64) -> i64
  llvm.func @omni_val_mod(i64, i64) -> i64
  llvm.func @omni_val_neg(i64) -> i64
  llvm.func @omni_val_not(i64) -> i64
  llvm.func @omni_val_lt(i64, i64) -> i64
  llvm.func @omni_val_le(i64, i64) -> i64
  llvm.func @omni_val_eq(i64, i64) -> i64
  llvm.func @omni_val_concat(i64, i64) -> i64
  llvm.func @omni_val_tostring(i64) -> i64
  llvm.func @omni_val_len(i64) -> i64
  llvm.func @omni_val_truthy(i64) -> i32
  llvm.func @omni_for_cont(i64, i64, i64) -> i32
  llvm.func @omni_val_print(i64) -> ()
  llvm.func @omni_str_new(!llvm.ptr, i32) -> i64
  llvm.func @omni_tab_new() -> i64
  llvm.func @omni_tab_get(i64, i64) -> i64
  llvm.func @omni_tab_set(i64, i64, i64) -> ()
  llvm.func @omni_cell_new(i64) -> !llvm.ptr
  llvm.func @omni_clo_new(!llvm.ptr, i32, i32, !llvm.ptr) -> i64
  llvm.func @omni_clo_fp(i64, i32) -> !llvm.ptr
  llvm.func @omni_clo_env(i64) -> !llvm.ptr
  llvm.func @omni_method_get(i64, i64) -> i64
  llvm.func @omni_setmetatable(i64, i64) -> i64
  llvm.func @omni_getmetatable(i64) -> i64
  llvm.func @omni_extra_set(i32, i64) -> ()
  llvm.func @omni_extra_get(i32) -> i64
  llvm.func @omni_tab_clone(i64) -> i64
  llvm.func @omni_coro_wrap(i64) -> i64
  llvm.func @omni_coro_yield(i64) -> i64
  llvm.func @omni_val_pow(i64, i64) -> i64
  llvm.func @omni_val_write(i64, i32) -> ()
  llvm.func @omni_ipairs(i64) -> i64
  llvm.func @omni_math_sqrt(i64) -> i64
  llvm.func @omni_math_abs(i64) -> i64
  llvm.func @omni_math_sin(i64) -> i64
  llvm.func @omni_math_cos(i64) -> i64
  llvm.func @omni_math_tan(i64) -> i64
  llvm.func @omni_math_exp(i64) -> i64
  llvm.func @omni_math_log(i64) -> i64
  llvm.func @omni_math_floor(i64) -> i64
  llvm.func @omni_math_ceil(i64) -> i64
  llvm.func @omni_math_fmod(i64, i64) -> i64
  llvm.func @omni_math_pow(i64, i64) -> i64
  llvm.func @omni_math_max(i64, i64) -> i64
  llvm.func @omni_math_min(i64, i64) -> i64
  llvm.func @omni_tab_get_ic(i64, i64, i32) -> i64
  llvm.func @omni_tab_get3_ic(i64, i64, i64, i64, i32, !llvm.ptr) -> ()
  llvm.func @omni_tab_set_ic(i64, i64, i64, i32) -> ()
  llvm.func @omni_ic_reserve(i32) -> ()
  llvm.func @omni_tab_new_shaped(!llvm.ptr, !llvm.ptr, !llvm.ptr, i32) -> i64
  llvm.func @omni_tab_new_shaped_meta(!llvm.ptr, !llvm.ptr, !llvm.ptr, i32, i64) -> i64
  llvm.func @omni_mm_slow(i64, i64, i32, i64, !llvm.ptr, !llvm.ptr) -> i64
  llvm.mlir.global external @omni_objs() : !llvm.ptr
  llvm.mlir.global external @omni_ics_p() : !llvm.ptr
  llvm.mlir.global external @omni_shape_gen() : i32
`;

/** 全局内建：名字 → 运行时符号（就这几格，不是一张库函数清单） */
const BUILTIN_CALL = {
  setmetatable: 'omni_setmetatable',
  getmetatable: 'omni_getmetatable',
  tostring: 'omni_val_tostring',
  ipairs: 'omni_ipairs',
};

/** 库里那几格带点的名字 —— 内建（无副作用、一条指令或一次 libm 调用） */
const BUILTIN_DOT = {
  'coroutine.wrap': 'omni_coro_wrap',
  'coroutine.yield': 'omni_coro_yield',
  'math.sqrt': 'omni_math_sqrt',
  'math.abs': 'omni_math_abs',
  'math.sin': 'omni_math_sin',
  'math.cos': 'omni_math_cos',
  'math.tan': 'omni_math_tan',
  'math.exp': 'omni_math_exp',
  'math.log': 'omni_math_log',
  'math.floor': 'omni_math_floor',
  'math.ceil': 'omni_math_ceil',
  'math.fmod': 'omni_math_fmod',
  'math.pow': 'omni_math_pow',
  'math.max': 'omni_math_max',
  'math.min': 'omni_math_min',
};

/** 库里那几格常量（按字面量发，不查表） */
const BUILTIN_FIELD = {
  'math.pi': Math.PI,
  'math.huge': Infinity,
};

/** 回「迭代函数 + 状态 + 控制变量」三样的内建（泛型 for 认得这一格） */
const MULTI_ITER = { ipairs: 3 };

/**
 * **运行时结构的布局**（内联缓存的快路直接发指令，所以要知道偏移量）。
 *
 * 这几个数与 lua-rt.h 末尾的 `_Static_assert` 一一对应 —— 改了那边而没改这边
 * （或反过来）是**编译错误**，不会变成"读错字段"的静默错答案。
 */
const LAYOUT = {
  tabMeta: 32, tabShape: 40, tabSvals: 48,
  icSize: 32, icShape: 0, icMeta: 8, icHolder: 16, icOff: 24, icGen: 28,
};
const TAG_TAB = 0xFFF80007n;

/** 算子元方法的键 → 运行时的 op 编号（与 lua-rt.h 的 OMNI_OP_* 一致） */
const MM_OPS = {
  '__add': { op: 0, bin: '+' }, '__sub': { op: 1, bin: '-' },
  '__mul': { op: 2, bin: '*' }, '__div': { op: 3, bin: '/' },
  '__mod': { op: 4, bin: '%' }, '__pow': { op: 5, bin: '^' },
};

/**
 * **算子元方法的单态化**：整份模块里某个算子只有一处元方法定义时，把它记下来，
 * 算术点上就能发**带守卫的直接调用** —— 直接调用 llvm 才可能内联，
 * 内联了中间那个 Vec 才有机会不落堆。
 *
 * 只收"唯一一处"的：两处以上就说不清该调哪个，照旧走通用路。
 * 守卫见 emitFastBin 的 mm 分支；失效判据是 `omni_shape_gen`（写原型就 +1）。
 */
function scanMetaOps(stmts) {
  const found = new Map();      // '__sub' → { count, obj, body }
  const walk = (x) => {
    if (x === null || x === undefined || !isList(x)) return;
    if (tag(x) === 'fndef') {
      const tgt = kids(x)[0];
      if (tag(tgt) === 'dot' && tag(kids(tgt)[0]) === 'name') {
        const fldName = leaf(kids(tgt)[1]);
        if (MM_OPS[fldName] !== undefined) {
          const e = found.get(fldName);
          if (e === undefined) found.set(fldName, { count: 1, obj: kids(tgt)[0], body: kids(x)[1] });
          else e.count++;
        }
      }
    }
    for (const k of kids(x)) walk(k);
  };
  for (const s of stmts) walk(s);
  const out = new Map();
  for (const [k, v] of found) {
    if (v.count !== 1) continue;
    /* **能不能就地展开**：函数体只有一句 `return <表达式>`、形参正好两个。
       这一档（smallpt 的 `__add`/`__sub`/`__mul`/`__mod` 全是）展开之后，
       建表与字段读会暴露在同一个函数里，llvm 的 SROA 才有机会把那三个
       double 留在寄存器里 —— 这是"不落堆"的前提。
       复杂的函数体不展开：只直连调用，语义一样，少赌一分风险。 */
    const blk = kids(v.body).find(y => tag(y) === 'block');
    const pi = paramInfo(v.body);
    let retExpr = null;
    if (blk && kids(blk).length === 1 && tag(kids(blk)[0]) === 'return'
        && kids(kids(blk)[0]).length === 1 && pi.names.length === 2 && !pi.vararg) {
      retExpr = kids(kids(blk)[0])[0];
    }
    out.set(k, { ...v, retExpr, params: pi.names });
  }
  return out;
}

const MLIR_EPILOGUE = `}\n`;

// NaN-boxing 常量（与 lua-rt.h 一致）
const TAG_NIL   = 0xFFF80001n;
const TAG_FALSE = 0xFFF80002n;
const TAG_TRUE  = 0xFFF80003n;

let _ssa = 0, _bb = 0;
/** 循环出口标签的栈 —— `break` 跳到栈顶那一个 */
let _loopEnds = [];
function ssa() { return `%v${_ssa++}`; }
function bb(p) { return `^${p}${_bb++}`; }
function reset() { _ssa = 0; _bb = 0; _loopEnds = []; }

/**
 * 一个 JS number → NaN-boxed i64 常量。
 *
 * **数只有 double 这一格**（lua-rt.h 头上那一段说了为什么）——
 * 所以这儿一律取 double 的位模式，整数不再走单独的 int tag。
 * 名字留着 `nanboxInt` 是因为调用点都在说"这是个整数字面量"。
 */
function nanboxInt(n) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = n;
  return new BigUint64Array(buf)[0];
}

/**
 * **被函数体引用的顶层局部量**（upvalue 的第一刀）。
 *
 * `local h = {}` 之后 `local function push(v) h[n] = v end` —— `h` 与 `n` 在 main 的
 * 栈帧上（`alloca`），而 `push` 是另一格 `llvm.func`，够不着别人的栈帧。
 * 于是 `heap` / `qsort` / `queens` 三个例子全报 `unbound`。
 *
 * 这一刀的办法：**被引用的顶层局部量改成模块级全局**（`llvm.mlir.global`）。
 * 顶层局部量的寿命与整个程序相同，所以这一步是等价的，而且 lua 的 upvalue 是
 * **按引用**捕获 —— 全局天然就是按引用。
 *
 * 明说的不足：这只解**顶层**那一档。真闭包（`counter()` 每次回一格各自带 `n` 的函数）
 * 要一格环境记录 + 函数值，那是下一刀（`closure` / `hof` 两个例子还在 GAP 上）。
 */
const FN_TAGS = new Set(['fn', 'localfn', 'globalfn', 'fndef']);

/** 一棵子树里出现的全部名字（过近似：内层函数自己的局部量也算进来） */
function namesIn(x, acc = new Set()) {
  if (x === null || x === undefined || !isList(x)) return acc;
  if (tag(x) === 'name') { acc.add(leaf(kids(x)[0])); return acc; }
  for (const k of kids(x)) namesIn(k, acc);
  return acc;
}

function scanCaptured(stmts) {
  const captured = new Set();
  const walk = (x) => {
    if (x === null || x === undefined || !isList(x)) return;
    if (FN_TAGS.has(tag(x))) { namesIn(x, captured); return; }
    for (const k of kids(x)) walk(k);
  };
  for (const s of stmts) walk(s);
  return captured;
}

/**
 * 取一格名字的存储位置 —— 一律回一个 `!llvm.ptr`（指向那格 i64）。
 * 四种绑定形状在这儿收敛成同一种：
 *   * 字符串 = 本帧栈上的 alloca
 *   * `{cell}` = 堆上的格子（被内层函数捕获的局部量）
 *   * `{global}` = 顶层被捕获的量，先 addressof
 *   * `{up:i}` = 闭包的 upvalue，从 upvalue 表里取第 i 格指针
 */
function refOf(env, nm) {
  const b = env.get(nm);
  if (b === undefined) throw new Error(`emit-mlir: unbound '${nm}'`);
  if (typeof b === 'object' && b.cell !== undefined) return { mlir: '', ptr: b.cell };
  if (typeof b === 'object' && b.global === true) {
    const p = ssa();
    return { mlir: `    ${p} = llvm.mlir.addressof @${b.name} : !llvm.ptr\n`, ptr: p };
  }
  if (typeof b === 'object' && b.up !== undefined) {
    const ic = ssa(), slot = ssa(), cell = ssa();
    return {
      mlir: `    ${ic} = llvm.mlir.constant(${b.up} : i32) : i32\n`
          + `    ${slot} = llvm.getelementptr ${env.upPtr}[${ic}] : (!llvm.ptr, i32) -> !llvm.ptr, !llvm.ptr\n`
          + `    ${cell} = llvm.load ${slot} : !llvm.ptr -> !llvm.ptr\n`,
      ptr: cell,
    };
  }
  return { mlir: '', ptr: b };
}

/**
 * 造一格串常量（回 { mlir, val }）。
 *
 * **同一个字面量只造一次**。原来是每处用到都发一次 `omni_str_new` —— `self.x` 在
 * 二十万次循环里就是二十万次 malloc + 拷贝（method 那个例子 150ms 里的大头）。
 * 现在每个字面量一格模块级全局，第一次用到时造好存进去，之后只是一次 load。
 * 判据：热循环的汇编里不该再有 `bl _omni_str_new`。
 */
function emitStr(s) {
  let g = _strCache.get(s);
  if (g === undefined) {
    const k = _strN++;
    const escaped = s.replace(/\\/g, '\\5C').replace(/"/g, '\\22').replace(/\n/g, '\\0A').replace(/\0/g, '\\00');
    _pendingGlobals.push(
      `  llvm.mlir.global internal constant @__str_${k}("${escaped}\\00") {addr_space = 0 : i32}\n`
      + `  llvm.mlir.global internal @__strv_${k}(0 : i64) {addr_space = 0 : i32} : i64\n`);
    g = { data: `@__str_${k}`, slot: `@__strv_${k}`, len: s.length };
    _strCache.set(s, g);
  }
  const gp = ssa(), cur = ssa(), zero = ssa(), isZ = ssa();
  const lMk = bb('mkstr'), lDone = bb('strok');
  let mlir = `    ${gp} = llvm.mlir.addressof ${g.slot} : !llvm.ptr\n`
    + `    ${cur} = llvm.load ${gp} : !llvm.ptr -> i64\n`
    + `    ${zero} = llvm.mlir.constant(0 : i64) : i64\n`
    + `    ${isZ} = llvm.icmp "eq" ${cur}, ${zero} : i64\n`
    + `    llvm.cond_br ${isZ}, ${lMk}, ${lDone}(${cur} : i64)\n`
    + `  ${lMk}:\n`;
  const p = ssa(), ln = ssa(), sv = ssa(), r = ssa();
  mlir += `    ${p} = llvm.mlir.addressof ${g.data} : !llvm.ptr\n`
    + `    ${ln} = llvm.mlir.constant(${g.len} : i32) : i32\n`
    + `    ${sv} = llvm.call @omni_str_new(${p}, ${ln}) : (!llvm.ptr, i32) -> i64\n`
    + `    llvm.store ${sv}, ${gp} : i64, !llvm.ptr\n`
    + `    llvm.br ${lDone}(${sv} : i64)\n`
    + `  ${lDone}(${r}: i64):\n`;
  return { mlir, val: r };
}

/** 调一格**函数值**（闭包）：取 fp + upvalue 表，然后间接 call */
function emitCallVal(fv, argVals) {
  const ac = ssa(), fp = ssa(), ev = ssa(), r = ssa();
  let mlir = `    ${ac} = llvm.mlir.constant(${argVals.length} : i32) : i32\n`
    + `    ${fp} = llvm.call @omni_clo_fp(${fv}, ${ac}) : (i64, i32) -> !llvm.ptr\n`
    + `    ${ev} = llvm.call @omni_clo_env(${fv}) : (i64) -> !llvm.ptr\n`;
  const cargs = [ev, ...argVals].join(', ');
  const ctys = ['!llvm.ptr', ...argVals.map(() => 'i64')].join(', ');
  mlir += `    ${r} = llvm.call ${fp}(${cargs}) : !llvm.ptr, (${ctys}) -> i64\n`;
  return { mlir, val: r };
}

/** 形参表：具名的那些 + 有没有 `...` */
function paramInfo(bodyNode) {
  const params = kids(bodyNode).find(y => tag(y) === 'params');
  const raw = params ? kids(params) : [];
  return {
    names: raw.filter(p => !isList(p)).map(p => leaf(p)),
    vararg: raw.some(p => isList(p) && tag(p) === 'vararg'),
  };
}

/** 变长实参的函数：名字 → 具名形参个数（直接调用点要按这个打包） */
let _vaFuncs = new Map();

function scanVaFuncs(stmts, out) {
  const walk = (x) => {
    if (x === null || x === undefined || !isList(x)) return;
    if (tag(x) === 'localfn' || tag(x) === 'globalfn') {
      const nm = leaf(kids(x)[0]);
      const pi = paramInfo(kids(x)[1]);
      if (pi.vararg) out.set(nm, pi.names.length);
    }
    for (const k of kids(x)) walk(k);
  };
  for (const s of stmts) walk(s);
  return out;
}

/** 造一格表，装下 `vals` 里的值（1..n）—— 变长实参就是这么传的 */
function emitPackTable(vals) {
  const tbl = ssa();
  let mlir = `    ${tbl} = llvm.call @omni_tab_new() : () -> i64\n`;
  vals.forEach((v, i) => {
    const kc = ssa();
    mlir += `    ${kc} = llvm.mlir.constant(${nanboxInt(i + 1)} : i64) : i64\n`
          + `    llvm.call @omni_tab_set(${tbl}, ${kc}, ${v}) : (i64, i64, i64) -> ()\n`;
  });
  return { mlir, val: tbl };
}

/**
 * **全局变量**：`Vec = {}` 这种没有 `local` 的赋值。
 *
 * lua 里它们住在 `_ENV` 那张表里。我们不摆那张表 —— 每个名字落一格模块级全局
 * （`@__g_名字`），读写就是一次 load / store，没有哈希查找。代价是**没有 `_G` 反射**
 * （`_G["Vec"]` 取不着），那一格要的时候再说。
 *
 * 预扫是**过近似**的：所有"裸名字当赋值目标"的地方都算。若同一个名字在某处其实是
 * 局部量，那格局部绑定会在它自己的作用域里盖住这个全局，全局只是没人用。
 */
function scanGlobalAssigned(stmts) {
  const out = new Set();
  const walk = (x) => {
    if (x === null || x === undefined || !isList(x)) return;
    if (tag(x) === 'assign') {
      const tg = kids(x).find(y => tag(y) === 'targets');
      if (tg) for (const t of kids(tg)) if (tag(t) === 'name') out.add(leaf(kids(t)[0]));
    }
    for (const k of kids(x)) walk(k);
  };
  for (const s of stmts) walk(s);
  return out;
}

/**
 * **字段读：把内联缓存的检查发成指令**（v8 的 monomorphic load IC 是这个形状）。
 *
 * **量出来这一版更慢，所以默认不开**（`OMNI_IC_INLINE=1` 才走这条）。
 * 账（smallpt 128×128 16spp，同一次会话、C 基线 ~320ms 做尺子）：
 *   * 发成指令：19.22x C
 *   * 调运行时 `omni_tab_get_ic`：**17.98x C**
 *
 * 为什么发成指令反而亏 —— 想清楚了就不再重复：慢路那一格 `call` 对 LLVM 是**内存屏障**，
 * 于是 `shape` / `gen` / 缓存结构这几次 load **跨不过任何调用**，43 个访问点各自
 * 多背 7 次 load + 30 条指令，I-cache 还变差。v8 赢在它的 IC 是**机器码里 patch 立即数**
 * （命中路径上根本没有"再读一次缓存结构"这件事），那种形状在 LLVM IR 这一层拿不到 ——
 * 要它就得自己发机器码。这段代码留着，就是给"自己发机器码"那一刀当参照。
 */
function emitFieldGet(objVal, keyVal, icId) {
  const L = LAYOUT;
  const lFast = bb('icf'), lHit = bb('ich'), lSlow = bb('ics'), lEnd = bb('ice');
  const hi = ssa(), c32 = ssa(), cTag = ssa(), isTab = ssa();
  let m = `    ${c32} = llvm.mlir.constant(32 : i64) : i64\n`
    + `    ${hi} = llvm.lshr ${objVal}, ${c32} : i64\n`
    + `    ${cTag} = llvm.mlir.constant(${TAG_TAB} : i64) : i64\n`
    + `    ${isTab} = llvm.icmp "eq" ${hi} , ${cTag} : i64\n`
    + `    llvm.cond_br ${isTab}, ${lFast}, ${lSlow}\n`
    + `  ${lFast}:\n`;
  /* 对象指针：omni_objs[payload] */
  const idx = ssa(), objsA = ssa(), objs = ssa(), tpp = ssa(), tp = ssa();
  m += `    ${idx} = llvm.trunc ${objVal} : i64 to i32\n`
    + `    ${objsA} = llvm.mlir.addressof @omni_objs : !llvm.ptr\n`
    + `    ${objs} = llvm.load ${objsA} : !llvm.ptr -> !llvm.ptr\n`
    + `    ${tpp} = llvm.getelementptr ${objs}[${idx}] : (!llvm.ptr, i32) -> !llvm.ptr, !llvm.ptr\n`
    + `    ${tp} = llvm.load ${tpp} : !llvm.ptr -> !llvm.ptr\n`;
  /* 缓存那一格：(*omni_ics_p)[icId] */
  const icpA = ssa(), icb = ssa(), icOff0 = ssa(), icp = ssa();
  m += `    ${icpA} = llvm.mlir.addressof @omni_ics_p : !llvm.ptr\n`
    + `    ${icb} = llvm.load ${icpA} : !llvm.ptr -> !llvm.ptr\n`
    + `    ${icOff0} = llvm.mlir.constant(${icId * L.icSize} : i32) : i32\n`
    + `    ${icp} = llvm.getelementptr ${icb}[${icOff0}] : (!llvm.ptr, i32) -> !llvm.ptr, i8\n`;
  const fld = (base, off, ty) => {
    const p = ssa(), v = ssa();
    const c = ssa();
    return {
      mlir: `    ${c} = llvm.mlir.constant(${off} : i32) : i32\n`
        + `    ${p} = llvm.getelementptr ${base}[${c}] : (!llvm.ptr, i32) -> !llvm.ptr, i8\n`
        + `    ${v} = llvm.load ${p} : !llvm.ptr -> ${ty}\n`,
      val: v,
    };
  };
  const tShape = fld(tp, L.tabShape, '!llvm.ptr');
  const tMeta = fld(tp, L.tabMeta, 'i64');
  const icShape = fld(icp, L.icShape, '!llvm.ptr');
  const icMeta = fld(icp, L.icMeta, 'i64');
  const icHolder = fld(icp, L.icHolder, 'i64');
  const icOffV = fld(icp, L.icOff, 'i32');
  const icGen = fld(icp, L.icGen, 'i32');
  m += tShape.mlir + tMeta.mlir + icShape.mlir + icMeta.mlir + icHolder.mlir + icOffV.mlir + icGen.mlir;
  const genA = ssa(), gen = ssa();
  m += `    ${genA} = llvm.mlir.addressof @omni_shape_gen : !llvm.ptr\n`
    + `    ${gen} = llvm.load ${genA} : !llvm.ptr -> i32\n`;
  const e1 = ssa(), e2 = ssa(), e3 = ssa(), z64 = ssa(), e4 = ssa(), z32 = ssa(), e5 = ssa();
  const a1 = ssa(), a2 = ssa(), a3 = ssa(), a4 = ssa();
  m += `    ${e1} = llvm.icmp "eq" ${tShape.val}, ${icShape.val} : !llvm.ptr\n`
    + `    ${e2} = llvm.icmp "eq" ${tMeta.val}, ${icMeta.val} : i64\n`
    + `    ${e3} = llvm.icmp "eq" ${gen}, ${icGen.val} : i32\n`
    + `    ${z64} = llvm.mlir.constant(0 : i64) : i64\n`
    + `    ${e4} = llvm.icmp "eq" ${icHolder.val}, ${z64} : i64\n`
    + `    ${z32} = llvm.mlir.constant(0 : i32) : i32\n`
    + `    ${e5} = llvm.icmp "sge" ${icOffV.val}, ${z32} : i32\n`
    + `    ${a1} = llvm.and ${e1}, ${e2} : i1\n`
    + `    ${a2} = llvm.and ${a1}, ${e3} : i1\n`
    + `    ${a3} = llvm.and ${a2}, ${e4} : i1\n`
    + `    ${a4} = llvm.and ${a3}, ${e5} : i1\n`
    + `    llvm.cond_br ${a4}, ${lHit}, ${lSlow}\n`
    + `  ${lHit}:\n`;
  const sv = fld(tp, L.tabSvals, '!llvm.ptr');
  const vp = ssa(), hv = ssa();
  m += sv.mlir
    + `    ${vp} = llvm.getelementptr ${sv.val}[${icOffV.val}] : (!llvm.ptr, i32) -> !llvm.ptr, i64\n`
    + `    ${hv} = llvm.load ${vp} : !llvm.ptr -> i64\n`
    + `    llvm.br ${lEnd}(${hv} : i64)\n`
    + `  ${lSlow}:\n`;
  const icC = ssa(), slowV = ssa(), r = ssa();
  m += `    ${icC} = llvm.mlir.constant(${icId} : i32) : i32\n`
    + `    ${slowV} = llvm.call @omni_tab_get_ic(${objVal}, ${keyVal}, ${icC}) : (i64, i64, i32) -> i64\n`
    + `    llvm.br ${lEnd}(${slowV} : i64)\n`
    + `  ${lEnd}(${r}: i64):\n`;
  return { mlir: m, val: r };
}

/**
 * **全是具名字段的表构造**（`{x=_, y=_, z=_}`）⇒ 一次调用搞定：形状在第一次求好之后
 * 缓存在这个构造点的一格全局里，OTab 与字段值一块儿分配，一次 set 都不调。
 * 采样量出来这一格原来占 35%（5 次分配 + 3 次形状迁移 + 3 次 set）。
 *
 * `metaVal` 非 null 时连元表一起装上 —— `setmetatable({…}, X)` 是构造对象最常见的
 * 一句，合成一格能少一次调用。
 */
function emitShapedTable(items, env, metaVal) {
  const names = items.map(it => leaf(kids(it)[0]));
  const vals = items.map(it => emitExpr(kids(it)[1], env));
  const keys = names.map(nm => emitStr(nm));
  const n = items.length;
  const slot = `@__shp_${_shpN++}`;
  _pendingGlobals.push(
    `  llvm.mlir.global internal ${slot}(0 : i64) {addr_space = 0 : i32} : i64\n`);
  const cn = ssa(), ka = ssa(), va = ssa(), sp = ssa(), r = ssa();
  let mlir = keys.map(k => k.mlir).join('') + vals.map(v => v.mlir).join('');
  mlir += `    ${cn} = llvm.mlir.constant(${n} : i32) : i32\n`
    + `    ${ka} = llvm.alloca ${cn} x i64 : (i32) -> !llvm.ptr\n`
    + `    ${va} = llvm.alloca ${cn} x i64 : (i32) -> !llvm.ptr\n`;
  for (let i = 0; i < n; i++) {
    const ic = ssa(), kp = ssa(), vp = ssa();
    mlir += `    ${ic} = llvm.mlir.constant(${i} : i32) : i32\n`
      + `    ${kp} = llvm.getelementptr ${ka}[${ic}] : (!llvm.ptr, i32) -> !llvm.ptr, i64\n`
      + `    llvm.store ${keys[i].val}, ${kp} : i64, !llvm.ptr\n`
      + `    ${vp} = llvm.getelementptr ${va}[${ic}] : (!llvm.ptr, i32) -> !llvm.ptr, i64\n`
      + `    llvm.store ${vals[i].val}, ${vp} : i64, !llvm.ptr\n`;
  }
  mlir += `    ${sp} = llvm.mlir.addressof ${slot} : !llvm.ptr\n`;
  if (metaVal !== null) {
    mlir += `    ${r} = llvm.call @omni_tab_new_shaped_meta(${sp}, ${ka}, ${va}, ${cn}, ${metaVal}) : (!llvm.ptr, !llvm.ptr, !llvm.ptr, i32, i64) -> i64\n`;
  } else {
    mlir += `    ${r} = llvm.call @omni_tab_new_shaped(${sp}, ${ka}, ${va}, ${cn}) : (!llvm.ptr, !llvm.ptr, !llvm.ptr, i32) -> i64\n`;
  }
  return { mlir, val: r };
}

function emitExpr(x, env) {
  const t = tag(x), ch = kids(x);

  if (t === 'fn') return emitClosure(ch[0], env, null);

  if (t === 'num') {
    const v = Number(leaf(ch[0]));
    const r = ssa();
    // 整数与浮点同一种编码：double 的位模式
    const bits = nanboxInt(v);
    return { mlir: `    ${r} = llvm.mlir.constant(${bits} : i64) : i64\n`, val: r };
  }

  if (t === 'nil') {
    const r = ssa();
    const bits = TAG_NIL << 32n;
    return { mlir: `    ${r} = llvm.mlir.constant(${bits} : i64) : i64\n`, val: r };
  }
  if (t === 'true') {
    const r = ssa();
    const bits = TAG_TRUE << 32n;
    return { mlir: `    ${r} = llvm.mlir.constant(${bits} : i64) : i64\n`, val: r };
  }
  if (t === 'false') {
    const r = ssa();
    const bits = TAG_FALSE << 32n;
    return { mlir: `    ${r} = llvm.mlir.constant(${bits} : i64) : i64\n`, val: r };
  }

  if (t === 'name') {
    const nm = leaf(ch[0]);
    const r = ssa();
    const ref = refOf(env, nm);
    return { mlir: ref.mlir + `    ${r} = llvm.load ${ref.ptr} : !llvm.ptr -> i64\n`, val: r };
  }

  if (t === 'paren') return emitExpr(ch[0], env);

  // 字符串字面量 → 一格全局，第一次用到时造（见 emitStr）
  if (t === 'str') return emitStr(leaf(ch[0]));

  // not
  if (t === 'not') {
    const a = emitExpr(ch[0], env);
    const r = ssa();
    return { mlir: a.mlir + `    ${r} = llvm.call @omni_val_not(${a.val}) : (i64) -> i64\n`, val: r };
  }

  // # (len)
  if (t === 'len') {
    const a = emitExpr(ch[0], env);
    const r = ssa();
    return { mlir: a.mlir + `    ${r} = llvm.call @omni_val_len(${a.val}) : (i64) -> i64\n`, val: r };
  }

  if (t === 'neg') {
    const a = emitExpr(ch[0], env);
    const r = ssa();
    return { mlir: a.mlir + `    ${r} = llvm.call @omni_val_neg(${a.val}) : (i64) -> i64\n`, val: r };
  }

  if (t === 'bin') {
    const op = leaf(ch[0]);

    /* **and / or 是短路的，而且回的是值不是布尔**（lua 的语义）。
       所以右边必须在自己的块里求值 —— 不能像别的算子那样先把两边都发出来。
       合流用块参数（与 emitFastBin 同一个写法）。 */
    if (op === 'and' || op === 'or') {
      const a = emitExpr(ch[1], env);
      const tr = emitTruthy(a.val);
      const lRhs = bb('sc'), lEnd = bb('scend');
      let mlir = a.mlir + tr.mlir;
      mlir += op === 'and'
        ? `    llvm.cond_br ${tr.val}, ${lRhs}, ${lEnd}(${a.val} : i64)\n`
        : `    llvm.cond_br ${tr.val}, ${lEnd}(${a.val} : i64), ${lRhs}\n`;
      mlir += `  ${lRhs}:\n`;
      const b = emitExpr(ch[2], env);
      mlir += b.mlir + `    llvm.br ${lEnd}(${b.val} : i64)\n`;
      const r = ssa();
      mlir += `  ${lEnd}(${r}: i64):\n`;
      return { mlir, val: r };
    }

    const a = emitExpr(ch[1], env);
    const b = emitExpr(ch[2], env);
    const FN = {
      '+': 'omni_val_add', '-': 'omni_val_sub', '*': 'omni_val_mul',
      '/': 'omni_val_div', '%': 'omni_val_mod', '..': 'omni_val_concat',
      '<': 'omni_val_lt', '<=': 'omni_val_le', '==': 'omni_val_eq',
      '^': 'omni_val_pow',
    };

    /* **快路那一族**：+ - * 与六格比较。热循环里因此没有 call（见 emitFastBin）。
       慢路的写法各不相同：`>` 用 `lt(b,a)`、`>=` 用 `le(b,a)`、`~=` 用 `not(eq(a,b))` ——
       这三格在快路里是**直接的**（sgt / sge / ne），只有慢路要换算。 */
    const SLOW = {
      '+':  { fn: 'omni_val_add' },
      '-':  { fn: 'omni_val_sub' },
      '*':  { fn: 'omni_val_mul' },
      '<':  { fn: 'omni_val_lt' },
      '<=': { fn: 'omni_val_le' },
      '==': { fn: 'omni_val_eq' },
      '>':  { fn: 'omni_val_lt', swap: true },
      '>=': { fn: 'omni_val_le', swap: true },
      '~=': { fn: 'omni_val_eq', negate: true },
    };
    if (SLOW[op] !== undefined) {
      /* 两边静态已知是数 ⇒ 只发快路（`env.nums` 是 scanNumLocals 预扫的结果） */
      const known = isNumExpr(ch[1], env.nums ?? new Set())
                 && isNumExpr(ch[2], env.nums ?? new Set());
      const mmKey = Object.keys(MM_OPS).find(k => MM_OPS[k].bin === op);
      const mmSite = mmKey !== undefined ? _mmEmitted.get(mmKey) : undefined;
      const f = emitFastBin(op, a.val, b.val,
        mmSite !== undefined ? { ...SLOW[op], mm: mmSite } : SLOW[op], known);
      return { mlir: a.mlir + b.mlir + f.mlir, val: f.val };
    }

    // 剩下的（/ % ..）没有整数快路：除法与串接的语义都在运行时
    const r = ssa();
    const fn = FN[op];
    if (!fn) throw new Error(`emit-mlir: unsupported binop '${op}'`);
    return { mlir: a.mlir + b.mlir
      + `    ${r} = llvm.call @${fn}(${a.val}, ${b.val}) : (i64, i64) -> i64\n`, val: r };
  }

  // 表构造 { items... } / { key=val, ... }
  if (t === 'table') {
    const items = ch;
    /* `{...}` 就是"把变长实参抄成一张表" —— 变长实参本来就是按表传的 */
    if (items.length === 1 && tag(items[0]) === 'item' && tag(kids(items[0])[0]) === 'vararg') {
      if (env.vaVal === undefined) throw new Error('emit-mlir: `...` 用在非变长函数里');
      const r = ssa();
      return { mlir: `    ${r} = llvm.call @omni_tab_clone(${env.vaVal}) : (i64) -> i64\n`, val: r };
    }
    /* **全是具名字段的构造**（`{x=_, y=_, z=_}`）⇒ 一次调用搞定：形状在第一次求好之后
       缓存在这个调用点的一格全局里，OTab 与字段值一块儿分配，一次 set 都不调。
       采样量出来这一格原来占 35%（5 次分配 + 3 次形状迁移 + 3 次 set）。 */
    if (items.length > 0 && items.every(it => tag(it) === 'named')) {
      return emitShapedTable(items, env, null);
    }
    const tbl = ssa();
    let mlir = `    ${tbl} = llvm.call @omni_tab_new() : () -> i64\n`;
    let idx = 1;
    for (const item of items) {
      if (tag(item) === 'named') {
        // { key = val }
        const [k, v] = kids(item);
        const kE = emitStr(leaf(k));
        const vE = emitExpr(v, env);
        mlir += kE.mlir + vE.mlir;
        mlir += `    llvm.call @omni_tab_set(${tbl}, ${kE.val}, ${vE.val}) : (i64, i64, i64) -> ()\n`;
      } else if (tag(item) === 'item') {
        // { val1, val2, ... } — 数组部分，从 1 起
        const vE = emitExpr(kids(item)[0], env);
        const kBits = nanboxInt(idx++);
        const kV = ssa();
        mlir += vE.mlir;
        mlir += `    ${kV} = llvm.mlir.constant(${kBits} : i64) : i64\n`;
        mlir += `    llvm.call @omni_tab_set(${tbl}, ${kV}, ${vE.val}) : (i64, i64, i64) -> ()\n`;
      }
    }
    return { mlir, val: tbl };
  }

  // t[k] → omni_tab_get(t, k)
  if (t === 'index') {
    const [obj, key] = ch;
    const o = emitExpr(obj, env);
    const k = emitExpr(key, env);
    const r = ssa();
    return { mlir: o.mlir + k.mlir
      + `    ${r} = llvm.call @omni_tab_get(${o.val}, ${k.val}) : (i64, i64) -> i64\n`, val: r };
  }

  // t.field → omni_tab_get(t, str_key)
  if (t === 'dot') {
    const [obj, fld] = ch;
    /* `math.pi` 这一族是常量，直接发字面量（不查表） */
    if (tag(obj) === 'name' && env.get(leaf(kids(obj)[0])) === undefined) {
      const key = `${leaf(kids(obj)[0])}.${leaf(fld)}`;
      if (BUILTIN_FIELD[key] !== undefined) {
        const r = ssa();
        return { mlir: `    ${r} = llvm.mlir.constant(${nanboxInt(BUILTIN_FIELD[key])} : i64) : i64\n`, val: r };
      }
    }
    /* 这一格已经被 emitFusedPrefix 一块儿读出来了（同一张表的前三个键） */
    if (_fused !== null && tag(obj) === 'name') {
      const hit = _fused.get(`${leaf(kids(obj)[0])}|${leaf(fld)}`);
      if (hit !== undefined) return { mlir: '', val: hit };
    }
    const o = emitExpr(obj, env);
    const k = emitStr(leaf(fld));
    /* **默认走运行时那一版**（量出来更快 6.5%，见 emitFieldGet 头上的账）。
       `OMNI_IC_INLINE=1` 打开"把缓存检查发成指令"那一版，留着是为了能随时复量。 */
    if (process.env.OMNI_IC_INLINE === '1') {
      const g = emitFieldGet(o.val, k.val, _icN++);
      return { mlir: o.mlir + k.mlir + g.mlir, val: g.val };
    }
    const r = ssa(), ic = ssa();
    return { mlir: o.mlir + k.mlir
      + `    ${ic} = llvm.mlir.constant(${_icN++} : i32) : i32\n`
      + `    ${r} = llvm.call @omni_tab_get_ic(${o.val}, ${k.val}, ${ic}) : (i64, i64, i32) -> i64\n`,
      val: r };
  }

  // 方法调用 obj:m(args) —— 查一格方法（顺 __index / 串的方法表），然后间接 call
  if (t === 'mcall') {
    const obj = ch[0], mname = leaf(ch[1]), args = ch[2];
    const o = emitExpr(obj, env);
    const k = emitStr(mname);
    const m = ssa(), ic = ssa();
    let mlir = o.mlir + k.mlir
      + `    ${ic} = llvm.mlir.constant(${_icN++} : i32) : i32\n`
      + `    ${m} = llvm.call @omni_tab_get_ic(${o.val}, ${k.val}, ${ic}) : (i64, i64, i32) -> i64\n`;
    const parts = (args ? kids(args) : []).map(a => emitExpr(a, env));
    mlir += parts.map(p => p.mlir).join('');
    const c = emitCallVal(m, [o.val, ...parts.map(p => p.val)]);   // self 是第一个实参
    return { mlir: mlir + c.mlir, val: c.val };
  }

  // 函数调用表达式
  if (t === 'call') {
    const fn = ch[0], args = ch[1];
    const argList = args ? kids(args) : [];
    if (tag(fn) === 'name') {
      const fname = leaf(kids(fn)[0]);
      const parts = argList.map(a => emitExpr(a, env));
      let mlir = parts.map(p => p.mlir).join('');
      const b = env.get(fname);
      const r = ssa();
      const argStr = parts.map(p => p.val).join(', ');
      if (b === undefined && BUILTIN_CALL[fname] !== undefined) {
        /* `setmetatable({…}, X)` —— 构造对象最常见的一句，合成一格（见 emitShapedTable） */
        if (fname === 'setmetatable' && argList.length === 2
            && tag(argList[0]) === 'table' && kids(argList[0]).length > 0
            && kids(argList[0]).every(it => tag(it) === 'named')) {
          const mv = emitExpr(argList[1], env);
          const st = emitShapedTable(kids(argList[0]), env, mv.val);
          return { mlir: mv.mlir + st.mlir, val: st.val };
        }
        const tyStr = parts.map(() => 'i64').join(', ');
        mlir += `    ${r} = llvm.call @${BUILTIN_CALL[fname]}(${argStr}) : (${tyStr}) -> i64\n`;
        return { mlir, val: r };
      }
      const direct = b === undefined || (typeof b === 'string' && b.startsWith('@'));
      if (direct) {
        /* 顶层具名函数：模块级符号，直接 call —— 没有间接那一跳 */
        let vals = parts.map(p => p.val);
        if (_vaFuncs.has(fname)) {
          /* **变长实参**：具名形参照传，多出来的打成一张表当最后一格实参。
             调用点知道被调方是不是变长（它就在同一份源码里），所以这一层是静态的。 */
          const fixed = _vaFuncs.get(fname);
          const pack = emitPackTable(vals.slice(fixed));
          mlir += pack.mlir;
          vals = [...vals.slice(0, fixed), pack.val];
        }
        const tyStr = vals.map(() => 'i64').join(', ');
        mlir += `    ${r} = llvm.call @${fname}(${vals.join(', ')}) : (${tyStr}) -> i64\n`;
        return { mlir, val: r };
      }
      /* 名字里装的是一格**函数值**（闭包）⇒ 间接调用。
         实参个数由 omni_clo_fp 在运行期核对 —— 不符就报错退出，不静默补 nil。 */
      const ref = refOf(env, fname);
      const fv = ssa();
      mlir += ref.mlir + `    ${fv} = llvm.load ${ref.ptr} : !llvm.ptr -> i64\n`;
      const c = emitCallVal(fv, parts.map(p => p.val));
      return { mlir: mlir + c.mlir, val: c.val };
    }
    /* 被调的是个表达式（`Point.new(…)` / `t[i](…)`）⇒ 求出那格函数值再间接调用 */
    if (tag(fn) === 'dot' && tag(kids(fn)[0]) === 'name') {
      const libName = `${leaf(kids(kids(fn)[0])[0])}.${leaf(kids(fn)[1])}`;
      if (env.get(leaf(kids(kids(fn)[0])[0])) === undefined && BUILTIN_DOT[libName] !== undefined) {
        const parts = argList.map(a => emitExpr(a, env));
        const r = ssa();
        const tyStr = parts.map(() => 'i64').join(', ');
        return {
          mlir: parts.map(p => p.mlir).join('')
            + `    ${r} = llvm.call @${BUILTIN_DOT[libName]}(${parts.map(p => p.val).join(', ')}) : (${tyStr}) -> i64\n`,
          val: r,
        };
      }
    }
    const fe = emitExpr(fn, env);
    const parts = argList.map(a => emitExpr(a, env));
    const c = emitCallVal(fe.val, parts.map(p => p.val));
    return { mlir: fe.mlir + parts.map(p => p.mlir).join('') + c.mlir, val: c.val };
  }

  throw new Error(`emit-mlir: unsupported expr '${t}'`);
}

function emitAlloca(env) {
  const sz = ssa(), ptr = ssa();
  return {
    mlir: `    ${sz} = llvm.mlir.constant(1 : i32) : i32\n`
        + `    ${ptr} = llvm.alloca ${sz} x i64 : (i32) -> !llvm.ptr\n`,
    ptr
  };
}

/* ---- 同一张表的多个字段读合成一次调用 ----
 *
 * 采样（smallpt 192×192，AOT 腿）里 `omni_tab_get_ic` 自占 29%，而热点的形状是
 * `Vec.new(a.x + b.x, a.y + b.y, a.z + b.z)`：同一张表连读三个键 ⇒ 同一个形状检查
 * 做三遍、调用发三次。把一张表的前三个键合成一次 `omni_tab_get3_ic`（见 lua-rt.h）。
 *
 * **凭什么能提**：Lua 不规定同一个表达式里子表达式的求值次序，所以同一个表达式内部
 * 把几个读挪到一块儿是合法的。**不许跨 and/or 提**（那边有短路，提了会读到本不该读的
 * 字段、跑到本不该跑的 __index），**也不进闭包**（闭包另发一个 llvm.func，SSA 不在作用域里）。
 */
let _fused = null;      // Map<'base|key', ssa 值>；null = 这一段不做合并

/* 取值要有个落脚处（get3 用出参回三格）。**这一格 alloca 必须在函数入口**，
   不能就地发：合并点常在循环体里，就地 alloca 每轮抬一次栈 ——
   96×96 那一档踩过一次 SIGSEGV（栈涨到 8MB）。
   所以懒建一格、整函数共用，最后塞回函数体开头。 */
let _scratchPtr = null, _scratchDef = '';

function scratch3() {
  if (_scratchPtr === null) {
    const sz = ssa(), p = ssa();
    _scratchDef = `    ${sz} = llvm.mlir.constant(3 : i32) : i32\n`
                + `    ${p} = llvm.alloca ${sz} x i64 : (i32) -> !llvm.ptr\n`;
    _scratchPtr = p;
  }
  return _scratchPtr;
}

/** 进一个新函数体：暂存槽要重开一格（返回的东西给 fnScratchEnd） */
function fnScratchBegin() {
  const saved = { ptr: _scratchPtr, def: _scratchDef };
  _scratchPtr = null; _scratchDef = '';
  return saved;
}

/** 出函数体：把入口那格 alloca 塞到最前面，再把外层的恢复回去 */
function fnScratchEnd(saved, body) {
  const out = _scratchDef + body;
  _scratchPtr = saved.ptr; _scratchDef = saved.def;
  return out;
}

function scanFieldGroups(x, env, out) {
  if (x === null || x === undefined || !isList(x)) return out;
  const t = tag(x);
  if (t === 'fn') return out;                                   // 闭包另发一个函数
  if (t === 'bin' && (leaf(kids(x)[0]) === 'and' || leaf(kids(x)[0]) === 'or')) return out;   // 短路
  if (t === 'dot' && tag(kids(x)[0]) === 'name') {
    const node = kids(x)[0];
    const base = leaf(kids(node)[0]);
    if (env.get(base) !== undefined) {         // 只认局部量/形参：全局还要多一跳，形状也不定
      const key = leaf(kids(x)[1]);
      let g = out.get(base);
      if (g === undefined) { g = { node, keys: [] }; out.set(base, g); }
      if (!g.keys.includes(key)) g.keys.push(key);
    }
  }
  for (const k of kids(x)) scanFieldGroups(k, env, out);
  return out;
}

/** 一条语句的表达式开头：把够三个键的组各发一次 get3，结果记进 _fused */
function emitFusedPrefix(exprs, env) {
  const groups = new Map();
  for (const e of exprs) scanFieldGroups(e, env, groups);
  let mlir = '';
  const memo = new Map();
  for (const [base, g] of groups) {
    if (g.keys.length < 3) continue;
    const ks = g.keys.slice(0, 3);
    const o = emitExpr(g.node, env);
    const kv = ks.map(k => emitStr(k));
    const id = _icN; _icN += 3;
    const buf = scratch3(), idC = ssa();
    mlir += o.mlir + kv.map(k => k.mlir).join('')
      + `    ${idC} = llvm.mlir.constant(${id} : i32) : i32\n`
      + `    llvm.call @omni_tab_get3_ic(${o.val}, ${kv[0].val}, ${kv[1].val}, ${kv[2].val}, ${idC}, ${buf})`
      + ` : (i64, i64, i64, i64, i32, !llvm.ptr) -> ()\n`;
    for (let i = 0; i < 3; i++) {
      const gep = ssa(), ld = ssa();
      mlir += `    ${gep} = llvm.getelementptr ${buf}[${i}] : (!llvm.ptr) -> !llvm.ptr, i64\n`
            + `    ${ld} = llvm.load ${gep} : !llvm.ptr -> i64\n`;
      memo.set(`${base}|${ks[i]}`, ld);
    }
  }
  return { mlir, memo };
}

/** 一段 MLIR 文本已经以终结符结尾了吗（终结符之后不许再发指令） */
function endsTerminated(s) {
  const lines = s.trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? '';
  return /llvm\.(return|br|cond_br|unreachable)\b/.test(last);
}

/**
 * 真值判断 —— **在这一层直接比位模式，不调运行时**。
 *
 * lua 的规矩只有一条：只有 `nil` 与 `false` 为假。这两个值的位模式是**常量**
 * （`TAG_NIL<<32` 与 `TAG_FALSE<<32`），所以"真不真"是两条 `icmp` + 一条 `and` ——
 * 不需要跨模块调一次 `omni_val_truthy`。
 *
 * 这一刀是汇编逼出来的：fib 里每次调用都有一个纯粹为了"把 OVal 变成 i1"的 `bl`，
 * 而那一跳什么都没算（`omni_val_lt` 交出来的已经是 true/false 了）。
 */
function emitTruthy(valSSA) {
  const nilBits = TAG_NIL << 32n;
  const falseBits = TAG_FALSE << 32n;
  const cNil = ssa(), cFalse = ssa(), neNil = ssa(), neFalse = ssa(), r = ssa();
  return {
    mlir: `    ${cNil} = llvm.mlir.constant(${nilBits} : i64) : i64\n`
        + `    ${cFalse} = llvm.mlir.constant(${falseBits} : i64) : i64\n`
        + `    ${neNil} = llvm.icmp "ne" ${valSSA}, ${cNil} : i64\n`
        + `    ${neFalse} = llvm.icmp "ne" ${valSSA}, ${cFalse} : i64\n`
        + `    ${r} = llvm.and ${neNil}, ${neFalse} : i1\n`,
    val: r,
  };
}

/** 发一个块的语句串；若已终结就不补 br */
function emitBlockBody(block, env) {
  let mlir = '';
  if (block) for (const s of kids(block)) mlir += emitStmt(s, env);
  return mlir;
}

/**
 * **算术/比较的快路**（这一刀是汇编 + 基准逼出来的，见 ADR-0043 §5）。
 *
 * 动态语言的代价在于"每个算子都要先问类型"。三种做法：
 *   * mojo：静态类型，问都不问 —— 直接发 `llvm.fadd`
 *   * luajit：trace JIT，跑热了再特化 —— 运行期猜一次，猜错回退
 *   * 这一份：**发两条路**，运行期一次 tag 检查选一条 —— 编译期不猜，热路径没有 call
 *
 * 形状：**两边都是数（double）⇒ 一条 `fadd`**；不是数才调运行时（元表 / 串接那一族）。
 *
 * 原来这儿判的是"两边都是 int tag"，那一版量出来是错的：`1..1e7` 求和到 5e13，
 * 32 位 payload 装不下，于是**每一轮都溢出、每一轮都掉进慢路**（61ms 里 53ms
 * 是这么来的）。数只有 double 之后没有溢出这回事 —— 见 lua-rt.h 头上那一段。
 *
 * 判据不是"开关收下了"，是**汇编里热循环内还有没有 `bl _omni_val_*`**。
 */
const TAG_FIRST = 0xFFF80001n;       // 高 32 位 >= 这个值就不是数

/** 两个 OVal 都是数（double）吗 —— 回 { mlir, val(i1) } */
function emitBothNum(aVal, bVal) {
  const c32 = ssa(), aHi = ssa(), bHi = ssa(), cT = ssa(), aIs = ssa(), bIs = ssa(), both = ssa();
  return {
    mlir: `    ${c32} = llvm.mlir.constant(32 : i64) : i64\n`
        + `    ${aHi} = llvm.lshr ${aVal}, ${c32} : i64\n`
        + `    ${bHi} = llvm.lshr ${bVal}, ${c32} : i64\n`
        + `    ${cT} = llvm.mlir.constant(${TAG_FIRST} : i64) : i64\n`
        + `    ${aIs} = llvm.icmp "ult" ${aHi}, ${cT} : i64\n`
        + `    ${bIs} = llvm.icmp "ult" ${bHi}, ${cT} : i64\n`
        + `    ${both} = llvm.and ${aIs}, ${bIs} : i1\n`,
    val: both,
  };
}

/** OVal → double（位模式重解释，零指令） */
function emitToDouble(v) {
  const d = ssa();
  return { mlir: `    ${d} = llvm.bitcast ${v} : i64 to f64\n`, val: d };
}

/** double → OVal（位模式重解释，零指令） */
function emitFromDouble(d) {
  const r = ssa();
  return { mlir: `    ${r} = llvm.bitcast ${d} : f64 to i64\n`, val: r };
}

/** 浮点算术那几格 */
const FAST_ARITH = { '+': 'fadd', '-': 'fsub', '*': 'fmul', '/': 'fdiv' };
/** 浮点比较那几格（llvm 的 fcmp 谓词） */
const FAST_CMP = { '<': 'olt', '<=': 'ole', '>': 'ogt', '>=': 'oge', '==': 'oeq', '~=': 'one' };

/**
 * **静态"一定是数"的判据**（类型覆盖层的第一刀，task #40 那一格）。
 *
 * 快路的 tag 检查在**两边都已知是数**时是死码 —— 慢路永远不会走。
 * 于是那一格检查（5 条指令 + 一次分支）可以整个删掉，只留一条 `fadd`。
 *
 * 判据是**语法上的**，不做数据流不动点：
 *   * 数字面量、`-字面量`、括号里的数
 *   * 两个"一定是数"做 + - * /（快路的结果一定是 double）
 *   * `#x`（长度一定是数）
 *   * 名字：`numNames` 里的（由 `scanNumLocals` 预扫一遍填好）
 *
 * 不做不动点是刻意的：不动点要迭代到稳定，而这一层的收益集中在
 * "初值是数、之后只被数赋值"这一种最常见的形状上。判不出来就退回带检查的快路，
 * **答案一样，只是慢一点** —— 这条性质让这一刀可以逐步加强而不必一次做对。
 */
function isNumExpr(x, numNames) {
  if (x === undefined || x === null) return false;
  const t = tag(x);
  if (t === 'num') return true;
  if (t === 'paren') return isNumExpr(kids(x)[0], numNames);
  if (t === 'neg') return isNumExpr(kids(x)[0], numNames);
  if (t === 'len') return true;
  if (t === 'name') return numNames.has(leaf(kids(x)[0]));
  if (t === 'call') {
    /* 调了一格"返回值一定是数"的函数（`_retNum` 由 scanNumFuncs 填） */
    const fn = kids(x)[0];
    return fn && tag(fn) === 'name' && _retNum.has(leaf(kids(fn)[0]));
  }
  if (t === 'bin') {
    const op = leaf(kids(x)[0]);
    if (FAST_ARITH[op] === undefined) return false;      // 比较出的是布尔，不是数
    return isNumExpr(kids(x)[1], numNames) && isNumExpr(kids(x)[2], numNames);
  }
  return false;
}

/**
 * **函数形参与返回值的"一定是数"**（类型覆盖层第二刀）。
 *
 * 第一刀只看局部量，所以 `fib(n)` 里的 `n` 是形参 —— 看不出来，每次 `n<2` / `n-1`
 * 都得发一次 tag 检查。这一刀补上跨函数的那一半，办法是**乐观不动点**：
 *
 *   1. 先假设每个形参、每个返回值都是数；
 *   2. 拿这个假设去查每一处调用点的实参、每一处 `return` 的表达式；
 *   3. 有一处不是数就划掉，重新来一遍；
 *   4. 不再变化就停 —— 剩下的就是真的。
 *
 * 为什么必须乐观：`fib` 的实参是 `n-1`，而 `n` 是它自己的形参 —— 悲观（先假设不是数）
 * 永远推不出来，递归那一族全都判不出。乐观 + 划掉是标准做法（Hindley-Milner 的
 * occurs check 之外那一半，也是 V8 的 feedback 在静态侧的对应物）。
 *
 * 判不出来的代价仍然只是**多发一次检查**，答案不变 —— 与第一刀同一条性质。
 */
function scanNumFuncs(stmts) {
  /** fnName → { params: string[], body: stmts, retExprs: exprs[] } */
  const fns = new Map();
  /** fnName → 实参表达式的列表（每处调用一项） */
  const calls = new Map();

  const collectRet = (list, acc) => {
    for (const s of list) {
      const t = tag(s);
      if (t === 'return') { const e = kids(s)[0]; acc.push(e ?? null); }
      else if (t === 'block') collectRet(kids(s), acc);
      else for (const k of kids(s)) {
        if (k && k.kind === 'list' && (tag(k) === 'block' || tag(k) === 'elseifs' || tag(k) === 'else')) {
          if (tag(k) === 'block') collectRet(kids(k), acc);
          else for (const e of kids(k)) {
            const eb = tag(k) === 'else' ? e : kids(e)[1];
            if (eb && tag(eb) === 'block') collectRet(kids(eb), acc);
          }
        }
      }
    }
  };
  const collectCalls = (x) => {
    if (x === null || x === undefined || x.kind !== 'list') return;
    if (tag(x) === 'call') {
      const fn = kids(x)[0], args = kids(x)[1];
      if (fn && tag(fn) === 'name') {
        const nm = leaf(kids(fn)[0]);
        if (!calls.has(nm)) calls.set(nm, []);
        calls.get(nm).push(args ? kids(args) : []);
      }
    }
    for (const k of kids(x)) collectCalls(k);
  };
  const walk = (list) => {
    for (const s of list) {
      if (tag(s) === 'localfn' || tag(s) === 'globalfn') {
        const nm = leaf(kids(s)[0]);
        const bodyNode = kids(s)[1];
        const params = kids(bodyNode).find((y) => tag(y) === 'params');
        const blk = kids(bodyNode).find((y) => tag(y) === 'block');
        const rets = [];
        if (blk) collectRet(kids(blk), rets);
        fns.set(nm, { params: paramInfo(bodyNode).names, block: blk, rets });
        if (blk) walk(kids(blk));
      }
      collectCalls(s);
      for (const k of kids(s)) {
        if (k && k.kind === 'list' && tag(k) === 'block') walk(kids(k));
      }
    }
  };
  walk(stmts);

  // ---- 乐观不动点 ----
  const paramNum = new Map();   // fnName → Set(形参名)
  const retNum = new Set();     // 返回值一定是数的函数名
  for (const [nm, f] of fns) { paramNum.set(nm, new Set(f.params)); retNum.add(nm); }

  /** 当前假设下，这格表达式是数吗（`nums` 之外还认得"调了返回数的函数"） */
  const numUnder = (x, nums) => {
    if (x === undefined || x === null) return false;
    const t = tag(x);
    if (t === 'call') {
      const fn = kids(x)[0];
      return fn && tag(fn) === 'name' && retNum.has(leaf(kids(fn)[0]));
    }
    if (t === 'bin') {
      const op = leaf(kids(x)[0]);
      if (FAST_ARITH[op] === undefined) return false;
      return numUnder(kids(x)[1], nums) && numUnder(kids(x)[2], nums);
    }
    if (t === 'paren' || t === 'neg') return numUnder(kids(x)[0], nums);
    if (t === 'num' || t === 'len') return true;
    if (t === 'name') return nums.has(leaf(kids(x)[0]));
    return false;
  };

  for (let round = 0; round < 8; round++) {
    let changed = false;
    // 形参：每一处调用点的对应实参都得是数
    for (const [nm, f] of fns) {
      const mine = paramNum.get(nm);
      const sites = calls.get(nm) ?? [];
      for (let i = 0; i < f.params.length; i++) {
        const p = f.params[i];
        if (!mine.has(p)) continue;
        for (const site of sites) {
          // 实参在**调用者**的作用域里判；这一刀只认"数字面量 / 形参 / 它们的算术"
          const callerNums = new Set([...mine, ...scanNumLocals(f.block ? kids(f.block) : [])]);
          if (!numUnder(site[i], callerNums)) { mine.delete(p); changed = true; break; }
        }
      }
    }
    // 返回值：每一处 return 的表达式都得是数
    for (const [nm, f] of fns) {
      if (!retNum.has(nm)) continue;
      const nums = new Set([...(paramNum.get(nm) ?? []),
        ...scanNumLocals(f.block ? kids(f.block) : [])]);
      for (const r of f.rets) {
        if (r === null || !numUnder(r, nums)) { retNum.delete(nm); changed = true; break; }
      }
    }
    if (!changed) break;
  }
  return { paramNum, retNum };
}

/**
 * 预扫一个块：哪些局部量**一直是数**。
 *
 * 规矩两条（保守，判不出来就不算）：
 *   1. `local x = <数>` 立一格候选；
 *   2. 整个块里对它的每一次 `x = …` 右边也得是数，否则划掉。
 * 数值 for 的循环变量：上界与步长都是字面量时也算（那一格由发射器自己保证）。
 *
 * 这一趟只看**当前块**（不下钻函数体）：跨函数的类型要真的类型层，不是这一刀。
 */
function scanNumLocals(stmts) {
  const cand = new Set();
  const killed = new Set();
  const walk = (list) => {
    for (const s of list) {
      const t = tag(s);
      if (t === 'local') {
        const names = kids(s).filter((y) => tag(y) === 'names');
        const values = kids(s).filter((y) => tag(y) === 'values');
        const nl = names.length > 0 ? kids(names[0]) : [];
        const vl = values.length > 0 ? kids(values[0]) : [];
        for (let i = 0; i < nl.length; i++) {
          const nm = leaf(nl[i]);
          if (vl[i] !== undefined && isNumExpr(vl[i], cand)) cand.add(nm);
          else killed.add(nm);
        }
      } else if (t === 'assign') {
        const tg = kids(s).filter((y) => tag(y) === 'targets');
        const values = kids(s).filter((y) => tag(y) === 'values');
        const tl = tg.length > 0 ? kids(tg[0]) : [];
        const vl = values.length > 0 ? kids(values[0]) : [];
        for (let i = 0; i < tl.length; i++) {
          if (tag(tl[i]) !== 'name') continue;
          const nm = leaf(kids(tl[i])[0]);
          if (vl[i] === undefined || !isNumExpr(vl[i], cand)) killed.add(nm);
        }
      } else if (t === 'fornum' || t === 'fornum-step') {
        const ch2 = kids(s);
        const iName = leaf(ch2[0]);
        const to = ch2[2];
        const step = (t === 'fornum-step') ? ch2[3] : null;
        // 起点、上界、步长都是数 ⇒ 循环变量一直是数
        if (isNumExpr(ch2[1], cand) && isNumExpr(to, cand)
            && (step === null || isNumExpr(step, cand))) cand.add(iName);
        else killed.add(iName);
        const blk = ch2[ch2.length - 1];
        if (blk && tag(blk) === 'block') walk(kids(blk));
      } else if (t === 'while') {
        const blk = kids(s)[1];
        if (blk && tag(blk) === 'block') walk(kids(blk));
      } else if (t === 'if') {
        for (const k of kids(s)) {
          if (tag(k) === 'block') walk(kids(k));
          else if (tag(k) === 'elseifs') for (const e of kids(k)) {
            const eb = kids(e)[1]; if (eb && tag(eb) === 'block') walk(kids(eb));
          } else if (tag(k) === 'else') {
            const eb = kids(k)[0]; if (eb && tag(eb) === 'block') walk(kids(eb));
          }
        }
      } else if (t === 'do') {
        const blk = kids(s)[0];
        if (blk && tag(blk) === 'block') walk(kids(blk));
      }
    }
  };
  walk(stmts);
  for (const k of killed) cand.delete(k);
  return cand;
}

/**
 * 发一格带快路的二元算子。
 *
 * @param {object} slow 慢路怎么调：{ fn, swap?, negate? }
 * @param {boolean} known 两边**静态已知是数**吗 —— 是就只发快路（检查是死码）
 * @returns { mlir, val } —— val 是 merge 块的块实参
 */
function emitFastBin(op, aVal, bVal, slow, known = false) {
  /* **两边都已知是数 ⇒ 慢路是死码**：不发检查、不开块，一条算术指令了事。
     这是类型覆盖层唯一的形式：知道了就少发，不知道就照发 —— 答案不变。 */
  if (known) {
    const da = emitToDouble(aVal), db = emitToDouble(bVal);
    let mlir = da.mlir + db.mlir;
    if (FAST_CMP[op] !== undefined && FAST_ARITH[op] === undefined) {
      const c = ssa(), tC = ssa(), fC = ssa(), sel = ssa();
      mlir += `    ${c} = llvm.fcmp "${FAST_CMP[op]}" ${da.val}, ${db.val} : f64\n`;
      mlir += `    ${tC} = llvm.mlir.constant(${TAG_TRUE << 32n} : i64) : i64\n`;
      mlir += `    ${fC} = llvm.mlir.constant(${TAG_FALSE << 32n} : i64) : i64\n`;
      mlir += `    ${sel} = llvm.select ${c}, ${tC}, ${fC} : i1, i64\n`;
      return { mlir, val: sel };
    }
    const d = ssa();
    mlir += `    ${d} = llvm.${FAST_ARITH[op]} ${da.val}, ${db.val} : f64\n`;
    const boxed = emitFromDouble(d);
    return { mlir: mlir + boxed.mlir, val: boxed.val };
  }

  const lblFast = bb('af'), lblSlow = bb('as'), lblMerge = bb('am');
  const res = ssa();
  const both = emitBothNum(aVal, bVal);
  let mlir = both.mlir;
  mlir += `    llvm.cond_br ${both.val}, ${lblFast}, ${lblSlow}\n`;

  // ---- 快路：两边都是 double ----
  mlir += `  ${lblFast}:\n`;
  const da = emitToDouble(aVal), db = emitToDouble(bVal);
  mlir += da.mlir + db.mlir;

  if (FAST_CMP[op] !== undefined && FAST_ARITH[op] === undefined) {
    const c = ssa(), tC = ssa(), fC = ssa(), sel = ssa();
    const trueBits = TAG_TRUE << 32n, falseBits = TAG_FALSE << 32n;
    mlir += `    ${c} = llvm.fcmp "${FAST_CMP[op]}" ${da.val}, ${db.val} : f64\n`;
    mlir += `    ${tC} = llvm.mlir.constant(${trueBits} : i64) : i64\n`;
    mlir += `    ${fC} = llvm.mlir.constant(${falseBits} : i64) : i64\n`;
    mlir += `    ${sel} = llvm.select ${c}, ${tC}, ${fC} : i1, i64\n`;
    mlir += `    llvm.br ${lblMerge}(${sel} : i64)\n`;
  } else {
    const inst = FAST_ARITH[op];
    const d = ssa();
    mlir += `    ${d} = llvm.${inst} ${da.val}, ${db.val} : f64\n`;
    const boxed = emitFromDouble(d);
    mlir += boxed.mlir;
    mlir += `    llvm.br ${lblMerge}(${boxed.val} : i64)\n`;
  }

  // ---- 慢路 ----
  mlir += `  ${lblSlow}:\n`;
  /* **单态化那一格**：整份模块里这个算子只有一处元方法 ⇒ 守卫过了就直接调它。
     守卫 = 「a 是表 && a 的元表正是那张 && 结构代号没变过」。
     直接调用是关键：llvm 才可能把整个 `__sub` 展开进来，中间那个 Vec 才有机会
     不落堆。守卫不过就落 omni_mm_slow（它顺手武装守卫，再照常算）。 */
  if (slow.mm !== undefined && FAST_ARITH[op] !== undefined) {
    const mm = slow.mm;
    const lChk = bb('mmc'), lHit = bb('mmh'), lGen = bb('mmg');
    const hi = ssa(), c32 = ssa(), cTag = ssa(), isTab = ssa();
    mlir += `    ${c32} = llvm.mlir.constant(32 : i64) : i64\n`
      + `    ${hi} = llvm.lshr ${aVal}, ${c32} : i64\n`
      + `    ${cTag} = llvm.mlir.constant(${TAG_TAB} : i64) : i64\n`
      + `    ${isTab} = llvm.icmp "eq" ${hi}, ${cTag} : i64\n`
      + `    llvm.cond_br ${isTab}, ${lChk}, ${lGen}\n`
      + `  ${lChk}:\n`;
    const idx = ssa(), objsA = ssa(), objs = ssa(), tpp = ssa(), tp = ssa();
    const mo = ssa(), mp = ssa(), am = ssa();
    mlir += `    ${idx} = llvm.trunc ${aVal} : i64 to i32\n`
      + `    ${objsA} = llvm.mlir.addressof @omni_objs : !llvm.ptr\n`
      + `    ${objs} = llvm.load ${objsA} : !llvm.ptr -> !llvm.ptr\n`
      + `    ${tpp} = llvm.getelementptr ${objs}[${idx}] : (!llvm.ptr, i32) -> !llvm.ptr, !llvm.ptr\n`
      + `    ${tp} = llvm.load ${tpp} : !llvm.ptr -> !llvm.ptr\n`
      + `    ${mo} = llvm.mlir.constant(${LAYOUT.tabMeta} : i32) : i32\n`
      + `    ${mp} = llvm.getelementptr ${tp}[${mo}] : (!llvm.ptr, i32) -> !llvm.ptr, i8\n`
      + `    ${am} = llvm.load ${mp} : !llvm.ptr -> i64\n`;
    const tabA = ssa(), tabV = ssa(), okA = ssa(), okV = ssa(), genA = ssa(), genV = ssa();
    const c1 = ssa(), c2 = ssa(), cc = ssa();
    mlir += `    ${tabA} = llvm.mlir.addressof @${mm.tab} : !llvm.ptr\n`
      + `    ${tabV} = llvm.load ${tabA} : !llvm.ptr -> i64\n`
      + `    ${okA} = llvm.mlir.addressof @${mm.ok} : !llvm.ptr\n`
      + `    ${okV} = llvm.load ${okA} : !llvm.ptr -> i32\n`
      + `    ${genA} = llvm.mlir.addressof @omni_shape_gen : !llvm.ptr\n`
      + `    ${genV} = llvm.load ${genA} : !llvm.ptr -> i32\n`
      + `    ${c1} = llvm.icmp "eq" ${am}, ${tabV} : i64\n`
      + `    ${c2} = llvm.icmp "eq" ${okV}, ${genV} : i32\n`
      + `    ${cc} = llvm.and ${c1}, ${c2} : i1\n`
      + `    llvm.cond_br ${cc}, ${lHit}, ${lGen}\n`
      + `  ${lHit}:\n`;
    /* **就地展开**（只展一层）：形参落两格 alloca，名字解析用顶层那套（全局与具名函数），
       然后把 `return` 后面那个表达式当场发出来。llvm 于是看得见完整的
       "读三个字段 → 三次 fsub → 建一张表"，SROA/内联才有机会继续往下吃。 */
    if (mm.retExpr !== null && _mmDepth === 0) {
      _mmDepth++;
      const ienv = new Map();
      for (const [k, v] of _topEnv) {
        if (typeof v === 'object' && v.global === true) ienv.set(k, v);
        else if (typeof v === 'string' && v.startsWith('@')) ienv.set(k, v);
      }
      ienv.nums = new Set();
      const pa = emitAlloca(ienv), pb = emitAlloca(ienv);
      mlir += pa.mlir + `    llvm.store ${aVal}, ${pa.ptr} : i64, !llvm.ptr\n`
        + pb.mlir + `    llvm.store ${bVal}, ${pb.ptr} : i64, !llvm.ptr\n`;
      ienv.set(mm.params[0], pa.ptr);
      ienv.set(mm.params[1], pb.ptr);
      /* 展开的函数体是**另一套名字**（形参 a/b），所以 _fused 要换成这一层自己的；
         这里也正是合并最值钱的地方：`Vec.new(a.x+b.x, …)` 六次字段读变两次调用。 */
      const savedFused = _fused;
      const pre = emitFusedPrefix([mm.retExpr], ienv);
      _fused = pre.memo.size > 0 ? pre.memo : null;
      const body = emitExpr(mm.retExpr, ienv);
      _fused = savedFused;
      _mmDepth--;
      mlir += pre.mlir + body.mlir + `    llvm.br ${lblMerge}(${body.val} : i64)\n  ${lGen}:\n`;
    } else {
      const envA = ssa(), envI = ssa(), envP = ssa(), dr = ssa();
      mlir += `    ${envA} = llvm.mlir.addressof @${mm.env} : !llvm.ptr\n`
        + `    ${envI} = llvm.load ${envA} : !llvm.ptr -> i64\n`
        + `    ${envP} = llvm.inttoptr ${envI} : i64 to !llvm.ptr\n`
        + `    ${dr} = llvm.call @${mm.fn}(${envP}, ${aVal}, ${bVal}) : (!llvm.ptr, i64, i64) -> i64\n`
        + `    llvm.br ${lblMerge}(${dr} : i64)\n  ${lGen}:\n`;
    }
    const opC = ssa(), fpA = ssa(), tabA2 = ssa(), tabV2 = ssa(), okA2 = ssa(), gr = ssa();
    mlir += `    ${opC} = llvm.mlir.constant(${mm.op} : i32) : i32\n`
      + `    ${fpA} = llvm.mlir.addressof @${mm.fn} : !llvm.ptr\n`
      + `    ${tabA2} = llvm.mlir.addressof @${mm.tab} : !llvm.ptr\n`
      + `    ${tabV2} = llvm.load ${tabA2} : !llvm.ptr -> i64\n`
      + `    ${okA2} = llvm.mlir.addressof @${mm.ok} : !llvm.ptr\n`
      + `    ${gr} = llvm.call @omni_mm_slow(${aVal}, ${bVal}, ${opC}, ${tabV2}, ${fpA}, ${okA2}) : (i64, i64, i32, i64, !llvm.ptr, !llvm.ptr) -> i64\n`
      + `    llvm.br ${lblMerge}(${gr} : i64)\n`;
    mlir += `  ${lblMerge}(${res}: i64):\n`;
    return { mlir, val: res };
  }
  const x = slow.swap ? bVal : aVal;
  const y = slow.swap ? aVal : bVal;
  const raw = ssa();
  mlir += `    ${raw} = llvm.call @${slow.fn}(${x}, ${y}) : (i64, i64) -> i64\n`;
  let slowVal = raw;
  if (slow.negate) {
    const neg = ssa();
    mlir += `    ${neg} = llvm.call @omni_val_not(${raw}) : (i64) -> i64\n`;
    slowVal = neg;
  }
  mlir += `    llvm.br ${lblMerge}(${slowVal} : i64)\n`;

  // ---- 汇合 ----
  mlir += `  ${lblMerge}(${res}: i64):\n`;
  return { mlir, val: res };
}

/** 一格表达式是整数字面量吗（含 `-2` 这种一元负号）—— 是就回那个数，不是回 null。 */
function numLitOf(x) {
  if (x === undefined || x === null) return null;
  const t = tag(x);
  if (t === 'num') {
    const v = Number(leaf(kids(x)[0]));
    return (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) ? v : null;
  }
  if (t === 'neg') {
    const inner = numLitOf(kids(x)[0]);
    return inner === null ? null : -inner;
  }
  if (t === 'paren') return numLitOf(kids(x)[0]);
  return null;
}

/** 步长的字面量值（没写步长就是 1）。 */
function stepLitOf(step) {
  if (step === undefined || step === null) return 1;
  return numLitOf(step);
}

/**
 * 步长的方向 —— 字面量回 +1 / -1，变量回 null。
 *
 * `for i = 1, N do`（没写步长）与 `for i = 10, 1, -2 do`（写了字面量）两种都认得，
 * 于是 `omni_for_cont` 那一格调用**只在步长是变量时**才发。
 * 这一格是 loop 那 62ms 的根：1e7 次跨模块调用只为问"正还是负"。
 */
function stepDirOf(step) {
  const lit = stepLitOf(step);
  if (lit === null) return null;                              // 变量 ⇒ 运行期才知道
  return lit >= 0 ? 1 : -1;
}

function emitStmt(x, env) {
  const t = tag(x), ch = kids(x);

  if (t === 'mcall') return emitExpr(x, env).mlir;      // `t:push(v)` 当语句

  if (t === 'call') {
    const fn = ch[0], args = ch[1];
    if (tag(fn) === 'name' && leaf(kids(fn)[0]) === 'print') {
      const argList = args ? kids(args) : [];
      /* lua 的 print 是**一行、制表符隔开** —— 最后一格才换行 */
      let mlir = '';
      for (let i = 0; i < argList.length; i++) {
        const e = emitExpr(argList[i], env);
        const lastC = ssa();
        mlir += e.mlir
          + `    ${lastC} = llvm.mlir.constant(${i === argList.length - 1 ? 1 : 0} : i32) : i32\n`
          + `    llvm.call @omni_val_write(${e.val}, ${lastC}) : (i64, i32) -> ()\n`;
      }
      return mlir;
    }
    // 其他函数调用当语句
    const e = emitExpr(x, env);
    return e.mlir;
  }

  if (t === 'local') {
    const names = kids(x).filter(y => tag(y) === 'names');
    const values = kids(x).filter(y => tag(y) === 'values');
    const nameList = names.length > 0 ? kids(names[0]) : [];
    const valList = values.length > 0 ? kids(values[0]) : [];
    /* 名字比值多、而且最后那格值是次调用 ⇒ 多出来的名字从边槽里取（多返回值） */
    const lastVal = valList[valList.length - 1];
    const extraFrom = (valList.length >= 1 && nameList.length > valList.length
      && lastVal !== undefined && (tag(lastVal) === 'call' || tag(lastVal) === 'mcall'))
      ? valList.length : -1;
    let mlir = '';
    /* 右边那几个表达式里，同一张表的字段读合成一次（见 emitFusedPrefix） */
    const preL = emitFusedPrefix(valList, env);
    const savedFusedL = _fused;
    _fused = preL.memo.size > 0 ? preL.memo : null;
    mlir += preL.mlir;
    for (let i = 0; i < nameList.length; i++) {
      const nm = leaf(nameList[i]);
      /* **被内层函数引用的局部量要能活过本帧**（upvalue，见 scanCaptured）：
         顶层落成模块级全局；函数里落成堆上的格子（cell）。
         两种都是"指向 i64 的指针"，所以用处上与 alloca 一模一样。 */
      let ptr;
      if ((env.captured ?? new Set()).has(nm)) {
        if (env.topLevel === true) {
          const g = `__up_${nm}`;
          _pendingGlobals.push(
            `  llvm.mlir.global internal @${g}(${TAG_NIL << 32n} : i64) {addr_space = 0 : i32} : i64\n`);
          env.set(nm, { global: true, name: g });
          const r = refOf(env, nm);
          mlir += r.mlir;
          ptr = r.ptr;
        } else {
          const nil = ssa(), c = ssa();
          mlir += `    ${nil} = llvm.mlir.constant(${TAG_NIL << 32n} : i64) : i64\n`
                + `    ${c} = llvm.call @omni_cell_new(${nil}) : (i64) -> !llvm.ptr\n`;
          env.set(nm, { cell: c });
          ptr = c;
        }
      } else {
        const a = emitAlloca(env);
        mlir += a.mlir;
        ptr = a.ptr;
        env.set(nm, ptr);
      }
      if (valList[i]) {
        const e = emitExpr(valList[i], env);
        mlir += e.mlir;
        mlir += `    llvm.store ${e.val}, ${ptr} : i64, !llvm.ptr\n`;
      } else if (extraFrom >= 0) {
        /* **多返回值的第二格及往后**：从边槽里取（`local a, b = f()`）。
           紧跟在那次调用后面，中间没有别的调用 —— 边槽只活这么一小段。 */
        const ic = ssa(), ev = ssa();
        mlir += `    ${ic} = llvm.mlir.constant(${i - extraFrom} : i32) : i32\n`
              + `    ${ev} = llvm.call @omni_extra_get(${ic}) : (i32) -> i64\n`
              + `    llvm.store ${ev}, ${ptr} : i64, !llvm.ptr\n`;
      } else {
        // 默认 nil
        const nil = ssa();
        const bits = TAG_NIL << 32n;
        mlir += `    ${nil} = llvm.mlir.constant(${bits} : i64) : i64\n`;
        mlir += `    llvm.store ${nil}, ${ptr} : i64, !llvm.ptr\n`;
      }
    }
    _fused = savedFusedL;
    return mlir;
  }

  if (t === 'assign') {
    const targets = kids(x).filter(y => tag(y) === 'targets');
    const values = kids(x).filter(y => tag(y) === 'values');
    const tgtList = targets.length > 0 ? kids(targets[0]) : [];
    const valList = values.length > 0 ? kids(values[0]) : [];
    let mlir = '';
    /* **右边先全部求值，再一格一格写**。
       lua 的多重赋值是这个语义，`a[i], a[j] = a[j], a[i]` 靠的就是它。
       原来是"求一格写一格"，于是这句交换把两边都写成了 a[j] —— qsort 排不动，
       而且是**静默的错答案**（答案 "0,0,6400"，序都没乱到报错）。 */
    const vals = [];
    /* 右边那几个表达式里，同一张表的字段读合成一次。**只在求值那一轮有效** ——
       下面写回的一轮可能改同一张表，缓存下来的值就不作数了。 */
    const preA = emitFusedPrefix(valList, env);
    const savedFusedA = _fused;
    _fused = preA.memo.size > 0 ? preA.memo : null;
    mlir += preA.mlir;
    for (let i = 0; i < tgtList.length; i++) {
      if (valList[i] !== undefined) {
        const e = emitExpr(valList[i], env);
        mlir += e.mlir;
        vals.push(e.val);
        continue;
      }
      /* 目标比值多：多出来的从边槽里取（`obj, t = intersect(r)` 那一格多返回值）。
         最后那格值必须是次调用 —— 否则补 nil。 */
      const lastVal = valList[valList.length - 1];
      const multi = lastVal !== undefined && (tag(lastVal) === 'call' || tag(lastVal) === 'mcall');
      const r = ssa();
      if (multi) {
        const ic = ssa();
        mlir += `    ${ic} = llvm.mlir.constant(${i - valList.length} : i32) : i32\n`
          + `    ${r} = llvm.call @omni_extra_get(${ic}) : (i32) -> i64\n`;
      } else {
        mlir += `    ${r} = llvm.mlir.constant(${TAG_NIL << 32n} : i64) : i64\n`;
      }
      vals.push(r);
    }
    _fused = savedFusedA;
    for (let i = 0; i < tgtList.length; i++) {
      const tgt = tgtList[i];
      const e = { val: vals[i] };
      // t[k] = v → omni_tab_set
      if (tag(tgt) === 'index') {
        const [obj, key] = kids(tgt);
        const o = emitExpr(obj, env);
        const k = emitExpr(key, env);
        mlir += o.mlir + k.mlir;
        mlir += `    llvm.call @omni_tab_set(${o.val}, ${k.val}, ${e.val}) : (i64, i64, i64) -> ()\n`;
      } else if (tag(tgt) === 'dot') {
        const [obj, fld] = kids(tgt);
        const o = emitExpr(obj, env);
        const kk = emitStr(leaf(fld));
        const ic = ssa();
        mlir += o.mlir + kk.mlir
          + `    ${ic} = llvm.mlir.constant(${_icN++} : i32) : i32\n`
          + `    llvm.call @omni_tab_set_ic(${o.val}, ${kk.val}, ${e.val}, ${ic}) : (i64, i64, i64, i32) -> ()\n`;
      } else {
        const nm = leaf(kids(tgt)[0]);
        const ref = refOf(env, nm);
        mlir += ref.mlir;
        mlir += `    llvm.store ${e.val}, ${ref.ptr} : i64, !llvm.ptr\n`;
      }
    }
    return mlir;
  }

  if (t === 'if') {
    const cond = ch[0], thenBlock = ch[1], elifs = ch[2], elsePart = ch[3];
    const lblEnd = bb('end');

    // 收集所有分支：[cond, block] 对
    const branches = [{ cond, block: thenBlock }];
    if (elifs !== undefined) {
      for (const elif of kids(elifs)) {
        const [ec, eb] = kids(elif);
        branches.push({ cond: ec, block: eb });
      }
    }

    const hasElse = elsePart !== undefined && tag(elsePart) === 'else';
    let elseLabel = null;

    let mlir = '';
    for (let i = 0; i < branches.length; i++) {
      const br = branches[i];
      const lblThen = bb('then');
      let lblNext;
      if (i < branches.length - 1) {
        lblNext = bb('elif');
      } else if (hasElse) {
        elseLabel = bb('else');
        lblNext = elseLabel;
      } else {
        lblNext = lblEnd;
      }
      const c = emitExpr(br.cond, env);
      const tr = emitTruthy(c.val);
      mlir += c.mlir + tr.mlir;
      mlir += `    llvm.cond_br ${tr.val}, ${lblThen}, ${lblNext}\n`;
      mlir += `  ${lblThen}:\n`;
      const thenBody = emitBlockBody(br.block, env);
      mlir += thenBody;
      if (!endsTerminated(thenBody)) mlir += `    llvm.br ${lblEnd}\n`;
      if (i < branches.length - 1) {
        mlir += `  ${lblNext}:\n`;
      }
    }
    if (hasElse) {
      mlir += `  ${elseLabel}:\n`;
      const elseBlock = kids(elsePart)[0];
      const elseBody = emitBlockBody(elseBlock, env);
      mlir += elseBody;
      if (!endsTerminated(elseBody)) mlir += `    llvm.br ${lblEnd}\n`;
    }
    mlir += `  ${lblEnd}:\n`;
    return mlir;
  }

  if (t === 'while') {
    const cond = ch[0], body = ch[1];
    const lblCond = bb('wc'), lblBody = bb('wb'), lblEnd = bb('we');
    let mlir = `    llvm.br ${lblCond}\n`;
    mlir += `  ${lblCond}:\n`;
    const c = emitExpr(cond, env);
    const tr = emitTruthy(c.val);
    mlir += c.mlir + tr.mlir;
    mlir += `    llvm.cond_br ${tr.val}, ${lblBody}, ${lblEnd}\n`;
    mlir += `  ${lblBody}:\n`;
    _loopEnds.push(lblEnd);
    const wBody = emitBlockBody(body, env);
    _loopEnds.pop();
    mlir += wBody;
    if (!endsTerminated(wBody)) mlir += `    llvm.br ${lblCond}\n`;
    mlir += `  ${lblEnd}:\n`;
    return mlir;
  }

  if (t === 'return') {
    if (ch.length === 0) {
      const r = ssa(), bits = TAG_NIL << 32n;
      return `    ${r} = llvm.mlir.constant(${bits} : i64) : i64\n    llvm.return ${r} : i64\n`;
    }
    const pre = emitFusedPrefix(ch, env);
    const saved = _fused;
    _fused = pre.memo.size > 0 ? pre.memo : null;
    const e = emitExpr(ch[0], env);
    let mlir = pre.mlir + e.mlir;
    /* **第二格及往后的返回值**走边槽（见 lua-rt.h 的 omni_extra_*）。
       先把后面那些算出来写进边槽，最后 return 第一格 —— 调用方紧接着取。 */
    for (let i = 1; i < ch.length; i++) {
      const ei = emitExpr(ch[i], env);
      const ic = ssa();
      mlir += ei.mlir
        + `    ${ic} = llvm.mlir.constant(${i - 1} : i32) : i32\n`
        + `    llvm.call @omni_extra_set(${ic}, ${ei.val}) : (i32, i64) -> ()\n`;
    }
    _fused = saved;
    return mlir + `    llvm.return ${e.val} : i64\n`;
  }

  // for i = from, to [, step] do block end
  if (t === 'fornum' || t === 'fornum-step') {
    const [nm, from, to, ...rest] = ch;
    const step = (t === 'fornum-step') ? rest[0] : null;
    const block = rest[rest.length - 1];
    const iName = leaf(nm);

    const { mlir: am, ptr: iPtr } = emitAlloca(env);
    let mlir = am;
    const fromE = emitExpr(from, env);
    mlir += fromE.mlir;
    mlir += `    llvm.store ${fromE.val}, ${iPtr} : i64, !llvm.ptr\n`;
    env.set(iName, iPtr);

    const lblCond = bb('fc'), lblBody = bb('fb'), lblEnd = bb('fe');
    /* **步长的方向**：字面量（含 `-3` 这种一元负号）⇒ 编译期就知道，
       回 +1 / -1；是变量 ⇒ 回 null，条件退回运行时判断。 */
    const stepDir = stepDirOf(step);
    /* **步长是字面量时不落 alloca**（loop 那 61ms 的根）。
       落了 alloca，LLVM 就证不出"它一直是 int tag"，于是每轮自增都掉进慢路
       （汇编里那一句 `bl _omni_val_add`）。字面量直接当常量 SSA 值喂进快路，
       自增就是 `add + 溢出检查`，热循环里一个 call 都没有。 */
    const stepLit = stepLitOf(step);
    let stepPtr = null, stepConst = null;
    if (stepLit !== null) {
      stepConst = ssa();
      mlir += `    ${stepConst} = llvm.mlir.constant(${nanboxInt(stepLit)} : i64) : i64\n`;
    } else {
      const a = emitAlloca(env);
      mlir += a.mlir;
      stepPtr = a.ptr;
      const stepE = emitExpr(step, env);
      mlir += stepE.mlir;
      mlir += `    llvm.store ${stepE.val}, ${stepPtr} : i64, !llvm.ptr\n`;
    }
    /* 上界同理：字面量直接当常量（省一格 alloca 与每轮一次 load）。 */
    const toLit = numLitOf(to);
    let limPtr = null, limConst = null;
    if (toLit !== null) {
      limConst = ssa();
      mlir += `    ${limConst} = llvm.mlir.constant(${nanboxInt(toLit)} : i64) : i64\n`;
    } else {
      const a = emitAlloca(env);
      mlir += a.mlir;
      limPtr = a.ptr;
      const toE = emitExpr(to, env);
      mlir += toE.mlir;
      mlir += `    llvm.store ${toE.val}, ${limPtr} : i64, !llvm.ptr\n`;
    }

    mlir += `    llvm.br ${lblCond}\n`;
    mlir += `  ${lblCond}:\n`;
    const curI = ssa();
    mlir += `    ${curI} = llvm.load ${iPtr} : !llvm.ptr -> i64\n`;
    let curL;
    if (limConst !== null) { curL = limConst; } else {
      curL = ssa();
      mlir += `    ${curL} = llvm.load ${limPtr} : !llvm.ptr -> i64\n`;
    }
    /* **方向静态已知时不调运行时**（loop 那 62ms 的根就在这儿）。
       `for i = 1, N do` 是最常见的形状，步长是字面量 ⇒ 方向编译期就定了，
       条件落成带整数快路的比较（热循环里因此一个 call 都没有）。
       步长是变量时才退回 `omni_for_cont` —— 那一格的方向只有运行期知道。 */
    let c;
    if (stepDir !== null) {
      const cmpOp = stepDir > 0 ? '<=' : '>=';
      /* 循环变量与上界都已知是数 ⇒ 条件只发一条 `fcmp`（没有 tag 检查） */
      const loopNum = (env.nums ?? new Set()).has(iName) && (toLit !== null || isNumExpr(to, env.nums ?? new Set()));
      const f = emitFastBin(cmpOp, curI, curL,
        stepDir > 0 ? { fn: 'omni_val_le' } : { fn: 'omni_val_le', swap: true }, loopNum);
      const tr = emitTruthy(f.val);
      mlir += f.mlir + tr.mlir;
      c = tr.val;
    } else {
      const curS = ssa(), cont = ssa(), z = ssa(), cc = ssa();
      mlir += `    ${curS} = llvm.load ${stepPtr} : !llvm.ptr -> i64\n`;
      mlir += `    ${cont} = llvm.call @omni_for_cont(${curI}, ${curL}, ${curS}) : (i64, i64, i64) -> i32\n`;
      mlir += `    ${z} = llvm.mlir.constant(0 : i32) : i32\n`;
      mlir += `    ${cc} = llvm.icmp "ne" ${cont}, ${z} : i32\n`;
      c = cc;
    }
    mlir += `    llvm.cond_br ${c}, ${lblBody}, ${lblEnd}\n`;
    mlir += `  ${lblBody}:\n`;
    _loopEnds.push(lblEnd);
    const forBody = emitBlockBody(block, env);
    _loopEnds.pop();
    mlir += forBody;
    if (!endsTerminated(forBody)) {
      // i = i + step —— 走整数快路；步长是字面量时直接用常量（不经 alloca）
      const i2 = ssa();
      mlir += `    ${i2} = llvm.load ${iPtr} : !llvm.ptr -> i64\n`;
      let s2;
      if (stepConst !== null) { s2 = stepConst; } else {
        s2 = ssa();
        mlir += `    ${s2} = llvm.load ${stepPtr} : !llvm.ptr -> i64\n`;
      }
      /* 循环变量已知是数 + 步长是字面量 ⇒ 自增只发一条 `fadd` */
      const incNum = (env.nums ?? new Set()).has(iName) && stepLit !== null;
      const inc = emitFastBin('+', i2, s2, { fn: 'omni_val_add' }, incNum);
      mlir += inc.mlir;
      mlir += `    llvm.store ${inc.val}, ${iPtr} : i64, !llvm.ptr\n`;
      mlir += `    llvm.br ${lblCond}\n`;
    }
    mlir += `  ${lblEnd}:\n`;
    return mlir;
  }

  // break —— 跳到最近那一层循环的出口
  if (t === 'break') {
    /* **循环出口标签的栈**（`_loopEnds`）。原来这一格是空实现（一句 TODO），
       于是 `mandel` 里 `if x2+y2 > 4.0 then break end` 什么都不做 ——
       内层 while 每次跑满 100 轮，每个点都判成"在集合内"，答案 90000 而不是 23275。
       **静默的错答案**，简单例子一个都抓不到。判据现在是那五个复杂例子。 */
    if (_loopEnds.length === 0) throw new Error('emit-mlir: break outside a loop');
    return `    llvm.br ${_loopEnds[_loopEnds.length - 1]}\n`;
  }

  // do block end
  if (t === 'do') {
    let mlir = '';
    const block = ch[0];
    if (block) for (const s of kids(block)) mlir += emitStmt(s, env);
    return mlir;
  }

  // for v in iter do block end（泛型 for）
  if (t === 'forin') {
    const names = kids(x).find(y => tag(y) === 'names');
    const values = kids(x).find(y => tag(y) === 'values');
    const block = kids(x).find(y => tag(y) === 'block');
    const nameList = names ? kids(names) : [];
    const exprList = values ? kids(values) : [];
    /* lua 的泛型 for 拿三样东西：迭代函数 f、状态 s、控制变量 ctrl，每步算
       `f(s, ctrl)`，第一个回值是新的 ctrl，是 nil 就停。
       **谁给这三样**：`ipairs(t)` 这种已知回三个值的内建（第二三个走边槽），
       别的表达式只当 f，s/ctrl 传 nil（`for v in g do` 那一格协程就是这样）。
       用户自己写的"回三个值的迭代器"还不支持 —— 那要给每次 return 记回值个数，
       是下一刀；现在的表现是循环一次都不跑，不是错答案。 */
    const itExpr = exprList[0];
    const isMulti = tag(itExpr) === 'call' && tag(kids(itExpr)[0]) === 'name'
      && MULTI_ITER[leaf(kids(kids(itExpr)[0])[0])] !== undefined
      && env.get(leaf(kids(kids(itExpr)[0])[0])) === undefined;
    const itE = emitExpr(itExpr, env);
    const { mlir: am, ptr: itPtr } = emitAlloca(env);
    const sA = emitAlloca(env), cA = emitAlloca(env);
    let mlir = am + sA.mlir + cA.mlir + itE.mlir
      + `    llvm.store ${itE.val}, ${itPtr} : i64, !llvm.ptr\n`;
    if (isMulti) {
      const i0 = ssa(), s0 = ssa(), i1 = ssa(), c0 = ssa();
      mlir += `    ${i0} = llvm.mlir.constant(0 : i32) : i32\n`
        + `    ${s0} = llvm.call @omni_extra_get(${i0}) : (i32) -> i64\n`
        + `    llvm.store ${s0}, ${sA.ptr} : i64, !llvm.ptr\n`
        + `    ${i1} = llvm.mlir.constant(1 : i32) : i32\n`
        + `    ${c0} = llvm.call @omni_extra_get(${i1}) : (i32) -> i64\n`
        + `    llvm.store ${c0}, ${cA.ptr} : i64, !llvm.ptr\n`;
    } else {
      const nz = ssa();
      mlir += `    ${nz} = llvm.mlir.constant(${TAG_NIL << 32n} : i64) : i64\n`
        + `    llvm.store ${nz}, ${sA.ptr} : i64, !llvm.ptr\n`
        + `    llvm.store ${nz}, ${cA.ptr} : i64, !llvm.ptr\n`;
    }
    const vPtrs = [];
    for (const nmNode of nameList) {
      const a = emitAlloca(env);
      mlir += a.mlir;
      env.set(leaf(nmNode), a.ptr);
      vPtrs.push(a.ptr);
    }
    const lblCond = bb('gc'), lblBody = bb('gb'), lblEnd = bb('ge');
    mlir += `    llvm.br ${lblCond}\n  ${lblCond}:\n`;
    const itV = ssa(), sV = ssa(), cV = ssa(), nilC = ssa();
    mlir += `    ${itV} = llvm.load ${itPtr} : !llvm.ptr -> i64\n`
          + `    ${sV} = llvm.load ${sA.ptr} : !llvm.ptr -> i64\n`
          + `    ${cV} = llvm.load ${cA.ptr} : !llvm.ptr -> i64\n`
          + `    ${nilC} = llvm.mlir.constant(${TAG_NIL << 32n} : i64) : i64\n`;
    const c = emitCallVal(itV, [sV, cV]);
    mlir += c.mlir + `    llvm.store ${c.val}, ${vPtrs[0]} : i64, !llvm.ptr\n`
          + `    llvm.store ${c.val}, ${cA.ptr} : i64, !llvm.ptr\n`;
    for (let i = 1; i < vPtrs.length; i++) {
      const ic = ssa(), ev = ssa();
      mlir += `    ${ic} = llvm.mlir.constant(${i - 1} : i32) : i32\n`
            + `    ${ev} = llvm.call @omni_extra_get(${ic}) : (i32) -> i64\n`
            + `    llvm.store ${ev}, ${vPtrs[i]} : i64, !llvm.ptr\n`;
    }
    const isNil = ssa();
    mlir += `    ${isNil} = llvm.icmp "ne" ${c.val}, ${nilC} : i64\n`
          + `    llvm.cond_br ${isNil}, ${lblBody}, ${lblEnd}\n  ${lblBody}:\n`;
    _loopEnds.push(lblEnd);
    const body = emitBlockBody(block, env);
    _loopEnds.pop();
    mlir += body;
    if (!endsTerminated(body)) mlir += `    llvm.br ${lblCond}\n`;
    mlir += `  ${lblEnd}:\n`;
    return mlir;
  }

  if (t === 'localfn') return emitNamedFn(leaf(ch[0]), ch[1], env);

  /* `function f(…)` / `function T.m(…)` / `function T:m(…)`。
     裸名字那一格与 `local function` 同路（模块级符号，直接 call）；
     带点的造一格闭包然后 `T.m = clo`，`method` 子节点表示 `:`（加隐含 self）。 */
  if (t === 'fndef') {
    const target = ch[0], bodyNode = ch[1];
    if (tag(target) === 'name') return emitNamedFn(leaf(kids(target)[0]), bodyNode, env);
    const isMeth = tag(target) === 'method';
    const nameNode = kids(target);
    const obj = nameNode[0], fldName = leaf(nameNode[1]);
    /* 这一处是被单态化盯上的算子元方法 ⇒ 用固定的符号名，并把"那张元表"与
       "闭包的 upvalue 表"存进两格全局，算术点上的守卫要读它们（见 emitFastBin）。 */
    const mmSite = _mmEmitted.get(fldName);
    const mine = mmSite !== undefined && mmSite.body === bodyNode;
    const clo = emitClosure(bodyNode, env, fldName, isMeth, mine ? mmSite.fn : null);
    const o = emitExpr(obj, env);
    const k = emitStr(fldName);
    let mlir = clo.mlir + o.mlir + k.mlir
      + `    llvm.call @omni_tab_set(${o.val}, ${k.val}, ${clo.val}) : (i64, i64, i64) -> ()\n`;
    if (mine) {
      const tA = ssa(), eV = ssa(), eI = ssa(), eA = ssa();
      mlir += `    ${tA} = llvm.mlir.addressof @${mmSite.tab} : !llvm.ptr\n`
        + `    llvm.store ${o.val}, ${tA} : i64, !llvm.ptr\n`
        + `    ${eV} = llvm.call @omni_clo_env(${clo.val}) : (i64) -> !llvm.ptr\n`
        + `    ${eI} = llvm.ptrtoint ${eV} : !llvm.ptr to i64\n`
        + `    ${eA} = llvm.mlir.addressof @${mmSite.env} : !llvm.ptr\n`
        + `    llvm.store ${eI}, ${eA} : i64, !llvm.ptr\n`;
    }
    return mlir;
  }

  throw new Error(`emit-mlir: unsupported stmt '${t}'`);
}

/**
 * **具名函数**（`local function f` / `function f`）—— 一格模块级 `llvm.func`，
 * 调用点直接 call，没有闭包那一跳。带点的（`function T.m`）走 emitClosure。
 */
function emitNamedFn(nm, bodyNode, env) {
  const block = kids(bodyNode).find(y => tag(y) === 'block');
  const pi = paramInfo(bodyNode);
  const paramNames = pi.names;
  const fnEnv = new Map();
  /* **upvalue**：外层那些落成全局的名字，函数体里照样看得见（全局是按引用的，
     与 lua 的 upvalue 语义一致）。局部的 alloca 不传 —— 那是别人的栈帧。 */
  for (const [k, v] of env) {
    if (typeof v === 'object' && v.global === true) fnEnv.set(k, v);
    else if (typeof v === 'string' && v.startsWith('@')) fnEnv.set(k, v);   // 函数名
  }
  fnEnv.set(nm, `@${nm}`);                       // 递归：函数体里看得见自己
  /* **形参的类型覆盖层**：scanNumFuncs 的乐观不动点判出来的那几个形参一定是数，
     加上函数体里判得出的局部量 —— 于是 `fib` 的 `n<2` / `n-1` 只发一条 fcmp / fsub。 */
  fnEnv.nums = new Set([
    ...(_paramNum.get(nm) ?? []),
    ...scanNumLocals(block ? kids(block) : []),
  ]);
  /* 函数体里被更内层函数捕获的量要落成格子（cell）——`local` 那一格看这个集合 */
  fnEnv.captured = scanCaptured(block ? kids(block) : []);
  const savedSsa = _ssa, savedLoops = _loopEnds;
  _ssa = 0; _loopEnds = [];
  const savedScratch = fnScratchBegin();
  let fnBody = '';
  const paramVals = paramNames.map((_, i) => `%arg${i}`);
  for (let i = 0; i < paramNames.length; i++) {
    if (fnEnv.captured.has(paramNames[i])) {
      const c = ssa();
      fnBody += `    ${c} = llvm.call @omni_cell_new(${paramVals[i]}) : (i64) -> !llvm.ptr\n`;
      fnEnv.set(paramNames[i], { cell: c });
      continue;
    }
    const { mlir: am, ptr } = emitAlloca(fnEnv);
    fnBody += am;
    fnBody += `    llvm.store ${paramVals[i]}, ${ptr} : i64, !llvm.ptr\n`;
    fnEnv.set(paramNames[i], ptr);
  }
  /* **变长实参**：最后多一格形参，装的是调用点打好的那张表（`{...}` 就是抄它一份） */
  if (pi.vararg) fnEnv.vaVal = `%arg${paramNames.length}`;
  if (block) for (const s of kids(block)) fnBody += emitStmt(s, fnEnv);
  if (!endsTerminated(fnBody)) {
    const rz = ssa(), bits = TAG_NIL << 32n;
    fnBody += `    ${rz} = llvm.mlir.constant(${bits} : i64) : i64\n    llvm.return ${rz} : i64\n`;
  }
  _ssa = savedSsa; _loopEnds = savedLoops;
  fnBody = fnScratchEnd(savedScratch, fnBody);
  const sigVals = pi.vararg ? [...paramVals, `%arg${paramNames.length}`] : paramVals;
  _pendingFuncs.push(
    `  llvm.func @${nm}(${sigVals.map(v => `${v}: i64`).join(', ')}) -> i64 {\n${fnBody}  }\n`
  );
  env.set(nm, `@${nm}`);
  return '';
}

/**
 * **一格函数值**（匿名函数 / 嵌套函数）。
 *
 * 出两样东西：
 *   1. 一个 `llvm.func @__cloN(%upe: !llvm.ptr, %arg0: i64, …) -> i64` —— 第一个形参是
 *      upvalue 表（格子指针的数组）；
 *   2. 定义点上的一串指令：把捕获到的格子指针填进表里，然后 `omni_clo_new`。
 *
 * upvalue 槽的顺序由 `free` 这张表定死 —— 函数体与创建点读的是同一张表，所以两边对得上。
 *
 * **捕获栈上的量会报错，不会静默**：被内层函数引用的量应当已经由 `scanCaptured`
 * 提成格子（函数里）或全局（顶层）。要是还剩一格 alloca，说明某条路径漏了提升 ——
 * 那时候捕的是别人栈帧里的地址，返回之后就是垃圾。宁可在这儿响。
 */
let _cloN = 0;

function emitClosure(bodyNode, env, hint, implicitSelf = false, fixedName = null) {
  const savedFused = _fused;
  _fused = null;                 // 闭包另发一个 llvm.func，外头那些 SSA 不在作用域里
  try {
    return emitClosureInner(bodyNode, env, hint, implicitSelf, fixedName);
  } finally {
    _fused = savedFused;
  }
}

function emitClosureInner(bodyNode, env, hint, implicitSelf = false, fixedName = null) {
  const block = kids(bodyNode).find(y => tag(y) === 'block');
  const pi = paramInfo(bodyNode);
  if (pi.vararg) throw new Error('emit-mlir: 匿名/方法函数的 `...` 还没做');
  const paramNames = [
    ...(implicitSelf ? ['self'] : []),          // `function T:m()` 的隐含形参
    ...pi.names,
  ];
  const fname = fixedName !== null ? fixedName : `__clo${_cloN++}${hint ? `_${hint}` : ''}`;

  const free = [];
  for (const nm of namesIn(bodyNode)) {
    if (paramNames.includes(nm)) continue;
    const b = env.get(nm);
    if (b === undefined) continue;                                   // 内置 / 未绑定
    if (typeof b === 'string' && b.startsWith('@')) continue;        // 顶层具名函数
    if (typeof b === 'string' && env.topLevel !== true)
      throw new Error(`emit-mlir: capture of stack local '${nm}'`);
    free.push(nm);
  }

  // ---- 函数体 ----
  const fnEnv = new Map();
  for (const [k, v] of env) if (typeof v === 'string' && v.startsWith('@')) fnEnv.set(k, v);
  free.forEach((nm, i) => fnEnv.set(nm, { up: i }));
  fnEnv.upPtr = '%upe';
  fnEnv.captured = scanCaptured(block ? kids(block) : []);
  fnEnv.nums = scanNumLocals(block ? kids(block) : []);

  const savedSsa = _ssa, savedLoops = _loopEnds;
  _ssa = 0; _loopEnds = [];
  const savedScratchC = fnScratchBegin();
  let fnBody = '';
  for (let i = 0; i < paramNames.length; i++) {
    const nm = paramNames[i];
    if (fnEnv.captured.has(nm)) {
      const c = ssa();
        fnBody += `    ${c} = llvm.call @omni_cell_new(%arg${i}) : (i64) -> !llvm.ptr\n`;
      fnEnv.set(nm, { cell: c });
    } else {
      const { mlir: am, ptr } = emitAlloca(fnEnv);
      fnBody += am + `    llvm.store %arg${i}, ${ptr} : i64, !llvm.ptr\n`;
      fnEnv.set(nm, ptr);
    }
  }
  if (block) for (const s of kids(block)) fnBody += emitStmt(s, fnEnv);
  if (!endsTerminated(fnBody)) {
    const rz = ssa(), bits = TAG_NIL << 32n;
    fnBody += `    ${rz} = llvm.mlir.constant(${bits} : i64) : i64\n    llvm.return ${rz} : i64\n`;
  }
  _ssa = savedSsa; _loopEnds = savedLoops;
  fnBody = fnScratchEnd(savedScratchC, fnBody);
  const sig = [`%upe: !llvm.ptr`, ...paramNames.map((_, i) => `%arg${i}: i64`)].join(', ');
  _pendingFuncs.push(`  llvm.func @${fname}(${sig}) -> i64 {\n${fnBody}  }\n`);

  // ---- 创建点 ----
  let mlir = '';
  const nC = ssa(), arr = ssa();
  mlir += `    ${nC} = llvm.mlir.constant(${Math.max(free.length, 1)} : i32) : i32\n`
        + `    ${arr} = llvm.alloca ${nC} x !llvm.ptr : (i32) -> !llvm.ptr\n`;
  free.forEach((nm, i) => {
    const r = refOf(env, nm);
    const ic = ssa(), slot = ssa();
    mlir += r.mlir
      + `    ${ic} = llvm.mlir.constant(${i} : i32) : i32\n`
      + `    ${slot} = llvm.getelementptr ${arr}[${ic}] : (!llvm.ptr, i32) -> !llvm.ptr, !llvm.ptr\n`
      + `    llvm.store ${r.ptr}, ${slot} : !llvm.ptr, !llvm.ptr\n`;
  });
  const fa = ssa(), ar = ssa(), nu = ssa(), fv = ssa();
  mlir += `    ${fa} = llvm.mlir.addressof @${fname} : !llvm.ptr\n`
    + `    ${ar} = llvm.mlir.constant(${paramNames.length} : i32) : i32\n`
    + `    ${nu} = llvm.mlir.constant(${free.length} : i32) : i32\n`
    + `    ${fv} = llvm.call @omni_clo_new(${fa}, ${ar}, ${nu}, ${arr}) : (!llvm.ptr, i32, i32, !llvm.ptr) -> i64\n`;
  return { mlir, val: fv };
}

let _pendingFuncs = [];
let _pendingGlobals = [];
let _strN = 0;
/** 字段访问点的编号（每个点一格内联缓存，见 lua-rt.h 的 OIC） */
let _icN = 0;
/** 具名字段构造点的编号（每个点一格形状缓存） */
let _shpN = 0;
/** 被单态化的算子元方法：'__sub' → { fn, tab, env, ok, op, body, retExpr, params } */
let _mmEmitted = new Map();
/** 就地展开只展一层（元方法体里再用同一个算子时不再展开，免得无限递归） */
let _mmDepth = 0;
/** 顶层那套名字绑定（展开元方法体时要拿它解析全局与具名函数） */
let _topEnv = new Map();
/** 串字面量 → 它那格全局（同一个字面量只造一次） */
let _strCache = new Map();
/** scanNumFuncs 的结果（isNumExpr 要查"这个函数返回数吗"） */
let _retNum = new Set();
let _paramNum = new Map();

export function luaToMlir(tree) {
  if (tag(tree) !== 'block') throw new Error('emit-mlir: expected (block ...)');
  reset(); _pendingFuncs = []; _pendingGlobals = []; _strN = 0; _cloN = 0; _strCache = new Map(); _icN = 0; _shpN = 0; _fused = null;
  /* **类型覆盖层**：两刀先后跑一遍。
     第二刀（跨函数）要在第一刀之前设好 `_retNum`，因为 isNumExpr 会查它。 */
  _retNum = new Set(); _paramNum = new Map();
  _vaFuncs = scanVaFuncs(kids(tree), new Map());
  const ff = scanNumFuncs(kids(tree));
  _retNum = ff.retNum; _paramNum = ff.paramNum;
  /* **算子元方法的单态化**：先把唯一那处记下来（符号名与两格全局），
     这样不管算术点在定义之前还是之后，都能发那个带守卫的直接调用。 */
  _mmEmitted = new Map();
  for (const [key, site] of scanMetaOps(kids(tree))) {
    const sfx = key.replace(/^__/, '');
    const rec = {
      fn: `__mm_${sfx}`, tab: `__mmtab_${sfx}`, env: `__mmenv_${sfx}`,
      ok: `__mmok_${sfx}`, op: MM_OPS[key].op, body: site.body,
      retExpr: site.retExpr, params: site.params,
    };
    _pendingGlobals.push(
      `  llvm.mlir.global internal @${rec.tab}(0 : i64) {addr_space = 0 : i32} : i64\n`
      + `  llvm.mlir.global internal @${rec.env}(0 : i64) {addr_space = 0 : i32} : i64\n`
      + `  llvm.mlir.global internal @${rec.ok}(0 : i32) {addr_space = 0 : i32} : i32\n`);
    _mmEmitted.set(key, rec);
  }
  const env = new Map();
  env.topLevel = true;
  _topEnv = env; _mmDepth = 0;
  /* 第一刀（块内局部量）：判不出来就是空集，发射器照样对，只是多发一次 tag 检查。 */
  env.nums = scanNumLocals(kids(tree));
  /* **upvalue 那一刀**：被内层函数体引用的顶层局部量落成模块级全局。 */
  env.captured = scanCaptured(kids(tree));
  /* **全局变量**：没有 `local` 的赋值目标，各落一格模块级全局（见 scanGlobalAssigned）。 */
  for (const g of scanGlobalAssigned(kids(tree))) {
    const gn = `__g_${g}`;
    _pendingGlobals.push(
      `  llvm.mlir.global internal @${gn}(${TAG_NIL << 32n} : i64) {addr_space = 0 : i32} : i64\n`);
    env.set(g, { global: true, name: gn });
  }
  let body = '';
  for (const stmt of kids(tree)) body += emitStmt(stmt, env);
  if (!endsTerminated(body)) {
    const rz = ssa();
    body += `    ${rz} = llvm.mlir.constant(0 : i32) : i32\n    llvm.return ${rz} : i32\n`;
  }
  body = _scratchDef + body;      // main 那格暂存槽也放函数开头（循环里不许再 alloca）
  _scratchPtr = null; _scratchDef = '';
  /* 内联缓存那张表：main 的第一条指令就把它开出来（每个字段访问点一格） */
  const icc = ssa();
  const prologue = `    ${icc} = llvm.mlir.constant(${Math.max(_icN, 1)} : i32) : i32\n`
    + `    llvm.call @omni_ic_reserve(${icc}) : (i32) -> ()\n`;
  return MLIR_PRELUDE + _pendingGlobals.join('') + _pendingFuncs.join('')
    + `  llvm.func @main() -> i32 {\n` + prologue + body + `  }\n` + MLIR_EPILOGUE;
}
