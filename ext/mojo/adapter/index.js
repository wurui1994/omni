// ext/mojo/adapter/index.js —— **Mojo → 标准 IR**（ADR-0044 第二片第五门）
//
// 替掉 `ext/mojo/tograph.js`（363 行）。这一门的特点：
//   1. **入口是 `fn main`**（不像 awk 的 BEGIN 或 Scheme 的顶层语句）——
//      所以模块里就有一格名叫 `main` 的函数，公共降级器会发 `(main (expr (call main)))`；
//   2. **struct 带方法**：`@value struct Point: … fn total(self) -> Int`。方法不是新东西 ——
//      名字落成 `Point_total`、接收者是第一格实参（单态分派，声明里写着它属于谁）；
//   3. **`with` 那一族就是 defer**：`with Say(1), Say(2):` 出块时按逆序调 `__exit__`，
//      body 里的 `return` 也要先调一遍（与 freebasic 的析构同一手）；
//   4. `assert` 方言里没有这一格，按口径拼：`(if (un "!" 条件) (do (print …) (fail …)))`。

import { tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import { INT, named, typeOf } from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfTok, nameOf, tyArg,
} from './expr.js';

/** 一棵 mojo 的树（`(module …)`）→ 标准 IR 的模块。 */
export function mojoToIR(tree) {
  if (tag(tree) !== 'module') throw new Error('mojo->IR: 这不是 (module …)');

  let tmpN = 0;
  const names = new Map();
  const scopes = [new Map()];
  const recFields = new Map();
  const mvs = new Map();
  const decls = [];
  const C = {
    /** struct 名 → { name, fields: [{name,type}], methods: [routine] }。 */
    records: new Map(),
    fns: new Map(),
    /** 现在套着的 `with` 里那几格（出块要逆序调 `__exit__`）。 */
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
    mvType: (types) => {
      const key = types.map((t) => JSON.stringify(t)).join(',');
      if (!mvs.has(key)) {
        const name = `mv${mvs.size + 1}`;
        mvs.set(key, name);
        const fields = types.map((t, i) => ({ name: `v${i}`, type: t }));
        recFields.set(name, fields);
        decls.push({ kind: 'struct', name, fields });
      }
      return named(mvs.get(key));
    },
  };

  /* ---- 第一遍：struct 的声明（字段 + 方法）---------------------------------- */
  const structs = [];
  for (const f of kids(tree)) {
    const s = tag(f) === 'struct' ? f : (tag(f) === 'decorated' ? part(f, 'struct') ?? kids(f).find((y) => tag(y) === 'struct') : undefined);
    if (s === undefined) continue;
    structs.push(s);
  }
  for (const s of structs) {
    const name = String(nameOf(kids(s)[0]));
    const body = part(s, 'body');
    const fields = [];
    const methods = [];
    for (const item of (body === undefined ? [] : kids(body))) {
      if (tag(item) === 'line') {
        for (const v of kids(item)) {
          if (tag(v) !== 'var') continue;
          /* `(var var (n x) (n Int))` —— 字段：名字 + 类型。 */
          const vs = kids(v);
          fields.push({ name: String(nameOf(vs[1])), type: typeOfTok(vs[2], C) });
        }
        continue;
      }
      if (tag(item) === 'routine') { methods.push(item); continue; }
    }
    C.records.set(name, { name, fields, methods });
  }
  /* 字段表要**先全登记**（方法体里会引到别的 struct）。 */
  for (const [, rec] of C.records) {
    recFields.set(C.ref(rec.name), rec.fields);
    decls.push({ kind: 'class', name: C.ref(rec.name), fields: rec.fields });
  }

  /* ---- 第二遍：函数与方法的签名 --------------------------------------------- */
  const topFns = kids(tree).filter((f) => tag(f) === 'routine');
  const sigOf = (r, selfType) => {
    const nm = kids(r).find((y) => tag(y) === 'n');
    const sig = part(r, 'sig');
    /* **形参在一格无名表里**（`(sig ((p …) (p …)) (ret …))`）——
       按 `kids(sig).filter(tag==='p')` 取是空的（踩过：函数体里报"未声明的变量 n"）。 */
    const group = sig === undefined ? undefined : kids(sig).find((y) => tag(y) === null);
    const ps = group === undefined ? [] : group.items.filter((y) => tag(y) === 'p');
    const retTok = sig === undefined ? undefined : part(sig, 'ret');
    const params = ps.map((p) => {
      const pn = String(nameOf(kids(p)[0]));
      /* `self` 没有类型标注 —— 它的类型是那个 struct。 */
      if (pn === 'self' && selfType !== undefined) return { name: 'self', type: selfType };
      return { name: C.ref(pn), type: typeOfTok(kids(p)[1], C) };
    });
    return {
      name: nameOf(nm),
      params,
      ret: retTok === undefined ? { kind: 'void' } : typeOfTok(kids(retTok)[0], C),
    };
  };
  for (const r of topFns) {
    const s = sigOf(r);
    C.fns.set(C.ref(s.name), { params: s.params, ret: s.ret });
  }
  for (const [, rec] of C.records) {
    const selfType = named(C.ref(rec.name), true);
    for (const m of rec.methods) {
      const s = sigOf(m, selfType);
      C.fns.set(`${C.ref(rec.name)}_${s.name}`, { params: s.params, ret: s.ret });
    }
  }

  /* ---- 第三遍：方法体（名字是 `<类型>_<方法>`，接收者是第一格实参）----------- */
  for (const [, rec] of C.records) {
    const selfType = named(C.ref(rec.name), true);
    for (const m of rec.methods) {
      const s = sigOf(m, selfType);
      const name = `${C.ref(rec.name)}_${s.name}`;
      /* `__enter__` / `__exit__` 也落成普通函数 —— `with` 那一族靠它们（见 stmtsOf）。 */
      decls.push(fnDecl(name, s, m, C));
    }
  }

  /* ---- 函数体 --------------------------------------------------------------- */
  for (const r of topFns) {
    const s = sigOf(r);
    decls.push(fnDecl(C.ref(s.name), s, r, C));
  }

  /* Mojo 的入口就是那格 `fn main` —— 公共降级器看见它就发 `(main (expr (call main)))`。 */
  if (!C.fns.has('main')) {
    throw new Error('mojo->IR: 这份源码里没有 `fn main`（Mojo 的入口）');
  }
  return { kind: 'module', decls };
}

/** 一格函数（体里 `return` 前要补 `with` 那几格的 `__exit__`）。 */
function fnDecl(name, sig, routine, C) {
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  const outerScoped = C.scoped;
  C.scoped = [];
  const body = part(routine, 'body');
  const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
  C.scoped = outerScoped;
  C.pop();
  return {
    kind: 'fn', name, params: sig.params, ret: sig.ret, body: stmts,
  };
}

/** 当前 `with` 里那几格 → **逆序**各调一次 `__exit__`。 */
function exitCalls(C) {
  return [...C.scoped].reverse().map((v) => ({
    kind: 'expr-stmt',
    expr: {
      kind: 'call',
      fn: { kind: 'name', name: `${v.type}___exit__` },
      args: [{ kind: 'name', name: v.name }],
    },
  }));
}

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

export function stmtsOf(x, C) {
  switch (tag(x)) {
    case 'line': case 'body': return kids(x).flatMap((k) => stmtsOf(k, C));
    case 'import': case 'from': case 'trait': case 'struct': case 'decorated': return [];
    case 'expr': {
      const inner = kids(x)[0];
      /* `print(x)` 是语句（它不交值）。 */
      if (tag(inner) === 'call') {
        const [fn, argsTok] = kids(inner);
        if (tag(fn) === 'n' && String(nameOf(fn)) === 'print') {
          const args = argsTok === undefined ? [] : kids(argsTok);
          if (args.length === 0) return [{ kind: 'print', values: [{ kind: 'string', value: '' }] }];
          return args.map((a) => ({ kind: 'print', values: [exprOf(a, C)] }));
        }
      }
      return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
    }
    /* `var x = e` / `x = e` / `xs[i] = e` / `p.f = e` / `var a, b = two()`。 */
    case 'assign': {
      const targets = part(x, 'targets');
      const ts = targets === undefined ? [] : kids(targets);
      const value = exprOf(kids(x)[kids(x).length - 1], C);
      if (ts.length > 1) return destructure(ts, value, C);
      return [assignOne(ts[0], value, C)];
    }
    case 'augassign': {
      const [op, lhs, rhs] = kids(x);
      const o = String(leaf(op)).replace('=', '').trim();
      const target = lhsOf(lhs, C);
      const cur = targetRead(target, C);
      return [assignOne(lhs, {
        kind: 'binop', op: o, left: cur, right: exprOf(rhs, C),
      }, C)];
    }
    case 'while': {
      const cond = condOf(kids(x)[0], C);
      const body = part(x, 'body');
      C.push();
      const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'while', cond, body: stmts }];
    }
    /* `(if c (body…) (elifs [(elif c (body…))…]) [(else (body…))])` —— 与 freebasic 同形。 */
    case 'if': {
      const parts = kids(x);
      const cond = condOf(parts[0], C);
      const then = parts[1] === undefined ? [] : kids(parts[1]).flatMap((s) => stmtsOf(s, C));
      const elifs = parts[2] !== undefined && tag(parts[2]) === 'elifs' ? kids(parts[2]) : [];
      const elseTok = parts.slice(2).find((y) => tag(y) === 'else');
      let els = elseTok === undefined ? null : kids(elseTok).flatMap((s) => stmtsOf(s, C));
      for (let i = elifs.length - 1; i >= 0; i--) {
        const e = kids(elifs[i]);
        els = [{
          kind: 'if',
          cond: condOf(e[0], C),
          then: e[1] === undefined ? [] : kids(e[1]).flatMap((s) => stmtsOf(s, C)),
          else_: els,
        }];
      }
      return [{ kind: 'if', cond, then, else_: els }];
    }
    case 'return': {
      const vs = kids(x);
      /* `with` 里早退也要调 `__exit__`（逆序）。 */
      return [...exitCalls(C), { kind: 'return', values: vs.length === 0 ? [] : [exprOf(vs[0], C)] }];
    }
    case 'break': return [{ kind: 'break', label: null }];
    case 'continue': return [{ kind: 'continue', label: null }];
    /* `assert c[, "话"]`：方言里没有 assert，按口径拼 —— 印一句再停下来。 */
    case 'assert': {
      const cond = condOf(kids(x)[0], C);
      const msg = kids(x)[1];
      const head = { kind: 'string', value: 'assert failed' };
      const line = msg === undefined
        ? head
        : {
          kind: 'binop', op: '+',
          left: { kind: 'string', value: 'assert failed: ' },
          right: exprOf(msg, C),
        };
      return [{
        kind: 'if',
        cond: { kind: 'unop', op: '!', operand: cond },
        then: [
          { kind: 'print', values: [line] },
          { kind: 'builtin-stmt', name: 'fail', args: [head] },
        ],
        else_: null,
      }];
    }
    /* `with A(), B(): body` —— 进块时各造一格、出块时**逆序**调 `__exit__`。 */
    case 'with': {
      const items = part(x, 'items');
      const body = part(x, 'body');
      C.push();
      const outerScoped = C.scoped;
      C.scoped = [...outerScoped];
      const pre = [];
      for (const it of (items === undefined ? [] : kids(items))) {
        const v = exprOf(it, C);
        const t = typeOf(v, C.tyCtx());
        if (t.kind !== 'named') {
          throw new Error('mojo->IR: `with` 里那一格不是记录 —— `__enter__` / `__exit__` 要它是');
        }
        const tmp = C.fresh('with_');
        C.bind(tmp, t);
        pre.push({ kind: 'let', name: tmp, type: t, init: v });
        /* `__enter__` 有就调一遍（它的值这一批丢掉 —— 例子里没有 `as x`）。 */
        if (C.fns.has(`${t.name}___enter__`)) {
          pre.push({
            kind: 'expr-stmt',
            expr: {
              kind: 'call',
              fn: { kind: 'name', name: `${t.name}___enter__` },
              args: [{ kind: 'name', name: tmp }],
            },
          });
        }
        C.scoped.push({ name: tmp, type: t.name });
      }
      const inner = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
      /* 末尾也要调一遍（没早退的那条路）。 */
      const last = inner[inner.length - 1];
      const tail = last !== undefined && last.kind === 'return' ? [] : exitCalls(C);
      C.scoped = outerScoped;
      C.pop();
      return [{ kind: 'block', stmts: [...pre, ...inner, ...tail] }];
    }
    /* `alias X = 1` / `(const (n X) … (init e))`。 */
    case 'const': {
      const nm = kids(x).find((y) => tag(y) === 'n');
      const init = part(x, 'init');
      const value = init === undefined ? { kind: 'int', value: 0 } : exprOf(kids(init)[0], C);
      const name = C.ref(nameOf(nm));
      const type = typeOf(value, C.tyCtx());
      C.bind(name, type);
      return [{ kind: 'let', name, type, init: value }];
    }
    case 'var': {
      /* 函数体里的 `var x: Int = 1`（带标注那一种）。 */
      const vs = kids(x);
      const name = C.ref(nameOf(vs[1]));
      const type = vs[2] === undefined ? INT : typeOfTok(vs[2], C);
      C.bind(name, type);
      const init = part(x, 'init');
      return [{
        kind: 'let', name, type,
        init: init === undefined ? null : exprOf(kids(init)[0], C),
      }];
    }
    case 'routine':
      throw new Error('mojo->IR: 函数里套函数（闭包）还没接');
    default:
      throw new Error(`mojo->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** 赋值的左边那一格。 */
function lhsOf(t, C) {
  if (tag(t) === 'bind') return { kind: 'name', name: C.ref(nameOf(kids(t)[1])), declare: true };
  if (tag(t) === 'n') return { kind: 'name', name: C.ref(nameOf(t)) };
  if (tag(t) === 'attr') {
    return { kind: 'field', obj: exprOf(kids(t)[0], C), name: String(leaf(kids(t)[1])) };
  }
  if (tag(t) === 'index') {
    const obj = exprOf(kids(t)[0], C);
    const subs = part(t, 'subs');
    return { kind: 'index', obj, index: exprOf(kids(subs)[0], C) };
  }
  throw new Error(`mojo->IR: 赋值的左边是 ${tag(t)} —— 还没接`);
}

/** 目标当值读一遍（`+=` 要它）。 */
function targetRead(target) {
  if (target.kind === 'name') return { kind: 'name', name: target.name };
  return target;
}

/** 一格赋值（`var x = e` 是声明，别的是写）。 */
function assignOne(t, value, C) {
  const target = lhsOf(t, C);
  if (target.declare === true) {
    const type = typeOf(value, C.tyCtx());
    C.bind(target.name, type);
    return { kind: 'let', name: target.name, type, init: value };
  }
  if (target.kind === 'index') {
    const t2 = typeOf(target.obj, C.tyCtx());
    if (t2.kind === 'map') {
      return { kind: 'builtin-stmt', name: 'dset', args: [target.obj, target.index, value] };
    }
  }
  return { kind: 'assign', target, value };
}

/** `var a, b = two()`：一格记录拆成几格名字。 */
function destructure(ts, value, C) {
  const ty = typeOf(value, C.tyCtx());
  const tmp = C.fresh('mv_');
  C.bind(tmp, ty);
  const out = [{ kind: 'let', name: tmp, type: ty, init: value }];
  const fs = ty.kind === 'named' ? (C.tyCtx().fields.get(ty.name) ?? []) : [];
  ts.forEach((t, i) => {
    const name = tag(t) === 'bind' ? C.ref(nameOf(kids(t)[1])) : C.ref(nameOf(t));
    const type = fs[i] === undefined ? INT : fs[i].type;
    C.bind(name, type);
    out.push({
      kind: 'let', name, type,
      init: { kind: 'field', obj: { kind: 'name', name: tmp }, name: `v${i}` },
    });
  });
  return out;
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 闭包（函数里套函数 / lambda）没接；`trait` 与泛型参数丢掉。
//   2. `with … as x` 里的 `as` 没接（`__enter__` 的值丢掉）。
//   3. `Int()` 是截断（Mojo 那侧对浮点是向零取整，与方言一致）。
