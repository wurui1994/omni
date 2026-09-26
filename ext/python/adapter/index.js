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
import { INT, STR, BOOL, DYN, arrOf, dictOf, sameType, typeOf, named } from '../../../src/core/lower/ty-of.js';
import { typeToSx } from '../../../src/core/lower/ty.js';
import {
  exprOf, condOf, nameOf, typeOfAnnot, tyOfCst, tyArg, pyStr, pyRepr, lenOf, hasFields, fstringParts, cmpEq,
  kwOrder, tupleOf, cmpLt, needOrd, tupleToList, sortByKeyPy, emptyOf,
} from './expr.js';
import {
  reverseStmts, clearStmts, extendStmts, insertStmts, dropAtStmts, indexOfList,
  dictClearStmts, sortStmts, dictUpdateStmts, sliceAssignStmts, joinOf, charsOf,
} from './builtins.js';
import { boxOf, unifyPy } from './dyn.js';

/** 一格已经建好的 IR 表达式装的是什么。 */
const typeOfIR = (e, C) => typeOf(e, C.tyCtx());

/** 一棵 python 的树（`(module …)`）→ 标准 IR 的模块。 */
export function pyToIR(tree, ctx = {}) {
  if (tag(tree) !== 'module') throw new Error('python->IR: 这不是 (module …)');

  const C = makeCtx();
  C.parseExpr = ctx.parseExpr ?? null;
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
  /* **函数里套的函数**：没有捕获外层名字的那一档**提到模块级**（见 `hoistNested`）。 */
  for (const f of fnNodes) hoistNested(f, C);
  /* **f-string 里那几段表达式先解析出来**。单态化那一趟是从**调用点**收实例的，而
     `f"{twice(n)}"` 里那次调用躺在一个 STRING 记号里 —— `allNodes` 看不见它，于是
     `twice` 一格实例都收不到（量出来的原话：`twice(int)` 没有对得上的那一格）。
     所以在推断之前先解析一遍，把那几棵树挂在 `C.fstrTrees` 上，推断那几趟一起走。 */
  for (const nd of allNodes(tree)) {
    if (tag(nd) !== 'str' || !hasFields(nd)) continue;
    for (const p of fstringParts(nd, C)) if (p.tree !== undefined) C.fstrTrees.push(p.tree);
  }
  infer(C, tree, scriptStmts);

  /* ---- 发射 ------------------------------------------------------------------ */
  /* **先建函数体与顶层那一段，再摆声明**。次序反过来（原先那样）的后果是：
     元组那一族的形状是在**建 IR 的时候**才登记进 `C.records` 的（`(1, 2)` 走到
     `tupleRec` 那一下），排在前面的声明表就看不见它们。
     摆的时候记录要在函数前面 —— 方言那一层先收类型再收签名。 */
  const fns = [];
  for (const [nm, insts] of C.insts) {
    for (const inst of insts) fns.push(fnDecl(nm, inst, C));
  }

  C.push();
  const body = [
    { kind: 'assign', target: { kind: 'name', name: C.ref('__name__') }, value: { kind: 'string', value: '__main__' } },
    ...scriptStmts.flatMap((s) => stmtsOf(s, C)),
  ];
  C.pop();

  const decls = [];
  for (const [, rec] of C.records) {
    decls.push({ kind: 'class', name: rec.type.name, fields: rec.fields });
  }
  for (const [name, ty] of C.globals) decls.push({ kind: 'global', name: C.ref(name), type: ty });
  decls.push(...fns);
  decls.push({ kind: 'main', body });
  return { kind: 'module', decls };
}

/** `(line a b)` 那一层摊掉 —— 顶层与块体里都是这个形状。 */
function flatten(items) {
  /* `else` 也剥一层：`(else (body …))`。`scanBinds` 那一侧把 `(else …)` 整格递进来
     （`if` / `while` / `for` 三处都是），只剥 line / body 的话那一支**一格都不绑** ——
     量到过：`out = {}` 之后只在 else 支里写 `out[k] = v`，报"空字典的键值类型推不出来"。
     语句发射那几处递进来的一定是 `body`，所以多剥这一层不影响它们。 */
  return items.flatMap((s) => (['line', 'body', 'else'].includes(tag(s)) ? flatten(kids(s)) : [s]));
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
      /* **`self.xs: list[int] = []`** —— 带标注的那一句是 `annot` 不是 `assign`，
         从前这儿只看 `assign`，于是那一格字段**根本没认出来**（症状：`Stack` 没有字段
         `items`（一格都没有））。标注就在手上，照它算，比从右边猜准。 */
      if (tag(s) === 'annot') {
        const t0 = kids(s)[0];
        if (tag(t0) !== 'attr') continue;
        if (tag(kids(t0)[0]) !== 'n' || String(nameOf(kids(t0)[0])) !== 'self') continue;
        const n = String(leaf(kids(t0)[1]));
        const at = typeOfAnnot(kids(s)[1], C);
        if (at !== null) {
          annotated.add(n);
          add(n, at);
        }
        continue;
      }
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
  /* **合不成一格**（几处造出来时装的东西连箱子都装不进 —— 表与记录装不进 dyn，
     见 `dyn.js` 文件头）：在这儿报。不报的话那一格字段被上面那句 filter 摘掉，
     下一层说的是"`Holder` 没有字段 `v`（一格都没有）"，离根因就远了。
     **`order` 里没有的名字不在这儿报** —— 那是"这一轮还没推出来"，与真冲突不是一回事。 */
  for (const n of order) {
    if (rec.fields.some((f) => f.name === n)) continue;
    const ks = [...new Set(seen.get(n).map((t) => t.kind))].join(' / ');
    throw new Error(`python->IR: \`${rec.name}.${n}\` 在几处造出来时装的是 ${ks}`
      + ' —— 合不成一格（类不按实参单态化，一格 `(class …)` 只有一份字段表；'
      + '不同型的那一档退到 dyn，可表与记录装不进那格箱子）'
      + `（给它一格标注，如 \`${n}: list[int]\`；或者几处都造成同一种）`);
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
    /**
     * **一段表达式源码 → 那棵表达式的树**（`drive.js` 递进来的那一格）。
     * f-string 里那几段靠它 —— 整份 f-string 是一个记号，要用时用**同一张 LR 表**
     * 再解析一遍（`src/core/lang/jnc.js` 的 `jncParseExpr` 是同一条先例）。
     */
    parseExpr: null,
    /** f-string 的分段缓存（记号原文 → 那几段，表达式那几段带解析好的树）。 */
    fstrCache: new Map(),
    /** f-string 里那几棵解析出来的表达式树 —— 推断那几趟要连它们一起走。 */
    fstrTrees: [],
    /**
     * 一段 python 表达式的**原文** → 它的 CST。
     *
     * 语法只有一个起点（`(start module)`），所以把这段裹成一份合法的模块 ——
     * 一句"括起来的表达式语句" —— 再从树里把那一格 `(expr …)` 底下的挖出来。
     * 裹成 `(…)` 而不是裸的一行：那样多行的表达式（`f"{a +\n b}"` 不可能，但
     * `{d["k"]}` 里有引号与括号）不会被缩进那一层当成两句。
     */
    exprTreeOf: (src, why) => {
      if (C.parseExpr === null) {
        throw new Error(`python->IR: ${why} 要"再解析一段"那一格，而这一趟没给`
          + '（`drive.js` 的 `parseExpr` 没递进来）');
      }
      const t = C.parseExpr(`(${src})\n`);
      const dug = t === null ? null : digExpr(t);
      if (dug === null) throw new Error(`python->IR: ${why} 里这一段解析不了：\`${src}\``);
      return dug;
    },
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
    /**
     * **推导式那一层的改名**：python 3 里推导式有自己的作用域 —— `[x for x in xs]`
     * 里那个 `x` 与外头同名的那一格不是一件事，而且它**不漏到外头**。
     *
     * `ref` 是一张按整份模块的名字表（不分层），所以这儿的办法是把那个名字临时指到
     * 一格新名上，推导式发完再指回去。回的是"指回去"那个函数。
     */
    alias: (n, to) => {
      const had = names.has(n) ? names.get(n) : null;
      names.set(n, to);
      return () => { if (had === null) names.delete(n); else names.set(n, had); };
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
    /** 一格**已经建好的 IR 表达式**装的是什么（`builtins.js` 那几格现场发循环的要它）。 */
    tyOfIR: (e) => typeOf(e, C.tyCtx()),
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
 * 形参的**标注**那一格：`(p (n a) 标注 (default e))` 里的第二格 —— 可是没写标注时
 * 第二格就是 `(default …)` 本身，照着读会把默认值当标注（量到过）。
 */
const annotTok = (p) => {
  const k = kids(p)[1];
  return k !== undefined && tag(k) !== 'default' ? k : undefined;
};

/**
 * 形参的**默认值**只收字面量。
 *
 * 为什么卡这一条：默认值在这一层是**调用点展开**的（`kwOrder` 把缺的那几格补上那棵
 * 原文树），而 python 的默认值是 `def` 那一刻算一遍、以后**共享同一格**。
 * 字面量看不出区别；可变的（`def f(xs=[])`）区别是根本性的 —— python 里两次调用改的是
 * 同一张表。所以那一档当场报，不悄悄换语义。
 */
function checkDefault(nm, p) {
  const d = part(p, 'default');
  if (d === undefined) return;
  const e = kids(d)[0];
  const ok = ['num', 'str', 'true', 'false', 'none'].includes(tag(e))
    || (tag(e) === 'un' && String(leaf(kids(e)[0])) === '-' && tag(kids(e)[1]) === 'num');
  if (!ok) {
    throw new Error(`python->IR: \`def ${nm}\` 的默认值只收字面量（这里是 \`${tag(e)}\`）——`
      + ' 这一层的默认值是**调用点展开**的，而 python 的默认值 `def` 时算一遍、以后共享'
      + '同一格；可变的默认值（`def f(xs=[])`）两者差得是根本的');
  }
}

/**
 * 从"裹好的那一份模块"里挖出那一棵表达式：找第一格 `(expr E)`，交 E。
 * **不用生成器、不用递归的闭包** —— 这份文件跟着编译器一起被降级，子集越窄越稳。
 */
function digExpr(tree) {
  for (const nd of allNodes(tree)) {
    if (tag(nd) === 'expr' && kids(nd).length > 0) return kids(nd)[0];
  }
  return null;
}

/** 一棵树里用到的名字（`(n x)` 那一族；属性名与命名实参的键是叶子，不算）。 */
function namesIn(nd) {
  const out = new Set();
  for (const k of allNodes(nd)) if (tag(k) === 'n') out.add(String(nameOf(k)));
  return out;
}

/** 一棵树里**被赋过值**的那几个名字（赋值、带标注的赋值、`+=`、`for` 的目标）。 */
function boundIn(nd) {
  const out = new Set();
  const take = (t) => {
    if (t === undefined || t === null) return;
    if (tag(t) === 'n') out.add(String(nameOf(t)));
    if (tag(t) === 'tuple') for (const k of kids(t)) take(k);
  };
  for (const s of allNodes(nd)) {
    if (tag(s) === 'assign' || tag(s) === 'annot') {
      const lhs = part(s, 'lhs');
      if (lhs === undefined) take(kids(s)[0]);
      else for (const g of kids(lhs)) take(kids(g)[0]);
    }
    if (tag(s) === 'augassign') take(kids(s)[1]);
    if (tag(s) === 'for') take(kids(s)[0]);
    /* **套在里头的 `def` 的名字不算"外层的局部"** —— 它自己也会被提到模块级，所以
       一格嵌套函数调它的兄弟**不是捕获**（量到过：`a2` 调 `a1` 被误判成闭包）。 */
  }
  return out;
}

/** 一棵 `def` 的形参名字。 */
const paramNames = (f) => paramsOf(f).filter((p) => tag(p) === 'p')
  .map((p) => String(nameOf(kids(p)[0])));

/**
 * **函数里套的函数：没有捕获的那一档提到模块级**。
 *
 * python 的嵌套 `def` 有两种用法：一种只是"把一段逻辑关在里头"（不读外层的任何名字），
 * 另一种是真闭包（读外层的局部）。前者与模块级的 `def` **没有区别** —— 提上去就是，
 * 单态化那一套照旧。后者要"把捕获的那几格连函数一起带走"，那是 `(asfn …)` 与环境
 * 那一层的事，所以**当场报**，不悄悄把它当前者办（那会读到一个不存在的名字）。
 *
 * 判据就是一句话：**内层用到的名字里，有没有落在外层的形参或局部上**
 * （内层自己的形参与局部先减掉 —— 那是遮住的，不算捕获）。
 */
function hoistNested(f, C) {
  const outer = new Set([...paramNames(f), ...boundIn(part(f, 'body') ?? f)]);
  for (const nd of allNodes(part(f, 'body') ?? f)) {
    if (tag(nd) !== 'def') continue;
    const nm = String(nameOf(kids(nd).find((y) => tag(y) === 'n')));
    const mine = new Set([...paramNames(nd), ...boundIn(part(nd, 'body') ?? nd), nm]);
    const grabbed = [...namesIn(nd)].filter((n) => outer.has(n) && !mine.has(n));
    if (grabbed.length > 0) {
      throw new Error(`python->IR: \`def ${nm}\` 用到了外层的 ${grabbed.join(' / ')}`
        + ' —— 真闭包还没接（要把捕获的那几格连函数一起带走，是 `(asfn …)` 那一层的事）；'
        + '不读外层名字的嵌套函数是接了的（提到模块级）');
    }
    if (C.fnNodes.has(nm)) {
      throw new Error(`python->IR: 套在里头的 \`def ${nm}\` 与外头那个同名 —— 还没接`
        + '（提到模块级之后会撞）');
    }
    C.fnNodes.set(nm, nd);
    hoistNested(nd, C);
  }
}

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
      checkDefault(nm, p);
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
      annots: ps.map((p, i) => (rec !== null && i === 0 ? rec.type : typeOfAnnot(annotTok(p), C))),
      retAnnot: typeOfAnnot(kids(part(f, 'ret') ?? { kind: 'list', items: [] })[0], C),
      rec,
    });
    /* 形参全带标注的那一档第一轮就定得下来；别的先摆一格空表，等调用点。 */
    const sh = shells.get(nm);
    C.insts.set(nm, sh.annots.every((a) => a !== null) ? [mkInst(nm, sh, sh.annots)] : []);
  }

  for (let round = 0; round < 3; round += 1) {
    for (const [nm, sh] of shells) collectInsts(nm, sh, tree, C);
    /* 字段要在方法体扫 `return` 之前算好（`self.x` 的类型靠它）。
       元组那几格记录的字段是**按形状直接摆好的**（`tupleRec`），不从标注与 `__init__` 认 ——
       让 `inferFields` 走一遍会把它们抹成空。量到的原话：先报"类 'Tup2_int_string'
       至少要有一个字段"，接着字段读回来的类型也跟着错（`a, b = t` 报"b 先装 string
       后装 int"）。 */
    for (const [, rec] of C.records) if (rec.tuple === undefined) inferFields(rec, C);
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
/** 走一遍那一格的**元素**装什么（表的元素 / 串的一格字符 / 字典的键）。 */
function elemOfCst(tok, C) {
  const t = tyOfCst(tok, C);
  if (t === null || t === undefined) return null;
  if (t.kind === 'arr') return t.elem;
  if (t.kind === 'string') return STR;
  if (t.kind === 'map') return t.key;
  return null;
}

function collectInsts(nm, sh, tree, C) {
  if (sh.annots.every((a) => a !== null)) return;      // 全标注了，不看调用点
  const list = C.insts.get(nm);
  const dot = nm.indexOf('.');
  /** 形参那几格的类型**直接给**（不从调用点的实参 CST 认）。 */
  const takeTys = (types) => {
    if (types.some((t) => t === null || t === undefined)) return;
    const key = tyKey(types);
    if (!list.some((i) => i.key === key)) list.push(mkInst(nm, sh, types));
  };
  /** 一格调用点的实参类型（`self` 那一格由 `sh.annots[0]` 给）。 */
  const take = (args, selfTy) => {
    const types = sh.names.map((_, i) => {
      if (i === 0 && selfTy !== null) return selfTy;
      const k = selfTy === null ? i : i - 1;
      return sh.annots[i] ?? tyOfCst(args[k], C);
    });
    takeTys(types);
  };

  /* **连 f-string 里那几棵一起走** —— 那些调用躺在一个 STRING 记号里，
     `allNodes(tree)` 走不到（`pyToIR` 那一趟已经把它们解析出来挂在 `C.fstrTrees` 上）。 */
  const sweep = (nodes) => {
    for (const node of nodes) {
      if (tag(node) !== 'call') continue;
      const fn = kids(node)[0];
      /* 命名实参先排回位置上、缺的补默认值（不然按次序取的类型会错位）。 */
      const args = kwOrder(fn, kids(part(node, 'args') ?? { kind: 'list', items: [] }), C);
      if (dot < 0) {
        /* 普通函数：`f(…)`。 */
        if (tag(fn) === 'n' && String(nameOf(fn)) === nm && args.length === sh.names.length) {
          take(args, null);
        }
        /* **f 被"按元素"调的那几处**：`map(f, xs)` / `filter(f, xs)` / `key=f` ——
           这儿看到的**不是**一处对 f 的调用（f 是实参），可 `applyPer` 那一侧会按元素类型
           挑实例，所以得单独收一格。只管"一格形参、没标注"那一档（`applyPer` 也只铺这一档）。 */
        if (sh.names.length === 1 && sh.annots[0] === null) {
          const raw = kids(part(node, 'args') ?? { kind: 'list', items: [] });
          const isMe = (t) => t !== undefined && tag(t) === 'n' && String(nameOf(t)) === nm;
          const fname = tag(fn) === 'n' ? String(nameOf(fn)) : null;
          const seqs = [];
          if (['map', 'filter'].includes(fname) && raw.length === 2 && isMe(raw[0])) seqs.push(raw[1]);
          const kw = raw.find((a) => tag(a) === 'kw' && String(leaf(kids(a)[0])) === 'key');
          if (kw !== undefined && isMe(kids(kw)[1])) {
            /* `xs.sort(key=f)` 的序列是接收者；`sorted(xs, key=f)` / `min` / `max` 是第一格。 */
            if (tag(fn) === 'attr') seqs.push(kids(fn)[0]);
            else if (raw.length > 0 && tag(raw[0]) !== 'kw') seqs.push(raw[0]);
          }
          for (const s of seqs) takeTys([elemOfCst(s, C)]);
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
  };

  const nodes = allNodes(tree);
  for (const ft of C.fstrTrees) allNodes(ft, nodes);
  sweep(nodes);

  /**
   * **再按函数体扫一遍，先把形参与局部变量绑进一层作用域**。
   *
   * 头一遍是平铺全树的，所以调用点上的**局部变量**在 `tyOfCst` 那儿答 null —— 收不到
   * 实例。量到的原话：`x = 3` 之后 `dbl(x)` 报"`dbl(int)` 没有对得上的那一格（这份源码里
   * 生成的是 (x)）"；`b = Box(3)` 之后 `b.area(2)` 报"对不上那一格的形参"。
   * 也就是说**实参只要是局部变量就不算**，而真的 python 代码里几乎全是局部变量。
   *
   * 作用域怎么摆与 `inferRet` 那一处同一条（push / 绑形参 / `scanBinds` 走一遍体）。
   * 体里的名字**一次全绑上**（不按语句次序），所以同名换了类型的那种会取到后一格 ——
   * 与推断跑三轮那条口径一致：宁可多收一格实例，也别漏。
   */
  for (const [owner, f] of C.fnNodes) {
    for (const inst of C.insts.get(owner) ?? []) {
      C.push();
      for (const p of inst.params) C.bind(p.name, p.type);
      scanBinds(part(f, 'body'), C);
      sweep(allNodes(f));
      C.pop();
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

/**
 * **"这个名字被递给某个形参"也是一条线索** —— 空容器那一档要靠它。
 *
 * `m = {}` 那一句自己答不出键值类型（与 `d[k] = v` 那一条同一条口径：赋值先不绑，
 * 等走到用它的那一句）。而 `fib(20, m)` 里那格形参**标注了** `dict[int, int]` ——
 * 那就是这个名字的类型。量到的原话：`m = {}` 之后 `fib(20, m)`（形参带标注）报
 * "空字典 `{}` 的键值类型推不出来"，而把标注挪到 `m` 上就好了 —— 一样的信息，
 * 只是从前不从那一侧看。
 *
 * **只认实例唯一、而且形参是表或字典的那一档**：几格实例说明这个函数按实参类型单态化过，
 * 那时猜哪一格都是错的；标量那几档不必从这儿认（右边自己就答得出来），从这儿认反而会
 * 把真该报的错遮住。
 */
function bindFromParams(call, C) {
  const fn = kids(call)[0];
  if (tag(fn) !== 'n') return;
  const list = C.insts.get(String(nameOf(fn)));
  if (!Array.isArray(list) || list.length !== 1) return;
  const inst = list[0];
  const raw = kids(part(call, 'args') ?? { kind: 'list', items: [] });
  if (raw.length !== inst.params.length) return;
  raw.forEach((a, k) => {
    if (tag(a) !== 'n') return;
    const t = inst.params[k].type;
    if (t === null || t === undefined || !['arr', 'map'].includes(t.kind)) return;
    const n = String(nameOf(a));
    const local = C.inScope() && !C.isDeclGlobal(n);
    if ((local ? C.lookupHere(n) : C.lookup(n)) !== null) return;
    C.bind(C.ref(n), t);
  });
}

function scanOne(s, C, rets) {
  /* 这一句里的每一处调用都看一眼形参那一侧（见 `bindFromParams`）。 */
  for (const node of allNodes(s)) if (tag(node) === 'call') bindFromParams(node, C);
  switch (tag(s)) {
    case 'assign': {
      const v = kids(s)[kids(s).length - 1];
      const t = tyOfCst(v, C);
      for (const g of kids(part(s, 'lhs') ?? { kind: 'list', items: [] })) {
        const one = kids(g)[0];
        /* **`a, b = x, y`**（含 `a, b = b, a` 那个交换）—— 两边逐格对着绑。
           这一格从前漏了：`bindTarget` 的元组那一支把**整个右边的类型**按到每一格
           名字上，而 `tyOfCst((tuple …))` 答 null —— 于是一格都没绑，
           发到 `.sx` 那侧报"未声明的变量 'a'"（量出来的）。
           左右格数不一样那件事留给发射那一趟报（`assignTo` 里那句话更具体）。 */
        if (tag(one) === 'tuple' && tag(v) === 'tuple'
          && kids(one).length === kids(v).length) {
          kids(one).forEach((tt, i) => bindTarget(tt, tyOfCst(kids(v)[i], C), C));
          continue;
        }
        /* **`a, b = t`**（右边是一格元组的值）—— 逐格字段的类型对着绑。 */
        if (tag(one) === 'tuple') {
          const tup = tupleOf(C.recOf(t));
          if (tup !== null && tup.length === kids(one).length) {
            kids(one).forEach((tt, i) => bindTarget(tt, tup[i], C));
            continue;
          }
          /* **`a, b = s.split(",")`**（右边是一张表）—— 每一格都是**元素**的类型。
             不看这一条的话 `bindTarget` 的元组那一支会把**整张表**按到每一格名字上，
             到发射那一趟就报"'left' 先装 arr、后装 string"（量到过）。 */
          if (t !== null && t !== undefined && t.kind === 'arr') {
            kids(one).forEach((tt) => bindTarget(tt, t.elem, C));
            continue;
          }
        }
        if (tag(one) === 'index') bindEmptyDict(one, t, C);
        bindTarget(one, t, C);
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
      const iterTok = kids(part(s, 'in') ?? { kind: 'list', items: [] })[0];
      const pair = pairIter(kids(s)[0], iterTok, C);
      if (pair !== null) {
        /* `for i, v in enumerate(xs)` / `for a, b in zip(xs, ys)` —— 两格目标各自绑。 */
        bindTarget(kids(kids(s)[0])[0], pair.t0, C);
        bindTarget(kids(kids(s)[0])[1], pair.t1, C);
      } else {
        const et0 = elemOf(tyOfCst(iterTok, C), iterTok, C);
        /* **N 格目标逐格绑**（`for a, b, c in ts`）—— 照 `bindTarget` 的元组那一支会把
           **整格记录**按到每一格名字上（它不知道这是拆包）。 */
        const tgt = kids(s)[0];
        const tup0 = tupleOf(C.recOf(et0));
        if (tag(tgt) === 'tuple' && tup0 !== null && kids(tgt).length === tup0.length) {
          kids(tgt).forEach((tt, k) => bindTarget(tt, tup0[k], C));
        } else {
          bindTarget(tgt, et0, C);
        }
      }

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
    /**
     * **`xs = []` 之后 `xs.append(v)`** —— python 里最常见的那一格写法。
     *
     * 空表的元素类型从**往里 append 的那个值**认：`tyOfCst([])` 答不出来（空的），
     * 于是赋值那一句先不绑，等走到这一句时按 `arr<那个值的类型>` 绑上。
     * 语句是按次序扫的，所以 `parts = []` 在前、`parts.append(…)` 在后就够了；
     * 反过来（先 append 再赋空表）python 自己也不成立。
     */
    case 'expr': {
      const e = kids(s)[0];
      if (tag(e) !== 'call') return;
      const fn = kids(e)[0];
      if (tag(fn) !== 'attr' || String(leaf(kids(fn)[1])) !== 'append') return;
      const box = kids(fn)[0];
      /**
       * **`d = {}` 之后 `d[k].append(v)`** —— "字典装一串表"那种分组写法（python 里到处
       * 都是）。空字典那一句认不出类型，`d[k] = []` 那一句也认不出（右边是空表），
       * 唯一说得清的就是这一句：键的类型从下标来、元素的类型从 append 的那个值来。
       */
      if (tag(box) === 'index') {
        const base = kids(box)[0];
        if (tag(base) !== 'n') return;
        const bn = String(nameOf(base));
        const blocal = C.inScope() && !C.isDeclGlobal(bn);
        if ((blocal ? C.lookupHere(bn) : C.lookup(bn)) !== null) return;
        const subs0 = kids(part(box, 'subs') ?? { kind: 'list', items: [] });
        const as0 = kids(part(e, 'args') ?? { kind: 'list', items: [] });
        if (subs0.length !== 1 || as0.length !== 1) return;
        const kt0 = tyOfCst(subs0[0], C);
        const vt0 = tyOfCst(as0[0], C);
        if (kt0 === null || vt0 === null || !['int', 'string'].includes(kt0.kind)) return;
        C.bind(C.ref(bn), dictOf(arrOf(vt0), kt0));
        return;
      }
      if (tag(box) !== 'n') return;
      const n = String(nameOf(box));
      const local = C.inScope() && !C.isDeclGlobal(n);
      if ((local ? C.lookupHere(n) : C.lookup(n)) !== null) return;
      const as = kids(part(e, 'args') ?? { kind: 'list', items: [] });
      if (as.length !== 1) return;
      const et = tyOfCst(as[0], C);
      if (et !== null) C.bind(C.ref(n), arrOf(et));
      return;
    }
    default:
  }
}

/**
 * `for a, b in enumerate(xs)` / `for a, b in zip(xs, ys)` —— 认得出来就答两格类型与实参，
 * 别的（目标不是两格名字、或者可迭代不是这两个）答 `null`。
 *
 * 为什么这两个要单挑出来：python 里它们交的是**一串元组**，而这一层没有元组 ——
 * 可这两种写法落下去都只是"一格下标循环"（enumerate 的第一格就是下标，
 * zip 是两张表同一个下标），所以不必先有元组这一档。
 */
function pairIter(target, iterTok, C) {
  if (target === undefined || tag(target) !== 'tuple') return null;
  const ts = kids(target);
  if (ts.length !== 2 || ts.some((t) => tag(t) !== 'n')) return null;
  /* `for a, b in ts`（ts 装的是一串**两格的元组**）—— 与下面那三种一样落成一趟下标循环，
     体开头把两格字段取出来。`list(d.items())` 那种写法就走这一条。 */
  const et = tyOfCst(iterTok, C);
  if (et !== null && et !== undefined && et.kind === 'arr') {
    const tup = tupleOf(C.recOf(et.elem));
    if (tup !== null && tup.length === 2) {
      return { fn: 'tuples', args: [iterTok], t0: tup[0], t1: tup[1] };
    }
  }
  if (iterTok === undefined || tag(iterTok) !== 'call') return null;
  const callee = kids(iterTok)[0];
  const as = kids(part(iterTok, 'args') ?? { kind: 'list', items: [] });
  /* `for k, v in d.items():` —— 被调的是一格 `attr`（不是名字），所以单独一支。
     交的两格就是字典的键与值：走一遍 `(dkeys d)`，值再 `(dget d k)` 取。 */
  if (tag(callee) === 'attr') {
    if (String(nameOf(kids(callee)[1])) !== 'items' || as.length !== 0) return null;
    const recv = kids(callee)[0];
    const dt = tyOfCst(recv, C);
    if (dt === null || dt.kind !== 'map') return null;
    return { fn: 'items', args: [recv], t0: dt.key, t1: dt.value };
  }
  if (tag(callee) !== 'n') return null;
  const fn = String(nameOf(callee));
  if (fn === 'enumerate' && (as.length === 1 || as.length === 2)) {
    const et = elemOf(tyOfCst(as[0], C), as[0]);
    return { fn, args: as, t0: INT, t1: et };
  }
  if (fn === 'zip' && as.length === 2) {
    return {
      fn, args: as, t0: elemOf(tyOfCst(as[0], C), as[0]), t1: elemOf(tyOfCst(as[1], C), as[1]),
    };
  }
  return null;
}

/**
 * `enumerate` / `zip` 那两格 —— 一格下标循环，体开头把两格目标算出来。
 *
 * `zip` 走到**短的那一张**为止（python 的规矩）；`enumerate(xs, start)` 的第一格
 * 是 `下标 + start`。两格都只走表与串（字典要先有"走一遍键"那一格）。
 */
function pairFor(x, pair, once, pre, C) {
  const i = C.fresh('for_i');
  C.bind(i, INT);
  const idx = { kind: 'name', name: i };
  const n0 = C.ref(String(nameOf(kids(kids(x)[0])[0])));
  const n1 = C.ref(String(nameOf(kids(kids(x)[0])[1])));
  /** 第 i 格（表按下标、串按一个字符）。 */
  const at = (box) => {
    const t = typeOfIR(box, C);
    if (t.kind === 'arr') return { kind: 'index', obj: box, index: idx };
    if (t.kind === 'string') return { kind: 'builtin', name: 'ssub', args: [box, idx, { kind: 'int', value: 1 }] };
    throw new Error(`python->IR: \`${pair.fn}()\` 在 ${t.kind} 上还没接（表与串接了）`);
  };
  let cond;
  let first;
  let second;
  if (pair.fn === 'enumerate') {
    const box = once(pair.args[0], 'iter');
    const start = pair.args.length === 2 ? once(pair.args[1], 'start') : { kind: 'int', value: 0 };
    cond = { kind: 'binop', op: '<', left: idx, right: lenOf(box, C) };
    first = start.kind === 'int' && Number(start.value) === 0
      ? idx
      : { kind: 'binop', op: '+', left: idx, right: start };
    second = at(box);
  } else if (pair.fn === 'tuples') {
    /* 一串两格的元组：逐格取 `_0` / `_1`。 */
    const box = once(pair.args[0], 'iter');
    cond = { kind: 'binop', op: '<', left: idx, right: lenOf(box, C) };
    const at = { kind: 'index', obj: box, index: idx };
    first = { kind: 'field', obj: at, name: '_0' };
    second = { kind: 'field', obj: at, name: '_1' };
  } else if (pair.fn === 'items') {
    /* `d.items()` —— 键表落一格临时量（`(dkeys d)` 是抄的一份，循环里 `dget` 取值）。 */
    const d = once(pair.args[0], 'items_d');
    const kn = C.fresh('items_ks');
    const kt = arrOf(pair.t0);
    C.bind(kn, kt);
    pre.push({ kind: 'let', name: kn, type: kt, init: { kind: 'builtin', name: 'dkeys', args: [d] } });
    const ks = { kind: 'name', name: kn };
    cond = { kind: 'binop', op: '<', left: idx, right: { kind: 'builtin', name: 'alen', args: [ks] } };
    first = { kind: 'index', obj: ks, index: idx };
    second = { kind: 'builtin', name: 'dget', args: [d, first] };
  } else {
    const a = once(pair.args[0], 'zip_a');
    const b = once(pair.args[1], 'zip_b');
    const la = lenOf(a, C);
    const lb = lenOf(b, C);
    /* 短的那一张说了算 —— `(sel (< la lb) la lb)`。 */
    cond = {
      kind: 'binop', op: '<', left: idx,
      right: {
        kind: 'ternary', type: INT, cond: { kind: 'binop', op: '<', left: la, right: lb }, then: la, else_: lb,
      },
    };
    first = at(a);
    second = at(b);
  }
  C.bind(n0, pair.t0);
  C.bind(n1, pair.t1);
  return {
    kind: 'block',
    stmts: [...pre, {
      kind: 'for',
      init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
      cond,
      post: { kind: 'assign', target: idx, value: { kind: 'binop', op: '+', left: idx, right: { kind: 'int', value: 1 } } },
      body: [
        { kind: 'assign', target: { kind: 'name', name: n0 }, value: first },
        { kind: 'assign', target: { kind: 'name', name: n1 }, value: second },
        ...bodyStmts(part(x, 'body'), C),
      ],
    }],
  };
}

/** 一格可迭代的东西装的元素是什么（`range(…)` 出 int，表出它的元素，串出串）。 */
function elemOf(it, node, C) {
  if (node !== undefined && tag(node) === 'call' && tag(kids(node)[0]) === 'n'
    && String(nameOf(kids(node)[0])) === 'range') return INT;
  if (it === null) return null;
  if (it.kind === 'arr') return it.elem;
  if (it.kind === 'string') return STR;
  /* `for k in d:` —— python 走的是键（不是值，也不是键值对）。 */
  if (it.kind === 'map') return it.key;
  /* 元组：逐格合成一格（`for v in (1, 2, 3)`）。 */
  if (C !== undefined) {
    const tup = tupleOf(C.recOf(it));
    if (tup !== null) return unifyPy(tup);
  }
  return null;
}

/**
 * **`d = {}` 之后 `d[k] = v`** —— 空字典的键值类型从这一句认（与 `xs = []` 之后
 * `xs.append(v)` 那一格同一条办法：赋值那一句先不绑，等走到用它的那一句）。
 * 键只认 int 与 str（方言的字典键就这两档）。
 */
function bindEmptyDict(target, vt, C) {
  if (vt === null || vt === undefined) return;
  const base = kids(target)[0];
  if (tag(base) !== 'n') return;
  const n = String(nameOf(base));
  const local = C.inScope() && !C.isDeclGlobal(n);
  if ((local ? C.lookupHere(n) : C.lookup(n)) !== null) return;
  const subs = kids(part(target, 'subs') ?? { kind: 'list', items: [] });
  if (subs.length !== 1) return;
  const kt = tyOfCst(subs[0], C);
  if (kt === null || !['int', 'string'].includes(kt.kind)) return;
  C.bind(C.ref(n), dictOf(vt, kt));
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
    case 'while': return loopElse(x, whileStmt(x, C), C);
    case 'for': return loopElse(x, forStmt(x, C), C);
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
    /* 函数里套的函数**已经提到模块级**了（`hoistNested`），所以这一句不发东西。
       有捕获的那一档在 `hoistNested` 里就当场报了，走不到这儿。 */
    case 'def':
      return [];

    case 'class':
      throw new Error('python->IR: `class` 还没接（下一刀）');
    case 'del': return delStmt(x, C);
    case 'try': case 'with': case 'match': case 'decorated': case 'async':
      throw new Error(`python->IR: \`${tag(x)}\` 还没接`);
    default:
      throw new Error(`python->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/**
 * `del d[k]` / `del xs[i]`（可以一句删几格：`del d["a"], xs[0]`）。
 *
 * 字典那一格落在方言的 `(ddel d k)` 上 —— 它答"原先在不在"，所以 KeyError 就是
 * 「答 false 就 `(fail …)`」。表那一格没有新算子：`dropAtStmts` 往前挪一格再 `apop`
 * （与 `.pop(i)` 逐字同一条路）。
 *
 * **`del 名字` 不接**：那要有"这一格还绑着没有"这一层，而方言里一格变量就是一格槽位，
 * 没有"没绑"这一档 —— 猜一个（比如置零值）会让后面读到的东西看着像对的。
 */
function delStmt(x, C) {
  const t = kids(x)[0];
  const ts = tag(t) === 'tuple' ? kids(t) : [t];
  const out = [];
  for (const one of ts) out.push(...delOne(one, C));
  return out;
}

function delOne(t, C) {
  if (tag(t) !== 'index') {
    throw new Error(`python->IR: \`del ${tag(t) === 'n' ? String(nameOf(t)) : tag(t)}\` 还没接`
      + ' —— `del` 只接下标那一格（`del d[k]` / `del xs[i]`）。'
      + '`del 名字` 要有"这一格还绑着没有"那一层，方言里一格变量就是一格槽位，没有那一档');
  }
  const box = exprOf(kids(t)[0], C);
  const subs = kids(part(t, 'subs') ?? { kind: 'list', items: [] });
  if (subs.length !== 1) throw new Error('python->IR: `del` 收一格下标');
  if (tag(subs[0]) === 'slice') throw new Error('python->IR: `del xs[1:3]` 还没接');
  const bt = typeOfIR(box, C);
  const key = exprOf(subs[0], C);
  if (bt.kind === 'map') {
    /* 键不在就 KeyError。那句话里带上键本身（`KeyError: 'z'`，与 python 的末行同形）——
       键是运行期的值，所以拼的是一格串表达式，不是编译期的字面量。 */
    const msg = {
      kind: 'binop', op: '+',
      left: { kind: 'string', value: 'KeyError: ' },
      right: pyRepr(key, C),
    };
    return [{
      kind: 'if',
      cond: { kind: 'unop', op: '!', operand: { kind: 'builtin', name: 'ddel', args: [box, key] } },
      then: [{ kind: 'builtin-stmt', name: 'fail', args: [msg] }],
      else_: null,
    }];
  }
  if (bt.kind === 'arr') return dropAtStmts(box, wrapIdxForWrite(box, key, C), C);
  throw new Error(`python->IR: \`del\` 落在 ${bt.kind} 上还没接（串在 python 里不可改）`);
}

/** 语句位置上的一格表达式。`print(…)` 与**改原表**那几格方法不交值，各自一格。 */
function exprStmtOf(e, C) {
  if (tag(e) === 'call') {
    const [fn, argsTok] = kids(e);
    const argToks = argsTok === undefined ? [] : kids(argsTok);
    if (tag(fn) === 'n' && String(nameOf(fn)) === 'print') return printStmt(argToks, C);
    if (tag(fn) === 'attr') {
      const m = String(leaf(kids(fn)[1]));
      if (LIST_MUT.has(m)) {
        const box = exprOf(kids(fn)[0], C);
        const t = typeOfIR(box, C);
        if (t.kind === 'arr') return listMut(m, box, argToks, C);
        /* 字典上改原表的那两格 —— python 里都交 None，所以只当语句用。 */
        if (t.kind === 'map' && m === 'clear') {
          if (argToks.length !== 0) throw new Error('python->IR: `.clear()` 不收实参');
          return dictClearStmts(box, C);
        }
        if (t.kind === 'map' && m === 'update') {
          if (argToks.length !== 1) throw new Error('python->IR: `.update()` 只收一格字典');
          const other = exprOf(argToks[0], C);
          const ot = typeOfIR(other, C);
          if (ot.kind !== 'map') throw new Error(`python->IR: \`.update()\` 收一格字典，这里是 ${ot.kind}`);
          if (!sameType(t.key, ot.key)) {
            throw new Error(`python->IR: \`.update()\` 两边的键是 ${t.key.kind} 与 ${ot.key.kind}`);
          }
          const box2 = (e) => (t.value.kind === 'dyn' && ot.value.kind !== 'dyn' ? boxOf(e, C) : e);
          return dictUpdateStmts(box, other, C, box2);
        }
      }
    }
  }
  return [{ kind: 'expr-stmt', expr: exprOf(e, C) }];
}

/** **改原容器**的那几格（python 里它们交 None，所以只当语句用）。 */
const LIST_MUT = new Set([
  'append', 'reverse', 'extend', 'clear', 'insert', 'remove', 'pop', 'sort', 'update',
]);

/**
 * `xs.append(v)` / `.reverse()` / `.extend(ys)` / `.clear()` / `.insert(i, v)` / `.remove(v)`
 * —— 方言里只有 `apush` / `apop` / `aset`，别的都是**现场发一趟循环**（`builtins.js`）。
 */
function listMut(m, box, argToks, C) {
  const et = typeOfIR(box, C).elem;
  const arg = (k) => {
    const v = exprOf(argToks[k], C);
    return et.kind === 'dyn' && typeOfIR(v, C).kind !== 'dyn' ? boxOf(v, C) : v;
  };
  /* `.sort()` / `.sort(reverse=True)` / `.sort(key=lambda v: …)` —— **就地**排
     （`sorted()` 才抄一份）。两个命名实参与 `sorted()` 那一处同一条口径。 */
  if (m === 'sort') {
    let desc = false;
    let keyTok = null;
    for (const a of argToks) {
      if (tag(a) !== 'kw') throw new Error('python->IR: `.sort()` 的实参只收 `reverse=` 与 `key=`');
      const k = String(leaf(kids(a)[0]));
      const v = kids(a)[1];
      if (k === 'key') {
        keyTok = v;
        continue;
      }
      if (k !== 'reverse') {
        throw new Error(`python->IR: \`.sort(${k}=…)\` 还没接（接了的是 reverse= 与 key=）`);
      }
      if (tag(v) !== 'true' && tag(v) !== 'false') {
        throw new Error('python->IR: `.sort(reverse=…)` 要写成 True / False 字面量'
          + '（两种比法是两条循环，得在编译期定）');
      }
      desc = tag(v) === 'true';
    }
    const bt = C.tyOfIR(box);
    if (keyTok !== null) return sortByKeyPy(box, keyTok, C, desc);
    if (bt.kind === 'arr') needOrd(bt.elem, C, '.sort()');
    return sortStmts(box, C, desc, (x, y) => cmpLt(x, y, C));
  }
  if (m === 'append') {
    if (argToks.length !== 1) throw new Error('python->IR: `.append()` 只收一格实参');
    return [{ kind: 'builtin-stmt', name: 'apush', args: [box, arg(0)] }];
  }
  if (m === 'reverse') {
    if (argToks.length !== 0) throw new Error('python->IR: `.reverse()` 不收实参');
    return reverseStmts(box, C);
  }
  if (m === 'clear') {
    if (argToks.length !== 0) throw new Error('python->IR: `.clear()` 不收实参');
    return clearStmts(box, C);
  }
  if (m === 'extend') {
    if (argToks.length !== 1) throw new Error('python->IR: `.extend()` 只收一格实参');
    const ys = exprOf(argToks[0], C);
    const yt = typeOfIR(ys, C);
    if (yt.kind !== 'arr') throw new Error(`python->IR: \`.extend()\` 收一格表（这里是 ${yt.kind}）`);
    return extendStmts(box, ys, C, et.kind === 'dyn' && yt.elem.kind !== 'dyn' ? (v) => boxOf(v, C) : undefined);
  }
  if (m === 'insert') {
    if (argToks.length !== 2) throw new Error('python->IR: `.insert(i, v)` 收两格实参');
    return insertStmts(box, exprOf(argToks[0], C), arg(1), C);
  }
  if (m === 'remove') {
    if (argToks.length !== 1) throw new Error('python->IR: `.remove(v)` 只收一格实参');
    const at = indexOfList(box, arg(0), C, (l, r) => cmpEq(l, r, C));
    return dropAtStmts(box, at, C);
  }
  /* `xs.pop()` / `xs.pop(i)` 当语句用 —— 交出来的那一格没人要，丢掉。 */
  if (argToks.length === 0) return [{ kind: 'expr-stmt', expr: { kind: 'builtin', name: 'apop', args: [box] } }];
  return dropAtStmts(box, exprOf(argToks[0], C), C);
}

/**
 * `print(a, b)` —— **一行、空格连、末尾一个换行**（`Lib/builtins` 的默认 sep/end）。
 * 给了 `end=` 就改走 `write`（那一格不补换行），把 end 拼在后面。`sep=` 还没接。
 */
function printStmt(argToks, C) {
  let end = null;
  let sep = null;
  const pos = [];
  for (const a of argToks) {
    if (tag(a) === 'kw') {
      const k = String(leaf(kids(a)[0]));
      if (k === 'end') { end = exprOf(kids(a)[1], C); continue; }
      if (k === 'sep') { sep = exprOf(kids(a)[1], C); continue; }
      throw new Error(`python->IR: \`print(${k}=…)\` 还没接（接了的是 end= 与 sep=）`);
    }
    if (tag(a) === 'starstar') {
      throw new Error('python->IR: `print(**d)` 还没接');
    }
    pos.push(a);
  }
  const gap = sep ?? { kind: 'string', value: ' ' };
  const pre = [];
  let value;
  if (pos.some((a) => tag(a) === 'star')) {
    /**
     * **`print(*xs)`** —— 先把要印的那几段**攒成一张串表**，再用分隔符 join。
     *
     * 为什么不是"逐段拿 `+` 接起来"：展开的那张表可能是空的，而 python 那时**不多摆
     * 一个分隔符**（`print("a", *[], "b")` 是 `a b`，不是 `a  b`）。表的长度是运行时
     * 才知道的，所以"有几段"这件事只能在运行时数 —— 攒表再 join 正好是这个意思。
     */
    const st = arrOf(STR);
    const pn = C.fresh('pr_ps');
    C.bind(pn, st);
    pre.push({
      kind: 'let', name: pn, type: st,
      init: { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: st }, { kind: 'int', value: 0 }] },
    });
    const ps = { kind: 'name', name: pn };
    for (const a of pos) {
      if (tag(a) !== 'star') {
        pre.push({ kind: 'builtin-stmt', name: 'apush', args: [ps, pyStr(exprOf(a, C), C)] });
        continue;
      }
      const box = exprOf(kids(a)[0], C);
      const bt = typeOfIR(box, C);
      const src = bt.kind === 'string' ? charsOf(box, C) : box;
      const stt = typeOfIR(src, C);
      if (stt.kind !== 'arr') {
        throw new Error(`python->IR: \`print(*${bt.kind})\` 还没接（表与串接了）`);
      }
      const bn = C.fresh('pr_xs');
      C.bind(bn, stt);
      pre.push({ kind: 'let', name: bn, type: stt, init: src });
      const xs = { kind: 'name', name: bn };
      const iN = C.fresh('pr_i');
      C.bind(iN, INT);
      pre.push({ kind: 'let', name: iN, type: INT, init: { kind: 'int', value: 0 } });
      const i = { kind: 'name', name: iN };
      pre.push({
        kind: 'while',
        cond: { kind: 'binop', op: '<', left: i, right: { kind: 'builtin', name: 'alen', args: [xs] } },
        body: [
          {
            kind: 'builtin-stmt',
            name: 'apush',
            args: [ps, pyStr({ kind: 'index', obj: xs, index: i }, C)],
          },
          { kind: 'assign', target: i, value: { kind: 'binop', op: '+', left: i, right: { kind: 'int', value: 1 } } },
        ],
      });
    }
    value = joinOf(gap, ps, C);
  } else {
    /**
     * **实参先按次序各落一格临时量**（两格以上、而且那一格不纯时）。
     *
     * python 是**从左到右**把实参算完的，而这儿是把几段拼成一个大表达式 —— 段里带的
     * `block-expr` 那几句会被提到整句的最前头，于是**后面那一段的转串跑在前面那一段的
     * 副作用之前**。量到的原话：`print(xs.pop(), xs)` 答 `2 [1, 2]`（python 是 `2 [1]`）——
     * 转 `xs` 那一趟循环跑在 `apop` 之前。先按次序钉住实参，次序就回来了。
     */
    const vals = pos.map((a, k) => {
      const v = exprOf(a, C);
      if (pos.length < 2 || ['int', 'real', 'string', 'bool', 'name'].includes(v.kind)) return v;
      const t0 = typeOfIR(v, C);
      const n0 = C.fresh(`pr_a${k}`);
      C.bind(n0, t0);
      pre.push({ kind: 'let', name: n0, type: t0, init: v });
      return { kind: 'name', name: n0 };
    });
    const parts = vals.map((v) => pyStr(v, C));
    value = parts.length === 0 ? { kind: 'string', value: '' } : parts[0];
    for (const p of parts.slice(1)) {
      value = {
        kind: 'binop', op: '+',
        left: { kind: 'binop', op: '+', left: value, right: gap },
        right: p,
      };
    }
  }
  if (end === null) return [...pre, { kind: 'print', values: [value] }];
  return [...pre, { kind: 'write', values: [{ kind: 'binop', op: '+', left: value, right: end }] }];
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
    const ts = kids(t);
    /* **右边是一格元组的值**（`a, b = f()` / `a, b = t`）—— 逐格字段拆出来。
       先落一格临时量：右边只算一遍。 */
    if (tag(valueTok) !== 'tuple') {
      const v = exprOf(valueTok, C);
      const vt = typeOfIR(v, C);
      const tup = tupleOf(C.recOf(vt));
      /* **右边是一张表**（`a, b = s.split(",")`）—— 长度要跑起来才知道，所以
         **发一句运行期的检查**（python 那儿是 ValueError），再按下标逐格取。
         这是最常见的一种写法，不接的话 `.split()` 的结果就得自己按下标拆。 */
      if (tup === null && vt.kind === 'arr') {
        const tmp0 = C.fresh('unpack');
        C.bind(tmp0, vt);
        const box0 = { kind: 'name', name: tmp0 };
        const out0 = [
          { kind: 'let', name: tmp0, type: vt, init: v },
          {
            kind: 'if',
            cond: {
              kind: 'binop', op: '!=',
              left: { kind: 'builtin', name: 'alen', args: [box0] },
              right: { kind: 'int', value: ts.length },
            },
            then: [{
              kind: 'builtin-stmt',
              name: 'fail',
              args: [{ kind: 'string', value: `expected ${ts.length} values to unpack` }],
            }],
            else_: null,
          },
        ];
        ts.forEach((tt, i) => out0.push(...writeTo(
          tt, { kind: 'index', obj: box0, index: { kind: 'int', value: i } }, C,
        )));
        return out0;
      }
      if (tup === null) {
        throw new Error(`python->IR: 拆包赋值的右边装的是 ${vt.kind} —— `
          + '要么写成一格元组（`a, b = x, y`），要么交一格元组或一张表');
      }
      if (tup.length !== ts.length) {
        throw new Error(`python->IR: 拆包赋值两边格数不一样（左 ${ts.length}、右 ${tup.length}）`);
      }
      const tmp = C.fresh('unpack');
      C.bind(tmp, vt);
      const out = [{ kind: 'let', name: tmp, type: vt, init: v }];
      ts.forEach((tt, i) => out.push(...writeTo(
        tt, { kind: 'field', obj: { kind: 'name', name: tmp }, name: `_${i}` }, C,
      )));
      return out;
    }
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
  /* **`xs[a:b] = []` 与 `d[k] = []`** —— 空容器的类型从**左边那一格**来（右边答不出）。 */
  if (tag(t) === 'index' && ['list', 'dict'].includes(tag(valueTok))
    && kids(valueTok).length === 0) {
    const subs0 = kids(part(t, 'subs') ?? { kind: 'list', items: [] });
    const bt1 = tyOfCst(kids(t)[0], C);
    if (subs0.length === 1 && tag(subs0[0]) === 'slice'
      && bt1 !== null && bt1.kind === 'arr' && tag(valueTok) === 'list') {
      return writeTo(t, emptyOf(bt1), C);
    }
    /* `d[k] = []` / `d[k] = {}` —— 字典的**值**那一档说了算。 */
    if (subs0.length === 1 && bt1 !== null && bt1.kind === 'map'
      && bt1.value.kind === (tag(valueTok) === 'list' ? 'arr' : 'map')) {
      return writeTo(t, emptyOf(bt1.value), C);
    }
  }
  /* **`xs = []` / `d = {}`**：空容器自己答不出元素类型，可这一格名字的类型
     `scanBinds` 那一趟已经认出来了（从 `xs.append(v)` 或标注）—— 按它造。 */
  if (tag(t) === 'n' && ['list', 'dict'].includes(tag(valueTok)) && kids(valueTok).length === 0) {
    const want = C.lookup(String(nameOf(t)));
    if (want !== null && want.kind === (tag(valueTok) === 'list' ? 'arr' : 'map')) {
      return writeTo(t, emptyOf(want), C);
    }
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
    /* **`xs[a:b] = ys`** —— 就地换掉那一段（长度可以不一样）。步长那一档不收：
       python 里带步长的切片赋值要求两边格数一样，是另一条规矩。 */
    if (tag(subs[0]) === 'slice') {
      const parts = kids(subs[0]);
      if (parts.length > 2 && parts[2] !== undefined && tag(parts[2]) !== null) {
        throw new Error('python->IR: 带步长的切片赋值（`xs[::2] = …`）还没接'
          + '（python 那一档要求两边格数一样，是另一条规矩）');
      }
      const bt0 = typeOfIR(box, C);
      const vt0 = typeOfIR(value, C);
      if (bt0.kind !== 'arr') throw new Error(`python->IR: 给 ${bt0.kind} 的切片赋值还没接（表接了）`);
      if (vt0.kind !== 'arr' || !sameType(vt0.elem, bt0.elem)) {
        throw new Error('python->IR: `xs[a:b] = ys` 的右边要是一张**同型的表**'
          + `（这里是 ${vt0.kind === 'arr' ? `arr<${vt0.elem.kind}>` : vt0.kind}）`);
      }
      const at = (k) => (parts[k] === undefined || tag(parts[k]) === null ? null : exprOf(parts[k], C));
      return sliceAssignStmts(box, at(0), at(1), value, C);
    }
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
  /* `o.f += v` —— 落成 `o.f = o.f + v`。**接收者要是一格名字**（`self.n += 1` 那种）：
     这一手把它读一遍、写一遍，接收者不纯就会算两遍（python 只算一遍）。 */
  if (tag(target) === 'attr' && tag(kids(target)[0]) !== 'n') {
    throw new Error(`python->IR: \`${o}=\` 的左边是一格属性，而接收者不是名字`
      + ' —— 还没接（那一手要把接收者算两遍，python 只算一遍）');
  }
  if (!['n', 'index', 'attr'].includes(tag(target))) {
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
  /* **`self.xs: list[int] = []`** —— 标注只管类型（字段那一侧 `inferFields` 已经照它算了），
     这儿把那一句赋值发出去就行；空容器按标注造。 */
  if (tag(target) === 'attr') {
    if (init === undefined) return [];
    const v0 = kids(init)[0];
    const empty = (tag(v0) === 'list' && kids(v0).length === 0 && t.kind === 'arr')
      || (tag(v0) === 'dict' && kids(v0).length === 0 && t.kind === 'map');
    return writeTo(target, empty ? emptyOf(t) : exprOf(v0, C), C);
  }
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

/**
 * `for … else:` / `while … else:` —— 那一支是"**没 break 就跑**"（不是"循环完就跑"：
 * 从 `break` 出来的那一回不跑）。
 *
 * 落法：一格布尔旗子 —— 进循环前置 true，体里**属于这一层**的每个 `break` 前面补一句
 * 置 false，循环之后 `if (旗子) { else 那一支 }`。
 *
 * "属于这一层"是关键：递归进 `if` / `block` 那几层，**不进**嵌套的 `for` / `while`
 * （那里头的 break 跳的是里层那一圈，与这一格的 else 无关）。
 */
function loopElse(x, made, C) {
  const els = kids(x).filter((y) => tag(y) === 'else');
  if (els.length === 0) return [made];
  /* 刚造出来的那一圈：`forStmt` 可能把它包在一格 block 里（前面还有几句 pre）。 */
  const loop = made.kind === 'block' ? made.stmts[made.stmts.length - 1] : made;
  const flag = C.fresh('loop_ok');
  C.bind(flag, BOOL);
  const fv = { kind: 'name', name: flag };
  markBreaks(loop.body, { kind: 'assign', target: fv, value: { kind: 'bool', value: false } });
  return [
    { kind: 'let', name: flag, type: BOOL, init: { kind: 'bool', value: true } },
    made,
    { kind: 'if', cond: fv, then: els.flatMap((e) => bodyStmts(part(e, 'body') ?? e, C)), else_: null },
  ];
}

/** 一串语句里属于这一层的 `break` 前面各补一句（不进嵌套的循环）。 */
function markBreaks(list, clear) {
  if (!Array.isArray(list)) return;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const s = list[i];
    if (s === null || typeof s !== 'object') continue;
    if (s.kind === 'break') { list.splice(i, 0, clear); continue; }
    if (s.kind === 'for' || s.kind === 'while') continue;
    for (const key of ['then', 'else_', 'body', 'stmts']) markBreaks(s[key], clear);
  }
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
  const target = kids(x)[0];
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

  /* `for i, v in enumerate(xs)` / `for a, b in zip(xs, ys)` —— 都落成一格下标循环。 */
  const pair = pairIter(target, iter, C);
  if (pair !== null) return pairFor(x, pair, once, pre, C);

  /**
   * **`for a, b, c in ts`** —— ts 装的是一串 **N 格的元组**（`zip(a, b, c)` 交的正是它）。
   *
   * 两格那一档走上面的 `pairIter`（那儿另有 enumerate / items / zip 三条专路，省一张中间表）；
   * 这儿管 N 格：一格下标循环，体开头把 `_0` … `_{n-1}` 逐格取出来。
   */
  if (tag(target) === 'tuple') {
    const ts = kids(target);
    const et = tyOfCst(iter, C);
    const tup = et !== null && et !== undefined && et.kind === 'arr'
      ? tupleOf(C.recOf(et.elem)) : null;
    if (tup !== null && ts.length === tup.length && ts.every((t) => tag(t) === 'n')) {
      const box = once(iter, 'iter');
      const iN = C.fresh('for_i');
      C.bind(iN, INT);
      const idx = { kind: 'name', name: iN };
      const names = ts.map((t) => C.ref(String(nameOf(t))));
      names.forEach((n, k) => C.bind(n, tup[k]));
      const cell = { kind: 'index', obj: box, index: idx };
      return {
        kind: 'block',
        stmts: [...pre, {
          kind: 'for',
          init: { kind: 'let', name: iN, type: INT, init: { kind: 'int', value: 0 } },
          cond: {
            kind: 'binop', op: '<', left: idx,
            right: { kind: 'builtin', name: 'alen', args: [box] },
          },
          post: {
            kind: 'assign', target: idx,
            value: { kind: 'binop', op: '+', left: idx, right: { kind: 'int', value: 1 } },
          },
          body: [
            ...names.map((n, k) => ({
              kind: 'assign',
              target: { kind: 'name', name: n },
              value: { kind: 'field', obj: cell, name: `_${k}` },
            })),
            ...bodyStmts(part(x, 'body'), C),
          ],
        }],
      };
    }
  }
  if (tag(target) !== 'n') throw new Error(`python->IR: \`for\` 的目标是 \`${tag(target)}\` —— 拆包还没接`
    + '（`enumerate(…)` 与 `zip(a, b)` 那两格接了）');
  const name = C.ref(String(nameOf(target)));

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
  let src = box;
  let bt = typeOfIR(box, C);
  /* `for v in t:` —— **元组逐格摆进一张表再走**（格数与逐格类型都是编译期定的，
     所以这一趟是展开，不是循环）。异质的那格元组摆出来是 `(arr dyn)`。 */
  if (tupleOf(C.recOf(bt)) !== null) {
    const lst = tupleToList(box, C);
    const lt = typeOfIR(lst, C);
    const tn = C.fresh('for_tl');
    C.bind(tn, lt);
    pre.push({ kind: 'let', name: tn, type: lt, init: lst });
    src = { kind: 'name', name: tn };
    bt = lt;
  }
  /* `for k in d:` —— python 走的是**键**。`(dkeys d)` 交一格 `(arr K)`（插入序），
     于是这一格落成"键表 + 下标循环"，与走一遍表逐字同一条路。 */
  if (bt.kind === 'map') {
    const kn = C.fresh('for_ks');
    const kt = arrOf(bt.key);
    C.bind(kn, kt);
    pre.push({ kind: 'let', name: kn, type: kt, init: { kind: 'builtin', name: 'dkeys', args: [box] } });
    src = { kind: 'name', name: kn };
    bt = kt;
  }
  if (bt.kind !== 'arr' && bt.kind !== 'string') {
    throw new Error(`python->IR: 在 ${bt.kind} 上走一遍还没接（range / 表 / 串 / 字典接了）`);
  }
  const i = C.fresh('for_i');
  C.bind(i, INT);
  const item = bt.kind === 'arr'
    ? { kind: 'index', obj: src, index: { kind: 'name', name: i } }
    : {
      /* `(ssub E I N)` 是"从 I 起取 N 个" —— 一格字符就是 N = 1。 */
      kind: 'builtin', name: 'ssub',
      args: [src, { kind: 'name', name: i }, { kind: 'int', value: 1 }],
    };
  return {
    kind: 'block',
    stmts: [...pre, {
      kind: 'for',
      init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
      cond: { kind: 'binop', op: '<', left: { kind: 'name', name: i }, right: lenOf(src, C) },
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
