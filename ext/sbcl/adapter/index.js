// ext/sbcl/adapter/index.js —— **Common Lisp（SBCL）→ 标准 IR**（ADR-0044 第二片第三门）
//
// 替掉 `ext/sbcl/tograph.js`（279 行）。与 chez 那份的差别只有三处**语言自己的规矩**：
//
//   1. **函数体是一串语句、最后一格是返回值**，而且有 `(return-from f v)` 这种早退 ——
//      所以这一份按"语句 + 末尾 return"译，不像 chez 那样整个体当一格表达式；
//   2. **`(dotimes (i n) …)`** 是计数循环，里头的 `(return)` 是跳出循环（CL 的规矩：
//      循环的体是一格名叫 `nil` 的块）—— 落成方言的三段式 `for` + `brk`，一格新东西都没加；
//   3. **`(unwind-protect body cleanup…)`**：这一批落成"先跑 body、再跑 cleanup"。
//      **明说的边界**：body 里要是有早退（`return-from` / `return`），cleanup 就跑不到了 ——
//      那要真正的作用域出口，所以撞上就当场报，不静静错（从前那条路上是同一个形状，
//      而它把这条边界藏着）。
//
// 类型那一半在 `src/core/lower/ty-of.js`（公共）+ 这儿的三张表（结构 / 函数 / 名字）。

import { head, kids, text, symName, asList } from '../../../src/core/lower/cst.js';
import { INT, named, typeOf } from '../../../src/core/lower/ty-of.js';
import { exprOf, condOf, seqExpr, tyArg } from './expr.js';

/** `(defstruct point x y)` → 登记那一族名字（字段可带默认值 `(x 0)`，名字仍是第一格）。 */
function defstruct(rest, C) {
  const name = symName(rest[0]);
  if (name === null) {
    throw new Error('sbcl->IR: defstruct 的名字那一格还没接（不收 (:constructor …) 那些选项）');
  }
  const fields = rest.slice(1).map((f) => {
    const s = symName(f);
    if (s !== null) return s;
    const pair = asList(f) ?? [];
    return symName(pair[0]);
  }).filter((s) => s !== null);
  C.structs.fields.set(name, fields);
  C.structs.maker.set(`make-${name}`, name);
  for (const f of fields) C.structs.access.set(`${name}-${f}`, f);
}

/** 一段 datum 里出现过的符号（"这个顶层变量是不是被函数体引到了"要它）。 */
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

/** 这几个头在语句位置上**不交值**（函数体的末尾是它们 ⇒ 这个函数回 void）。 */
const VOIDISH = new Set(['princ', 'print', 'write', 'write-line', 'terpri', 'setq', 'setf',
  'dotimes', 'unwind-protect', 'defstruct', 'defparameter', 'defvar', 'defconstant',
  'multiple-value-bind', 'return', 'return-from']);

/** 一棵 sbcl 的 GLR 树（`(program datum…)`）→ 标准 IR 的模块。 */
export function sbclToIR(tree) {
  if (head(tree) !== 'program') throw new Error('sbcl->IR: 这不是 (program …)');
  const forms = kids(tree);

  let tmpN = 0;
  const names = new Map();
  const scopes = [new Map()];
  const globals = new Map();
  const recFields = new Map();
  const mvs = new Map();
  const decls = [];
  const C = {
    structs: { fields: new Map(), maker: new Map(), access: new Map() },
    fns: new Map(),
    /** 现在套着的那几格块（`defun f` 一格、`dotimes` 一格叫 `nil`）—— 早退落哪儿看它。 */
    blocks: [],
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
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

  /* ---- 第一遍：结构的声明（表达式要用它）------------------------------------ */
  for (const f of forms) {
    const items = asList(f);
    if (items !== null && symName(items[0]) === 'defstruct') defstruct(items.slice(1), C);
  }
  for (const [rec, fields] of C.structs.fields) {
    const fs = fields.map((n) => ({ name: n, type: INT }));
    recFields.set(C.ref(rec), fs);
    decls.push({ kind: 'class', name: C.ref(rec), fields: fs });
  }

  /* ---- 第二遍：顶层分三类 --------------------------------------------------- */
  const topFns = [];
  const topVars = [];
  const mainForms = [];
  for (const f of forms) {
    const items = asList(f);
    const op = items === null ? null : symName(items[0]);
    if (op === 'defstruct') continue;
    if (op === 'defun') {
      topFns.push({
        name: symName(items[1]),
        params: (asList(items[2]) ?? []).map((p) => symName(p)),
        body: items.slice(3),
      });
      continue;
    }
    if (op === 'defparameter' || op === 'defvar' || op === 'defconstant') {
      topVars.push({ name: symName(items[1]), init: items[2] });
      continue;
    }
    mainForms.push(f);
  }

  const inFnBodies = new Set();
  for (const fn of topFns) for (const s of symsIn(fn.body)) inFnBodies.add(s);
  const globalNames = new Set(topVars.filter((v) => inFnBodies.has(v.name)).map((v) => v.name));

  for (const fn of topFns) {
    C.fns.set(C.ref(fn.name), {
      params: fn.params.map((p) => ({ name: C.ref(p), type: INT })),
      ret: INT,
    });
  }

  /* ---- 顶层变量 ------------------------------------------------------------- */
  const varInit = [];
  const mainLocals = [];
  for (const v of topVars) {
    C.push();
    const init = v.init === undefined ? { kind: 'int', value: 0 } : exprOf(v.init, C);
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

  /* ---- 函数体 --------------------------------------------------------------- */
  for (const fn of topFns) {
    C.push();
    for (const p of fn.params) C.bind(C.ref(p), INT);
    C.blocks.push({ name: fn.name, kind: 'func' });
    const body = [];
    const last = fn.body[fn.body.length - 1];
    if (last === undefined) throw new Error(`sbcl->IR: \`${fn.name}\` 的体空着还没接`);
    const lastHead = (() => { const it = asList(last); return it === null ? null : symName(it[0]); })();
    let ret = { kind: 'void' };
    if (VOIDISH.has(lastHead)) {
      for (const f of fn.body) body.push(stmtOf(f, C));
    } else {
      for (const f of fn.body.slice(0, -1)) body.push(stmtOf(f, C));
      const value = exprOf(last, C);
      ret = typeOf(value, C.tyCtx());
      body.push({ kind: 'return', values: [value] });
    }
    C.blocks.pop();
    C.pop();
    const name = C.ref(fn.name);
    C.fns.set(name, { params: fn.params.map((p) => ({ name: C.ref(p), type: INT })), ret });
    decls.push({
      kind: 'fn',
      name,
      params: fn.params.map((p) => ({ name: C.ref(p), type: INT })),
      ret,
      body,
    });
  }

  /* ---- 入口 ---------------------------------------------------------------- */
  C.push();
  for (const l of mainLocals) C.bind(l.name, l.type);
  const mainBody = [...varInit];
  for (const f of mainForms) mainBody.push(stmtOf(f, C));
  C.pop();
  decls.push({ kind: 'main', body: mainBody });

  return { kind: 'module', decls };
}

/* ─── 语句位置上的那几种形式 ──────────────────────────────────────────────── */

export function stmtOf(f, C) {
  const items = asList(f);
  const op = items === null ? null : symName(items[0]);
  const rest = items === null ? [] : items.slice(1);
  switch (op) {
    case 'princ': case 'print': case 'write': case 'write-line':
      return { kind: 'print', values: [exprOf(rest[0], C)] };
    case 'terpri':
      return { kind: 'print', values: [{ kind: 'string', value: '' }] };
    case 'setq': return {
      kind: 'assign',
      target: { kind: 'name', name: C.ref(symName(rest[0])) },
      value: exprOf(rest[1], C),
    };
    /* **`setf` 的左边可以是一格形式**（广义位置）：`aref` → 数组、`gethash` → 字典、
       结构的访问器 → 字段。CL 独有的形状，落到的却是别人也有的那几格。 */
    case 'setf': {
      const inner = asList(rest[0]);
      if (inner === null) {
        return {
          kind: 'assign',
          target: { kind: 'name', name: C.ref(symName(rest[0])) },
          value: exprOf(rest[1], C),
        };
      }
      const place = symName(inner[0]);
      if (place === 'aref' || place === 'svref' || place === 'elt') {
        return {
          kind: 'assign',
          target: { kind: 'index', obj: exprOf(inner[1], C), index: exprOf(inner[2], C) },
          value: exprOf(rest[1], C),
        };
      }
      if (place === 'gethash') {
        /* 键在前、表在后 —— `dset` 收的是 (表, 键, 值)。 */
        return {
          kind: 'builtin-stmt',
          name: 'dset',
          args: [exprOf(inner[2], C), exprOf(inner[1], C), exprOf(rest[1], C)],
        };
      }
      if (place !== null && C.structs.access.has(place)) {
        return {
          kind: 'assign',
          target: { kind: 'field', obj: exprOf(inner[1], C), name: C.structs.access.get(place) },
          value: exprOf(rest[1], C),
        };
      }
      throw new Error(`sbcl->IR: 这个 setf 位置还没接：${place}`);
    }
    case 'if': {
      const els = rest[2] === undefined ? null : [stmtOf(rest[2], C)];
      return { kind: 'if', cond: condOf(rest[0], C), then: [stmtOf(rest[1], C)], else_: els };
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
    case 'progn':
      return { kind: 'block', stmts: rest.map((r) => stmtOf(r, C)) };
    case 'let': case 'let*': {
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
    /* `(dotimes (i n) …)`：`i` 从 0 走到 n-1。体是一格名叫 `nil` 的块（`(return)` 跳出它）。 */
    case 'dotimes': {
      const spec = asList(rest[0]) ?? [];
      const i = C.ref(symName(spec[0]));
      C.push();
      C.bind(i, INT);
      C.blocks.push({ name: 'nil', kind: 'loop' });
      const body = rest.slice(1).map((r) => stmtOf(r, C));
      C.blocks.pop();
      const limit = exprOf(spec[1], C);
      C.pop();
      return {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: { kind: 'binop', op: '<', left: { kind: 'name', name: i }, right: limit },
        post: {
          kind: 'assign',
          target: { kind: 'name', name: i },
          value: { kind: 'binop', op: '+', left: { kind: 'name', name: i }, right: { kind: 'int', value: 1 } },
        },
        body,
      };
    }
    /* **CL 的早退是"从一格带名字的块里返回"**：`(return-from f v)` 在 `defun f` 里是
       函数返回，`(return)`（= 从 `nil` 那格块）在循环里是 break。跨层的当场报，不猜。 */
    case 'return': case 'return-from': {
      const blockName = op === 'return' ? 'nil' : symName(rest[0]);
      const val = op === 'return' ? rest[0] : rest[1];
      const inner = C.blocks[C.blocks.length - 1];
      if (inner === undefined) throw new Error(`sbcl->IR: ${op} 在任何块之外`);
      if (blockName === 'nil') {
        if (inner.kind !== 'loop') {
          throw new Error('sbcl->IR: `(return)` 要它在循环里（`nil` 那格块是循环的）');
        }
        if (val !== undefined) {
          throw new Error('sbcl->IR: 从循环里**带值**返回还没接 —— 方言里 break 不带值');
        }
        return { kind: 'break', label: null };
      }
      if (inner.kind === 'func' && inner.name === blockName) {
        return { kind: 'return', values: val === undefined ? [] : [exprOf(val, C)] };
      }
      throw new Error(`sbcl->IR: 从 ${blockName} 那格块里返回要跨过一层 —— 跨层的早退还没接`);
    }
    /* `(unwind-protect body cleanup…)`：先 body、再 cleanup。**body 里不许早退**
       （那要真正的作用域出口 —— 见文件头第 3 条）。 */
    case 'unwind-protect': {
      const guarded = symsIn(rest.slice(0, 1));
      if (guarded.has('return') || guarded.has('return-from')) {
        throw new Error('sbcl->IR: `unwind-protect` 的 body 里有早退 —— 那时 cleanup 跑不到，'
          + '要真正的作用域出口（这一批没接，明说不猜）');
      }
      return {
        kind: 'block',
        stmts: [stmtOf(rest[0], C), ...rest.slice(1).map((r) => stmtOf(r, C))],
      };
    }
    /* `(multiple-value-bind (lo hi) (minmax …) …)`：一格记录拆成几格名字。 */
    case 'multiple-value-bind': {
      C.push();
      const stmts = [];
      const ns = (asList(rest[0]) ?? []).map((s) => C.ref(symName(s)));
      const src = exprOf(rest[1], C);
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
      for (const r of rest.slice(2)) stmts.push(stmtOf(r, C));
      C.pop();
      return { kind: 'block', stmts };
    }
    default: break;
  }
  if (op === 'defun' || op === 'defstruct') {
    throw new Error(`sbcl->IR: 这个位置上的 \`${op}\` 还没接`);
  }
  return { kind: 'expr-stmt', expr: exprOf(f, C) };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. `&optional` / `&rest` / 关键字形参不收（元数分派是另一件事）。
//   2. `format` 那一族、条件系统（`handler-bind` / restart）、CLOS 都不在这一批。
//   3. `lambda` 当值用没接；`unwind-protect` 的 body 里有早退当场报（见文件头第 3 条）。
