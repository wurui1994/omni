// ext/chez/adapter/index.js —— **Scheme（Chez）→ 标准 IR**（ADR-0044 第二片第二门）
//
// 替掉 `ext/chez/tograph.js`（232 行）。这一门比 awk 难的不是语法，是**它什么都是表达式**
// 加上**它一个类型都不写**：
//
//   1. `if` / `let` / `begin` 交一个值 → 公共降级器的 `if-expr` / `block-expr`（临时量 + 语句槽）；
//   2. 内层 `define` 会捕获外层的名字 → 这一份自己做**函数提升**（把捕获的名字补成形参）。
//      从前这一格是 `backend-core.js` 替十一门语言一起做的；
//   3. 类型 → `types.js`（这门语言自己的账，见那份文件头的四条取舍）；
//   4. 名字里的 `-` / `?` / `!` 方言那侧不认 → `ref()` 把它们改成 `_`
//      （**这一格顺手修了一个真错**：`intmath.ss` 从前落出 `(fn sum-go …)`，下游读不了，
//      `omni run ext/chez/examples/intmath.ss` 在 HEAD 上就是红的）。
//
// 一门语言一个目录（ADR-0044 §2 那条）：`index.js` 管顶层与提升，`expr.js` 管表达式，
// `types.js` 管类型账。

import { head, kids, text, symName, asList } from '../../../src/core/lower/cst.js';
import {
  INT, STR, arrOf, dictOf, named, typeOf, sameType,
} from '../../../src/core/lower/ty-of.js';
import { exprOf, condOf, seqExpr, letExpr, tyArg } from './expr.js';

/* ─── 记录（`define-record-type` 一句话生成一族名字）───────────────────────── */

/**
 * 两种写法都收，因为它们**在同一门语言里都合法**（与从前那份映射一字不改地继承）：
 *   R6RS：`(define-record-type point (fields x y))` —— 名字是**生成**的
 *         （`make-point` / `point-x` / `point-x-set!`）；
 *   R7RS：`(define-record-type point (make-point x y) point? (x point-x set-point-x!) …)`
 *         —— 名字**写在形式里**。
 */
function defRecord(rest, C) {
  const name = symName(rest[0]) ?? symName((asList(rest[0]) ?? [])[0]);
  if (name === null) throw new Error('chez->IR: define-record-type 的名字那一格还没接');
  const ctor = asList(rest[1]);
  if (ctor !== null && symName(ctor[0]) !== null && symName(ctor[0]) !== 'fields') {
    const fields = ctor.slice(1).map((f) => symName(f)).filter((s) => s !== null);
    C.records.fields.set(name, fields);
    C.records.maker.set(symName(ctor[0]), name);
    for (const cl of rest.slice(3)) {
      const c = asList(cl) ?? [];
      const f = symName(c[0]);
      if (f === null) continue;
      if (symName(c[1]) !== null) C.records.access.set(symName(c[1]), f);
      if (symName(c[2]) !== null) C.records.setter.set(symName(c[2]), f);
    }
    return;
  }
  const fieldsClause = rest.slice(1).map((c) => asList(c) ?? [])
    .find((c) => symName(c[0]) === 'fields') ?? [];
  const fields = fieldsClause.slice(1).map((f) => symName(f) ?? symName((asList(f) ?? [])[1]))
    .filter((s) => s !== null);
  C.records.fields.set(name, fields);
  C.records.maker.set(`make-${name}`, name);
  for (const f of fields) {
    C.records.access.set(`${name}-${f}`, f);
    C.records.setter.set(`${name}-${f}-set!`, f);
  }
}

/* ─── 走 datum 收名字（提升与"全局还是局部"两处要它）───────────────────────── */

/**
 * 一段 datum 里出现过的**符号**（名字）。
 *
 * 收一棵 datum、也收**一串** datum（`[form, form]`）。自己走 `items`，不走 `kids` ——
 * `kids` 会把头上那一格当标签丢掉，而一串里的第一格是真的一格形式（踩过一次：
 * `go` 的体只有一格 `if`，被丢掉之后捕获算成了空，提升出来的函数少一格形参）。
 */
function symsIn(x, out = new Set()) {
  if (x === null || x === undefined) return out;
  if (Array.isArray(x)) { for (const y of x) symsIn(y, out); return out; }
  if (x.kind === 'list') {
    if (head(x) === 'sym') { out.add(text(x)); return out; }
    for (const it of x.items) symsIn(it, out);
    return out;
  }
  return out;
}

/** 一段体里的内层 `define`（`(define (g …) …)` 与 `(define x e)` 两种）。 */
function innerDefines(forms) {
  const out = [];
  for (const f of forms) {
    const items = asList(f);
    if (items === null || symName(items[0]) !== 'define') continue;
    const target = items[1];
    const inner = asList(target);
    out.push(inner === null
      ? { name: symName(target), params: null, body: items.slice(2), form: f }
      : { name: symName(inner[0]), params: inner.slice(1).map((p) => symName(p)), body: items.slice(2), form: f });
  }
  return out;
}

/* ─── 主入口 ──────────────────────────────────────────────────────────────── */

/**
 * 一棵 chez 的 GLR 树（`(program datum…)`）→ 标准 IR 的模块。
 * 收不下的形状**当场报**（不猜、不静默）—— 与语法那一侧同一条纪律。
 */
export function chezToIR(tree) {
  if (head(tree) !== 'program') throw new Error('chez->IR: 这不是 (program …)');
  const forms = kids(tree);

  /* ---- adapter 的上下文（一份源码一份 —— 表不许跨文件串味）------------------ */
  let tmpN = 0;
  const names = new Map();              // Scheme 的名字 -> 方言认的名字
  const scopes = [new Map()];           // 名字 -> 类型（局部那几层）
  const globals = new Map();            // 名字 -> 类型
  const C = {
    records: { fields: new Map(), maker: new Map(), access: new Map(), setter: new Map() },
    fns: new Map(),                     // 名字（改过的）-> { params, ret }
    captures: new Map(),                // 被提升的函数 -> 要补的那几格实参（Scheme 原名）
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
    /** Scheme 的名字 → 方言认得的名字（`-` / `?` / `!` / `*` 一律改成 `_`）。 */
    ref: (n) => {
      if (n === null || n === undefined) return n;
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
    /** 类型账要的那三张表（`types.js` 的 `typeOf` 收它）。 */
    tyCtx: () => ({
      env: {
        get: (n) => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            const v = scopes[i].get(n);
            if (v !== undefined) return v;
          }
          return globals.get(n);
        },
      },
      fns: C.fns,
      fields: recFields,
    }),
    stmtOf: (f) => stmtOf(f, C),
    mvType: (types) => mvType(types),
  };

  /* 记录的字段表（方言那侧要的形状：`[{ name, type }]`）。 */
  const recFields = new Map();
  /* 多值那一族合成出来的记录（按"几个值 × 各自类型"去重）。 */
  const mvs = new Map();
  const decls = [];

  function mvType(types) {
    const key = types.map((t) => JSON.stringify(t)).join(',');
    if (!mvs.has(key)) {
      const name = `mv${mvs.size + 1}`;
      mvs.set(key, name);
      const fields = types.map((t, i) => ({ name: `v${i}`, type: t }));
      recFields.set(name, fields);
      decls.push({ kind: 'struct', name, fields });
    }
    return named(mvs.get(key));
  }

  /* ---- 第一遍：记录的声明（表达式要用它）------------------------------------ */
  for (const f of forms) {
    const items = asList(f);
    if (items !== null && symName(items[0]) === 'define-record-type') defRecord(items.slice(1), C);
  }
  for (const [rec, fields] of C.records.fields) {
    /* 字段的类型这一批一律 int（见 types.js 第 3 条）—— 构造器的实参类型在
       `new-record` 那一格会对上；不对上的话方言那侧当场报，不会静静错。 */
    const fs = fields.map((n) => ({ name: n, type: INT }));
    recFields.set(C.ref(rec), fs);
    decls.push({ kind: 'class', name: C.ref(rec), fields: fs });
  }

  /* ---- 第二遍：顶层的 `define` 分三类（函数 / 变量 / 别的都是入口里的语句）---- */
  const topFns = [];
  const topVars = [];
  const mainForms = [];
  for (const f of forms) {
    const items = asList(f);
    const op = items === null ? null : symName(items[0]);
    if (op === 'define-record-type') continue;
    if (op === 'define') {
      const target = items[1];
      const inner = asList(target);
      if (inner !== null) {
        topFns.push({
          name: symName(inner[0]),
          params: inner.slice(1).map((p) => symName(p)),
          body: items.slice(2),
        });
        continue;
      }
      topVars.push({ name: symName(target), init: items[2] });
      continue;
    }
    mainForms.push(f);
  }

  /* 顶层变量：**被函数体引到的才是全局**，别的就是入口里的一格局部量
     （与从前那条路的落点相同：`index.ss` 的 `xs` 是全局、`mut.ss` 的 `n` 不是）。 */
  const inFnBodies = new Set();
  for (const fn of topFns) for (const s of symsIn(fn.body)) inFnBodies.add(s);
  const globalNames = new Set(topVars.filter((v) => inFnBodies.has(v.name)).map((v) => v.name));

  /* 函数签名先登记（互相调用要它）：形参这一批按 int，回什么等体译完才知道。 */
  for (const fn of topFns) {
    C.fns.set(C.ref(fn.name), {
      params: fn.params.map((p) => ({ name: C.ref(p), type: INT })),
      ret: INT,
    });
  }

  /* ---- 顶层变量的类型：按初值算（全局要先登记，函数体里会引到）-------------- */
  const varInit = [];          // 入口开头那几句
  const mainLocals = [];       // 入口里那几格局部量（名字 + 类型）
  for (const v of topVars) {
    C.push();
    const init = v.init === undefined ? { kind: 'int', value: 0 } : exprOf(v.init, C);
    /* **类型在 pop 之前算**：`(vector …)` / `(vector-copy …)` 往当前作用域里绑了临时量，
       pop 掉再问就查不着，答出来的是 int（`slice.ss` 就是这么错的：`let ys int`）。 */
    const type = typeOf(init, C.tyCtx());
    C.pop();
    const name = C.ref(v.name);
    if (globalNames.has(v.name)) {
      globals.set(name, type);
      decls.push({ kind: 'global', name, type });
      varInit.push({ kind: 'assign', target: { kind: 'name', name }, value: init });
    } else {
      mainLocals.push({ name, type });
      varInit.push({ kind: 'let', name, type, init });
    }
  }

  /* ---- 第三遍：函数体（含提升）---------------------------------------------- */
  for (const fn of topFns) decls.push(...fnDecls(fn, C));

  /* ---- 入口：顶层那些语句 --------------------------------------------------- */
  C.push();
  for (const l of mainLocals) C.bind(l.name, l.type);
  const mainBody = [...varInit];
  for (const f of mainForms) mainBody.push(stmtOf(f, C));
  C.pop();
  decls.push({ kind: 'main', body: mainBody });

  return { kind: 'module', decls };

  /* ---- 一格函数（可能带内层 define → 提升）--------------------------------- */
  function fnDecls(fn, Cx) {
    const out = [];
    const inners = innerDefines(fn.body);
    const paramSet = new Set(fn.params);
    /* 内层 define 的**捕获**：它体里引到的、属于外层形参的那些名字。
       先登记 captures，再译外层的体 —— 不然体里那几处调用不知道要补实参。 */
    for (const g of inners) {
      if (g.params === null) {
        throw new Error(`chez->IR: 内层的 \`(define ${g.name} …)\`（变量）还没接`);
      }
      const used = symsIn(g.body);
      const free = [...paramSet].filter((p) => used.has(p) && !g.params.includes(p));
      Cx.captures.set(g.name, free);
      Cx.fns.set(Cx.ref(g.name), {
        params: [...g.params, ...free].map((p) => ({ name: Cx.ref(p), type: INT })),
        ret: INT,
      });
    }
    /* 提升出来的那几格先发（它们是独立的顶层函数）。 */
    for (const g of inners) {
      out.push(...fnDecls({ name: g.name, params: [...g.params, ...Cx.captures.get(g.name)], body: g.body }, Cx));
    }
    /* 外层自己：体里去掉那几格内层 define。 */
    const rest = fn.body.filter((f) => !inners.some((g) => g.form === f));
    Cx.push();
    for (const p of fn.params) Cx.bind(Cx.ref(p), INT);
    if (rest.length === 0) throw new Error(`chez->IR: \`${fn.name}\` 的体空着还没接`);
    const value = seqExpr(rest, Cx);
    const ret = typeOf(value, Cx.tyCtx());
    Cx.pop();
    const name = Cx.ref(fn.name);
    Cx.fns.set(name, {
      params: fn.params.map((p) => ({ name: Cx.ref(p), type: INT })),
      ret,
    });
    out.push({
      kind: 'fn',
      name,
      params: fn.params.map((p) => ({ name: Cx.ref(p), type: INT })),
      ret,
      body: [{ kind: 'return', values: [value] }],
    });
    return out;
  }
}

/* ─── 语句位置上的那几种形式 ──────────────────────────────────────────────── */

/**
 * 一格 datum 当**语句**用。Scheme 里这些形式在语句位置上有更直接的落点
 * （`display` → `print`、`if` → 语句形的 if、`set!` → 赋值），所以不必都走表达式那条路。
 */
export function stmtOf(f, C) {
  const items = asList(f);
  const op = items === null ? null : symName(items[0]);
  const rest = items === null ? [] : items.slice(1);
  switch (op) {
    case 'display': case 'write':
      return { kind: 'print', values: [exprOf(rest[0], C)] };
    case 'newline':
      return { kind: 'print', values: [{ kind: 'string', value: '' }] };
    case 'set!':
      return {
        kind: 'assign',
        target: { kind: 'name', name: C.ref(symName(rest[0])) },
        value: exprOf(rest[1], C),
      };
    case 'if': {
      const els = rest[2] === undefined ? null : [stmtOf(rest[2], C)];
      return {
        kind: 'if', cond: condOf(rest[0], C), then: [stmtOf(rest[1], C)], else_: els,
      };
    }
    case 'when':
      return { kind: 'if', cond: condOf(rest[0], C), then: rest.slice(1).map((r) => stmtOf(r, C)), else_: null };
    case 'unless':
      return {
        kind: 'if',
        cond: { kind: 'unop', op: '!', operand: condOf(rest[0], C) },
        then: rest.slice(1).map((r) => stmtOf(r, C)),
        else_: null,
      };
    case 'begin':
      return { kind: 'block', stmts: rest.map((r) => stmtOf(r, C)) };
    case 'let': case 'let*': {
      /* 语句位置上的 `let`：一层块 —— 里头的绑定与语句都在那一层里。 */
      C.push();
      const stmts = [];
      for (const b of (asList(rest[0]) ?? [])) {
        const pair = asList(b) ?? [];
        const name = C.ref(symName(pair[0]));
        const init = pair[1] === undefined ? { kind: 'int', value: 0 } : exprOf(pair[1], C);
        const type = typeOf(init, C.tyCtx());
        C.bind(name, type);
        stmts.push({ kind: 'let', name, type, init });
      }
      for (const r of rest.slice(1)) stmts.push(stmtOf(r, C));
      C.pop();
      return { kind: 'block', stmts };
    }
    /* `(let-values (((a b) (two))) …)`：一格记录拆成几格名字 —— 多值那一族的消费侧。 */
    case 'let-values': case 'let*-values': {
      C.push();
      const stmts = [];
      for (const b of (asList(rest[0]) ?? [])) {
        const pair = asList(b) ?? [];
        const ns = (asList(pair[0]) ?? []).map((s) => C.ref(symName(s)));
        if (ns.length === 0) throw new Error('chez->IR: `let-values` 的形参表空着还没接');
        const src = exprOf(pair[1], C);
        const ty = typeOf(src, C.tyCtx());
        const tmp = C.fresh('mv_');
        C.bind(tmp, ty);
        stmts.push({ kind: 'let', name: tmp, type: ty, init: src });
        const fs = ty.kind === 'named' ? (C.tyCtx().fields.get(ty.name) ?? []) : [];
        ns.forEach((n, i) => {
          const t = fs[i] === undefined ? INT : fs[i].type;
          C.bind(n, t);
          stmts.push({
            kind: 'let', name: n, type: t,
            init: { kind: 'field', obj: { kind: 'name', name: tmp }, name: `v${i}` },
          });
        });
      }
      for (const r of rest.slice(1)) stmts.push(stmtOf(r, C));
      C.pop();
      return { kind: 'block', stmts };
    }
    case 'vector-set!':
      return {
        kind: 'assign',
        target: { kind: 'index', obj: exprOf(rest[0], C), index: exprOf(rest[1], C) },
        value: exprOf(rest[2], C),
      };
    case 'hashtable-set!':
      /* `dset` 在方言里只当**语句**用（包进 `(expr …)` 那侧报"不认识的表达式 'dset'"）。 */
      return {
        kind: 'builtin-stmt',
        name: 'dset',
        args: [exprOf(rest[0], C), exprOf(rest[1], C), exprOf(rest[2], C)],
      };
    /* `(vector-copy v 1 3)` / `(subvector v 1 3)`：**上界不含、0 起**（R6RS/R7RS 与方言一致），
       落成"造一格空数组 + 一个 while 往里 push" —— 方言里没有"切一段"这一格。 */
    case 'vector-copy': case 'subvector':
      throw new Error('chez->IR: `vector-copy` 在语句位置上没有意义（它交一格新数组）');
    default: break;
  }
  /* `(point-y-set! p 5)`：`define-record-type` 生成的**写入器** —— 一格字段赋值。 */
  if (op !== null && C.records.setter.has(op)) {
    return {
      kind: 'assign',
      target: { kind: 'field', obj: exprOf(rest[0], C), name: C.records.setter.get(op) },
      value: exprOf(rest[1], C),
    };
  }
  if (op === 'define') throw new Error('chez->IR: 这个位置上的 `define` 还没接');
  /* 别的都是"算一格值、丢掉"（调用那一族）。 */
  return { kind: 'expr-stmt', expr: exprOf(f, C) };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 只收十进制的数、`quote` 只当串常量收（与从前那份映射同一个范围）。
//   2. `lambda` 当值用、`call/cc`、宏（`syntax-rules`）没接。
//   3. 形参的类型按 int（`types.js` 第 2 条），内层 `(define x e)`（变量）没接。
