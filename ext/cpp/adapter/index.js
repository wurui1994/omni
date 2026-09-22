// ext/cpp/adapter/index.js —— **C++ → 标准 IR**（ADR-0044 第二片第六门）
//
// 替掉 `ext/cpp/tograph.js`（534 行）。这一门的要点：
//   1. **类型是写着的**（`int` / `double` / `Point` / `std::map<std::string,int>`），`auto` 从初值取；
//   2. **`~Say()` 是出作用域跑一段**（RAII）—— 与 freebasic 的析构同一手：adapter 在每个
//      出口按逆序补一遍调用（公共层还没有真正的作用域出口）；
//   3. `#include` / `namespace` / `template` 的前向声明**丢掉**（这一门不做预处理，
//      例子里那几行是为了让语法认得 `std::map` 这类名字）；
//   4. 入口是 `int main()` —— 公共降级器看见名叫 `main` 的函数就发 `(main (expr (call main)))`。

import { tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import { INT, arrOf, named, typeOf } from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfSpecs, printArgs, nameOf, tyArg,
} from './expr.js';

/** 析构函数的名字。 */
const dtorName = (ty) => `__destruct_${String(ty).replace(/[^A-Za-z0-9_]/g, '_')}`;

/** 一棵 cpp 的树（`(unit …)`）→ 标准 IR 的模块。 */
export function cppToIR(tree) {
  if (tag(tree) !== 'unit') throw new Error('cpp->IR: 这不是 (unit …)');

  let tmpN = 0;
  const names = new Map();
  const scopes = [new Map()];
  const recFields = new Map();
  const mvs = new Map();
  const decls = [];
  const C = {
    /** 记录名 → { name, fields, methods, dtor }。 */
    records: new Map(),
    /** `typedef int myint;` → 名字 → 类型。 */
    aliases: new Map(),
    fns: new Map(),
    /** 当前函数里那几格带析构的量（出作用域逆序调一遍）。 */
    scoped: [],
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
    ref: (n) => {
      if (!names.has(n)) {
        let s = String(n).replace(/[^A-Za-z0-9_]/g, '_');
        if (/^[0-9]/.test(s)) s = `_${s}`;
        names.set(n, s);
      }
      return names.get(n);
    },
    push: () => scopes.push(new Map()),
    pop: () => scopes.pop(),
    bind: (n, t) => scopes[scopes.length - 1].set(n, t),
    tyCtx: () => ({
      env: {
        get: (n) => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            const v = scopes[i].get(n);
            if (v !== undefined) return v;
          }
          return undefined;
        },
      },
      fns: C.fns,
      fields: recFields,
    }),
    /** 多值那一族合成的记录。`fieldNames` 给了就按它命名（C++ 的 pair 叫 first/second）。 */
    mvType: (types, fieldNames) => {
      const ns = fieldNames ?? types.map((_, i) => `v${i}`);
      const key = `${ns.join(',')}|${types.map((t) => JSON.stringify(t)).join(',')}`;
      if (!mvs.has(key)) {
        const name = `mv${mvs.size + 1}`;
        mvs.set(key, name);
        const fields = types.map((t, i) => ({ name: ns[i], type: t }));
        recFields.set(name, fields);
        decls.push({ kind: 'struct', name, fields });
      }
      return named(mvs.get(key));
    },
  };

  /* ---- 第一遍：typedef 与 struct/class ------------------------------------- */
  for (const d of kids(tree)) {
    if (tag(d) !== 'decl') continue;
    const specs = part(d, 'specs');
    if (specs === undefined) continue;
    const isTypedef = kids(specs).some((y) => tag(y) === null && String(leaf(y)) === 'typedef');
    if (isTypedef) {
      const init = part(d, 'init');
      const nm = init === undefined ? undefined : kids(kids(init)[0])[0];
      if (nm !== undefined) C.aliases.set(nameOf(nm), typeOfSpecs(specs, C));
      continue;
    }
    const cls = kids(specs).find((y) => tag(y) === 'class');
    if (cls === undefined) continue;
    const nm = kids(cls).find((y) => tag(y) === 'n');
    const members = part(cls, 'members');
    const fields = [];
    const methods = [];
    let dtor = null;
    for (const m of (members === undefined ? [] : kids(members))) {
      if (tag(m) === 'decl') {
        const ms = part(m, 'specs');
        const mi = part(m, 'init');
        const mn = mi === undefined ? undefined : kids(kids(mi)[0])[0];
        if (mn !== undefined) {
          fields.push({ name: nameOf(mn), type: typeOfSpecs(ms, C, kids(kids(mi)[0])[0]) ?? INT });
        }
        continue;
      }
      if (tag(m) === 'func') {
        const f = part(m, 'fn') ?? kids(m).find((y) => tag(y) === 'fn');
        const head = f === undefined ? undefined : kids(f)[0];
        if (head !== undefined && tag(head) === 'dtor') { dtor = m; continue; }
        methods.push(m);
      }
    }
    C.records.set(nameOf(nm), { name: nameOf(nm), fields, methods, dtor });
  }
  for (const [, rec] of C.records) {
    recFields.set(C.ref(rec.name), rec.fields);
    decls.push({ kind: 'class', name: C.ref(rec.name), fields: rec.fields });
  }

  /* ---- 第二遍：函数签名（含方法与析构）------------------------------------- */
  const topFns = kids(tree).filter((f) => tag(f) === 'func');
  const sigOf = (fnTok, selfType, forcedName) => {
    const f = kids(fnTok).find((y) => tag(y) === 'fn');
    const nmTok = kids(f)[0];
    const ps = part(f, 'params');
    const params = (ps === undefined ? [] : kids(ps).filter((y) => tag(y) === 'p')).map((p) => {
      const pn = kids(p).find((y) => tag(y) === 'n' || tag(y) === 'ptr' || tag(y) === 'array');
      const pname = pn === undefined ? 'x' : nameOf(tag(pn) === 'n' ? pn : kids(pn)[kids(pn).length - 1]);
      return { name: C.ref(pname), type: typeOfSpecs(part(p, 'specs'), C, pn) ?? INT };
    });
    const ret = typeOfSpecs(part(fnTok, 'specs'), C) ?? { kind: 'void' };
    const name = forcedName ?? C.ref(nameOf(nmTok));
    const all = selfType === undefined ? params : [{ name: 'this', type: selfType }, ...params];
    return { name, params: all, ret };
  };
  for (const f of topFns) {
    const s = sigOf(f);
    C.fns.set(s.name, { params: s.params, ret: s.ret });
  }
  for (const [, rec] of C.records) {
    const selfType = named(C.ref(rec.name), true);
    for (const m of rec.methods) {
      const s = sigOf(m, selfType, `${C.ref(rec.name)}_${nameOf(kids(kids(m).find((y) => tag(y) === 'fn'))[0])}`);
      C.fns.set(s.name, { params: s.params, ret: s.ret });
    }
    if (rec.dtor !== null) {
      C.fns.set(dtorName(rec.name), {
        params: [{ name: 'this', type: selfType }],
        ret: { kind: 'void' },
      });
    }
  }

  /* ---- 第三遍：方法 / 析构 / 函数的体 -------------------------------------- */
  for (const [, rec] of C.records) {
    const selfType = named(C.ref(rec.name), true);
    for (const m of rec.methods) {
      const s = sigOf(m, selfType, `${C.ref(rec.name)}_${nameOf(kids(kids(m).find((y) => tag(y) === 'fn'))[0])}`);
      decls.push(fnDecl(s, m, C));
    }
    if (rec.dtor !== null) {
      const s = {
        name: dtorName(rec.name),
        params: [{ name: 'this', type: selfType }],
        ret: { kind: 'void' },
      };
      decls.push(fnDecl(s, rec.dtor, C));
    }
  }
  for (const f of topFns) decls.push(fnDecl(sigOf(f), f, C));

  if (!C.fns.has('main')) throw new Error('cpp->IR: 这份源码里没有 `int main()`');
  return { kind: 'module', decls };
}

/** 一格函数（体里 `return` 前要补析构调用）。 */
function fnDecl(sig, fnTok, C) {
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  const outerScoped = C.scoped;
  C.scoped = [];
  const body = part(fnTok, 'body');
  const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
  const last = stmts[stmts.length - 1];
  if (C.scoped.length > 0 && (last === undefined || last.kind !== 'return')) {
    stmts.push(...dtorCalls(C));
  }
  C.scoped = outerScoped;
  C.pop();
  return {
    kind: 'fn', name: sig.name, params: sig.params, ret: sig.ret, body: stmts,
  };
}

/** 当前函数里那几格带析构的量 → **逆序**各调一次。 */
function dtorCalls(C) {
  return [...C.scoped].reverse().map((v) => ({
    kind: 'expr-stmt',
    expr: {
      kind: 'call',
      fn: { kind: 'name', name: dtorName(v.type) },
      args: [{ kind: 'name', name: v.name }],
    },
  }));
}

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

export function stmtsOf(x, C) {
  switch (tag(x)) {
    case 'block': {
      C.push();
      const stmts = kids(x).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'block', stmts }];
    }
    case 'pp': case 'namespace': case 'template': case 'using': return [];
    case 'expr': {
      const inner = kids(x)[0];
      /* `printf(…)` / `puts(…)` 是语句（它们不交值）。 */
      if (tag(inner) === 'call' && tag(kids(inner)[0]) === 'n') {
        const nm = nameOf(kids(inner)[0]);
        if (nm === 'printf' || nm === 'puts') {
          const argsTok = part(inner, 'args');
          return printArgs(nm, argsTok === undefined ? [] : kids(argsTok), C);
        }
      }
      if (tag(inner) === 'assign') return [assignOf(inner, C)];
      if (tag(inner) === 'post' || tag(inner) === 'pre') return [stepOf(inner, C)];
      return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
    }
    case 'assign': return [assignOf(x, C)];
    case 'post': case 'pre': return [stepOf(x, C)];
    /* `int acc = 0;` / `int xs[3] = {…};` / `Point p = {1,2};` / `Say s1;` / `auto t = …`。 */
    case 'decl': {
      const specs = part(x, 'specs');
      /* 结构体/类的声明（`struct Point { … };`）已经在第一遍收过了。 */
      if (specs !== undefined && kids(specs).some((y) => tag(y) === 'class' || tag(y) === 'elaborated')) return [];
      if (specs !== undefined && kids(specs).some((y) => tag(y) === null && String(leaf(y)) === 'typedef')) return [];
      const out = [];
      for (const d of kids(x).filter((y) => tag(y) === 'init')) {
        out.push(declOf(d, specs, C));
      }
      return out;
    }
    case 'if': {
      const parts = kids(x);
      const cond = condOf(parts[0], C);
      const then = stmtsOf(parts[1], C);
      const elseTok = parts.slice(2).find((y) => tag(y) === 'else');
      const els = elseTok === undefined ? null : kids(elseTok).flatMap((s) => stmtsOf(s, C));
      return [{ kind: 'if', cond, then, else_: els }];
    }
    case 'while': {
      const cond = condOf(kids(x)[0], C);
      C.push();
      const body = kids(x).slice(1).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'while', cond, body }];
    }
    /* `for (init; cond; post) body` —— 三段式（公共降级器会把 `continue` 那一格摆对）。 */
    case 'for': {
      const [initTok, condTok, postTok, ...rest] = kids(x);
      C.push();
      const init = initTok === undefined || tag(initTok) === null ? null : stmtsOf(initTok, C)[0];
      const cond = condTok === undefined || tag(condTok) === null ? null : condOf(condTok, C);
      const post = postTok === undefined || tag(postTok) === null ? null : stmtsOf(postTok, C)[0];
      const body = rest.flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'for', init, cond, post, body }];
    }
    case 'return': {
      const vs = kids(x);
      return [...dtorCalls(C), {
        kind: 'return',
        values: vs.length === 0 ? [] : [exprOf(vs[0], C)],
      }];
    }
    case 'break': return [{ kind: 'break', label: null }];
    case 'continue': return [{ kind: 'continue', label: null }];
    case 'func':
      throw new Error('cpp->IR: 函数里套函数（lambda）还没接');
    default:
      throw new Error(`cpp->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** `i++` / `++i` / `i--` → 一格赋值。 */
function stepOf(x, C) {
  const op = String(leaf(kids(x)[0])) === '++' ? '+' : '-';
  const target = lhsOf(kids(x)[1], C);
  return {
    kind: 'assign',
    target,
    value: { kind: 'binop', op, left: target, right: { kind: 'int', value: 1 } },
  };
}

/** 赋值的左边那一格。 */
function lhsOf(t, C) {
  if (tag(t) === 'n') return { kind: 'name', name: C.ref(nameOf(t)) };
  if (tag(t) === 'dot' || tag(t) === 'arrow') {
    return { kind: 'field', obj: exprOf(kids(t)[0], C), name: nameOf(kids(t)[1]) };
  }
  if (tag(t) === 'index') {
    return { kind: 'index', obj: exprOf(kids(t)[0], C), index: exprOf(kids(t)[1], C) };
  }
  throw new Error(`cpp->IR: 赋值的左边是 ${tag(t)} —— 还没接`);
}

/** `a = b` / `a += b`。 */
function assignOf(x, C) {
  const [op, lhs, rhs] = kids(x);
  const o = String(leaf(op));
  const target = lhsOf(lhs, C);
  let value = exprOf(rhs, C);
  if (o !== '=') {
    const bare = o.replace('=', '');
    value = { kind: 'binop', op: bare, left: target, right: value };
  }
  /* 字典的键要走 `dset`（它只当语句用）。 */
  if (target.kind === 'index') {
    const t = typeOf(target.obj, C.tyCtx());
    if (t.kind === 'map') {
      return { kind: 'builtin-stmt', name: 'dset', args: [target.obj, target.index, value] };
    }
  }
  return { kind: 'assign', target, value };
}

/** 一格 `(init (d 名字 [(init 值)]))` → 一条 `let`。 */
function declOf(d, specs, C) {
  const dd = kids(d)[0];
  const nameTok = kids(dd)[0];
  const initTok = part(dd, 'init');
  const isArray = tag(nameTok) === 'array';
  const bare = tag(nameTok) === 'n' ? nameTok : kids(nameTok).find((y) => tag(y) === 'n');
  const name = C.ref(nameOf(bare));
  let type = typeOfSpecs(specs, C, nameTok);

  /* `auto t = …`：类型从初值取。 */
  if (type === null) {
    if (initTok === undefined) throw new Error(`cpp->IR: \`auto ${name}\` 没有初值`);
    const v = exprOf(kids(initTok)[0], C);
    type = typeOf(v, C.tyCtx());
    C.bind(name, type);
    return { kind: 'let', name, type, init: v };
  }

  if (isArray) {
    const elem = type;
    const arrTy = arrOf(elem);
    C.bind(name, arrTy);
    const nTok = kids(nameTok).find((y) => tag(y) === 'num');
    const size = nTok === undefined ? 0 : Number(leaf(kids(nTok)[0]));
    if (initTok !== undefined && tag(kids(initTok)[0]) === 'braces') {
      const its = kids(kids(initTok)[0]).map((k) => exprOf(k, C));
      const tmp = C.fresh('arr');
      C.bind(tmp, arrTy);
      const stmts = [{
        kind: 'let', name: tmp, type: arrTy,
        init: { kind: 'builtin', name: 'anew', args: [tyArg(arrTy), { kind: 'int', value: Math.max(size, its.length) }] },
      }];
      its.forEach((v, i) => stmts.push({
        kind: 'assign',
        target: { kind: 'index', obj: { kind: 'name', name: tmp }, index: { kind: 'int', value: i } },
        value: v,
      }));
      return {
        kind: 'let', name, type: arrTy,
        init: { kind: 'block-expr', stmts, value: { kind: 'name', name: tmp } },
      };
    }
    return {
      kind: 'let', name, type: arrTy,
      init: { kind: 'builtin', name: 'anew', args: [tyArg(arrTy), { kind: 'int', value: size }] },
    };
  }

  C.bind(name, type);
  /* `Point p = {1, 2}`：按字段顺序造一格记录。 */
  if (initTok !== undefined && tag(kids(initTok)[0]) === 'braces' && type.kind === 'named') {
    const its = kids(kids(initTok)[0]).map((k) => exprOf(k, C));
    const fields = C.tyCtx().fields.get(type.name) ?? [];
    return {
      kind: 'let', name, type,
      init: {
        kind: 'new-record',
        type,
        ref: true,
        fields: fields.map((f, i) => ({
          name: f.name,
          value: its[i] === undefined ? { kind: 'int', value: 0 } : its[i],
        })),
      },
    };
  }
  /* `Say s1;`（带析构的类型）—— 记一格，出作用域要逆序调。 */
  if (type.kind === 'named') {
    const rec = [...C.records.values()].find((r) => C.ref(r.name) === type.name);
    if (rec !== undefined && rec.dtor !== null) C.scoped.push({ name, type: rec.name });
  }
  return {
    kind: 'let', name, type,
    init: initTok === undefined ? null : exprOf(kids(initTok)[0], C),
  };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 模板、继承、虚函数、运算符重载、异常、lambda 都没接（与从前那条路同一个范围）。
//   2. `printf` 只接"一格转换 + 换行"与纯文本（见 expr.js 的 printArgs）。
//   3. 引用（`T&`）当值收（例子里只用它传结构 —— 记录本来就是引用语义）。
