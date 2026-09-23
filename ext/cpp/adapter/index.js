// ext/cpp/adapter/index.js —— **C++ → 标准 IR**（ADR-0044 第二片第六门）
//
// 替掉 `ext/cpp/tograph.js`（534 行）。这一门的要点：
//   1. **类型是写着的**（`int` / `double` / `Point` / `std::map<std::string,int>`），`auto` 从初值取；
//   2. **`~Say()` 是出作用域跑一段**（RAII）—— 交给**公共层的作用域出口**
//      （`{ kind: 'scope', stmts, exits }`，`lower-stmt.js`）：这一份只说"哪几格要销毁、
//      按什么次序"，"每个出口都补一遍"是公共层的事；
//   3. `#include` / `namespace` / `template` 的前向声明**丢掉**（这一门不做预处理，
//      例子里那几行是为了让语法认得 `std::map` 这类名字）；
//   4. 入口是 `int main()` —— 公共降级器看见名叫 `main` 的函数就发 `(main (expr (call main)))`。

import {
  tag, kids, leaf, part, isList, groupItems,
} from '../../../src/core/lower/cst.js';
import { INT, arrOf, named, typeOf } from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfSpecs, printArgs, nameOf, tyArg, vcallName, readParams,
} from './expr.js';

/** 析构函数的名字。 */
const dtorName = (ty) => `__destruct_${String(ty).replace(/[^A-Za-z0-9_]/g, '_')}`;

/** 构造函数的名字（交的是一格记录，所以它是个**普通函数**，不带 `this`）。 */
const ctorName = (rec) => `${rec}__ctor`;

/**
 * **`operator@` 的方法名**（与 `expr.js` 的 `OP_MAP` 是同一张表的两头）。
 * 落法是把重载编成一格**普通方法**（`类名_op_add`）—— 登记、发体、分派全不用另写；
 * 改写发生在调用点（`a + b` 里 a 装的是有这一格的类才改写）。
 */
const OP_NAMES = new Map([
  ['+', 'op_add'], ['-', 'op_sub'], ['*', 'op_mul'], ['/', 'op_div'], ['%', 'op_mod'],
  ['==', 'op_eq'], ['!=', 'op_neq'],
  ['<', 'op_lt'], ['>', 'op_gt'], ['<=', 'op_le'], ['>=', 'op_ge'],
  ['index', 'op_index'], ['call', 'op_call'],
]);

/** `(opname "+")` → `op_add`。不认的算子当场报（别静默地编出个怪名字）。 */
function opMethodName(tok) {
  const s = String(leaf(kids(tok)[0]));
  const n = OP_NAMES.get(s);
  if (n === undefined) throw new Error(`cpp->IR: \`operator${s}\` 这一格重载还没接`);
  return n;
}

/** 模板实例的名字里那一截（`int` / `real` / `arr_int` / `Point`）。 */
function tyTag(t) {
  if (t.kind === 'named') return t.name;
  if (t.kind === 'arr') return `arr_${tyTag(t.elem)}`;
  if (t.kind === 'map') return `map_${tyTag(t.value)}`;
  return t.kind;
}

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
    /** `typedef int myint;` → 名字 → 类型。**模板的类型形参实例化时也临时摆在这儿**。 */
    aliases: new Map(),
    fns: new Map(),
    /** `template <class T> T f(…)` → 名字 → { tparams, fnTok }（本身**不发代码**）。 */
    templates: new Map(),
    /** `template <class T> struct Box {…}` → 名字 → { tparams, clsTok }（同样不发代码）。 */
    ctemplates: new Map(),
    /** 已经发过的实例名（`maxOf__int`）—— 同一格只降一遍。 */
    instDone: new Set(),
    /**
     * **一格类名 → 它在方言里落成哪一格记录**。没有虚函数的类就是自己；有虚函数的
     * 整棵继承树**共用根那一格记录**（见 `planVirtuals`）—— 那是"基类指针能装派生类"
     * 的唯一办法，方言里没有子类型。
     */
    storage: new Map(),
    /** 同一张表，键与值都**已经 ref 过**（`C.self` 是 ref 过的名字，那边要用这张）。 */
    storageRef: new Map(),
    /** 类名 → `__vt` 的值（根是 0，派生类按登记次序 1、2、…）。 */
    vtId: new Map(),
    /** 同一张表，键**已经 ref 过**。 */
    vtIdRef: new Map(),
    /** 根名（已 ref 过） → 方法名 → [{ vt, fn }]（虚方法的分派表）。 */
    vtab: new Map(),
    /**
     * 一格类名 → 类型。**`name` 是落地的记录（可能是根）、`cls` 是写着的那个静态类型** ——
     * 非虚方法按 `cls` 单态分派（C++ 的隐藏规则），虚方法按 `name` 找分派表。
     */
    recType: (n) => ({
      kind: 'named', name: C.ref(C.storage.get(n) ?? n), ref: true, cls: C.ref(n),
    }),
    /** 当前函数里那几格带析构的量（出作用域逆序调一遍）。 */
    scoped: [],
    /** 正在降的这格方法的**接收者类型名**（裸写字段名 = `this->` 那一格靠它）。 */
    self: null,
    /** 正在降的这格 lambda 借走了哪几格量（名字 → 类型）—— 体里它们落成 `(cap …)`。 */
    capNames: new Map(),
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
    /**
     * **把作用域栈整个换成空的，跑一段，再换回来**。模板实例化发生在**别人的体中间**
     * （调用点），要是不换，模板体里的名字会往外看见调用者的局部量 —— 那是
     * "答案静默地错"那一类（同名的量被借走）。数组的身份要保住，所以用 splice。
     */
    isolate: (f) => {
      const saved = scopes.splice(0, scopes.length, new Map());
      try { return f(); } finally { scopes.splice(0, scopes.length, ...saved); }
    },
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

  /* ---- 第零遍：模板登记（本身不发代码，等调用点来要）----------------------- */
  for (const d of kids(tree)) {
    if (tag(d) !== 'template') continue;
    const ps = part(d, 'params');
    const tparams = (ps === undefined ? [] : kids(ps))
      .filter((y) => tag(y) === 'tp')
      .map((y) => nameOf(kids(y).find((z) => tag(z) === 'n')));
    const inner = kids(d).find((y) => tag(y) === 'func' || tag(y) === 'decl');
    if (inner === undefined) throw new Error('cpp->IR: 这格 template 里什么都没有');
    if (tag(inner) === 'func') {
      const f = kids(inner).find((y) => tag(y) === 'fn');
      C.templates.set(nameOf(kids(f)[0]), { tparams, fnTok: inner });
      continue;
    }
    /* **类模板**：`template <class T> struct Box { … };`。 */
    const sp = part(inner, 'specs');
    const cls = sp === undefined ? undefined : kids(sp).find((y) => tag(y) === 'class');
    if (cls === undefined) throw new Error('cpp->IR: 这一格 template 还没接（只接函数与类）');
    const clsKids = kids(cls).flatMap((y) => (tag(y) === null && isList(y) ? groupItems(y) : [y]));
    const cn = clsKids.find((y) => tag(y) === 'n');
    C.ctemplates.set(nameOf(cn), { tparams, clsTok: cls });
  }

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
    const rec = collectClass(cls, C);
    C.records.set(rec.name, rec);
  }
  planVirtuals(C, recFields, decls);
  /* **把基类摊进派生类**（字段在前、方法按名字继承）—— 见 `flatten`。 */
  for (const [, rec] of C.records) flatten(rec, C, new Set());
  for (const [, rec] of C.records) {
    if (rec.done === true) continue;
    recFields.set(C.ref(rec.name), rec.fields);
    /* 虚继承树那一档**只发根那一格记录**（字段是整棵树的并集 + `__vt`）—— 见 `layoutVirtual`。 */
    if (C.storage.get(rec.name) === rec.name) {
      decls.push({ kind: 'class', name: C.ref(rec.name), fields: rec.fields });
    }
  }
  layoutVirtual(C, recFields, decls);

  /* ---- 第二遍：函数签名（含方法与析构）------------------------------------- */
  const topFns = kids(tree).filter((f) => tag(f) === 'func');
  const sigOf = (fnTok, selfType, forcedName) => {
    const f = kids(fnTok).find((y) => tag(y) === 'fn');
    const nmTok = kids(f)[0];
    const params = readParams(part(f, 'params'), C);
    const ret = typeOfSpecs(part(fnTok, 'specs'), C) ?? { kind: 'void' };
    const name = forcedName ?? C.ref(nameOf(nmTok));
    const all = selfType === undefined ? params : [{ name: 'this', type: selfType }, ...params];
    return { name, params: all, ret };
  };
  /**
   * **一格模板实例**（单态化）。名字按实参类型编（`maxOf__int` / `maxOf__real`），
   * 第一次要到才把体降一遍 —— 图上一格新节点也没加，落的全是现成的 `fn` + `call`。
   *
   * 类型形参**临时摆进 `C.aliases`**（`typeOfSpecs` 认得那张表），完了还回去：
   * 嵌套实例化（模板里调模板）靠这条就够，因为里层要的是自己那一格绑定。
   * 作用域栈要 `C.isolate` 换空 —— 调用点在别人的体中间，不换就会看见调用者的局部量。
   */
  C.instantiate = (name, types) => {
    const t = C.templates.get(name);
    const inst = `${C.ref(name)}__${types.map(tyTag).join('_')}`;
    if (C.instDone.has(inst)) return inst;
    C.instDone.add(inst);
    const saved = t.tparams.map((p) => C.aliases.get(p));
    t.tparams.forEach((p, i) => C.aliases.set(p, types[i]));
    try {
      const s = sigOf(t.fnTok, undefined, inst);
      C.fns.set(s.name, { params: s.params, ret: s.ret });
      decls.push(C.isolate(() => fnDecl(s, t.fnTok, C)));
    } finally {
      t.tparams.forEach((p, i) => {
        if (saved[i] === undefined) C.aliases.delete(p); else C.aliases.set(p, saved[i]);
      });
    }
    return inst;
  };
  /**
   * **一格类模板的实例**（`Box<int>` → 一格叫 `Box__int` 的普通记录）。
   *
   * 与函数模板同一条路：类型形参临时摆进 `C.aliases`，把**同一棵 `(class …)` 树**
   * 再读一遍 —— `collectClass` / `sigOf` 一个字都不用改。读完当场把类、方法签名、
   * 方法体三样都发掉，并把 `done` 立起来：这一格可能发生在第二、三遍**中间**
   * （`Box<int> mk(int)` 的返回类型），外头那两个遍历看见 `done` 就跳过，不会发第二份。
   */
  C.instClass = (name, types) => {
    const t = C.ctemplates.get(name);
    const inst = `${C.ref(name)}__${types.map(tyTag).join('_')}`;
    if (C.instDone.has(inst)) return C.recType(inst);
    C.instDone.add(inst);
    const saved = t.tparams.map((p) => C.aliases.get(p));
    t.tparams.forEach((p, i) => C.aliases.set(p, types[i]));
    try {
      const rec = collectClass(t.clsTok, C, inst);
      if (rec.virtuals.size > 0) throw new Error('cpp->IR: 类模板 + 虚函数还没接');
      if (rec.bases.length > 0) throw new Error('cpp->IR: 类模板 + 继承还没接');
      if (rec.ctor !== null) throw new Error('cpp->IR: 类模板 + 构造函数还没接');
      rec.done = true;
      rec.flat = true;
      C.records.set(inst, rec);
      C.storage.set(inst, inst);
      C.storageRef.set(C.ref(inst), C.ref(inst));
      recFields.set(C.ref(inst), rec.fields);
      decls.push({ kind: 'class', name: C.ref(inst), fields: rec.fields });
      const selfType = C.recType(inst);
      const sigs = rec.methods.map((m) => sigOf(m.tok, selfType, `${C.ref(inst)}_${C.ref(m.name)}`));
      sigs.forEach((s) => C.fns.set(s.name, { params: s.params, ret: s.ret }));
      rec.methods.forEach((m, i) => {
        decls.push(C.isolate(() => fnDecl(sigs[i], m.tok, C, C.ref(inst))));
      });
      if (rec.dtor !== null) throw new Error('cpp->IR: 类模板 + 析构函数还没接');
    } finally {
      t.tparams.forEach((p, i) => {
        if (saved[i] === undefined) C.aliases.delete(p); else C.aliases.set(p, saved[i]);
      });
    }
    return C.recType(inst);
  };
  /**
   * **一格 lambda** → 公共层现成的闭包（`{ kind: 'closure' }` + `make-closure` + `capture`，
   * 与 go 的匿名函数走同一台机器）。图上一格新节点也没加。
   *
   * 三条是这一门自己的：
   *   1. **捕获一律按值**。`[x]` 照抄、`[=]` 扫体里的自由名字（只收"这儿真有这格局部量"的）；
   *      `[&]` / `[&x]` **当场报** —— 按引用要"把局部量提上去"那台机器（go 那侧的 promote）。
   *   2. **返回类型从体里第一句 `return` 推**（C++ 的 `auto` 推导；写了 `-> T` 也认）。
   *   3. 体要换一格干净的作用域（`C.isolate`）—— 不换就会直接看见外层的局部量，
   *      于是该落成 `(cap …)` 的那几格落成了裸名字，**答案静默地错**。
   */
  C.lambda = (tok) => {
    const name = C.fresh('__lam');
    const params = readParams(kids(tok).find((y) => tag(y) === 'params'), C);
    const body = part(tok, 'body');
    const capsTok = kids(tok).find((y) => tag(y) === 'captures');
    const wanted = [];
    let all = false;
    for (const c of (capsTok === undefined ? [] : kids(capsTok))) {
      if (tag(c) === 'c') { wanted.push(String(leaf(kids(c)[0]))); continue; }
      if (tag(c) === 'by-value-all') { all = true; continue; }
      throw new Error(`cpp->IR: lambda 的这一格捕获还没接：${tag(c)}`
        + '（按引用捕获要"把借走的局部量提上去"那台机器）');
    }
    const pnames = new Set(params.map((p) => p.name));
    if (all) {
      for (const n of freeNames(body)) {
        if (pnames.has(C.ref(n))) continue;
        if (C.tyCtx().env.get(C.ref(n)) === undefined) continue;   // 不是局部量（全局 / 函数名）
        if (!wanted.includes(n)) wanted.push(n);
      }
    }
    const caps = wanted.map((n) => {
      const flat = C.ref(n);
      const t = C.tyCtx().env.get(flat) ?? C.capNames.get(flat);
      if (t === undefined) throw new Error(`cpp->IR: lambda 捕获了 ${n}，可是这儿没有这格量`);
      return { name: flat, type: t };
    });
    /* 造点上那几格实参 —— **在换作用域之前**算（外面一层自己也可能在一格 lambda 里）。 */
    const capArgs = caps.map((c) => (
      C.tyCtx().env.get(c.name) === undefined && C.capNames.has(c.name)
        ? { kind: 'capture', name: c.name, type: c.type }
        : { kind: 'name', name: c.name }));
    const outer = { caps: C.capNames, self: C.self, scoped: C.scoped };
    C.capNames = new Map(caps.map((c) => [c.name, c.type]));
    C.self = null;
    C.scoped = [];
    let stmts;
    let ret;
    try {
      C.isolate(() => {
        C.push();
        for (const p of params) C.bind(p.name, p.type);
        stmts = kids(body).flatMap((s) => stmtsOf(s, C));
        const rv = firstReturn(stmts);
        ret = rv === null ? { kind: 'void' } : typeOf(rv, C.tyCtx());
        C.pop();
      });
    } finally {
      C.capNames = outer.caps;
      C.self = outer.self;
      C.scoped = outer.scoped;
    }
    const retTok = kids(tok).find((y) => tag(y) === 'ret');
    if (retTok !== undefined) {
      ret = typeOfSpecs(part(kids(retTok)[0], 'specs') ?? kids(kids(retTok)[0])[0], C) ?? ret;
    }
    decls.push({
      kind: 'closure', name, caps, params, ret, body: stmts,
    });
    return {
      kind: 'make-closure',
      name,
      caps: capArgs,
      type: { kind: 'fn-type', params: params.map((p) => p.type), ret },
    };
  };

  /** 实参类型 → 类型形参的绑定（**只认"形参的类型就是那个形参名"**那一档）。 */
  C.deduce = (name, argTypes) => {
    const t = C.templates.get(name);
    const f = kids(t.fnTok).find((y) => tag(y) === 'fn');
    const ps = part(f, 'params');
    const plist = ps === undefined ? [] : kids(ps).filter((y) => tag(y) === 'p');
    return t.tparams.map((tp) => {
      for (let i = 0; i < plist.length; i += 1) {
        const sp = part(plist[i], 'specs');
        const ns = (sp === undefined ? [] : kids(sp)).filter((y) => tag(y) === 'n').map(nameOf);
        if (ns.includes(tp) && argTypes[i] !== undefined) return argTypes[i];
      }
      throw new Error(`cpp->IR: \`${name}\` 的类型形参 ${tp} 推不出来`
        + '（这一批只认"某个形参的类型就写着它"那一档 —— 显式写出 `f<T>(…)` 也行）');
    });
  };
  /* 顶层函数的签名**要等三格实例化的口子装好之后**才算：`Box<int> mk(int)` 的返回类型
     就是一格用点，算它的时候会现造 `Box__int`。 */
  for (const f of topFns) {
    const s = sigOf(f);
    C.fns.set(s.name, { params: s.params, ret: s.ret });
  }

  for (const [, rec] of C.records) {
    /* 类模板的实例自己已经把三样都发过了（`C.instClass`）—— 跳过，别发第二份。 */
    if (rec.done === true) continue;
    const selfType = C.recType(rec.name);
    for (const m of rec.methods) {
      const s = sigOf(m.tok, selfType, `${C.ref(rec.name)}_${C.ref(m.name)}`);
      C.fns.set(s.name, { params: s.params, ret: s.ret });
    }
    if (rec.dtor !== null) {
      C.fns.set(dtorName(rec.name), {
        params: [{ name: 'this', type: selfType }],
        ret: { kind: 'void' },
      });
    }
    /* **构造函数**交的是一格记录（`Point__ctor(a, b) -> Point`）。 */
    if (rec.ctor !== null && rec.ctor !== undefined) {
      const s = sigOf(rec.ctor, undefined, ctorName(C.ref(rec.name)));
      C.fns.set(s.name, { params: s.params, ret: selfType });
    }
  }

  /* **虚方法的分派函数**（签名照根那一份抄，第一格实参是接收者）。 */
  for (const { root } of (C.vtRoots ?? [])) {
    const rootRef = C.ref(root);
    for (const [m] of C.vtab.get(rootRef)) {
      const base = C.fns.get(`${rootRef}_${C.ref(m)}`);
      C.fns.set(vcallName(rootRef, C.ref(m)), { params: base.params, ret: base.ret });
    }
  }

  /* ---- 第三遍：方法 / 析构 / 函数的体 -------------------------------------- */
  for (const [, rec] of C.records) {
    if (rec.done === true) continue;
    const selfType = C.recType(rec.name);
    for (const m of rec.methods) {
      const s = sigOf(m.tok, selfType, `${C.ref(rec.name)}_${C.ref(m.name)}`);
      decls.push(fnDecl(s, m.tok, C, C.ref(rec.name)));
    }
    if (rec.dtor !== null) {
      const s = {
        name: dtorName(rec.name),
        params: [{ name: 'this', type: selfType }],
        ret: { kind: 'void' },
      };
      decls.push(fnDecl(s, rec.dtor, C, C.ref(rec.name)));
    }
    if (rec.ctor !== null && rec.ctor !== undefined) {
      const s = sigOf(rec.ctor, undefined, ctorName(C.ref(rec.name)));
      decls.push(ctorDecl({ ...s, ret: selfType }, rec, C));
    }
  }
  for (const f of topFns) decls.push(fnDecl(sigOf(f), f, C));
  for (const d of vcallDecls(C)) decls.push(d);

  if (!C.fns.has('main')) throw new Error('cpp->IR: 这份源码里没有 `int main()`');
  return { kind: 'module', decls };
}

/**
 * **虚方法的分派函数**：按 `this.__vt` 走一条 if 链，兜底是根自己那一份
 * （`__vt` 为 0 —— 那是基类自己的对象）。
 *
 * 为什么是 if 链而不是一格"虚表"：方言里函数不是值（没有函数指针那一族），
 * 而这条链落的全是现成的 `if` + `call` —— 一格新节点也没加。派生类少的时候它也够快。
 */
function vcallDecls(C) {
  const out = [];
  for (const { root } of (C.vtRoots ?? [])) {
    const rootRef = C.ref(root);
    for (const [m, entries] of C.vtab.get(rootRef)) {
      const mref = C.ref(m);
      const sig = C.fns.get(vcallName(rootRef, mref));
      const fwd = sig.params.map((p) => ({ kind: 'name', name: p.name }));
      const callTo = (fn) => ({ kind: 'call', fn: { kind: 'name', name: fn }, args: fwd });
      const isVoid = sig.ret.kind === 'void';
      const hand = (fn) => (isVoid
        ? [{ kind: 'expr-stmt', expr: callTo(fn) }, { kind: 'return', values: [] }]
        : [{ kind: 'return', values: [callTo(fn)] }]);
      const body = [];
      for (const e of entries) {
        if (e.vt === 0) continue;               // 根那一份是兜底，摆在最后
        body.push({
          kind: 'if',
          cond: {
            kind: 'binop',
            op: '==',
            left: { kind: 'field', obj: { kind: 'name', name: 'this' }, name: VT },
            right: { kind: 'int', value: e.vt },
          },
          then: hand(e.fn),
          else_: null,
        });
      }
      body.push(...hand(`${rootRef}_${mref}`));
      out.push({
        kind: 'fn', name: vcallName(rootRef, mref), params: sig.params, ret: sig.ret, body,
      });
    }
  }
  return out;
}

/**
 * 体里**第一句交了值的 `return`** 那格表达式（lambda 的返回类型从它推）。
 * 要往 if / while / for / block / scope 里走 —— 不走的话 `[](int x){ if (…) return 1; return 2; }`
 * 会算成"什么都不交"，那是静默地错。
 */
function firstReturn(stmts) {
  for (const s of stmts) {
    if (s === null || s === undefined) continue;
    if (s.kind === 'return') return s.values.length === 0 ? null : s.values[0];
    for (const key of ['then', 'else_', 'body', 'stmts']) {
      const sub = s[key];
      if (!Array.isArray(sub)) continue;
      const v = firstReturn(sub);
      if (v !== null) return v;
    }
  }
  return null;
}

/**
 * 一棵树里出现过的名字（`(n X)`）。`[=]` 那一格用它猜"借走了哪几格量" ——
 * 会多收几个（字段名、函数名也长这样），所以调用点还要再过一道"这儿真有这格局部量"。
 * 多捕一格按值的量不改变答案，少捕一格才会错，所以宁可多收。
 */
function freeNames(tok) {
  const out = [];
  const walk = (t) => {
    if (t === null || t === undefined) return;
    if (tag(t) === 'n') { out.push(nameOf(t)); return; }
    if (!isList(t)) return;
    for (const k of kids(t)) walk(k);
  };
  walk(tok);
  return out;
}

/**
 * 一格 `(class …)` → `{ name, bases, fields, methods, dtor, ctor, virtuals }`。
 * `asName` 给了就用它当记录名（**类模板的实例**走这一格：同一棵树按不同的 `T` 读两遍，
 * 名字是 `Box__int` / `Box__real`）。字段与形参的类型走 `typeOfSpecs`，所以类型形参
 * 只要在 `C.aliases` 里绑着，这一份一个字都不用改。
 */
function collectClass(cls, C, asName = null) {
  /* **带基类的那一档，名字与基类表裹在一格无名表里**（`(class "struct" (· (n …) (bases …)) …)`）
     —— 无名表的孩子是**全部 items**（`cst.js` 文件头那条教训），所以先摊一层再找。 */
  const clsKids = kids(cls).flatMap((y) => (tag(y) === null && isList(y) ? groupItems(y) : [y]));
  const nm = clsKids.find((y) => tag(y) === 'n');
  /* **继承**：`struct Derived : Base {}` 的 `(bases (b (n "Base")))`。 */
  const basesTok = clsKids.find((y) => tag(y) === 'bases');
  const bases = (basesTok === undefined ? [] : kids(basesTok))
    .map((b) => nameOf(kids(b).find((y) => tag(y) === 'n')))
    .filter((b) => b !== null && b !== undefined);
  const members = clsKids.find((y) => tag(y) === 'members');
  const fields = [];
  const methods = [];
  const virtuals = new Set();
  let dtor = null;
  let ctor = null;
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
      /* **构造函数**：名字与类同名、而且**没有返回类型那一格**。 */
      if (head !== undefined && tag(head) === 'n' && nameOf(head) === nameOf(nm)
        && part(m, 'specs') === undefined) { ctor = m; continue; }
      const mn2 = (head !== undefined && tag(head) === 'opname')
        ? opMethodName(head) : nameOf(kids(f)[0]);
      /* `virtual` 是 specs 里的一格光秃秃的词。 */
      const ms2 = part(m, 'specs');
      if (ms2 !== undefined
        && kids(ms2).some((y) => tag(y) === null && String(leaf(y)) === 'virtual')) {
        virtuals.add(mn2);
      }
      methods.push({ tok: m, name: mn2 });
    }
  }
  return {
    name: asName ?? nameOf(nm), bases, fields, methods, dtor, ctor, virtuals,
  };
}

/**
 * **哪几棵继承树要合成一格记录**（`C.storage` / `C.vtId`）。
 *
 * 判据只有一条：树里**有人写了 `virtual`**。没写的（`inherit.cpp` 那一族）照旧一类一格
 * 记录、方法静态分派 —— 那条路已经全绿，不为这一格去动它。
 *
 * **Why 合成一格**：方言的记录没有子类型，`Shape* p = &r;` 在"两格互不相关的记录"上
 * 根本表示不出来。合成一格（字段是并集 + 一格 `__vt` 标记）之后它就是一格普通赋值，
 * 而"按真身分派"落成按 `__vt` 走的 if 链 —— 图上一格新节点也没加。
 */
function planVirtuals(C, recFields, decls) {
  const rootOf = (name, seen = new Set()) => {
    const rec = C.records.get(name);
    if (rec === undefined || rec.bases.length === 0) return name;
    if (seen.has(name)) throw new Error(`cpp->IR: 继承成环了（${name}）`);
    return rootOf(rec.bases[0], new Set([...seen, name]));
  };
  /* 每棵树的成员表（根 → 树里的类，按登记次序）。 */
  const trees = new Map();
  for (const [n] of C.records) {
    const r = rootOf(n);
    if (!trees.has(r)) trees.set(r, []);
    trees.get(r).push(n);
  }
  for (const [root, members] of trees) {
    const anyVirtual = members.some((n) => C.records.get(n).virtuals.size > 0);
    if (!anyVirtual) {
      for (const n of members) { C.storage.set(n, n); C.storageRef.set(C.ref(n), C.ref(n)); }
      continue;
    }
    if (members.some((n) => C.records.get(n).bases.length > 1)) {
      throw new Error(`cpp->IR: 虚函数 + 多继承还没接（${root} 那棵树）`);
    }
    members.forEach((n, i) => {
      C.storage.set(n, root);
      C.storageRef.set(C.ref(n), C.ref(root));
      C.vtId.set(n, i);
      C.vtIdRef.set(C.ref(n), i);
    });
    C.vtRoots = C.vtRoots ?? [];
    C.vtRoots.push({ root, members });
  }
  /* 这两个实参只是让调用点读起来是"三件事一起算"，这一趟不用它们。 */
  void recFields; void decls;
}

/** `__vt` 那一格字段的名字（用户写不出这个名字 —— 双下线开头是留给我们的）。 */
const VT = '__vt';

/**
 * 虚继承树的**落地**：根那一格记录的字段 = 整棵树的并集 + `__vt`，
 * 再给每个虚方法发一格**分派函数** `根__v_方法(this, …)` —— 按 `__vt` 走 if 链，
 * 兜底是根自己那一份（`__vt` 为 0 就是基类的对象）。
 */
function layoutVirtual(C, recFields, decls) {
  for (const { root, members } of (C.vtRoots ?? [])) {
    const union = [];
    for (const n of members) {
      for (const f of C.records.get(n).fields) {
        if (!union.some((y) => y.name === f.name)) union.push(f);
      }
    }
    union.push({ name: VT, type: INT });
    const rootRef = C.ref(root);
    recFields.set(rootRef, union);
    const cls = decls.find((d) => d.kind === 'class' && d.name === rootRef);
    cls.fields = union;
    C.vtUnion = C.vtUnion ?? new Map();
    C.vtUnion.set(rootRef, union);
    /* 分派表：一格虚方法名 → 每个派生类那一份。 */
    const tab = new Map();
    for (const name of C.records.get(root).virtuals) {
      tab.set(name, members.map((n) => ({
        vt: C.vtId.get(n), fn: `${C.ref(n)}_${C.ref(name)}`,
      })));
    }
    C.vtab.set(rootRef, tab);
  }
}

/**
 * **把基类摊进派生类**（单继承与多继承都走这一格，按声明次序）。
 *
 * 落法是**摊平**：字段表 = 基类的接在自己前面（C++ 的布局也是这样）、
 * 方法按**名字**继承（派生类自己那一份赢 —— C++ 的隐藏规则）。
 * 为什么不给方言加"基类"那一格：方言的记录只有一张字段表，摊平之后
 * `d.基类字段` 与 `d.自己的字段` 在同一格记录上，三条腿一格都不用改。
 *
 * 继承来的方法**按派生类再发一份体**（接收者的类型不同，方言那侧是两格类型）——
 * 字段已经摊平了，所以同一份体在派生类上逐字成立。
 */
function flatten(rec, C, seen) {
  if (rec.flat === true) return;
  if (seen.has(rec.name)) {
    throw new Error(`cpp->IR: 继承成环了（${[...seen, rec.name].join(' -> ')}）`);
  }
  const next = new Set([...seen, rec.name]);
  const fields = [];
  const methods = [];
  for (const bn of rec.bases ?? []) {
    const base = C.records.get(bn);
    if (base === undefined) throw new Error(`cpp->IR: 基类 ${bn} 没有登记过`);
    flatten(base, C, next);
    for (const f of base.fields) if (!fields.some((y) => y.name === f.name)) fields.push(f);
    for (const m of base.methods) methods.push(m);
  }
  for (const f of rec.fields) if (!fields.some((y) => y.name === f.name)) fields.push(f);
  /* 派生类自己那一份**盖掉**同名的基类方法。 */
  const own = new Set(rec.methods.map((m) => m.name));
  rec.methods = [...methods.filter((m) => !own.has(m.name)), ...rec.methods];
  rec.fields = fields;
  rec.flat = true;
}

/**
 * 一格函数。**析构交给公共层的作用域出口**（`{ kind: 'scope', stmts, exits }`）——
 * 从前这一份自己在"体的末尾"与"每个 `return` 前面"各补一遍，那是六门语言里第六份同样的
 * 代码，而且漏一个出口（跳出函数的 `break`、`if` 里的 `return`）就是**静默地少跑一段**。
 * 现在只交两样：体，与那几句出口动作（**逆序** —— 那是 C++ 的规矩，不是公共层的）。
 */
function fnDecl(sig, fnTok, C, selfName = null) {
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  const outerScoped = C.scoped;
  const outerSelf = C.self;
  C.self = selfName;
  C.scoped = [];
  const body = part(fnTok, 'body');
  const stmts = body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C));
  const exits = dtorCalls(C);
  C.scoped = outerScoped;
  C.self = outerSelf;
  C.pop();
  return {
    kind: 'fn',
    name: sig.name,
    params: sig.params,
    ret: sig.ret,
    body: exits.length === 0 ? stmts : [{ kind: 'scope', stmts, exits }],
  };
}

/**
 * **一格构造函数**。落成"造一格零值记录 → 跑成员初始化表 → 跑体 → 交出去"的普通函数：
 *
 *   Point__ctor(a, b) -> Point { let this = Point{x:0,y:0,sum:0}; this.x=a; this.y=b; …; return this }
 *
 * 两条是 C++ 的规矩，不是公共层的：
 *   1. 成员初始化表**按字段声明的次序**跑（不按表里写的次序 —— 那一格写反了答案会静默地错）；
 *   2. 体里裸写的名字先查形参、再查字段（`C.self` 那条既有规矩，见 expr.js 的 `case 'n'`）。
 */
function ctorDecl(sig, rec, C) {
  const recName = C.ref(rec.name);
  const selfType = C.recType(rec.name);
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  C.bind('this', selfType);
  const outerScoped = C.scoped;
  const outerSelf = C.self;
  C.self = recName;
  C.scoped = [];
  const stmts = [{
    kind: 'let',
    name: 'this',
    type: selfType,
    /* 零值记录走同一份（虚继承树上那一格要带 `__vt`，字段表也是并集）。 */
    init: vtZeroRecord(selfType, C),
  }];
  /* 成员初始化表 —— 按**字段声明的次序**，不按表里写的次序。 */
  const initTok = kids(rec.ctor).find((y) => tag(y) === 'ctor-init');
  const inits = new Map();
  for (const mi of (initTok === undefined ? [] : kids(initTok))) {
    if (tag(mi) !== 'mi') continue;
    const args = part(mi, 'args');
    if (args === undefined || kids(args).length !== 1) {
      throw new Error('cpp->IR: 成员初始化表这一格还没接（只接 `字段(一格表达式)`）');
    }
    inits.set(nameOf(kids(mi)[0]), kids(args)[0]);
  }
  for (const f of rec.fields) {
    const e = inits.get(f.name);
    if (e === undefined) continue;
    stmts.push({
      kind: 'assign',
      target: { kind: 'field', obj: { kind: 'name', name: 'this' }, name: f.name },
      value: exprOf(e, C),
    });
  }
  const body = part(rec.ctor, 'body');
  if (body !== undefined) for (const s of kids(body)) stmts.push(...stmtsOf(s, C));
  stmts.push({ kind: 'return', values: [{ kind: 'name', name: 'this' }] });
  const exits = dtorCalls(C);
  C.scoped = outerScoped;
  C.self = outerSelf;
  C.pop();
  return {
    kind: 'fn',
    name: sig.name,
    params: sig.params,
    ret: selfType,
    body: exits.length === 0 ? stmts : [{ kind: 'scope', stmts, exits }],
  };
}

/**
 * 一格**带 `__vt` 的零值记录**。字段表取的是**落地那格记录**的（虚继承树上那是并集），
 * 所以派生类自己那几格也在里头 —— 少一格 `new-record` 就会缺字段。
 */
function vtZeroRecord(type, C) {
  const fs = C.tyCtx().fields.get(type.name) ?? [];
  const id = C.vtIdRef.get(type.cls) ?? 0;
  return {
    kind: 'new-record',
    type,
    ref: true,
    fields: fs.map((f) => ({
      name: f.name,
      value: f.name === VT ? { kind: 'int', value: id } : zeroFor(f.type),
    })),
  };
}

/** 一格类型的零值（构造函数先造一格全零的记录，再让初始化表与体去改）。 */function zeroFor(t) {
  switch (t.kind) {
    case 'int': return { kind: 'int', value: 0 };
    case 'real': return { kind: 'real', value: 0 };
    case 'bool': return { kind: 'bool', value: false };
    case 'string': return { kind: 'string', value: '' };
    case 'arr': return { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: 0 }] };
    case 'map': return { kind: 'builtin', name: 'dnew', args: [tyArg(t)] };
    default:
      throw new Error(`cpp->IR: 构造函数里 ${t.kind} 那一格字段的零值还没接`);
  }
}

/** 当前函数里那几格带析构的量 → **逆序**各调一次（C++ 的规矩）。 */function dtorCalls(C) {
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
      /* 析构不在这儿补 —— 公共层那一格 `scope` 在**每个**出口上补（见 `fnDecl`）。 */
      const vs = kids(x);
      return [{ kind: 'return', values: vs.length === 0 ? [] : [exprOf(vs[0], C)] }];
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
  /**
   * 裸名字走 `exprOf` —— 那一份已经有"局部量先查、再当 `this->` 那一格字段"的规矩
   * （见 expr.js 的 `case 'n'`）。**赋值的左边也要认这条**：构造函数体里的
   * `sum = total();` 与方法里的 `n = 1;` 改的都是字段，写成裸 `(set sum …)` 会报未声明。
   */
  if (tag(t) === 'n') {
    const e = exprOf(t, C);
    if (e.kind !== 'name' && e.kind !== 'field') {
      throw new Error(`cpp->IR: \`${nameOf(t)}\` 不能当赋值的左边`);
    }
    return e;
  }
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
  /**
   * **构造**：`Point p(1, 2)` 走 `(ctor (args …))` 那一格，`Counter c;`（这个类有构造函数）
   * 走的是"没有初值"那一格 —— 两者落的都是一次 `Rec__ctor(…)`。没有构造函数的类照旧
   * （`Point p;` 是 `init: null`，`Say s1;` 只登记析构）。
   */
  const ctorTok = kids(dd).find((y) => tag(y) === 'ctor');
  /**
   * **虚继承树里的对象要带上 `__vt`**（那是"真身是谁"的唯一记号）。`Square q;` 落成
   * 一格全零的根记录 + `__vt = 1` —— 忘了这一句，分派会一路走到兜底那份，
   * 答案静默地错成基类的。
   */
  if (type.kind === 'named' && C.vtIdRef.has(type.cls)
    && ctorTok === undefined && initTok === undefined) {
    return {
      kind: 'let', name, type, init: vtZeroRecord(type, C),
    };
  }
  if (type.kind === 'named' && C.fns.has(`${type.name}__ctor`)
    && (ctorTok !== undefined || initTok === undefined)) {
    const as = ctorTok === undefined ? undefined : part(ctorTok, 'args');
    return {
      kind: 'let',
      name,
      type,
      init: {
        kind: 'call',
        fn: { kind: 'name', name: `${type.name}__ctor` },
        args: as === undefined ? [] : kids(as).map((a) => exprOf(a, C)),
      },
    };
  }
  return {
    kind: 'let', name, type,
    init: initTok === undefined ? null : exprOf(kids(initTok)[0], C),
  };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. **异常**还没接（当场报）。
//   2. `printf` 的格式串走公共层那一份（`src/core/lower/fmt.js` 的 `fmtToIR`）：
//      宽度与标志（`%5d` / `%-5d` / `%05d`）还没接，而且格式串必须**以一个换行收尾**
//      （方言的 `print` 自带换行，"不换行地写一段"这一层还没有）。
//   3. 引用（`T&`）当值收（例子里只用它传结构 —— 记录本来就是引用语义）；
//      `&x` 只在记录/列表/字典上成立（标量上当场报，那要真指针）。
//   4. 整数那一族只有一格宽度：定宽类型（`int8_t` …）的位宽表在
//      `src/core/lower/cfam.js` 的 `C_INT_BITS`（与 jancy 共用一张），**回卷还没接**。
//   5. 构造函数一个类只认**一份**（重载还没接）；拷贝构造与赋值算子也没有 ——
//      记录是引用语义，所以那两格在这条腿上本来就不是"拷贝"。
//   6. 虚函数只接**单继承**（虚函数 + 多继承当场报）；纯虚（`= 0`）与虚析构没接。
//   7. 类模板只接"没有继承、没有虚函数、没有构造/析构"那一档（别的当场报）；
//      模板的默认实参与特化没接。
//   8. lambda 的捕获**一律按值**：`[&]` / `[&x]` 当场报（按引用要"把借走的局部量提上去"
//      那台机器，go 那侧的 `promote`）；`mutable`、`[this]`、泛型 lambda 也没接。
