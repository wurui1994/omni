// Omni stage0 — JS AST → OIR 的降级器（ADR-0011 落地顺序第 6 步）
//
// 立场（ADR-0011 决策 1）：JS 的每个值都是 `dynamic`，不给 JS 做类型推断。所以这里
// 没有类型检查，只有"把 JS 的语义摊成 OIR 的形状"。语义本身全在 js_abi.js 那张封闭
// 的 op 表里，两个后端各实现一次；这个文件只决定**发哪个 op**。
//
// 几条贯穿全文的约定：
//   - 每个 JS 函数降成 OIR 的 `fn(list<dynamic>) -> dynamic`：实参装在一个数组里，
//     形参在函数开头从数组里取。这样"函数当值用"和"直接调用"是同一套调用约定。
//   - 模块级的 const/let/var 变成 OIR 的 JsGlobal（后端各发一个真全局），不是
//     omni_main 的局部量 —— 顶层函数要能互相递归、要能读模块级的表，把它们塞进
//     main 的局部量就都做不到了。
//   - OIR 里语句不是表达式，也没有逗号表达式。需要"先算一下再用"的地方（&& || ??
//     ?. 复合赋值 ++）一律用**临时量 + Assign 表达式**：Assign 在 OIR 里是表达式，
//     而 Ternary 的两个分支是惰性的，所以短路语义靠 Ternary 就能对上。
//   - 拿不准的构造一律**当场报错**，不猜。清单见文件末尾的 unsupported 列表。

import { DYNAMIC, STRING, BOOL, REAL, INT, listType, dictType, fnType } from '../hir/types.js';
import { JS_ALL, JS_METHODS, JS_PROPS } from '../hir/js_abi.js';
import { C_ABI } from '../hir/c_abi.js';
import { genToStateMachine } from './genfn.js';

/** JS 的函数签名只有一种：fn(list&lt;dynamic&gt;) -&gt; dynamic（ADR-0011） */
const JS_FN = fnType([listType(DYNAMIC)], DYNAMIC);

/** 形参数组：静态类型是 list&lt;dynamic&gt;，喂给 js_* op 之前要装箱 */
const argsDyn = () => box({ kind: 'VarRef', name: 'args', type: listType(DYNAMIC) }, listType(DYNAMIC));
/** 没装箱的形参数组：转发给另一个函数时要的就是这个（形参类型本来就是 list&lt;dynamic&gt;） */
const argsRaw = () => ({ kind: 'VarRef', name: 'args', type: listType(DYNAMIC) });

/* ---------------------------------------------------------------- OIR 构造助手 */

const D = DYNAMIC;
const dyn = (kind, extra) => ({ kind, type: D, ...extra });
const op = (name, args, extra = {}) => {
  const abi = JS_ALL[name];
  if (abi && abi.ret === 'bool') {
    // 表里返回 bool 的 op（has / includes / eq …）在表达式位置要装箱回 dynamic
    return box({ kind: 'Builtin', name, args, type: BOOL, ...extra }, BOOL);
  }
  return dyn('Builtin', { name, args, ...extra });
};
const undefExpr = () => op('js_undef', []);
const nullExpr = () => dyn('DynNull', {});
const box = (e, from) => dyn('Box', { from, expr: e });
const constReal = (v) => box({ kind: 'Const', type: REAL, value: v }, REAL);
const constInt = (v) => box({ kind: 'Const', type: INT, value: v }, INT);
const constBool = (v) => box({ kind: 'Const', type: BOOL, value: v }, BOOL);
/** JS 的字符串是 UTF-16 码元序列（ADR-0011 决策 8），字面量要过一次 js_s16 */
const s16 = (v) => op('js_s16', [{ kind: 'Const', type: STRING, value: v }]);
const arrLit = (items) => box({ kind: 'ListLit', type: listType(D), items }, listType(D));
const varRef = (name) => dyn('VarRef', { name });
const globalRef = (name) => dyn('JsGlobal', { name });
const assign = (target, value) => dyn('Assign', { target, value });
const ternary = (cond, then, otherwise) => dyn('Ternary', { cond, then, otherwise });
/** 真假判断的结果是 OIR 的 bool（不是 dynamic），Ternary/If 的条件要的就是它 */
const truthy = (e) => ({ kind: 'Builtin', name: 'js_truthy', args: [e], type: BOOL });
const boolOp = (name, args, extra = {}) => ({ kind: 'Builtin', name, args, type: BOOL, ...extra });
const notB = (e) => ({ kind: 'Un', op: '!', operand: e, type: BOOL });
/**
 * `a >>> b`（与 `>>>=`）：**不走 `js_bitop`，走 i32 那三条**（ADR-0013 第三刀那一组）。
 *
 * 理由是语义，不是省事：`js_bitop` 那一族只对 bigint 成立（方言的 int 就是 int64），
 * 而 JS 里的 `>>>` **是 32 位、而且对 BigInt 直接 TypeError** —— 它本来就不属于
 * 64 位那一族。ECMAScript 的定义是 `ToUint32(a) >>> (ToUint32(b) & 31)`，落到已有的
 * 两条 op 上正好是一层套一层：`u>>` 算出规范形 int32，`tou` 再把那些位当无符号读回来。
 * 这两条 op 的三份实现（`host/native.js`、`backend-js/prelude.js`、`omni_js_host.c`）
 * 早就对齐了，所以这儿一行都不用新加运行时。
 */
const ushr = (a, b) => op('js_i32_tou', [op('js_i32_op', [s16('u>>'), a, b])]);
const block = (stmts) => ({ kind: 'Block', stmts });
const exprStmt = (expr) => ({ kind: 'ExprStmt', expr });
const localStmt = (name, init) => ({ kind: 'Local', name, type: D, init });

/* ---------------------------------------------------------------- 降级器 */

/** C 标识符只认 [A-Za-z0-9_]，而 JS 名字里常有 `$` */
function cSafe(name) {
  return name.replace(/[^A-Za-z0-9_]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`);
}

/** 一个绑定模式里出现的所有名字（模块级要给每个名字开一个全局槽） */
function patternNames(pat, lower, span, out = []) {
  switch (pat.type) {
    case 'Ident': out.push(pat.name); break;
    case 'AssignPattern': patternNames(pat.left, lower, span, out); break;
    case 'ArrayPattern':
      for (const el of pat.elements) if (el) patternNames(el, lower, span, out);
      if (pat.rest) patternNames(pat.rest, lower, span, out);
      break;
    case 'ObjectPattern':
      for (const p of pat.props) patternNames(p.value, lower, span, out);
      if (pat.rest) patternNames(pat.rest, lower, span, out);
      break;
    default: lower.err(pat.span ?? span, `cannot bind with '${pat.type}'`);
  }
  return out;
}

/* ---- 捕获分析（6b）：只需要"哪些名字被内层函数引用过"，宁可多算不能少算 ---- */

/**
 * 一个 span 属于哪个源文件（P1：分文件发射的唯一依据）。
 *
 * span 里本来就挂着整个 SourceFile（见 eachChild 那句注释），所以这一格是**现成的** ——
 * 从前只是没往 OIR 传。没有它，42 万行 C 落在一个翻译单元里：编不快（clang -O1 要 137 秒）、
 * 不能并行、不能增量，也看不出是哪个源文件撑起来的。
 * 拿不到就交空串：调用方按"归到无主那一格"处理，而不是崩。
 */
function fileOfSpan(span) {
  return span && span.file && typeof span.file.path === 'string' ? span.file.path : '';
}

/** 遍历一个 AST 节点的子节点。跳过 span（里面挂着整个 SourceFile） */
function eachChild(node, f) {
  for (const k of Object.keys(node)) {
    if (k === 'span' || k === 'type') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === 'object') f(x);
    } else if (v && typeof v === 'object') {
      f(v);
    }
  }
}

/**
 * 子树里出现的所有标识符名。刻意**过度估计**（属性名、模式里的名字也收进来）：
 * 多算一个名字只会多做一个 cell 或多捕获一个已有的 cell，语义不会错；少算会错。
 */
function refNames(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Ident' && typeof node.name === 'string') out.add(node.name);
  eachChild(node, (x) => refNames(x, out));
  return out;
}

/** 这棵子树里给 `name` 赋过值吗（`n = …` / `n += …` / `n++`）—— 不进内层函数 */
function assignsName(node, name) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Arrow' || node.type === 'FuncExpr' || node.type === 'FuncDecl') return false;
  if ((node.type === 'Assign' || node.type === 'Update')
    && node.target && node.target.type === 'Ident' && node.target.name === name) return true;
  let hit = false;
  eachChild(node, (x) => { if (!hit) hit = assignsName(x, name); });
  return hit;
}

/** 子树里最外层的那些函数节点（不再往里钻 —— refNames 会把更深层一起收） */
function nestedFns(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Arrow' || node.type === 'FuncExpr' || node.type === 'FuncDecl') {
    out.push(node);
    return out;
  }
  /* 对象字面量与类里的方法/访问器**没有 type 字段**（解析器把它们摊成
   * `{ kind, key, params, rest, body }`，parser.js:908），而它们同样是"内层函数" ——
   * 漏掉它们，被它们引用的外层局部量就不会装 cell，捕获时就成了未定义的名字
   * （量出来的：`[Symbol.iterator]() { let i = 0; return { next() { … i … } }; }`
   * 报 "unresolved identifier 'i'"）。 */
  if (Array.isArray(node.params) && node.body && node.body.type === 'Block') {
    out.push(node);
    return out;
  }
  /* 类的**字段初始化式**也算："`#n = start` 里那句表达式是在 `$init` 那格闭包里跑的"
   * （classInitClosure），所以 start 是被内层引用的名字，外层得给它装 cell。
   * 漏掉它就是 "unresolved identifier 'start'" —— 量出来的：
   * `function f(start) { class C { #n = start; … } }`。 */
  if (node.kind === 'field' && node.value) {
    out.push(node);
    return out;
  }
  /* static 初始化块同理：那一段是在一格无参闭包里跑的（classProtoStmts 的 staticBlock 那一支），
   * 所以块里提到的外层名字也得装 cell。量出来的：函数里 `class A { static { A.x = 1; } }`
   * 报 unresolved 'A'（类名自己就是外层那格 let 绑定）。 */
  if (node.kind === 'staticBlock' && node.body) {
    out.push(node);
    return out;
  }
  eachChild(node, (x) => nestedFns(x, out));
  return out;
}

/** 类的原型对象那一格全局的名字（ADR-0020 P1-f） */
function protoGlobalName(id) {
  return `proto_of_${id}`;
}

/** 类对象上放"初始化实例的那个闭包"的内部键。`new C()` 与（以后的）`super(...)` 都查它。 */
/* 类对象上那格"初始化实例的闭包"用的是一个**符号键**（不是字符串 "$init"）：
 * 符号键不进 Object.getOwnPropertyNames，也不进 JSON —— 从前它是字符串键，
 * `Object.getOwnPropertyNames(B)` 里于是多出一格 $init（量出来的静默分叉）。 */
const CLASS_INIT_WK = 'omni.classInit';
const classInitKey = () => op('js_sym_wk', [], { wk: CLASS_INIT_WK });

/**
 * 对象字面量里的方法/访问器拼回一个函数节点（ADR-0020 P1）。
 *
 * 解析器把它们摊成 `{ params, rest, body }` 而**没有** `value` 那一格（parser.js:908），
 * 而闭包降级（closureOf）吃的是一个函数节点。所以这儿补一个 FuncExpr 形状出来 ——
 * 不是 Arrow：方法有自己的 `this`（箭头的 this 是外层的）。
 */
function fnNodeOfProp(p) {
  return {
    type: 'FuncExpr', id: null, params: p.params, rest: p.rest, body: p.body, span: p.span,
    // 生成器方法（ADR-0020 P2）：`*m() {}` 的那一格标记要跟着传下去，closureOf 靠它改写
    generator: p.generator === true,
    async: p.async === true,
  };
}

/** 这一层函数里，会被内层函数引用到的名字 —— 它们的局部量要装进 cell */
function capturedNames(stmts) {
  const out = new Set();
  for (const s of stmts) for (const fn of nestedFns(s)) refNames(fn, out);
  return out;
}

/**
 * 这个函数体里提到 `this` 了吗（ADR-0020 P1）。
 *
 * `super` 也算：`super.m()` 要拿当前的接收者当 this（不然 this 会变成父类的原型），
 * 而方法体里完全可以只写 `super.m()` 一句、根本不提 `this`。
 *
 * 钻进箭头、**不钻**进普通函数与方法：箭头的 this 是外层的（所以外层得把它装进 cell 传下去），
 * 而普通函数有自己的 this（它自己入口取一次就行，不该逼外层也开一格）。
 */
function mentionsThis(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'This') return true;
  if (node.type === 'Ident' && node.name === 'super') return true;
  if (node.type === 'FuncExpr' || node.type === 'FuncDecl' || node.type === 'ClassDecl'
    || node.type === 'ClassExpr') return false;
  /* 对象字面量里的方法与访问器（`{ next() { this.i } }`）也是**普通函数** —— 它们身上
   * 没有 type，只有 method: true（见 parser 的 objectLit），所以要单独挡一道。漏了这一道
   * 的后果是：外层函数会以为"我的体里提到了 this"、开一格 this 并装进 cell，方法于是
   * 捕获外层那一个而不是自己的接收者 —— 量出来的：mk() 里造的对象，m.next() 里 this 是
   * undefined。 */
  if (node.method === true) return false;
  let hit = false;
  eachChild(node, (x) => { if (!hit) hit = mentionsThis(x); });
  return hit;
}

/** 这个函数体里提到 `new.target` 了吗（钻箭头，不钻普通函数 —— 与 mentionsThis 同理） */
function mentionsNewTarget(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'NewTarget') return true;
  if (node.method === true) return false;
  if (node.type === 'FuncExpr' || node.type === 'FuncDecl' || node.type === 'ClassDecl'
    || node.type === 'ClassExpr') return false;
  let hit = false;
  eachChild(node, (x) => { if (!hit) hit = mentionsNewTarget(x); });
  return hit;
}

/* ---- 精确那一问：这个名字**真的**被内层闭包捕获了吗（只有 `for` 那条拒绝用它） ----
 *
 * 上面那几个是**保守**的（宁可多算），对 cell 分配无害 —— 多一个 cell 只是多一层下标。
 * 但 `forStmt()` 把这个保守结论接到了一条**硬拒绝**上，保守 + 硬拒绝 = 假红。
 * 量到过（十二行复现）：内层闭包里只要有个**同名**的局部量，外层那个循环变量就被骂
 * 「被闭包捕获」，而那个循环体里一个闭包都没有。
 *
 * 所以拒绝那一条问的是**自由变量**：
 *
 *   free(fn) = ( fn 体内、不进内层函数的标识符 ∪ ⋃ free(g) ) - bound(fn)
 *   bound(fn) = 形参 + fn 自己声明的名字（**不含**内层函数里声明的）
 *
 * 过度估计的方向要挑对：`bound` 少收一个 -> `free` 多一个 -> 可能假红（只是烦）；
 * `bound` 多收一个 -> `free` 少一个 -> **漏掉真捕获，语义会错**。所以 `bound` 只收
 * 明摆着是绑定的那些，拿不准的一律不收。
 */

const isFnNode = (n) => n.type === 'Arrow' || n.type === 'FuncExpr' || n.type === 'FuncDecl';

/** fn.length（ADR-0020）：**第一个带默认值的形参之前**有几个（规范如此，rest 不算） */
function fnArity(params) {
  let n = 0;
  for (const p of params) {
    if (p.type === 'AssignPattern') break;
    n += 1;
  }
  return n;
}

/** 子树里的标识符，**遇到内层函数就停**。 */
function shallowRefs(node, out = new Set(), top = true) {
  if (!node || typeof node !== 'object') return out;
  if (!top && isFnNode(node)) return out;
  if (node.type === 'Ident' && typeof node.name === 'string') out.add(node.name);
  eachChild(node, (x) => shallowRefs(x, out, false));
  return out;
}

/** 子树里的**声明名**，遇到内层函数就停（但那个函数自己的名字要收 —— 它绑在外面）。
 *
 * 名字里带 `Local` 是因为 `link.js` 已经有一个 `declNames` —— 模块作用域的名字在整份
 * 程序里唯一（棘轮的第一条断言就是它，这一处当场被抓到过）。 */
function declNamesLocal(node, out, sink, top = true) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'FuncDecl' && typeof node.id === 'string') out.add(node.id);
  if (node.type === 'ClassDecl' && typeof node.id === 'string') out.add(node.id);
  if (!top && isFnNode(node)) return out;
  if (node.type === 'VarDecl' && Array.isArray(node.decls)) {
    for (const d of node.decls) for (const n of patternNames(d.id, sink, node.span)) out.add(n);
  }
  if (node.param && (node.type === 'Catch' || node.type === 'CatchClause')) {
    for (const n of patternNames(node.param, sink, node.span)) out.add(n);
  }
  eachChild(node, (x) => declNamesLocal(x, out, sink, false));
  return out;
}

/** `fn` 自己绑的名字。`sink` 吞掉诊断：这一问不报错，拿不准的名字宁可不收。 */
function boundNames(fn) {
  const out = new Set();
  /* 写成属性里放一个箭头函数，不用方法简写 —— 对象字面量里的方法与访问器还没降。 */
  const sink = { err: () => {} };
  for (const p of fn.params ?? []) for (const n of patternNames(p, sink, fn.span)) out.add(n);
  if (typeof fn.id === 'string') out.add(fn.id);
  declNamesLocal(fn.body, out, sink);
  return out;
}

/** 这一层里 `var` 声明的名字（不钻进内层函数；`for (var i …)` 的 init 也算）。
 *
 * `var` 是**函数**作用域的，所以它们要在栈帧入口一次立好 —— 块里、if 里、循环里写的
 * `var` 出了块还看得见（量出来的：`{ var x = 1; } return x;` 从前报 unresolved 'x'）。 */
function varNames(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (isFnNode(node)) return out;
  if (node.type === 'VarDecl' && node.kind === 'var' && Array.isArray(node.decls)) {
    const sink = { err: () => {} };
    for (const d of node.decls) for (const n of patternNames(d.id, sink, node.span)) out.add(n);
  }
  eachChild(node, (x) => varNames(x, out));
  return out;
}

/** 直接嵌在 `fn` 里的那些函数（不含 `fn` 自己）。 */
function directNestedFns(fn) {
  const out = [];
  eachChild(fn, (x) => nestedFns(x, out));
  return out;
}

/** `fn` 里**自由**出现的名字。 */
function freeNames(fn, out = new Set()) {
  const bound = boundNames(fn);
  const mine = shallowRefs(fn);
  for (const g of directNestedFns(fn)) freeNames(g, mine);
  for (const n of mine) if (!bound.has(n)) out.add(n);
  return out;
}


/**
 * 这个**源码层**的语句会不会把控制流带走（switch 的穿透检查用）。
 * 带花括号的 case 体（`case 'x': { …; return 0; }`）是一个 Block，所以要往里看一层；
 * if/else 两边都带走也算。其它的（循环里 break、标签之类）一律当"会掉下去"。
 */
function endsControl(st) {
  if (!st) return false;
  if (['Break', 'Continue', 'Return', 'Throw'].includes(st.type)) return true;
  if (st.type === 'Block') return endsControl(st.body[st.body.length - 1]);
  if (st.type === 'If') return !!st.alt && endsControl(st.cons) && endsControl(st.alt);
  return false;
}

/**
 * 这段**降完的** OIR 里有没有可能往 pending 槽里放东西（ADR-0011 决策 14）。
 * 调用一律算；成员派发器的兜底会调用户的函数（决策 12），所以 js_m_* 也算；
 * 其余的 op 看表里的 throws 标记（回调类的 op、以及会抛的宿主调用）。
 */
function mayThrow(node) {
  if (Array.isArray(node)) return node.some(mayThrow);
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'Call' || node.kind === 'CallFn') return true;
  if (node.kind === 'Builtin' && (node.name.startsWith('js_m_') || JS_ALL[node.name]?.throws)) return true;
  for (const k of Object.keys(node)) {
    // type / from / fnType 里装的是类型，不是 OIR 节点
    if (k === 'type' || k === 'from' || k === 'fnType') continue;
    if (mayThrow(node[k])) return true;
  }
  return false;
}

/**
 * 这一句是不是"一次 pending 检查"（`if (js_pending()) <退出这一层>`）。
 * 只按形状认：条件是 js_pending()、没有 else。withCheck 用它去掉紧挨着的第二次检查。
 */
function isPendingCheck(st) {
  return st !== null && typeof st === 'object' && st.kind === 'If' && st.otherwise === null
    && st.cond !== undefined && st.cond !== null
    && st.cond.kind === 'Builtin' && st.cond.name === 'js_pending';
}

class Lower {  /** @param {import('../source/diag.js').Diagnostics} diags */
  constructor(diags) {
    this.diags = diags;
    this.funcs = [];
    /** 模块级的 const/let/var：名字 -> 全局槽（后端各发一个真全局） */
    this.globals = new Map();
    /** 正在降级第几句顶层语句（TDZ 的静态判据要它；不在顶层时是 null） */
    this.topIdx = null;
    /** 带标签模板的站点计数（每个站点一格模块级的槽，见 template） */
    this.tplSites = 0;
    // 类表达式的合成表键（见 classExpr）—— 与模板站点那格计数同一招
    this.clsSites = 0;
    /** 顶层函数声明：名字 -> mangled。互相递归靠的就是先收一遍再降级 */
    this.topFns = new Map();
    /** 顶层函数的形参个数（fn.length 要它；topFnValue 那边已经看不到形参表） */
    this.topFnLens = new Map();
    /** 初始化式是正则字面量的模块级 const：名字 -> {body, flags}（ADR-0011 决策 10） */
    this.regexConsts = new Map();
    this.used = new Set();
    /** 顶层类声明：名字 -> {mangled, node}（降成一个"造实例"的函数，ADR-0011 决策 13） */
    this.classes = new Map();
    /** 原生宿主面：名字 -> ABI op（由链接器给出，见 frontend-js/link.js） */
    this.natives = new Map();
    /** 外部 C 符号：名字 -> C_ABI 里那一条（ADR-0014 决策 4） */
    this.cnatives = new Map();
    /** 这个模块真用到的 C_ABI 条目，按首次出现排序 —— C 后端靠它发 extern 与 -l */
    this.cused = [];
    /** 闭包记录（ADR-0010 的布局），MakeClosure 的 closure 下标就是这里的位置 */
    this.closures = [];
    /** 顶层函数当值用时的转发闭包：名字 -> 闭包记录（一个函数只生成一次） */
    this.fnValues = new Map();
    /** 内建函数当值用时的薄包装：路径（'Object.keys' / 'Number'） -> 闭包记录 */
    this.builtinFns = new Map();
    this.fn = null;
  }

  err(span, msg) {
    this.diags.error(span ?? null, msg);
  }

  mangle(prefix, name) {
    let m = `${prefix}${cSafe(name)}`;
    let i = 2;
    while (this.used.has(m)) m = `${prefix}${cSafe(name)}__${i++}`;
    this.used.add(m);
    return m;
  }

  /** 模块：先把顶层的声明收全（JS 的函数声明是提升的），再逐个降级 */
  module(program) {
    // 原生宿主面（ADR-0011 决策 17）：链接器给出"名字 -> ABI op"，这些名字只能被调用
    this.natives = program.natives ?? new Map();
    this.cnatives = program.cnatives ?? new Map();
    program.body.forEach((s, i) => this.collectTop(s, i));
    for (const s of program.body) {
      if (s.type === 'FuncDecl') this.funcDecl(s);
    }
    for (const s of program.body) {
      if (s.type === 'ClassDecl') this.classDecl(s);
    }
    // 顶层的其余语句是 omni_main 的函数体；模块级变量的初始化也在这里发生
    // file：整批顶层就是一个模块，取第一句所在的文件（P1，见 fileOfSpan）
    const main = {
      name: 'main',
      mangled: 'omni_main',
      file: program.body.length > 0 ? fileOfSpan(program.body[0].span) : '',
      ret: { k: 'void' },
      params: [],
      body: null,
    };
    this.fn = this.newFrame(program.body, { isMain: true });
    const stmts = [];
    program.body.forEach((s, i) => {
      if (s.type === 'FuncDecl') return;
      // TDZ 的静态判据要"现在在第几句"（见 expr 里 globals 那一格）
      this.topIdx = i;
      stmts.push(...this.stmt(s));
    });
    this.topIdx = null;
    main.body = block([...this.fn.prelude, ...stmts, ...this.jobsTail()]);
    this.fn = null;
    this.funcs.push(main);
    return {
      structs: [],
      classes: [],
      // dyn 桥与所有 js_* op 的发射条件（backend-c 的 dynBridge）：这两个实例必须在。
      // list<string> 是被 dict<string,dynamic> 的 _keys 拖进来的。
      containers: [listType(STRING), listType(D), dictType(STRING, D)],
      closures: this.closures,
      // JS 的函数值只有一种签名，所以调用助手也只需要一个
      fnTypes: [JS_FN],
      jsGlobals: [...this.globals.values()],
      funcs: this.funcs,
      entry: 'omni_main',
      // 这个模块里的函数值一律是 ABI 里 JS 的那个唯一签名 fn(list<dynamic>) -> dynamic：
      // 形参不是位置实参，而是**整条实参表**。解释器造闭包记录时要按这个口径接
      // （interp/eval.js 的 makeClosure）—— 两个后端是发射期就知道的，解释器只能看模块。
      js: true,
      // 用到的外部 C 符号（ADR-0014 决策 4）。空数组是常态 —— 只有真去调 C 的模块才非空。
      cabi: this.cused,
    };
  }

  collectTop(s, i) {
    /* 块里写的 `var` 也是这一层的（var 是函数作用域的，模块顶层就是全局槽）——
     * 从前只收顶层那一句，于是 `{ var x = 1; } console.log(x);` 当场报 unresolved 'x'。
     * 不带 lexIdx：TDZ 是 let / const 的事，var 声明前读到 undefined 是对的。 */
    if (s.type !== 'FuncDecl' && s.type !== 'ClassDecl') {
      for (const n of varNames(s)) {
        if (!this.globals.has(n)) this.globals.set(n, { name: cSafe(n), lexIdx: undefined });
      }
    }
    switch (s.type) {
      case 'FuncDecl':
        if (this.topFns.has(s.id)) this.err(s.span, `duplicate function '${s.id}'`);
        this.topFns.set(s.id, this.mangle('u_', s.id));
        // fn.length 要形参个数（ADR-0020）：顶层函数取值时（topFnValue）已经看不到形参表了
        this.topFnLens.set(s.id, fnArity(s.params));
        break;
      case 'VarDecl':
        for (const d of s.decls) {
          // 不带 g / y 的正则可以当"编译期常量"折到使用点上，不占全局槽：它没有可观察的
          // 状态（lastIndex 谁都不碰），折一份和共用一份不可区分。
          // **带 g 或 y 的不行** —— lastIndex 是那一格自己的状态，`re.exec(s)` 的循环靠它
          // 推进、sticky 的 test 也一格格往前挪，折到使用点就成了每次一格新的：循环永远停在
          // 第一个匹配上、sticky 的 lastIndex 永远是 0（ADR-0011 决策 10；y 那一格是量出来的）。
          if (s.kind === 'const' && d.id.type === 'Ident' && d.init && d.init.type === 'Regex'
            && !d.init.flags.includes('g') && !d.init.flags.includes('y')) {
            this.regexConsts.set(d.id.name, { body: d.init.body, flags: d.init.flags });
            continue;
          }
          for (const n of patternNames(d.id, this, s.span)) {
            // lexIdx 只给 let / const：TDZ 是它们的事，var 声明前读到 undefined 是对的
            this.globals.set(n, { name: cSafe(n), lexIdx: s.kind === 'var' ? undefined : i });
          }
        }
        break;
      case 'ClassDecl': {
        if (this.classes.has(s.id)) this.err(s.span, `duplicate class '${s.id}'`);
        // 继承只支持 `extends Error`（量过：全仓库三处，全是异常类）。异常类的实例带一条
        // $cls 链，instanceof 查的就是它（ADR-0011 决策 15）
        const sup = s.superClass;
        /* Error 那一族全收（不只 `extends Error`）：`class E extends TypeError {}` 也是
         * 异常类，实例带的 $cls 链是 [E, TypeError, Error] —— catch 的类型判断与
         * name 都顺着它走。从前只认 Error，别的名字落到"这个文件里没声明过"那条错上，
         * 而且报错之后还往下走、在 supProto 那儿当场崩（量出来的内部异常）。 */
        const supErr = sup && sup.type === 'Ident' && ERROR_CTORS.has(sup.name) ? sup.name : null;
        const isError = supErr !== null;
        /* `extends`（ADR-0020 P1-f）：Error 那一支照旧走 `$cls` 链；别的收**这个文件里
         * 声明过的类名** —— 原型链要拿到父类的原型对象与 `$init`，而那两格是模块级全局。
         * 任意表达式（`class C extends mixin(B)`）还不收，那要先有"类当值"。 */
        const superName = !isError && sup ? (sup.type === 'Ident' ? sup.name : null) : null;
        if (!isError && sup && superName === null) {
          this.err(s.span, "'extends <expression>' is not supported; extend a class declared in this file");
        }
        this.classes.set(s.id, { mangled: this.mangle('n_', s.id), node: s, isError, superName, errBase: supErr });
        /* 非 Error 的类走**原型链**那条新路（ADR-0020 P1-f）：类对象与原型对象各占一格
         * 模块级全局 —— 方法只能建一次（每次 new 重建原型的话
         * `getPrototypeOf(a) === getPrototypeOf(b)` 就假了），而类名本身要在整个模块可见
         * （`C.staticM()`、`C.prototype`、`x instanceof C` 都是查它）。
         * 原型那一格的名字带前缀，撞上用户自己的同名变量的可能性留在这儿，不装作没有。 */
        if (!isError) {
          this.globals.set(s.id, { name: cSafe(s.id) });
          this.globals.set(protoGlobalName(s.id), { name: cSafe(protoGlobalName(s.id)) });
        }
        break;
      }
      case 'ImportDecl': case 'ExportNamed': case 'ExportDefault': case 'ExportDecl':
        this.err(s.span, 'import/export are not lowered yet (ADR-0011 landing step 6e)');
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------- 作用域与临时量 */

  pushScope() { this.fn.scopes.push(new Map()); }
  popScope() { this.fn.scopes.pop(); }

  /**
   * 声明一个局部量。名字在**整个函数里**去重（不靠块级作用域来遮蔽）：OIR 的 Block
   * 虽然会发花括号，但 for-of / switch 的降级会插进合成的块，去重最省心。
   *
   * 会被内层函数引用到的名字装进 **cell**（一个单元素数组）：JS 的捕获是按引用的，
   * 闭包里写一下、外面就得看见；而 OIR 的闭包捕获是按值的（ADR-0010）。让捕获变成
   * "共享同一个数组对象"就对上了，代价是这些变量多一层下标。不做赋值分析：只要有
   * 内层函数提到过这个名字就装 cell（宁可多装，不能少装）。
   */
  declare(name) {
    let uniq = cSafe(name);
    let i = 2;
    while (this.fn.locals.has(uniq)) uniq = `${cSafe(name)}__${i++}`;
    this.fn.locals.add(uniq);
    const ent = { kind: this.fn.captured.has(name) ? 'cell' : 'local', name: uniq };
    this.fn.scopes[this.fn.scopes.length - 1].set(name, ent);
    return ent;
  }

  /** @returns {{kind:'local'|'cell'|'capture', name:string}|null} */
  lookup(name) {
    for (let i = this.fn.scopes.length - 1; i >= 0; i--) {
      const hit = this.fn.scopes[i].get(name);
      if (hit !== undefined) {
        // 捕获层里的名字只有**真被引用**才进闭包记录：refNames 是过度估计的
        if (hit.kind === 'capture') this.fn.uses.add(name);
        return hit;
      }
    }
    return null;
  }

  /** 声明落地成一条 Local：cell 要包一层单元素数组 */
  declStmt(ent, init) {
    return localStmt(ent.name, ent.kind === 'cell' ? arrLit([init]) : init);
  }

  /** cell 本身：局部量里存着，或者从闭包记录上读 */
  cellOf(ent) {
    return ent.kind === 'capture' ? dyn('CaptureRef', { name: ent.name }) : varRef(ent.name);
  }

  /** 读一个绑定 */
  readEntry(ent) {
    if (ent.kind === 'local') return varRef(ent.name);
    return op('js_arr_get', [this.cellOf(ent), constReal(0)]);
  }

  /** 写一个绑定；这是个表达式，值是刚写进去的那个 */
  writeEntry(ent, v) {
    if (ent.kind === 'local') return assign(varRef(ent.name), v);
    return op('js_idx_set', [this.cellOf(ent), constReal(0), v]);
  }

  /** 临时量：声明提到函数开头（声明没有副作用，提上去是安全的），赋值留在表达式里 */
  temp() {
    const n = `_t${this.fn.temps++}`;
    this.fn.locals.add(n);
    this.fn.prelude.push(localStmt(n, undefExpr()));
    return n;
  }

  /* -------------------------------------------------------- 函数 */

  funcDecl(s) {
    const f = this.genFix(s);
    this.funcs.push(this.funcOf(s.id, this.topFns.get(s.id), f.params, f.rest, f.body.body, f.span));
  }

  /** 生成器与 async（ADR-0020 P2）：`function*` / `async function` 在这儿先被改写成
   * 一台状态机（genfn.js），降级器自己因此不用认识 Yield / Await —— 它看到的是普通函数体。 */
  genFix(node) {
    if (node.generator !== true && node.async !== true) return node;
    return genToStateMachine(node, (sp, msg) => this.err(sp, msg));
  }


  /** 一个新的函数栈帧。opts.outerScopes 给出捕获层（只有 cell 能被捕获） */
  newFrame(bodyStmts, opts) {
    const fn = {
      temps: 0, prelude: [], loops: 0, switches: 0,
      scopes: [new Map()], locals: new Set(['args']), sink: [], lazies: 0,
      captured: capturedNames(bodyStmts), uses: new Set(), isMain: !!opts.isMain,
      // try 的嵌套深度，以及每层 try 进去时的循环层数（用来拦跨 try 的 break/continue）
      tries: 0, tryLoops: [],
      // 每层 try 进去时的 OIR 循环层数（带标签的跳转要用它拦"跳过 catch"）
      tryOLoops: [],
      /* 带 finally 的 try：从体里 return / break / continue 出去要**先跑清理**。
       * 每层记一格 { unw, rv, loops, switches, oloops }：unw 是"为什么出去"
       * （1 return / 2 break / 3 continue），rv 是 return 的值，后三个是进 try 时的
       * 层数快照（用来判断这一句是被里面的循环接住、还是真要跳出 try）。 */
      finStack: [],
      // 每层 switch 进去时的循环层数，以及那层的"出去之后要 continue"标志位（懒声明）
      switchLoops: [], switchFlags: [],
      /* 无标签 break / continue 该跳到哪一层 OIR 循环：每层真循环与每个 switch 压一格
       * （switch 那格 cont 是 false —— continue 不认它）。try 摊出来的那层合成循环**不**压，
       * 它不是跳转目标；跨过它就是"多跳一层"，见 Break / Continue 那两支。 */
      targets: [],
      /* 还开着的 for-of 把手（{name, ol}）：`return` 与"带标签跳到外层去"会跳过循环后面
       * 那一句 close，所以在那两处按内层到外层补上（见 iterCloses）。 */
      iters: [],
      // **OIR 的**循环层数，以及每个还在作用域里的标签记下的那一层。
      // 与 loops 的差别是它把合成的循环也算进去（switch / try / do-while 各摊出一个
      // while(true)）—— OIR 的 Break/Continue 的 level 数的正是 OIR 的层数，
      // 所以带标签的跳转只能按这个数算。
      oloops: 0, labels: [],
    };
    if (opts.outerScopes) {
      // 外层可见的 cell 全摆进捕获层；lookup 命中过的才会真进闭包记录
      const cap = new Map();
      for (const sc of opts.outerScopes) {
        for (const [n, ent] of sc) {
          if (ent.kind === 'cell' || ent.kind === 'capture') cap.set(n, { kind: 'capture', name: ent.name });
        }
      }
      fn.scopes = [cap, new Map()];
    }
    return fn;
  }

  funcOf(name, mangled, params, rest, bodyStmts, span, opts = {}) {
    const outer = this.fn;
    this.fn = this.newFrame(bodyStmts, opts);
    /* 形参默认值里的闭包也要算捕获（`function f(x, y = () => x)`）：capturedNames 只扫体，
     * 于是从前那个箭头里的 x 是"未定义的名字"（量出来的 —— 直接写 `y = x + 1` 是通的，
     * 只有装进闭包那一格漏了）。形参自己就是这一帧的局部量，加进 captured 就够了。 */
    for (const n of capturedNames(params)) this.fn.captured.add(n);
    const stmts = [];
    /* `this`（ADR-0020 P1）：普通函数与方法自己在**入口**取一次接收者。
     * 两种情况不取：
     *   - 箭头（`opts.isArrow`）：它的 this 是外层那一个，靠 cell 捕获拿到；
     *   - 构造器（`opts.isCtor`）：那一格是 classDecl 自己造的实例。
     * 从前还有第三条"外层已经有 this 就不取"（ADR-0011 决策 13 的遗留）。P1-f 把类改成
     * 原型链之后它就该翻过来了 —— 量出来的分叉：类方法里造的对象字面量，它自己的方法
     * `get2()` 里 this 是**外层实例**而不是那个字面量（qjs 给 9，这边给 1）。
     * 提到 this 才发这一句：每个函数都发就是每次调用多一次 op，而量过的源码里绝大多数
     * 函数根本不提它。加进 captured 是为了内层箭头能把它当 cell 捕获下去。 */
    if (!opts.isArrow && !opts.isCtor
      && (opts.wantThis === true || bodyStmts.some((s) => mentionsThis(s)))) {
      this.fn.captured.add('this');
      const self = this.declare('this');
      stmts.push(this.declStmt(self, op('js_this_take', [])));
    }
    /* new.target（ADR-0020）：与 this 同一个路子 —— 入口取一次存进一格临时量。提到了才发
     * 这一句。箭头也自己取（拿到的是 undefined）：那一格要跟着外层走的话得装 cell，
     * 而量过的源码里没有"箭头里读 new.target"这种写法。 */
    if (bodyStmts.some((s) => mentionsNewTarget(s))) {
      const nt = this.temp();
      stmts.push(exprStmt(assign(varRef(nt), op('js_nt_take', []))));
      this.fn.ntLocal = nt;
    }
    /* `pre`：在**取完接收者、绑形参之前**插几句。类的实例字段就是这么进去的
     * （ADR-0020 P1-f）：规范里字段在构造器体之前初始化，而且它们看不见构造器的形参。 */
    if (opts.pre) stmts.push(...opts.pre());
    // 这一帧属于哪个类（`super.m()` 与 `super(...)` 要靠它找父类，ADR-0020 P1-f）
    if (opts.classOf) this.fn.classOf = opts.classOf;
    // 静态方法：super 指着**父类对象**而不是父类原型（见 superProtoRef）
    if (opts.staticSuper === true) this.fn.staticSuper = true;
    // 箭头没有自己的 arguments（规范如此）—— `arguments` 那一格要认得出来
    this.fn.isArrowFn = opts.isArrow === true;
    params.forEach((p, i) => stmts.push(...this.bindParam(p, i, span)));
    if (rest) {
      if (rest.type !== 'Ident') this.err(span, 'destructuring a rest parameter is not supported');
      const ent = this.declare(rest.type === 'Ident' ? rest.name : '_rest');
      stmts.push(this.declStmt(ent, op('js_arr_slice', [argsDyn(), constReal(params.length), undefExpr()])));
    }
    stmts.push(...this.hoistVars(bodyStmts));
    stmts.push(...this.preCells(bodyStmts));
    stmts.push(...this.hoistFuncDecls(bodyStmts));
    for (const st of bodyStmts) stmts.push(...this.stmt(st));
    const f = {
      name,
      mangled,
      /* 定义在哪个源文件（P1）。span 里挂着整个 SourceFile，所以这一格是**现成的**，
       * 只是从前没往下传。它是"分文件发射"与"按文件看产出分布"的唯一依据 ——
       * 今天 C 那侧的名字里没有模块痕迹，于是 42 万行落在一个翻译单元里，
       * 既编不快也看不出是谁撑起来的。 */
      file: fileOfSpan(span),
      ret: D,
      params: [{ name: 'args', type: listType(D) }],
      // JS 的函数走到底没 return 就是 undefined；OIR 要求非 void 的函数有返回值
      body: block([...this.fn.prelude, ...stmts, { kind: 'Return', value: undefExpr() }]),
    };
    const uses = this.fn.uses;
    const capScope = opts.outerScopes ? this.fn.scopes[0] : null;
    this.fn = outer;
    // 捕获表在**外层**这边解释：MakeClosure 的实参是外层的那些 cell
    f.captureList = capScope ? [...uses].map((n) => capScope.get(n)) : [];
    return f;
  }

  /**
   * `var` 是**函数**作用域的：块里、if 里、循环里写的 `var` 出了块还看得见，声明之前读它
   * 是 undefined 而不是错。所以栈帧入口把这一层所有 `var` 的名字一次立好（值 undefined），
   * 声明那一句只剩"写一次"（见 varDecl 里那一支）。从前它们跟 let 一样按块声明 ——
   * `{ var x = 1; } return x;` 于是当场报 unresolved 'x'（量出来的）。
   * 形参同名（`function f(p){ var p = p + 1; }`）不另立一格：规范里那就是同一个绑定。
   * main 那一帧不走这条路 —— 那儿的 var 是真全局（collectTop 收，块里的也收）。
   */
  hoistVars(bodyStmts) {
    if (this.fn.isMain) return [];
    const names = new Set();
    for (const s of bodyStmts) varNames(s, names);
    if (!names.size) return [];
    this.fn.varNames = names;
    const scope = this.fn.scopes[this.fn.scopes.length - 1];
    const out = [];
    for (const n of names) {
      if (scope.has(n)) continue;
      const ent = this.declare(n);
      ent.varSlot = true;
      out.push(this.declStmt(ent, undefExpr()));
    }
    return out;
  }

  /**
   * 提升的嵌套函数声明在**入口**就造出来（规范：体首就看得见它），可它们引用的名字常常是
   * 体里后面才声明的 —— 造闭包那一刻作用域里还没有，于是
   * `function outer(){ const v = 1; function inner(){ return v; } }` 当场报
   * unresolved 'v'（箭头与函数表达式没这毛病：它们在声明之后才降级）。
   * 所以入口先给"被闭包引用的、这一层体**顶层**声明的"名字各立一格 cell（值先是
   * undefined），到声明那一句再往里写（defineVar 认得出这一格是预立的）。
   * 只管顶层：块里的声明另有作用域，提到帧入口来就把生存期改宽了。
   * main 那一帧不走这条路 —— 那儿的顶层名字是真全局，defineVar 有自己的一支。
   */
  preCells(bodyStmts) {
    // main 的**顶层**名字是真全局（defineVar 有自己的一支）；它里面的块照常走这条路
    if (this.fn.isMain && this.fn.scopes.length === 1) return [];
    const sink = { err: () => {} };
    const scope = this.fn.scopes[this.fn.scopes.length - 1];
    const out = [];
    for (const s of bodyStmts) {
      /* 块里 / 体里的类声明也是一格 let 绑定（见 stmt 的 ClassDecl 那一支），而且**必须**
         走这条路：方法体里的 `new Point(…)` 捕获的就是这个名字，按值捕获会在类值还没装进去
         之前就取一次 —— 量出来的是 "Cannot access 'v_Point' before initialization"。 */
      if (s.type === 'ClassDecl' && typeof s.id === 'string') {
        if (!this.fn.captured.has(s.id) || scope.has(s.id)) continue;
        const ent = this.declare(s.id);
        ent.pre = true;
        out.push(localStmt(ent.name, arrLit([undefExpr()])));
        continue;
      }
      // 只管 let / const：var 是函数作用域的，它那一格由 hoistVars（或 main 的全局槽）立
      if (s.type !== 'VarDecl' || s.kind === 'var') continue;
      for (const d of s.decls) {
        for (const n of patternNames(d.id, sink, s.span)) {
          if (!this.fn.captured.has(n) || scope.has(n)) continue;
          const ent = this.declare(n);
          ent.pre = true;
          out.push(localStmt(ent.name, arrLit([undefExpr()])));
        }
      }
    }
    return out;
  }

  /**
   * 嵌套的函数声明是提升的，而且可以互相递归。所以在栈帧入口分两趟：先给每个名字
   * 立一个 cell（值先是 undefined），再逐个造闭包填进去 —— 这样第二趟里造的闭包
   * 捕获到的都是已经存在的 cell，互相递归就通了。
   */
  hoistFuncDecls(bodyStmts) {
    const decls = bodyStmts.filter((s) => s.type === 'FuncDecl');
    if (!decls.length) return [];
    // 记名字而不是记节点：这个值域里的 Set 键是"值"，对象没有身份（决策 1），
    // 而这个文件自己也要被降级。同一个函数体里的函数名本来就不会重
    this.fn.hoisted = new Set(decls.map((d) => d.id));
    const out = [];
    const ents = [];
    for (const d of decls) {
      this.fn.captured.add(d.id);   // 提升的函数名一律装 cell，两趟才好分
      const ent = this.declare(d.id);
      ents.push(ent);
      out.push(this.declStmt(ent, undefExpr()));
    }
    decls.forEach((d, i) => {
      out.push(exprStmt(this.writeEntry(ents[i], this.closureExpr(d, d.id))));
    });
    return out;
  }


  /**
   * 函数值（Arrow / FuncExpr / 嵌套的 FuncDecl），ADR-0011 落地第 6b 步。
   * 体降级成一个独立的 OIR 函数（带 closureId），捕获的 cell 拷进闭包记录。
   * @returns {{expr: any, closure: any}}
   */
  closureOf(node, label, extra = {}) {
    node = this.genFix(node);
    const id = this.closures.length;
    const mangled = this.mangle('l_', label);
    /* fn.name / fn.length（ADR-0020）：名字优先用调用点给的（方法名），其次是函数
     * 表达式自己的名字；箭头没有（规范里它的 name 来自赋值目标，那一格还没做）。 */
    const rec = {
      id, mangled, make: `omni_mk_${mangled}`, captures: [],
      fnName: extra.fnName !== undefined ? extra.fnName
        : (typeof node.id === 'string' ? node.id : ''),
      /* length 一般就是"到第一个默认值为止的形参个数"，但内建的薄包装要能盖掉它 ——
       * 包装的形参个数是 **op 的**（js_math 收 2 个），而 Math.abs.length 是 1。 */
      fnLen: extra.fnLen !== undefined ? extra.fnLen : fnArity(node.params),
      ...(extra.single === true ? { single: true } : {}),
    };
    this.closures.push(rec);   // 先占位：体里的嵌套闭包会往后追加，id 不能变
    // 箭头的表达式体等价于 { return expr; }
    const bodyStmts = node.type === 'Arrow' && node.expression
      ? [{ type: 'Return', arg: node.body, span: node.span }]
      : node.body.body;
    // 具名函数表达式引用自己那一支在 closureExpr 里已经处理（外层一格 cell），
    // 走到这儿的 id 只当 fn.name 用
    const f = this.funcOf(label, mangled, node.params, node.rest, bodyStmts, node.span, {
      outerScopes: this.fn.scopes,
      // 箭头的 this 是**外层**的（词法的），所以它自己不去取接收者
      isArrow: node.type === 'Arrow',
      ...extra,
    });
    f.closureId = id;
    rec.captures = f.captureList.map((e) => ({ name: e.name, type: D }));
    this.funcs.push(f);
    return rec;
  }

  /**
   * 类（ADR-0011 决策 13）。降成一个"造实例"的函数：实例就是普通对象，方法是**每个
   * 实例一份的闭包**，都捕获同一个 `this` cell。量过：编译器源码里 14 个类，每个类的
   * 实例只有 1~6 个，所以"每实例一份闭包"这点开销换来的是不用动 dynamic 的标签、也
   * 不用给 js_obj_* 家族加分支 —— `o.m()` 走成员派发的兜底（决策 12）就是对的。
   */
  classDecl(s) {
    const rec = this.classes.get(s.id);
    /* 非 Error 的类走原型链那条新路（ADR-0020 P1-f），而且它是**语句**：原型与类对象在
     * 类声明那一句执行时建起来（见 classProtoStmts）。这儿只剩 Error 子类的老路 ——
     * 它那条 `$cls` 链是 throw/catch 的现役机制（ADR-0011 决策 15），不跟着一起翻。 */
    if (!rec.isError) return;
    if (s.superClass && !rec.isError) {
      this.err(s.span, "'extends' is only supported for Error (ADR-0011 decision 15)");
    }
    const methods = [];
    let ctor = null;
    for (const m of s.members) {
      if (m.kind === 'staticBlock') {
        this.err(m.span, "a static initialization block is not supported in an Error subclass");
        continue;
      }
      const what = m.computed ? '<computed>' : this.keyName(m.key, m.span);
      if (m.static) { this.err(m.span, `static class members are not supported ('${what}')`); continue; }
      if (m.kind === 'field') { this.err(m.span, `class fields are not supported; assign '${what}' in the constructor`); continue; }
      if (m.kind === 'get' || m.kind === 'set') { this.err(m.span, `accessors are not supported; make '${what}' a method`); continue; }
      if (m.computed) { this.err(m.span, 'computed method names are not supported'); continue; }
      if (what === 'constructor') ctor = m; else methods.push([what, m]);
    }

    const outer = this.fn;
    const bodyStmts = ctor ? ctor.body.body : [];
    this.fn = this.newFrame(bodyStmts, {});
    // 方法体提到的名字都可能被捕获；`this` 一定被捕获，所以必须是 cell
    for (const [, m] of methods) refNames(m.body, this.fn.captured);
    this.fn.captured.add('this');
    this.fn.isCtor = true;
    this.fn.superIsError = rec.isError;
    const self = this.declare('this');
    // 异常类的实例是 { $cls: [类名, …父类, "Error"], message }；没写构造器时 message
    // 就是第一个实参。链里带上父类那一格 —— `class E extends TypeError {}` 的实例
    // 既 instanceof TypeError 也 instanceof Error，name 也从链上认（$js_err_bname）。
    const errChain = rec.isError
      ? [s.id, ...(rec.errBase && rec.errBase !== 'Error' ? [rec.errBase] : []), 'Error']
      : [];
    const init = rec.isError
      ? op('js_err_new', [
        ctor ? undefExpr() : op('js_arr_get', [argsDyn(), constReal(0)]),
        arrLit(errChain.map((n) => s16(n))),
        undefExpr(),
      ])
      : op('js_obj_new', []);
    const stmts = [localStmt(self.name, arrLit([init]))];
    for (const [name, m] of methods) {
      stmts.push(exprStmt(op('js_obj_set',
        [this.readEntry(self), s16(name), this.closureExpr(m, `${s.id}_${name}`, { fnName: name })])));
    }
    if (ctor) {
      ctor.params.forEach((p, i) => stmts.push(...this.bindParam(p, i, ctor.span)));
      if (ctor.rest) {
        if (ctor.rest.type !== 'Ident') this.err(ctor.span, 'destructuring a rest parameter is not supported');
        const ent = this.declare(ctor.rest.type === 'Ident' ? ctor.rest.name : '_rest');
        stmts.push(this.declStmt(ent, op('js_arr_slice', [argsDyn(), constReal(ctor.params.length), undefExpr()])));
      }
      stmts.push(...this.preCells(bodyStmts));
      stmts.push(...this.hoistFuncDecls(bodyStmts));
      for (const st of bodyStmts) stmts.push(...this.stmt(st));
    }
    const body = block([...this.fn.prelude, ...stmts, { kind: 'Return', value: this.readEntry(self) }]);
    this.fn = outer;
    this.funcs.push({ name: s.id, mangled: rec.mangled, file: fileOfSpan(s.span), ret: D, params: [{ name: 'args', type: listType(D) }], body });
  }

  /**
   * 类 -> 原型链（ADR-0020 P1-f）。降成**三样东西**，全在类声明那一句里建起来：
   *
   *   1. 原型对象（模块级全局 `proto_of_C`）：方法与访问器挂在它上面，**不可枚举**
   *      （规范如此 —— 所以 `Object.keys(实例)` 只会看到自己的字段）。
   *   2. 类对象（模块级全局 `C`）：一格真对象，挂 `prototype`、static 成员，
   *      以及一个内部键 `$init`（初始化实例的那个闭包）。`x instanceof C` 查的就是
   *      它身上的 `prototype`，`C.staticM()` 查的是它自己的属性。
   *   3. `$init` 闭包：`this` 从接收者槽取（js_this_take），先跑实例字段、再跑构造器体。
   *      刻意**不分配实例** —— 分配由 `new C()` 那边做（见 newExpr），这样以后
   *      `super(...)` 就是"拿当前 this 调父类的 $init"，不用再造一个对象。
   *
   * 与老那条（ADR-0011 决策 13：每实例一份闭包方法）的差别是可观察的：方法现在是
   * **共享的**（`a.m === b.m` 为真）、在原型上（`hasOwnProperty('m')` 为假）、
   * 而 `this` 是真接收者，所以方法可以借给别人用。
   */
  classProtoStmts(s, opts = {}) {
    /* 类**表达式**（`const C = class {}`）走的正是这一段：差别只在"那两格东西住在哪儿"。
     * 声明那条住模块级全局（方法只能建一次 —— 重建原型的话
     * `getPrototypeOf(a) === getPrototypeOf(b)` 就假了）；表达式那条住一对**临时量**，
     * 因为每次求值都得是一格新的类（`mk(1) !== mk(2)`，量过 qjs）。 */
    const name = opts.name ?? s.id;
    const classOf = opts.classOf !== undefined ? opts.classOf : s.id;
    const sup = opts.superName !== undefined ? opts.superName : this.classes.get(s.id).superName;
    if (sup !== null) {
      const srec = this.classes.get(sup);
      if (!srec || srec.isError) {
        this.err(s.span, `'extends ${sup}': ${srec ? 'extending an Error subclass is not supported yet' : `'${sup}' is not a class declared in this file`}`);
        return [];   // 父类的原型槽不存在，往下走就是内部崩（量出来的：class G extends Array {}）
      }
    }
    const protoG = opts.protoRef ?? (() => globalRef(this.globals.get(protoGlobalName(s.id)).name));
    const classG = opts.classRef ?? (() => globalRef(this.globals.get(s.id).name));
    const out = [];
    /* 原型链就是**把父类的原型当自己原型的原型**；静态成员的继承是"类对象的原型是父类对象"
     * （规范如此 —— 所以子类身上能查到父类的 static 方法）。 */
    const supProto = sup === null ? undefExpr() : globalRef(this.globals.get(protoGlobalName(sup)).name);
    out.push(exprStmt(assign(protoG(), op('js_obj_new_p', [supProto]))));
    out.push(exprStmt(assign(classG(), op('js_obj_slots', []))));
    if (sup !== null) {
      out.push(exprStmt(op('js_obj_proto_set', [classG(), globalRef(this.globals.get(sup).name)])));
    }
    // prototype 与 constructor 互指，两条都不可枚举
    out.push(exprStmt(this.defHidden(classG(), s16('prototype'), protoG())));
    out.push(exprStmt(this.defHidden(protoG(), s16('constructor'), classG())));
    /* 类对象身上的 name 与 length（规范 10.2.9 / 15.7.14）：都不可枚举。类在这个值域里
     * 不是函数（`typeof A` 给 "object"，见 ADR-0020），但这两格是**普通自有属性**，
     * 挂上去就对得上 —— 从前 `E.name` 是 undefined（量出来的静默分叉）。
     * length 是构造器声明的形参个数（有默认值或 rest 的那些不算，规范如此）。 */
    const ctorM = s.members.find((m) => m.kind === 'method' && !m.static && !m.computed
      && m.key && this.keyName(m.key, m.span) === 'constructor');
    let clen = 0;
    if (ctorM) {
      for (const p of ctorM.params) {
        if (p.type !== 'Ident') break;
        clen++;
      }
    }
    out.push(exprStmt(this.defHidden(classG(), s16('length'), constReal(clen))));
    out.push(exprStmt(this.defHidden(classG(), s16('name'), s16(name))));
    /* 局部类：**类对象刚造好就先写进它的绑定那一格**。静态块与静态字段初始化式是在"类定义
     * 那一刻"跑的，它们里面的 `A.x = 1` 读的就是那一格 —— 等到 `let A = …` 那一句才写就晚了
     * （量出来的：函数里 `class A { static { A.x = seed; } }` 报 "cannot assign to an index
     * of a undefined"）。规范里类体内部那个类名是**另一格绑定**、在这一刻就已初始化好，
     * 所以先写一次是对的口径，不只是绕开顺序问题。 */
    if (opts.afterCreate !== undefined) out.push(opts.afterCreate());

    let ctor = null;
    const fields = [];
    for (const m of s.members) {
      /* static 初始化块（ADR-0020 P4）：类定义那一刻跑一段，`this` 是类对象。
       * 摊成"造一格无参闭包 + 带接收者调一次" —— 于是块里的 `this.x = 1` 与
       * `A.x = 1` 都成立，而且块里的局部量不会漏到模块作用域。它没有名字，所以
       * 这一支必须在 keyName 之前（key 是 null）。 */
      if (m.kind === 'staticBlock') {
        const fn = this.closureExpr({
          type: 'FuncExpr', id: null, params: [], rest: null, body: m.body, span: m.span,
        }, `${name}_static_block`, { classOf });
        out.push(exprStmt(op('js_call_this', [fn, classG(), box(this.argList([]), listType(D))])));
        continue;
      }
      const what = m.computed ? null : this.keyName(m.key, m.span);
      const key = () => (m.computed ? this.expr(m.key) : this.propKey(what));
      const target = m.static ? classG : protoG;
      if (m.kind === 'field') {
        /* static 字段直接落在类对象上（可枚举、可写）；实例字段进 $init。
         * 私有名（`#x`）那一格**不可枚举** —— 它不该出现在 Object.keys / JSON.stringify
         * 里。私有性在这个值域里就是"不可枚举 + 名字里带井号"：`o["#x"]` 能绕过去，
         * 那是画出来的边界（真做要给每个类一格 WeakMap）。 */
        if (m.static) {
          out.push(exprStmt(what !== null && what.startsWith('#')
            ? this.defHidden(classG(), key(), m.value ? this.expr(m.value) : undefExpr())
            : op('js_obj_set', [classG(), key(), m.value ? this.expr(m.value) : undefExpr()])));
        } else {
          fields.push(m);
        }
        continue;
      }
      if (what === 'constructor' && !m.static) { ctor = m; continue; }
      const label = `${name}_${m.static ? 'static_' : ''}${what ?? 'computed'}`;
      /* staticSuper：静态方法里的 `super.m()` 指的是**父类对象**上的 m，不是父类原型上的
       * （规范 里 static 的 [[HomeObject]] 就是类对象本身）。superProtoRef 认这一位。
       * 访问器那两格的 name 照规范带前缀（10.2.9 SetFunctionName 的 prefix 实参）：
       * `get v` / `set v`，不是 `v`。 */
      const fnNm = what === undefined ? ''
        : (m.kind === 'get' || m.kind === 'set' ? `${m.kind} ${what}` : what);
      const fn = this.closureExpr(fnNodeOfProp(m), label, {
        classOf, fnName: fnNm, staticSuper: m.static === true,
      });
      if (m.kind === 'get' || m.kind === 'set') {
        let desc = op('js_obj_set', [op('js_obj_new', []), s16(m.kind), fn]);
        desc = op('js_obj_set', [desc, s16('configurable'), constBool(true)]);
        out.push(exprStmt(op('js_obj_def', [target(), key(), desc])));
      } else {
        out.push(exprStmt(this.defHidden(target(), key(), fn)));
      }
    }
    out.push(exprStmt(this.defHidden(classG(), classInitKey(),
      this.classInitClosure(s, ctor, fields, { name, classOf, sup }))));
    return out;
  }

  /** 挂一格**不可枚举**的属性（可写、可配置）—— 方法与内部键都该是这个形状 */
  defHidden(objE, keyE, valE) {
    let desc = op('js_obj_set', [op('js_obj_new', []), s16('value'), valE]);
    desc = op('js_obj_set', [desc, s16('writable'), constBool(true)]);
    desc = op('js_obj_set', [desc, s16('configurable'), constBool(true)]);
    return op('js_obj_def', [objE, keyE, desc]);
  }

  /** `$init`：实例字段 + 构造器体，`this` 是传进来的接收者（不分配实例） */
  classInitClosure(s, ctor, fields, opts = {}) {
    const name = opts.name ?? s.id;
    const classOf = opts.classOf !== undefined ? opts.classOf : s.id;
    const sup = opts.sup !== undefined ? opts.sup : this.classes.get(s.id).superName;
    const node = {
      type: 'FuncExpr',
      id: null,
      params: ctor ? ctor.params : [],
      rest: ctor ? ctor.rest : null,
      body: ctor ? ctor.body : { type: 'Block', body: [], span: s.span },
      span: s.span,
    };
    return this.closureExpr(node, `${name}_init`, {
      wantThis: true,
      classOf,
      pre: () => {
        const pre = [];
        /* 没写构造器的派生类：规范给的隐式构造器是 `constructor(...a){ super(...a) }` ——
         * 所以整条实参表原样转给父类的 `$init`。写了构造器的那些由 `super(...)` 自己发。 */
        if (!ctor && sup !== null) {
          pre.push(exprStmt(op('js_call_this', [
            op('js_obj_get', [globalRef(this.globals.get(sup).name), classInitKey()]),
            this.readEntry(this.lookup('this')),
            argsDyn(),
          ])));
        }
        // 字段在构造器体**之前**、形参绑定之前（规范：字段初始化器看不见构造器的形参）
        const fieldStmts = () => {
          const out = [];
          for (const f of fields) {
            const fname = f.computed ? null : this.keyName(f.key, f.span);
            const fkey = f.computed ? this.expr(f.key) : this.propKey(fname);
            const fval = f.value ? this.expr(f.value) : undefExpr();
            // 私有名那一格不可枚举（理由同 classProtoStmts 里那段说明）
            out.push(exprStmt(fname !== null && fname.startsWith('#')
              ? this.defHidden(this.readEntry(this.lookup('this')), fkey, fval)
              : op('js_setp', [this.readEntry(this.lookup('this')), fkey, fval])));
          }
          return out;
        };
        /* **写了构造器的派生类**：字段要等 super() 回来才初始化（规范 15.7.14），
         * 所以把那一批挂在栈帧上，由 super(...) 那一处发出来。 */
        if (ctor && sup !== null && fields.length > 0) {
          this.fn.fieldsAfterSuper = fieldStmts;
          return pre;
        }
        pre.push(...fieldStmts());
        return pre;
      },
    });
  }

  /**
   * 类表达式（`const C = class {}`、`[class{}, class{}]`、`return class {}`）。
   *
   * 与类声明**共用** classProtoStmts —— 差别只在那两格东西住哪儿：声明住模块级全局
   * （方法只能建一次），表达式住一对临时量，于是每次求值都是一格新的类。这一点是可
   * 观察的：`mk(1) !== mk(2)`、两次求值造出来的实例互不 instanceof（qjs 就是这样）。
   *
   * 两处画出来的边界：
   *   - `extends` 只认**这个文件顶层声明过的非 Error 类**：原型链要拿父类的原型对象与
   *     `$init`，而那两格是模块级全局，只有顶层声明的类才有。别的（`extends Error`、
   *     `extends Array`、表达式当父类）当场报。
   *   - 有名字的类表达式（`class Named {}`）：名字只落到类对象的 `name` 上，**不**在类体
   *     内部当一格绑定用（规范里它是的）。要那一格得多开一层作用域。
   */
  classExpr(e) {
    let superName = null;
    let classOf = null;
    if (e.superClass) {
      const sn = e.superClass.type === 'Ident' && !this.lookup(e.superClass.name)
        ? e.superClass.name : null;
      const srec = sn === null ? null : this.classes.get(sn);
      if (srec === undefined || srec === null || srec.isError) {
        this.err(e.span, "'extends' here only accepts a non-Error class declared at the top level of this module");
        return undefExpr();
      }
      superName = sn;
      /* `super.m()` 与 `super(...)` 靠 `fn.classOf` 去 classes 表里问父类名（superProtoRef
       * 与 Super 那一支）。类表达式没有自己的表项，所以配一格**合成的键** —— 用 `@cls<n>`
       * 是因为它不是合法的 JS 标识符，撞不上用户的类名（与模板站点那格 `@tpl<n>` 同一招）。 */
      classOf = `@cls${this.clsSites++}`;
      this.classes.set(classOf, { superName, isError: false, node: null });
    }
    const name = e.id ?? '';
    const protoT = this.temp();
    const classT = this.temp();
    const node = { id: name, superClass: e.superClass ?? null, members: e.members, span: e.span };
    const bindTo = e.bindTo ?? null;
    const stmts = this.classProtoStmts(node, {
      name,
      classOf,
      superName,
      protoRef: () => varRef(protoT),
      classRef: () => varRef(classT),
      afterCreate: bindTo === null ? undefined : () => exprStmt(this.writeEntry(bindTo, varRef(classT))),
    });
    for (const st of stmts) this.emitPre(st, e.span);
    return varRef(classT);
  }

  /* 私有名（`#x`）的键：一格**符号**，不是字符串 —— 于是 `o["#x"]` 取不到、
   * `Object.getOwnPropertyNames` 也列不出来（qjs 就是这样，量过）。同名共用一格
   * （js_sym_for 的注册表），代价写在明处：`Object.getOwnPropertySymbols` 还看得见它，
   * 而且两个类里同名的 `#x` 是同一格键（规范靠词法作用域禁掉跨类访问，这儿没那一层）。 */
  privKey(name) { return op('js_sym_for', [s16(name)]); }

  /** 名字是私有名就给符号键，否则给字符串键 */
  propKey(name) { return name.startsWith('#') ? this.privKey(name) : s16(name); }

  /** 这个静态路径（或它的某个前缀）在 STATIC_PROPS 里注册过吗（ADR-0020 P1-f） */  staticPrefix(node) {
    let cur = node;
    while (cur && cur.type === 'Member' && !cur.computed) {
      const p = this.staticPath(cur);
      if (p && Object.hasOwn(STATIC_PROPS, p)) return true;
      /* 内建函数**当值用**的那一格也算前缀（`Math.max.apply(null, xs)`、
       * `Number.isInteger.call(null, 1)`）：STATIC_CALLS 里带 len 的那些能取成一格薄包装的
       * 函数值（builtinFnValue），后半段就是普通的成员调用 —— call / apply / bind 住在
       * Function.prototype 上。 */
      if (p && Object.hasOwn(STATIC_CALLS, p) && STATIC_CALLS[p].len !== undefined) return true;
      cur = cur.object;
    }
    return false;
  }

  /** 父类原型那一格全局（`super.m` 用它）。不在派生类里就骂一句并回 null。 */
  superProtoRef(span) {
    const sup = this.fn.classOf ? this.classes.get(this.fn.classOf)?.superName : null;
    if (!sup) {
      this.err(span, "'super' is only available inside a method of a derived class");
      return null;
    }
    // 静态方法里的 super 指着**父类对象**（它的 [[HomeObject]] 是类对象，不是原型）
    if (this.fn.staticSuper === true) return globalRef(this.globals.get(sup).name);
    return globalRef(this.globals.get(protoGlobalName(sup)).name);
  }

  /** `super.x` / `super.m()` 里那格**接收者**：静态方法里没有 this，就交 undefined。 */
  superRecv() {
    const ent = this.lookup('this');
    return ent ? this.readEntry(ent) : undefExpr();
  }

  /** 闭包值的构造表达式（在**外层**栈帧里求值） */
  closureExpr(node, label, extra = {}) {
    /* 具名函数表达式引用自己（`const f = function fx(n){ … fx(n - 1) … }`）：那个名字在
     * JS 里只在**函数体里**可见，指着这个函数本身。办法与提升的函数声明（hoistFuncDecls）
     * 同一个：在外层开一格 cell、先填 undefined，造好闭包再写进去 —— 体里的 fx 捕获那一格。
     * 那个名字声明在一层临时作用域里，所以出了这个表达式就看不见它（JS 也是这样）。 */
    if (node.type === 'FuncExpr' && node.id && refNames(node).has(node.id)) {
      this.pushScope();
      this.fn.captured.add(node.id);
      const ent = this.declare(node.id);
      this.emitPre(this.declStmt(ent, undefExpr()), node.span);
      const inner = { ...node, id: null, selfName: node.id };
      this.emitPre(exprStmt(this.writeEntry(ent,
        this.makeClosure(this.closureOf(inner, label, { fnName: node.id, ...extra })))), node.span);
      this.popScope();
      return this.readEntry(ent);
    }
    return this.makeClosure(this.closureOf(node, label, extra));
  }

  makeClosure(rec) {
    return op('js_ofFn', [{
      kind: 'MakeClosure',
      closure: rec.id,
      make: rec.make,
      args: rec.captures.map((c) => this.cellOf(this.lookupCell(c.name))),
      type: JS_FN,
    }]);
  }

  /**
   * 按 cell 的**落地名**在当前栈帧里找回它（捕获表存的就是这个名字）。命中捕获层时
   * 要记一笔：内层闭包捕获的名字，本层自己也得捕获才能传下去（捕获是一级一级传的）。
   */
  lookupCell(uniq) {
    for (let i = this.fn.scopes.length - 1; i >= 0; i--) {
      for (const [n, ent] of this.fn.scopes[i]) {
        if (ent.name !== uniq) continue;
        if (ent.kind === 'capture') this.fn.uses.add(n);
        return ent;
      }
    }
    throw new Error(`lower.js: captured cell '${uniq}' is not in scope`);
  }

  /** 顶层函数当值用：包一个零捕获的转发闭包，按需生成一次 */
  topFnValue(name) {
    const hit = this.fnValues.get(name);
    if (hit) return this.makeClosure(hit);
    const id = this.closures.length;
    const mangled = this.mangle('a_', name);
    const rec = {
      id, mangled, make: `omni_mk_${mangled}`, captures: [],
      fnName: name, fnLen: this.topFnLens.get(name) ?? 0,
      /* **单件**（与 sexpr 的 fnref 同一格）：同一个具名函数取出来的值必须是同一个东西。
       * `f === f` 要为真，而且 `f.prototype` 是按闭包记录的身份查的 side table
       * （ADR-0020 的 js_fn_construct）—— 每次取一个新记录的话 `new f() instanceof f`
       * 就永远是假。 */
      single: true,
    };
    this.closures.push(rec);
    this.funcs.push({
      name: `${name}#value`,
      mangled,
      ret: D,
      params: [{ name: 'args', type: listType(D) }],
      closureId: id,
      body: block([{
        kind: 'Return',
        value: { kind: 'Call', func: this.topFns.get(name), name, args: [argsRaw()], type: D },
      }]),
    });
    this.fnValues.set(name, rec);
    return this.makeClosure(rec);
  }


  /** 形参从 args 数组里取；缺席就是 undefined，默认值只在 === undefined 时生效 */
  bindParam(p, i, span) {
    const get = op('js_arr_get', [argsDyn(), constReal(i)]);
    if (p.type === 'Ident') return [this.declStmt(this.declare(p.name), get)];
    if (p.type === 'AssignPattern' && p.left.type === 'Ident') {
      const ent = this.declare(p.left.name);
      const dflt = this.expr(p.right);
      return [
        this.declStmt(ent, get),
        {
          kind: 'If',
          cond: boolOp('js_eq', [this.readEntry(ent), undefExpr()], { strict: true }),
          then: block([exprStmt(this.writeEntry(ent, dflt))]),
          otherwise: null,
        },
      ];
    }
    // 解构形参：和声明位置同一套（bindPattern）
    return this.bindPattern(p, get);
  }

  /* -------------------------------------------------------- 语句 */

  /** @returns {any[]} 一条 JS 语句可能摊成多条 OIR 语句 */
  stmt(s) {
    // 表达式降级时可能需要"先算一句"（逗号表达式、i++ 的旧值、o.x += 1 的接收者）。
    // 这些语句放进 sink，摊在当前语句前面 —— 所以每条语句都有自己的 sink。
    const outer = this.fn.sink;
    const pre = [];
    this.fn.sink = pre;
    const out = this.stmtInner(s);
    this.fn.sink = outer;
    const all = pre.length ? [...pre, ...out] : out;
    return this.withCheck(s, all);
  }

  /**
   * throw 的传播（ADR-0011 决策 14）。C 里没有异常，所以每条**可能抛**的语句后面插一句
   * `if (js_pending()) <退出这一层>`：
   *   - 在 try 体里 -> Break（try 体本身摊成一个只跑一遍的循环，Break 正好落到 catch 前）
   *   - 不在 try 体里 -> Return（一路返回给调用者，调用者自己的检查会接着往上走）
   * 循环里的检查只跳出**当前**这一层，循环语句后面还有一次检查 —— 一级一级地退，
   * 这样只用 Break 就够，不需要 goto 或者标号。
   */
  withCheck(s, stmts) {
    if (s.type === 'Throw' || s.type === 'Return' || s.type === 'Break' || s.type === 'Continue') return stmts;
    if (!mayThrow(stmts)) return stmts;
    /* 已经以一次检查收尾的就不再补一次（量出来的：自举那份 13.7MB 的 JS 里 57487 次检查有
     * 7781 次是紧挨着的两句 —— guard() 把"会抛的子表达式"提成"临时量 + 一次检查"落进 sink，
     * 而 mayThrow 看的是整棵子树，于是这儿又补一次）。判据是**词法**的：这一句剩下的活儿
     * 已经没有了（检查就是最后一句），两次之间没有任何能置上 pending 的东西，所以第二次
     * 恒为假。省下来的不只是字节：五条腿每次都要真的去问一次 pending。 */
    if (stmts.length > 0 && isPendingCheck(stmts[stmts.length - 1])) return stmts;
    return [...stmts, { kind: 'If', cond: boolOp('js_pending', []), then: block([this.unwind()]), otherwise: null }];
  }

  unwind() {
    if (this.fn.tries > 0) return { kind: 'Break' };
    return { kind: 'Return', value: this.fn.isMain ? null : undefExpr() };
  }

  /** 直接待在 try 体里（没有再套一层自己的循环）—— 这时 break/continue 会被 try 接住 */
  crossesTry() {
    return this.fn.tries > 0 && this.fn.loops === this.fn.tryLoops[this.fn.tryLoops.length - 1];
  }

  /**
   * 可能抛的**子表达式**：先算进临时量，紧跟一次 pending 检查，再把临时量交出去。
   * 图的是精确 —— `console.log(f())` 里 f 抛了，println 就不该再跑。
   * 惰性位置（&& 的右边、Ternary 的分支、循环条件）提不出来，那里保持内联，
   * 由语句末尾那次检查兜着：抛出来的值是 undefined，接着这条语句就退出去了。
   */
  guard(e) {
    if (this.fn.lazies > 0) return e;
    /* void 的 op（console.log 那一族）不能落进临时量 —— C 那侧 "assigning to omni_dyn from
     * incompatible type void" 直接编不过（量出来的：实参子树里有会抛的 op 时，mayThrow 对
     * 整句为真，于是连这一句一起被提走）。当一句发出去就行，它的值本来就是 undefined。 */
    if (e.kind === 'Builtin' && JS_ALL[e.name] !== undefined && JS_ALL[e.name].ret === 'void') {
      this.fn.sink.push(exprStmt(e));
      this.fn.sink.push({ kind: 'If', cond: boolOp('js_pending', []), then: block([this.unwind()]), otherwise: null });
      return undefExpr();
    }
    const t = this.temp();
    this.fn.sink.push(exprStmt(assign(varRef(t), e)));
    this.fn.sink.push({ kind: 'If', cond: boolOp('js_pending', []), then: block([this.unwind()]), otherwise: null });
    return varRef(t);
  }

  /** 只有真会抛的才值得占一个临时量 */
  guarded(e) {
    return mayThrow(e) ? this.guard(e) : e;
  }

  /**
   * 一串**按次序求值**的子表达式（实参、数组的格子、模板的插值…）。
   *
   * 会抛的子表达式会被 guard 提到 sink 里（先算进临时量、紧跟一次 pending 检查）。
   * 只提一格是不够的：提出来的那一格会**跑在它前面那些还内联着的**之前。量出来的：
   *
   *   console.log(gi.next().value, JSON.stringify(gi.next(3)))
   *
   * 里 JSON.stringify（throws 的 op）落进了 sink，于是第二个 next 先跑，第一个后跑 ——
   * 生成器于是收到错的 sent 值，而且两条腿会一致地错（**静默分叉**）。
   *
   * 所以：谁往 sink 里放了东西，它**前面**那几格就先落进临时量，插在那批 sink 之前。
   * 常量不必（没有副作用、也读不到别人的写）。
   *
   * 注意"用过 sink 的那一格自己也还有残留"：`m.set("a",1).size` 里 set 被提走了，
   * 留在原地的是 `js_p_size(t)` —— 它也得跟着前面那些一起落地，不然读的是**后面**那些
   * sink 语句跑完之后的状态（量出来的静默分叉：`[m.set("a",1).size, m.size, m.set("b",2).size]`
   * 第一格印 2 而不是 1）。
   */
  seq(nodes, lowerOne) {
    const at = [];
    const out = [];
    for (const n of nodes) {
      at.push(this.fn.sink.length);
      out.push(lowerOne(n));
    }
    let pending = [];
    for (let i = 0; i < out.length; i++) {
      const start = at[i];
      const end = i + 1 < at.length ? at[i + 1] : this.fn.sink.length;
      if (end > start) {
        if (pending.length > 0) {
          const stmts = [];
          for (const j of pending) {
            const t = this.temp();
            stmts.push(exprStmt(assign(varRef(t), out[j])));
            out[j] = varRef(t);
          }
          this.fn.sink.splice(start, 0, ...stmts);
          for (let k = i; k < at.length; k++) at[k] += stmts.length;
        }
        pending = [];
      }
      if (out[i] && out[i].kind !== 'Const') pending.push(i);
    }
    return out;
  }

  /**
   * 惰性位置（循环条件、for 的 update、Ternary 的分支、&& 的右边）：这里**不能**把
   * 语句提到外面去 —— 提出去就变成每次都算、或者算得太早。碰上需要 sink 的构造就
   * 当场报错，让人把它拆成语句，而不是悄悄改语义。
   */
  lazy(f) {
    this.fn.lazies++;
    const out = f();
    this.fn.lazies--;
    return out;
  }

  emitPre(st, span) {
    if (this.fn.lazies > 0) {
      this.err(span, 'this expression needs a temporary in a lazily-evaluated position; hoist it into a statement');
      return;
    }
    this.fn.sink.push(st);
  }

  /**
   * 把 f() 期间落进 sink 的那几句**捞出来**，别让它们漏到外层语句前面。
   * 解构的默认值要它：`const { a = g() } = o` 里 g() 只在 a 缺席时才该跑，而 g() 这种
   * 会抛的调用会被 guard 提成"临时量 + 一次 pending 检查"落进 sink —— 从前那两句就摊在
   * 整条 If 的**前面**，于是默认值每次都算（量出来的静默分叉：属性在的时候副作用照样发生）。
   * 与 lazy() 的分工：那边是"这一格根本不能有 sink"（当场报），这边是"能有，但要跟着走"。
   */
  captureSink(f) {
    const outer = this.fn.sink;
    const pre = [];
    this.fn.sink = pre;
    const v = f();
    this.fn.sink = outer;
    return [pre, v];
  }

  stmtInner(s) {
    switch (s.type) {
      case 'Empty': return [];
      case 'Block': {
        this.pushScope();
        const out = this.blockBody(s.body);
        this.popScope();
        return [block(out)];
      }
      case 'VarDecl': return this.varDecl(s);
      case 'ExprStmt': {
        // 调用被 guard 提到 sink 里之后，这里剩下的常常只是那个临时量 —— 不必再发一句
        const e = this.exprDiscard(s.expr);
        return e.kind === 'VarRef' ? [] : [exprStmt(e)];
      }
      case 'If': return [{
        kind: 'If',
        cond: truthy(this.expr(s.test)),
        then: this.bodyBlock(s.cons),
        otherwise: s.alt ? this.bodyBlock(s.alt) : null,
      }];
      case 'While': {
        this.fn.loops++;
        this.fn.oloops++;
        this.fn.targets.push({ ol: this.fn.oloops, cont: true });
        const cond = this.lazy(() => truthy(this.expr(s.test)));
        const st = { kind: 'While', cond, body: this.bodyBlock(s.body) };
        this.fn.targets.pop();
        this.fn.oloops--;
        this.fn.loops--;
        return [st];
      }
      case 'DoWhile': return this.doWhile(s);
      case 'For': return this.forStmt(s);
      case 'ForOf':
        /* `for await` 只在 async 函数体里成立（genfn.js 那条路会把它摊成异步迭代协议）。
         * 走到这儿说明它在**非 async 的**位置上 —— 顶层 await 这个值域里没有（ADR-0020）。 */
        if (s.await === true) {
          this.err(s.span, "'for await' is only allowed in an async function");
          return [];
        }
        return this.forOf(s);
      case 'ForIn':
        // for-in（ADR-0020 P3）：与 for-of 同一个形状，只是那一串是"键"
        return this.forOf(s, () => op('js_for_in_keys', [this.expr(s.right)]));
      case 'Return': {
        // 构造器的 return 只能是空的（值就是实例），别的形状拒掉
        if (this.fn.isCtor) {
          if (s.arg) this.err(s.span, 'a constructor cannot return a value');
          const self = this.readEntry(this.lookup('this'));
          return this.finAbrupt(1, self) ?? [...this.iterCloses(0), { kind: 'Return', value: self }];
        }
        const rv = s.arg ? this.expr(s.arg) : undefExpr();
        /* 外面套着带 finally 的 try：先记下再 break 出去，清理跑完了才真的 return ——
         * for-of 的那几次 close 就挂在**真发 Return 的那一处**（见 iterCloses 与 tryStmt），
         * 于是次序是"先跑 finally，再关迭代器"，与规范一致。 */
        return this.finAbrupt(1, rv) ?? [...this.iterCloses(0), { kind: 'Return', value: rv }];
      }
      case 'Labeled': {
        // 标签只打在循环上（parser 那边保证）。记下"进了这层循环之后 OIR 有多少层"，
        // 里面的 `break L` 就能算出要跳出几层。
        this.fn.labels.push({ name: s.label, depth: this.fn.oloops + 1, block: s.block === true });
        const st = this.stmt(s.body);
        this.fn.labels.pop();
        return st;
      }
      case 'Break':
        if (s.label) return this.labelJump(s, 'break');
        return this.breakAt(s.span);
      case 'Continue':
        // do-while 现在摊成 For（条件在 step 里），所以 continue 正好是"去算条件"，见 doWhile
        if (s.label) return this.labelJump(s, 'continue');
        return this.continueAt(s.span);
      case 'Switch': return this.switchStmt(s);
      case 'Throw':
        return [exprStmt(op('js_throw', [this.expr(s.arg)])), this.unwind()];
      case 'Try': return this.tryStmt(s);
      case 'FuncDecl':
        // 提升过了：funcOf 在栈帧入口就把 cell 和闭包都摆好了（hoistFuncDecls）
        if (this.fn.hoisted?.has(s.id)) return [];
        this.err(s.span, 'a nested function declaration is only supported at the top of a function body');
        return [];
      case 'ClassDecl':
        /* 顶层的类：Error 子类在 module() 里就降完了（老路），非 Error 的那条**是语句** ——
         * 原型与类对象在这一句执行时建起来（ADR-0020 P1-f）。类因此不提升，与 JS 的
         * TDZ 方向一致（我们不报错，只是那之前 `new C()` 会拿到一格空原型）。 */
        if (this.classes.get(s.id)?.node === s) {
          return this.classes.get(s.id).isError ? [] : this.classProtoStmts(s);
        }
        /* 函数体里 / 块里的类声明。规范里它就是一格 let 绑定加一格类值（14.7.14 的
         * ClassDeclaration: BindingClassDeclarationEvaluation），所以照这个意思降：
         * `class A { … }` ≡ `let A = class A { … }`，值那一边走 classExpr 那条现成的路。
         * 从前这儿一律当场报"只支持模块顶层" —— 而函数里放一个小类是再普通不过的 JS。
         * `extends` 还是不收：那要父类的原型对象与 $init，而那两格只对"这个文件里声明过的类"
         * 存在（classExpr 里同一条边界）。 */
        return this.varDecl({
          type: 'VarDecl',
          kind: 'let',
          decls: [{
            id: { type: 'Ident', name: s.id, span: s.span },
            /* bindTo：绑定那一格（preCells 立的 cell）。静态块与静态字段初始化式在"类定义
             * 那一刻"就读类名，所以类对象一造好就先往那一格写一次（classProtoStmts 的
             * afterCreate）。引用了类名的静态块 / 字段会让 capturedNames 收下这个名字
             * （nestedFns 认字段与 staticBlock），于是这时候那一格一定已经立好了。 */
            init: {
              type: 'ClassExpr',
              id: s.id,
              superClass: s.superClass,
              members: s.members,
              span: s.span,
              bindTo: this.lookup(s.id),
            },
          }],
          span: s.span,
        });
      case 'ImportDecl': case 'ExportNamed': case 'ExportDefault': case 'ExportDecl':
        return [];   // collectTop 已经报过了
      default:
        this.err(s.span, `cannot lower statement '${s.type}'`);
        return [];
    }
  }

  /** 循环体/分支体：JS 允许单条语句，OIR 要的是 {stmts} */
  bodyBlock(s) {
    if (s.type === 'Block') {
      this.pushScope();
      const out = this.blockBody(s.body);
      this.popScope();
      return block(out);
    }
    return block(this.stmt(s));
  }

  /**
   * 一个块里的语句表。块**自己**也提升函数声明（规范 14.2.3：块级的函数声明是块作用域的
   * 绑定，块一进去就绑好），所以 `if (f) { function g(){…} return g(); }` 与
   * `while (…) { const s = 1; function h(){ return s; } }` 这两种写法通了 —— 从前是当场报
   * "a nested function declaration is only supported at the top of a function body"。
   * 顺序与栈帧入口那儿一致：先给被闭包引用的块级量立 cell（preCells），再造那些闭包。
   * `hoisted` 要存一存再还回去：里层的块有它自己的一套名字。
   */
  blockBody(stmts) {
    const prevHoisted = this.fn.hoisted;
    const pre = [...this.preCells(stmts), ...this.hoistFuncDecls(stmts)];
    const out = stmts.flatMap((x) => this.stmt(x));
    this.fn.hoisted = prevHoisted;
    return [...pre, ...out];
  }

  varDecl(s) {
    const out = [];
    for (const d of s.decls) {
      // 模块级的正则 const 没有运行期的身份（ADR-0011 决策 10）：collectTop 已经把它
      // 记成编译期常量了，这里什么都不发
      if (d.id.type === 'Ident' && this.fn.isMain && this.fn.scopes.length === 1
          && this.regexConsts.has(d.id.name)) continue;
      /* fn.name（ADR-0020）：规范里箭头与匿名函数表达式的 name 来自**赋值目标** ——
       * `const g = () => {}` 的 `g.name` 是 "g"。所以这一处的初始化式要带上名字。 */
      const init = () => {
        if (d.init && d.id.type === 'Ident'
          && (d.init.type === 'Arrow' || (d.init.type === 'FuncExpr' && !d.init.id))) {
          return this.closureExpr(d.init, d.id.name, { fnName: d.id.name });
        }
        return d.init ? this.expr(d.init) : undefExpr();
      };
      /* `var`：名字在栈帧入口就立好了（hoistVars），这儿只剩"写一次" —— 没有初始化式的
       * `var x;` 一句都不发（规范里再声明一次不清零）。模块顶层的 var 是全局槽，块里写的
       * 也是同一格（collectTop 连块里的一起收），所以那一支直接写那个全局。 */
      if (s.kind === 'var') {
        const ent = d.id.type === 'Ident' ? this.lookup(d.id.name) : null;
        if (ent && ent.varSlot === true) {
          if (d.init) out.push(exprStmt(this.writeEntry(ent, init())));
          continue;
        }
        const glob = d.id.type === 'Ident' && !ent && this.fn.isMain
          && this.globals.has(d.id.name) ? this.globals.get(d.id.name) : null;
        if (glob) {
          if (d.init) out.push(exprStmt(assign(globalRef(glob.name), init())));
          continue;
        }
        // 解构的 var（`{ var {a} = o; }`）：名字也提升过了，所以按"往已有绑定里写"那条路走
        if (d.id.type !== 'Ident' && (this.fn.varNames?.size || this.fn.isMain)) {
          if (d.init) this.destructInto(d.id, init(), s.span);
          continue;
        }
      }
      if (d.id.type === 'Ident') out.push(...this.defineVar(d.id.name, init));
      else out.push(...this.bindPattern(d.id, init()));
    }
    return out;
  }

  /**
   * 声明一个变量：模块级的是全局槽（顶层函数要能看见），函数里的是普通局部量或 cell。
   * 初始化式是**惰性**给的：cell 要先立起来才能算初始化式，`const f = x => f(x-1)`
   * 这种自递归的箭头靠的就是这个顺序。
   */
  defineVar(name, initFn) {
    if (this.fn.isMain && this.fn.scopes.length === 1 && this.globals.has(name)) {
      return [exprStmt(assign(globalRef(this.globals.get(name).name), initFn()))];
    }
    if (this.fn.captured.has(name)) {
      /* 入口预立的那一格（preCells）：cell 已经在了，这儿只往里写 —— 再 localStmt 一次
       * 会是**另一格** cell，提升的那些闭包捕获的还是旧的那一格。 */
      const pre = this.fn.scopes[this.fn.scopes.length - 1].get(name);
      if (pre !== undefined && pre.pre === true) {
        pre.pre = false;
        return [exprStmt(this.writeEntry(pre, initFn()))];
      }
      const ent = this.declare(name);
      return [localStmt(ent.name, arrLit([undefExpr()])), exprStmt(this.writeEntry(ent, initFn()))];
    }
    // 普通局部量：先算初始化式再声明 —— `let x = x` 里右边的 x 是外层那个
    const init = initFn();
    return [localStmt(this.declare(name).name, init)];
  }

  /** defineVar 之后读它 */
  refVar(name) {
    const ent = this.lookup(name);
    if (ent) return this.readEntry(ent);
    return globalRef(this.globals.get(name).name);
  }

  /** defineVar 之后写它（表达式） */
  writeVar(name, v) {
    const ent = this.lookup(name);
    if (ent) return this.writeEntry(ent, v);
    return assign(globalRef(this.globals.get(name).name), v);
  }

  /**
   * 解构：`const [a, b] = e` / `const {x, y} = e`。量过的源码里解构只出现在声明位置
   * （和 for-of 的循环变量），所以这里只管声明。嵌套的模式支持，但计算键不支持。
   */
  bindPattern(pat, value) {
    if (pat.type === 'Ident') return this.defineVar(pat.name, () => value);
    /* 右值只算一次，存进一个临时量再按位取。
     * 数组模式走**迭代器协议**（规范 8.6.2 的 ArrayBindingPattern）：js_iter_open 交出
     * "list 或一格把手"，每一格取一次就往前走一格 —— 于是 `const [a, b] = 无穷生成器()`
     * 只 next 两次（从前是先抽干，**挂住**），取完了没有 rest 还要补一次 close
     * （带 finally 的生成器于是跑得到清理）。数组身上把手就是它自己，与从前等价。 */
    const t = this.declare('_d').name;
    const out = [localStmt(t, pat.type === 'ArrayPattern' ? op('js_iter_open', [value]) : value)];
    if (pat.type === 'ArrayPattern') {
      // 一格 = "走一步，走得到就是那一格、走不到就是 undefined"（done 每次只走一步）
      const at = (i) => ternary(boolOp('js_iter_done', [varRef(t), constReal(i)]),
        undefExpr(), op('js_iter_cur', [varRef(t), constReal(i)]));
      pat.elements.forEach((el, i) => {
        // 空位（`const [, b] = it`）也要走一格，只是不绑
        if (el === null) { out.push(exprStmt(at(i))); return; }
        out.push(...this.bindElem(el, at(i)));
      });
      if (pat.rest) {
        out.push(...this.bindElem(pat.rest, op('js_iter_rest', [varRef(t), constReal(pat.elements.length)])));
      } else {
        out.push(exprStmt(op('js_iter_close', [varRef(t)])));
      }
      return out;
    }
    if (pat.type === 'ObjectPattern') {
      /* 计算键（`const { [k]: v } = o`）：键的表达式**只算一次** —— 它可能有副作用，
       * 而 rest 那一支还要再用一遍（把取过的键从拷贝里删掉）。所以先落在临时量上。 */
      const keys = [];
      pat.props.forEach((p) => {
        let k;
        if (!p.computed) {
          k = s16(this.keyName(p.key, pat.span));
        } else {
          const kt = this.declare('_k').name;
          out.push(localStmt(kt, this.expr(p.key)));
          k = varRef(kt);
        }
        keys.push(k);
        out.push(...this.bindElem(p.value, op('js_obj_get', [varRef(t), k])));
      });
      if (pat.rest) {
        /* `const {a, ...r} = o`（ADR-0020 P3）：r 是"**剩下的**自有可枚举属性"的一份浅拷贝。
         * 摊成"整份抄一遍，再把取过的那几个键删掉" —— 现成的两个 op 就够，不必为它新增。
         * 顺序无所谓：抄的是自有属性，删的是取过的键，两组互不影响。 */
        if (pat.rest.type !== 'Ident') {
          this.err(pat.span, 'a nested pattern in an object rest is not supported');
        } else {
          out.push(...this.defineVar(pat.rest.name,
            () => op('js_obj_assign', [op('js_obj_new', []), varRef(t)])));
          for (const k of keys) {
            out.push(exprStmt(op('js_obj_delete', [this.refVar(pat.rest.name), k])));
          }
        }
      }
      return out;
    }
    if (pat.type === 'AssignPattern') return this.bindElem(pat, value);
    this.err(pat.span, `cannot destructure with '${pat.type}'`);
    return out;
  }

  /** 模式里的一个位置：可能带默认值（只在 === undefined 时生效） */
  bindElem(el, value) {
    if (el.type === 'AssignPattern') {
      if (el.left.type !== 'Ident') {
        /* 嵌套模式带默认值（`function f({x} = {})`、`const {b: {c} = {}} = o`）：默认值
         * 只在这一格是 undefined 时生效，所以先把值落在一个临时量上、补过默认值，再往里拆。 */
        const t = this.declare('_v').name;
        const [pre, dv] = this.captureSink(() => this.expr(el.right));
        return [
          localStmt(t, value),
          {
            kind: 'If',
            cond: boolOp('js_eq', [varRef(t), undefExpr()], { strict: true }),
            then: block([...pre, exprStmt(assign(varRef(t), dv))]),
            otherwise: null,
          },
          ...this.bindPattern(el.left, varRef(t)),
        ];
      }
      const ref = () => this.refVar(el.left.name);
      const decl = this.defineVar(el.left.name, () => value);
      const [pre, dv] = this.captureSink(() => this.expr(el.right));
      return [...decl, {
        kind: 'If',
        cond: boolOp('js_eq', [ref(), undefExpr()], { strict: true }),
        then: block([...pre, exprStmt(this.writeVar(el.left.name, dv))]),
        otherwise: null,
      }];
    }
    return this.bindPattern(el, value);
  }

  /** 属性名：Ident / Str / Num 三种键都摊成字符串 */
  keyName(key, span) {
    if (key.type === 'Ident') return key.name;
    if (key.type === 'Str') return key.value;
    if (key.type === 'Num') return String(key.value);
    this.err(key.span ?? span, `cannot use '${key.type}' as a property name`);
    return '<error>';
  }

  /**
   * do-while：OIR 没有 do-while。摊成一个 **For**，条件放在 step 里、循环条件读一格标志：
   *
   *   let _dw = true;
   *   for (; _dw; _dw = <test>) { body }
   *
   * 头一轮标志是 true 所以体先跑；体跑完（**或者 continue**）走 step，那儿才算 test ——
   * 于是 `continue` 的语义正好是"去算条件"，与规范一致。从前摊的是
   * `while (true) { body; if (!test) break; }`，continue 会跳过尾巴那一句、成了死循环，
   * 所以那时候 do-while 里的 continue 是当场报错。
   */
  doWhile(s) {
    const flag = this.declare('_dw').name;
    this.fn.loops++;
    this.fn.oloops++;
    this.fn.targets.push({ ol: this.fn.oloops, cont: true });
    const body = this.bodyBlock(s.body);
    const step = assign(varRef(flag), this.lazy(() => box(truthy(this.expr(s.test)), BOOL)));
    this.fn.targets.pop();
    this.fn.oloops--;
    this.fn.loops--;
    return [block([
      localStmt(flag, constBool(true)),
      { kind: 'For', init: null, cond: truthy(varRef(flag)), step, body },
    ])];
  }

  forStmt(s) {
    this.pushScope();
    let pre = [];
    if (s.init) {
      pre = s.init.type === 'VarDecl' ? this.varDecl(s.init) : [exprStmt(this.expr(s.init.expr))];
    }
    /* `for (let i = …)` 的绑定在 JS 里是**每轮一个新的**（闭包捕获的是这一轮那一格），
     * 而 var 是函数作用域里的一格、共享才对。
     *
     * let 那一支的办法：循环自己照旧用外层那一格 cell（cond 与 update 读写它），**体里
     * 另给一格同名的 cell**、每轮开头从外层抄一份进去 —— 那一句是体里的 `let`，所以每轮
     * 都是新的一格数组，这一轮造的闭包捕获它、上一轮造的还拿着自己那一格。
     *
     * 体里**改**循环变量的那一格照旧拒绝：抄进来的那一份要在 update 之前抄回去，而
     * `continue` 会跳过体的尾巴（OIR 的 Continue 直接跳到 step），抄不回去就是静默分叉。
     *
     * 问的是**自由变量**（`freeNames` 上面那段）：从前这儿看的是 `ent.kind === 'cell'`，
     * 而 cell 是**保守**算出来的 —— 内层闭包里有个同名局部量就够让外层循环变量变 cell，
     * 于是「体里一个闭包都没有」的循环也会被骂。保守分析不该接到硬拒绝上。 */
    const capturedHere = new Set();
    for (const part of [s.body, s.test, s.update]) {
      for (const g of nestedFns(part)) freeNames(g, capturedHere);
    }
    const perIter = [];
    const letInit = s.init && s.init.type === 'VarDecl' && s.init.kind !== 'var';
    for (const [n, ent] of this.fn.scopes[this.fn.scopes.length - 1]) {
      if (!capturedHere.has(n)) continue;
      if (!letInit) continue;   // var 那一支什么也不做：共享一格正是 JS 的语义
      if (assignsName(s.body, n)) {
        this.err(s.span, `'${n}' is a for-loop variable that the body assigns and a closure captures;`
          + ' copy it into a body-local const first');
        continue;
      }
      perIter.push([n, ent]);
    }
    const cond = s.test ? this.lazy(() => truthy(this.expr(s.test))) : { kind: 'Const', type: BOOL, value: true };
    const step = s.update ? this.lazy(() => this.exprDiscard(s.update)) : null;
    this.fn.loops++;
    this.fn.oloops++;
    this.fn.targets.push({ ol: this.fn.oloops, cont: true });
    /* 每轮一格新绑定：体里另开一层作用域，同名再声明一格 cell、从外层那一格抄一份进去。
     * 这一句是体里的 let，所以每轮执行一次、每轮一格新数组。 */
    const fresh = [];
    if (perIter.length > 0) {
      this.pushScope();
      for (const [n, outer] of perIter) {
        const inner = this.declare(n);
        inner.kind = 'cell';
        fresh.push(this.declStmt(inner, this.readEntry(outer)));
      }
    }
    const body = this.bodyBlock(s.body);
    if (perIter.length > 0) this.popScope();
    this.fn.targets.pop();
    this.fn.oloops--;
    this.fn.loops--;
    this.popScope();
    // init 摊在 For 外面（多个声明时 OIR 的 init 放不下），所以套一层块管作用域
    const loop = {
      kind: 'For',
      init: null,
      cond,
      step,
      body: fresh.length ? block([...fresh, ...body.stmts]) : body,
    };
    return pre.length ? [block([...pre, loop])] : [loop];
  }

  /**
   * for-of：取一次可迭代对象（js_iter：数组原样返回，所以下标迭代是活的），
   * 然后按下标走。刻意不用 OIR 的 ForIn —— 那个要静态的容器类型，而这里全是 dynamic。
   */
  /**
   * `for-of`，以及 `for-in`（ADR-0020 P3）—— 两者的形状是同一个：先把"要走一遍的那串
   * 东西"摊成一个数组，再按下标走。差别只在那一步：for-of 是 `js_iter`（协议或内建），
   * for-in 是 `js_for_in_keys`（自有 + 继承来的可枚举字符串键，去重）。
   *
   * 惰性那一格还没有（生成器是 P2）：现在两条都是**先收齐再走**。可观察的差别是
   * "循环体里改容器"—— 记在 ADR-0020 里，等 P2 的生成器把惰性形态带进来。
   */
  forOf(s, seqOf = () => op('js_iter_open', [this.expr(s.right)])) {
    /* 没有声明的 for-of / for-in（`for (x of xs)`、`for (k in o)`）：每轮往一个**已经
     * 存在的**名字上写。目标只收名字 —— 成员目标（`for (o.k of xs)`）要把接收者提成
     * 临时量（走 sink），而这儿是循环体里的一句，提出去就跑到循环外面了。 */
    if (!s.declKind && s.left.type !== 'Ident') {
      this.err(s.span, "for-of / for-in over an existing target is only supported for a plain name; declare the loop variable, or assign inside the body");
      return [];
    }
    this.pushScope();
    const it = this.declare('_it').name;
    const i = this.declare('_i').name;
    const pre = [localStmt(it, seqOf()), localStmt(i, constReal(0))];
    /* 惰性（ADR-0020）：把手可能是 list，也可能是一格真迭代器。cond 那一步**就是**
     * "往前走一格"（每轮恰好一次 next —— cond 在体之前跑，continue 也走 step 再 cond），
     * 取值另有 js_iter_cur。循环后面补一次 close：正常跑完时迭代器已经 done、那是空操作，
     * break 出来才真调 it.return()。 */
    const cond = notB(boolOp('js_iter_done', [varRef(it), varRef(i)]));
    const step = assign(varRef(i), op('js_add', [varRef(i), constReal(1)]));
    this.fn.loops++;
    this.fn.oloops++;
    this.fn.targets.push({ ol: this.fn.oloops, cont: true });
    this.fn.iters.push({ name: it, ol: this.fn.oloops });
    const elem = () => op('js_iter_cur', [varRef(it), varRef(i)]);
    let inner;
    if (s.declKind) {
      inner = this.bindPattern(s.left, elem());
    } else {
      const lv = this.lvalue(s.left, s.span);
      inner = lv ? [exprStmt(lv.set(elem()))] : [];
    }
    const body = this.bodyBlock(s.body);
    this.fn.iters.pop();
    this.fn.targets.pop();
    this.fn.oloops--;
    this.fn.loops--;
    this.popScope();
    return [block([
      ...pre,
      { kind: 'For', init: null, cond, step, body: block([...inner, ...body.stmts]) },
      exprStmt(op('js_iter_close', [varRef(it)])),
    ])];
  }

  /**
   * switch：OIR 没有 switch，摊成"先算出中了第几格，再从那一格往下跑"。
   *   - 外面套一层"只跑一遍的循环"，这样 case 体里的 break 就是 OIR 的 Break，
   *     语义正好是"跳出 switch"（而不是跳出外层循环）。
   *   - **穿透是支持的**（ADR-0020 P4）：每个 case 自成一格，派发只算出中了哪一格
   *     （`_m`），跑的时候每一格的守卫是 `_m <= 这一格` —— 于是"从中的那一格往下，
   *     直到遇上 break/return"正好是 JS 的语义。分组写法（`case 'a': case 'b': body`）
   *     不再需要特殊照顾：空体的 case 自然穿到下一格。
   *   - default 可以在中间：都不中时 `_m` 就是它的格号，之后同样往下穿。
   *   - 派发链是**嵌套三元**（不是 if 链）：这样 case 的判据只算到中的那一格为止，
   *     与 JS 一致。
   */
  switchStmt(s) {
    this.pushScope();
    const d = this.declare('_sw').name;
    const pre = [localStmt(d, this.expr(s.disc))];
    this.fn.switches++;
    this.fn.switchLoops.push(this.fn.loops);
    // 下面那层合成的 while(true) 在 OIR 里是**一层真的循环**，case 体是在它里面降的
    this.fn.oloops++;
    this.fn.targets.push({ ol: this.fn.oloops, cont: false });   // 无标签 break 认它，continue 不认
    this.fn.switchFlags.push(null);
    /** @type {{test: any, body: any[]}[]} 源码次序，default 也占一格（test 是 null） */
    const groups = [];
    let dfltIdx = -1;
    for (const cs of s.cases) {
      if (cs.test === null) {
        if (dfltIdx >= 0) this.err(cs.span, 'a switch has more than one default clause');
        dfltIdx = groups.length;
      }
      const test = cs.test === null ? null : this.expr(cs.test);
      groups.push({ test, body: cs.body.flatMap((x) => this.stmt(x)) });
    }
    const m = this.declare('_m').name;
    // 派发：从上往下第一个 === 的那一格；都不中就落到 default（没有 default 就落到"格数"，
    // 于是下面每一格的守卫都不成立，一格都不跑）
    let pick = constReal(dfltIdx >= 0 ? dfltIdx : groups.length);
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].test === null) continue;
      pick = ternary(boolOp('js_eq', [varRef(d), groups[i].test], { strict: true }),
        constReal(i), pick);
    }
    const runs = [];
    for (let i = 0; i < groups.length; i++) {
      // 空体的那一格不必生成 if：它的"体"就是穿到下一格
      if (groups[i].body.length === 0) continue;
      runs.push({
        kind: 'If',
        cond: boolOp('js_cmp', [varRef(m), constReal(i)], { op: 'l' }),
        then: block(groups[i].body),
        otherwise: null,
      });
    }
    this.fn.switches--;
    this.fn.targets.pop();
    this.fn.oloops--;
    this.fn.switchLoops.pop();
    const flag = this.fn.switchFlags.pop();
    this.popScope();
    const body = block([...runs, { kind: 'Break' }]);
    const loop = { kind: 'While', cond: { kind: 'Const', type: BOOL, value: true }, body };
    if (!flag) return [block([...pre, localStmt(m, pick), loop])];
    // 里面有 continue：合成循环会把它接住，所以改成"置标志位 + break"，出来再补一次
    // continue（外面还是 switch 的话，continueStmts 会继续往上传一层）
    return [block([
      ...pre,
      localStmt(m, pick),
      localStmt(flag, constBool(false)),
      loop,
      { kind: 'If', cond: truthy(varRef(flag)), then: block(this.continueStmts()), otherwise: null },
    ])];
  }

  /**
   * 带标签的跳转要跳出/继续第几层 OIR 循环。
   *
   * level 数的是 **OIR** 的层数，所以 switch 与 try 摊出来的那层合成循环也算 ——
   * 这也正是"跨过一个 switch 的 `break L`"能一句话说清的原因：它就是多跳一层。
   * 跨过只有 catch 的 try 也是多跳一层：那层合成循环后面紧跟着的 pending 检查（catch 就长
   * 在那儿）只在真有异常时才进，跳转这会儿槽是空的。带 finally 的那种走不到这儿 ——
   * labelJump 先问过 finLabelAbrupt 了。
   */
  labelLevel(s, what) {
    const labs = this.fn.labels;
    let ent = null;
    for (let i = labs.length - 1; i >= 0; i--) {
      if (labs[i].name === s.label) { ent = labs[i]; break; }
    }
    if (ent === null) {
      this.err(s.span, `no enclosing label '${s.label}' for '${what}'`);
      return 1;
    }
    /* `continue L` 指着一个**标签块**：规范里这是 SyntaxError（continue 只能指循环），
       而这边的块摊成了 while(true)，放过去就成死循环 —— 所以在这儿挡住。 */
    if (ent.block === true && what === 'continue') {
      this.err(s.span, `'continue ${s.label}' targets a labeled block, which is not a loop`);
      return 1;
    }
    /* 跨过只有 catch 的 try 是安全的：那层合成循环出来之后紧跟着的 pending 检查只在真有
     * 异常时才进（catch 就长在那儿），而这会儿槽是空的 —— 多跳一层正好落在它外面。
     * 带 finally 的那种在 finLabelAbrupt 里走 unwind 协议，走不到这儿。 */
    return this.fn.oloops - ent.depth + 1;
  }

  /**
   * 带标签的跳转发出来是什么：先看要不要跨过一层带 finally 的 try（那就走 unwind 协议，
   * 清理跑完了在 try 后面照着再跳一次），否则就是"跳出/继续第几层 OIR 循环"。
   */
  labelJump(s, what) {
    const u = this.finLabelAbrupt(s, what);
    if (u) return u;   // 推到 finally 后面去发，close 也跟着挪（见 tryStmt 里那一段）
    /* 跳到外层去时，中间那几层 for-of 的 close 被跳过了（它是循环后面那一句）——
     * 按内层到外层补上。目标那一层自己的不用补：跳出去正好落在它后面。 */
    const labs = this.fn.labels;
    let depth = 0;
    for (let k = labs.length - 1; k >= 0; k--) {
      if (labs[k].name === s.label) { depth = labs[k].depth; break; }
    }
    const closes = depth > 0 ? this.iterCloses(depth) : [];
    const level = this.labelLevel(s, what);
    return [...closes, what === 'break' ? { kind: 'Break', level } : { kind: 'Continue', level }];
  }

  /**
   * `break L` / `continue L` 要跨过一层带 finally 的 try：与 finAbrupt 同一格协议，只是
   * "为什么出去"记的是**跳哪个标签**（4 起，一个目标一格）。清理在合成循环后面跑，跑完了
   * 在那个位置照记下的标签再跳一次 —— 那儿已经出了合成循环，层数正好算得对；外面还套着
   * 带 finally 的 try 时，这一步又落成"再记一次 + 再 break 一层"，于是每层清理都跑得到。
   * 没跨过这种 try 就交出 null，调用方照原样发带层数的 Break / Continue。
   */
  finLabelAbrupt(s, what) {
    const labs = this.fn.labels;
    let ent = null;
    for (let i = labs.length - 1; i >= 0; i--) {
      if (labs[i].name === s.label) { ent = labs[i]; break; }
    }
    // 找不到标签、或 `continue` 指着标签块：让 labelLevel 去报，这儿不接
    if (ent === null || (ent.block === true && what === 'continue')) return null;
    const top = this.fn.finStack[this.fn.finStack.length - 1];
    if (top === undefined || ent.depth > top.oloop) return null;   // 不跨带 finally 的 try
    const key = `${what} ${s.label}`;
    let j = top.jumps.find((x) => x.key === key);
    if (!j) {
      j = { key, code: 4 + top.jumps.length, what, label: s.label, span: s.span };
      top.jumps.push(j);
    }
    /* break 出到"那层 finally 所属的合成循环"外面 —— 中间可能还夹着几层只有 catch 的 try，
     * 一并跳出去是对的：它们循环后面那句 pending 检查只在真有异常时才进，这会儿槽是空的。 */
    const level = this.fn.oloops - top.oloop + 1;
    return [
      exprStmt(assign(varRef(top.unw), constReal(j.code))),
      level > 1 ? { kind: 'Break', level } : { kind: 'Break' },
    ];
  }

  /**
   * 跳出 for-of 时要补的那几次 `it.return()`：循环后面那一句 close 只有"落到那儿"才跑，
   * 而 `return` 与"带标签跳到外层去"都跳过了它。按**内层到外层**发（规范的次序）。
   * @param {number} minOL 只关掉深度比它大的那些（`0` = 全关，用于 return）
   */
  iterCloses(minOL) {
    const out = [];
    for (let k = this.fn.iters.length - 1; k >= 0; k--) {
      const h = this.fn.iters[k];
      if (h.ol > minOL) out.push(exprStmt(op('js_iter_close', [varRef(h.name)])));
    }
    return out;
  }

  /**
   * 无标签 `break` 在当前位置发什么。目标是最内层的循环或 switch（targets 的顶）：
   *   - 目标在一层带 finally 的 try **外面**：走 unwind 协议（finAbrupt），清理跑完再跳；
   *   - 中间夹着只有 catch 的 try（或 switch）：就是多跳几层 —— 那些合成循环后面那句
   *     pending 检查只在真有异常时才进，这会儿槽是空的，跳过去是对的。
   */
  breakAt(span) {
    const tgt = this.fn.targets[this.fn.targets.length - 1];
    if (tgt === undefined) {
      this.err(span, "'break' outside a loop or switch");
      return [{ kind: 'Break' }];
    }
    const u = this.finAbrupt(2, undefined, tgt.ol);
    if (u) return u;
    const level = this.fn.oloops - tgt.ol + 1;
    return [level > 1 ? { kind: 'Break', level } : { kind: 'Break' }];
  }

  /** 无标签 `continue`：目标是最内层的**循环**（switch 那格不算），其余同 breakAt */
  continueAt(span) {
    let tgt = null;
    for (let i = this.fn.targets.length - 1; i >= 0; i--) {
      if (this.fn.targets[i].cont) { tgt = this.fn.targets[i]; break; }
    }
    if (tgt === null) {
      this.err(span, "'continue' outside a loop");
      return [{ kind: 'Continue' }];
    }
    const u = this.finAbrupt(3, undefined, tgt.ol);
    if (u) return u;
    // 没跨 try：照旧（隔着 switch 时靠标志位翻出去，见 continueStmts）
    if (!this.crossesTry()) return this.continueStmts();
    const level = this.fn.oloops - tgt.ol + 1;
    return [level > 1 ? { kind: 'Continue', level } : { kind: 'Continue' }];
  }

  /** 当前位置的 `continue` 该发什么：switch 是一层合成循环，得靠标志位翻出去 */
  continueStmts() {
    const top = this.fn.switchLoops.length - 1;
    if (this.fn.switches > 0 && this.fn.loops === this.fn.switchLoops[top]) {
      return [exprStmt(assign(varRef(this.switchContFlag()), constBool(true))), { kind: 'Break' }];
    }
    return [{ kind: 'Continue' }];
  }

  /** 最内层 switch 的"出去之后要 continue"标志位；第一次用到才声明 */
  switchContFlag() {
    const i = this.fn.switchFlags.length - 1;
    if (!this.fn.switchFlags[i]) this.fn.switchFlags[i] = this.declare('_cont').name;
    return this.fn.switchFlags[i];
  }

  /**
   * try / catch（ADR-0011 决策 14）。try 体摊成一个只跑一遍的循环，unwind 的 Break
   * 正好落到循环后面；catch 就是"循环之后 pending 还在着"：
   *   while (true) { …体（每句后面查 pending -> break）…; break; }
   *   if (js_pending()) { e = js_take_pending(); …catch 体… }
   * finally 不支持（量过：全仓库 1 处）—— 那已经是老话了：finally 走 unwind 协议（见下面
   * 与 finAbrupt），break/continue（带标签的也算）跨过 try 的边界也收得下。
   */
  tryStmt(s) {
    if (!s.handler && !s.finalizer) { this.err(s.span, "'try' needs a 'catch'"); return []; }
    /* finally（ADR-0020 P4）：pending 槽是全局一格，所以清理代码不能在"槽里还有东西"的
     * 时候跑 —— 那样 C 自己的第一次 pending 检查就会当场把它接走。所以三步：
     *   1. 先记下"有没有异常"、把它挪到一格局部量（槽因此清空）；
     *   2. 干净地跑清理；
     *   3. 有的话再抛回去（js_throw 就是"往槽里放"）。
     * 从 try / catch 里 **return / break / continue 出去**也不能绕过清理，所以走一格
     * unwind 协议：记下"为什么出去"（unw：1 return / 2 break / 3 continue）与 return 的
     * 值，break 出这层合成循环，跑完清理再照记下的那件事接着做。外面还套着带 finally 的
     * try 时，接着做的那一步又落成"记一次 + 再 break 一层"（见 finAbrupt）。
     * 带标签的跳转同一格协议，只是记的是"跳哪个标签"（4 起），见 finLabelAbrupt。 */
    let unw = null;
    if (s.finalizer) {
      const esc = this.abruptIn(s.block.body) ?? (s.handler ? this.abruptIn(s.handler.body) : null);
      if (esc) {
        unw = { unw: this.declare('_funw').name, rv: this.declare('_frv').name, used: new Set(), jumps: [], oloop: 0 };
      }
    }
    if (unw) this.fn.finStack.push(unw);
    this.fn.tries++;
    this.fn.tryLoops.push(this.fn.loops);
    this.fn.oloops++;   // try 体也摊在一层合成的 while(true) 里
    this.fn.tryOLoops.push(this.fn.oloops);
    if (unw) unw.oloop = this.fn.oloops;   // finLabelAbrupt 要认"最内层这层 try 是不是我"
    this.pushScope();
    const body = s.block.body.flatMap((x) => this.stmt(x));
    this.popScope();
    this.fn.tryOLoops.pop();
    this.fn.oloops--;
    this.fn.tryLoops.pop();
    this.fn.tries--;
    const loop = {
      kind: 'While',
      cond: { kind: 'Const', type: BOOL, value: true },
      body: block([...body, { kind: 'Break' }]),
    };
    this.pushScope();
    const hasCatch = !!s.handler;
    /* 有 finally 时 catch 体也要摊在一层合成循环里：catch 里再抛的话，pending 检查
     * 在"没有 try 包着"的位置就是**直接从函数 return**，清理会被整段跳过
     * （量出来的：node 印 c2ioR，我们印 c2io）。套一层之后那次检查落成 break，
     * 走出去正好接上下面的 finally。 */
    const wrapCatch = hasCatch && !!s.finalizer;
    if (wrapCatch) {
      this.fn.tries++;
      this.fn.tryLoops.push(this.fn.loops);
      this.fn.oloops++;
      this.fn.tryOLoops.push(this.fn.oloops);
    }
    // 绑不绑名字都要把槽取空 —— 不取的话下一次 pending 检查会重新抛一遍
    const head = !hasCatch ? []
      : (s.param ? this.bindPattern(s.param, op('js_take_pending', []))
        : [exprStmt(op('js_take_pending', []))]);
    const handler = !hasCatch ? [] : s.handler.body.flatMap((x) => this.stmt(x));
    if (wrapCatch) {
      this.fn.tryOLoops.pop();
      this.fn.oloops--;
      this.fn.tryLoops.pop();
      this.fn.tries--;
    }
    this.popScope();
    const out = unw ? [localStmt(unw.unw, constReal(0)), localStmt(unw.rv, undefExpr()), loop] : [loop];
    if (hasCatch) {
      const hbody = wrapCatch ? [{
        kind: 'While',
        cond: { kind: 'Const', type: BOOL, value: true },
        body: block([...handler, { kind: 'Break' }]),
      }] : handler;
      out.push({
        kind: 'If',
        cond: boolOp('js_pending', []),
        then: block([...head, ...hbody]),
        otherwise: null,
      });
    }
    if (s.finalizer) {
      if (unw) this.fn.finStack.pop();
      this.pushScope();
      const has = this.declare('_fhas').name;
      const val = this.declare('_ferr').name;
      const fin = s.finalizer.body.flatMap((x) => this.stmt(x));
      this.popScope();
      out.push(localStmt(has, box(boolOp('js_pending', []), BOOL)));
      out.push(localStmt(val, op('js_take_pending', [])));
      out.push(...fin);
      out.push({
        kind: 'If',
        cond: truthy(varRef(has)),
        then: block([exprStmt(op('js_throw', [varRef(val)]))]),
        otherwise: null,
      });
      /* 清理跑完了，照记下的那件事接着做。外面还套着带 finally 的 try 时 finAbrupt
       * 交出的是"再记一次 + 再 break 一层" —— 于是一层层的清理都跑得到。 */
      if (unw) {
        const eq = (n) => boolOp('js_eq', [varRef(unw.unw), constReal(n)], { strict: true });
        if (unw.used.has(1)) {
          // for-of 的 close 挂在真发 Return 的这一处，所以次序是"先跑 finally，再关迭代器"
          const ret = this.finAbrupt(1, varRef(unw.rv)) ?? [...this.iterCloses(0), {
            kind: 'Return',
            value: this.fn.isMain ? null : varRef(unw.rv),
          }];
          out.push({ kind: 'If', cond: eq(1), then: block(ret), otherwise: null });
        }
        // break / continue 那两支只有真出现过才发 —— 不然会在"不在循环里"的位置发出来
        if (unw.used.has(2)) {
          out.push({ kind: 'If', cond: eq(2), then: block(this.breakAt(s.span)), otherwise: null });
        }
        if (unw.used.has(3)) {
          out.push({ kind: 'If', cond: eq(3), then: block(this.continueAt(s.span)), otherwise: null });
        }
        // 带标签的那些：4 起一格一个目标，在这个位置照记下的标签再跳一次
        for (const j of unw.jumps) {
          out.push({
            kind: 'If',
            cond: eq(j.code),
            then: block(this.labelJump({ label: j.label, span: j.span }, j.what)),
            otherwise: null,
          });
        }
      }
    }
    return [block(out)];
  }

  /**
   * "从带 finally 的 try 里跳出去"在**当前位置**怎么发：最内层的那格 finally 还没跑，
   * 所以先把"为什么出去"记进 unw（1 return / 2 break / 3 continue）、return 的值记进 rv，
   * 再 break 出那一层合成循环 —— 清理就在循环后面。没有这样的 try 就交出 null，
   * 调用方照原样发 Return / Break / Continue。
   *
   * @param {number} kind 1 return / 2 break / 3 continue
   * @param {any} [value] return 的值
   * @param {number} [tgtOL] break/continue 要跳到的那层 OIR 循环的深度：它在这层 finally
   *   **里面**的话这一跳根本没出去，清理不该现在跑 —— 交出 null 让调用方照常发。
   */
  finAbrupt(kind, value, tgtOL) {
    const top = this.fn.finStack[this.fn.finStack.length - 1];
    if (top === undefined) return null;
    if (tgtOL !== undefined && tgtOL > top.oloop) return null;
    top.used.add(kind);
    /* 数的是"到那层 finally 所属的合成循环"有几层 —— 中间夹着的只有 catch 的 try 一并跳出去
     * （量出来的：`for { try { try { break } catch {} ; log() } finally { … } }` 早先只 break
     * 了内层那一格，log 还照跑，node 印 fin0 我们印 after-inner0,fin0）。 */
    const level = this.fn.oloops - top.oloop + 1;
    const out = [exprStmt(assign(varRef(top.unw), constReal(kind)))];
    if (kind === 1) out.push(exprStmt(assign(varRef(top.rv), value)));
    out.push(level > 1 ? { kind: 'Break', level } : { kind: 'Break' });
    return out;
  }

  /**
   * try / catch 体里有没有"跳出这一块"的语句（Return，或者会被外层循环接住的
   * break/continue）。有 finally 的时候这些形状还不收 —— 见 tryStmt 里的说明。
   * 不进嵌套函数（那里的 return 是它自己的），也不进内层循环/switch 的无标签 break。
   * @returns {any} 找到的那一句（用它的 span 报错），没有就是 null
   */
  abruptIn(sts) {
    let found = null;
    const walk = (st, depth) => {
      if (!st || found) return;
      switch (st.type) {
        case 'Return': found = st; return;
        case 'Break': case 'Continue':
          if (depth === 0 || st.label) found = st;
          return;
        case 'Block': for (const x of st.body) walk(x, depth); return;
        case 'If': walk(st.cons, depth); walk(st.alt, depth); return;
        case 'Labeled': walk(st.body, depth); return;
        case 'While': case 'DoWhile': case 'For': case 'ForOf': case 'ForIn':
          walk(st.body, depth + 1);
          return;
        case 'Switch':
          for (const cs of st.cases) for (const x of cs.body) walk(x, depth + 1);
          return;
        case 'Try':
          for (const x of st.block.body) walk(x, depth);
          if (st.handler) for (const x of st.handler.body) walk(x, depth);
          if (st.finalizer) for (const x of st.finalizer.body) walk(x, depth);
          return;
        default: return;   // 函数/类声明与普通语句都不算
      }
    };
    for (const st of sts) walk(st, 0);
    return found;
  }

  /* -------------------------------------------------------- 表达式 */

  expr(e) {
    switch (e.type) {
      case 'Num': return constReal(e.value);
      // int 是 int64，外加一格无符号 64 位（决策 19 的 OMNI_DYN_UINT）。两段都要真能表达：
      // jancy 的整数字面量在 INT64_MAX 之上就是 `unsigned long`（见 frontend-jnc 的 intLit，
      // 那里写着 0xffffffffffffffffn），而"位当无符号读"也落在这一段。再往上没有落点 ——
      // 当场报，而不是一路走到 backend-c 发一个 clang 拒收的整数常量，或者悄悄回卷成别的数。
      case 'BigIntLit': {
        const v = e.value;
        if (v >= -9223372036854775807n - 1n && v <= 9223372036854775807n) return constInt(v);
        if (v <= 0xffffffffffffffffn) {
          return op('js_bigint_as_uint_n', [constReal(64), constInt(BigInt.asIntN(64, v))]);
        }
        this.err(e.span, `integer literal does not fit in 64 bits: ${v}n`);
        return constInt(0n);
      }
      case 'Str': return s16(e.value);
      /* 合成节点（genfn.js 造的）：直接发一个 ABI 里的 op。解析器不会产出它 ——
       * 它是"改写器写给降级器"的那一格，省得把状态机的每一步都翻译成用户级 JS。
       * async 那三格要作业队列：main 末尾得补一句 js_jobs_run（见 jobsTail）。 */
      case 'OpCall': {
        if (e.op === 'js_async_run' || e.op === 'js_agen_new' || e.op === 'js_aiter_next') {
          this.usesJobs = true;
        }
        return op(e.op, e.args.map((a) => this.expr(a)), e.lit ?? {});
      }
      case 'Lit': return e.value === null ? nullExpr() : constBool(e.value);
      case 'Ident': return this.ident(e);
      case 'Template': return this.template(e);
      case 'Array': return this.arrayLit(e);
      case 'Object': return this.objectLit(e);
      case 'Member': return this.member(e);
      case 'Call': return this.guarded(this.call(e));
      case 'New': return this.guarded(this.newExpr(e));
      case 'Assign': return this.assignExpr(e);
      case 'Update': return this.update(e, false);
      case 'Unary': return this.unary(e);
      case 'Binary': return this.binary(e);
      case 'Logical': return this.logical(e);
      case 'Cond':
        return ternary(truthy(this.expr(e.test)),
          this.lazy(() => this.expr(e.cons)), this.lazy(() => this.expr(e.alt)));
      // 逗号表达式：前面几个当语句摊出去，值是最后一个
      case 'Seq': {
        for (const x of e.exprs.slice(0, -1)) this.emitPre(exprStmt(this.exprDiscard(x)), e.span);
        return this.expr(e.exprs[e.exprs.length - 1]);
      }
      case 'This': {
        /* `this` 现在是**调用接收者**（ADR-0020 P1）：函数入口用 js_this_take 取一次，
         * 存进一个同名的局部量；箭头没有自己的，靠捕获拿外层那一个。所以这儿只要查名字。
         * 查不到就是**顶层**的 this —— 这个值域里给 undefined（qjs 把脚本的顶层 this
         * 当 globalThis，那一格等 P4 的 globalThis 一起做）。 */
        const ent = this.lookup('this');
        if (ent) return this.readEntry(ent);
        return undefExpr();
      }
      case 'Arrow': case 'FuncExpr':
        return this.closureExpr(e, e.type === 'FuncExpr' && e.id ? e.id : 'fn');
      case 'ClassExpr':
        return this.classExpr(e);
      case 'Regex':
        // 决策 10 的第二半：不在 .test/.replace/.match/.split 的接收位上，就求值出一格
        // 正则对象。字面量每次求值都造一格新的（ES5 起就是这个语义），所以 `g` 的
        // lastIndex 从 0 起 —— 循环里的 `re.exec(s)` 要推进，得先把它存进一个变量。
        return op('js_re_new', [s16(e.body), s16(e.flags)]);
      case 'Spread':
        this.err(e.span, 'spread is only supported in array literals and call arguments');
        return undefExpr();
      case 'ImportMeta':
        this.err(e.span, 'import.meta is not supported');
        return undefExpr();
      /* new.target（ADR-0020）：函数入口用 js_nt_take 取一次存进一格临时量（与 this
       * 同一个路子），这儿只要读它。没有那一格就是"不在函数里"或箭头 —— 给 undefined。 */
      case 'NewTarget':
        return this.fn.ntLocal ? varRef(this.fn.ntLocal) : undefExpr();
      /* 顶层 await（ES2022）：模块体本身还不是一台可挂起的状态机（genfn.js 只改造
       * async 函数），所以这一格**当场报**，而且要报清楚 —— 从前落在下面那条兜底上，
       * 印的是 "cannot lower expression 'Await'"，看不出是这件事。 */
      case 'Await':
        this.err(e.span, "top-level 'await' is not supported; put it inside an async function");
        return undefExpr();
      default:
        this.err(e.span, `cannot lower expression '${e.type}'`);
        return undefExpr();
    }
  }

  /** 值被丢掉的位置（ExprStmt、for 的 update）：i++ 不必费劲留住旧值 */
  exprDiscard(e) {
    if (e.type === 'Update') return this.update(e, true);
    // 逗号表达式在"只要副作用"的位置上：用 (A || true) && (B || true) 串起来。
    // 图的是求值顺序有保证 —— C 的 && 与 || 是定序的，而函数实参和初始化列表不是。
    if (e.type === 'Seq') {
      const forced = e.exprs.map((x) => ({
        kind: 'Logic', op: '||', type: BOOL,
        left: truthy(this.exprDiscard(x)),
        right: { kind: 'Const', type: BOOL, value: true },
      }));
      return forced.reduce((a, b) => ({ kind: 'Logic', op: '&&', left: a, right: b, type: BOOL }));
    }
    return this.expr(e);
  }

  ident(e) {
    switch (e.name) {
      case 'undefined': return undefExpr();
      case 'NaN': return constReal(NaN);
      case 'Infinity': return constReal(Infinity);
      case 'super':
        this.err(e.span, "'super' can only be called as super(...) in an Error subclass constructor");
        return undefExpr();
      default: break;
    }
    const ent = this.lookup(e.name);
    if (ent) return this.readEntry(ent);
    if (this.regexConsts.has(e.name)) {
      // 折起来的那批一律不带 g（见 collectTop），所以当值用时现造一格是对的：
      // 没有 lastIndex 要共用，造一份和共用一份不可区分
      const r = this.regexConsts.get(e.name);
      return op('js_re_new', [s16(r.body), s16(r.flags)]);
    }
    /* TDZ（规范 9.1.1.1 的 uninitialized binding）：模块级的 let / const 在这个值域里是
     * **全局槽**，所以声明**之前**读它从前静静地给 undefined —— 规范那儿是 ReferenceError。
     * 函数体里的同一件事早就是响的（"unresolved identifier"，名字还没进作用域），
     * 差的只有顶层这一格。判据只看**词法**：同一格顶层语句表里，读它的那句在声明那句之前。
     * 闭包体不算（那儿的 fn.isMain 是假）—— 它什么时候跑是运行期的事，静态判不了。 */
    if (this.globals.has(e.name)) {
      const g = this.globals.get(e.name);
      if (g.lexIdx !== undefined && this.topIdx !== null && this.topIdx < g.lexIdx
        && this.fn !== null && this.fn.isMain === true) {
        this.err(e.span, `'${e.name}' is read before its declaration (TDZ; JS throws a ReferenceError here)`);
      }
      return globalRef(g.name);
    }
    // 顶层函数当值用：包一个零捕获的转发闭包（每个函数只包一次）
    if (this.topFns.has(e.name)) return this.topFnValue(e.name);
    if (this.classes.has(e.name)) {
      this.err(e.span, `'${e.name}' is a class, which can only be used in 'new ${e.name}(...)'`);
      return undefExpr();
    }
    if (this.natives.has(e.name)) {
      this.err(e.span, `'${e.name}' is a native host function; it can only be called, not used as a value`);
      return undefExpr();
    }
    /* globalThis（ADR-0020 P4）：这个值域里没有全局环境记录，所以它就是一格普通的真对象
     * （每个 realm 一份）。挂上去的东西读得回来；内建（Math / JSON …）不在它身上 ——
     * 那是画出来的边界，不是悄悄给个空对象。用户自己声明了同名变量的话上面就接住了。 */
    if (e.name === 'globalThis') return op('js_global_this', []);
    /* 内建构造器**当值用**（ADR-0020 P1-f）：`const A = Array` / `[].constructor === Array`。
     * 要在 GLOBAL_CALLS 之前 —— String / Number / Boolean 那三个既在这儿也在那儿，而
     * `"".constructor === String` 要为真，两条路必须给**同一个值**，所以一律走 realm 这一格。
     * 静态面（Array.isArray）挂不到函数值上，从值上取是运行期报错，见 prelude $js_mk_ctors。 */
    /* 异常那八族也走这一格（ADR-0020）：`const E = Error` / `er.constructor === TypeError`。
     * 它们各有一格自己的原型，所以 `x instanceof E`（右手是变量）走原型链也是对的 ——
     * 右手是**名字**的那条路仍旧查 $cls 链，见 binary 里的 instanceof。 */
    if (REALM_CTORS.has(e.name) || ERROR_CTORS.has(e.name)) {
      return op('js_realm_ctor', [], { ctor: e.name });
    }
    /* 全局内建函数当值用（见 builtinFnValue）：`[1,2].map(Number)` /
     * `["1","2"].map(parseInt)`（后者照规范是 [1, NaN, NaN] —— 第二个实参是下标，
     * 被当成了进制）。这一格要在 STATIC_NS 之前 —— `Number` / `String` 既是命名空间
     * 也是函数，**当值用时是那个函数**。 */
    const gv = Object.hasOwn(GLOBAL_CALLS, e.name) ? GLOBAL_CALLS[e.name] : undefined;
    if (gv !== undefined && gv.len !== undefined) return this.builtinFnValue(e.name, e, e.name, gv);
    if (STATIC_NS.has(e.name)) {
      this.err(e.span, `'${e.name}' can only be used as a member base, e.g. ${e.name}.something`);
      return undefExpr();
    }
    /* `arguments`（ADR-0020 P3）：这个值域里"实参表"本来就是函数的那一格形参
     * （`args`，list<dynamic>），所以 arguments 就是它 —— 装箱之后 `.length` 与下标
     * 都是现成的。箭头**没有**自己的 arguments（规范如此），这儿就照规范骂一句，
     * 不去悄悄给它外层的那一份（那要把 args 也装 cell 传下去）。 */
    if (e.name === 'arguments' && this.fn && !this.fn.isMain) {
      if (this.fn.isArrowFn) {
        this.err(e.span, "an arrow function has no 'arguments'; take a rest parameter instead");
        return undefExpr();
      }
      return argsDyn();
    }
    this.err(e.span, `unresolved identifier '${e.name}'`);
    return undefExpr();
  }

  /**
   * `typeof <名字>` 的静态答案：null = 有运行期的格子，照常发 js_typeof。
   * 别的都是编译期就定死的字符串 —— 类与顶层函数是 "function"、命名空间（Math/JSON…）
   * 是 "object"、剩下的（根本没声明过）照规范是 "undefined"。
   */
  typeofIdent(e) {
    const n = e.name;
    if (n === 'undefined') return 'undefined';
    if (n === 'NaN' || n === 'Infinity' || n === 'globalThis') return null;
    if (this.lookup(n) || this.globals.has(n) || this.regexConsts.has(n)) return null;
    if (n === 'arguments' && this.fn && !this.fn.isMain && !this.fn.isArrowFn) return null;
    if (this.topFns.has(n) || this.classes.has(n) || this.natives.has(n)) return 'function';
    if (ERROR_CTORS.has(n) || CTOR_NAMES.has(n)) return 'function';
    if (STATIC_NS.has(n)) return 'object';
    return 'undefined';
  }

  /**
   * main（或 REPL 的一批）末尾要不要排一次微任务队列。
   * 只有这个模块真用到 Promise 时才补 —— js_jobs_run 是 JS-only 的 op（P1_JS_ONLY），
   * 无条件补的话每个 JS 程序的 C 那条腿都会当场断掉。
   */
  jobsTail() {
    return this.usesJobs === true ? [exprStmt(op('js_jobs_run', []))] : [];
  }

  /** 模板串：从第一段字符串开始一路 js_add —— 有一边是字符串，js_add 就是拼接 */
  template(e) {
    if (e.tag) {
      // String.raw`…`（没有插值）= 一个字面量：raw 就是源码里那段原文，不做转义。
      // 编译器自己靠它装 JS 前奏（backend-js/prelude.js），所以这一支必须能降。
      const tag = e.tag.type === 'Member' ? this.staticPath(e.tag) : null;
      if (tag === 'String.raw' && e.exprs.length === 0) return s16(e.quasis[0].raw);
      /* `String.raw` 带插值：原文那几段与值交替拼起来 —— 精确，不必绕道去造 strings 对象。 */
      if (tag === 'String.raw') {
        const raws = this.seq(e.exprs, (x) => this.expr(x));
        let out = s16(e.quasis[0].raw);
        for (let i = 0; i < raws.length; i++) {
          out = op('js_add', [out, op('js_str', [raws[i]])]);
          out = op('js_add', [out, s16(e.quasis[i + 1].raw)]);
        }
        return out;
      }
      /* 一般的带标签模板（ADR-0020 P3）：`t\`a${x}\`` 就是 `t(strings, x)`，其中 strings
       * 是那几段字面量的数组、身上再挂一格 `raw`（原文那一份）。数组身上挂属性这个值域
       * 支持（js_obj_set 对 list 走旁表），所以不必为它新造一种值。
       *
       * 同一处模板站点复用**同一格** strings（规范 13.2.8.4 的模板缓存）：拿它当 WeakMap
       * 键的库（lit-html / graphql-tag 那一类）靠的就是这个身份 —— 每次新造一格的话缓存
       * 永远打不中，而且 `t\`x\` === t\`x\`` 静静地为假。做法是给每个站点配一格模块级的槽，
       * **第一次求值时**才装（不是在 main 开头装：站点可能在别的全局初始化的过程中被跑到）。
       * 键用 `@tpl<n>`（不是合法的 JS 标识符，撞不上用户的名字）。 */
      const key = `@tpl${this.tplSites++}`;
      if (!this.globals.has(key)) this.globals.set(key, { name: cSafe(key) });
      const slot = () => globalRef(this.globals.get(key).name);
      const strings = ternary(
        boolOp('js_eq', [slot(), undefExpr()], { strict: true }),
        assign(slot(), op('js_obj_set', [
          arrLit(e.quasis.map((q) => s16(q.cooked))),
          s16('raw'),
          arrLit(e.quasis.map((q) => s16(q.raw))),
        ])),
        slot(),
      );
      const items = [strings, ...this.seq(e.exprs, (x) => this.expr(x))];
      const argl = box({ kind: 'ListLit', type: listType(D), items }, listType(D));
      if (e.tag.type === 'Member' && !this.staticPath(e.tag)) {
        // 成员标签（`o.tag\`…\``）：接收者是 o
        return this.onObject(e.tag.object, e.tag.optional, (obj) => {
          const t = this.temp();
          const fn = this.memberOn(assign(varRef(t), obj), e.tag);
          return op('js_call_this', [fn, varRef(t), argl]);
        });
      }
      return op('js_call_this', [this.expr(e.tag), undefExpr(), argl]);
    }
    /* 插值一律走 seq（与实参表同一招）：其中一格要 sink（成员调用会把接收者提成临时量、
     * 会抛的 op 要 guard）时，**它前面那些格先落进临时量** —— 不然提出去的那一句跑在
     * 前面，次序就反了。量出来的静默分叉：
     *   `${s.splice(1,0,9,8).length}| ${s.join(",")}` 里 join 被提到了 splice 前面，
     * 于是印的是插入前的内容（两把尺子都是插入后的）。 */
    const vals = this.seq(e.exprs, (x) => this.expr(x));
    let out = s16(e.quasis[0].cooked);
    for (let i = 0; i < vals.length; i++) {
      /* 插值那一格照规范走 **ToString**（13.2.8.5 第 5 步），不是 `+` 的那套 ToPrimitive
       * default —— 差别在带 valueOf 的对象上：`${{valueOf(){return 3},toString(){return "S"}}}`
       * 规范里是 "S"（string 提示先问 toString），从前走 js_add 的默认提示、静静地给 3。 */
      out = op('js_add', [out, op('js_str', [vals[i]])]);
      out = op('js_add', [out, s16(e.quasis[i + 1].cooked)]);
    }
    return out;
  }

  arrayLit(e) {
    /* 元素一律先走 seq（求值次序，与对象字面量、实参表同一招）：其中一格要 sink 时，
     * 它前面那些格先落进临时量。量出来的静默分叉：
     * `[b.splice(1,1).length, b.join(",")]` 里 join 跑在了 splice 前面。 */
    const vals = this.seq(e.elements, (el) => {
      /* 洞（`[1,,3]`）**当场报**。这个值域里的 list 是一排稠密的 dyn，表达不出洞，而洞
       * 与 undefined 只对得上一半：从前这儿悄悄填 undefined，于是 `1 in [1,,3]` 给 true
       * （qjs 是 false）、`forEach` 会走进那一格、`Object.keys` 也多列一个 "1" ——
       * 三处都是**悄悄的错答案**（从前的注只记了 `in` 那一格，量下来不止）。
       * 与 `delete a[i]` 那一格同一条判据、同一个理由：不假装做到了。
       * 真想要一格 undefined 就写出来。 */
      if (el === null) {
        this.err(e.span, 'a hole in an array literal cannot be represented; write undefined instead');
        return undefExpr();
      }
      if (el.type === 'Spread') return this.guarded(op('js_iter', [this.expr(el.arg)]));
      return this.expr(el);
    });
    /** @type {any[]} 一段段拼：连续的普通元素是一个 ListLit，展开的是 js_iter */
    const parts = [];
    let run = [];
    let firstIsSpread = false;
    e.elements.forEach((el, i) => {
      if (el !== null && el.type === 'Spread') {
        if (run.length) { parts.push(arrLit(run)); run = []; }
        if (parts.length === 0) firstIsSpread = true;
        parts.push(vals[i]);
        return;
      }
      run.push(vals[i]);
    });
    if (run.length || parts.length === 0) parts.push(arrLit(run));
    /* `[...a]` 必须是**一份新的**数组：js_iter 在 list 上是恒等，一段就交回去的话
     * `const b = [...a]` 拿到的就是 a 自己 —— `b.push(x)` / `b.sort()` 会改到 a
     * （量出来的 silent 分叉：`[...people].sort(…)` 把原数组也排了，`people[0]` 于是变了）。
     * 头一段是展开时前面垫一格空字面量，concat 就给出新数组。 */
    if (firstIsSpread) parts.unshift(arrLit([]));
    return parts.reduce((a, b) => op('js_arr_concat', [a, b]));
  }

  /** 对象字面量：js_obj_set / js_obj_assign 都返回对象本身，所以能纯表达式地串起来 */
  objectLit(e) {
    /* 属性值一律先走 seq（求值次序）：其中一格要 sink（成员调用要把接收者提成临时量、
     * 会抛的 op 要 guard）时，它前面那些格**先落进临时量** —— 不然提出去的那一句会跑在
     * 前面几格之前。量出来的静默分叉：`{ x: a.splice(1,1).length, y: a.join(",") }`
     * 里 join 跑在了 splice 前面，于是 y 是删之前的内容（两把尺子都是删之后的）。
     * 计算键仍在各自那一格里就地降 —— 键在这个值域里绝大多数是常量。 */
    const keys = [];
    const vals = this.seq(e.props, (p) => {
      if (p.kind === 'spread') { keys.push(null); return this.expr(p.arg); }
      if (p.kind === 'get' || p.kind === 'set') {
        keys.push(p.computed ? this.expr(p.key) : s16(this.keyName(p.key, p.span)));
        /* 访问器那两格的 name 照规范**带前缀**（10.2.9 SetFunctionName 的 prefix 实参）：
         * { get g() {} } 那一格函数的 name 是 "get g" 而不是 "g"。从前一格都没给（是 ""），
         * 按 name 打日志或分派的代码会静静地看不见它。计算键那一格的名字只有运行期才知道，
         * 照旧空着（与计算键的方法同一条边界，见 ADR-0020）。 */
        const nm = p.computed ? '' : `${p.kind} ${this.keyName(p.key, p.span)}`;
        return this.closureExpr(fnNodeOfProp(p), p.kind, { fnName: nm });
      }
      if (p.kind !== 'init') {
        this.err(p.span, `object literal property kind '${p.kind}' is not lowered yet`);
        keys.push(null);
        return null;
      }
      /* `{ x = 1 }` 只有当**解构模式**用才有意义（`({x = 1} = o)`）；真当对象字面量用时
       * 这儿报错 —— 解析器为了那条解构路先收下了它（见 parser 的 shorthandDefault）。 */
      if (p.shorthandDefault === true) {
        this.err(p.span, "'=' in an object literal is only valid in a destructuring pattern");
        keys.push(null);
        return null;
      }
      keys.push(p.computed ? this.expr(p.key) : s16(this.keyName(p.key, p.span)));
      /* 方法简写 `{ m() {} }` 就是一格函数值属性（可写、可枚举）—— 与
       * `{ m: function() {} }` 在这个值域里没有区别（差的那一格是 home object，
       * 而它只被 super 用到）。解析器把方法摊成 params/rest/body，所以先拼回函数节点。 */
      if (p.method) {
        return this.closureExpr(fnNodeOfProp(p), p.computed ? 'method' : this.keyName(p.key, p.span),
          { fnName: p.computed ? '' : this.keyName(p.key, p.span) });
      }
      return this.propValue(p);
    });
    /* 带**访问器**（或 `__proto__:`）的字面量要一格**真对象**：访问器与原型都住在属性槽上，
     * 而这个值域里普通对象在 C 那条腿上是一格 dict（没有槽）。JS 那条腿上两种都是 $js_obj_new，
     * 所以这一句只改 C 那边的表示，不改任何可观察的答案（ADR-0020 P1-c）。 */
    /* 计算键也走真对象：`{[s]: 1}` 里 s 可能是个**符号**，而这条腿上的"普通对象"是一格
     * dict —— dict 的键是串，挂不了符号（C 那侧当场报："符号键只在真对象上成立"）。
     * 静态判不出那个键是串还是符号，所以一律给真对象；字面量里带计算键的写法本来就少，
     * 而这一格换来的是"符号键的对象字面量四条腿都成立"。 */
    const wantSlots = e.props.some((p) => p.kind === 'get' || p.kind === 'set' || p.computed === true
      || (!p.computed && !p.method && p.shorthand !== true && p.key !== undefined
        && (p.key.name === '__proto__' || p.key.value === '__proto__')));
    let out = op(wantSlots ? 'js_obj_slots' : 'js_obj_new', []);
    e.props.forEach((p, i) => {
      if (vals[i] === null) return;
      if (p.kind === 'spread') { out = op('js_obj_assign', [out, vals[i]]); return; }
      if (p.kind === 'get' || p.kind === 'set') {
        /* 访问器（ADR-0020 P1）：降成一次 defineProperty —— 描述符本身也是一格对象。
         * enumerable/configurable 都是 true（字面量里的访问器就是这个默认）。
         * 同一个键上 get 与 set 分两次定义：js_obj_def 在已有的访问器槽上只覆盖
         * **desc 里出现过**的字段，所以先 get 后 set 两条都留得住。 */
        let desc = op('js_obj_set', [op('js_obj_new', []), s16(p.kind), vals[i]]);
        desc = op('js_obj_set', [desc, s16('enumerable'), constBool(true)]);
        desc = op('js_obj_set', [desc, s16('configurable'), constBool(true)]);
        out = op('js_obj_def', [out, keys[i], desc]);
        return;
      }
      /* `{ __proto__: v }` 是**设原型**，不是加一格属性（规范 B.3.1）。只有
       * "名字 : 值"这一种形状算：`{ __proto__ }` 简写、`{ __proto__() {} }` 方法、
       * `{ ["__proto__"]: v }` 计算键都是普通属性。
       * 与规范差一格：给的既不是对象也不是 null 时规范整句忽略，这儿照 js_obj_proto_set
       * 的口径写进去 —— 那一格与 Object.setPrototypeOf 共用，改要一起改。 */
      if (!p.computed && !p.method && p.shorthand !== true
        && this.keyName(p.key, p.span) === '__proto__') {
        const t = this.temp();
        this.emitPre(exprStmt(assign(varRef(t), out)), p.span);
        this.emitPre(exprStmt(op('js_obj_proto_set', [varRef(t), vals[i]])), p.span);
        out = varRef(t);
        return;
      }
      out = op('js_obj_set', [out, keys[i], vals[i]]);
    });
    return out;
  }

  /** 属性值。匿名函数拿**属性名**当 name（规范如此：`{ m: () => {} }` 的 m.name 是 "m"） */
  propValue(p) {
    const v = p.value;
    const anon = v && (v.type === 'Arrow' || (v.type === 'FuncExpr' && !v.id));
    if (anon && !p.computed) {
      const n = this.keyName(p.key, p.span);
      return this.closureExpr(v, n, { fnName: n });
    }
    return this.expr(v);
  }

  unary(e) {
    switch (e.op) {
      case '!': return box(notB(truthy(this.expr(e.arg))), BOOL);
      case '-': return op('js_neg', [this.expr(e.arg)]);
      case '+': return op('js_num_of', [this.expr(e.arg)]);
      case '~': return op('js_bitnot', [this.expr(e.arg)]);
      case 'typeof': {
        /* `typeof 一个没声明的名字`在 JS 里是 "undefined"，**不抛 ReferenceError** ——
         * 特性探测（`typeof structuredClone === "function"`）全靠这一条。所以名字这一支
         * 先静态问一次：拿不到运行期的格子就直接给常量，别在编译期骂 unresolved。 */
        if (e.arg.type === 'Ident') {
          const t = this.typeofIdent(e.arg);
          if (t !== null) return s16(t);
        }
        return op('js_typeof', [this.expr(e.arg)]);
      }
      case 'void': {
        /* void x：算一遍 x（副作用要留着），值是 undefined。逗号那条路同一个办法 ——
         * 把它作为语句先发出去，表达式的位置交出 undefined。 */
        this.emitPre(exprStmt(this.exprDiscard(e.arg)), e.span);
        return undefExpr();
      }
      case 'delete': {
        const t = e.arg;
        if (t.type !== 'Member') {
          this.err(e.span, "'delete' needs a member expression");
          return undefExpr();
        }
        const key = t.computed ? this.expr(t.prop) : this.propKey(t.name);
        return op('js_obj_delete', [this.expr(t.object), key]);
      }
      default:
        this.err(e.span, `unary '${e.op}' is not supported`);
        return undefExpr();
    }
  }

  binary(e) {
    const A = () => this.expr(e.left);
    const B = () => this.expr(e.right);
    switch (e.op) {
      case '+': return op('js_add', [A(), B()]);
      case '-': case '*': case '/': case '%':
        return op('js_arith', [A(), B()], { op: e.op });
      // `**` 与别的算术同一格（op 字符 'p'，与 js_math 的 pow 对齐）。int 那一支照样回卷到
      // 64 位 —— 这个值域里的 int 就是 int64（ADR-0005），不是无界的 BigInt。
      case '**': return op('js_arith', [A(), B()], { op: 'p' });
      case '<': case '>':
        return op('js_cmp', [A(), B()], { op: e.op });
      case '<=': return op('js_cmp', [A(), B()], { op: 'l' });
      case '>=': return op('js_cmp', [A(), B()], { op: 'g' });
      case '===': return op('js_eq', [A(), B()], { strict: true });
      case '==': return op('js_eq', [A(), B()], { strict: false });
      case '!==': return box(notB(boolOp('js_eq', [A(), B()], { strict: true })), BOOL);
      case '!=': return box(notB(boolOp('js_eq', [A(), B()], { strict: false })), BOOL);
      case '&': case '|': case '^':
        return op('js_bitop', [A(), B()], { op: e.op });
      case '<<': return op('js_bitop', [A(), B()], { op: '<' });
      case '>>': return op('js_bitop', [A(), B()], { op: '>' });
      case '>>>': return ushr(A(), B());
      case 'in': {
        /* `#x in o`（ES2022 的 brand check）：左边不是表达式而是一个**私有名** ——
         * 它的键是符号（见 privKey），问的是"自有"而不是沿原型链，所以走 has_own。 */
        if (e.left.type === 'Ident' && typeof e.left.name === 'string' && e.left.name.startsWith('#')) {
          return op('js_obj_has_own', [B(), this.privKey(e.left.name)]);
        }
        return op('js_obj_has', [B(), A()]);
      }
      case 'instanceof': {
        /* 两条路（ADR-0020 P1-f）：
         *   - Error 与它的子类查 `$cls` 链（决策 15，那是 throw/catch 的现役机制）；
         *   - 别的走**真原型链**（js_instanceof：先问 Symbol.hasInstance，再顺着
         *     右边那个类对象的 prototype 往上找）。右边是任意表达式也行。 */
        const rhs = e.right.type === 'Ident' ? e.right.name : null;
        const isErr = (rhs !== null && ERROR_CTORS.has(rhs)) || (rhs && this.classes.get(rhs)?.isError);
        if (isErr) return op('js_is_a', [A(), s16(rhs)]);
        /* 右边是内建构造器的名字（`x instanceof Object` / `... instanceof Array`）：
         * 这个值域里那些构造器**取不出函数值来**（封闭 ABI），但 instanceof 真正要的只是
         * 它的 prototype —— 直接拿 realm 上那一格比原型链（js_instanceof_p）。 */
        if (rhs !== null && REALM_CTORS.has(rhs) && !this.lookup(rhs) && !this.globals.has(rhs)
          && !this.classes.has(rhs)) {
          return op('js_instanceof_p', [A(), op('js_realm_proto', [], { proto: rhs })]);
        }
        return op('js_instanceof', [A(), B()]);
      }
      default:
        this.err(e.span, `binary '${e.op}' is not supported`);
        return undefExpr();
    }
  }

  /**
   * && || ??：JS 里它们的值是**其中一个操作数**，不是布尔。左边只能算一次，所以
   * 存进临时量（Assign 在 OIR 里是表达式），右边留在 Ternary 的惰性分支里。
   */
  logical(e) {
    const t = this.temp();
    const l = assign(varRef(t), this.expr(e.left));
    const r = this.lazy(() => this.expr(e.right));
    if (e.op === '&&') return ternary(truthy(l), r, varRef(t));
    if (e.op === '||') return ternary(truthy(l), varRef(t), r);
    // ?? 只在 null / undefined 时取右边 —— 宽松相等对 null 正好是这两个
    return ternary(boolOp('js_eq', [l, nullExpr()], { strict: false }), r, varRef(t));
  }

  /* -------------------------------------------------------- 成员与调用 */

  /** 静态命名空间的点路径（JSON.stringify / process.stdout.write），被局部量遮住就不算 */
  staticPath(node) {
    // 从里往外收，最后翻过来。这里不用 unshift 是因为 reverse 一趟就够
    //（第一百〇四刀之后 ABI 里有 unshift 了，但它是 O(n)，这条路上没必要）
    const parts = [];
    let cur = node;
    while (cur.type === 'Member' && !cur.computed) { parts.push(cur.name); cur = cur.object; }
    parts.reverse();
    if (cur.type !== 'Ident') return null;
    if (this.lookup(cur.name) || this.globals.has(cur.name) || !STATIC_NS.has(cur.name)) return null;
    return [cur.name, ...parts].join('.');
  }

  member(e) {
    // `super.x`（不是调用）：从父类原型上取一格属性（ADR-0020 P1-f）
    if (!e.computed && e.object.type === 'Ident' && e.object.name === 'super' && !this.lookup('super')) {
      const sp = this.superProtoRef(e.span);
      return sp === null ? undefExpr() : op('js_getp', [sp, s16(e.name), this.superRecv()]);
    }
    const path = this.staticPath(e);
    if (path) {
      /* 这几张表都拿**用户写的名字**当键，所以一律 Object.hasOwn 再取：
       * `o.hasOwnProperty("a")` / `valueOf()` 这些名字在 Object.prototype 上，
       * `表[名字]` 会拿到继承来的函数当成"表里有这一格"，当场崩在下游
       * （量出来的：`({a:1}).hasOwnProperty("a")` 崩在 methodCall 的 JS_ALL 查表）。 */
      const spec = Object.hasOwn(STATIC_PROPS, path) ? STATIC_PROPS[path] : undefined;
      // lit 也要带上：well-known Symbol（Symbol.iterator …）就是"名字是编译期常量"的 op
      if (spec) return op(spec.op, [], spec.lit ?? {});
      if (path.startsWith('process.env.')) return op('js_proc_env', [s16(path.slice('process.env.'.length))]);
      /* 常量那一族（ADR-0020 P4）：Number.EPSILON / Math.PI 这些没有运行期成分 ——
       * 直接就是一个 real 字面量，不必为它们各开一个 op。非有限的那几个
       * （Infinity / NaN）不在这儿：字面量要能落到 C 里，那是另一格。 */
      if (Object.hasOwn(CONST_PROPS, path)) return constReal(CONST_PROPS[path]);
      /* 最长的**已注册前缀**（ADR-0020 P1-f）：`Object.prototype.toString` 就是
       * "取 Object.prototype 这一格，再取它的 toString" —— 内建原型现在是真对象，
       * 所以后半段是普通的属性读。这一条让 `X.prototype.m.call(…)` 那类写法通了。 */
      if (!e.computed && e.object.type === 'Member' && this.staticPrefix(e.object)) {
        return op('js_obj_get', [this.member(e.object), s16(e.name)]);
      }
      // 内建静态面当值用：`const f = Object.keys` —— 只认表里标了 len 的那些（见 builtinFnValue）
      const fv = Object.hasOwn(STATIC_CALLS, path) ? STATIC_CALLS[path] : undefined;
      if (fv !== undefined && fv.len !== undefined) return this.builtinFnValue(path, e, e.name, fv);
      /* 内建函数值上的属性读：`Math.abs.name` / `Object.assign.length` —— 前半段求成那个
       * 薄包装的值，后半段就是普通的属性读（与上面 `X.prototype.m` 那一条同一个形状）。 */
      if (!e.computed && e.object.type === 'Member') {
        const base = this.staticPath(e.object);
        const bs = base !== null && Object.hasOwn(STATIC_CALLS, base) ? STATIC_CALLS[base] : undefined;
        if (bs !== undefined && bs.len !== undefined) {
          return this.memberOn(this.builtinFnValue(base, e.object, e.object.name, bs), e);
        }
      }
      /* 内建构造器身上的 name / length（Array.name / Number.length）：构造器现在取得出值来
       * （js_realm_ctor），这两格就是那个值上的普通属性读（住在 Function.prototype 上）。
       * **只**放这两个名字过 —— 别的静态面照旧当场报，不然 `Array.fromAsync` 这类没做的
       * 东西会从"响的拒绝"变成"静静地 undefined"。 */
      if (!e.computed && e.object.type === 'Ident' && REALM_CTORS.has(e.object.name)
        && !this.lookup(e.object.name) && !this.classes.has(e.object.name)
        && (e.name === 'name' || e.name === 'length')) {
        return op('js_obj_get', [op('js_realm_ctor', [], { ctor: e.object.name }), s16(e.name)]);
      }
      this.err(e.span, `'${path}' is not in the closed ABI (ADR-0011 decision 2)`);
      return undefExpr();
    }
    return this.onObject(e.object, e.optional, (obj) => this.memberOn(obj, e));
  }

  /**
   * 内建函数**当值用**（ADR-0020 P1-f）：`const f = Object.keys` / `[1,2].map(Number)`。
   *
   * 造一个薄包装 —— 形参就是 op 的那几个，体是**原封不动的那一句调用**，于是补 undefined、
   * lit、pre、usesJobs 全都还走 abiCall 那条路，不必在这儿复述一遍。
   *
   * 只有表里标了 `len` 的名字有这一格：`len` 是 **JS 那侧的 arity**，和 op 的形参个数不是
   * 一回事（js_math 收 2 个，而 `Math.abs.length` 是 1）。没标的照旧当场报错 —— 给一个
   * length 会撒谎的值是退步。
   *
   * `single: true` 与顶层函数当值用同一个理由：`Object.keys === Object.keys` 要为真。
   */
  builtinFnValue(key, callee, name, spec) {
    /* 缓存的键是"这一格到底是哪个函数"，不是写法：`parseInt` 与 `Number.parseInt` 在规范里
     * 是**同一个函数对象**（`Number.parseInt === parseInt` 为真），两条写法落到同一个 op、
     * 同一个 name、同样的 argc/len 上，所以键取那几样。从前键是写法本身，于是同一个内建
     * 取两次得到两个闭包，`===` 悄悄给 false。 */
    const ck = `${name}|${spec.op ?? key}|${spec.argc}|${spec.len}`;
    const hit = this.builtinFns.get(ck);
    if (hit) return this.makeClosure(hit);
    const sp = callee.span;
    /* 收**可变实参**的那几个（Math.max / min / hypot 的 assoc、fromCharCode 的 fold、
     * console.log 的 join）：包装不能按 spec.argc 定死形参个数 —— 那样 `F.max(1,2,3)` 只
     * 拿前两格（量出来的：一段真程序里 `max(1,2,3) - min(4,5)` 给 -2，两把尺子是 -1），
     * 而零实参那档给 NaN（规范是 -Infinity）。所以包成 `(...xs) => Math.max(...xs)`：
     * 带展开的调用走 abiSpreadCall 那条路，运行期 reduce，一格不差。 */
    const variadic = spec.assoc === true || spec.fold !== undefined || spec.join !== undefined;
    let arrow;
    if (variadic) {
      const rest = { type: 'Ident', name: '_bs', span: sp };
      arrow = {
        type: 'Arrow', params: [], rest, expression: true, span: sp,
        body: {
          type: 'Call', callee, optional: false, span: sp,
          args: [{ type: 'Spread', arg: { ...rest }, span: sp }],
        },
      };
    } else {
      const ps = [];
      for (let i = 0; i < spec.argc; i++) ps.push({ type: 'Ident', name: `_b${i}`, span: sp });
      arrow = {
        type: 'Arrow', params: ps, rest: null, expression: true, span: sp,
        body: { type: 'Call', callee, args: ps.map((p) => ({ ...p })), optional: false, span: sp },
      };
    }
    const rec = this.closureOf(arrow, name, { fnName: name, fnLen: spec.len, single: true });
    this.builtinFns.set(ck, rec);
    return this.makeClosure(rec);
  }

  /**
   * 链上的接收者：先把 objNode 求出来，再把 build 接在后面。
   *
   * `?.` 的短路是**整条链**的 —— `a?.b.find(f)` 里 a 为 null，`.fields` 与 `find` 都
   * 不该发生。所以判空不能就地包住那一个成员访问，而要把"链上剩下的部分"整体放进
   * else 分支（lazy）里。为此这里穿过成员链往里递归，把每个 `?.` 的守卫从内往外套。
   *
   * @param {any} objNode  接收者的 AST
   * @param {boolean} optional  消费这个接收者的那一环是不是 `?.`
   * @param {(obj: any) => any} build  拿到接收者的值以后继续降级
   */
  onObject(objNode, optional, build) {
    const next = !optional ? build : (obj) => {
      const t = this.temp();
      const cond = boolOp('js_eq', [assign(varRef(t), obj), nullExpr()], { strict: false });
      return ternary(cond, undefExpr(), this.lazy(() => build(varRef(t))));
    };
    // 静态路径（Math.PI 之类）不是普通成员访问，交给 expr 走 ABI 那条路
    if (objNode.type === 'Member' && !this.staticPath(objNode)) {
      return this.onObject(objNode.object, objNode.optional, (obj) => next(this.memberOn(obj, objNode)));
    }
    return next(this.expr(objNode));
  }

  memberOn(obj, e) {
    if (e.computed) return op('js_idx_get', [obj, this.expr(e.prop)]);
    /* x.constructor（ADR-0020 P1-f）：读法与普通属性读一模一样，单独占一格 op 只为让
     * C 那条腿在**发射期**就拒 —— 构造器对象住在 realm 里（真对象那一族，JS 独有），
     * 走 js_obj_get 的话 C 会静静地给 undefined。计算写法 o["constructor"] 不走这儿。 */
    if (e.name === 'constructor') return op('js_ctor_get', [obj]);
    if (Object.hasOwn(JS_PROPS, e.name)) return op(`js_p_${e.name}`, [obj]);
    return op('js_obj_get', [obj, this.propKey(e.name)]);
  }

  /**
   * 实参列表。函数的形参类型是 list&lt;dynamic&gt;（不是 dynamic），所以这里要的是**没装箱**
   * 的 ListLit；有展开的时候先按 dynamic 拼好，再用 asList 拆回来。
   */
  argList(args) {
    if (!args.some((a) => a.type === 'Spread')) {
      return { kind: 'ListLit', type: listType(D), items: this.seq(args, (a) => this.expr(a)) };
    }
    const parts = [];
    let run = [];
    let firstIsSpread = false;
    for (const a of this.seq(args, (a) => (a.type === 'Spread' ? { spread: this.expr(a.arg) } : this.expr(a)))) {
      if (a && a.spread !== undefined) {
        if (run.length) { parts.push(arrLit(run)); run = []; }
        if (parts.length === 0) firstIsSpread = true;
        parts.push(this.guarded(op('js_iter', [a.spread])));
        continue;
      }
      run.push(a);
    }
    if (run.length) parts.push(arrLit(run));
    /* `f(...a)` / `Array.of(...a)` 交出的实参表必须是**一份新的** list：js_iter 在 list 上
     * 是恒等，一段就交回去的话 rest 形参（或 Array.of 的结果）就是 a 自己，往上 push
     * 会改到调用方的数组（量出来的 silent 分叉：`Array.of(...a)` 之后 a 多了一格）。 */
    if (firstIsSpread) parts.unshift(arrLit([]));
    const joined = parts.reduce((a, b) => op('js_arr_concat', [a, b]));
    return { kind: 'Builtin', name: 'asList', args: [joined], type: listType(D) };
  }

  call(e) {
    if (e.optional) {
      /* `f?.()` / `o.f?.()`（ADR-0020 P3）：函数值是 null 或 undefined 就整句不调、
       * 结果是 undefined。摊法与 `?.` 取属性那一条同一个（onObject 的 optional 分支）：
       * 先算进临时量，再拿一次**宽松**相等比 null（宽松对 null 正好覆盖 undefined）。
       * 成员形态还要把接收者留住 —— `o.f?.()` 里的 this 是 o。 */
      const c0 = e.callee;
      const t = this.temp();
      if (c0.type === 'Member' && !this.staticPath(c0)) {
        return this.onObject(c0.object, c0.optional, (obj) => {
          const r = this.temp();
          const fn = assign(varRef(t), this.memberOn(assign(varRef(r), obj), c0));
          return ternary(boolOp('js_eq', [fn, nullExpr()], { strict: false }), undefExpr(),
            this.lazy(() => op('js_call_this',
              [varRef(t), varRef(r), box(this.argList(e.args), listType(D))])));
        });
      }
      return ternary(boolOp('js_eq', [assign(varRef(t), this.expr(c0)), nullExpr()], { strict: false }),
        undefExpr(), this.lazy(() => this.dynCall(varRef(t), e.args)));
    }
    const c = e.callee;
    if (c.type === 'Ident') {
      // super(msg)：Error 子类那一支就是把 message 填上（决策 15）
      if (c.name === 'super' && !this.lookup('super')) {
        if (this.fn.isCtor && this.fn.superIsError) {
          const msg = e.args.length ? this.expr(e.args[0]) : undefExpr();
          return op('js_obj_set', [this.readEntry(this.lookup('this')), s16('message'), msg]);
        }
        /* 原型链那一支（ADR-0020 P1-f）：`super(...)` 就是"拿**当前的 this** 调父类的
         * $init" —— 父类的 $init 不分配实例，所以派生类的字段与构造器体接着往同一个
         * 对象上写。这也是为什么分配那一步放在 `new C()` 那边。 */
        const sup = this.fn.classOf ? this.classes.get(this.fn.classOf)?.superName : null;
        if (sup) {
          const call = op('js_call_this', [
            op('js_obj_get', [globalRef(this.globals.get(sup).name), classInitKey()]),
            this.readEntry(this.lookup('this')),
            box(this.argList(e.args), listType(D)),
          ]);
          /* 派生类的字段在 **super() 回来之后**才初始化（规范 15.7.14：super 之前 this
           * 还没绑好）。写了构造器的派生类因此把那一批挪到这儿发 —— 量出来的分叉：
           * `class B extends A { w = this.x + 100; constructor(){ super(); } }` 里
           * this.x 是 undefined，因为字段跑在了父类的构造器之前。 */
          const fieldsAfter = this.fn.fieldsAfterSuper;
          if (fieldsAfter !== undefined) {
            this.fn.fieldsAfterSuper = undefined;
            this.emitPre(exprStmt(call), e.span);
            for (const st of fieldsAfter()) this.emitPre(st, e.span);
            return undefExpr();
          }
          return call;
        }
        this.err(e.span, "'super(...)' is only available in the constructor of a derived class");
        return undefExpr();
      }
      if (!this.lookup(c.name) && !this.globals.has(c.name)) {
        if (this.topFns.has(c.name)) {
          return { kind: 'Call', func: this.topFns.get(c.name), name: c.name, args: [this.argList(e.args)], type: D };
        }
        /* eval 与 Function(src)（ADR-0020 P6）：这两样要**编译器在运行期在场**。
         * 落点是一格运行期的钩子（host/src_eval.js 装，prelude 的 $js_src_eval 找）——
         * 在本进程里跑的时候（omni run / REPL）有，编成产物之后没有，那时当场报错。 */
        if (c.name === 'eval') {
          if (e.args.length !== 1) {
            this.err(e.span, 'eval takes exactly 1 argument');
            return undefExpr();
          }
          return op('js_src_eval', [this.expr(e.args[0])]);
        }
        if (c.name === 'Function') return this.fnFromSrc(e);
        /* Array(...) 与 new Array(...) 同义（规范 23.1.1.1：Array 当函数调用时也走
         * 同一条构造）。从前只认 new 那一形，`Array(1, 2)` 报的是 unresolved function。 */
        if (c.name === 'Array' && !this.lookup(c.name) && !this.classes.has(c.name)) {
          return this.newExpr(e);
        }
        // 原生宿主面：名字直接就是一个 ABI op（决策 17）
        const nat = this.natives.get(c.name);
        if (nat) return this.abiCall({ op: nat, argc: JS_ALL[nat].arity }, e.args, e.span, c.name);
        // 外部 C 符号（ADR-0014 决策 4）：实参个数由 C 的原型定死，不补 undefined
        const cn = this.cnatives.get(c.name);
        if (cn) return this.cCall(cn, e.args, e.span, c.name);
        const g = Object.hasOwn(GLOBAL_CALLS, c.name) ? GLOBAL_CALLS[c.name] : undefined;
        if (g) return this.abiCall(g, e.args, e.span, c.name);
        this.err(e.span, `unresolved function '${c.name}'`);
        return undefExpr();
      }
      return this.dynCall(this.ident(c), e.args);
    }
    if (c.type === 'Member') {
      /* `super.m(...)`（ADR-0020 P1-f）：函数从**父类的原型**上取，`this` 还是当前的
       * 接收者 —— 这就是 super 与普通成员调用唯一的差别（不然 `super.m()` 里的 this
       * 会变成父类原型自己）。 */
      if (!c.computed && c.object.type === 'Ident' && c.object.name === 'super' && !this.lookup('super')) {
        const sp = this.superProtoRef(e.span);
        if (sp === null) return undefExpr();
        return op('js_call_this', [
          op('js_getp', [sp, s16(c.name), this.superRecv()]),
          this.readEntry(this.lookup('this')),
          box(this.argList(e.args), listType(D)),
        ]);
      }
      const path = this.staticPath(c);
      if (path) {
        // Array.of(…) 收可变实参 —— 它就是一格数组字面量（展开也照走 argList）
        if (path === 'Array.of') return box(this.argList(e.args), listType(D));
        /* String.raw 的**普通调用**形态：第一格是身上挂着 raw 的对象，其余是插值。
         * tag 形态（String.raw`…`）在模板那儿就折成字面量了，不走这条。
         * 插值收可变实参，所以余下的先摊成一格数组 —— 与 Array.of 同一条路。 */
        if (path === 'String.raw') {
          if (e.args.length === 0) {
            this.err(e.span, 'String.raw() needs the strings object as its first argument');
            return undefExpr();
          }
          if (e.args[0].type === 'SpreadElement') {
            this.err(e.span, 'String.raw(...xs) spread in the first argument is not supported');
            return undefExpr();
          }
          return op('js_str_raw', [
            this.expr(e.args[0]),
            box(this.argList(e.args.slice(1)), listType(D)),
          ]);
        }
        const spec = Object.hasOwn(STATIC_CALLS, path) ? STATIC_CALLS[path] : undefined;
        if (spec) return this.abiCall(spec, e.args, e.span, path);
        /* 已注册前缀那一条（ADR-0020 P1-f）：`Object.prototype.toString.call(x)` ——
         * 前半段求值出内建原型（真对象），后半段就是普通的成员调用，往下落到通用路径。 */
        if (!this.staticPrefix(c)) {
          this.err(e.span, `'${path}' is not in the closed ABI (ADR-0011 decision 2)`);
          return undefExpr();
        }
      }
      const re = this.regexCall(c, e);
      if (re) return re;
      /* splice / toSpliced：收可变实参，而且**实参个数是语义的一部分** —— 走不了定长的
       * 成员派发器（那条路把缺席的实参补成 undefined，`splice(1)`（删到底）就变成
       * `splice(1, undefined)`（一格都不删））。整串实参摊成一格 list 交给 op，
       * 与 push 的可变实参那一支同一招。 */
      if (!c.computed && (c.name === 'splice' || c.name === 'toSpliced')) {
        const o = c.name === 'splice' ? 'js_arr_splice' : 'js_arr_to_spliced';
        return this.onObject(c.object, c.optional,
          (recv) => op(o, [recv, box(this.argList(e.args), listType(D))]));
      }
      if (!c.computed && Object.hasOwn(JS_METHODS, c.name)) return this.methodCall(c, e);
      /* 兜底：属性里存着的函数值。**接收者要传下去**（ADR-0020 P1）—— `o.m()` 里的
       * this 就是 o，这是原型上的方法、call/apply/bind、方法借用全都依赖的一格。
       * 从前这儿是 dynCall（丢掉接收者），于是 `o.m()` 里的 this 只能靠捕获的 cell。
       *
       * 接收者**先存进临时量**：它要用两次（取属性、当 this），而 onObject 交出来的是
       * 一个表达式，用两次就算两次 —— `c.bump().value()` 于是 bump 了两趟（量出来的：
       * tests/js-exec 的 07-classes 印 4 而不是 3）。 */
      return this.onObject(c.object, c.optional, (obj) => {
        const t = this.temp();
        const f = this.memberOn(assign(varRef(t), obj), c);
        return op('js_call_this', [f, varRef(t), box(this.argList(e.args), listType(D))]);
      });
    }
    return this.dynCall(this.expr(c), e.args);
  }

  /**
   * 成员派发器的调用：缺席的实参补 js_undef。
   * 实参比派发器的形参还多就说明这**不是** ABI 表里那个成员，而是用户自己的同名方法
   * （量过：parse/parser.js 的 `at(kind, n)` 撞上了字符串/数组的 `at`）。那就退回
   * "取属性、当函数调用"的通用路径 —— 和决策 12 派发器兜底走的是同一条路。
   * 展开不走这条：ABI 的 op 是定长的，而接收者很可能是 list（js_obj_get 会当场报错），
   * 所以照旧报错，让调用方自己摊成循环。
   */
  methodCall(c, e) {
    const name = c.name;
    const argc = JS_ALL[`js_m_${name}`].member.argc;
    return this.onObject(c.object, c.optional, (recv) => {
      // push 是唯一一个源码里真的会写可变实参的 ABI 成员（量过：14 处 `push(...xs)`）。
      // 实参先拼成一个 list，再整段追加 —— 定长的 op 表达不了可变实参。
      if (name === 'push' && (e.args.length !== 1 || e.args[0].type === 'Spread')) {
        return op('js_arr_push_all', [recv, box(this.argList(e.args), listType(D))]);
      }
      /* concat 也收可变实参，而成员派发器是定长的。它是**可结合**的（一次拼一段），
       * 所以多实参摊成一串调用、展开在运行期 reduce —— 与封闭 ABI 那边的 assoc 同一招。
       * push 不在这儿：它有专门的 js_arr_push_all（上面那一支）。
       * 一个实参都不给（`a.concat()`）是**拷一份**：缺席的实参会补成 undefined，而
       * `concat(undefined)` 在 JS 里是"末尾多一格 undefined" —— 两者必须分开
       * （量出来的 silent 分叉：`a.concat().length` 多了 1）。 */
      if (name === 'concat' && e.args.length === 0) {
        return op('js_m_concat', [recv, arrLit([])]);
      }
      if (name === 'concat' && (e.args.length > 1 || e.args.some((a) => a.type === 'Spread'))) {
        if (!e.args.some((a) => a.type === 'Spread')) {
          let out = recv;
          for (const a of e.args) out = op('js_m_concat', [out, this.expr(a)]);
          return out;
        }
        const idn = (nm) => ({ type: 'Ident', name: nm, span: e.span });
        const f = this.closureExpr({
          type: 'Arrow', params: [idn('_c0'), idn('_c1')], rest: null, expression: true, span: e.span,
          body: { type: 'OpCall', op: 'js_m_concat', args: [idn('_c0'), idn('_c1')], span: e.span },
        }, 'concat');
        return op('js_arr_reduce', [box(this.argList(e.args), listType(D)), f, recv]);
      }
      /* 展开（`xs.slice(...ab)`）：op 是定长的，而展开的长度只有运行期才知道 ——
       * 整条实参表先求成一个 list，再按下标取头几格（越界给 undefined，与"缺席的实参
       * 补 js_undef"是同一件事）。argc 为 0 的成员用 emitPre，免得把那条表的求值丢掉。 */
      if (e.args.some((a) => a.type === 'Spread')) {
        const t = this.temp();
        const lst = assign(varRef(t), box(this.argList(e.args), listType(D)));
        if (argc === 0) {
          this.emitPre(exprStmt(lst), e.span);
          return op(`js_m_${name}`, [recv]);
        }
        const out = [recv];
        for (let i = 0; i < argc; i++) out.push(op('js_arr_at', [i === 0 ? lst : varRef(t), constReal(i)]));
        return op(`js_m_${name}`, out);
      }
      /* unshift 的多实参（`a.unshift(x, y)`）：op 是定长的（一次插一格），而语义是"整段
       * 插到头上"。先把接收者与实参**从左到右**求进临时量（求值次序是可观察的），再**倒着**
       * 一格格 unshift —— 最后插的是第一个实参，于是插进去的次序与规范一致，返回值也正是
       * 最后那一次交出来的新长度。
       * 不这么摊的话它会落到下面"实参比派发器多"那一支，被当成用户自己的同名方法：
       * 接收者是 list，`js_obj_get(list, "unshift")` 给 undefined，于是运行期一句
       * "not a function"（量出来的：自举的 C1 跑自己时就死在这儿）。 */
      if (name === 'unshift' && e.args.some((a) => a.type === 'Spread')) {
        this.err(e.span, "'unshift' with a spread argument is not supported; push the items one by one");
        return undefExpr();
      }
      if (name === 'unshift' && e.args.length > 1) {
        const rt = this.temp();
        this.emitPre(exprStmt(assign(varRef(rt), recv)), e.span);
        const ts = [];
        for (const a of e.args) {
          const t = this.temp();
          this.emitPre(exprStmt(assign(varRef(t), this.expr(a))), e.span);
          ts.push(t);
        }
        let out = undefExpr();
        for (let i = ts.length - 1; i >= 0; i--) {
          const call = op('js_arr_unshift', [varRef(rt), varRef(ts[i])]);
          if (i === 0) out = call;
          else this.emitPre(exprStmt(call), e.span);
        }
        return out;
      }
      if (e.args.length > argc) {
        // 不是 ABI 表里那个成员，而是用户自己的同名方法 —— 接收者照样要传（P1）。
        // recv 用两次，所以先落进临时量（理由同上面那处 js_call_this）。
        const t = this.temp();
        const f = op('js_obj_get', [assign(varRef(t), recv), this.propKey(name)]);
        return op('js_call_this', [f, varRef(t), box(this.argList(e.args), listType(D))]);
      }
      const args = [recv];
      for (let i = 0; i < argc; i++) args.push(i < e.args.length ? this.expr(e.args[i]) : undefExpr());
      return op(`js_m_${name}`, args);
    });
  }

  abiCall(spec, args, span, what) {
    // Promise 那几格用到了作业队列：main 末尾要补一次 js_jobs_run（见 module 那一处）
    if (spec.op.startsWith('js_promise_')) this.usesJobs = true;
    if (args.some((a) => a.type === 'Spread')) return this.abiSpreadCall(spec, args, span, what);
    /* `assoc`：op 是两个形参的两两归约，而这个名字在 JS 里收可变实参（Math.max / min /
       hypot）。摊成一串调用，个数不到两个时补上**单位元** —— 规范里空调用的答案正是它
       （max 是 -Infinity、min 是 +Infinity、hypot 是 0），而 `Math.max(x)` 就是
       `max(-Infinity, x)`，也就是 ToNumber(x)。正好两个实参时走下面的通用路：那一条与
       从前逐字相同，免得给现役的每个 Math.max(a, b) 都多套一层。 */
    if (spec.assoc === true && args.length !== spec.argc) {
      let out = constReal(spec.id);
      for (const a of args) out = op(spec.op, [out, this.expr(a)], spec.lit ?? {});
      return out;
    }
    /* `assocL`：与 assoc 一样是两两归约，但**从第一个实参起**、没有单位元
       （`Object.assign(t, a, b)` 就是 assign(assign(t, a), b) —— 目标是那第一格，
       所以不能从单位元开始）。一个实参时就是 op(a, undefined)，与从前一字不差。 */
    if (spec.assocL === true && args.length > spec.argc) {
      let out = this.expr(args[0]);
      for (let i = 1; i < args.length; i++) out = op(spec.op, [out, this.expr(args[i])], spec.lit ?? {});
      return out;
    }
    /* 一格实参都不给：`fold` 那一族是"逐个码元拼串"，空的归约就是空串（规范 22.1.2.1 /
       22.1.2.2 的 length 为 0 那一步）。落到底下"缺席补 undefined"那条的话，
       `$js_idx(undefined, 0)` 是 0 —— 印出来是一格 NUL，静静地多一个字符。 */
    if (spec.fold !== undefined && spec.argc === 1 && args.length === 0) return s16('');
    if (args.length > spec.argc) {
      /* `fold`：这个名字在 JS 里收可变实参，而 ABI 的 op 是定长的。**能不能摊开**取决于
         语义是不是可结合的两两归约 —— `String.fromCharCode(a, b, c)` 就是三次单实参调用
         用 `+` 接起来（规范 22.1.2.1 逐个码元拼串），所以这一格摊得开、而且逐字符相同。 */
      if (spec.fold !== undefined && spec.argc === 1) {
        let out = null;
        for (const a of args) {
          const one = op(spec.op, [this.expr(a)], spec.lit ?? {});
          out = out === null ? one : op(spec.fold, [out, one]);
        }
        return out;
      }
      /* `join`：可变实参**先各自 ToString 再用一个分隔符拼成一句**，然后只调一次 op。
         与 `fold` 的差别是"调几次"：`fromCharCode` 摊成多次调用再相加，而 `console.log`
         必须只印一行 —— 印两次就多一个换行。分隔符照 qjs（quickjs-libc.c 的 js_print）
         那样是一个空格。 */
      if (spec.join !== undefined && spec.argc === 1) {
        let s = null;
        for (const one of this.seq(args, (a) => op('js_disp', [this.expr(a)]))) {
          s = s === null ? one : op('js_add', [op('js_add', [s, s16(spec.join)]), one]);
        }
        return op(spec.op, [s === null ? s16('') : s], spec.lit ?? {});
      }
      this.err(span, `'${what}' takes at most ${spec.argc} argument(s), got ${args.length}`);
      return undefExpr();
    }
    const lowered = [];
    /* `pre`：op 的**头几个实参是定死的字符串**（不是 `lit` —— 那一格是发射器认的字面量，
       这里是普通的运行期实参）。`Math.imul` 就是这样接到 `js_i32_op` 上的。 */
    if (spec.pre !== undefined) for (const v of spec.pre) lowered.push(s16(v));
    const fixed = this.seq(args.slice(0, spec.argc), (a) => this.expr(a));
    for (let i = 0; i < spec.argc; i++) lowered.push(i < fixed.length ? fixed[i] : undefExpr());
    return op(spec.op, lowered, spec.lit ?? {});
  }

  /**
   * 封闭 ABI 调用里的展开（`Math.max(...xs)` / `console.log(...args)` / `Object.keys(...a)`）。
   *
   * op 是定长的，而展开的长度只有运行期才知道，所以先把整条实参表求成一个 list
   * （argList 那一份，展开走 js_iter），再按这个名字的形状接下去：
   *   - `assoc`（max / min / hypot）：运行期 reduce，初值是单位元
   *   - `fold`（fromCharCode）：同上，只是每个元素先各自过一遍 op 再用 `+` 接
   *   - `join`（console.log）：各自 ToString、用一个空格拼成一句，只调一次 op
   *   - 定长的（Object.keys / JSON.stringify …）：按下标取头几格，缺的自然是 undefined
   *     （js_arr_at 越界给 undefined —— 与"缺席的实参补 js_undef"是同一件事）
   * 归约那两支需要一格两参的闭包，就地合成一个（体是一句 OpCall，走的还是同一条 op）。
   */
  abiSpreadCall(spec, args, span, what) {
    const list = this.temp();
    const head = assign(varRef(list), box(this.argList(args), listType(D)));
    const sp = span;
    const idn = (n) => ({ type: 'Ident', name: n, span: sp });
    const arrow2 = (body) => this.closureExpr({
      type: 'Arrow', params: [idn('_r0'), idn('_r1')], rest: null, expression: true, body, span: sp,
    }, what.replace(/[^A-Za-z0-9]/g, '_'));
    if (spec.assoc === true) {
      const f = arrow2({ type: 'OpCall', op: spec.op, args: [idn('_r0'), idn('_r1')], lit: spec.lit ?? {}, span: sp });
      return op('js_arr_reduce', [head, f, constReal(spec.id)]);
    }
    if (spec.fold !== undefined && spec.argc === 1) {
      const one = { type: 'OpCall', op: spec.op, args: [idn('_r1')], lit: spec.lit ?? {}, span: sp };
      return op('js_arr_reduce', [head, arrow2({ type: 'OpCall', op: spec.fold, args: [idn('_r0'), one], span: sp }), s16('')]);
    }
    if (spec.join !== undefined && spec.argc === 1) {
      const str = this.closureExpr({
        type: 'Arrow', params: [idn('_r0')], rest: null, expression: true, span: sp,
        body: { type: 'OpCall', op: 'js_disp', args: [idn('_r0')], span: sp },
      }, 'js_disp');
      return op(spec.op, [op('js_arr_join', [op('js_arr_map', [head, str]), s16(spec.join)])], spec.lit ?? {});
    }
    const lowered = [];
    if (spec.pre !== undefined) for (const v of spec.pre) lowered.push(s16(v));
    for (let i = 0; i < spec.argc; i++) {
      lowered.push(op('js_arr_at', [i === 0 ? head : varRef(list), constReal(i)]));
    }
    if (spec.argc === 0) this.err(span, `'${what}' takes no arguments`);
    return op(spec.op, lowered, spec.lit ?? {});
  }

  /**
   * 外部 C 符号的调用（ADR-0014 决策 4）。和 abiCall 的两处不同都来自「另一端是 C」：
   * 实参个数必须**正好**对上原型（C 没有"缺席就是 undefined"这回事），
   * 而且要把用到的条目记在模块上 —— C 后端靠它发 extern 原型、链接命令靠它加 -l。
   */
  cCall(entry, args, span, what) {
    const sig = C_ABI[entry];
    if (args.some((a) => a.type === 'Spread')) {
      this.err(span, `spread is not supported in a C call ('${what}')`);
      return undefExpr();
    }
    if (args.length !== sig.params.length) {
      this.err(span, `'${what}' takes exactly ${sig.params.length} argument(s), got ${args.length}`);
      return undefExpr();
    }
    if (!this.cused.includes(entry)) this.cused.push(entry);
    return { kind: 'CCall', entry, args: args.map((a) => this.expr(a)), type: D };
  }

  dynCall(f, args) {
    return {
      kind: 'CallFn',
      callee: { kind: 'Builtin', name: 'js_asFn', args: [f], type: JS_FN },
      fnType: JS_FN,
      args: [this.argList(args)],
      type: D,
    };
  }

  /** 正则字面量（或初始化式是正则字面量的模块级 const），ADR-0011 决策 10 */
  regexOf(node) {
    if (node.type === 'Regex') return { body: node.body, flags: node.flags };
    if (node.type === 'Ident' && !this.lookup(node.name)) return this.regexConsts.get(node.name) ?? null;
    return null;
  }

  /** re.test(s) / s.replace(re, x) / s.match(re) / s.split(re, n) */
  regexCall(c, e) {
    if (c.computed) return null;
    const arg = (i) => (i < e.args.length ? this.expr(e.args[i]) : undefExpr());
    if (c.name === 'test') {
      const re = this.regexOf(c.object);
      if (!re) return null;
      return op('js_re_test', [s16(re.body), s16(re.flags), arg(0)]);
    }
    if (!['replace', 'replaceAll', 'match', 'matchAll', 'search', 'split'].includes(c.name)) return null;
    const re = e.args.length ? this.regexOf(e.args[0]) : null;
    if (!re) {
      // 串模式那几支各有自己的成员 op（js_m_replace / js_m_replaceAll / js_m_split）
      if (c.name === 'split' || c.name === 'replace' || c.name === 'replaceAll') return null;
      /* match / matchAll / search 的实参不是字面量正则（`const re = /…/g` 带了 g、或者
       * `new RegExp(s)` 存进了变量）：把它**在运行期**摊成 (源, 旗标) 再交给同一格 op ——
       * 与 $js_str_replace 那一族早就在用的办法一字不差（见 prelude 的 $js_re_source）。
       * 从前这儿是编译期硬报错。差的一格写在明处：matchAll 照规范该从实参的 lastIndex
       * 起走，这儿总是从 0 起（那三个方法里只有它看 lastIndex）。 */
      const t = this.temp();
      this.emitPre(exprStmt(assign(varRef(t), this.expr(e.args[0]))), e.span);
      const name0 = { match: 'js_re_match', matchAll: 'js_re_match_all', search: 'js_re_search' }[c.name];
      /* matchAll 收**非正则**时规范给它补上 g（22.1.3.14 第 3 步 c：RegExpCreate(R, "g")），
       * 所以 "aXbX".matchAll("X") 是两处而不是 "matchAll needs the g flag"。真正则照旧读它
       * 自己的旗标 —— 不带 g 的真正则该报错，这一格不能顺手替它补上。 */
      const fl = c.name === 'matchAll' ? 'js_re_flags_g' : 'js_re_flags';
      return op(name0, [
        op('js_re_source', [varRef(t)]),
        op(fl, [varRef(t)]),
        this.expr(c.object),
      ]);
    }
    /* replaceAll 收正则时规范要求带 g（不带是 TypeError）—— 这儿是编译期报错。
       带 g 的话它与 replace 完全同义，所以接到同一格 op 上。 */
    if (c.name === 'replaceAll' && !re.flags.includes('g')) {
      this.err(e.span, "'replaceAll' with a regex needs the g flag");
      return undefExpr();
    }
    const recv = this.expr(c.object);
    const name = {
      replace: 'js_re_replace', replaceAll: 'js_re_replace',
      match: 'js_re_match', matchAll: 'js_re_match_all', search: 'js_re_search', split: 'js_re_split',
    }[c.name];
    if (c.name === 'match' || c.name === 'matchAll' || c.name === 'search') {
      return op(name, [s16(re.body), s16(re.flags), recv]);
    }
    return op(name, [s16(re.body), s16(re.flags), recv, arg(1)]);
  }

  newExpr(e) {
    const n0 = e.callee.type === 'Ident' ? e.callee.name : null;
    /* WeakMap / WeakSet 就是 Map / Set（ADR-0020 P4）。差别只在"键不阻止回收"，而这个
     * 值域里没有 GC 可观测的面（arena 一次性释放），所以两者在**能写出来的程序**里
     * 不可区分。刻意不做的两件事写在明处：不检查键必须是对象、`size`/迭代照 Map 有。 */
    const n = n0 === 'WeakMap' ? 'Map' : (n0 === 'WeakSet' ? 'Set' : n0);
    if ((n === 'Map' || n === 'Set') && !this.lookup(n0) && !this.classes.has(n0)) {
      if (e.args.length > 1) {
        this.err(e.span, `new ${n}(...) takes at most 1 argument`);
        return undefExpr();
      }
      // 有初值就走 of_pairs / of_list（初值只收 list，见 ABI 表）
      if (e.args.length) {
        if (e.args[0].type === 'Spread') {
          this.err(e.args[0].span, `spread is not supported in a 'new ${n}' call`);
          return undefExpr();
        }
        return op(n === 'Map' ? 'js_map_of_pairs' : 'js_set_of_list', [this.expr(e.args[0])]);
      }
      return op(n === 'Map' ? 'js_map_new' : 'js_set_new', []);
    }
    // new Array(...)：一个数的实参是"长度 n、每格 undefined"，别的实参个数就是那几格
    // 元素（与 JS 一样；new Array("x") 是 ["x"]，那一格由 js_arr_new_n 自己分辨）
    if (n === 'Array' && !this.lookup(n) && !this.classes.has(n)) {
      const sp = e.args.find((a) => a.type === 'Spread');
      if (sp !== undefined) {
        this.err(sp.span, "spread is not supported in a 'new Array' call");
        return undefExpr();
      }
      if (e.args.length === 0) return op('js_arr_new', []);
      if (e.args.length === 1) return op('js_arr_new_n', [this.expr(e.args[0])]);
      return arrLit(e.args.map((a) => this.expr(a)));
    }
    // 字节缓冲那一族（ADR-0011）：ArrayBuffer 与它上面的 Uint8Array / DataView 在这个
    // 值域里是**同一种值**（一个视图），三者共享同一块内存 —— interp/builtin.js 模拟
    // 指针内存靠的就是这个别名关系。TextEncoder 无状态，但 .encode 是第二步，所以也得有值。
    if ((n === 'ArrayBuffer' || n === 'Uint8Array' || n === 'DataView' || n === 'TextEncoder')
      && !this.lookup(n) && !this.classes.has(n)) {
      const sp = e.args.find((a) => a.type === 'Spread');
      if (sp !== undefined) {
        this.err(sp.span, `spread is not supported in a 'new ${n}' call`);
        return undefExpr();
      }
      const as = e.args.map((a) => this.expr(a));
      if (n === 'TextEncoder') {
        if (as.length !== 0) this.err(e.span, 'new TextEncoder() takes no arguments');
        return op('js_text_enc_new', []);
      }
      if (n === 'ArrayBuffer') {
        if (as.length !== 1) {
          this.err(e.span, 'new ArrayBuffer(n) takes exactly one argument');
          return undefExpr();
        }
        return op('js_buf_new', [as[0]]);
      }
      if (as.length < 1 || as.length > 3) {
        this.err(e.span, `new ${n}(buf[, offset[, length]]) takes one to three arguments`);
        return undefExpr();
      }
      /* new Uint8Array([…])：实参是一格数组就按元素填字节（ToUint8）。数组与字节缓冲在
       * 这个值域里是两种值，而"是哪一种"只有运行期知道，所以在这儿按标签挑 op ——
       * 填字节那一格（js_buf_of_list）住在能走 list 的宏段里，见 js_abi.js 的说明。
       * DataView 不收数组（规范里那是 TypeError），所以只给 Uint8Array 这一支。 */
      if (n === 'Uint8Array' && as.length === 1) {
        const t = this.temp();
        this.emitPre(exprStmt(assign(varRef(t), as[0])), e.span);
        return ternary(boolOp('js_arr_is_array', [varRef(t)]),
          op('js_buf_of_list', [varRef(t)]),
          op('js_buf_view', [varRef(t), undefExpr(), undefExpr()]));
      }
      return op('js_buf_view', [as[0], as[1] ?? undefExpr(), as[2] ?? undefExpr()]);
    }
    /* new Date(...)（ADR-0020 P4）：一格真对象，毫秒在隐藏槽里，取值面挂在 realm 的
     * dateP 上（见 prelude）。三种形状：不给实参（当下）、一个实参（毫秒数**或串** ——
     * 串走 Date.parse，运行期看标签决定）、以及 (y, mo[, d, h, mi, s, ms]) 那一族
     * （本地时区，缺的格子补 1/0）。展开还是当场报：定长的 op 表达不了。 */
    if (n === 'Date' && !this.lookup(n) && !this.classes.has(n)) {
      const sp = e.args.find((a) => a.type === 'Spread');
      if (sp !== undefined) {
        this.err(sp.span, "spread is not supported in a 'new Date' call");
        return undefExpr();
      }
      if (e.args.length === 0) return op('js_date_new', [op('js_now_ms', [])]);
      if (e.args.length === 1) return op('js_date_new', [this.expr(e.args[0])]);
      const as = this.seq(e.args, (a) => this.expr(a));
      const at = (i) => as[i] ?? undefExpr();
      return op('js_date_new', [op('js_date_parts', [at(0), at(1), at(2), at(3), at(4), at(5), at(6)])]);
    }
    /* new RegExp(src[, flags])（ADR-0011 决策 10）：模式与旗标是**运行期的串** ——
     * 字面量那条路在 expr() 里，这一支是"现搭一格正则对象"。第二个实参缺席就是无旗标。 */
    if (n === 'RegExp' && !this.lookup(n) && !this.classes.has(n)) {
      const sp = e.args.find((a) => a.type === 'Spread');
      if (sp !== undefined) {
        this.err(sp.span, "spread is not supported in a 'new RegExp' call");
        return undefExpr();
      }
      if (e.args.length > 2) {
        this.err(e.span, "'new RegExp(src[, flags])' takes at most two arguments");
        return undefExpr();
      }
      /* 实参不在这里 ToString：new RegExp(re) 要**照抄** re 的源与旗标（不是把它印成
       * "/a/g" 再当模式），undefined 模式是空模式而不是 "undefined"，这两条都得让
       * 运行期那一格看见原样的实参才分得清。 */
      return op('js_re_new', [
        e.args.length > 0 ? this.expr(e.args[0]) : undefExpr(),
        e.args.length > 1 ? this.expr(e.args[1]) : undefExpr(),
      ]);
    }
    /* new Promise(executor)（ADR-0020 P2）：状态与回调表在隐藏槽里，then / catch /
     * finally 住在 realm 的 promP 上。executor 立刻同步跑，它抛出来的东西当 reject。 */
    if (n === 'Promise' && !this.lookup(n) && !this.classes.has(n)) {
      if (e.args.length !== 1 || e.args[0].type === 'Spread') {
        this.err(e.span, "'new Promise' takes exactly one argument (the executor)");
        return undefExpr();
      }
      this.usesJobs = true;
      return op('js_promise_new', [this.expr(e.args[0])]);
    }
    /* new Proxy(target, handler)（ADR-0020 P4）：代理与普通对象是同一种值，
     * 差别只在属性访问的五个入口上多问一句陷阱（见 prelude 的 $js_px_trap）。 */
    if (n === 'Proxy' && !this.lookup(n) && !this.classes.has(n)) {
      if (e.args.length !== 2 || e.args.some((a) => a.type === 'Spread')) {
        this.err(e.span, "'new Proxy' takes exactly two arguments (target, handler)");
        return undefExpr();
      }
      return op('js_proxy_new', [this.expr(e.args[0]), this.expr(e.args[1])]);
    }
    // new Error(msg, opts) 与它那一家（决策 15 + ADR-0020 P4）：异常对象就是
    // { $cls: [类名…, "Error"], name, message }，opts 只看 cause 那一格。
    // AggregateError 的实参顺序不一样（errors 在前），errors 那一格另外挂。
    if (ERROR_CTORS.has(n) && !this.lookup(n) && !this.classes.has(n)) {
      const chain = n === 'Error' ? arrLit([s16('Error')]) : arrLit([s16(n), s16('Error')]);
      /* 展开（`new Error(...xs)`）：整条实参表先落进一格临时量，再按下标取 —— 与
       * 封闭 ABI 那条路同一个办法（abiSpreadCall）。 */
      if (e.args.some((a) => a.type === 'Spread')) {
        const lst = this.temp();
        this.emitPre(exprStmt(assign(varRef(lst), box(this.argList(e.args), listType(D)))), e.span);
        const at = (i) => op('js_arr_at', [varRef(lst), constReal(i)]);
        if (n !== 'AggregateError') return op('js_err_new', [at(0), chain, at(1)]);
        const t0 = this.temp();
        this.emitPre(exprStmt(assign(varRef(t0), op('js_err_new', [at(1), chain, at(2)]))), e.span);
        this.emitPre(exprStmt(op('js_obj_set', [varRef(t0), s16('errors'), at(0)])), e.span);
        return varRef(t0);
      }
      if (n !== 'AggregateError') {
        const msg = e.args.length ? this.expr(e.args[0]) : s16('');
        const opts = e.args.length > 1 ? this.expr(e.args[1]) : undefExpr();
        return op('js_err_new', [msg, chain, opts]);
      }
      // errors 先落一格临时量：实参在 JS 里是从左往右求值的
      const errs = this.temp();
      this.emitPre(exprStmt(assign(varRef(errs),
        e.args.length ? this.expr(e.args[0]) : op('js_arr_new', []))), e.span);
      const msg = e.args.length > 1 ? this.expr(e.args[1]) : s16('');
      const opts = e.args.length > 2 ? this.expr(e.args[2]) : undefExpr();
      const t = this.temp();
      this.emitPre(exprStmt(assign(varRef(t), op('js_err_new', [msg, chain, opts]))), e.span);
      this.emitPre(exprStmt(op('js_obj_set', [varRef(t), s16('errors'), varRef(errs)])), e.span);
      return varRef(t);
    }
    // 类的构造：Error 子类走老路（造实例的函数），别的走原型链那条新路（P1-f）
    if (n && this.classes.has(n) && !this.lookup(n)) {
      const rec = this.classes.get(n);
      if (rec.isError) {
        return { kind: 'Call', func: rec.mangled, name: n, args: [this.argList(e.args)], type: D };
      }
      /* 分配一格以类原型为原型的对象，再拿它当**接收者**跑 $init。摊成两句（emitPre）
       * 而不是一个表达式：临时量要用三次（造、当接收者、当结果）。
       * 构造器 `return {…}` 时值是**返回的那一格**（规范 10.2.2 第 13 步）；返回别的
       * （数、undefined）还是实例 —— 从前 $init 的返回值整个被丢掉，`new F()` 于是
       * 悄悄给出空实例（量出来的：class F { constructor() { return {custom:1}; } }）。 */
      const t = this.temp();
      this.emitPre(exprStmt(assign(varRef(t),
        op('js_obj_new_p', [globalRef(this.globals.get(protoGlobalName(n)).name)]))), e.span);
      const r = this.temp();
      /* new.target 是**被 new 的那一格类对象**（规范 10.2.2）。类的构造走 $init 那格闭包，
       * 不经过 js_fn_construct，所以要在这儿把类对象放进槽里 —— 不放的话类构造器里的
       * new.target 是 undefined（`new.target === C` 静静地为假）。 */
      this.emitPre(exprStmt(op('js_nt_put', [globalRef(this.globals.get(n).name)])), e.span);
      this.emitPre(exprStmt(assign(varRef(r), op('js_call_this', [
        op('js_obj_get', [globalRef(this.globals.get(n).name), classInitKey()]),
        varRef(t),
        box(this.argList(e.args), listType(D)),
      ]))), e.span);
      return ternary(boolOp('js_is_obj', [varRef(r)]), varRef(r), varRef(t));
    }
    /* 兜底：**普通函数当构造器**（ADR-0020）。`new f(a)` = 造一格以 f.prototype 为原型的
     * 对象、拿它当接收者跑 f、f 返回对象就用那一格。f.prototype 住在运行期的一张 side
     * table 上（函数还不是真对象），见 prelude 的 $js_fn_proto。 */
    if (n === 'Function' && !this.lookup('Function') && !this.globals.has('Function')) {
      return this.fnFromSrc(e);
    }
    return op('js_fn_construct', [this.expr(e.callee), box(this.argList(e.args), listType(D))]);
  }

  /* `new Function(a, b, "body")` 与 `Function(…)`（ADR-0020 P6）：形参名与体都是**运行期
   * 的字符串**，所以拼源码那一步也在运行期（prelude 的 $js_src_fn），和 eval 走同一格钩子。 */
  fnFromSrc(e) {
    const spread = e.args.find((a) => a.type === 'Spread');
    if (spread !== undefined) {
      this.err(spread.span, 'spread is not supported in a Function(...) call');
      return undefExpr();
    }
    const ps = e.args.slice(0, -1).map((a) => this.expr(a));
    const body = e.args.length ? this.expr(e.args[e.args.length - 1]) : s16('');
    return op('js_src_fn', [arrLit(ps), body]);
  }

  /* -------------------------------------------------------- 赋值与自增 */

  applyOp(o, a, b, span) {
    switch (o) {
      case '+': return op('js_add', [a, b]);
      case '-': case '*': case '/': case '%': return op('js_arith', [a, b], { op: o });
      // `**=`：幂在 js_arith 里的选择子是 'p'（ADR-0020 P3 —— 二元的 `**` 早就有，
      // 缺的只是复合赋值这一格）。
      case '**': return op('js_arith', [a, b], { op: 'p' });
      case '&': case '|': case '^': return op('js_bitop', [a, b], { op: o });
      case '<<': return op('js_bitop', [a, b], { op: '<' });
      case '>>': return op('js_bitop', [a, b], { op: '>' });
      case '>>>': return ushr(a, b);
      default:
        this.err(span, `compound assignment '${o}=' is not supported`);
        return a;
    }
  }

  /**
   * 可赋值位置。成员目标会把接收者（和计算键）先存进临时量 —— 复合赋值要读一次写
   * 一次，不能把接收者算两遍。所以这条路用了 sink，在惰性位置上会报错。
   */
  lvalue(node, span) {
    if (node.type === 'Ident') {
      const ent = this.lookup(node.name);
      if (ent) return { get: () => this.readEntry(ent), set: (v) => this.writeEntry(ent, v) };
      if (this.globals.has(node.name)) {
        const g = this.globals.get(node.name).name;
        return { get: () => globalRef(g), set: (v) => assign(globalRef(g), v) };
      }
      this.err(span, `cannot assign to '${node.name}'`);
      return null;
    }
    if (node.type === 'Member') {
      const path = this.staticPath(node);
      if (path) {
        const spec = STATIC_SETS[path];
        if (!spec) { this.err(span, `cannot assign to '${path}'`); return null; }
        return { get: () => undefExpr(), set: (v) => op(spec.op, [v]) };
      }
      const t = this.temp();
      this.emitPre(exprStmt(assign(varRef(t), this.expr(node.object))), span);
      let key = () => this.propKey(node.name);
      if (node.computed) {
        const k = this.temp();
        this.emitPre(exprStmt(assign(varRef(k), this.expr(node.prop))), span);
        key = () => varRef(k);
      }
      return {
        get: () => op('js_idx_get', [varRef(t), key()]),
        set: (v) => op('js_idx_set', [varRef(t), key(), v]),
      };
    }
    this.err(span, `cannot assign to '${node.type}'`);
    return null;
  }

  /**
   * 没有声明的解构赋值：`[a, b] = xs` / `({x, y} = o)`（ADR-0020 P3）。
   *
   * 与 bindPattern 的差别只有一处：那边**声明**新名字，这边往**已经存在的可赋值位置**写 ——
   * 所以每个叶子都过 lvalue，于是成员目标（`[o.a, o.b] = xs`）也能写。
   * 摊成一串 emitPre 语句加一个值：赋值表达式的值是右边那个东西。
   *
   * 一处已知偏差：数组模式那一格的值是 js_iter 的结果 —— 数组身上它是恒等（与规范一致），
   * 字符串或自定义可迭代对象上是那份摊开的数组，而规范说是原值。
   */
  destructAssign(pat, e) {
    return this.destructInto(pat, this.expr(e.value), e.span);
  }

  /** 解构赋值的一层：把 srcExpr 落进临时量，再按模式往各个可赋值位置写。交出那格临时量。 */
  destructInto(pat, srcExpr, span) {
    const tv = this.temp();
    // 数组模式走迭代器协议（与 bindPattern 同一副形状：一格走一步，取完补一次 close）
    const src = pat.type === 'ArrayPattern' ? op('js_iter_open', [srcExpr]) : srcExpr;
    this.emitPre(exprStmt(assign(varRef(tv), src)), span);
    const put = (leaf, value) => {
      /* 默认值（`[a = 1] = xs`、`({x = 2} = o)`）：只有 undefined 才用默认（规范如此）。
       * 先把取到的值落进临时量，再按它决定写哪一个 —— 默认表达式于是只在需要时才算。 */
      if (leaf.type === 'AssignPattern') {
        const t = this.temp();
        this.emitPre(exprStmt(assign(varRef(t), value)), span);
        const [pre, dv] = this.captureSink(() => this.expr(leaf.right));
        this.emitPre({
          kind: 'If',
          cond: boolOp('js_eq', [varRef(t), undefExpr()], { strict: true }),
          then: block([...pre, exprStmt(assign(varRef(t), dv))]),
          otherwise: null,
        }, span);
        put(leaf.left, varRef(t));
        return;
      }
      // 嵌套模式（`[[a], {b}] = xs`）：这一格的值当新的源，再来一层
      if (leaf.type === 'ArrayPattern' || leaf.type === 'ObjectPattern') {
        this.destructInto(leaf, value, span);
        return;
      }
      if (leaf.type !== 'Ident' && leaf.type !== 'Member') {
        this.err(span, `cannot assign to '${leaf.type}' in a destructuring assignment`);
        return;
      }
      const lv = this.lvalue(leaf, span);
      if (lv) this.emitPre(exprStmt(lv.set(value)), span);
    };
    if (pat.type === 'ArrayPattern') {
      const at = (i) => ternary(boolOp('js_iter_done', [varRef(tv), constReal(i)]),
        undefExpr(), op('js_iter_cur', [varRef(tv), constReal(i)]));
      pat.elements.forEach((el, i) => {
        // 空位也要走一格，只是不写
        if (el) put(el, at(i));
        else this.emitPre(exprStmt(at(i)), span);
      });
      if (pat.rest) {
        put(pat.rest, op('js_iter_rest', [varRef(tv), constReal(pat.elements.length)]));
      } else {
        this.emitPre(exprStmt(op('js_iter_close', [varRef(tv)])), span);
      }
      return varRef(tv);
    }
    /** 计算键：键先落进临时量（要用两次 —— 取值、rest 里删掉），也保住求值次序 */
    const keyOf = (p) => {
      if (!p.computed) return s16(this.keyName(p.key, span));
      const kt = this.temp();
      this.emitPre(exprStmt(assign(varRef(kt), this.expr(p.key))), span);
      return varRef(kt);
    };
    const keys = pat.props.map((p) => keyOf(p));
    pat.props.forEach((p, i) => put(p.value, op('js_obj_get', [varRef(tv), keys[i]])));
    if (pat.rest) {
      // 剩下的那一份：整份抄一遍再把取过的键删掉（与 bindPattern 那边同一条路）
      const rv = this.temp();
      this.emitPre(exprStmt(assign(varRef(rv),
        op('js_obj_assign', [op('js_obj_new', []), varRef(tv)]))), span);
      for (const k of keys) {
        this.emitPre(exprStmt(op('js_obj_delete', [varRef(rv), k])), span);
      }
      put(pat.rest, varRef(rv));
    }
    return varRef(tv);
  }

  assignExpr(e) {
    const t = e.target;
    if (e.op === '=') {
      if (t.type === 'ArrayPattern' || t.type === 'ObjectPattern') return this.destructAssign(t, e);
      // 简单赋值不需要临时量：接收者只算一次
      if (t.type === 'Member') {
        /* `super.x = v`（ADR-0020 P1-f）：从**父类原型**上找那一格，但访问器的 this 与
         * 数据格的落点都是**当前的接收者** —— 就是 js_setp 的第四格。 */
        if (!t.computed && t.object.type === 'Ident' && t.object.name === 'super' && !this.lookup('super')) {
          const sp = this.superProtoRef(e.span);
          if (sp === null) return undefExpr();
          return op('js_setp', [sp, this.propKey(t.name), this.expr(e.value), this.superRecv()]);
        }
        const path = this.staticPath(t);
        if (path) {
          const spec = STATIC_SETS[path];
          if (!spec) { this.err(e.span, `cannot assign to '${path}'`); return undefExpr(); }
          return op(spec.op, [this.expr(e.value)]);
        }
        const key = t.computed ? this.expr(t.prop) : this.propKey(t.name);
        return op('js_idx_set', [this.expr(t.object), key, this.expr(e.value)]);
      }
      const lv = this.lvalue(t, e.span);
      if (!lv) return undefExpr();
      /* `later = () => {}` 的 name 也来自赋值目标（与 `const g = …` 同一条规范） */
      const anon = e.value
        && (e.value.type === 'Arrow' || (e.value.type === 'FuncExpr' && !e.value.id));
      if (anon && t.type === 'Ident') {
        return lv.set(this.closureExpr(e.value, t.name, { fnName: t.name }));
      }
      return lv.set(this.expr(e.value));
    }
    const lv = this.lvalue(t, e.span);
    if (!lv) return undefExpr();
    if (e.op === '&&=' || e.op === '||=' || e.op === '??=') {
      /* 三格逻辑赋值（规范 13.15.2）：目标**只读一次** —— 先取值、按它决定要不要写。
       * 从前条件里与"保持原值"那一支各读一次，于是取值器被叫了两遍
       * （`q.v ??= f()` 里 `get v()` 跑两趟，量出来的静默分叉）。
       * 惰性位置（`c ? (a ||= 1) : 0`）开不了语句，那儿只能退回读两次的老形状 ——
       * 成员目标在那种位置本来就当场报（接收者要临时量），所以退回的只有名字目标那一格。 */
      let cur = () => lv.get();
      if (this.fn.lazies === 0) {
        const tv = this.temp();
        this.emitPre(exprStmt(assign(varRef(tv), lv.get())), e.span);
        cur = () => varRef(tv);
      }
      const set = () => this.lazy(() => lv.set(this.expr(e.value)));
      if (e.op === '&&=') return ternary(truthy(cur()), set(), cur());
      if (e.op === '||=') return ternary(truthy(cur()), cur(), set());
      return ternary(boolOp('js_eq', [cur(), nullExpr()], { strict: false }), set(), cur());
    }
    return lv.set(this.applyOp(e.op.slice(0, -1), lv.get(), this.expr(e.value), e.span));
  }

  /** ++ / --：只对 number 有意义（js_arith 不许 bigint 与 number 混用） */
  update(e, discard) {
    // '+' 不在 js_arith 里（字符串拼接与加法是同一个 op），所以自增走 js_add
    const bump = (x) => (e.op === '++'
      ? op('js_add', [x, constReal(1)])
      : op('js_arith', [x, constReal(1)], { op: '-' }));
    /* 惰性位置（三元的分支、`&&` 的右边）里开不了语句 —— 那儿 emitPre 会报
     * "hoist it into a statement"，而 lvalue 对**成员目标**头一件事就是 emitPre 存接收者。
     * 所以这一支要抢在 lvalue 之前：把"存接收者"与"存计算键"也折进表达式，靠
     * "三元的条件一定先算、两条分支又一样"来定顺序。于是 get 与 set 里读到的是同一格临时量，
     * C 那边实参求值次序未指定也不再要紧（从前正因为这一点整族拒了）。
     * 量出来的是最常见的手写迭代器：
     *   next() { return this.i < 3 ? { value: this.i++, done: false } : { done: true }; }
     * 从前报 "hoist it into a statement"，而它是再普通不过的 JS。 */
    if (this.fn.lazies > 0 && e.arg.type === 'Member' && !this.staticPath(e.arg)) {
      const seq = (first, then) => ternary(truthy(first), then, then);
      const rT = this.temp();
      const kT = e.arg.computed ? this.temp() : null;
      const key = () => (kT === null ? this.propKey(e.arg.name) : varRef(kT));
      const body = () => {
        const got = () => op('js_idx_get', [varRef(rT), key()]);
        // 前缀（与"值不要"的那一档）：值就是写回去的新值，js_idx_set 正好交出它
        if (discard || e.prefix) return op('js_idx_set', [varRef(rT), key(), bump(got())]);
        // 后缀的值是旧的：先存进 t0 再写回，最后读 t0
        const t0 = this.temp();
        const wrote = op('js_idx_set', [varRef(rT), key(), bump(assign(varRef(t0), got()))]);
        return ternary(truthy(wrote), varRef(t0), varRef(t0));
      };
      const inner = kT === null
        ? body()
        : seq(assign(varRef(kT), this.expr(e.arg.prop)), body());
      return seq(assign(varRef(rT), this.expr(e.arg.object)), inner);
    }
    const lv = this.lvalue(e.arg, e.span);
    if (!lv) return undefExpr();
    if (discard || e.prefix) return lv.set(bump(lv.get()));
    /* 后缀的值是**旧的**，所以先存一份再写回。平时摊成两句（干净、也不挑目标形状）。
     * 名字这一支在惰性位置里也不必摊：把两次写折进一个表达式
     *   (t = i) 先存旧值 -> i = t + 1 写回 -> 值是 t
     * 三元的两条分支都是"读同一格临时量"，所以复制的只是一个变量引用，没有重复求值。 */
    if (this.fn.lazies > 0 && e.arg.type === 'Ident') {
      const t0 = this.temp();
      const wrote = lv.set(bump(assign(varRef(t0), lv.get())));
      return ternary(truthy(wrote), varRef(t0), varRef(t0));
    }
    const t = this.temp();
    this.emitPre(exprStmt(assign(varRef(t), lv.get())), e.span);
    this.emitPre(exprStmt(lv.set(bump(varRef(t)))), e.span);
    return varRef(t);
  }
}

/* ------------------------------------------- 静态解析的宿主名字（ADR-0011 决策 2）
 * 这些名字不是值，只是"点出来的调用"：JSON.stringify、Math.floor、process.argv…
 * 表里没有的路径一律报错 —— 封闭 ABI 的意思就是"没写进表的东西降不下去"。
 * console.log 只是给测试用的糖（量过：编译器源码里 0 处 console.*）。
 */
const STATIC_NS = new Set(['JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'BigInt', 'process', 'console',
  // ADR-0020 P1：Symbol 与 Reflect 的静态面（Symbol.iterator、Reflect.ownKeys …）
  'Symbol', 'Reflect',
  // ADR-0020 P4：Date.now()
  'Date',
  // ADR-0020 P2：Promise.resolve / reject / all / allSettled / any / race / try
  'Promise',
  // ES2024 的 Map.groupBy（`new Map(...)` 那条路不经过这儿，见 newExpr）
  'Map',
  /* 只为**内建原型当值用**那一条（STATIC_PROPS 里的 X.prototype）进来的几个：
     `RegExp.prototype.toString.call(re)`、`Boolean.prototype` 这类借方法的写法要它。
     当函数用（`[1,0].map(Boolean)`）走的是上面 GLOBAL_CALLS 那一格，比这里早。 */
  'RegExp', 'Boolean', 'Function', 'Set']);

/* `new X(...)` 认的内建构造器（newExpr 里一支支写着）。这张表只给 `typeof X` 用 ——
 * 它们在 JS 里都是函数值，而这个值域里还不能把它们当值传，所以答案是编译期定死的。 */
const CTOR_NAMES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'ArrayBuffer',
  'Uint8Array', 'DataView', 'TextEncoder', 'RegExp', 'Promise', 'Proxy', 'Date']);

const STATIC_CALLS = {
  /* `len` 那一列：这个名字**当值用**时的 `fn.length`（照规范/qjs 量的），标了才允许
     `const f = Object.keys` 这种写法（见 builtinFnValue）。它和 `argc` 不是一回事 ——
     argc 是 op 的形参个数。收可变实参的那几格（fold / join）不标：包装摊不开。 */
  'JSON.stringify': { op: 'js_json_stringify', argc: 3, len: 3 },
  // parse 的第二个实参是 reviver（ADR-0020 P4）：自底向上走一遍，undefined 删格
  'JSON.parse': { op: 'js_json_parse', argc: 2, len: 2 },
  'Math.abs': { op: 'js_math', argc: 2, lit: { op: 'a' }, len: 1 },
  'Math.trunc': { op: 'js_math', argc: 2, lit: { op: 't' }, len: 1 },
  'Math.floor': { op: 'js_math', argc: 2, lit: { op: 'f' }, len: 1 },
  'Math.ceil': { op: 'js_math', argc: 2, lit: { op: 'c' }, len: 1 },
  'Math.max': { op: 'js_math', argc: 2, lit: { op: 'M' }, len: 2, assoc: true, id: -Infinity },
  'Math.min': { op: 'js_math', argc: 2, lit: { op: 'm' }, len: 2, assoc: true, id: Infinity },
  // fround（ADR-0017 第一刀）：MIR 的 f32 语义就是"按 double 算完再舍一次到单精度"，
  // 而闭包解释器要在**我们自己编出来的**编译器里也这么算 —— 所以它必须进封闭 ABI。
  'Math.fround': { op: 'js_math', argc: 2, lit: { op: 'F' } },
  /* 超越函数那一族（ADR-0020 P4）：选择子早就在 js_math 里（核心方言的 (rmath …) 用着），
     缺的只是这张表里的名字。**Math.round 不在这儿** —— js_math 的 'r' 是 C 的 round
     （离零舍入），而 Math.round 是"半数往上"，两者在 -0.5 上就分叉。 */
  'Math.sqrt': { op: 'js_math', argc: 2, lit: { op: 's' }, len: 1 },
  /* Math.round 是"半数往 +∞"（-2.5 -> -2），而 js_math 的 'r' 是 C 的 round（离零）——
     两者在 -0.5 上就分叉，所以它有自己的选择子 'R'（见 prelude 那段量口）。 */
  'Math.round': { op: 'js_math', argc: 2, lit: { op: 'R' }, len: 1 },
  // clz32：先 ToUint32 再数前导零。JS 的 Math.clz32 与 C 那份都走这一格（不是 __builtin_clz，
  // 那个在 0 上是未定义的）
  'Math.clz32': { op: 'js_math', argc: 2, lit: { op: 'Z' } },
  // len 有了才能"当值用"（这几个的 length 照规范）。可变实参那一档由 builtinFnValue
  // 包成 (...xs) => f(...xs)，所以定死的形参个数不会再把多出来的实参吃掉。
  'Math.hypot': { op: 'js_math', argc: 2, lit: { op: 'Y' }, len: 2, assoc: true, id: 0 },
  'Math.exp': { op: 'js_math', argc: 2, lit: { op: 'E' } },
  'Math.expm1': { op: 'js_math', argc: 2, lit: { op: 'X' } },
  'Math.log': { op: 'js_math', argc: 2, lit: { op: 'O' } },
  'Math.log10': { op: 'js_math', argc: 2, lit: { op: 'Q' } },
  'Math.log2': { op: 'js_math', argc: 2, lit: { op: 'w' }, len: 1 },
  'Math.log1p': { op: 'js_math', argc: 2, lit: { op: 'P' } },
  'Math.sign': { op: 'js_math', argc: 2, lit: { op: 'g' }, len: 1 },
  'Math.cbrt': { op: 'js_math', argc: 2, lit: { op: 'B' } },
  'Math.sin': { op: 'js_math', argc: 2, lit: { op: 'S' } },
  'Math.cos': { op: 'js_math', argc: 2, lit: { op: 'C' } },
  'Math.tan': { op: 'js_math', argc: 2, lit: { op: 'T' } },
  'Math.asin': { op: 'js_math', argc: 2, lit: { op: 'I' } },
  'Math.acos': { op: 'js_math', argc: 2, lit: { op: 'A' } },
  'Math.atan': { op: 'js_math', argc: 2, lit: { op: 'N' } },
  'Math.atan2': { op: 'js_math', argc: 2, lit: { op: '2' } },
  'Math.sinh': { op: 'js_math', argc: 2, lit: { op: 'H' } },
  'Math.cosh': { op: 'js_math', argc: 2, lit: { op: 'D' } },
  'Math.tanh': { op: 'js_math', argc: 2, lit: { op: 'G' } },
  'Math.asinh': { op: 'js_math', argc: 2, lit: { op: 'J' } },
  'Math.acosh': { op: 'js_math', argc: 2, lit: { op: 'K' } },
  'Math.atanh': { op: 'js_math', argc: 2, lit: { op: 'L' } },
  // pow 与 `**` 是同一件事（规范里两者都是 ToNumber 之后求幂），所以它就是那条算术 op
  'Math.pow': { op: 'js_arith', argc: 2, lit: { op: 'p' }, len: 2 },
  // imul 是**32 位乘法**，不是 `Math.*` 那一族：它属于 i32 那三条 op（ADR-0013 第三刀）。
  // `a * b` 先在 double 里丢精度，再折回 i32 已经错了 —— 这正是 `js_i32_op` 的 '*' 那一格。
  'Math.imul': { op: 'js_i32_op', argc: 2, pre: ['*'] },
  'Object.keys': { op: 'js_obj_keys', argc: 1, len: 1 },
  'Object.values': { op: 'js_obj_values', argc: 1, len: 1 },
  'Object.entries': { op: 'js_obj_entries', argc: 1, len: 1 },
  'Object.assign': { op: 'js_obj_assign', argc: 2, len: 2, assocL: true },
  /* ---- 真对象那一族（ADR-0020 P1）。`hasOwn` 从前接的是 js_obj_has，而那一条现在
     沿原型链走（`in` 的语义）—— 自有属性得问 js_obj_has_own，不然继承来的键也算"自有"。 */
  'Object.hasOwn': { op: 'js_obj_has_own', argc: 2, len: 2 },
  // Object.is（SameValue）：NaN 与自己相同、+0 与 -0 不同
  'Object.is': { op: 'js_same_value', argc: 2, len: 2 },
  'Object.create': { op: 'js_obj_create', argc: 2 },
  'Object.defineProperties': { op: 'js_obj_defs', argc: 2 },
  'Object.getPrototypeOf': { op: 'js_obj_proto_get', argc: 1, len: 1 },
  'Object.setPrototypeOf': { op: 'js_obj_proto_set', argc: 2 },
  'Object.defineProperty': { op: 'js_obj_def', argc: 3 },
  'Object.getOwnPropertyDescriptor': { op: 'js_obj_desc', argc: 2 },
  // 复数那一格（ES2017）：每一格自有属性一份描述符
  'Object.getOwnPropertyDescriptors': { op: 'js_obj_descs', argc: 1, len: 1 },
  'Object.getOwnPropertyNames': { op: 'js_obj_own_keys', argc: 1, lit: { sel: 's' } },
  'Object.getOwnPropertySymbols': { op: 'js_obj_own_keys', argc: 1, lit: { sel: 'y' } },
  'Object.freeze': { op: 'js_obj_freeze', argc: 1, len: 1 },
  'Object.seal': { op: 'js_obj_seal', argc: 1 },
  'Object.preventExtensions': { op: 'js_obj_prevent_ext', argc: 1 },
  'Object.isFrozen': { op: 'js_obj_is_frozen', argc: 1 },
  'Object.isSealed': { op: 'js_obj_is_sealed', argc: 1 },
  'Object.isExtensible': { op: 'js_obj_is_ext', argc: 1 },
  'Object.fromEntries': { op: 'js_obj_from_entries', argc: 1, len: 1 },
  // groupBy（ES2024）：回调收 (value, index)，每组按原顺序攒成数组
  'Object.groupBy': { op: 'js_obj_group_by', argc: 2, len: 2 },
  'Map.groupBy': { op: 'js_map_group_by', argc: 2, len: 2 },
  'Symbol.for': { op: 'js_sym_for', argc: 1 },
  'Symbol.keyFor': { op: 'js_sym_key_for', argc: 1 },
  'Reflect.getPrototypeOf': { op: 'js_obj_proto_get', argc: 1 },
  'Reflect.setPrototypeOf': { op: 'js_reflect_proto_set', argc: 2 },
  'Reflect.defineProperty': { op: 'js_reflect_def', argc: 3 },
  'Reflect.getOwnPropertyDescriptor': { op: 'js_obj_desc', argc: 2 },
  'Reflect.ownKeys': { op: 'js_obj_own_keys', argc: 1, lit: { sel: 'a' }, len: 1 },
  'Reflect.has': { op: 'js_obj_has_p', argc: 2, len: 2 },
  'Reflect.get': { op: 'js_getp', argc: 3, len: 2 },
  'Reflect.set': { op: 'js_reflect_set', argc: 4, len: 3 },
  'Reflect.deleteProperty': { op: 'js_obj_del_p', argc: 2 },
  'Reflect.isExtensible': { op: 'js_obj_is_ext', argc: 1 },
  'Reflect.preventExtensions': { op: 'js_reflect_prevent_ext', argc: 1 },
  /* Reflect.apply / Reflect.construct：就是"带 this 的调用"与"拿函数值当构造器"那两格 op
     （第三格实参本来就是一格数组，与 js_call_this / js_fn_construct 的形状对得上）。 */
  'Reflect.apply': { op: 'js_call_this', argc: 3, len: 3 },
  'Reflect.construct': { op: 'js_fn_construct', argc: 2, len: 2 },
  'Array.isArray': { op: 'js_arr_is_array', argc: 1, len: 1 },
  'Array.from': { op: 'js_arr_from', argc: 2, len: 1 },
  'String.fromCharCode': { op: 'js_str_of_char_code', argc: 1, len: 1, fold: 'js_add' },
  'String.fromCodePoint': { op: 'js_str_of_code_point', argc: 1, len: 1, fold: 'js_add' },
  'Number.isNaN': { op: 'js_num_is_nan', argc: 1, len: 1 },
  'Number.isFinite': { op: 'js_num_is_finite', argc: 1, len: 1 },
  'Number.isInteger': { op: 'js_num_is_integer', argc: 1, len: 1 },
  'Number.isSafeInteger': { op: 'js_num_is_safe_integer', argc: 1, len: 1 },
  'Number.parseInt': { op: 'js_num_parse_int', argc: 2, len: 2 },
  'Number.parseFloat': { op: 'js_num_parse_float', argc: 1, len: 1 },
  // Date.now()：就是宿主时钟那一格 op，不必造一格 Date 对象
  'Date.now': { op: 'js_now_ms', argc: 0, len: 0 },
  // Date.parse(串)：交出毫秒（认不出来是 NaN）。new Date(串) 走的是同一条解析
  'Date.parse': { op: 'js_date_parse', argc: 1, len: 1 },
  // Date.UTC：按 UTC 算的那一格（js_date_parts 是本地时区那一格）。缺席的实参由降级器
  // 补成 undefined，默认值在 $js_date_utc 里按规范给。
  'Date.UTC': { op: 'js_date_utc', argc: 7, len: 7 },
  // Promise 的三个静态面（ADR-0020 P2）。用到它们就要在 main 末尾排一次微任务队列，
  // 所以 abiCall 里对这几个 op 打一下 usesJobs
  'Promise.resolve': { op: 'js_promise_resolved', argc: 1, len: 1 },
  'Promise.reject': { op: 'js_promise_rejected', argc: 1, len: 1 },
  'Promise.all': { op: 'js_promise_all', argc: 1, len: 1 },
  'Promise.allSettled': { op: 'js_promise_all_settled', argc: 1, len: 1 },
  'Promise.any': { op: 'js_promise_any', argc: 1, len: 1 },
  'Promise.race': { op: 'js_promise_race', argc: 1, len: 1 },
  // Promise.try（ES2025）：f 同步跑，抛出来的当 reject
  'Promise.try': { op: 'js_promise_try', argc: 1, len: 1 },
  'BigInt.asIntN': { op: 'js_bigint_as_int_n', argc: 2 },
  'BigInt.asUintN': { op: 'js_bigint_as_uint_n', argc: 2 },
  'process.cwd': { op: 'js_proc_cwd', argc: 0 },
  'process.stdout.write': { op: 'js_proc_stdout_write', argc: 1 },
  'process.stderr.write': { op: 'js_proc_stderr_write', argc: 1 },
  // console.log 收可变实参（ADR-0020 P3）：各自 ToString、空格拼、只印一行 —— 与 qjs 的
  // js_print 同一个口径。从前只收一个实参，量特性覆盖的时候十条探针里九条卡在这儿。
  'console.log': { op: 'js_println', argc: 1, join: ' ' },
};

const STATIC_PROPS = {
  'process.argv': { op: 'js_proc_args' },
  'process.stdin.isTTY': { op: 'js_proc_stdin_is_tty' },
  /* well-known Symbol（ADR-0020 P1）：名字是编译期常量，所以走 lit。
     协议靠它们才立得住 —— for-of 找 Symbol.iterator、模板与 `+` 找 Symbol.toPrimitive、
     Object.prototype.toString 找 Symbol.toStringTag、instanceof 找 Symbol.hasInstance。 */
  'Symbol.iterator': { op: 'js_sym_wk', lit: { wk: 'iterator' } },
  'Symbol.asyncIterator': { op: 'js_sym_wk', lit: { wk: 'asyncIterator' } },
  'Symbol.toPrimitive': { op: 'js_sym_wk', lit: { wk: 'toPrimitive' } },
  'Symbol.toStringTag': { op: 'js_sym_wk', lit: { wk: 'toStringTag' } },
  'Symbol.hasInstance': { op: 'js_sym_wk', lit: { wk: 'hasInstance' } },
  'Symbol.species': { op: 'js_sym_wk', lit: { wk: 'species' } },
  'Symbol.unscopables': { op: 'js_sym_wk', lit: { wk: 'unscopables' } },
  /* 内建原型当值用（ADR-0020 P1-f）：它们现在是真对象，内建方法就住在上面。
     于是 `Object.prototype.toString.call(x)`、`Array.prototype.join.call(a, "|")`
     这类"借方法"的写法通了 —— 后半段是普通的属性读 + 带接收者的调用。 */
  'Object.prototype': { op: 'js_realm_proto', lit: { proto: 'Object' } },
  'Function.prototype': { op: 'js_realm_proto', lit: { proto: 'Function' } },
  'Array.prototype': { op: 'js_realm_proto', lit: { proto: 'Array' } },
  'String.prototype': { op: 'js_realm_proto', lit: { proto: 'String' } },
  'Number.prototype': { op: 'js_realm_proto', lit: { proto: 'Number' } },
  'Boolean.prototype': { op: 'js_realm_proto', lit: { proto: 'Boolean' } },
  'Symbol.prototype': { op: 'js_realm_proto', lit: { proto: 'Symbol' } },
  'RegExp.prototype': { op: 'js_realm_proto', lit: { proto: 'RegExp' } },
  'Map.prototype': { op: 'js_realm_proto', lit: { proto: 'Map' } },
  'Set.prototype': { op: 'js_realm_proto', lit: { proto: 'Set' } },
};

const STATIC_SETS = {
  'process.exitCode': { op: 'js_proc_exit_code' },
};

/* 没有运行期成分的那些属性（ADR-0020 P4）：直接就是一个 real 字面量。
   非有限的那几个（Infinity / NaN）不在这儿 —— 那要发射器那边先有"非有限字面量"这一格。 */
const CONST_PROPS = {
  'Number.EPSILON': 2.220446049250313e-16,
  'Number.MAX_SAFE_INTEGER': 9007199254740991,
  'Number.MIN_SAFE_INTEGER': -9007199254740991,
  'Number.MAX_VALUE': 1.7976931348623157e308,
  'Number.MIN_VALUE': 5e-324,
  'Math.PI': 3.141592653589793,
  'Math.E': 2.718281828459045,
  'Math.LN2': 0.6931471805599453,
  'Math.LN10': 2.302585092994046,
  'Math.LOG2E': 1.4426950408889634,
  'Math.LOG10E': 0.4342944819032518,
  'Math.SQRT2': 1.4142135623730951,
  'Math.SQRT1_2': 0.7071067811865476,
};

/* 内建的异常构造器（ADR-0020 P4）。都落到同一个 js_err_new 上，区别只有 $cls 链的头
 * 与 name —— 这个值域里没有真原型链上的 Error.prototype，catch 认的是那条链。
 * AggregateError 的实参顺序是 (errors, message, opts)，在 newExpr 里单独走一支。 */
const ERROR_CTORS = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
]);

/* realm 上有原型的那些内建构造器（ADR-0020）。它们**取不出函数值来**（封闭 ABI，
 * 决策 2），但 `x instanceof Object` 只要那一格 prototype —— 见 binary 里的 instanceof。
 * Error 那一族不在这儿：它们走 `$cls` 链（决策 15）。 */
const REALM_CTORS = new Set([
  'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'RegExp', 'Map', 'Set',
  'Date',
]);

const GLOBAL_CALLS = {
  String: { op: 'js_str', argc: 1, len: 1 },
  Number: { op: 'js_num_of', argc: 1, len: 1 },
  BigInt: { op: 'js_bigint_of', argc: 1, len: 1 },
  // Boolean(x)：就是 ToBoolean（`[1,0].map(Boolean)` 这类过滤写法要它当值用）
  Boolean: { op: 'js_truthy', argc: 1, len: 1 },
  parseInt: { op: 'js_num_parse_int', argc: 2, len: 2 },
  parseFloat: { op: 'js_num_parse_float', argc: 1, len: 1 },
  // 全局的 isNaN / isFinite 先 ToNumber（Number 上那两格不转，是另外的 op）
  isNaN: { op: 'js_global_is_nan', argc: 1, len: 1 },
  isFinite: { op: 'js_global_is_finite', argc: 1, len: 1 },
  // 四个 URI 函数是同一条 op 上的四个 op 码（见 hir/js_abi.js 的 js_uri）
  encodeURIComponent: { op: 'js_uri', argc: 1, lit: { op: 'e' }, len: 1 },
  encodeURI: { op: 'js_uri', argc: 1, lit: { op: 'E' }, len: 1 },
  decodeURIComponent: { op: 'js_uri', argc: 1, lit: { op: 'd' }, len: 1 },
  decodeURI: { op: 'js_uri', argc: 1, lit: { op: 'D' }, len: 1 },
  // Symbol(desc)（ADR-0020 P1）。**不是构造器** —— `new Symbol()` 在 JS 里是 TypeError，
  // 这儿也就只有调用这一条路。
  Symbol: { op: 'js_sym_new', argc: 1 },
};

/**
 * JS 的 Program -> OIR 模块。
 * @param {any} program frontend-js/parser.js 的输出
 * @param {import('../source/diag.js').Diagnostics} diags
 */
export function lowerJs(program, diags) {
  return new Lower(diags).module(program);
}

/**
 * JS 前端的**增量会话**（REPL 的 `--lang js`）。
 *
 * 与 CheckSession / CoreSession / AsySession 是同一个形状：一批输入 -> 这一批新增的 OIR
 * （几个新函数 + 一个入口 `omni_chunk_N`），装进运行期会话再跑那个入口。
 *
 * 跨批可见性在这条腿上几乎是白拿的：JS 的顶层 `let/const/var` 本来就降成**模块级全局**
 * （`collectTop` 里那句 `this.globals.set(...)`，两个后端各发一个真全局），而运行期会话
 * 对已经见过的名字不重开格子 —— 所以第 1 批的 `x` 第 2 批还在，不需要"常驻顶层 Env"
 * 那套东西。函数与类同理（`topFns` / `classes` 留在 Lower 里）。
 *
 * 这一条也是"原生二进制不丢 JS 能力"的落点：它只用前端 + 任一执行引擎，
 * 不需要宿主有能吃 JS 文本的引擎。
 */
export class JsFrontSession {
  constructor() {
    this.L = new Lower(null);
    this.no = 0;
  }

  snapshot() {
    const L = this.L;
    return {
      funcs: L.funcs.length,
      closures: L.closures.length,
      cused: L.cused.length,
      globals: new Map(L.globals),
      topFns: new Map(L.topFns),
      regexConsts: new Map(L.regexConsts),
      classes: new Map(L.classes),
      fnValues: new Map(L.fnValues),
      used: new Set(L.used),
      no: this.no,
    };
  }

  restore(s) {
    const L = this.L;
    L.funcs.length = s.funcs;
    L.closures.length = s.closures;
    L.cused.length = s.cused;
    L.globals = s.globals;
    L.topFns = s.topFns;
    L.regexConsts = s.regexConsts;
    L.classes = s.classes;
    L.fnValues = s.fnValues;
    L.used = s.used;
    this.no = s.no;
  }

  /** 一批（parser.js 的 Program） -> 这一批新增的 OIR。诊断按批传进来。
   *
   * `opts.valueOfLast`：最后一句是表达式语句时，把它的值当整段的**完成值**返回
   * （入口的返回类型于是是 dynamic）。`eval` 那条路要它 —— ADR-0020 的 P6。 */
  add(program, diags, opts = {}) {
    const L = this.L;
    L.diags = diags;
    this.no = this.no + 1;
    const baseFuncs = L.funcs.length;
    const baseClosures = L.closures.length;
    if (program.natives) L.natives = program.natives;
    if (program.cnatives) L.cnatives = program.cnatives;
    for (const s of program.body) L.collectTop(s);
    for (const s of program.body) if (s.type === 'FuncDecl') L.funcDecl(s);
    for (const s of program.body) if (s.type === 'ClassDecl') L.classDecl(s);
    const entry = `omni_chunk_${this.no}`;
    const wantValue = opts.valueOfLast === true;
    /* eval 的那一段不是 main：顶层声明留在这一帧里（不外泄成宿主全局），而且"抛出来就
     * 提前 return"那一句要带一格 undefined —— main 是 void 的，返回值那一格得是 null。 */
    L.fn = L.newFrame(program.body, { isMain: !wantValue });
    const stmts = [];
    let valueTmp = null;
    program.body.forEach((s, i) => {
      if (s.type === 'FuncDecl') return;
      if (wantValue && i === program.body.length - 1 && s.type === 'ExprStmt') {
        /* 完成值：算进一格临时量。这一句要自己走 sink 与 pending 检查那一套
         * （stmt() 平时替每条语句做这件事，而这儿是手搓的一条）。 */
        valueTmp = L.temp();
        const outerSink = L.fn.sink;
        const pre = [];
        L.fn.sink = pre;
        const v = L.expr(s.expr);
        L.fn.sink = outerSink;
        stmts.push(...L.withCheck(s, [...pre, exprStmt(assign(varRef(valueTmp), v))]));
        return;
      }
      stmts.push(...L.stmt(s));
    });
    const tail = [...L.jobsTail()];
    if (wantValue) {
      tail.push({ kind: 'Return', value: valueTmp === null ? undefExpr() : varRef(valueTmp) });
    }
    const main = {
      name: entry,
      mangled: entry,
      // 入口那一格属于**这一批的第一句**所在的文件（整批就是一个模块的顶层）
      file: program.body.length > 0 ? fileOfSpan(program.body[0].span) : '',
      ret: wantValue ? D : { k: 'void' },
      params: [],
      body: block([...L.fn.prelude, ...stmts, ...tail]),
    };
    L.fn = null;
    L.funcs.push(main);
    // 全局槽每批都整份带上：运行期会话对见过的名字不重开格子（值留着），
    // 而新名字必须有人声明 —— 只带增量就得再算一次差集，没意义。
    return {
      structs: [],
      // JS 的类降成"造实例"的函数（决策 13），所以 OIR 的 classes 一直是空的 ——
      // 新增的类就在 funcs 的增量里
      classes: [],
      containers: [listType(STRING), listType(D), dictType(STRING, D)],
      closures: L.closures.slice(baseClosures),
      fnTypes: [JS_FN],
      jsGlobals: [...L.globals.values()],
      funcs: L.funcs.slice(baseFuncs),
      entry,
      js: true,
      cabi: L.cused,
    };
  }
}

