// ext/cpp/adapter/expr.js —— **C++ 的树 → 标准 IR 的表达式**（ADR-0044）
//
// 这一门的类型是**写着的**（`int` / `double` / `Point` / `std::map<std::string,int>`），
// 所以类型那半笔账是照抄；`auto` 那一格从初值取。C++ 自己的几处在这一份里：
//   * `printf("%d\n", x)` / `puts(s)` —— 落成方言的 `print`（一格值一行，见 `printArgs`）；
//   * `(int)e` 与 `static_cast<double>(e)` 是转换（`toint` / `toreal`）；
//   * `m["a"]` 既可能是数组下标也可能是字典的键 —— 按**声明的类型**分；
//   * `m.count(k)` 是"在不在"、`std::make_pair(a,b)` 是一格两格值的记录（字段叫
//     `first` / `second`，那是 C++ 自己的名字）。

import { tag, kids, leaf, part, unquote } from '../../../src/core/lower/cst.js';
import { cUnescape, fmtToIR, fmtToStmts } from '../../../src/core/lower/fmt.js';
import {
  INT, REAL, STR, BOOL, arrOf, dictOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';

/**
 * 算子 → **重载后的方法名**（与 `index.js` 的 `OP_NAMES` 是同一张表的两头）。
 * 只有接收者装的是**用户类**、且那个类真写了这一格 `operator@` 时才改写；
 * 别的（int / double / 串）照旧走内建 —— 内建不许被抢。
 */
const OP_MAP = new Map([
  ['+', 'op_add'], ['-', 'op_sub'], ['*', 'op_mul'], ['/', 'op_div'], ['%', 'op_mod'],
  ['==', 'op_eq'], ['!=', 'op_neq'],
  ['<', 'op_lt'], ['>', 'op_gt'], ['<=', 'op_le'], ['>=', 'op_ge'],
]);

const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='],
  ['&&', '&&'], ['||', '||'], ['&', '&'], ['|', '|'], ['<<', '<<'], ['>>', '>>'], ['^', '^'],
]);

/** 基本类型名 → 标准 IR 的类型。 */
const BTYPES = new Map([
  ['int', INT], ['long', INT], ['short', INT], ['unsigned', INT], ['size_t', INT],
  ['char', INT], ['bool', BOOL], ['double', REAL], ['float', REAL], ['void', { kind: 'void' }],
]);

export const nameOf = (x) => (tag(x) === 'n' ? String(leaf(kids(x)[0])) : String(leaf(x)));
export const tyArg = (type) => ({ kind: 'type', type });
/** 虚方法的**分派函数**叫什么（`Shape__v_area`）。 */
export const vcallName = (root, m) => `${root}__v_${m}`;

/**
 * `(specs …)` → 标准 IR 的类型。认得的形状：
 *   `(btype int)` · `(n myint)`（别名或记录）· `(auto)` · `(qual (n std) …)` ·
 *   `(qual (n std) (tid (n map) (targs …)))`（字典）· `const` / `typedef` 那些修饰跳过。
 */
export function typeOfSpecs(specs, C, declTok) {
  if (specs === undefined) return INT;
  const parts = kids(specs).filter((y) => {
    const t = tag(y);
    if (t === null) {
      const w = String(leaf(y));
      return w !== 'const' && w !== 'static' && w !== 'typedef' && w !== 'virtual';
    }
    return true;
  });
  /* `char *` / `const char *` → 串（C 里串就是 `char*`）。 */
  const isPtr = declTok !== undefined && tag(declTok) === 'ptr';
  for (const p of parts) {
    if (tag(p) === 'btype') {
      const n = String(leaf(kids(p)[0]));
      if (n === 'char' && isPtr) return STR;
      const t = BTYPES.get(n);
      if (t !== undefined) return t;
      throw new Error(`cpp->IR: 这个基本类型还没接：${n}`);
    }
    if (tag(p) === 'auto') return null;            // 从初值取
    if (tag(p) === 'n') {
      const n = nameOf(p);
      if (C.aliases.has(n)) return C.aliases.get(n);
      if (C.records.has(n)) return C.recType(n);
      throw new Error(`cpp->IR: 这个类型名还没接：${n}`);
    }
    if (tag(p) === 'qual') return qualType(p, C);
    /* **类模板的用点**：`Box<int>` → 一格叫 `Box__int` 的普通记录（第一次要到才造）。 */
    if (tag(p) === 'tid') {
      const base = nameOf(kids(p)[0]);
      if (!C.ctemplates.has(base)) {
        throw new Error(`cpp->IR: \`${base}<…>\` 不是登记过的类模板`);
      }
      return C.instClass(base, targTypes(p, C));
    }
    if (tag(p) === 'class' || tag(p) === 'elaborated') {
      const nm = kids(p).find((y) => tag(y) === 'n');
      if (nm !== undefined && C.records.has(nameOf(nm))) return C.recType(nameOf(nm));
      return null;
    }
  }
  return INT;
}

/**
 * 一格 `(params (p (specs …) (n x)) …)` → `[{ name, type }]`。
 * 函数、方法、构造函数、**lambda** 四处共用这一份（名字那一格可能裹在 `ptr` / `array` 里）。
 */
export function readParams(paramsTok, C) {
  const ps = paramsTok === undefined ? [] : kids(paramsTok).filter((y) => tag(y) === 'p');
  return ps.map((p) => {
    const pn = kids(p).find((y) => tag(y) === 'n' || tag(y) === 'ptr' || tag(y) === 'array');
    const pname = pn === undefined ? 'x' : nameOf(tag(pn) === 'n' ? pn : kids(pn)[kids(pn).length - 1]);
    return { name: C.ref(pname), type: typeOfSpecs(part(p, 'specs'), C, pn) ?? INT };
  });
}

/** `(targs (type (specs …)) …)` → 那几格实参类型。 */function targTypes(tid, C) {
  const targs = part(tid, 'targs');
  return (targs === undefined ? [] : kids(targs))
    .map((a) => typeOfSpecs(part(a, 'specs') ?? kids(a)[0], C) ?? INT);
}

/** `std::map<std::string, int>` / `std::string` / `std::vector<int>`。 */
function qualType(q, C) {
  const last = kids(q)[kids(q).length - 1];
  if (tag(last) === 'n') {
    const n = nameOf(last);
    if (n === 'string') return STR;
    throw new Error(`cpp->IR: 这个 std:: 类型还没接：${n}`);
  }
  if (tag(last) === 'tid') {
    const base = nameOf(kids(last)[0]);
    const targs = part(last, 'targs');
    const args = targs === undefined ? [] : kids(targs)
      .map((a) => typeOfSpecs(part(a, 'specs') ?? kids(a)[0], C));
    if (base === 'map' || base === 'unordered_map') return dictOf(args[1] ?? INT);
    if (base === 'vector') return arrOf(args[0] ?? INT);
    if (base === 'pair') return C.mvType([args[0] ?? INT, args[1] ?? INT], ['first', 'second']);
    throw new Error(`cpp->IR: 这个模板类型还没接：${base}`);
  }
  throw new Error('cpp->IR: 这一格 qual 类型还没接');
}

/** 一格二元：数值那一格要自己补转换。 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
  return { kind: 'binop', op, left: l, right: r };
}

/** 一格表达式。 */
export function exprOf(x, C) {
  switch (tag(x)) {
    case 'num': {
      const t = String(leaf(kids(x)[0]));
      const v = Number(t);
      return (t.includes('.') || /[eE]/.test(t))
        ? { kind: 'real', value: v } : { kind: 'int', value: v };
    }
    case 'str': return { kind: 'string', value: unquote(leaf(kids(x)[0])) };
    /* 树上的布尔字面量有两种形状：`(true)` / `(false)`，与"当成一格名字读"（见 `case 'n'`）。 */
    case 'true': return { kind: 'bool', value: true };
    case 'false': return { kind: 'bool', value: false };
    case 'n': {
      const n = nameOf(x);
      if (n === 'true') return { kind: 'bool', value: true };
      if (n === 'false') return { kind: 'bool', value: false };
      /**
       * **方法体里裸写的字段名就是 `this->` 那一格**（C++ 的隐式成员访问）：
       * `int sum() { return a + b; }` 里的 a、b 不是局部量，是接收者的字段。
       * 顺序是硬的：**局部量与形参先查**（同名的局部量遮住字段，C++ 就是这么定的）。
       */
      const flat = C.ref(n);
      /**
       * **lambda 体里借走的那几格量**落成 `(cap …)`：那一层的作用域栈是换空过的
       * （见 index.js 的 `C.lambda`），所以"环境里没有、捕获表里有"就是一格捕获。
       */
      if (C.tyCtx().env.get(flat) === undefined && C.capNames.has(flat)) {
        return { kind: 'capture', name: flat, type: C.capNames.get(flat) };
      }
      if (C.self !== null && C.tyCtx().env.get(flat) === undefined
        && (C.tyCtx().fields.get(C.self) ?? []).some((f) => f.name === n)) {
        return { kind: 'field', obj: { kind: 'name', name: 'this' }, name: n };
      }
      return { kind: 'name', name: flat };
    }
    case 'paren': case 'expr': return exprOf(kids(x)[0], C);
    case 'this': return { kind: 'name', name: 'this' };
    /**
     * `&x` —— **记录本来就是引用**（方言的 `(class …)`），所以取地址就是那格值自己。
     * 标量上的 `&` 当场报：那要真指针，这条腿上没有。
     */
    case 'addrof': {
      const v = exprOf(kids(x)[0], C);
      const t = typeOf(v, C.tyCtx());
      if (t.kind !== 'named' && t.kind !== 'arr' && t.kind !== 'map') {
        throw new Error(`cpp->IR: \`&\` 用在 ${t.kind} 上还没接（记录/列表/字典本来就是引用）`);
      }
      return v;
    }
    /* `p.x` 与 `this->tag` —— 同一格字段。 */
    case 'dot': case 'arrow':
      return { kind: 'field', obj: exprOf(kids(x)[0], C), name: nameOf(kids(x)[1]) };
    case 'bin': {
      const [op, a, b] = kids(x);
      const o = OPS.get(String(leaf(op)));
      if (o === undefined) throw new Error(`cpp->IR: 这个算子还没接：${leaf(op)}`);
      const la = exprOf(a, C);
      const lb = exprOf(b, C);
      /* 接收者装的是用户类、且那个类写了这一格 `operator@` —— 落成方法调用。 */
      const opn = OP_MAP.get(o);
      const lt = typeOf(la, C.tyCtx());
      if (opn !== undefined && lt.kind === 'named' && C.fns.has(`${lt.name}_${opn}`)) {
        return {
          kind: 'call',
          fn: { kind: 'name', name: `${lt.name}_${opn}` },
          args: [la, lb],
        };
      }
      return mkBin(o, la, lb, C);
    }
    case 'un': {
      const [op, a] = kids(x);
      const o = String(leaf(op));
      if (o === '!') return { kind: 'unop', op: '!', operand: condOf(a, C) };
      return { kind: 'unop', op: o, operand: exprOf(a, C) };
    }
    /* `xs[0]` / `m["a"]` —— 按声明的类型分（数组的下标 vs 字典的键）。 */
    case 'index': {
      const obj = exprOf(kids(x)[0], C);
      const key = exprOf(kids(x)[1], C);
      const t = typeOf(obj, C.tyCtx());
      /* 用户类上的 `operator[]`。 */
      if (t.kind === 'named' && C.fns.has(`${t.name}_op_index`)) {
        return {
          kind: 'call',
          fn: { kind: 'name', name: `${t.name}_op_index` },
          args: [obj, key],
        };
      }
      if (t.kind === 'map') return { kind: 'builtin', name: 'dget', args: [obj, key] };
      return { kind: 'index', obj, index: key };
    }
    /* `c ? a : b` —— 公共层的 if-expr 那一格。 */
    case 'cond': {
      const [c, a, b] = kids(x);
      return {
        kind: 'if-expr', type: null, cond: condOf(c, C), then: exprOf(a, C), else_: exprOf(b, C),
      };
    }
    /* `(int)e` 与 `static_cast<double>(e)`。 */
    case 'cast': case 'named-cast': {
      const tyTok = kids(x).find((y) => tag(y) === 'type');
      const target = typeOfSpecs(part(tyTok, 'specs') ?? kids(tyTok)[0], C);
      const v = exprOf(kids(x)[kids(x).length - 1], C);
      const t = typeOf(v, C.tyCtx());
      if (target !== null && target.kind === 'int') {
        return t.kind === 'int' ? v : { kind: 'builtin', name: 'toint', args: [v] };
      }
      if (target !== null && target.kind === 'real') {
        return t.kind === 'real' ? v : { kind: 'builtin', name: 'toreal', args: [v] };
      }
      return v;
    }
    case 'call': return callOf(x, C);
    /* `[捕获](形参){ 体 }` —— 落成公共层现成的闭包（真正那一趟在 index.js 的 `C.lambda`）。 */
    case 'lambda': return C.lambda(x);
    case 'qual': {
      /* `std::something` 当值用（这一批只有 `std::make_pair` 那一处，在 callOf 里）。 */
      throw new Error(`cpp->IR: \`${kids(x).map((k) => (tag(k) === 'n' ? nameOf(k) : '?')).join('::')}\` 当值用还没接`);
    }
    default:
      throw new Error(`cpp->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** 一格调用。 */
function callOf(x, C) {
  const fn = kids(x)[0];
  const argsTok = part(x, 'args');
  const rawArgs = argsTok === undefined ? [] : kids(argsTok);
  /* `m.count(k)` —— 字典里有没有这个键。 */
  if (tag(fn) === 'dot' || tag(fn) === 'arrow') {
    const obj = exprOf(kids(fn)[0], C);
    const m = nameOf(kids(fn)[1]);
    const t = typeOf(obj, C.tyCtx());
    if (m === 'count' && t.kind === 'map') {
      return { kind: 'builtin', name: 'dhas', args: [obj, exprOf(rawArgs[0], C)] };
    }
    if (m === 'size') {
      return { kind: 'builtin', name: t.kind === 'map' ? 'dlen' : (t.kind === 'string' ? 'slen' : 'alen'), args: [obj] };
    }
    if (m === 'push_back' && t.kind === 'arr') {
      return { kind: 'builtin', name: 'apush', args: [obj, exprOf(rawArgs[0], C)] };
    }
    /**
     * **用户类上的方法**：`p.total()` → `(call Point_total (var p) …)`。
     * 分派是**单态的**（接收者的静态类型定哪一份）—— 虚函数是另一格（还没接）。
     * 继承来的那几格在第一遍里就按派生类的名字登记过了（见 `index.js` 的 `flatten`），
     * 所以这儿只查一次，不用往基类走。
     */
    if (t.kind === 'named') {
      const as = rawArgs.map((a) => exprOf(a, C));
      /**
       * **虚方法走分派函数**（`Shape__v_area(obj)`）—— 按对象自己的 `__vt` 走 if 链。
       * 为什么连 `q.area()`（静态类型就是派生类）也走：那格对象的真身可能是**更派生的**
       * 一层，静态类型定不了。分派函数在任何一格上都给对的那一份，所以只留这一条路。
       */
      const tab = C.vtab.get(t.name);
      if (tab !== undefined && tab.has(m)) {
        return {
          kind: 'call',
          fn: { kind: 'name', name: vcallName(t.name, C.ref(m)) },
          args: [obj, ...as],
        };
      }
      /**
       * 非虚方法按**静态类型**（`t.cls`）单态分派 —— C++ 的隐藏规则。
       * 三档，与 `methodName` 那三档反过来：先试"按实参**类型**挑"（有两份个数一样的
       * 那几个名字才在表里），再试"带实参个数"那个名字，最后是老名字（见 `pickMethod`）。
       */
      const hitT = C.pickMethodT(t.cls ?? t.name, m, as.map((a) => typeOf(a, C.tyCtx())));
      if (hitT !== null) {
        return {
          kind: 'call',
          fn: { kind: 'name', name: hitT.name },
          args: [obj, ...as.map((a, i) => coerce(a, hitT.params[i].type, C))],
        };
      }
      const target = C.pickMethod(t.cls ?? t.name, m, rawArgs.length);
      if (target !== null) {
        return {
          kind: 'call',
          fn: { kind: 'name', name: target },
          args: [obj, ...as],
        };
      }
    }
    throw new Error(`cpp->IR: \`.${m}()\` 这一格方法还没接`
      + `（接收者装的是 ${t.name ?? t.kind}）`);
  }
  /* `std::make_pair(a, b)` —— 一格两格值的记录（字段叫 first / second）。 */
  if (tag(fn) === 'qual') {
    const nm = nameOf(kids(fn)[kids(fn).length - 1]);
    const args = rawArgs.map((a) => exprOf(a, C));
    if (nm === 'make_pair') {
      const ty = C.mvType(args.map((a) => typeOf(a, C.tyCtx())), ['first', 'second']);
      return {
        kind: 'new-record',
        type: ty,
        ref: false,
        fields: [{ name: 'first', value: args[0] }, { name: 'second', value: args[1] }],
      };
    }
    throw new Error(`cpp->IR: \`std::${nm}()\` 还没接`);
  }
  /**
   * **显式写出模板实参**：`maxOf<double>(4.0, 2.5)` → `(tid (n maxOf) (targs (type …)))`。
   * 这一格不看实参的类型，看写着的那个（`4.0` 是 int 字面量时也照 double 走）。
   */
  if (tag(fn) === 'tid') {
    const nm = nameOf(kids(fn)[0]);
    if (!C.templates.has(nm)) throw new Error(`cpp->IR: \`${nm}<…>\` 不是登记过的模板`);
    const inst = C.instantiate(nm, targTypes(fn, C));
    return {
      kind: 'call',
      fn: { kind: 'name', name: inst },
      args: rawArgs.map((a) => exprOf(a, C)),
    };
  }
  const name = nameOf(fn);
  const args = rawArgs.map((a) => exprOf(a, C));
  if (name === 'printf' || name === 'puts') {
    throw new Error(`cpp->IR: \`${name}\` 在表达式位置上（它不交值）`);
  }
  /**
   * **方法体里裸写的调用就是 `this->` 那一格**（与裸写字段名同一条规矩）：
   * `int total() { return sum() + c; }` 里的 `sum()` 是成员。
   * 类里有同名成员时裸写的一定是成员（自由函数要写 `::f()` 才轮到它）。
   */
  /**
   * 裸写的**虚**方法走分派函数（`describe()` 里的 `area()`）。这一格要排在
   * "有没有这个名字的方法"**之前** —— 纯虚那一格根上根本没有体，按名字找是找不着的。
   */
  if (C.self !== null) {
    const root = C.storageRef.get(C.self) ?? C.self;
    const tab = C.vtab.get(root);
    if (tab !== undefined && tab.has(name)) {
      return {
        kind: 'call',
        fn: { kind: 'name', name: vcallName(root, C.ref(name)) },
        args: [{ kind: 'name', name: 'this' }, ...args],
      };
    }
  }
  /* 裸写的成员也走那三档（先按类型，再按个数 / 老名字）。 */
  const selfT = C.self === null ? null
    : C.pickMethodT(C.self, name, args.map((a) => typeOf(a, C.tyCtx())));
  if (selfT !== null) {
    return {
      kind: 'call',
      fn: { kind: 'name', name: selfT.name },
      args: [{ kind: 'name', name: 'this' }, ...args.map((a, i) => coerce(a, selfT.params[i].type, C))],
    };
  }
  const selfPick = C.self === null ? null : C.pickMethod(C.self, name, args.length);
  if (selfPick !== null) {
    return {
      kind: 'call',
      fn: { kind: 'name', name: selfPick },
      args: [{ kind: 'name', name: 'this' }, ...args],
    };
  }
  /* `Point(1, 2)` —— **函数式的构造**（与 `Point p(1,2)` 落同一格调用，按实参个数挑）。 */
  if (C.records.has(name)) {
    const hitT = C.pickCtor(C.ref(name), args.map((a) => typeOf(a, C.tyCtx())));
    if (hitT !== null) {
      return {
        kind: 'call',
        fn: { kind: 'name', name: hitT.name },
        args: args.map((a, i) => coerce(a, hitT.params[i].type, C)),
      };
    }
    const pick = `${C.ref(name)}__ctor${args.length}`;
    if (C.fns.has(pick)) return { kind: 'call', fn: { kind: 'name', name: pick }, args };
    if ([...C.fns.keys()].some((k) => k.startsWith(`${C.ref(name)}__ctor`))) {
      throw new Error(`cpp->IR: ${name} 没有收 ${args.length} 个实参的构造函数`);
    }
  }
  /* **模板的调用**（推出类型形参 → 单态化 → 落成一格普通调用）。 */
  if (C.templates.has(name)) {
    const inst = C.instantiate(name, C.deduce(name, args.map((a) => typeOf(a, C.tyCtx()))));
    return { kind: 'call', fn: { kind: 'name', name: inst }, args };
  }
  /* **局部量或捕获里装着函数** —— 通过值调（`(callfn v …)`）。 */
  const fv = C.tyCtx().env.get(C.ref(name)) ?? C.capNames.get(C.ref(name));
  if (fv !== undefined && fv.kind === 'fn-type') {
    return { kind: 'call-value', fn: exprOf(fn, C), args };
  }
  /**
   * **重载了的自由函数**：按实参类型挑那一份（`twice__int` / `twice__real`），
   * 再照挑中那份的形参给实参补转换 —— 方言是严的，拿 int 去喂 real 形参会当场报。
   * 没重载的名字不进这张表，所以这一格对别的家族是逐字节中性的。
   */
  if (C.ovlFns.has(C.ref(name))) {
    const hit = C.pickFn(C.ref(name), args.map((a) => typeOf(a, C.tyCtx())));
    return {
      kind: 'call',
      fn: { kind: 'name', name: hit.name },
      args: args.map((a, i) => coerce(a, hit.params[i].type, C)),
    };
  }
  return { kind: 'call', fn: { kind: 'name', name: C.ref(name) }, args };
}

/** 一格实参往形参的类型上凑（这条腿只认 `int -> real` 与 `bool -> int` 两格提升）。 */
export function coerce(a, want, C) {
  const got = typeOf(a, C.tyCtx());
  if (want.kind === 'real' && got.kind === 'int') {
    return { kind: 'builtin', name: 'toreal', args: [a] };
  }
  if (want.kind === 'int' && got.kind === 'bool') {
    return {
      kind: 'if-expr', type: INT, cond: a, then: { kind: 'int', value: 1 }, else_: { kind: 'int', value: 0 },
    };
  }
  return a;
}

/**
 * `printf(格式, 实参…)` / `puts(串)` → 几行 `print` / `write`。
 *
 * 格式那一层**走公共层那一份**（`src/core/lower/fmt.js` 的 `fmtToStmts` —— 与 jancy 的
 * `printf` 共用同一张转换表、同一个 `readSpec`）：按 `\n` 切段，带换行的段发 `print`
 * （它自带换行），末段没有换行时发 `write`。所以 `printf("abc")` 与多行格式串都成立。
 *
 * 这一份自己只管两样：解转义、以及 **bool 按 `%d` 印成 1 / 0**（C++ 的规矩，不是 true / false）。
 */
export function printArgs(name, rawArgs, C) {
  if (name === 'puts') {
    return [{ kind: 'print', values: [exprOf(rawArgs[0], C)] }];
  }
  const fmtTok = rawArgs[0];
  if (fmtTok === undefined || tag(fmtTok) !== 'str') {
    throw new Error('cpp->IR: printf 的格式串不是字面量 —— 那要运行期的格式化（还没接）');
  }
  const fmt = cUnescape(unquote(leaf(kids(fmtTok)[0])));
  /* `printf("%d\n", x == y)`：C++ 里 bool 按 `%d` 印的是 1 / 0。方言的 `toint` 只吃 real，
     所以这一格在交给公共层**之前**用三目摊成 int。 */
  const args = rawArgs.slice(1).map((a) => {
    const v = exprOf(a, C);
    if (typeOf(v, C.tyCtx()).kind !== 'bool') return v;
    return {
      kind: 'if-expr', type: INT, cond: v, then: { kind: 'int', value: 1 }, else_: { kind: 'int', value: 0 },
    };
  });
  return fmtToStmts(fmt, args, C.tyCtx(), 'cpp->IR', C.fresh);
}

/** 条件位置上的那一格（C++ 里"非零为真"）。 */
export function condOf(x, C) {
  /* 字面量在这儿就定下来（`while (1)`）。 */
  if (tag(x) === 'num') return { kind: 'bool', value: Number(leaf(kids(x)[0])) !== 0 };
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  if (t.kind === 'int') return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  throw new Error(`cpp->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}
