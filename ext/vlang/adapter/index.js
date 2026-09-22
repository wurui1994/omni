// ext/vlang/adapter/index.js —— **V → 标准 IR**（ADR-0044 第三片，图上最后一门之前的那一门）
//
// 替掉 `ext/vlang/tograph.js`（1581 行）。这一门是借来的十一门里例子最多的一格（31 份），
// 多出来的那几族在 `expr.js` 文件头里记着（Option/Result · 函数值 · `<<` · `@FN`）。
// 这一份管的是**声明与语句**：
//
//   * **struct 一律落 `(class …)`**（引用语义）—— `&T`、`mut p`、`q := p` 那几行答案要的正是它；
//   * **方法压成 `Type__名字`**，接收者是第一格实参（单态分派，声明里写着它属于谁）；
//   * **`$if` 是编译期分支**（`V_CT_ENV` 那张定死的表），`flag ?` 那一格是 false；
//   * **`defer` 逆序**、**`assert` 按口径拼**（方言里没有这两格）；
//   * **`enum` 落成一组整数**：`Color.blue` / `.red` 在树上是两种写法、同一件事。

import { tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import { INT, named, typeOf } from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfTok, nameOf, zeroExpr, matchParts, PRINTS,
} from './expr.js';

/** 复合赋值里认得的那几个算符。 */
const AUG = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'],
  ['&', '&'], ['|', '|'], ['^', '^'], ['<<', '<<'], ['>>', '>>'],
]);

/**
 * **声明过的编译期环境**（`$if linux {}`）—— 与 nim 那一份同一条口径：定死一个参考目标
 * （linux · x64 · gcc），不看跑在哪台机器上（**尺子要可重现**）。不在表里的名字当场报。
 */
const V_CT_ENV = new Map(Object.entries({
  linux: true, macos: false, windows: false, freebsd: false, openbsd: false, netbsd: false,
  android: false, ios: false, solaris: false, serenity: false, vinix: false, haiku: false,
  x64: true, x32: false, little_endian: true, big_endian: false, amd64: true, arm64: false,
  gcc: true, tinyc: false, clang: false, msvc: false, mingw: false,
  js: false, wasm32: false, prod: false, debug: true, test: false, threads: false,
  no_bounds_checking: false, freestanding: false, cplusplus: false, gcboehm: false,
}));

/** `$if` 的条件求值。`flag ?`（`(propagate …)`）那一格是 **false** —— 那是"命令行给了吗"。 */
function ctCond(c) {
  const t = tag(c);
  if (t === 'paren') return ctCond(kids(c)[0]);
  if (t === 'propagate') return false;
  if (t === 'un' && ['!', 'not'].includes(String(leaf(kids(c)[0])))) return !ctCond(kids(c)[1]);
  if (t === 'bin') {
    const o = String(leaf(kids(c)[0]));
    if (o === '&&') return ctCond(kids(c)[1]) && ctCond(kids(c)[2]);
    if (o === '||') return ctCond(kids(c)[1]) || ctCond(kids(c)[2]);
  }
  if (t === 'name') {
    const n = nameOf(c);
    if (V_CT_ENV.has(n)) return V_CT_ENV.get(n) === true;
    throw new Error(`vlang->IR: \`$if\` 的条件里有 \`${n}\` —— 不在声明过的那张表里（V_CT_ENV）`);
  }
  throw new Error(`vlang->IR: \`$if\` 的条件是 \`${t}\` 这个形状 —— 只接标志名与 ! && || 拼起来的那几种`);
}

/** 一棵 V 的树（`(file …)`）→ 标准 IR 的模块。 */
export function vlangToIR(tree) {
  if (tag(tree) !== 'file') throw new Error('vlang->IR: 这不是 (file …)');

  let tmpN = 0;
  let liftN = 0;
  const scopes = [new Map()];
  const recFields = new Map();
  const mvs = new Map();
  const decls = [];
  const C = {
    mod: 'main',
    records: new Map(),
    aliases: new Map(),
    enums: new Map(),
    variants: new Map(),
    enumNames: new Set(),
    /** 编译期常量（`const start = 10`）—— 用处直接换成值。 */
    consts: new Map(),
    methods: new Map(),
    fns: new Map(),
    defers: [],
    /** 现在降的是哪格函数（`@FN` / `@STRUCT` 与 `f()!` 要它）。 */
    cur: { fn: null, struct: null, ret: { kind: 'void' } },
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
    ref: (n) => String(n).replace(/[^A-Za-z0-9_]/g, '_'),
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
    /** 一格 `fn (…) … { … }` **提升**成顶层函数，回它的名字。 */
    lift: (fnlit, hint) => {
      liftN += 1;
      const name = hint === null ? `__fn${liftN}` : C.ref(hint);
      const sig = sigOfParts(part(fnlit, 'params'), kids(fnlit).find((y) => tag(y) !== 'params' && tag(y) !== 'block'), C);
      C.fns.set(name, sig);
      decls.push(fnBody(name, sig, part(fnlit, 'block'), null, C));
      return name;
    },
    blockStmts: (blockTok) => {
      if (blockTok === undefined || blockTok === null) return [];
      C.push();
      const out = kids(blockTok).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return out;
    },
    /** 一段块，**末尾那格表达式写回 `tmp`**（`or {}` / 交值的 match 与 if 要它）。 */
    valueBlock: (blockTok, tmp) => {
      if (blockTok === undefined || blockTok === null) return [];
      C.push();
      const items = kids(blockTok);
      const out = [];
      items.forEach((s, i) => {
        const val = i === items.length - 1 ? valueTail(s) : null;
        if (val !== null) {
          out.push({ kind: 'assign', target: { kind: 'name', name: tmp }, value: exprOf(val, C) });
          return;
        }
        out.push(...stmtsOf(s, C));
      });
      C.pop();
      return out;
    },
  };

  /* ---- module ---------------------------------------------------------------- */
  const modTok = kids(tree).find((y) => tag(y) === 'module');
  if (modTok !== undefined) C.mod = String(leaf(kids(modTok)[0]));

  /* ---- 第一遍：类型（struct / enum / 别名）。`pub` 与 `[attr]` 是包一层，剥掉。 ---- */
  const top = kids(tree).flatMap(unwrap);
  for (const d of top) {
    if (tag(d) === 'struct') C.records.set(nameOf(kids(d)[0]).split('.').pop(), { fields: [] });
    if (tag(d) === 'enum') C.enumNames.add(String(leaf(kids(d)[0])));
  }
  for (const d of top) {
    if (tag(d) === 'typedecl') {
      C.aliases.set(nameOf(kids(d)[0]).split('.').pop(), typeOfTok(kids(d)[1], C));
    }
  }
  for (const d of top) {
    if (tag(d) !== 'struct') continue;
    const name = nameOf(kids(d)[0]).split('.').pop();
    const fields = kids(d).slice(1).filter((f) => tag(f) === 'f')
      .map((f) => ({ name: String(leaf(kids(f)[0])), type: typeOfTok(kids(f)[1], C) }));
    C.records.get(name).fields = fields;
    recFields.set(C.ref(name), fields);
    decls.push({ kind: 'class', name: C.ref(name), fields });
  }
  /* 枚举：默认从 0 数上去，写了 `= N` 就从那儿接着数。变体名撞了的存 null（不猜）。 */
  for (const d of top) {
    if (tag(d) !== 'enum') continue;
    const ename = String(leaf(kids(d)[0]));
    let next = 0;
    for (const v of kids(d).slice(1)) {
      if (tag(v) !== 'v') continue;
      const vn = String(leaf(kids(v)[0]));
      const given = kids(v)[1];
      if (given !== undefined) {
        if (tag(given) !== 'num') throw new Error(`vlang->IR: 枚举 ${ename}.${vn} 的值要编译期求值 —— 这一批只接整数字面量`);
        next = Number(leaf(kids(given)[0]));
      }
      C.enums.set(`${ename}.${vn}`, next);
      C.variants.set(vn, C.variants.has(vn) ? null : next);
      next += 1;
    }
  }

  /* ---- 第二遍：const ---------------------------------------------------------
     V 的 const 是**编译期常量**，所以在用处**直接换成那个值** —— 不落模块级变量：
     方言的 `(global 名字 类型)` 没有初值那一格（初值要在入口里写），而 const 本来就不需要
     一格存储。判据是 `decls.v`（`start` / `step` / `limit` 三格都在 main 里当值用）。 */
  for (const d of top) {
    if (tag(d) !== 'const') continue;
    for (const c of kids(d)) {
      if (tag(c) !== 'c') continue;
      C.consts.set(C.ref(String(leaf(kids(c)[0]))), exprOf(kids(c)[1], C));
    }
  }

  /* ---- 第三遍：函数与方法的签名 ---------------------------------------------- */
  const routines = top.filter((d) => tag(d) === 'fn' || tag(d) === 'method');
  for (const r of routines) {
    if (tag(r) === 'fn') {
      const name = C.ref(String(leaf(kids(r)[0])));
      C.fns.set(name, sigOf(r, C));
      continue;
    }
    const owner = recvOwner(r, C);
    const m = String(leaf(kids(r)[1]));
    const name = `${owner}__${m}`;
    const sig = sigOf(r, C);
    sig.params = [{ name: C.ref(recvName(r)), type: named(C.ref(owner), true) }, ...sig.params];
    C.fns.set(name, sig);
    C.methods.set(`${C.ref(owner)}.${m}`, { name, params: sig.params, ret: sig.ret });
  }
  /* ---- 第四遍：函数体 -------------------------------------------------------- */
  for (const r of routines) {
    if (tag(r) === 'fn') {
      const name = C.ref(String(leaf(kids(r)[0])));
      decls.push(fnBody(name, C.fns.get(name), part(r, 'block'), null, C));
      continue;
    }
    const owner = recvOwner(r, C);
    const name = `${owner}__${String(leaf(kids(r)[1]))}`;
    decls.push(fnBody(name, C.fns.get(name), part(r, 'block'), owner, C));
  }
  if (!C.fns.has('main')) throw new Error('vlang->IR: 这份源码里没有 `fn main`（V 的入口）');
  return { kind: 'module', decls };
}

/** `pub` / `[attr]` 是包一层（不产生代码），剥到里头那格声明。 */
function unwrap(d) {
  if (tag(d) === 'pub') return kids(d).flatMap(unwrap);
  if (tag(d) === 'attributed') return kids(d).filter((y) => tag(y) !== 'attrs').flatMap(unwrap);
  return [d];
}

/** 一格 `(params …)` + 返回那一格 → 签名。形参名可以没有（`fntype` 里就没有）。 */
function sigOfParts(paramsTok, retTok, C) {
  const ps = paramsTok === undefined ? [] : kids(paramsTok).filter((p) => tag(p) === 'p');
  const params = ps.map((p) => {
    const ks = kids(p);
    const tyTok = ks.find((y) => tag(y) !== null);
    const nm = tag(ks[0]) === null ? String(leaf(ks[0])) : null;
    return { name: nm === null ? C.fresh('p') : C.ref(nm), type: typeOfTok(tyTok, C) };
  });
  return { params, ret: typeOfTok(retTok, C) };
}

/** 一格 `fn` / `method` 的签名（返回那一格紧跟在 `(params …)` 后面）。 */
function sigOf(r, C) {
  const ks = kids(r);
  const pi = ks.findIndex((y) => tag(y) === 'params');
  return sigOfParts(ks[pi], ks[pi + 1], C);
}

const recvP = (r) => kids(part(r, 'recv'))[0];
const recvName = (r) => String(leaf(kids(recvP(r))[0]));
function recvOwner(r, C) {
  const t = typeOfTok(kids(recvP(r)).find((y) => tag(y) !== null), C);
  if (t.kind !== 'named') throw new Error('vlang->IR: 方法的接收者不是一格 struct —— 这一层不猜');
  return t.name;
}

/** 一格函数体（`defer` 在每个出口前**逆序**摊开）。 */
function fnBody(name, sig, blockTok, ownerStruct, C) {
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  const outerCur = C.cur;
  const outerDefers = C.defers;
  C.cur = {
    fn: ownerStruct === null ? name : name.slice(ownerStruct.length + 2),
    struct: ownerStruct,
    ret: sig.ret,
  };
  C.defers = [];
  const stmts = (blockTok === undefined ? [] : kids(blockTok)).flatMap((s) => stmtsOf(s, C));
  const last = stmts[stmts.length - 1];
  if (last === undefined || last.kind !== 'return') stmts.push(...exitStmts(C));
  C.cur = outerCur;
  C.defers = outerDefers;
  C.pop();
  return {
    kind: 'fn', name, params: sig.params, ret: sig.ret, body: stmts,
  };
}

const exitStmts = (C) => [...C.defers].reverse().flat();
const nameRef = (n) => ({ kind: 'name', name: n });
const plus1 = (e) => ({ kind: 'binop', op: '+', left: e, right: { kind: 'int', value: 1 } });

/** 一段块末尾那格**交值**的表达式（印那一族与 `panic` 不算 —— 它们不交值）。 */
function valueTail(s) {
  if (tag(s) !== 'expr') return null;
  const inner = kids(s)[0];
  if (['if', 'match', 'if-bind', 'unsafe', 'ctime'].includes(tag(inner))) return null;
  if (tag(inner) === 'bin' && String(leaf(kids(inner)[0])) === '<<') return null;
  if (tag(inner) === 'call') {
    const f = kids(inner)[0];
    if (tag(f) === 'name' && (PRINTS.has(nameOf(f)) || nameOf(f) === 'panic')) return null;
  }
  return inner;
}

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

export function stmtsOf(x, C) {
  switch (tag(x)) {
    case 'block': return [{ kind: 'block', stmts: C.blockStmts(x) }];
    case 'module': case 'import': case 'struct': case 'enum': case 'typedecl':
    case 'interface': case 'fn': case 'method': case 'const': case 'attributed': case 'pub':
      return [];
    case 'expr': return exprStmts(kids(x)[0], C);
    case 'define': return defineStmts(x, C);
    case 'assign': return assignStmts(x, C);
    case 'inc': return [{ kind: 'assign', target: lhsOf(kids(x)[0], C), value: plus1(exprOf(kids(x)[0], C)) }];
    case 'dec': return [{
      kind: 'assign',
      target: lhsOf(kids(x)[0], C),
      value: { kind: 'binop', op: '-', left: exprOf(kids(x)[0], C), right: { kind: 'int', value: 1 } },
    }];
    case 'if': return ifStmts(x, C);
    case 'match': return matchStmts(x, C);
    case 'if-bind': return ifBindStmts(x, C);
    case 'unsafe': return [{ kind: 'block', stmts: C.blockStmts(part(x, 'block') ?? kids(x)[0]) }];
    case 'ctime': return ctimeStmts(x, C);
    case 'for': return forStmts(x, C);
    case 'for-in': return forInStmts(x, C);
    case 'return': return returnStmts(x, C);
    case 'break': return [{ kind: 'break', label: null }];
    case 'continue': return [{ kind: 'continue', label: null }];
    /* `defer { … }` —— 登记下来，每个出口前逆序摊开（方言里没有作用域出口那一格）。 */
    case 'defer': {
      C.defers.push(C.blockStmts(part(x, 'block') ?? kids(x)[0]));
      return [];
    }
    /* `assert c` —— 方言里没有这一格，按口径拼：印一句再停下来。 */
    case 'assert': {
      const cond = condOf(kids(x)[0], C);
      const msgTok = part(x, 'msg');
      const head = { kind: 'string', value: 'assert failed' };
      const line = msgTok === undefined ? head : {
        kind: 'binop', op: '+',
        left: { kind: 'string', value: 'assert failed: ' },
        right: exprOf(kids(msgTok)[0], C),
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
    default:
      throw new Error(`vlang->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** 语句位置上的表达式：印那一族、`panic`、`xs << v`（追加）各自是一格语句。 */
function exprStmts(inner, C) {
  switch (tag(inner)) {
    case 'if': return ifStmts(inner, C);
    case 'match': return matchStmts(inner, C);
    case 'if-bind': return ifBindStmts(inner, C);
    case 'unsafe': return [{ kind: 'block', stmts: C.blockStmts(part(inner, 'block') ?? kids(inner)[0]) }];
    case 'ctime': return ctimeStmts(inner, C);
    case 'bin': {
      const e = exprOf(inner, C);
      if (e.isStmt === true) return [{ kind: 'builtin-stmt', name: e.name, args: e.args }];
      return [{ kind: 'expr-stmt', expr: e }];
    }
    case 'call': {
      const f = kids(inner)[0];
      const argsTok = part(inner, 'args');
      const as = argsTok === undefined ? [] : kids(argsTok);
      if (tag(f) === 'name' && PRINTS.has(nameOf(f))) {
        if (as.length === 0) return [{ kind: 'print', values: [{ kind: 'string', value: '' }] }];
        return as.map((a) => ({ kind: 'print', values: [exprOf(a, C)] }));
      }
      if (tag(f) === 'name' && nameOf(f) === 'panic') {
        const msg = as.length === 0 ? { kind: 'string', value: 'panic' } : exprOf(as[0], C);
        return [
          { kind: 'print', values: [msg] },
          { kind: 'builtin-stmt', name: 'fail', args: [msg] },
        ];
      }
      return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
    }
    default: return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
  }
}

/** `x := e` / `mut x := e` / `a, b := two()` / `inc := fn …`。 */
function defineStmts(x, C) {
  const targets = kids(part(x, 'lhs'));
  const values = kids(part(x, 'rhs'));
  if (targets.length > 1 && values.length === 1) return destructure(targets, values[0], C);
  const out = [];
  targets.forEach((t, i) => {
    const name = C.ref(nameOf(tag(t) === 'mut' ? kids(t)[0] : t));
    const vTok = values[i];
    /* 函数字面量**提升**成顶层函数 —— 那格名字于是是一格函数名，不是变量。 */
    if (vTok !== undefined && tag(vTok) === 'fnlit') { C.lift(vTok, name); return; }
    const value = exprOf(vTok, C);
    const type = typeOf(value, C.tyCtx());
    C.bind(name, type);
    out.push({ kind: 'let', name, type, init: value });
  });
  return out;
}

/** `a, b := two()`：先落一格记录，再逐格取字段。 */
function destructure(targets, vTok, C) {
  const value = exprOf(vTok, C);
  const ty = typeOf(value, C.tyCtx());
  const tmp = C.fresh('mv_');
  C.bind(tmp, ty);
  const out = [{ kind: 'let', name: tmp, type: ty, init: value }];
  const fs = ty.kind === 'named' ? (C.tyCtx().fields.get(ty.name) ?? []) : [];
  targets.forEach((t, i) => {
    const name = C.ref(nameOf(tag(t) === 'mut' ? kids(t)[0] : t));
    const type = fs[i] === undefined ? INT : fs[i].type;
    C.bind(name, type);
    out.push({
      kind: 'let', name, type, init: { kind: 'field', obj: nameRef(tmp), name: `v${i}` },
    });
  });
  return out;
}

/** 赋值的左边那一格（字典的下标单独一档 —— 它发的是 `dset`）。 */
function lhsOf(t, C) {
  if (tag(t) === 'mut') return lhsOf(kids(t)[0], C);
  if (tag(t) === 'sel') {
    return { kind: 'field', obj: exprOf(kids(t)[0], C), name: String(leaf(kids(t)[1])) };
  }
  if (tag(t) === 'index') {
    const obj = exprOf(kids(t)[0], C);
    const index = exprOf(kids(t)[1], C);
    return { kind: typeOf(obj, C.tyCtx()).kind === 'map' ? 'dict' : 'index', obj, index };
  }
  if (tag(t) === 'name') return nameRef(C.ref(nameOf(t)));
  throw new Error(`vlang->IR: 赋值的左边是 ${tag(t)} —— 还没接`);
}

function assignStmts(x, C) {
  const o = String(leaf(kids(x)[0]));
  const aug = o === '=' ? null : AUG.get(o.replace('=', ''));
  if (o !== '=' && aug === undefined) throw new Error(`vlang->IR: 这个复合赋值还没接：${o}`);
  const targets = kids(part(x, 'lhs'));
  const values = kids(part(x, 'rhs'));
  return targets.map((t, i) => {
    const target = lhsOf(t, C);
    const read = target.kind === 'dict'
      ? { kind: 'builtin', name: 'dget', args: [target.obj, target.index] }
      : target;
    const rhs = exprOf(values[i], C);
    const value = aug === null ? rhs : { kind: 'binop', op: aug, left: read, right: rhs };
    if (target.kind === 'dict') {
      return { kind: 'builtin-stmt', name: 'dset', args: [target.obj, target.index, value] };
    }
    return { kind: 'assign', target, value };
  });
}

function ifStmts(x, C) {
  const cond = condOf(kids(x)[0], C);
  const then = C.blockStmts(kids(x)[1]);
  const elseTok = part(x, 'else');
  let els = null;
  if (elseTok !== undefined) {
    const inner = kids(elseTok)[0];
    els = tag(inner) === 'block' ? C.blockStmts(inner) : stmtsOf(inner, C);
  }
  return [{ kind: 'if', cond, then, else_: els }];
}

/** 语句位置上的 `match` → if 链（每一支的几个值用 `||` 串起来）。 */
function matchStmts(x, C) {
  const { pre, arms, elseBlock } = matchParts(x, C);
  let els = elseBlock === null ? null : C.blockStmts(elseBlock);
  for (let i = arms.length - 1; i >= 0; i--) {
    els = [{
      kind: 'if', cond: arms[i].cond, then: C.blockStmts(arms[i].block), else_: els,
    }];
  }
  return [...pre, ...(els ?? [])];
}

/** `if v := f() { … } else { … }` —— 先落一格量，再按"不是零值"分支（Option 的口径）。 */
function ifBindStmts(x, C) {
  const name = C.ref(String(leaf(kids(x)[0])));
  const value = exprOf(kids(x)[1], C);
  const type = typeOf(value, C.tyCtx());
  C.push();
  C.bind(name, type);
  const blocks = kids(x).slice(2);
  const thenB = blocks.find((y) => tag(y) === 'block');
  const elseTok = blocks.find((y) => tag(y) === 'else');
  const stmts = [
    { kind: 'let', name, type, init: value },
    {
      kind: 'if',
      cond: { kind: 'binop', op: '!=', left: nameRef(name), right: zeroExpr(type) },
      then: C.blockStmts(thenB),
      else_: elseTok === undefined ? null : C.blockStmts(part(elseTok, 'block') ?? kids(elseTok)[0]),
    },
  ];
  C.pop();
  return [{ kind: 'block', stmts }];
}

/** `$if 标志 { … } $else { … }` —— **编译期**：中的那支摊开、别的**整格丢掉**。 */
function ctimeStmts(x, C) {
  const ks = kids(x);
  const which = String(leaf(ks[0]));
  if (which !== '$if') throw new Error(`vlang->IR: 编译期 \`${which}\` 还没接`);
  if (ctCond(ks[1])) return C.blockStmts(ks[2]);
  const elseTok = part(x, 'else');
  if (elseTok === undefined) return [];
  const inner = kids(elseTok)[0];
  return tag(inner) === 'block' ? C.blockStmts(inner) : stmtsOf(inner, C);
}

/** 三段式 `for`（哪一段都可以没有）。 */
function forStmts(x, C) {
  const has = (t) => t !== undefined && kids(t).length > 0 && tag(kids(t)[0]) !== 'none';
  const initTok = part(x, 'init');
  const condTok = part(x, 'cond');
  const postTok = part(x, 'post');
  C.push();
  const init = has(initTok) ? stmtsOf(kids(initTok)[0], C) : [];
  const cond = has(condTok) ? condOf(kids(condTok)[0], C) : null;
  const post = has(postTok) ? stmtsOf(kids(postTok)[0], C) : [];
  const body = C.blockStmts(part(x, 'block'));
  C.pop();
  if (post.length > 1) throw new Error('vlang->IR: for 的步进那一段不止一句 —— 还没接');
  return [...init.slice(0, -1), {
    kind: 'for',
    init: init[init.length - 1] ?? null,
    cond: cond ?? { kind: 'bool', value: true },
    post: post[0] ?? null,
    body,
  }];
}

/**
 * `for x in xs` / `for i, x in xs` / `for i in 0 .. 4`。
 * **表上按键走一遍当场报**：方言里没有能装下那格键列表的类型（只有 `(arr T)`，
 * 而 `keys` 出的是 `list<K>`）—— 要先给方言加一格，是一次语言决定。
 */
function forInStmts(x, C) {
  const names = kids(part(x, 'names')).map((n) => String(leaf(n)));
  const valTok = kids(part(x, 'values'))[0];
  const blockTok = part(x, 'block');
  const step = (n) => ({ kind: 'assign', target: nameRef(n), value: plus1(nameRef(n)) });
  const bindName = (n) => (n === '_' ? C.fresh('skip') : C.ref(n));

  if (tag(valTok) === 'range') {
    /* `0 .. 4` —— 上界**不含**。 */
    const i = bindName(names[0]);
    C.push();
    C.bind(i, INT);
    const body = C.blockStmts(blockTok);
    C.pop();
    return [{
      kind: 'for',
      init: { kind: 'let', name: i, type: INT, init: exprOf(kids(valTok)[0], C) },
      cond: { kind: 'binop', op: '<', left: nameRef(i), right: exprOf(kids(valTok)[1], C) },
      post: step(i),
      body,
    }];
  }
  const pre = [];
  let box = exprOf(valTok, C);
  const t = typeOf(box, C.tyCtx());
  if (t.kind === 'map') {
    throw new Error('vlang->IR: 按键遍历（`for k, v in m`）：方言里没有能装下那格键列表的类型'
      + '（只有 `(arr T)`，而 `keys` 出的是 `list<K>`，它在方言里一个操作都没有）——'
      + ' 要先给方言加一格，是一次语言决定');
  }
  if (t.kind !== 'arr') {
    throw new Error(`vlang->IR: \`for … in\` 只接区间与数组（这一格装的是 ${t.kind}）`);
  }
  if (box.kind !== 'name') {
    const tmp = C.fresh('iter_');
    C.bind(tmp, t);
    pre.push({ kind: 'let', name: tmp, type: t, init: box });
    box = nameRef(tmp);
  }
  /* 一格名字是元素、两格名字是"下标 + 元素"。 */
  const idx = names.length > 1 ? bindName(names[0]) : C.fresh('for_i');
  const elem = names.length > 1 ? bindName(names[1]) : bindName(names[0]);
  C.push();
  C.bind(idx, INT);
  C.bind(elem, t.elem);
  const body = C.blockStmts(blockTok);
  C.pop();
  return [...pre, {
    kind: 'for',
    init: { kind: 'let', name: idx, type: INT, init: { kind: 'int', value: 0 } },
    cond: {
      kind: 'binop', op: '<', left: nameRef(idx),
      right: { kind: 'builtin', name: 'alen', args: [box] },
    },
    post: step(idx),
    body: [
      {
        kind: 'let', name: elem, type: t.elem, init: { kind: 'index', obj: box, index: nameRef(idx) },
      },
      ...body,
    ],
  }];
}

/** `return` —— 多值合成一格记录（`(int, int)` 那种签名落的也是它）。 */
function returnStmts(x, C) {
  const vs = kids(x);
  const pre = exitStmts(C);
  if (vs.length === 0) return [...pre, { kind: 'return', values: [] }];
  if (vs.length === 1) return [...pre, { kind: 'return', values: [exprOf(vs[0], C)] }];
  const parts = vs.map((v) => exprOf(v, C));
  const ty = C.mvType(parts.map((p) => typeOf(p, C.tyCtx())));
  return [...pre, {
    kind: 'return',
    values: [{
      kind: 'new-record',
      type: ty,
      ref: false,
      fields: parts.map((p, i) => ({ name: `v${i}`, value: p })),
    }],
  }];
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. `expr.js` 文件末尾那四条（Option 的近似 · 闭包 · 泛型/接口 · 引用语义）。
//   2. 模块限定的调用（`os.join_path(…)`）当场报 —— 那一族要"真的编 stdlib"那一层。
//   3. `for k, v in m`（表）当场报 —— 见 forInStmts 里那段话，那是一次语言决定。
//   4. `defer` 登记在函数这一层（V 也只允许在函数里）；登记点之前就早退的那种摊不出来。

