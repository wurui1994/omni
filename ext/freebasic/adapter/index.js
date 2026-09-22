// ext/freebasic/adapter/index.js —— **FreeBASIC → 标准 IR**（ADR-0044 第二片第四门）
//
// 替掉 `ext/freebasic/tograph.js`（309 行）。这一门与前三门的差别：**类型是写着的**
// （`Dim acc As Integer` / `As Integer` 的返回类型），所以类型那半笔账是照抄不是推断。
// FB 自己的三条规矩在 `expr.js` 的文件头上（名字不分大小写 / `xs(0)` 的歧义 / `=` 既是
// 比较也是赋值）。
//
// **这一批明说的不足**：`Declare Destructor`（出作用域跑一段）没接 —— 那要真正的作用域
// 出口，而公共降级器还没有那一格（sbcl 的 `unwind-protect` 是靠"body 里不许早退"绕的）。
// 撞上就当场报，不静静把析构丢掉（从前那条路上它是靠图的 `scope-exit` 接的）。

import { isList, tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import { INT, arrOf, named, typeOf } from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfTok, nameOf, lower, tyArg,
} from './expr.js';

/** 一棵 FB 的树（`(module … )`）→ 标准 IR 的模块。 */
export function fbToIR(tree) {
  if (tag(tree) !== 'module') throw new Error('fb->IR: 这不是 (module …)');

  let tmpN = 0;
  const names = new Map();
  const scopes = [new Map()];
  const globals = new Map();
  const recFields = new Map();
  const decls = [];
  const C = {
    /** 小写的类型名 → { name, fields: [{name,type}] }（`Type … End Type` 登记的）。 */
    records: new Map(),
    /** 小写的名字 → 真的是数组（`xs(0)` 才分得清取下标还是调用）。 */
    arrays: new Set(),
    /** 有 `Declare Destructor` 的那几个类型（小写）。 */
    dtors: new Set(),
    /** 当前函数里**声明过的带析构的量**（名字 + 类型，按声明顺序）—— 出作用域要逆序调一遍。 */
    scoped: [],
    fns: new Map(),
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
    ref: (n) => {
      /* FB 的名字不分大小写：**登记按小写、发出去按第一次见到的写法**
         （`Print s` 与 `print S` 指同一格）。 */
      const k = lower(n);
      if (!names.has(k)) {
        let s = String(n).replace(/[^A-Za-z0-9_]/g, '_');
        if (/^[0-9]/.test(s)) s = `_${s}`;
        names.set(k, s);
      }
      return names.get(k);
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
    stmtOf: (f) => stmtsOf(f, C),
  };

  /* ---- 第一遍：`Type … End Type`（记录）与数组的登记 ------------------------- */
  walk(tree, (x) => {
    if (tag(x) !== 'typedecl') return;
    const nm = kids(x).find((y) => tag(y) === 'n');
    const ms = part(x, 'members');
    if (nm === undefined) return;
    const hasDtor = ms !== undefined && kids(ms).some((m) => tag(m) === 'declare'
      && lower(leaf(kids(kids(m)[0])[0])) === 'destructor');
    if (hasDtor) C.dtors.add(lower(nameOf(nm)));
    const fields = ms === undefined ? [] : kids(ms)
      .filter((f) => tag(f) === 'f')
      .map((f) => {
        const v = kids(f)[0];
        return { name: String(nameOf(kids(v)[0])), type: typeOfTok(kids(v)[1], C) };
      });
    C.records.set(lower(nameOf(nm)), { name: nameOf(nm), fields });
  });
  for (const [, rec] of C.records) {
    recFields.set(C.ref(rec.name), rec.fields);
    decls.push({ kind: 'class', name: C.ref(rec.name), fields: rec.fields });
  }
  /* 数组名要**先**登记（`xs(0)` 在声明之后才出现，但一趟扫下来更稳）。 */
  walk(tree, (x) => {
    if (tag(x) !== 'dim' && tag(x) !== 'static' && tag(x) !== 'const') return;
    for (const v of kids(x).filter((y) => tag(y) === 'v')) {
      const nm = kids(v)[0];
      if (isList(nm) && kids(nm).some((y) => tag(y) === 'bounds')) C.arrays.add(lower(nameOf(nm)));
    }
  });

  /* ---- 第二遍：顶层分两类（函数 / 别的都是入口里的语句）---------------------- */
  const topFns = [];
  const mainForms = [];
  for (const f of kids(tree)) {
    if (tag(f) === 'typedecl') continue;
    if (tag(f) === 'routine') { topFns.push(f); continue; }
    mainForms.push(f);
  }

  /* 函数签名先登记（互相调用要它）。**`Destructor Say()` 头上那格名字是类型名**，
     落成一格普通函数 `__destruct_say(This As Say)`（FB 的析构体里本来就写 `This`）。 */
  const sigOf = (r) => {
    const head = part(r, 'head');
    const kw = lower(leaf(kids(head)[0]));
    const nm = kids(head).find((y) => tag(y) === 'n');
    if (nm === undefined) throw new Error('fb->IR: 这一格 routine 头上没有名字');
    if (kw === 'destructor') {
      const ty = lower(nameOf(nm));
      return {
        name: dtorName(ty),
        params: [{ name: 'This', type: named(C.ref(C.records.get(ty).name), true) }],
        ret: { kind: 'void' },
      };
    }
    const ps = kids(head).find((y) => tag(y) === 'params');
    const retTok = part(head, 'ret');
    return {
      name: C.ref(nameOf(nm)),
      params: ps === undefined ? [] : kids(ps).map((p) => ({
        name: C.ref(nameOf(kids(p)[0])),
        type: typeOfTok(kids(p)[kids(p).length - 1], C),
      })),
      ret: retTok === undefined ? { kind: 'void' } : typeOfTok(kids(retTok)[0], C),
    };
  };
  for (const r of topFns) {
    const sig = sigOf(r);
    C.fns.set(sig.name, { params: sig.params, ret: sig.ret });
  }

  /* ---- 函数体 --------------------------------------------------------------- */
  for (const r of topFns) {
    const sig = sigOf(r);
    C.push();
    for (const p of sig.params) C.bind(p.name, p.type);
    const outerScoped = C.scoped;
    C.scoped = [];
    const body = part(r, 'body');
    const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
    /* **末尾也要跑一遍析构**（没写 `Exit Sub` 的那条路）—— 里头的 `return` 已经各自补过了。 */
    const last = stmts[stmts.length - 1];
    if (C.scoped.length > 0 && (last === undefined || last.kind !== 'return')) {
      stmts.push(...dtorCalls(C));
    }
    C.scoped = outerScoped;
    C.pop();
    decls.push({
      kind: 'fn', name: sig.name, params: sig.params, ret: sig.ret, body: stmts,
    });
  }

  /* ---- 入口 ---------------------------------------------------------------- */
  C.push();
  const mainBody = mainForms.flatMap((f) => stmtsOf(f, C));
  C.pop();
  decls.push({ kind: 'main', body: mainBody });

  return { kind: 'module', decls };
}

/** 走一遍树（第一遍登记用）。 */
function walk(x, fn) {
  if (!isList(x)) return;
  fn(x);
  for (const k of x.items) walk(k, fn);
}

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

/**
 * 一格树节点 → **一串**语句（`(line …)` 一行可能有几条、`dim` 一格可能声明几个名字）。
 * 回数组，调用方 `flatMap` 摊平。
 */
export function stmtsOf(x, C) {
  if (isList(x) && x.items.length === 0) return [];      // 空行 / 只有注释的行
  switch (tag(x)) {
    case 'line': case 'body': return kids(x).flatMap((k) => stmtsOf(k, C));
    case 'print': {
      const args = kids(x);
      if (args.length === 0) return [{ kind: 'print', values: [{ kind: 'string', value: '' }] }];
      return args.map((a) => ({ kind: 'print', values: [exprOf(a, C)] }));
    }
    /* 语句位置上的表达式：**顶上是 `=` 就是赋值**（FB 用同一个记号做比较与赋值）。 */
    case 'expr': {
      const inner = kids(x)[0];
      if (tag(inner) === 'bin' && String(leaf(kids(inner)[0])) === '=') {
        const [, lhs, rhs] = kids(inner);
        return [assignTo(lhs, exprOf(rhs, C), C)];
      }
      return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
    }
    case 'augassign': {
      const [op, lhs, rhs] = kids(x);
      const o = String(leaf(op)).replace('=', '').trim();
      const target = lhsOf(lhs, C);
      return [{
        kind: 'assign',
        target,
        value: { kind: 'binop', op: o === '&' ? '+' : o, left: target, right: exprOf(rhs, C) },
      }];
    }
    /* `Dim acc As Integer = 0` / `Dim xs(2) As Integer = {…}` / `Dim p As Point`。 */
    case 'dim': case 'static': case 'const': return kids(x)
      .filter((y) => tag(y) === 'v')
      .map((v) => dimOf(v, C));
    case 'for': {
      const head = part(x, 'head');
      const body = part(x, 'body');
      const i = C.ref(nameOf(kids(head)[0]));
      const type = typeOfTok(kids(head)[1], C);
      const from = part(head, 'from');
      const to = part(head, 'to');
      const step = part(head, 'step');
      C.push();
      C.bind(i, type);
      const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
      const limit = exprOf(kids(to)[0], C);
      const stepV = step === undefined ? { kind: 'int', value: 1 } : exprOf(kids(step)[0], C);
      C.pop();
      /* FB 的 `To` 是**含上界**的（`0 To 2` 走 0/1/2）—— 与方言的 `while` 差那一格，
         所以条件是 `<=`。步进为负的那一档这一批不接（例子里没有，明说不猜）。 */
      if (stepV.kind === 'int' && stepV.value < 0) {
        throw new Error('fb->IR: `Step` 是负数的 For 还没接（条件要反过来）');
      }
      return [{
        kind: 'for',
        init: { kind: 'let', name: i, type, init: exprOf(kids(from)[0], C) },
        cond: { kind: 'binop', op: '<=', left: { kind: 'name', name: i }, right: limit },
        post: {
          kind: 'assign',
          target: { kind: 'name', name: i },
          value: { kind: 'binop', op: '+', left: { kind: 'name', name: i }, right: stepV },
        },
        body: stmts,
      }];
    }
    /* `Do … Loop`（条件省掉 = 永真）与 `While c … Wend`。 */
    case 'do': case 'while': {
      const body = part(x, 'body');
      const condTok = kids(x).find((y) => tag(y) !== 'body' && isList(y));
      const cond = condTok === undefined || tag(condTok) === 'body'
        ? { kind: 'bool', value: true }
        : condOf(condTok, C);
      const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
      return [{ kind: 'while', cond, body: stmts }];
    }
    /* `(if 条件 (body …) (elifs [(elif 条件 (body …))…]) [(body …)])` ——
       **中间那一格 `elifs` 总在**（没有 ElseIf 时是空表）。`ElseIf` 嵌成一层新的 if。 */
    case 'if': {
      const parts = kids(x);
      const cond = condOf(parts[0], C);
      const then = parts[1] === undefined ? [] : kids(parts[1]).flatMap((s) => stmtsOf(s, C));
      const elifs = parts[2] !== undefined && tag(parts[2]) === 'elifs' ? kids(parts[2]) : [];
      /* `Else` 那一格是 `(else () 语句…)` —— **头上还有一格空表**（那是它的 mods 位），
         所以不能按"再找一格 body"取（踩过：整支 else 被丢掉，`max2` 回 0、析构少印一行）。 */
      const elseTok = parts.slice(2).find((y) => tag(y) === 'else');
      let els = elseTok === undefined
        ? null
        : kids(elseTok).flatMap((s) => stmtsOf(s, C));
      /* 从后往前嵌：最后一格 ElseIf 的 else 是那格 Else。 */
      for (let i = elifs.length - 1; i >= 0; i--) {
        const e = kids(elifs[i]);
        const c2 = condOf(e[0], C);
        const b2 = e[1] === undefined ? [] : kids(e[1]).flatMap((s) => stmtsOf(s, C));
        els = [{ kind: 'if', cond: c2, then: b2, else_: els }];
      }
      return [{ kind: 'if', cond, then, else_: els }];
    }
    case 'return': {
      const vs = kids(x);
      /* **早退也要跑析构**（FB 的 RAII）—— 逆序，与声明的次序相反。 */
      return [...dtorCalls(C), { kind: 'return', values: vs.length === 0 ? [] : [exprOf(vs[0], C)] }];
    }
    /* `Exit Do` / `Exit For` → break；`Exit Sub` / `Exit Function` → return。 */
    case 'exit': {
      const what = lower(leaf(kids(x)[0]));
      if (what === 'sub' || what === 'function') {
        return [...dtorCalls(C), { kind: 'return', values: [] }];
      }
      return [{ kind: 'break', label: null }];
    }
    case 'continue': return [{ kind: 'continue', label: null }];
    /* `Scope … End Scope`：一层块。 */
    case 'scope': {
      const body = part(x, 'body');
      C.push();
      const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'block', stmts }];
    }
    /* 独立的调用（`demo()`）在树上是 `(call …)`。 */
    case 'call': return [{ kind: 'expr-stmt', expr: exprOf(x, C) }];
    case 'typedecl': return [];
    default:
      throw new Error(`fb->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** 析构函数的名字（类型名小写）。 */
const dtorName = (ty) => `__destruct_${String(ty).replace(/[^A-Za-z0-9_]/g, '_')}`;

/**
 * 当前函数里那几格带析构的量 → **逆序**各调一次。
 * FB 的规矩：出作用域（或早退）时按声明的相反次序跑析构 —— `defer` 那一族的输出
 * （`in b a out`）钉的正是这个次序。
 */
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

/** 赋值的左边那一格（名字 / 下标 / 字段）。 */
function lhsOf(lhs, C) {
  if (tag(lhs) === 'call') {
    const [fn, args] = kids(lhs);
    return {
      kind: 'index',
      obj: { kind: 'name', name: C.ref(nameOf(fn)) },
      index: exprOf(kids(args)[0], C),
    };
  }
  if (tag(lhs) === 'dot') {
    return { kind: 'field', obj: exprOf(kids(lhs)[0], C), name: String(leaf(kids(lhs)[1])) };
  }
  return { kind: 'name', name: C.ref(nameOf(lhs)) };
}

function assignTo(lhs, value, C) {
  return { kind: 'assign', target: lhsOf(lhs, C), value };
}

/** 一格 `(v (n 名字[ (bounds …)]) 类型 [(init …)])` → 一条 `let`。 */
function dimOf(v, C) {
  const nm = kids(v)[0];
  const name = C.ref(nameOf(nm));
  const init = part(v, 'init');
  const bounds = isList(nm) ? kids(nm).find((y) => tag(y) === 'bounds') : undefined;
  const tyTok = kids(v)[1];
  if (bounds !== undefined) {
    /* 数组：`Dim xs(2) As Integer` 的上界**含在内**（0…2 共三格）。 */
    const elem = typeOfTok(tyTok, C);
    const type = arrOf(elem);
    C.bind(name, type);
    if (init !== undefined) {
      return { kind: 'let', name, type, init: exprOf(kids(init)[0], C) };
    }
    const hi = Number(leaf(kids(kids(bounds)[0])[0]));
    const size = Number.isFinite(hi) ? hi + 1 : 0;
    return {
      kind: 'let', name, type,
      init: { kind: 'builtin', name: 'anew', args: [tyArg(type), { kind: 'int', value: size }] },
    };
  }
  const type = tyTok === undefined ? INT : typeOfTok(tyTok, C);
  C.bind(name, type);
  /* 这一格的类型有析构 ⇒ 记下来（出作用域要逆序调一遍，见 `dtorCalls`）。 */
  if (tyTok !== undefined && C.dtors.has(lower(nameOf(tyTok)))) {
    C.scoped.push({ name, type: lower(nameOf(tyTok)) });
  }
  if (init !== undefined) return { kind: 'let', name, type, init: exprOf(kids(init)[0], C) };
  /* 没给初值：FB 的数值量是 0、串是 ""、记录是"字段各自的零值"—— 都是 `zeroOf` 那一格
     （公共降级器里 `let` 不给初值时就发零值）。 */
  return { kind: 'let', name, type, init: null };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. `Declare Destructor`（出作用域跑一段）当场报 —— 要真正的作用域出口。
//   2. `Step` 是负数的 `For` 没接；`Select Case` 没接。
//   3. `CInt` 在 FB 里是**四舍五入**、方言的 `toint` 是截断（与从前那条路同一个取舍）。
