// ext/nim/adapter/index.js —— **Nim → 标准 IR**（ADR-0044 第二片第七门）
//
// 替掉 `ext/nim/tograph.js`（801 行）。这一门自己的几条规矩落在这儿：
//   1. **顶层就是语句**（`echo sumto(5)` 写在文件里）—— 所以出一格 `{kind:'main', body}`；
//      同时文件里还能有一格 `proc main()`，那是普通函数（`casefor.nim` 两样都有）。
//   2. **`when` 是编译期分支**：按一张定死的环境表求值，中的那支摊开、别的**整格丢掉**
//      （nim 明说没走的那支不要求编得过）。表在 `NIM_CT_ENV` 里，与 `ext/vlang` 同一条口径。
//   3. **`defer:` 逆序**：出口前把登记过的那几段按逆序摊开（`return` 那一处也要）。
//      方言里没有"作用域出口"那一格，这一手与 freebasic 的析构、mojo 的 `with` 是同一招。
//   4. **`case` 的分支左边能是区间**（`of 0 .. 59:`）—— 落成两格比较 `and` 起来；
//      还能有 **`elif`**（走自己的条件，不是"主语等于什么"）。
//   5. **`for` 只接两种**：区间（`0 ..< 4`）与序列（`for x in xs`）。表上按键走一遍
//      （`for k in m`）**当场报** —— 方言里没有能装下那格键列表的类型，那是一次语言决定。
//   6. **末尾表达式是返回值**（`proc addTo(a, b: int): int = a + b`）。

import { tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import { INT, named, typeOf } from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfTok, nameOf,
} from './expr.js';

/** 复合赋值里认得的那几个算符（`+=` / `-=` / `*=`）。 */
const AUG = new Map([['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['&', '+']]);

/**
 * **声明过的编译期环境**（`when defined(x)`）—— 照搬 `ext/nim/tograph.js` 那一份：
 * 定死一个参考目标（linux · x64 · gcc），不看跑在哪台机器上（**尺子要可重现**）。
 * 不在表里的名字**当场报**：这一层看不见命令行上的 `-d`，猜 false 就会静静丢掉一段代码。
 */
const NIM_CT_ENV = new Map(Object.entries({
  linux: true, posix: true, unix: true, gcc: true, cpu64: true, littleEndian: true,
  windows: false, macosx: false, macos: false, osx: false, bsd: false, freebsd: false,
  openbsd: false, netbsd: false, android: false, ios: false, haiku: false, genode: false,
  js: false, nimscript: false, nimvm: false, cpp: false, objc: false, emscripten: false,
  release: false, danger: false, debug: true, useMalloc: false, gcArc: false, gcOrc: false,
  windowsHasEnvironmentVariables: false, cpu32: false, bigEndian: false, clang: false,
  vcc: false, tcc: false, icl: false, nimHasStyleChecks: true,
  nimPreviewSlimSystem: true, hasThreads: false, useRef: false,
  isDebug: true, hasRstdin: false,
}));

/** `when` 的条件求值。认不出来的形状**当场报**（不猜）。 */
function whenCond(c) {
  const t = tag(c);
  if (t === 'paren') return whenCond(kids(c)[0]);
  if (t === 'un' && ['not', '!'].includes(String(leaf(kids(c)[0])))) return !whenCond(kids(c)[1]);
  if (t === 'bin') {
    const o = String(leaf(kids(c)[0]));
    if (o === 'and' || o === '&&') return whenCond(kids(c)[1]) && whenCond(kids(c)[2]);
    if (o === 'or' || o === '||') return whenCond(kids(c)[1]) || whenCond(kids(c)[2]);
  }
  if (t === 'name' || t === 'n') {
    const nm = nameOf(c);
    if (nm === 'true') return true;
    if (nm === 'false') return false;
    if (NIM_CT_ENV.has(nm)) return NIM_CT_ENV.get(nm) === true;
    throw new Error(`nim->IR: \`when\` 的条件里有 \`${nm}\` —— 不在声明过的那张表里（NIM_CT_ENV）`);
  }
  if (t === 'call' || t === 'command') {
    const fn = kids(c)[0];
    const args = part(c, 'args');
    if (nameOf(fn) === 'defined' && args !== undefined) {
      const nm = nameOf(kids(args)[0]);
      if (NIM_CT_ENV.has(nm)) return NIM_CT_ENV.get(nm) === true;
      throw new Error(`nim->IR: \`defined(${nm})\` 不在声明过的那张表里（NIM_CT_ENV）——`
        + ' 这一层看不见命令行上的 -d，猜 false 就会静静丢掉一段代码');
    }
  }
  throw new Error(`nim->IR: \`when\` 的条件是 \`${t}\` 这个形状 —— 只接 defined() 与`
    + ' and / or / not 拼起来的那几种');
}

/**
 * 一棵 nim 的树（`(module …)`）→ 标准 IR 的模块。
 *
 * `opts.also` 是**旁边那几份 import 进来的同语言文件**（依赖在前，由 `drive.js` 读好）。
 * 处理办法只有一条：把它们的顶层形式摆在这一份**前面**，别的一模一样 ——
 * 于是声明互相看得见，而"被 import 的那份文件的顶层语句先跑"也正好是 nim 的语义。
 */
export function nimToIR(tree, opts = {}) {
  const asModule = (t) => {
    if (tag(t) !== 'module') throw new Error('nim->IR: 这不是 (module …)');
    return kids(t);
  };
  const forms = [...(opts.also ?? []), tree].flatMap(asModule);
  let tmpN = 0;
  const names = new Map();
  const scopes = [new Map()];
  const recFields = new Map();
  const mvs = new Map();
  const decls = [];
  const C = {
    /** `type X = object` 登记过的那些（名字 → { name, fields }）。 */
    records: new Map(),
    /** `type X = int` 那一族（名字 → 类型）。 */
    aliases: new Map(),
    fns: new Map(),
    /** 现在这一层登记过的 `defer:`（出口前**逆序**摊开）。 */
    defers: [],
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
    /** N 格类型 → 一格合成的记录（元组就是这么落的：`(int, int)` → `mv1`）。 */
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

  /* ---- 第一遍：`type` 段（对象 → 记录、别名 → 类型）-------------------------- */
  for (const f of forms) {
    if (tag(f) !== 'type-section') continue;
    for (const d of kids(f)) {
      if (tag(d) !== 'tdef') continue;
      const name = nameOf(kids(d).find((y) => tag(y) === 'n'));
      const obj = part(d, 'object');
      if (obj === undefined) {
        /* `type Count = int` —— 别名（这一层只接标量与已登记的类型）。 */
        const rhs = kids(d).find((y) => tag(y) !== 'n');
        if (rhs !== undefined) C.aliases.set(name, typeOfTok(rhs, C));
        continue;
      }
      C.records.set(name, { name, fields: [] });
    }
  }
  /* 字段表要**先全登记**（一个记录的字段可能是另一个记录）。 */
  for (const f of forms) {
    if (tag(f) !== 'type-section') continue;
    for (const d of kids(f)) {
      const obj = part(d, 'object');
      if (tag(d) !== 'tdef' || obj === undefined) continue;
      const name = nameOf(kids(d).find((y) => tag(y) === 'n'));
      const fields = [];
      for (const fld of kids(obj)) {
        if (tag(fld) !== 'f') continue;
        const ns = part(fld, 'names');
        const ty = typeOfTok(kids(fld).find((y) => tag(y) !== 'names'), C);
        for (const one of kids(ns)) fields.push({ name: nameOf(one), type: ty });
      }
      C.records.get(name).fields = fields;
      recFields.set(C.ref(name), fields);
      decls.push({ kind: 'class', name: C.ref(name), fields });
    }
  }

  /* ---- 第二遍：proc 的签名（体里会互相调，`fact` 还自己调自己）--------------- */
  const routines = forms.filter((f) => tag(f) === 'routine');
  for (const r of routines) {
    const s = sigOf(r, C);
    C.fns.set(C.ref(s.name), { params: s.params, ret: s.ret });
  }
  /* ---- 第三遍：proc 的体 ---------------------------------------------------- */
  for (const r of routines) decls.push(fnDecl(r, C));

  /* ---- 顶层语句（`echo …` / `var …` 那些）就是入口 -------------------------- */
  const top = forms.filter((f) => !['routine', 'type-section'].includes(tag(f)));
  const body = top.flatMap((s) => stmtsOf(s, C));
  if (body.length > 0) decls.push({ kind: 'main', body });
  return { kind: 'module', decls };
}

/**
 * **这份文件 import 了哪几格模块**（驱动那一层拿它去旁边找同名的 `.nim`）。
 * `import util` -> `util`；`import tables` 也回 `tables`，可旁边没有 `tables.nim`，
 * 于是照旧交给 adapter —— 标准库那一族是这么落的（`drive.js` 里那段话）。
 */
export function nimImports(tree) {
  const out = [];
  const walk = (x) => {
    if (tag(x) === 'line') { kids(x).forEach(walk); return; }
    if (tag(x) !== 'import') return;
    for (const k of kids(x)) {
      const n = nameOf(k);
      if (n !== '') out.push(n);
    }
  };
  kids(tree).forEach(walk);
  return out;
}

/** 一格 proc 的签名（`(sig (形参…) 返回 (pragma) (impl …))`）。 */
function sigOf(r, C) {
  const name = nameOf(kids(r).find((y) => tag(y) === 'n' || tag(y) === 'name'));
  const sig = part(r, 'sig');
  /* **形参在第一格无名表里**（空的时候也在，`(sig () (none) () (impl …))`）。 */
  const group = sig === undefined ? undefined : kids(sig).find((y) => tag(y) === null);
  const ps = group === undefined ? [] : group.items.filter((y) => tag(y) === 'p');
  const params = [];
  for (const p of ps) {
    /* `(p (names (n a) (n b)) (name int))` —— 一格标注能带好几个名字。 */
    const ns = part(p, 'names');
    const ty = typeOfTok(kids(p).find((y) => tag(y) !== 'names'), C);
    for (const one of (ns === undefined ? [kids(p)[0]] : kids(ns))) {
      params.push({ name: C.ref(nameOf(one)), type: ty });
    }
  }
  const retTok = sig === undefined ? undefined : kids(sig)[1];
  return { name, params, ret: typeOfTok(retTok, C) };
}

/** `echo` 那一族（它们不交值，是语句）。 */
const PRINTS = new Set(['echo']);
const isEcho = (x) => ['call', 'command'].includes(tag(x)) && PRINTS.has(nameOf(kids(x)[0]));

/** 一格 proc（体末尾的表达式是返回值；`defer:` 在每个出口前**逆序**摊开）。 */
function fnDecl(r, C) {
  const s = sigOf(r, C);
  C.push();
  for (const p of s.params) C.bind(p.name, p.type);
  const outer = C.defers;
  C.defers = [];
  const sig = part(r, 'sig');
  const impl = (sig === undefined ? undefined : part(sig, 'impl')) ?? part(r, 'impl');
  const bodyTok = impl === undefined ? undefined : part(impl, 'body');
  const items = bodyTok === undefined ? [] : kids(bodyTok);
  const stmts = [];
  items.forEach((it, i) => {
    /* **末尾的表达式就是返回值**（`proc addTo(a, b: int): int = a + b`）。 */
    const tail = i === items.length - 1 && s.ret.kind !== 'void' ? valueTail(it) : null;
    if (tail !== null) {
      stmts.push(...exitStmts(C), { kind: 'return', values: [exprOf(tail, C)] });
      return;
    }
    stmts.push(...stmtsOf(it, C));
  });
  /* 没早退的那条路也要摊一遍（`demo()` 走到底也得印 b / a）。 */
  const last = stmts[stmts.length - 1];
  if (last === undefined || last.kind !== 'return') stmts.push(...exitStmts(C));
  C.defers = outer;
  C.pop();
  return {
    kind: 'fn', name: C.ref(s.name), params: s.params, ret: s.ret, body: stmts,
  };
}

/** 这一格是"当返回值的末尾表达式"吗（`echo …` 不算 —— 它不交值）。 */
function valueTail(x) {
  if (tag(x) === 'line' && kids(x).length === 1) return valueTail(kids(x)[0]);
  if (tag(x) !== 'expr') return null;
  const inner = kids(x)[0];
  return isEcho(inner) ? null : inner;
}

/** 登记过的 `defer:` —— **逆序**摊开。 */
const exitStmts = (C) => [...C.defers].reverse().flat();

/** `(body …)` 里那一串语句（自己一层作用域）。 */
function bodyStmts(tok, C) {
  if (tok === undefined || tok === null) return [];
  C.push();
  const out = kids(tok).flatMap((s) => stmtsOf(s, C));
  C.pop();
  return out;
}

const nameRef = (n) => ({ kind: 'name', name: n });
const plus1 = (e) => ({ kind: 'binop', op: '+', left: e, right: { kind: 'int', value: 1 } });

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

export function stmtsOf(x, C) {
  switch (tag(x)) {
    case 'line': case 'body': case 'impl': return kids(x).flatMap((k) => stmtsOf(k, C));
    case 'import': case 'export': case 'include': case 'type-section': return [];
    case 'expr': {
      const inner = kids(x)[0];
      if (isEcho(inner)) {
        const args = part(inner, 'args');
        const as = args === undefined ? [] : kids(args);
        if (as.length === 0) return [{ kind: 'print', values: [{ kind: 'string', value: '' }] }];
        /* `echo a, b` —— nim 把几格**直接接起来**（中间不加分隔符）。 */
        const vals = as.map((a) => {
          const e = exprOf(a, C);
          return typeOf(e, C.tyCtx()).kind === 'string' ? e : { kind: 'builtin', name: 'tostr', args: [e] };
        });
        const one = vals.reduce((acc, v) => ({ kind: 'binop', op: '+', left: acc, right: v }));
        return [{ kind: 'print', values: [as.length === 1 ? exprOf(as[0], C) : one] }];
      }
      return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
    }
    /* `discard f()` —— **算掉、把值扔了**。带作用的那一格（调用）留下。 */
    case 'discard': {
      const e = kids(x)[0];
      return e === undefined ? [] : [{ kind: 'expr-stmt', expr: exprOf(e, C) }];
    }
    case 'var-section': case 'let-section': case 'const-section': return sectionStmts(x, C);
    case 'assign': return [assignStmt(x, C)];
    case 'while': {
      const cond = condOf(kids(x)[0], C);
      return [{ kind: 'while', cond, body: bodyStmts(part(x, 'body'), C) }];
    }
    /* `(if c (body…) (elifs [(elif c (body…))…]) [(else (body…))])`。 */
    case 'if': {
      const cond = condOf(kids(x)[0], C);
      const then = bodyStmts(kids(x)[1], C);
      const elseTok = part(x, 'else');
      let els = elseTok === undefined ? null : bodyStmts(part(elseTok, 'body'), C);
      const elifs = part(x, 'elifs');
      const es = elifs === undefined ? [] : kids(elifs);
      for (let i = es.length - 1; i >= 0; i--) {
        els = [{
          kind: 'if',
          cond: condOf(kids(es[i])[0], C),
          then: bodyStmts(part(es[i], 'body'), C),
          else_: els,
        }];
      }
      return [{ kind: 'if', cond, then, else_: els }];
    }
    case 'case': return caseStmts(x, C);
    case 'for': return forStmts(x, C);
    /**
     * `when` —— **编译期分支**：按 NIM_CT_ENV 求值，中的那支摊开、别的**整格丢掉**
     * （nim 明说没走的那支不要求编得过，所以不能当运行期的 if 落）。
     */
    case 'when': {
      if (whenCond(kids(x)[0])) return bodyStmts(part(x, 'body'), C);
      const elifs = part(x, 'elifs');
      for (const e of (elifs === undefined ? [] : kids(elifs))) {
        if (whenCond(kids(e)[0])) return bodyStmts(part(e, 'body'), C);
      }
      const els = part(x, 'else');
      return els === undefined ? [] : bodyStmts(part(els, 'body') ?? kids(els)[0], C);
    }
    /* `block:` —— 一段带自己作用域的语句（里外同名的 `x` 是两格）。 */
    case 'block': {
      const outer = C.defers;
      C.defers = [];
      const inner = bodyStmts(part(x, 'body'), C);
      const tail = exitStmts(C);
      C.defers = outer;
      return [{ kind: 'block', stmts: [...inner, ...tail] }];
    }
    /* `defer: …` —— 登记下来，每个出口前**逆序**摊开（方言里没有作用域出口那一格）。 */
    case 'defer': {
      C.defers.push(bodyStmts(part(x, 'body') ?? kids(x)[0], C));
      return [];
    }
    case 'return': {
      const vs = kids(x);
      return [...exitStmts(C), { kind: 'return', values: vs.length === 0 ? [] : [exprOf(vs[0], C)] }];
    }
    case 'break': return [{ kind: 'break', label: null }];
    case 'continue': return [{ kind: 'continue', label: null }];
    case 'routine':
      throw new Error('nim->IR: proc 里套 proc（闭包）还没接');
    default:
      throw new Error(`nim->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** `var a = 1` / `let (lo, hi) = f()` / `var x: int` —— 一段里能有好几格。 */
function sectionStmts(x, C) {
  const out = [];
  for (const it of kids(x)) {
    if (tag(it) === 'untuple') { out.push(...destructure(it, C)); continue; }
    if (tag(it) !== 'item') throw new Error(`nim->IR: ${tag(x)} 里这一格还没接：${tag(it)}`);
    const ns = part(it, 'names');
    const initTok = part(it, 'init');
    const tyTok = kids(it).find((y) => !['names', 'init'].includes(tag(y)));
    const value = initTok === undefined ? null : exprOf(kids(initTok)[0], C);
    /* 标注优先；没标注就看初值装的是什么（`var acc = 0` → int）。 */
    const type = tyTok !== undefined
      ? typeOfTok(tyTok, C)
      : (value === null ? INT : typeOf(value, C.tyCtx()));
    for (const one of kids(ns)) {
      const name = C.ref(nameOf(one));
      C.bind(name, type);
      out.push({ kind: 'let', name, type, init: value });
    }
  }
  return out;
}

/** `let (lo, hi) = f()`：N 个名字对 1 个右值 —— 先落一格记录，再逐格取字段。 */
function destructure(u, C) {
  const initTok = part(u, 'init');
  if (initTok === undefined) throw new Error('nim->IR: `let (a, b)` 后面没有初值');
  const value = exprOf(kids(initTok)[0], C);
  const ty = typeOf(value, C.tyCtx());
  const tmp = C.fresh('mv_');
  C.bind(tmp, ty);
  const out = [{ kind: 'let', name: tmp, type: ty, init: value }];
  const fs = ty.kind === 'named' ? (C.tyCtx().fields.get(ty.name) ?? []) : [];
  kids(part(u, 'names')).forEach((n, i) => {
    const name = C.ref(nameOf(n));
    const type = fs[i] === undefined ? INT : fs[i].type;
    C.bind(name, type);
    out.push({
      kind: 'let', name, type, init: { kind: 'field', obj: nameRef(tmp), name: `v${i}` },
    });
  });
  return out;
}

/** 赋值的左边那一格（字典的下标单独一档 —— 它发的是 `dset`，不是 `aset`）。 */
function lhsOf(lhs, C) {
  if (tag(lhs) === 'dot') {
    return { kind: 'field', obj: exprOf(kids(lhs)[0], C), name: String(leaf(kids(lhs)[1])) };
  }
  if (tag(lhs) === 'bracket') {
    const obj = exprOf(kids(lhs)[0], C);
    const index = exprOf(kids(part(lhs, 'args'))[0], C);
    const t = typeOf(obj, C.tyCtx());
    return { kind: t.kind === 'map' ? 'dict' : 'index', obj, index };
  }
  if (tag(lhs) === 'name' || tag(lhs) === 'n') return nameRef(C.ref(nameOf(lhs)));
  throw new Error(`nim->IR: 赋值的左边是 ${tag(lhs)} —— 还没接`);
}

/** `x = e` / `x += e` / `p.y = 5` / `xs[1] = 5` / `m["a"] = 1`。 */
function assignStmt(x, C) {
  const [opTok, lhs, rhs] = kids(x);
  const o = String(leaf(opTok));
  const aug = o === '=' ? null : AUG.get(o.replace('=', ''));
  if (o !== '=' && aug === undefined) throw new Error(`nim->IR: 这个复合赋值还没接：${o}`);
  const target = lhsOf(lhs, C);
  const read = target.kind === 'dict'
    ? { kind: 'builtin', name: 'dget', args: [target.obj, target.index] }
    : target;
  const value = aug === null
    ? exprOf(rhs, C)
    : { kind: 'binop', op: aug, left: read, right: exprOf(rhs, C) };
  if (target.kind === 'dict') {
    return { kind: 'builtin-stmt', name: 'dset', args: [target.obj, target.index, value] };
  }
  return { kind: 'assign', target, value };
}

/**
 * `case` → if 链。nim 在这一处有两样别人没有的：
 *   * 分支左边能是**区间**（`of 0 .. 59:`）—— 落成两格比较 `and` 起来；
 *   * 分支里能有 **`elif`** —— 它走**自己的条件**，不是"主语等于什么"。
 */
function caseStmts(x, C) {
  const pre = [];
  let value = exprOf(kids(x)[0], C);
  /* 主语不是一格名字就先落一格临时量 —— 每个分支都要读它一遍。 */
  if (value.kind !== 'name') {
    const tmp = C.fresh('case_');
    const t = typeOf(value, C.tyCtx());
    C.bind(tmp, t);
    pre.push({ kind: 'let', name: tmp, type: t, init: value });
    value = nameRef(tmp);
  }
  const arms = [];
  let els = null;
  for (const a of kids(x).slice(1)) {
    const body = bodyStmts(part(a, 'body'), C);
    if (tag(a) === 'else') { els = body; continue; }
    if (tag(a) === 'elif') { arms.push([condOf(kids(a)[0], C), body]); continue; }
    if (tag(a) !== 'of') throw new Error(`nim->IR: case 里这一格还没接：${tag(a)}`);
    const vals = part(a, 'values');
    if (vals === undefined) throw new Error('nim->IR: of 里没有 (values …)');
    const cond = kids(vals).map((v) => matchCond(value, v, C))
      .reduce((acc, c) => ({ kind: 'binop', op: '||', left: acc, right: c }));
    arms.push([cond, body]);
  }
  let out = els;
  for (let i = arms.length - 1; i >= 0; i--) {
    out = [{ kind: 'if', cond: arms[i][0], then: arms[i][1], else_: out }];
  }
  return [...pre, ...(out ?? [])];
}

/** 一格 `of` 的值：区间是两格比较，别的就是相等。 */
function matchCond(value, v, C) {
  if (tag(v) === 'bin' && ['..', '..<'].includes(String(leaf(kids(v)[0])))) {
    const [opTok, loTok, hiTok] = kids(v);
    return {
      kind: 'binop',
      op: '&&',
      left: { kind: 'binop', op: '>=', left: value, right: exprOf(loTok, C) },
      right: {
        kind: 'binop',
        op: String(leaf(opTok)) === '..' ? '<=' : '<',
        left: value,
        right: exprOf(hiTok, C),
      },
    };
  }
  return { kind: 'binop', op: '==', left: value, right: exprOf(v, C) };
}

/**
 * `for x in …` —— **只接两种**：区间（`0 ..< 4` / `0 .. 3`）与序列。
 * 表上按键走一遍（`for k in t`）当场报：方言里没有能装下那格键列表的类型
 * （只有 `(arr T)`，而 `keys` 出的是 `list<K>`）—— 要先给方言加一格，是一次语言决定。
 */
function forStmts(x, C) {
  const nms = part(x, 'names') ?? part(x, 'untuple');
  const bodyTok = kids(x).find((y) => tag(y) === 'body');
  const subj = kids(x).find((y) => !['names', 'untuple', 'body'].includes(tag(y)));
  if (nms === undefined || subj === undefined) throw new Error('nim->IR: for 缺名字或缺主语');
  const vars = kids(nms).map((y) => C.ref(nameOf(y)));
  const step = (n) => ({ kind: 'assign', target: nameRef(n), value: plus1(nameRef(n)) });

  /* 区间：上界含不含由那个算符说（`..` 含、`..<` 不含）。 */
  if (tag(subj) === 'bin' && ['..', '..<'].includes(String(leaf(kids(subj)[0])))) {
    if (vars.length !== 1) throw new Error('nim->IR: 区间上只能走一格名字');
    const [opTok, loTok, hiTok] = kids(subj);
    const i = vars[0];
    const init = { kind: 'let', name: i, type: INT, init: exprOf(loTok, C) };
    const cond = {
      kind: 'binop',
      op: String(leaf(opTok)) === '..' ? '<=' : '<',
      left: nameRef(i),
      right: exprOf(hiTok, C),
    };
    C.push();
    C.bind(i, INT);
    const inner = bodyStmts(bodyTok, C);
    C.pop();
    return [{
      kind: 'for', init, cond, post: step(i), body: inner,
    }];
  }

  const pre = [];
  let box = exprOf(subj, C);
  const t = typeOf(box, C.tyCtx());
  if (t.kind === 'map') {
    throw new Error('nim->IR: 按键遍历（`for k in t`）：方言里没有能装下那格键列表的类型'
      + '（只有 `(arr T)`，而 `keys` 出的是 `list<K>`，它在方言里一个操作都没有）——'
      + ' 要先给方言加一格，是一次语言决定');
  }
  if (t.kind !== 'arr') {
    throw new Error(`nim->IR: \`for … in\` 只接区间与序列（这一格装的是 ${t.kind}）—— `
      + '串上按字符走要 char 那一格、别的要迭代器');
  }
  if (vars.length !== 1) throw new Error('nim->IR: `for i, x in xs`（带下标）还没接');
  /* 主语不是一格名字就先落一格临时量（条件与体各读它一遍）。 */
  if (box.kind !== 'name') {
    const tmp = C.fresh('iter_');
    C.bind(tmp, t);
    pre.push({ kind: 'let', name: tmp, type: t, init: box });
    box = nameRef(tmp);
  }
  const idx = C.fresh('for_i');
  C.push();
  C.bind(idx, INT);
  C.bind(vars[0], t.elem);
  const inner = bodyStmts(bodyTok, C);
  C.pop();
  return [...pre, {
    kind: 'for',
    init: { kind: 'let', name: idx, type: INT, init: { kind: 'int', value: 0 } },
    cond: {
      kind: 'binop',
      op: '<',
      left: nameRef(idx),
      right: { kind: 'builtin', name: 'alen', args: [box] },
    },
    post: step(idx),
    body: [
      {
        kind: 'let', name: vars[0], type: t.elem, init: { kind: 'index', obj: box, index: nameRef(idx) },
      },
      ...inner,
    ],
  }];
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 闭包 / 迭代器 / 模板 / 宏没接；`result` 那格隐式变量也没接。
//   2. `for k in t`（表）当场报 —— 见 forStmts 里那段话，那是一次语言决定。
//   3. `defer:` 登记在**它所在的那一层**，摊开的位置是"出口前"；登记点之前就早退的
//      那种（`if …: return` 写在 `defer:` 上面）这一层摊不出来 —— 例子里没有那种写法。
//   4. object 落成方言的 `(class …)`（引用语义）。nim 的 object 是值语义 ——
//      整格赋值（`var q = p` 之后改 q 不该动 p）这一批没有判据，明说记着。

