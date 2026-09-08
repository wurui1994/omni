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

/** 子树里最外层的那些函数节点（不再往里钻 —— refNames 会把更深层一起收） */
function nestedFns(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Arrow' || node.type === 'FuncExpr' || node.type === 'FuncDecl') {
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
const CLASS_INIT_KEY = '$init';

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
  if (node.type === 'FuncExpr' || node.type === 'FuncDecl' || node.type === 'ClassDecl') return false;
  let hit = false;
  eachChild(node, (x) => { if (!hit) hit = mentionsThis(x); });
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

class Lower {
  /** @param {import('../source/diag.js').Diagnostics} diags */
  constructor(diags) {
    this.diags = diags;
    this.funcs = [];
    /** 模块级的 const/let/var：名字 -> 全局槽（后端各发一个真全局） */
    this.globals = new Map();
    /** 顶层函数声明：名字 -> mangled。互相递归靠的就是先收一遍再降级 */
    this.topFns = new Map();
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
    for (const s of program.body) this.collectTop(s);
    for (const s of program.body) {
      if (s.type === 'FuncDecl') this.funcDecl(s);
    }
    for (const s of program.body) {
      if (s.type === 'ClassDecl') this.classDecl(s);
    }
    // 顶层的其余语句是 omni_main 的函数体；模块级变量的初始化也在这里发生
    const main = { name: 'main', mangled: 'omni_main', ret: { k: 'void' }, params: [], body: null };
    this.fn = this.newFrame(program.body, { isMain: true });
    const stmts = [];
    for (const s of program.body) {
      if (s.type === 'FuncDecl') continue;
      stmts.push(...this.stmt(s));
    }
    main.body = block([...this.fn.prelude, ...stmts]);
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

  collectTop(s) {
    switch (s.type) {
      case 'FuncDecl':
        if (this.topFns.has(s.id)) this.err(s.span, `duplicate function '${s.id}'`);
        this.topFns.set(s.id, this.mangle('u_', s.id));
        break;
      case 'VarDecl':
        for (const d of s.decls) {
          // 不带 g 的正则可以当"编译期常量"折到使用点上，不占全局槽：它没有可观察的
          // 状态（lastIndex 谁都不碰），折一份和共用一份不可区分。
          // **带 g 的不行** —— lastIndex 是那一格自己的状态，`re.exec(s)` 的循环靠它推进，
          // 折到使用点就成了每次一格新的，循环永远停在第一个匹配上（ADR-0011 决策 10）。
          if (s.kind === 'const' && d.id.type === 'Ident' && d.init && d.init.type === 'Regex'
            && !d.init.flags.includes('g')) {
            this.regexConsts.set(d.id.name, { body: d.init.body, flags: d.init.flags });
            continue;
          }
          for (const n of patternNames(d.id, this, s.span)) this.globals.set(n, { name: cSafe(n) });
        }
        break;
      case 'ClassDecl': {
        if (this.classes.has(s.id)) this.err(s.span, `duplicate class '${s.id}'`);
        // 继承只支持 `extends Error`（量过：全仓库三处，全是异常类）。异常类的实例带一条
        // $cls 链，instanceof 查的就是它（ADR-0011 决策 15）
        const sup = s.superClass;
        const isError = !!(sup && sup.type === 'Ident' && sup.name === 'Error');
        /* `extends`（ADR-0020 P1-f）：Error 那一支照旧走 `$cls` 链；别的收**这个文件里
         * 声明过的类名** —— 原型链要拿到父类的原型对象与 `$init`，而那两格是模块级全局。
         * 任意表达式（`class C extends mixin(B)`）还不收，那要先有"类当值"。 */
        const superName = !isError && sup ? (sup.type === 'Ident' ? sup.name : null) : null;
        if (!isError && sup && superName === null) {
          this.err(s.span, "'extends <expression>' is not supported; extend a class declared in this file");
        }
        this.classes.set(s.id, { mangled: this.mangle('n_', s.id), node: s, isError, superName });
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
    this.funcs.push(this.funcOf(s.id, this.topFns.get(s.id), s.params, s.rest, s.body.body, s.span));
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
      // 每层 switch 进去时的循环层数，以及那层的"出去之后要 continue"标志位（懒声明）
      switchLoops: [], switchFlags: [],
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
    const stmts = [];
    /* `this`（ADR-0020 P1）：普通函数与方法自己在**入口**取一次接收者。
     * 三种情况不取：
     *   - 箭头（`opts.isArrow`）：它的 this 是外层那一个，靠 cell 捕获拿到；
     *   - 构造器（`opts.isCtor`）：那一格是 classDecl 自己造的实例；
     *   - **外层已经有 `this`**：类的方法闭包捕获的就是构造器里那个实例（ADR-0011
     *     决策 13）。取接收者会把它遮住 —— 而那个类的方法被当回调传出去时就没有接收者，
     *     于是 this 变 undefined。这条腿在 P1-f（类改成原型链）之后才该翻过来。
     * 提到 this 才发这一句：每个函数都发就是每次调用多一次 op，而量过的源码里绝大多数
     * 函数根本不提它。加进 captured 是为了内层箭头能把它当 cell 捕获下去。 */
    if (!opts.isArrow && !opts.isCtor && !this.lookup('this')
      && (opts.wantThis === true || bodyStmts.some((s) => mentionsThis(s)))) {
      this.fn.captured.add('this');
      const self = this.declare('this');
      stmts.push(this.declStmt(self, op('js_this_take', [])));
    }
    /* `pre`：在**取完接收者、绑形参之前**插几句。类的实例字段就是这么进去的
     * （ADR-0020 P1-f）：规范里字段在构造器体之前初始化，而且它们看不见构造器的形参。 */
    if (opts.pre) stmts.push(...opts.pre());
    // 这一帧属于哪个类（`super.m()` 与 `super(...)` 要靠它找父类，ADR-0020 P1-f）
    if (opts.classOf) this.fn.classOf = opts.classOf;
    params.forEach((p, i) => stmts.push(...this.bindParam(p, i, span)));
    if (rest) {
      if (rest.type !== 'Ident') this.err(span, 'destructuring a rest parameter is not supported');
      const ent = this.declare(rest.type === 'Ident' ? rest.name : '_rest');
      stmts.push(this.declStmt(ent, op('js_arr_slice', [argsDyn(), constReal(params.length), undefExpr()])));
    }
    stmts.push(...this.hoistFuncDecls(bodyStmts));
    for (const st of bodyStmts) stmts.push(...this.stmt(st));
    const f = {
      name,
      mangled,
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
    const id = this.closures.length;
    const mangled = this.mangle('l_', label);
    const rec = { id, mangled, make: `omni_mk_${mangled}`, captures: [] };
    this.closures.push(rec);   // 先占位：体里的嵌套闭包会往后追加，id 不能变
    // 箭头的表达式体等价于 { return expr; }
    const bodyStmts = node.type === 'Arrow' && node.expression
      ? [{ type: 'Return', arg: node.body, span: node.span }]
      : node.body.body;
    if (node.type === 'FuncExpr' && node.id && refNames(node).has(node.id)) {
      this.err(node.span, `a named function expression cannot refer to itself ('${node.id}'); use a const arrow instead`);
    }
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
    // 异常类的实例是 { $cls: [类名, "Error"], message }；没写构造器时 message 就是第一个实参
    const init = rec.isError
      ? op('js_err_new', [
        ctor ? undefExpr() : op('js_arr_get', [argsDyn(), constReal(0)]),
        arrLit([s16(s.id), s16('Error')]),
      ])
      : op('js_obj_new', []);
    const stmts = [localStmt(self.name, arrLit([init]))];
    for (const [name, m] of methods) {
      stmts.push(exprStmt(op('js_obj_set',
        [this.readEntry(self), s16(name), this.closureExpr(m, `${s.id}_${name}`)])));
    }
    if (ctor) {
      ctor.params.forEach((p, i) => stmts.push(...this.bindParam(p, i, ctor.span)));
      if (ctor.rest) {
        if (ctor.rest.type !== 'Ident') this.err(ctor.span, 'destructuring a rest parameter is not supported');
        const ent = this.declare(ctor.rest.type === 'Ident' ? ctor.rest.name : '_rest');
        stmts.push(this.declStmt(ent, op('js_arr_slice', [argsDyn(), constReal(ctor.params.length), undefExpr()])));
      }
      stmts.push(...this.hoistFuncDecls(bodyStmts));
      for (const st of bodyStmts) stmts.push(...this.stmt(st));
    }
    const body = block([...this.fn.prelude, ...stmts, { kind: 'Return', value: this.readEntry(self) }]);
    this.fn = outer;
    this.funcs.push({ name: s.id, mangled: rec.mangled, ret: D, params: [{ name: 'args', type: listType(D) }], body });
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
  classProtoStmts(s) {
    const rec = this.classes.get(s.id);
    const sup = rec.superName;
    if (sup !== null) {
      const srec = this.classes.get(sup);
      if (!srec || srec.isError) {
        this.err(s.span, `'extends ${sup}': ${srec ? 'extending an Error subclass is not supported yet' : `'${sup}' is not a class declared in this file`}`);
      }
    }
    const protoG = () => globalRef(this.globals.get(protoGlobalName(s.id)).name);
    const classG = () => globalRef(this.globals.get(s.id).name);
    const out = [];
    /* 原型链就是**把父类的原型当自己原型的原型**；静态成员的继承是"类对象的原型是父类对象"
     * （规范如此 —— 所以子类身上能查到父类的 static 方法）。 */
    const supProto = sup === null ? undefExpr() : globalRef(this.globals.get(protoGlobalName(sup)).name);
    out.push(exprStmt(assign(protoG(), op('js_obj_new_p', [supProto]))));
    out.push(exprStmt(assign(classG(), op('js_obj_new', []))));
    if (sup !== null) {
      out.push(exprStmt(op('js_obj_proto_set', [classG(), globalRef(this.globals.get(sup).name)])));
    }
    // prototype 与 constructor 互指，两条都不可枚举
    out.push(exprStmt(this.defHidden(classG(), s16('prototype'), protoG())));
    out.push(exprStmt(this.defHidden(protoG(), s16('constructor'), classG())));

    let ctor = null;
    const fields = [];
    for (const m of s.members) {
      const what = m.computed ? null : this.keyName(m.key, m.span);
      const key = () => (m.computed ? this.expr(m.key) : s16(what));
      const target = m.static ? classG : protoG;
      if (m.kind === 'field') {
        // static 字段直接落在类对象上（可枚举、可写）；实例字段进 $init
        if (m.static) out.push(exprStmt(op('js_obj_set', [classG(), key(), m.value ? this.expr(m.value) : undefExpr()])));
        else fields.push(m);
        continue;
      }
      if (what === 'constructor' && !m.static) { ctor = m; continue; }
      const label = `${s.id}_${m.static ? 'static_' : ''}${what ?? 'computed'}`;
      const fn = this.closureExpr(fnNodeOfProp(m), label, { classOf: s.id });
      if (m.kind === 'get' || m.kind === 'set') {
        let desc = op('js_obj_set', [op('js_obj_new', []), s16(m.kind), fn]);
        desc = op('js_obj_set', [desc, s16('configurable'), constBool(true)]);
        out.push(exprStmt(op('js_obj_def', [target(), key(), desc])));
      } else {
        out.push(exprStmt(this.defHidden(target(), key(), fn)));
      }
    }
    out.push(exprStmt(this.defHidden(classG(), s16(CLASS_INIT_KEY), this.classInitClosure(s, ctor, fields))));
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
  classInitClosure(s, ctor, fields) {
    const sup = this.classes.get(s.id).superName;
    const node = {
      type: 'FuncExpr',
      id: null,
      params: ctor ? ctor.params : [],
      rest: ctor ? ctor.rest : null,
      body: ctor ? ctor.body : { type: 'Block', body: [], span: s.span },
      span: s.span,
    };
    return this.closureExpr(node, `${s.id}_init`, {
      wantThis: true,
      classOf: s.id,
      pre: () => {
        const pre = [];
        /* 没写构造器的派生类：规范给的隐式构造器是 `constructor(...a){ super(...a) }` ——
         * 所以整条实参表原样转给父类的 `$init`。写了构造器的那些由 `super(...)` 自己发。 */
        if (!ctor && sup !== null) {
          pre.push(exprStmt(op('js_call_this', [
            op('js_obj_get', [globalRef(this.globals.get(sup).name), s16(CLASS_INIT_KEY)]),
            this.readEntry(this.lookup('this')),
            argsDyn(),
          ])));
        }
        // 字段在构造器体**之前**、形参绑定之前（规范：字段初始化器看不见构造器的形参）
        for (const f of fields) {
          pre.push(exprStmt(op('js_setp', [
            this.readEntry(this.lookup('this')),
            f.computed ? this.expr(f.key) : s16(this.keyName(f.key, f.span)),
            f.value ? this.expr(f.value) : undefExpr(),
          ])));
        }
        return pre;
      },
    });
  }

  /** 这个静态路径（或它的某个前缀）在 STATIC_PROPS 里注册过吗（ADR-0020 P1-f） */
  staticPrefix(node) {
    let cur = node;
    while (cur && cur.type === 'Member' && !cur.computed) {
      const p = this.staticPath(cur);
      if (p && STATIC_PROPS[p]) return true;
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
    return globalRef(this.globals.get(protoGlobalName(sup)).name);
  }

  /** 闭包值的构造表达式（在**外层**栈帧里求值） */
  closureExpr(node, label, extra = {}) {
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
    const rec = { id, mangled, make: `omni_mk_${mangled}`, captures: [] };
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

  stmtInner(s) {
    switch (s.type) {
      case 'Empty': return [];
      case 'Block': {
        this.pushScope();
        const out = s.body.flatMap((x) => this.stmt(x));
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
        const cond = this.lazy(() => truthy(this.expr(s.test)));
        const st = { kind: 'While', cond, body: this.bodyBlock(s.body) };
        this.fn.oloops--;
        this.fn.loops--;
        return [st];
      }
      case 'DoWhile': return this.doWhile(s);
      case 'For': return this.forStmt(s);
      case 'ForOf': return this.forOf(s);
      case 'ForIn':
        // for-in（ADR-0020 P3）：与 for-of 同一个形状，只是那一串是"键"
        return this.forOf(s, () => op('js_for_in_keys', [this.expr(s.right)]));
      case 'Return':
        // 构造器的 return 只能是空的（值就是实例），别的形状拒掉
        if (this.fn.isCtor) {
          if (s.arg) this.err(s.span, 'a constructor cannot return a value');
          return [{ kind: 'Return', value: this.readEntry(this.lookup('this')) }];
        }
        return [{ kind: 'Return', value: s.arg ? this.expr(s.arg) : undefExpr() }];
      case 'Labeled': {
        // 标签只打在循环上（parser 那边保证）。记下"进了这层循环之后 OIR 有多少层"，
        // 里面的 `break L` 就能算出要跳出几层。
        this.fn.labels.push({ name: s.label, depth: this.fn.oloops + 1 });
        const st = this.stmt(s.body);
        this.fn.labels.pop();
        return st;
      }
      case 'Break':
        if (s.label) return [{ kind: 'Break', level: this.labelLevel(s, 'break') }];
        if (this.crossesTry()) {
          this.err(s.span, "'break' cannot cross a try boundary; restructure the try");
        } else if (this.fn.loops === 0 && this.fn.switches === 0) {
          this.err(s.span, "'break' outside a loop or switch");
        }
        return [{ kind: 'Break' }];
      case 'Continue':
        // do-while 摊成 while(true) 之后，continue 会跳过尾部的条件检查
        if (s.label) return [{ kind: 'Continue', level: this.labelLevel(s, 'continue') }];
        if (this.crossesTry()) {
          this.err(s.span, "'continue' cannot cross a try boundary; restructure the try");
        } else if ((this.fn.doWhiles ?? 0) > 0) {
          this.err(s.span, "'continue' inside a do-while is not lowered yet; restructure the loop");
        } else if (this.fn.loops === 0) {
          this.err(s.span, "'continue' outside a loop");
        }
        return this.continueStmts();
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
        this.err(s.span, 'a class declaration is only supported at the top level of a module');
        return [];
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
      const out = s.body.flatMap((x) => this.stmt(x));
      this.popScope();
      return block(out);
    }
    return block(this.stmt(s));
  }

  varDecl(s) {
    const out = [];
    for (const d of s.decls) {
      // 模块级的正则 const 没有运行期的身份（ADR-0011 决策 10）：collectTop 已经把它
      // 记成编译期常量了，这里什么都不发
      if (d.id.type === 'Ident' && this.fn.isMain && this.fn.scopes.length === 1
          && this.regexConsts.has(d.id.name)) continue;
      const init = () => (d.init ? this.expr(d.init) : undefExpr());
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
    // 右值只算一次，存进一个临时量再按位取
    const t = this.declare('_d').name;
    const out = [localStmt(t, value)];
    if (pat.type === 'ArrayPattern') {
      pat.elements.forEach((el, i) => {
        if (el === null) return;
        out.push(...this.bindElem(el, op('js_idx_get', [varRef(t), constReal(i)])));
      });
      if (pat.rest) {
        out.push(...this.bindElem(pat.rest,
          op('js_arr_slice', [varRef(t), constReal(pat.elements.length), undefExpr()])));
      }
      return out;
    }
    if (pat.type === 'ObjectPattern') {
      for (const p of pat.props) {
        if (p.computed) { this.err(pat.span, 'computed keys in a destructuring pattern are not supported'); continue; }
        const key = this.keyName(p.key, pat.span);
        out.push(...this.bindElem(p.value, op('js_obj_get', [varRef(t), s16(key)])));
      }
      if (pat.rest) this.err(pat.span, 'rest in an object pattern is not supported');
      return out;
    }
    this.err(pat.span, `cannot destructure with '${pat.type}'`);
    return out;
  }

  /** 模式里的一个位置：可能带默认值（只在 === undefined 时生效） */
  bindElem(el, value) {
    if (el.type === 'AssignPattern') {
      if (el.left.type !== 'Ident') {
        this.err(el.span, 'a default value on a nested pattern is not supported');
        return this.bindPattern(el.left, value);
      }
      const ref = () => this.refVar(el.left.name);
      const decl = this.defineVar(el.left.name, () => value);
      return [...decl, {
        kind: 'If',
        cond: boolOp('js_eq', [ref(), undefExpr()], { strict: true }),
        then: block([exprStmt(this.writeVar(el.left.name, this.expr(el.right)))]),
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

  /** do-while：OIR 没有 do-while，摊成 while(true) { body; if (!test) break; } */
  doWhile(s) {
    this.fn.loops++;
    this.fn.oloops++;
    this.fn.doWhiles = (this.fn.doWhiles ?? 0) + 1;
    const body = this.bodyBlock(s.body);
    this.fn.doWhiles--;
    this.fn.oloops--;
    this.fn.loops--;
    body.stmts.push({
      kind: 'If',
      cond: this.lazy(() => notB(truthy(this.expr(s.test)))),
      then: block([{ kind: 'Break' }]),
      otherwise: null,
    });
    return [{ kind: 'While', cond: { kind: 'Const', type: BOOL, value: true }, body }];
  }

  forStmt(s) {
    this.pushScope();
    let pre = [];
    if (s.init) {
      pre = s.init.type === 'VarDecl' ? this.varDecl(s.init) : [exprStmt(this.expr(s.init.expr))];
    }
    // `for (let i = …)` 的绑定在 JS 里是**每轮一个新的**，而这里的循环变量只有一个 cell。
    // 闭包捕获它就会两边（其实是和 JS 自己）分叉，所以直接拒绝，不悄悄给出 var 的语义。
    //
    // 问的是**自由变量**（`freeNames` 上面那段）：从前这儿看的是 `ent.kind === 'cell'`，
    // 而 cell 是**保守**算出来的 —— 内层闭包里有个同名局部量就够让外层循环变量变 cell，
    // 于是「体里一个闭包都没有」的循环也会被骂。保守分析不该接到硬拒绝上。
    const capturedHere = new Set();
    for (const part of [s.body, s.test, s.update]) {
      for (const g of nestedFns(part)) freeNames(g, capturedHere);
    }
    for (const [n] of this.fn.scopes[this.fn.scopes.length - 1]) {
      if (capturedHere.has(n)) {
        this.err(s.span, `'${n}' is a for-loop variable captured by a closure; copy it into a body-local const first`);
      }
    }
    const cond = s.test ? this.lazy(() => truthy(this.expr(s.test))) : { kind: 'Const', type: BOOL, value: true };
    const step = s.update ? this.lazy(() => this.exprDiscard(s.update)) : null;
    this.fn.loops++;
    this.fn.oloops++;
    const body = this.bodyBlock(s.body);
    this.fn.oloops--;
    this.fn.loops--;
    this.popScope();
    // init 摊在 For 外面（多个声明时 OIR 的 init 放不下），所以套一层块管作用域
    const loop = { kind: 'For', init: null, cond, step, body };
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
  forOf(s, seqOf = () => op('js_iter', [this.expr(s.right)])) {
    if (!s.declKind) {
      this.err(s.span, 'for-of over an existing variable is not supported; declare the loop variable');
      return [];
    }
    this.pushScope();
    const it = this.declare('_it').name;
    const i = this.declare('_i').name;
    const pre = [localStmt(it, seqOf()), localStmt(i, constReal(0))];
    const cond = boolOp('js_cmp', [varRef(i), op('js_p_length', [varRef(it)])], { op: '<' });
    const step = assign(varRef(i), op('js_add', [varRef(i), constReal(1)]));
    this.fn.loops++;
    this.fn.oloops++;
    const inner = this.bindPattern(s.left, op('js_idx_get', [varRef(it), varRef(i)]));
    const body = this.bodyBlock(s.body);
    this.fn.oloops--;
    this.fn.loops--;
    this.popScope();
    return [block([...pre, { kind: 'For', init: null, cond, step, body: block([...inner, ...body.stmts]) }])];
  }

  /**
   * switch：OIR 没有 switch，摊成 if / else-if 链。两个讲究：
   *   - 外面套一层"只跑一遍的循环"，这样 case 体里的 break 就是 OIR 的 Break，
   *     语义正好是"跳出 switch"（而不是跳出外层循环）。
   *   - 不支持穿透（fall-through）：量过的 37 处 switch 全都不穿透。空体的 case 是
   *     分组写法（case 'a': case 'b': body），按"或"合并到下一个有体的 case 上。
   */
  switchStmt(s) {
    this.pushScope();
    const d = this.declare('_sw').name;
    const pre = [localStmt(d, this.expr(s.disc))];
    this.fn.switches++;
    this.fn.switchLoops.push(this.fn.loops);
    // 下面那层合成的 while(true) 在 OIR 里是**一层真的循环**，case 体是在它里面降的
    this.fn.oloops++;
    this.fn.switchFlags.push(null);
    /** @type {{tests: any[], body: any[]}[]} */
    const groups = [];
    let pending = [];
    let dflt = null;
    for (const cs of s.cases) {
      const isDefault = cs.test === null;
      const tests = isDefault ? [] : [this.expr(cs.test)];
      if (cs.body.length === 0) {
        if (!isDefault) pending.push(...tests);
        continue;   // 分组写法：条件攒着，等下一个有体的 case
      }
      const body = cs.body.flatMap((x) => this.stmt(x));
      this.checkNoFallThrough(cs, cs === s.cases[s.cases.length - 1]);
      if (isDefault) dflt = block(body);
      else { groups.push({ tests: [...pending, ...tests], body }); pending = []; }
    }
    if (pending.length) this.err(s.span, 'a switch case group must end with a case that has a body');
    let chain = dflt;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      let cond = boolOp('js_eq', [varRef(d), g.tests[0]], { strict: true });
      for (const t of g.tests.slice(1)) {
        cond = { kind: 'Logic', op: '||', left: cond, right: boolOp('js_eq', [varRef(d), t], { strict: true }), type: BOOL };
      }
      // OIR 的 If 只认块状的 then/otherwise，所以 else-if 要自己套一层块
      chain = { kind: 'If', cond, then: block(g.body), otherwise: chain ? block([chain]) : null };
    }
    this.fn.switches--;
    this.fn.oloops--;
    this.fn.switchLoops.pop();
    const flag = this.fn.switchFlags.pop();
    this.popScope();
    const body = block(chain ? [chain, { kind: 'Break' }] : [{ kind: 'Break' }]);
    const loop = { kind: 'While', cond: { kind: 'Const', type: BOOL, value: true }, body };
    if (!flag) return [block([...pre, loop])];
    // 里面有 continue：合成循环会把它接住，所以改成"置标志位 + break"，出来再补一次
    // continue（外面还是 switch 的话，continueStmts 会继续往上传一层）
    return [block([
      ...pre,
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
   * 跨 try 不行：try 的合成循环出来之后紧跟着 pending 检查（catch 就长在那儿），
   * 从里面跳出去等于跳过 catch。
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
    const tries = this.fn.tryOLoops;
    if (tries.length > 0 && ent.depth <= tries[tries.length - 1]) {
      this.err(s.span, `'${what} ${s.label}' cannot cross a try boundary; restructure the try`);
      return 1;
    }
    return this.fn.oloops - ent.depth + 1;
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
   * finally 不支持（量过：全仓库 1 处），break/continue 也不许跨过 try 的边界 ——
   * 它们会被这层合成的循环接住，语义就变了。
   */
  tryStmt(s) {
    if (s.finalizer) {
      this.err(s.span, "'finally' is not lowered; duplicate the cleanup into both paths");
      return [];
    }
    if (!s.handler) { this.err(s.span, "'try' needs a 'catch'"); return []; }
    this.fn.tries++;
    this.fn.tryLoops.push(this.fn.loops);
    this.fn.oloops++;   // try 体也摊在一层合成的 while(true) 里
    this.fn.tryOLoops.push(this.fn.oloops);
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
    // 绑不绑名字都要把槽取空 —— 不取的话下一次 pending 检查会重新抛一遍
    const head = s.param ? this.bindPattern(s.param, op('js_take_pending', []))
      : [exprStmt(op('js_take_pending', []))];
    const handler = s.handler.body.flatMap((x) => this.stmt(x));
    this.popScope();
    return [loop, {
      kind: 'If',
      cond: boolOp('js_pending', []),
      then: block([...head, ...handler]),
      otherwise: null,
    }];
  }

  /** 最后一个 case 掉出去没关系（后面没有 case 可穿）；中间的必须自己结束 */
  checkNoFallThrough(cs, isLast) {
    if (isLast) return;
    const last = cs.body[cs.body.length - 1];
    if (!endsControl(last)) {
      this.err(last?.span ?? cs.body[0]?.span, 'a switch case must not fall through; end it with break or return');
    }
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
        this.err(e.span, 'class expressions are not lowered yet (ADR-0011 landing step 6c)');
        return undefExpr();
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
    if (this.globals.has(e.name)) return globalRef(this.globals.get(e.name).name);
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
    if (STATIC_NS.has(e.name)) {
      this.err(e.span, `'${e.name}' can only be used as a member base, e.g. ${e.name}.something`);
      return undefExpr();
    }
    this.err(e.span, `unresolved identifier '${e.name}'`);
    return undefExpr();
  }

  /** 模板串：从第一段字符串开始一路 js_add —— 有一边是字符串，js_add 就是拼接 */
  template(e) {
    if (e.tag) {
      // String.raw`…`（没有插值）= 一个字面量：raw 就是源码里那段原文，不做转义。
      // 编译器自己靠它装 JS 前奏（backend-js/prelude.js），所以这一支必须能降。
      const tag = e.tag.type === 'Member' ? this.staticPath(e.tag) : null;
      if (tag === 'String.raw' && e.exprs.length === 0) return s16(e.quasis[0].raw);
      this.err(e.span, tag === 'String.raw'
        ? 'String.raw`…` with a substitution is not supported'
        : 'tagged templates are not supported');
      return undefExpr();
    }
    let out = s16(e.quasis[0].cooked);
    for (let i = 0; i < e.exprs.length; i++) {
      out = op('js_add', [out, this.expr(e.exprs[i])]);
      out = op('js_add', [out, s16(e.quasis[i + 1].cooked)]);
    }
    return out;
  }

  arrayLit(e) {
    /** @type {any[]} 一段段拼：连续的普通元素是一个 ListLit，展开的是 js_iter */
    const parts = [];
    let run = [];
    for (const el of e.elements) {
      if (el === null) {
        // 洞（`[1,,3]`）：这个值域里没有"稀疏数组"那一格，所以洞就是 undefined。
        // 与 JS 的差别只剩 `1 in [1,,3]`（那边是 false，我们是 true）—— 记在 ADR-0020，
        // 等真数组对象那一片（P4 的 TypedArray/Array exotic）再对齐。
        run.push(undefExpr());
        continue;
      }
      if (el.type === 'Spread') {
        if (run.length) { parts.push(arrLit(run)); run = []; }
        parts.push(op('js_iter', [this.expr(el.arg)]));
        continue;
      }
      run.push(this.expr(el));
    }
    if (run.length || parts.length === 0) parts.push(arrLit(run));
    return parts.reduce((a, b) => op('js_arr_concat', [a, b]));
  }

  /** 对象字面量：js_obj_set / js_obj_assign 都返回对象本身，所以能纯表达式地串起来 */
  objectLit(e) {
    let out = op('js_obj_new', []);
    for (const p of e.props) {
      if (p.kind === 'spread') {
        out = op('js_obj_assign', [out, this.expr(p.arg)]);
        continue;
      }
      if (p.kind === 'get' || p.kind === 'set') {
        /* 访问器（ADR-0020 P1）：降成一次 defineProperty —— 描述符本身也是一格对象。
         * enumerable/configurable 都是 true（字面量里的访问器就是这个默认）。
         * 同一个键上 get 与 set 分两次定义：js_obj_def 在已有的访问器槽上只覆盖
         * **desc 里出现过**的字段，所以先 get 后 set 两条都留得住。 */
        const key = p.computed ? this.expr(p.key) : s16(this.keyName(p.key, p.span));
        const fn = this.closureExpr(fnNodeOfProp(p), p.kind);
        let desc = op('js_obj_set', [op('js_obj_new', []), s16(p.kind), fn]);
        desc = op('js_obj_set', [desc, s16('enumerable'), constBool(true)]);
        desc = op('js_obj_set', [desc, s16('configurable'), constBool(true)]);
        out = op('js_obj_def', [out, key, desc]);
        continue;
      }
      if (p.kind !== 'init') {
        this.err(p.span, `object literal property kind '${p.kind}' is not lowered yet`);
        continue;
      }
      const key = p.computed ? this.expr(p.key) : s16(this.keyName(p.key, p.span));
      /* 方法简写 `{ m() {} }` 就是一格函数值属性（可写、可枚举）——
       * 与 `{ m: function() {} }` 在这个值域里没有区别（差的那一格是 home object，
       * 而它只被 `super` 用到，那在 P1-f）。解析器把方法摊成 params/rest/body
       * （没有 value 那一格），所以这儿要先拼回一个函数节点。 */
      out = op('js_obj_set', [out, key, p.method
        ? this.closureExpr(fnNodeOfProp(p), p.computed ? 'method' : this.keyName(p.key, p.span))
        : this.expr(p.value)]);
    }
    return out;
  }

  unary(e) {
    switch (e.op) {
      case '!': return box(notB(truthy(this.expr(e.arg))), BOOL);
      case '-': return op('js_neg', [this.expr(e.arg)]);
      case '+': return op('js_num_of', [this.expr(e.arg)]);
      case '~': return op('js_bitnot', [this.expr(e.arg)]);
      case 'typeof': return op('js_typeof', [this.expr(e.arg)]);
      case 'delete': {
        const t = e.arg;
        if (t.type !== 'Member') {
          this.err(e.span, "'delete' needs a member expression");
          return undefExpr();
        }
        const key = t.computed ? this.expr(t.prop) : s16(t.name);
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
      case 'in': return op('js_obj_has', [B(), A()]);
      case 'instanceof': {
        /* 两条路（ADR-0020 P1-f）：
         *   - Error 与它的子类查 `$cls` 链（决策 15，那是 throw/catch 的现役机制）；
         *   - 别的走**真原型链**（js_instanceof：先问 Symbol.hasInstance，再顺着
         *     右边那个类对象的 prototype 往上找）。右边是任意表达式也行。 */
        const rhs = e.right.type === 'Ident' ? e.right.name : null;
        const isErr = rhs === 'Error' || (rhs && this.classes.get(rhs)?.isError);
        if (isErr) return op('js_is_a', [A(), s16(rhs)]);
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
      return sp === null ? undefExpr() : op('js_getp', [sp, s16(e.name)]);
    }
    const path = this.staticPath(e);
    if (path) {
      const spec = STATIC_PROPS[path];
      // lit 也要带上：well-known Symbol（Symbol.iterator …）就是"名字是编译期常量"的 op
      if (spec) return op(spec.op, [], spec.lit ?? {});
      if (path.startsWith('process.env.')) return op('js_proc_env', [s16(path.slice('process.env.'.length))]);
      /* 最长的**已注册前缀**（ADR-0020 P1-f）：`Object.prototype.toString` 就是
       * "取 Object.prototype 这一格，再取它的 toString" —— 内建原型现在是真对象，
       * 所以后半段是普通的属性读。这一条让 `X.prototype.m.call(…)` 那类写法通了。 */
      if (!e.computed && e.object.type === 'Member' && this.staticPrefix(e.object)) {
        return op('js_obj_get', [this.member(e.object), s16(e.name)]);
      }
      this.err(e.span, `'${path}' is not in the closed ABI (ADR-0011 decision 2)`);
      return undefExpr();
    }
    return this.onObject(e.object, e.optional, (obj) => this.memberOn(obj, e));
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
    if (JS_PROPS[e.name]) return op(`js_p_${e.name}`, [obj]);
    return op('js_obj_get', [obj, s16(e.name)]);
  }

  /**
   * 实参列表。函数的形参类型是 list&lt;dynamic&gt;（不是 dynamic），所以这里要的是**没装箱**
   * 的 ListLit；有展开的时候先按 dynamic 拼好，再用 asList 拆回来。
   */
  argList(args) {
    if (!args.some((a) => a.type === 'Spread')) {
      return { kind: 'ListLit', type: listType(D), items: args.map((a) => this.expr(a)) };
    }
    const parts = [];
    let run = [];
    for (const a of args) {
      if (a.type === 'Spread') {
        if (run.length) { parts.push(arrLit(run)); run = []; }
        parts.push(op('js_iter', [this.expr(a.arg)]));
        continue;
      }
      run.push(this.expr(a));
    }
    if (run.length) parts.push(arrLit(run));
    const joined = parts.reduce((a, b) => op('js_arr_concat', [a, b]));
    return { kind: 'Builtin', name: 'asList', args: [joined], type: listType(D) };
  }

  call(e) {
    if (e.optional) {
      this.err(e.span, 'optional calls (?.()) are not supported');
      return undefExpr();
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
          return op('js_call_this', [
            op('js_obj_get', [globalRef(this.globals.get(sup).name), s16(CLASS_INIT_KEY)]),
            this.readEntry(this.lookup('this')),
            box(this.argList(e.args), listType(D)),
          ]);
        }
        this.err(e.span, "'super(...)' is only available in the constructor of a derived class");
        return undefExpr();
      }
      if (!this.lookup(c.name) && !this.globals.has(c.name)) {
        if (this.topFns.has(c.name)) {
          return { kind: 'Call', func: this.topFns.get(c.name), name: c.name, args: [this.argList(e.args)], type: D };
        }
        // 原生宿主面：名字直接就是一个 ABI op（决策 17）
        const nat = this.natives.get(c.name);
        if (nat) return this.abiCall({ op: nat, argc: JS_ALL[nat].arity }, e.args, e.span, c.name);
        // 外部 C 符号（ADR-0014 决策 4）：实参个数由 C 的原型定死，不补 undefined
        const cn = this.cnatives.get(c.name);
        if (cn) return this.cCall(cn, e.args, e.span, c.name);
        const g = GLOBAL_CALLS[c.name];
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
          op('js_getp', [sp, s16(c.name)]),
          this.readEntry(this.lookup('this')),
          box(this.argList(e.args), listType(D)),
        ]);
      }
      const path = this.staticPath(c);
      if (path) {
        const spec = STATIC_CALLS[path];
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
      if (!c.computed && JS_METHODS[c.name]) return this.methodCall(c, e);
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
      if (e.args.some((a) => a.type === 'Spread')) {
        this.err(e.span, `spread is not supported in a '${name}' call`);
        return undefExpr();
      }
      if (e.args.length > argc) {
        // 不是 ABI 表里那个成员，而是用户自己的同名方法 —— 接收者照样要传（P1）。
        // recv 用两次，所以先落进临时量（理由同上面那处 js_call_this）。
        const t = this.temp();
        const f = op('js_obj_get', [assign(varRef(t), recv), s16(name)]);
        return op('js_call_this', [f, varRef(t), box(this.argList(e.args), listType(D))]);
      }
      const args = [recv];
      for (let i = 0; i < argc; i++) args.push(i < e.args.length ? this.expr(e.args[i]) : undefExpr());
      return op(`js_m_${name}`, args);
    });
  }

  abiCall(spec, args, span, what) {
    if (args.some((a) => a.type === 'Spread')) {
      this.err(span, `spread is not supported in a '${what}' call`);
      return undefExpr();
    }
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
        for (const a of args) {
          const one = op('js_str', [this.expr(a)]);
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
    for (let i = 0; i < spec.argc; i++) lowered.push(i < args.length ? this.expr(args[i]) : undefExpr());
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
    if (!['replace', 'match', 'split'].includes(c.name)) return null;
    const re = e.args.length ? this.regexOf(e.args[0]) : null;
    if (!re) {
      if (c.name === 'split') return null;   // 字符串分隔符那一支走 js_m_split
      this.err(e.span, `'${c.name}' needs a regex literal as its first argument`);
      return undefExpr();
    }
    const recv = this.expr(c.object);
    const name = { replace: 'js_re_replace', match: 'js_re_match', split: 'js_re_split' }[c.name];
    if (c.name === 'match') return op(name, [s16(re.body), s16(re.flags), recv]);
    return op(name, [s16(re.body), s16(re.flags), recv, arg(1)]);
  }

  newExpr(e) {
    const n = e.callee.type === 'Ident' ? e.callee.name : null;
    if ((n === 'Map' || n === 'Set') && !this.lookup(n)) {
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
      return op('js_buf_view', [as[0], as[1] ?? undefExpr(), as[2] ?? undefExpr()]);
    }
    // new Error(msg)：异常对象就是 { $cls: ["Error"], message }（决策 15）
    if (n === 'Error' && !this.lookup(n) && !this.classes.has(n)) {
      const msg = e.args.length ? this.expr(e.args[0]) : s16('');
      return op('js_err_new', [msg, arrLit([s16('Error')])]);
    }
    // 类的构造：Error 子类走老路（造实例的函数），别的走原型链那条新路（P1-f）
    if (n && this.classes.has(n) && !this.lookup(n)) {
      const rec = this.classes.get(n);
      if (rec.isError) {
        return { kind: 'Call', func: rec.mangled, name: n, args: [this.argList(e.args)], type: D };
      }
      /* 分配一格以类原型为原型的对象，再拿它当**接收者**跑 $init。摊成两句（emitPre）
       * 而不是一个表达式：临时量要用三次（造、当接收者、当结果）。 */
      const t = this.temp();
      this.emitPre(exprStmt(assign(varRef(t),
        op('js_obj_new_p', [globalRef(this.globals.get(protoGlobalName(n)).name)]))), e.span);
      this.emitPre(exprStmt(op('js_call_this', [
        op('js_obj_get', [globalRef(this.globals.get(n).name), s16(CLASS_INIT_KEY)]),
        varRef(t),
        box(this.argList(e.args), listType(D)),
      ])), e.span);
      return varRef(t);
    }
    this.err(e.span, `'new ${n ?? '<expr>'}' is not supported; only Array, Map, Set, Error and classes declared in this file`);
    return undefExpr();
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
      let key = () => s16(node.name);
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

  assignExpr(e) {
    const t = e.target;
    if (e.op === '=') {
      if (t.type === 'ArrayPattern' || t.type === 'ObjectPattern') {
        this.err(e.span, 'destructuring assignment without a declaration is not supported');
        return undefExpr();
      }
      // 简单赋值不需要临时量：接收者只算一次
      if (t.type === 'Member') {
        const path = this.staticPath(t);
        if (path) {
          const spec = STATIC_SETS[path];
          if (!spec) { this.err(e.span, `cannot assign to '${path}'`); return undefExpr(); }
          return op(spec.op, [this.expr(e.value)]);
        }
        const key = t.computed ? this.expr(t.prop) : s16(t.name);
        return op('js_idx_set', [this.expr(t.object), key, this.expr(e.value)]);
      }
      const lv = this.lvalue(t, e.span);
      return lv ? lv.set(this.expr(e.value)) : undefExpr();
    }
    const lv = this.lvalue(t, e.span);
    if (!lv) return undefExpr();
    if (e.op === '&&=') return ternary(truthy(lv.get()), this.lazy(() => lv.set(this.expr(e.value))), lv.get());
    if (e.op === '||=') return ternary(truthy(lv.get()), lv.get(), this.lazy(() => lv.set(this.expr(e.value))));
    if (e.op === '??=') {
      return ternary(boolOp('js_eq', [lv.get(), nullExpr()], { strict: false }),
        this.lazy(() => lv.set(this.expr(e.value))), lv.get());
    }
    return lv.set(this.applyOp(e.op.slice(0, -1), lv.get(), this.expr(e.value), e.span));
  }

  /** ++ / --：只对 number 有意义（js_arith 不许 bigint 与 number 混用） */
  update(e, discard) {
    const lv = this.lvalue(e.arg, e.span);
    if (!lv) return undefExpr();
    // '+' 不在 js_arith 里（字符串拼接与加法是同一个 op），所以自增走 js_add
    const bump = (x) => (e.op === '++'
      ? op('js_add', [x, constReal(1)])
      : op('js_arith', [x, constReal(1)], { op: '-' }));
    if (discard || e.prefix) return lv.set(bump(lv.get()));
    // 后缀的值是**旧的**，所以先存一份再写回
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
  'Symbol', 'Reflect']);

const STATIC_CALLS = {
  'JSON.stringify': { op: 'js_json_stringify', argc: 3 },
  // parse 只收一个实参（没有 reviver）：量过，仓库里 JSON.parse 全是一个实参
  'JSON.parse': { op: 'js_json_parse', argc: 1 },
  'Math.abs': { op: 'js_math', argc: 2, lit: { op: 'a' } },
  'Math.trunc': { op: 'js_math', argc: 2, lit: { op: 't' } },
  'Math.floor': { op: 'js_math', argc: 2, lit: { op: 'f' } },
  'Math.ceil': { op: 'js_math', argc: 2, lit: { op: 'c' } },
  'Math.max': { op: 'js_math', argc: 2, lit: { op: 'M' } },
  'Math.min': { op: 'js_math', argc: 2, lit: { op: 'm' } },
  // fround（ADR-0017 第一刀）：MIR 的 f32 语义就是"按 double 算完再舍一次到单精度"，
  // 而闭包解释器要在**我们自己编出来的**编译器里也这么算 —— 所以它必须进封闭 ABI。
  'Math.fround': { op: 'js_math', argc: 2, lit: { op: 'F' } },
  // pow 与 `**` 是同一件事（规范里两者都是 ToNumber 之后求幂），所以它就是那条算术 op
  'Math.pow': { op: 'js_arith', argc: 2, lit: { op: 'p' } },
  // imul 是**32 位乘法**，不是 `Math.*` 那一族：它属于 i32 那三条 op（ADR-0013 第三刀）。
  // `a * b` 先在 double 里丢精度，再折回 i32 已经错了 —— 这正是 `js_i32_op` 的 '*' 那一格。
  'Math.imul': { op: 'js_i32_op', argc: 2, pre: ['*'] },
  'Object.keys': { op: 'js_obj_keys', argc: 1 },
  'Object.values': { op: 'js_obj_values', argc: 1 },
  'Object.entries': { op: 'js_obj_entries', argc: 1 },
  'Object.assign': { op: 'js_obj_assign', argc: 2 },
  /* ---- 真对象那一族（ADR-0020 P1）。`hasOwn` 从前接的是 js_obj_has，而那一条现在
     沿原型链走（`in` 的语义）—— 自有属性得问 js_obj_has_own，不然继承来的键也算"自有"。 */
  'Object.hasOwn': { op: 'js_obj_has_own', argc: 2 },
  'Object.create': { op: 'js_obj_new_p', argc: 1 },
  'Object.getPrototypeOf': { op: 'js_obj_proto_get', argc: 1 },
  'Object.setPrototypeOf': { op: 'js_obj_proto_set', argc: 2 },
  'Object.defineProperty': { op: 'js_obj_def', argc: 3 },
  'Object.getOwnPropertyDescriptor': { op: 'js_obj_desc', argc: 2 },
  'Object.getOwnPropertyNames': { op: 'js_obj_own_keys', argc: 1, lit: { kind: 's' } },
  'Object.getOwnPropertySymbols': { op: 'js_obj_own_keys', argc: 1, lit: { kind: 'y' } },
  'Object.freeze': { op: 'js_obj_freeze', argc: 1 },
  'Object.seal': { op: 'js_obj_seal', argc: 1 },
  'Object.preventExtensions': { op: 'js_obj_prevent_ext', argc: 1 },
  'Object.isFrozen': { op: 'js_obj_is_frozen', argc: 1 },
  'Object.isSealed': { op: 'js_obj_is_sealed', argc: 1 },
  'Object.isExtensible': { op: 'js_obj_is_ext', argc: 1 },
  'Symbol.for': { op: 'js_sym_for', argc: 1 },
  'Symbol.keyFor': { op: 'js_sym_key_for', argc: 1 },
  'Reflect.getPrototypeOf': { op: 'js_obj_proto_get', argc: 1 },
  'Reflect.setPrototypeOf': { op: 'js_obj_proto_set', argc: 2 },
  'Reflect.defineProperty': { op: 'js_obj_def', argc: 3 },
  'Reflect.getOwnPropertyDescriptor': { op: 'js_obj_desc', argc: 2 },
  'Reflect.ownKeys': { op: 'js_obj_own_keys', argc: 1, lit: { kind: 'a' } },
  'Reflect.has': { op: 'js_obj_has_p', argc: 2 },
  'Reflect.get': { op: 'js_getp', argc: 2 },
  'Reflect.set': { op: 'js_setp', argc: 3 },
  'Reflect.deleteProperty': { op: 'js_obj_del_p', argc: 2 },
  'Reflect.isExtensible': { op: 'js_obj_is_ext', argc: 1 },
  'Reflect.preventExtensions': { op: 'js_obj_prevent_ext', argc: 1 },
  'Array.isArray': { op: 'js_arr_is_array', argc: 1 },
  'Array.from': { op: 'js_arr_from', argc: 1 },
  'String.fromCharCode': { op: 'js_str_of_char_code', argc: 1, fold: 'js_add' },
  'String.fromCodePoint': { op: 'js_str_of_code_point', argc: 1 },
  'Number.isNaN': { op: 'js_num_is_nan', argc: 1 },
  'Number.isFinite': { op: 'js_num_is_finite', argc: 1 },
  'Number.isInteger': { op: 'js_num_is_integer', argc: 1 },
  'Number.parseInt': { op: 'js_num_parse_int', argc: 2 },
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
  'Symbol.iterator': { op: 'js_sym_wk', lit: { name: 'iterator' } },
  'Symbol.asyncIterator': { op: 'js_sym_wk', lit: { name: 'asyncIterator' } },
  'Symbol.toPrimitive': { op: 'js_sym_wk', lit: { name: 'toPrimitive' } },
  'Symbol.toStringTag': { op: 'js_sym_wk', lit: { name: 'toStringTag' } },
  'Symbol.hasInstance': { op: 'js_sym_wk', lit: { name: 'hasInstance' } },
  'Symbol.species': { op: 'js_sym_wk', lit: { name: 'species' } },
  'Symbol.unscopables': { op: 'js_sym_wk', lit: { name: 'unscopables' } },
  /* 内建原型当值用（ADR-0020 P1-f）：它们现在是真对象，内建方法就住在上面。
     于是 `Object.prototype.toString.call(x)`、`Array.prototype.join.call(a, "|")`
     这类"借方法"的写法通了 —— 后半段是普通的属性读 + 带接收者的调用。 */
  'Object.prototype': { op: 'js_realm_proto', lit: { name: 'Object' } },
  'Function.prototype': { op: 'js_realm_proto', lit: { name: 'Function' } },
  'Array.prototype': { op: 'js_realm_proto', lit: { name: 'Array' } },
  'String.prototype': { op: 'js_realm_proto', lit: { name: 'String' } },
  'Number.prototype': { op: 'js_realm_proto', lit: { name: 'Number' } },
  'Boolean.prototype': { op: 'js_realm_proto', lit: { name: 'Boolean' } },
  'Symbol.prototype': { op: 'js_realm_proto', lit: { name: 'Symbol' } },
  'RegExp.prototype': { op: 'js_realm_proto', lit: { name: 'RegExp' } },
  'Map.prototype': { op: 'js_realm_proto', lit: { name: 'Map' } },
  'Set.prototype': { op: 'js_realm_proto', lit: { name: 'Set' } },
};

const STATIC_SETS = {
  'process.exitCode': { op: 'js_proc_exit_code' },
};

const GLOBAL_CALLS = {
  String: { op: 'js_str', argc: 1 },
  Number: { op: 'js_num_of', argc: 1 },
  BigInt: { op: 'js_bigint_of', argc: 1 },
  parseInt: { op: 'js_num_parse_int', argc: 2 },
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

  /** 一批（parser.js 的 Program） -> 这一批新增的 OIR。诊断按批传进来。 */
  add(program, diags) {
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
    L.fn = L.newFrame(program.body, { isMain: true });
    const stmts = [];
    for (const s of program.body) {
      if (s.type === 'FuncDecl') continue;
      stmts.push(...L.stmt(s));
    }
    const main = {
      name: entry, mangled: entry, ret: { k: 'void' }, params: [],
      body: block([...L.fn.prelude, ...stmts]),
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

