// ext/python/adapter/index.js —— **Python → 标准 IR**（ADR-0044）
//
// ## 这一门最特别的地方：**一个类型标注都不必写**
//
// 借来的十门里，awk / Scheme / Common Lisp 也不写类型，但它们的值只有"数与串"两档。
// python 的值有表、字典、浮点、整数、串、布尔 —— 而方言（`.sx`）是静态类型、**不推导只检查**。
// 所以这一份里最大的一块是**推断**，办法与 R 那一门（`r-lang` 分支）同一条：
//
//   1. 形参的类型：**标注优先**（`def f(x: int)`），没标注就**从调用点推**；
//   2. 返回类型：形参定了之后扫函数体里的 `return`；
//   3. 模块级变量：从它的初值推；
//   4. 以上三件互相依赖（`g = f(1)` 要先有 f 的返回类型，而 f 的形参可能来自 `f(g)`），
//      所以**整个扫三轮**，每轮只填得出来的那几格。
//
// **推不出来的退到 dyn**（`./dyn.js`），不是当场报要标注 —— 那是个错结论：方言那一侧早就有
// 真动态那一族，而 JS 整门语言就跑在它上面（ADR-0011 决策 1），js→C 还是自举主干。
// 口径按 ADR-0008：异质 ⇒ 统一降为 dynamic。**推得出来仍然优先**（箱子上的算术要按
// `(dtag …)` 分派，比静态那条路贵），所以单态化与三轮推断一格没动。
//
// ## 入口
//
// python 没有 `main` —— **顶层语句就是入口**（与 awk 的 BEGIN、lua 的顶层语句同一档），
// 所以发 `{ kind: 'main', body }`。顶层赋的那几个名字是**模块级变量**（`(global …)`），
// 函数体里读得到它们；方言那一层的规矩是"global 不带初值"，所以初值摆成入口里的一句 `set`。
//
// `__name__` 预先登记成一格串并在入口里置成 `"__main__"` —— 于是
// `if __name__ == "__main__": main()` 这个惯用写法直接能跑。

import { tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import { INT, STR, DYN, sameType, typeOf, named } from '../../../src/core/lower/ty-of.js';
import { typeToSx } from '../../../src/core/lower/ty.js';
import {
  exprOf, condOf, nameOf, typeOfAnnot, tyOfCst, tyArg, pyStr, lenOf,
} from './expr.js';
import { boxOf, unifyPy } from './dyn.js';

/** 一格已经建好的 IR 表达式装的是什么。 */
const typeOfIR = (e, C) => typeOf(e, C.tyCtx());

/** 一棵 python 的树（`(module …)`）→ 标准 IR 的模块。 */
export function pyToIR(tree) {
  if (tag(tree) !== 'module') throw new Error('python->IR: 这不是 (module …)');

  const C = makeCtx();
  const top = flatten(kids(tree));
  const fnNodes = top.filter((s) => tag(s) === 'def');
  const classNodes = top.filter((s) => tag(s) === 'class');
  const scriptStmts = top.filter((s) => tag(s) !== 'def' && tag(s) !== 'class');

  for (const f of fnNodes) {
    const nm = String(nameOf(kids(f).find((y) => tag(y) === 'n')));
    if (C.fnNodes.has(nm)) throw new Error(`python->IR: \`def ${nm}\` 定义了两遍 —— 还没接（后一个盖前一个）`);
    C.fnNodes.set(nm, f);
  }
  declareClasses(classNodes, C);
  infer(C, tree, scriptStmts);

  /* ---- 发射 ------------------------------------------------------------------ */
  const decls = [];
  /* 记录的声明要**排在函数前面**（方言那一层先收类型再收签名）。 */
  for (const [, rec] of C.records) {
    decls.push({ kind: 'class', name: rec.type.name, fields: rec.fields });
  }
  for (const [name, ty] of C.globals) decls.push({ kind: 'global', name: C.ref(name), type: ty });
  for (const [nm, insts] of C.insts) {
    for (const inst of insts) decls.push(fnDecl(nm, inst, C));
  }

  C.push();
  const body = [
    { kind: 'assign', target: { kind: 'name', name: C.ref('__name__') }, value: { kind: 'string', value: '__main__' } },
    ...scriptStmts.flatMap((s) => stmtsOf(s, C)),
  ];
  C.pop();
  decls.push({ kind: 'main', body });
  return { kind: 'module', decls };
}

/** `(line a b)` 那一层摊掉 —— 顶层与块体里都是这个形状。 */
function flatten(items) {
  return items.flatMap((s) => (tag(s) === 'line' || tag(s) === 'body' ? flatten(kids(s)) : [s]));
}

/* ─── class ───────────────────────────────────────────────────────────────── */

/**
 * 登记每个 `class` 的名字与方法。**字段等推断那几轮再算** —— 字段的类型来自
 * `__init__` 里的 `self.x = …`，而那要先知道 `__init__` 的形参装什么。
 *
 * 落点照 mojo 那一门（`ext/mojo/adapter/index.js`）：方言的 `(class …)`（引用语义），
 * 方法落成普通函数 `<类名>_<方法名>`，`self` 是第一格实参 —— 单态分派，声明里写着它属于谁。
 */
function declareClasses(nodes, C) {
  for (const cls of nodes) {
    const nm = String(nameOf(kids(cls).find((y) => tag(y) === 'n')));
    if (C.records.has(nm)) throw new Error(`python->IR: \`class ${nm}\` 定义了两遍 —— 还没接`);
    if (kids(part(cls, 'bases') ?? { kind: 'list', items: [] }).length > 0) {
      throw new Error(`python->IR: \`class ${nm}(…)\` 的继承还没接`);
    }
    if (part(cls, 'tparams') !== undefined) {
      throw new Error(`python->IR: \`class ${nm}[T]\` 的类型形参还没接`);
    }
    const rec = {
      name: nm,
      type: named(C.ref(nm), true),
      fields: [],
      methods: new Map(),
      annots: [],
    };
    for (const s of flatten(kids(part(cls, 'body') ?? { kind: 'list', items: [] }))) {
      if (tag(s) === 'def') {
        const mn = String(nameOf(kids(s).find((y) => tag(y) === 'n')));
        rec.methods.set(mn, s);
        C.fnNodes.set(`${nm}.${mn}`, s);
        continue;
      }
      /* 类级的标注就是字段声明（`x: int`）。 */
      if (tag(s) === 'annot') { rec.annots.push(s); continue; }
      /* 文档串与 `pass` 忽略；别的当场报（类体里的赋值是**类属性**，那是另一格）。 */
      if (tag(s) === 'pass') continue;
      if (tag(s) === 'expr' && tag(kids(s)[0]) === 'str') continue;
      throw new Error(`python->IR: \`class ${nm}\` 的体里有 \`${tag(s)}\` —— 还没接`
        + '（只接了方法、类级标注、文档串与 pass）');
    }
    C.records.set(nm, rec);
  }
}

/**
 * 一格类的字段 = 类级标注 + `__init__` 顶层那几句 `self.x = …`（按出现次序）。
 *
 * **标注优先**；没标注的字段把**所有 `__init__` 实例**里看到的类型合成一格（`unifyPy`）——
 * 类不像函数那样按实参单态化（一个 `(class Point …)` 只有一份字段表），所以
 * `Point(3, 4)` 与 `Point(1.5, 2.5)` 里 `x` 装的东西不同型时，那一格**退到 dyn**。
 * 要静态的那一档，给字段一格标注（`x: float`）。
 *
 * **明说的近似**：只扫 `__init__` 的**顶层语句**。`if …: self.x = 1` 那种条件里才出现的
 * 字段收不到 —— 那时报的是"这个字段不在记录里"，离根因不远，所以先不猜。
 */
function inferFields(rec, C) {
  /* 名字 → 看到过的那几格类型（按第一次出现的次序记名字）。 */
  const order = [];
  const seen = new Map();
  const add = (n, t) => {
    if (t === null || t === undefined) return;
    if (!seen.has(n)) { order.push(n); seen.set(n, []); }
    seen.get(n).push(t);
  };
  const annotated = new Set();
  for (const a of rec.annots) {
    const n = String(nameOf(kids(a)[0]));
    const t = typeOfAnnot(kids(a)[1], C);
    if (t === null) continue;
    annotated.add(n);
    add(n, t);
  }
  const init = rec.methods.get('__init__');
  for (const inst of C.insts.get(`${rec.name}.__init__`) ?? []) {
    if (init === undefined) break;
    C.push();
    for (const p of inst.params) C.bind(p.name, p.type);
    for (const s of flatten(kids(part(init, 'body') ?? { kind: 'list', items: [] }))) {
      if (tag(s) !== 'assign') continue;
      const value = kids(s)[kids(s).length - 1];
      for (const g of kids(part(s, 'lhs') ?? { kind: 'list', items: [] })) {
        const t0 = kids(g)[0];
        if (tag(t0) !== 'attr') continue;
        if (tag(kids(t0)[0]) !== 'n' || String(nameOf(kids(t0)[0])) !== 'self') continue;
        const n = String(leaf(kids(t0)[1]));
        if (annotated.has(n)) continue;              // 标注说了算
        add(n, tyOfCst(value, C));
      }
    }
    C.pop();
  }
  rec.fields = order
    .map((n) => ({ name: n, type: unifyPy(seen.get(n)) }))
    .filter((f) => f.type !== null);
  /* 字段退到 dyn 这一档**方言那一侧还不收**（`(class …)` 的字段白名单里没有 dyn，
     见 `src/core/sexpr/lower.js` 的字段检查）—— 所以在这儿报，别让它落到下一层
     变成"类 Point 没有字段 'x'"那一串连锁错。 */
  for (const f of rec.fields) {
    if (f.type.kind !== 'dyn') continue;
    const ks = [...new Set(seen.get(f.name).map((t) => t.kind))].join(' / ');
    throw new Error(`python->IR: \`${rec.name}.${f.name}\` 在几处造出来时装的是 ${ks}`
      + ' —— 类不按实参单态化（一格 `(class …)` 只有一份字段表），而方言的字段还不收 dyn'
      + `（给它一格标注，如 \`${f.name}: float\`；或者两处都造成同一种）`);
  }
}

/** 一格类型的短名（单态化的名字后缀与那张表的键都用它）。 */
function tyTag(t) {
  if (t === null || t === undefined) return '_';
  switch (t.kind) {
    case 'int': return 'int';
    case 'real': return 'float';
    case 'string': return 'str';
    case 'bool': return 'bool';
    case 'void': return 'none';
    case 'arr': return `list_${tyTag(t.elem)}`;
    case 'map': return `dict_${tyTag(t.key)}_${tyTag(t.value)}`;
    default: return t.name ?? 'x';
  }
}
const tyKey = (types) => types.map(tyTag).join(',');

/* ─── 上下文 ──────────────────────────────────────────────────────────────── */

function makeCtx() {
  let tmpN = 0;
  const names = new Map();
  const scopes = [];
  const gdecls = [];
  const C = {
    /** 现在在不在函数体里（模块级的赋值是给 `(global …)` 的 `set`，函数里的是 `let`）。 */
    inFn: false,
    /** 当前在发的这格函数交出来的类型（`return` 那一句要按它装箱 / 提 real）。 */
    retTy: null,
    /** 函数名 → { params: [{name,type}], ret }。签名，推断填。 */
    fns: new Map(),
    /**
     * **单态化那张表**：python 的函数名 → 一串"实例"。
     * `add(2, 3)` 与 `add(1.5, 2.5)` 在 python 里是同一个函数，在方言里是两个 ——
     * 所以按**实参类型的元组**各生成一格，名字加后缀（`add__int_int` / `add__float_float`）。
     * 只有一格实例时不加后缀（多数函数是这一档，`.sx` 读起来干净）。
     * 每一格：`{ key, mangled, params, ret, annots, retAnnot }`。
     */
    insts: new Map(),
    /**
     * 一处调用该落到哪一格实例上：先按实参类型精确找，找不到再试"int 提到 real"。
     * 实参类型还没推出来（null）时，只有一格实例就用它 —— 那是推断头一两轮的常态。
     */
    /** 一格具名类型对应的那格记录（字段表 / 方法表靠它）。 */
    recOf: (t) => (t === null || t === undefined || t.kind !== 'named' ? null
      : ([...C.records].map((e) => e[1]).find((r) => r.type.name === t.name) ?? null)),
    /** 一处方法调用该落到哪一格实例上。 */
    resolveMethod: (cls, m, argTys) => C.resolveFn(`${cls}.${m}`, argTys),
    resolveFn: (nm, argTys) => {
      const list = C.insts.get(nm);
      if (list === undefined || list.length === 0) return null;
      if (argTys.some((t) => t === null || t === undefined)) {
        return list.length === 1 ? list[0] : null;
      }
      const want = tyKey(argTys);
      const exact = list.find((i) => i.key === want);
      if (exact !== undefined) return exact;
      const up = list.find((i) => i.params.length === argTys.length
        && i.params.every((p, k) => p.type !== null
          && (sameType(p.type, argTys[k]) || (p.type.kind === 'real' && argTys[k].kind === 'int'))));
      return up ?? null;
    },
    /** 函数名 → 那棵 `(def …)`。 */
    fnNodes: new Map(),
    /** 模块级变量名 → 类型。 */
    globals: new Map(),
    /** 记录（class）—— 这一版空着，留着让 `typeOfAnnot` 那条路不必分支。 */
    records: new Map(),
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
    /** python 的名字 → 方言里那个名字（方言只收 `[A-Za-z0-9_]`）。 */
    ref: (n) => {
      if (!names.has(n)) {
        let s = String(n).replace(/[^A-Za-z0-9_]/g, '_');
        if (/^[0-9]/.test(s)) s = `_${s}`;
        names.set(n, s);
      }
      return names.get(n);
    },
    push: () => { scopes.push(new Map()); gdecls.push(new Set()); },
    pop: () => { scopes.pop(); gdecls.pop(); },
    /** `global x` 说过的那几个名字（那时的赋值是写模块级那一格，不是造一格新的局部）。 */
    markGlobal: (n) => { if (gdecls.length > 0) gdecls[gdecls.length - 1].add(n); },
    isDeclGlobal: (n) => gdecls.some((s) => s.has(n)),
    bind: (n, t) => {
      if (scopes.length === 0) C.globals.set(n, t);
      else scopes[scopes.length - 1].set(n, t);
    },
    /** 这一层里有没有（决定发 `let` 还是 `set`）。 */
    here: (n) => (scopes.length > 0 && scopes[scopes.length - 1].has(C.ref(n))),
    /**
     * **只看这一层**装的是什么（`lookup` 会一路看到模块级那张表）。
     *
     * 赋值那一侧要它：python 里**函数体内赋一个名字就是造一格局部**（除非说了 `global`），
     * 哪怕模块级有个同名的。用 `lookup` 的症状是那格局部根本不生成，
     * `set` 打到模块级那一格上去 —— 量到的是 `for v in xs` 里的 v 撞上模块级的 v
     * （"'v' 是 dynamic，赋的值是 int"）。
     */
    lookupHere: (n) => {
      if (scopes.length === 0) return C.globals.get(n) ?? null;
      const v = scopes[scopes.length - 1].get(C.ref(n));
      return v === undefined ? null : v;
    },
    /** 在不在某一层作用域里（函数体、或推断时那一趟临时的那层）。 */
    inScope: () => scopes.length > 0,
    /** 这一层登记过的名字与类型（函数体开头那一批 `let` 靠它）。 */
    localsHere: () => (scopes.length === 0 ? [] : [...scopes[scopes.length - 1]]),
    /** 名字装的是什么；找不到回 `null`。 */
    lookup: (n) => {
      const k = C.ref(n);
      for (let i = scopes.length - 1; i >= 0; i -= 1) {
        const v = scopes[i].get(k);
        if (v !== undefined) return v;
      }
      return C.globals.get(n) ?? null;
    },
    tyCtx: () => ({
      env: { get: (n) => C.lookupRef(n) },
      fns: new Map([...C.fns].map(([k, v]) => [C.ref(k), v])),
      fields: new Map([...C.records].map((e) => [e[1].type.name, e[1].fields])),
    }),
    /** 按**方言里那个名字**查（`tyCtx().env` 收到的是改过的名字）。 */
    lookupRef: (n) => {
      for (let i = scopes.length - 1; i >= 0; i -= 1) {
        const v = scopes[i].get(n);
        if (v !== undefined) return v;
      }
      for (const [g, t] of C.globals) if (C.ref(g) === n) return t;
      return undefined;
    },
  };
  return C;
}

/* ─── 推断（三轮）────────────────────────────────────────────────────────── */

/** 树里所有节点，深度优先。**不用生成器** —— 这份文件跟着编译器一起被降级，子集越窄越稳。 */
function allNodes(x, out = []) {
  if (x === null || x === undefined || x.kind !== 'list') return out;
  out.push(x);
  for (const k of kids(x)) allNodes(k, out);
  return out;
}

/** 一格 `(def …)` 的形参表（`(params (p (n x) [T] …) …)`）。 */
const paramsOf = (f) => kids(part(f, 'params') ?? { kind: 'list', items: [] });

/**
 * 形参、返回类型、模块级变量 —— 整个扫三轮，每轮只填得出来的那几格。
 * 三轮之后还缺的当场报（见文件头那四条）。
 *
 * **单态化**在这一趟里：一个 python 函数按"实参类型的元组"生成几格实例。
 * `add(2, 3)` 与 `add(1.5, 2.5)` 在 python 里是同一个 `add`，在方言里是两个函数。
 */
function infer(C, tree, scriptStmts) {
  C.globals.set('__name__', STR);

  /* 每个函数先摆一格骨架（标注读出来、形参的名字定下来）。 */
  const shells = new Map();
  for (const [nm, f] of C.fnNodes) {
    const ps = paramsOf(f);
    for (const p of ps) {
      if (tag(p) !== 'p') throw new Error(`python->IR: \`def ${nm}\` 的形参里有 \`${tag(p)}\` —— 还没接（*args / **kw / 位置标记）`);
      if (part(p, 'default') !== undefined) throw new Error(`python->IR: \`def ${nm}\` 的形参带默认值 —— 还没接`);
    }
    /* 方法的名字是 `<类名>.<方法名>`（`declareClasses` 摆进来的）。它的第一格形参是
       `self`，类型就是那个类 —— 相当于自带一格标注，所以调用点不必推它。 */
    const dot = nm.indexOf('.');
    const rec = dot < 0 ? null : C.records.get(nm.slice(0, dot));
    if (rec !== null) {
      if (ps.length === 0 || String(nameOf(kids(ps[0])[0])) !== 'self') {
        throw new Error(`python->IR: \`class ${rec.name}\` 的 \`${nm.slice(dot + 1)}\` 第一格形参不是 self`
          + ' —— 类方法 / 静态方法还没接');
      }
    }
    shells.set(nm, {
      names: ps.map((p) => C.ref(String(nameOf(kids(p)[0])))),
      annots: ps.map((p, i) => (rec !== null && i === 0 ? rec.type : typeOfAnnot(kids(p)[1], C))),
      retAnnot: typeOfAnnot(kids(part(f, 'ret') ?? { kind: 'list', items: [] })[0], C),
      rec,
    });
    /* 形参全带标注的那一档第一轮就定得下来；别的先摆一格空表，等调用点。 */
    const sh = shells.get(nm);
    C.insts.set(nm, sh.annots.every((a) => a !== null) ? [mkInst(nm, sh, sh.annots)] : []);
  }

  for (let round = 0; round < 3; round += 1) {
    for (const [nm, sh] of shells) collectInsts(nm, sh, tree, C);
    /* 字段要在方法体扫 `return` 之前算好（`self.x` 的类型靠它）。 */
    for (const [, rec] of C.records) inferFields(rec, C);
    for (const [nm, list] of C.insts) {
      const { retAnnot } = shells.get(nm);
      for (const inst of list) {
        /* **每轮都重算一遍**（不是"空着才算"）：头一轮里被调方的返回类型可能还没定，
           那时算出来的是个下界；到最后一轮全定了，不一致的地方才现形。 */
        inst.ret = retAnnot !== null ? retAnnot : inferRet(nm, inst, C);
      }
    }
    for (const s of scriptStmts) scanBinds(s, C);
  }

  /* 名字：只有一格实例时不加后缀（多数函数是这一档），多格时加类型后缀。
     方法的名字是 `<类名>_<方法名>`（mojo 那一门同一个落点）。 */
  for (const [nm, list] of C.insts) {
    /* 一个调用点都没有、形参又没标注（这份源码里根本没调它）—— 那几格退到 dyn，
       发一格实例出去。从前这儿是当场报"给它一格标注"；不必，`dyn.js` 那条道就是为它来的。 */
    if (list.length === 0) {
      const sh = shells.get(nm);
      const inst = mkInst(nm, sh, sh.annots.map((a) => a ?? DYN));
      inst.ret = sh.retAnnot !== null ? sh.retAnnot : inferRet(nm, inst, C);
      list.push(inst);
    }
    const base = nm.indexOf('.') < 0 ? C.ref(nm) : C.ref(nm.replace('.', '_'));
    for (const inst of list) {
      inst.mangled = list.length === 1
        ? base
        : `${base}__${inst.key.replace(/[^A-Za-z0-9_]/g, '_')}`;
      if (inst.ret === null) inst.ret = { kind: 'void' };
      C.fns.set(inst.mangled, { params: inst.params, ret: inst.ret });
    }
  }
  /* `__init__` 交的是 void（python 那边不许 return 值）—— 造一格靠 `cnew` + 调它。 */
  for (const [, rec] of C.records) {
    const list = C.insts.get(`${rec.name}.__init__`);
    if (list !== undefined) for (const inst of list) inst.ret = { kind: 'void' };
  }
}

/** 一格实例。 */
function mkInst(nm, sh, types) {
  return {
    key: tyKey(types),
    mangled: null,
    params: sh.names.map((n, i) => ({ name: n, type: types[i] })),
    ret: null,
  };
}

/**
 * 从调用点收实例：全树找 `f(…)`，每一组**全都推得出来**的实参类型就是一格实例。
 *
 * 形参带标注的那几格听标注（调用点只补没标注的）。一组都收不到、而形参又没标全的，
 * 这一轮就先空着 —— 三轮之后还空着的在 `infer` 末尾当场报。
 */
function collectInsts(nm, sh, tree, C) {
  if (sh.annots.every((a) => a !== null)) return;      // 全标注了，不看调用点
  const list = C.insts.get(nm);
  const dot = nm.indexOf('.');
  /** 一格调用点的实参类型（`self` 那一格由 `sh.annots[0]` 给）。 */
  const take = (args, selfTy) => {
    const types = sh.names.map((_, i) => {
      if (i === 0 && selfTy !== null) return selfTy;
      const k = selfTy === null ? i : i - 1;
      return sh.annots[i] ?? tyOfCst(args[k], C);
    });
    if (types.some((t) => t === null)) return;
    const key = tyKey(types);
    if (!list.some((i) => i.key === key)) list.push(mkInst(nm, sh, types));
  };

  for (const node of allNodes(tree)) {
    if (tag(node) !== 'call') continue;
    const fn = kids(node)[0];
    const args = kids(part(node, 'args') ?? { kind: 'list', items: [] });
    if (dot < 0) {
      /* 普通函数：`f(…)`。 */
      if (tag(fn) === 'n' && String(nameOf(fn)) === nm && args.length === sh.names.length) {
        take(args, null);
      }
      continue;
    }
    const cname = nm.slice(0, dot);
    const mname = nm.slice(dot + 1);
    /* 造一格：`C(…)` -> `C.__init__(self, …)`。 */
    if (mname === '__init__' && tag(fn) === 'n' && String(nameOf(fn)) === cname
      && args.length === sh.names.length - 1) {
      take(args, sh.annots[0]);
      continue;
    }
    /* 方法：`recv.m(…)`，而 recv 装的正是这个类。 */
    if (tag(fn) === 'attr' && String(leaf(kids(fn)[1])) === mname
      && args.length === sh.names.length - 1) {
      const rt = tyOfCst(kids(fn)[0], C);
      if (rt !== null && rt.kind === 'named' && rt.name === sh.annots[0].name) take(args, sh.annots[0]);
    }
  }
}

/** 扫一格实例的函数体收 `return`。 */
function inferRet(nm, inst, C) {
  const f = C.fnNodes.get(nm);
  C.push();
  for (const p of inst.params) C.bind(p.name, p.type);
  const rets = [];
  scanBinds(part(f, 'body'), C, rets);
  C.pop();
  if (rets.length === 0) return { kind: 'void' };
  const known = rets.filter((t) => t !== null);
  if (known.length === 0) return null;                 // 全没定，下一轮再来
  /* **几处 return 不同型就合成一格**（`unifyPy`）—— 一样就是它、int 与 real 提到 real、
     别的退到 dyn。`void` 与有值的混着来才真的没法合（那是源码本身的事），当场报。 */
  if (known.some((t) => t.kind === 'void') && known.some((t) => t.kind !== 'void')) {
    throw new Error(`python->IR: \`def ${nm}\` 有的 return 带值、有的不带 —— 补齐它`);
  }
  const u = unifyPy(known);
  if (u === null) {
    const ks = [...new Set(known.map((t) => t.kind))].join(' / ');
    throw new Error(`python->IR: \`def ${nm}\` 的几处 return 装着 ${ks} —— 合不成一格`
      + '（不同型的退到 dyn，但表与记录装不进那格箱子）');
  }
  return u;
}

/**
 * **只管绑定与收 return** 的一趟（不建 IR）。推断那三轮反复跑它，所以它必须没有副作用
 * （除了往当前作用域里 bind —— 那正是它的活）。
 */
function scanBinds(x, C, rets = null) {
  if (x === null || x === undefined) return;
  for (const s of flatten([x])) scanOne(s, C, rets);
}

function scanOne(s, C, rets) {
  switch (tag(s)) {
    case 'assign': {
      const t = tyOfCst(kids(s)[kids(s).length - 1], C);
      for (const g of kids(part(s, 'lhs') ?? { kind: 'list', items: [] })) {
        bindTarget(kids(g)[0], t, C);
      }
      return;
    }
    case 'annot': {
      const t = typeOfAnnot(kids(s)[1], C);
      if (t !== null) bindTarget(kids(s)[0], t, C);
      return;
    }
    case 'walrus': return;
    /* `global x` —— **绑定这一趟也要认它**（不然下面那句 `x = …` 会被当成造一格局部，
       于是函数体开头多一格 `let x` 把模块级那一格遮住，写进去的东西外头看不见。
       量到的是 control.py 的 `global TICKS` —— `assert TICKS == 5` 当场不成立）。 */
    case 'global':
      for (const n of kids(s)) C.markGlobal(String(leaf(n)));
      return;
    case 'for': {
      const it = tyOfCst(kids(part(s, 'in') ?? { kind: 'list', items: [] })[0], C);
      bindTarget(kids(s)[0], elemOf(it, kids(part(s, 'in') ?? { kind: 'list', items: [] })[0]), C);
      scanBinds(part(s, 'body'), C, rets);
      for (const e of kids(s).filter((y) => tag(y) === 'else')) scanBinds(e, C, rets);
      return;
    }
    case 'if': case 'while': case 'with': {
      for (const k of kids(s)) {
        if (['body', 'else', 'elifs'].includes(tag(k))) scanBinds(k, C, rets);
        if (tag(k) === null && k.kind === 'list') for (const e of k.items) scanBinds(part(e, 'body'), C, rets);
      }
      /* `(elifs (elif C (body …)) …)` 里那几层。 */
      const el = part(s, 'elifs');
      if (el !== undefined) for (const e of kids(el)) scanBinds(part(e, 'body'), C, rets);
      return;
    }
    case 'return':
      if (rets !== null) rets.push(kids(s).length === 0 ? { kind: 'void' } : tyOfCst(kids(s)[0], C));
      return;
    default:
  }
}

/** 一格可迭代的东西装的元素是什么（`range(…)` 出 int，表出它的元素，串出串）。 */
function elemOf(it, node) {
  if (node !== undefined && tag(node) === 'call' && tag(kids(node)[0]) === 'n'
    && String(nameOf(kids(node)[0])) === 'range') return INT;
  if (it === null) return null;
  if (it.kind === 'arr') return it.elem;
  if (it.kind === 'string') return STR;
  return null;
}

/** 一格赋值目标登记进作用域（元组目标逐格登记）。 */
function bindTarget(t, ty, C) {
  if (ty === null || ty === undefined) return;
  if (tag(t) === 'n') {
    const n = String(nameOf(t));
    /* **函数体里赋一个名字就是造一格局部**（python 的规矩，除非说了 `global`）——
       所以只看这一层，不要一路看到模块级那张表去（见 `lookupHere` 那段话）。 */
    const local = C.inScope() && !C.isDeclGlobal(n);
    const had = local ? C.lookupHere(n) : C.lookup(n);
    /* **写了几回就合成一格**（`unifyPy`）：一样就是它、int 与 real 混着来也合成箱子、
       别的退到 dyn。从前这儿是"第一回见到就定死"，于是 `x = 1` 之后 `x = "s"`
       只能当场报"一格变量只装一种东西" —— 那是个错结论，见 `dyn.js` 文件头。 */
    if (had === null) { C.bind(C.ref(n), ty); return; }
    const u = unifyPy([had, ty]);
    if (u !== null && !sameType(u, had)) C.bind(C.ref(n), u);
    return;
  }
  if (tag(t) === 'tuple') {
    for (const k of kids(t)) bindTarget(k, ty, C);
  }
}

/* ─── 函数体 ──────────────────────────────────────────────────────────────── */

/**
 * 一格函数。**局部量全提到函数体开头**（一批 `let`），体里的赋值一律是 `set`。
 *
 * 为什么必须这样：python 的局部量是**整个函数一格命名空间**（`if c: x = 1` 之后，
 * 块外头照样读得到 x），而方言的 `(let …)` 归它所在那个 `(do …)`。不提上来的话
 * `if c: x = 1` 那一句里的 `let` 就锁在 if 的块里 —— 后面读 x 时方言当场报
 * "未声明的变量"。R 那一门与 lua 那台 VM 都是同一条办法。
 */
function fnDecl(nm, inst, C) {
  const node = C.fnNodes.get(nm);
  const bodyNode = part(node, 'body') ?? { kind: 'list', items: [] };
  C.push();
  const wasIn = C.inFn;
  const wasRet = C.retTy;
  C.inFn = true;
  C.retTy = inst.ret;
  for (const p of inst.params) C.bind(p.name, p.type);
  /* 先只走一趟"绑定"（不建 IR）—— 于是局部量的名字与类型在发第一句之前就全知道了。 */
  scanBinds(bodyNode, C);
  const pnames = new Set(inst.params.map((p) => p.name));
  const locals = C.localsHere().filter(([n]) => !pnames.has(n));
  const stmts = flatten(kids(bodyNode)).flatMap((s) => stmtsOf(s, C));
  C.inFn = wasIn;
  C.retTy = wasRet;
  C.pop();
  return {
    kind: 'fn',
    name: inst.mangled,
    params: inst.params,
    ret: inst.ret,
    body: [...locals.map(([n, t]) => ({ kind: 'let', name: n, type: t, init: null })), ...stmts],
  };
}

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

export function stmtsOf(x, C) {
  switch (tag(x)) {
    case 'line': case 'body': return flatten([x]).flatMap((k) => stmtsOf(k, C));
    case 'pass': return [];
    /* import 这一版**丢掉**（`math` 那一族在 adapter 里认名字，不必真读那份模块）。 */
    case 'import': case 'from': case 'typealias': return [];
    case 'global': {
      for (const n of kids(x)) {
        const nm = String(leaf(n));
        C.markGlobal(nm);
        if (!C.globals.has(nm)) {
          throw new Error(`python->IR: \`global ${nm}\` 可顶层没给它赋过值 —— 还没接`);
        }
      }
      return [];
    }
    case 'nonlocal':
      throw new Error('python->IR: `nonlocal` 还没接（要先有函数里套函数）');
    case 'expr': return exprStmtOf(kids(x)[0], C);
    case 'assign': return assignStmt(x, C);
    case 'augassign': return augassignStmt(x, C);
    case 'annot': return annotStmt(x, C);
    case 'if': return [ifStmt(x, C)];
    case 'while': return [whileStmt(x, C)];
    case 'for': return [forStmt(x, C)];
    case 'return': {
      const vs = kids(x);
      if (vs.length === 0) return [{ kind: 'return', values: [] }];
      const v = exprOf(vs[0], C);
      /* 交出去的那一格要与**签名**对上（`inferRet` 那一侧用 `unifyPy` 合出来的）：
         签名是 dyn 就装箱、是 real 而这一支交的是 int 就提上去。 */
      const want = C.retTy;
      const got = typeOfIR(v, C);
      if (want !== null && want !== undefined && !sameType(want, got)) {
        if (want.kind === 'dyn') return [{ kind: 'return', values: [boxOf(v, C)] }];
        if (want.kind === 'real' && got.kind === 'int') {
          return [{ kind: 'return', values: [{ kind: 'builtin', name: 'toreal', args: [v] }] }];
        }
      }
      return [{ kind: 'return', values: [v] }];
    }
    case 'break': return [{ kind: 'break', label: null }];
    case 'continue': return [{ kind: 'continue', label: null }];
    case 'assert': return [assertStmt(x, C)];
    /* `raise X("话")` —— 方言里没有异常，落成"印一句 + 停下来"（与 mojo 的 assert 同一手）。 */
    case 'raise': {
      const vs = kids(x).filter((y) => tag(y) !== 'from');
      const msg = vs.length === 0 ? { kind: 'string', value: 'raise' } : raiseText(vs[0], C);
      return [{ kind: 'builtin-stmt', name: 'fail', args: [msg] }];
    }
    case 'def':
      throw new Error('python->IR: 函数里套函数还没接');
    case 'class':
      throw new Error('python->IR: `class` 还没接（下一刀）');
    case 'try': case 'with': case 'match': case 'del': case 'decorated': case 'async':
      throw new Error(`python->IR: \`${tag(x)}\` 还没接`);
    default:
      throw new Error(`python->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** 语句位置上的一格表达式。`print(…)` 与 `xs.append(v)` 不交值，各自一格。 */
function exprStmtOf(e, C) {
  if (tag(e) === 'call') {
    const [fn, argsTok] = kids(e);
    const argToks = argsTok === undefined ? [] : kids(argsTok);
    if (tag(fn) === 'n' && String(nameOf(fn)) === 'print') return printStmt(argToks, C);
    if (tag(fn) === 'attr' && String(leaf(kids(fn)[1])) === 'append') {
      const box = exprOf(kids(fn)[0], C);
      if (argToks.length !== 1) throw new Error('python->IR: `.append()` 只收一格实参');
      const bt = typeOfIR(box, C);
      let v = exprOf(argToks[0], C);
      /* 表装的是箱子时先装箱（`xs = [1, "a"]` 之后 `xs.append(2.5)`）。 */
      if (bt.kind === 'arr' && bt.elem.kind === 'dyn') v = boxOf(v, C);
      return [{ kind: 'builtin-stmt', name: 'apush', args: [box, v] }];
    }
  }
  return [{ kind: 'expr-stmt', expr: exprOf(e, C) }];
}

/**
 * `print(a, b)` —— **一行、空格连、末尾一个换行**（`Lib/builtins` 的默认 sep/end）。
 * 给了 `end=` 就改走 `write`（那一格不补换行），把 end 拼在后面。`sep=` 还没接。
 */
function printStmt(argToks, C) {
  let end = null;
  const pos = [];
  for (const a of argToks) {
    if (tag(a) === 'kw') {
      const k = String(leaf(kids(a)[0]));
      if (k !== 'end') throw new Error(`python->IR: \`print(${k}=…)\` 还没接（只接了 end=）`);
      end = exprOf(kids(a)[1], C);
      continue;
    }
    if (['star', 'starstar', 'genexp'].includes(tag(a))) {
      throw new Error(`python->IR: \`print\` 的实参里有 \`${tag(a)}\` —— 还没接`);
    }
    pos.push(a);
  }
  const parts = pos.map((a) => pyStr(exprOf(a, C), C));
  let value = parts.length === 0 ? { kind: 'string', value: '' } : parts[0];
  for (const p of parts.slice(1)) {
    value = {
      kind: 'binop', op: '+',
      left: { kind: 'binop', op: '+', left: value, right: { kind: 'string', value: ' ' } },
      right: p,
    };
  }
  if (end === null) return [{ kind: 'print', values: [value] }];
  return [{ kind: 'write', values: [{ kind: 'binop', op: '+', left: value, right: end }] }];
}

/* ─── 赋值 ────────────────────────────────────────────────────────────────── */

function assignStmt(x, C) {
  const groups = kids(part(x, 'lhs') ?? { kind: 'list', items: [] });
  const valueTok = kids(x)[kids(x).length - 1];
  const targets = groups.map((g) => kids(g)[0]);
  if (targets.length === 1) return assignTo(targets[0], valueTok, C);
  /* `a = b = c` —— 右边只算一遍，落一格临时量再各写一次。 */
  const v = exprOf(valueTok, C);
  const t = typeOfIR(v, C);
  const tmp = C.fresh('chain');
  C.bind(tmp, t);
  const out = [{ kind: 'let', name: tmp, type: t, init: v }];
  for (const tt of targets) {
    if (tag(tt) === 'tuple') throw new Error('python->IR: `a = b, c = …` 这种连写加拆包还没接');
    out.push(...writeTo(tt, { kind: 'name', name: tmp }, C));
  }
  return out;
}

/** 一格目标 ← 一格**还没算过**的右边（拆包要看右边的形状，所以收的是记号）。 */
function assignTo(t, valueTok, C) {
  if (tag(t) === 'tuple') {
    if (tag(valueTok) !== 'tuple') {
      throw new Error('python->IR: 拆包赋值的右边要也是个元组（`a, b = f()` 还没接）');
    }
    const ts = kids(t);
    const vs = kids(valueTok);
    if (ts.length !== vs.length) {
      throw new Error(`python->IR: 拆包赋值两边格数不一样（左 ${ts.length}、右 ${vs.length}）`);
    }
    /* **右边全算完再赋** —— `a, b = b, a` 这个交换靠的正是这一条。 */
    const out = [];
    const tmps = vs.map((e) => {
      const v = exprOf(e, C);
      const ty = typeOfIR(v, C);
      const n = C.fresh('unpack');
      C.bind(n, ty);
      out.push({ kind: 'let', name: n, type: ty, init: v });
      return { kind: 'name', name: n };
    });
    ts.forEach((tt, i) => out.push(...writeTo(tt, tmps[i], C)));
    return out;
  }
  return writeTo(t, exprOf(valueTok, C), C);
}

/** 一格目标 ← 一格**算好了**的值。 */
function writeTo(t, value, C) {
  if (tag(t) === 'n') {
    const n = String(nameOf(t));
    const want = C.lookup(n);
    const got = typeOfIR(value, C);
    if (want !== null && !sameType(want, got)) {
      /* int 装进 real 的格子里是许的（`x = 1` 之后 `x = 1.5` 那种在 python 里合法，
         而方言里一格变量只有一种类型 —— 所以 int 提到 real）。 */
      if (want.kind === 'real' && got.kind === 'int') {
        return [{ kind: 'assign', target: { kind: 'name', name: C.ref(n) }, value: { kind: 'builtin', name: 'toreal', args: [value] } }];
      }
      /* 这一格声明成了箱子（`scanBinds` 那一趟合成出来的）—— 装进去就是了。
         「一格变量只装一种东西」从前在这儿是个当场报的错，现在它只是**推得出来的那一档**
         的说法；推不出来的退到 dyn，见 `dyn.js` 文件头。 */
      if (want.kind === 'dyn') {
        return [{ kind: 'assign', target: { kind: 'name', name: C.ref(n) }, value: boxOf(value, C) }];
      }
      throw new Error(`python->IR: '${n}' 先装 ${want.kind}、后装 ${got.kind}`
        + `，而 ${got.kind} 装不进 dyn 那格箱子 —— 换个名字，或者两处都写成同一种`);
    }
    if (want === null) C.bind(C.ref(n), got);
    return [{ kind: 'assign', target: { kind: 'name', name: C.ref(n) }, value }];
  }
  if (tag(t) === 'index') {
    const box = exprOf(kids(t)[0], C);
    const subs = kids(part(t, 'subs') ?? { kind: 'list', items: [] });
    if (subs.length !== 1) throw new Error('python->IR: 多维下标赋值还没接');
    if (tag(subs[0]) === 'slice') throw new Error('python->IR: 给切片赋值（`xs[1:3] = …`）还没接');
    const bt = typeOfIR(box, C);
    const key = exprOf(subs[0], C);
    /* 容器装的是箱子时，写进去的那一格要先装箱（`d["k"] = 1` / `xs[0] = "a"`）。 */
    const elemT = bt.kind === 'map' ? bt.value : (bt.kind === 'arr' ? bt.elem : null);
    const v = elemT !== null && elemT.kind === 'dyn' ? boxOf(value, C) : value;
    if (bt.kind === 'map') return [{ kind: 'builtin-stmt', name: 'dset', args: [box, key, v] }];
    if (bt.kind === 'arr') {
      return [{
        kind: 'assign',
        target: { kind: 'index', obj: box, index: wrapIdxForWrite(box, key, C) },
        value: v,
      }];
    }
    throw new Error(`python->IR: 往 ${bt.kind} 上按下标写还没接（串在 python 里不可改）`);
  }
  if (tag(t) === 'attr') {
    const obj = exprOf(kids(t)[0], C);
    const name = String(leaf(kids(t)[1]));
    const rec = C.recOf(typeOfIR(obj, C));
    if (rec === null) {
      throw new Error(`python->IR: 往 ${typeOfIR(obj, C).kind} 的 \`.${name}\` 上写还没接`
        + '（记录的字段接了，模块属性没接）');
    }
    const f = rec.fields.find((y) => y.name === name);
    if (f === undefined) {
      throw new Error(`python->IR: \`${rec.name}\` 没有字段 \`${name}\``
        + ' —— 字段只从类级标注与 `__init__` 顶层那几句 `self.x = …` 认');
    }
    const got = typeOfIR(value, C);
    let v = value;
    /* 与名字那一侧同一条：int 装进 real 的格子里提上去，声明成箱子的装箱。 */
    if (!sameType(f.type, got)) {
      if (f.type.kind === 'real' && got.kind === 'int') {
        v = { kind: 'builtin', name: 'toreal', args: [value] };
      } else if (f.type.kind === 'dyn') {
        v = boxOf(value, C);
      } else {
        throw new Error(`python->IR: \`${rec.name}.${name}\` 装的是 ${f.type.kind}，这儿给的是 ${got.kind}`);
      }
    }
    return [{ kind: 'assign', target: { kind: 'field', obj, name }, value: v }];
  }
  if (tag(t) === 'star') throw new Error('python->IR: 带星号的赋值目标（`*rest`）还没接');
  throw new Error(`python->IR: 赋值的左边是 \`${tag(t)}\` —— 还没接`);
}

/** 写的那一侧也要管负下标（`xs[-1] = v`）—— 与读那一侧同一条口径。 */
function wrapIdxForWrite(box, key, C) {
  if (key.kind === 'int' && key.value < 0n) {
    return { kind: 'binop', op: '+', left: lenOf(box, C), right: key };
  }
  if (key.kind === 'int') return key;
  return {
    kind: 'ternary', type: INT,
    cond: { kind: 'binop', op: '<', left: key, right: { kind: 'int', value: 0 } },
    then: { kind: 'binop', op: '+', left: lenOf(box, C), right: key },
    else_: key,
  };
}

/* ─── `+=` / 标注 / 分支 / 循环 ────────────────────────────────────────────── */

/** 一格**造出来的** CST 节点（`x += 1` 改写成 `x = x + 1` 要它）。 */
const mkTok = (...items) => ({
  kind: 'list',
  items: items.map((i) => (typeof i === 'string' ? { kind: 'atom', value: i } : i)),
});

function augassignStmt(x, C) {
  const [opTok, target, value] = kids(x);
  const o = String(leaf(opTok)).slice(0, -1);      // `+=` -> `+`
  if (tag(target) !== 'n' && tag(target) !== 'index') {
    throw new Error(`python->IR: \`${o}=\` 的左边是 \`${tag(target)}\` —— 还没接`);
  }
  return writeTo(target, exprOf(mkTok('bin', o, target, value), C), C);
}

/** `x: int` / `x: int = 0` / `xs: list[int] = []`。**空容器靠标注才造得出来**。 */
function annotStmt(x, C) {
  const [target, annot] = kids(x);
  const init = part(x, 'init');
  const t = typeOfAnnot(annot, C);
  if (t === null) throw new Error(`python->IR: 这一格类型标注还没接（认得 int / float / str / bool / list[T] / dict[K,V]）`);
  if (tag(target) !== 'n') throw new Error('python->IR: 带标注的赋值目标只接一格名字');
  const n = String(nameOf(target));
  if (C.lookup(n) === null) C.bind(C.ref(n), t);
  if (init === undefined) return [];
  const v = kids(init)[0];
  /* `[]` / `{}` 自己推不出元素类型 —— 标注在这儿，按它造。 */
  if (tag(v) === 'list' && kids(v).length === 0) {
    if (t.kind !== 'arr') throw new Error(`python->IR: \`[]\` 的标注写的是 ${t.kind}`);
    return [{
      kind: 'assign',
      target: { kind: 'name', name: C.ref(n) },
      value: { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: 0 }] },
    }];
  }
  if (tag(v) === 'dict' && kids(v).length === 0) {
    if (t.kind !== 'map') throw new Error(`python->IR: \`{}\` 的标注写的是 ${t.kind}`);
    return [{
      kind: 'assign',
      target: { kind: 'name', name: C.ref(n) },
      value: { kind: 'builtin', name: 'dnew', args: [tyArg(t)] },
    }];
  }
  return writeTo(target, exprOf(v, C), C);
}

function bodyStmts(node, C) {
  return node === undefined ? [] : flatten(kids(node)).flatMap((s) => stmtsOf(s, C));
}

function ifStmt(x, C) {
  const parts = kids(x);
  const cond = condOf(parts[0], C);
  const then = bodyStmts(parts[1], C);
  const elifs = kids(part(x, 'elifs') ?? { kind: 'list', items: [] });
  const elseTok = kids(x).find((y) => tag(y) === 'else');
  let els = elseTok === undefined ? null : bodyStmts(kids(elseTok)[0], C);
  for (let i = elifs.length - 1; i >= 0; i -= 1) {
    const e = kids(elifs[i]);
    els = [{ kind: 'if', cond: condOf(e[0], C), then: bodyStmts(e[1], C), else_: els }];
  }
  return { kind: 'if', cond, then, else_: els };
}

function whileStmt(x, C) {
  if (kids(x).some((y) => tag(y) === 'else')) {
    throw new Error('python->IR: `while … else:` 还没接（那一支是"没 break 就跑"）');
  }
  return { kind: 'while', cond: condOf(kids(x)[0], C), body: bodyStmts(part(x, 'body'), C) };
}

/**
 * `for` —— **三种可迭代**：`range(…)`、表、串。
 *
 * 落成标准 IR 的 `{ kind: 'for', init, cond, post, body }`（不是自己摊成 while）——
 * 那一格在 `lower-stmt.js` 里会把体内**属于这一层**的 `continue` 前面补上步进。
 * 自己摊的话 `continue` 会跳过步进，当场死循环（那一条账写在 `lowerFor` 的注释里）。
 */
function forStmt(x, C) {
  if (kids(x).some((y) => tag(y) === 'else')) {
    throw new Error('python->IR: `for … else:` 还没接（那一支是"没 break 就跑"）');
  }
  const target = kids(x)[0];
  if (tag(target) !== 'n') throw new Error(`python->IR: \`for\` 的目标是 \`${tag(target)}\` —— 拆包还没接`);
  const name = C.ref(String(nameOf(target)));
  const iter = kids(part(x, 'in') ?? { kind: 'list', items: [] })[0];
  const pre = [];
  /** 循环前先算一遍并落一格临时量（python 的 range 与容器都只算一次）。 */
  const once = (e, p) => {
    const v = exprOf(e, C);
    if (['int', 'real', 'string', 'bool', 'name'].includes(v.kind)) return v;
    const n = C.fresh(p);
    const t = typeOfIR(v, C);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: v });
    return { kind: 'name', name: n };
  };

  if (tag(iter) === 'call' && tag(kids(iter)[0]) === 'n' && String(nameOf(kids(iter)[0])) === 'range') {
    const as = kids(part(iter, 'args') ?? { kind: 'list', items: [] });
    if (as.length === 0 || as.length > 3) throw new Error('python->IR: `range()` 收 1~3 格实参');
    const from = as.length === 1 ? { kind: 'int', value: 0 } : once(as[0], 'from');
    const to = once(as[as.length === 1 ? 0 : 1], 'to');
    let step = { kind: 'int', value: 1 };
    let down = false;
    if (as.length === 3) {
      const sv = exprOf(as[2], C);
      if (sv.kind !== 'int' || sv.value === 0n) {
        throw new Error('python->IR: `range(a, b, step)` 的步长要是一格非零整数字面量 —— '
          + '不然"往上还是往下"只有跑起来才知道（那要两条循环）');
      }
      step = sv;
      down = sv.value < 0n;
    }
    C.bind(name, INT);
    return {
      kind: 'block',
      stmts: [...pre, {
        kind: 'for',
        init: { kind: 'assign', target: { kind: 'name', name }, value: from },
        cond: { kind: 'binop', op: down ? '>' : '<', left: { kind: 'name', name }, right: to },
        post: {
          kind: 'assign', target: { kind: 'name', name },
          value: { kind: 'binop', op: '+', left: { kind: 'name', name }, right: step },
        },
        body: bodyStmts(part(x, 'body'), C),
      }],
    };
  }

  const box = once(iter, 'iter');
  const bt = typeOfIR(box, C);
  if (bt.kind !== 'arr' && bt.kind !== 'string') {
    throw new Error(`python->IR: 在 ${bt.kind} 上走一遍还没接（range / 表 / 串接了）`);
  }
  const i = C.fresh('for_i');
  C.bind(i, INT);
  const item = bt.kind === 'arr'
    ? { kind: 'index', obj: box, index: { kind: 'name', name: i } }
    : {
      /* `(ssub E I N)` 是"从 I 起取 N 个" —— 一格字符就是 N = 1。 */
      kind: 'builtin', name: 'ssub',
      args: [box, { kind: 'name', name: i }, { kind: 'int', value: 1 }],
    };
  return {
    kind: 'block',
    stmts: [...pre, {
      kind: 'for',
      init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
      cond: { kind: 'binop', op: '<', left: { kind: 'name', name: i }, right: lenOf(box, C) },
      post: {
        kind: 'assign', target: { kind: 'name', name: i },
        value: { kind: 'binop', op: '+', left: { kind: 'name', name: i }, right: { kind: 'int', value: 1 } },
      },
      body: [
        { kind: 'assign', target: { kind: 'name', name }, value: item },
        ...bodyStmts(part(x, 'body'), C),
      ],
    }],
  };
}

/* ─── assert / raise ──────────────────────────────────────────────────────── */

/** `assert c[, "话"]` —— 方言里没有 assert，按口径拼：印一句再停下来。 */
function assertStmt(x, C) {
  const cond = condOf(kids(x)[0], C);
  const msg = kids(x)[1];
  const head = { kind: 'string', value: 'AssertionError' };
  const line = msg === undefined
    ? head
    : {
      kind: 'binop', op: '+',
      left: { kind: 'string', value: 'AssertionError: ' },
      right: pyStr(exprOf(msg, C), C),
    };
  return {
    kind: 'if',
    cond: { kind: 'unop', op: '!', operand: cond },
    then: [
      { kind: 'print', values: [line] },
      { kind: 'builtin-stmt', name: 'fail', args: [head] },
    ],
    else_: null,
  };
}

/** `raise ValueError("话")` → 停下来时印的那一句。 */
function raiseText(v, C) {
  if (tag(v) === 'call' && tag(kids(v)[0]) === 'n') {
    const nm = String(nameOf(kids(v)[0]));
    const as = kids(part(v, 'args') ?? { kind: 'list', items: [] });
    if (as.length === 0) return { kind: 'string', value: nm };
    return {
      kind: 'binop', op: '+',
      left: { kind: 'string', value: `${nm}: ` },
      right: pyStr(exprOf(as[0], C), C),
    };
  }
  if (tag(v) === 'n') return { kind: 'string', value: String(nameOf(v)) };
  throw new Error('python->IR: `raise` 后面那一格还没接（只接了 `raise E` 与 `raise E("话")`）');
}

/* ─── 语言钩子 ────────────────────────────────────────────────────────────── */

/**
 * 数组的零值 —— 公共那张表里没有这一格（`lower/ty.js` 的 `zeroOf`），
 * 而函数体开头那一批 `let` 全是零初始化，所以这儿必须给。
 */
export const PY_HOOKS = {
  zeroOf: (type) => {
    if (type !== null && typeof type === 'object' && type.kind === 'arr') {
      return `(anew ${typeToSx(type)} (int 0))`;
    }
    return null;
  },
};

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. `class` / `try` / `with` / `match` / 生成器 / 闭包 / 装饰器都没接。
//   2. 单态化按**实参类型的元组**分（`add(2,3)` 与 `add(1.5,2.5)` 各一格），可
//      **只按返回类型分不出来**：`def f(): return []` 在两处要不同的元素类型时报错。
//   3. 整数是 64 位（python 的 int 没有上界）—— 溢出的那一档要等 `longobject.c` 接上来。
//   4. `str(float)` 走方言的 `(srepr E)`，与 CPython **逐字节相同**（三条腿都量过）。
//      不过它是我们自己那三份实现，不是 CPython 的 `dtoa.c`（那一份已经编出来了，
//      见 `ext/python/build.js`，接上它要先解决"出串怎么过 cabi"）。
//   5. `round()` 是 C 的 round（远离零），python 是银行家舍入 —— `.5` 那一格答得不一样。
//   6. 循环变量不外泄（python 里 `for i in …` 之后还读得到 i）。
//   7. f-string 里那段表达式、`%` 格式化、`.format()` 都没接。
//   8. 字典转串没接（方言里没有"走一遍字典的键"那一格算子）。
