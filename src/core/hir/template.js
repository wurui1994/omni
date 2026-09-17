// src/core/hir/template.js —— 卫生模板落在 **omni 主语言** 上（ADR-0037 事情一，§4.1）
//
// `sexpr/template.js` 那一份是同一个机制在**中间格式**上的样子（核心方言只是中间格式，
// 不是给人写的那一门）。这一份才是给人写的那一格：
//
//     template dbl(x) { let t = x; print(t + t); }
//     dbl(k * 2);            // 调用点与函数调用同形
//
// 两趟照 Nim（`compiler/semtempl.nim` + `compiler/evaltempl.nim`，本机
// `~/Documents/Lang/reference/Nim/`）：
//   一、**定义期**（`bindDef`）：体里 `let`/`var`/`for` 引入的名字记成「要换名的」
//       （Nim 的 "locals default to gensym"）；体里引用的自由名字**在定义处**分类 ——
//       是模块级变量就记进 `t.globals`，既不是形参也不是局部也不是模块级名字就当场报。
//   二、**展开期**（`substStmts`）：形参**按位置**替成实参那棵树（深拷，同一个实参可能替进
//       好几处），要换名的局部换成 `名_gensymN`（`N` 一次展开一个号，就是 Nim 的 `instID`）。
//
// 落点：`module/load.js` 里 parse 之后（每份文件各展开自己的模板 —— 模板不跨模块），
// 所以检查器一个 `TemplateDecl` 都见不到。
//
// **明着不接的三格**（都报，不猜）：
//   * 表达式位置上的模板调用（体是一串语句，塞不进表达式）
//   * 调用处有局部与模板体绑到的模块级变量同名 —— Nim 那边靠"自由名字在定义处解析成
//     nkSym"做到不遮，而我们的检查器给遮蔽的声明**不改名**（`check.js` 的 `Scope.declare`
//     原名入表），所以这一格靠改名做不到；报出来比让它静默取错那一个好
//   * 模板体里的 lambda 形参 / match 绑定与替进去的实参同名（那两格是它们自己的绑定器，
//     不参与 gensym）

import { BUILTIN_FUNCS } from './check.js';

/** 一次展开一个号（Nim 的 `instID`）。进程内单调递增 —— 同一个模板展开两次名字必须不同。 */
let INST = 0;

/** 展开套多少层就算"在调自己"。模板不是函数，展开是编译期做完的，所以不能递归。 */
const MAX_DEPTH = 64;

const isNode = (n) => n !== null && n !== undefined && typeof n === 'object';

/** `span` 那一格里挂着整份 SourceFile，深拷会把源码文本也拷一遍 —— 按引用带走。 */
const isSpanKey = (k) => k === 'span' || k.endsWith('Span');

/**
 * 深拷一棵子树。同一个实参可能被替进去**好几处**（`dbl(k)` 的体里 `t` 出现两次），
 * 不共享节点 —— 共享的话后面任何一处改写都会串到别处。
 */
function copy(n) {
  if (Array.isArray(n)) return n.map(copy);
  if (!isNode(n)) return n;
  const out = {};
  for (const k of Object.keys(n)) out[k] = isSpanKey(k) ? n[k] : copy(n[k]);
  return out;
}

/** 这条语句里新引入的名字（进了作用域就可能遮住模板体绑到的模块级变量）。 */
function binderNames(s) {
  if (s.kind === 'VarDecl') return s.decls.map((d) => d.name);
  if (s.kind === 'ForIn') return [s.varName];
  return [];
}

/**
 * 一串语句里的模板调用点全展开。`cx.binders` 是**调用处**这一层往外的局部名字，
 * 用来判"调用处的局部会不会遮住模板体在定义处绑到的模块级变量"。
 */
function expandStmts(list, cx, depth) {
  const mark = cx.binders.length;
  const out = list.map((s) => {
    const r = expandStmt(s, cx, depth);
    for (const nm of binderNames(s)) cx.binders.push(nm);
    return r;
  });
  cx.binders.length = mark;
  return out;
}

function expandStmt(s, cx, depth) {
  if (!isNode(s)) return s;
  switch (s.kind) {
    case 'Block': return { ...s, stmts: expandStmts(s.stmts, cx, depth) };
    case 'If': return {
      ...s,
      then: expandStmt(s.then, cx, depth),
      otherwise: s.otherwise === null ? null : expandStmt(s.otherwise, cx, depth),
    };
    case 'While': return { ...s, body: expandStmt(s.body, cx, depth) };
    case 'For': {
      const mark = cx.binders.length;
      if (isNode(s.init)) for (const nm of binderNames(s.init)) cx.binders.push(nm);
      const body = expandStmt(s.body, cx, depth);
      cx.binders.length = mark;
      return { ...s, body };
    }
    case 'ForIn': {
      cx.binders.push(s.varName);
      const body = expandStmt(s.body, cx, depth);
      cx.binders.pop();
      return { ...s, body };
    }
    case 'Match': return {
      ...s,
      cases: s.cases.map((c) => {
        const mark = cx.binders.length;
        for (const b of c.binds) cx.binders.push(b.name);
        const body = { ...c.body, stmts: expandStmts(c.body.stmts, cx, depth) };
        cx.binders.length = mark;
        return { ...c, body };
      }),
      fallback: s.fallback === null ? null
        : { ...s.fallback, stmts: expandStmts(s.fallback.stmts, cx, depth) },
    };
    case 'ExprStmt': {
      const e = s.expr;
      if (!isNode(e) || e.kind !== 'Call' || !isNode(e.callee) || e.callee.kind !== 'Name') return s;
      const t = cx.defs.get(e.callee.name);
      if (t === undefined) return s;
      return expandCall(t, e, cx, depth);
    }
    default: return s;
  }
}

/**
 * 一处调用点展开成一格 `{ … }`。
 *
 * 裹一层块是**故意**的：模板体里 `let` 出来的东西不该漏到调用处（omni 的 `let` 是块作用域，
 * `check.js` 的 `block()` 给每一格开一层 Scope）。要往外写东西只能通过形参那几个洞。
 */
function expandCall(t, call, cx, depth) {
  const diags = cx.diags;
  if (depth > MAX_DEPTH) {
    diags.error(call.span, `模板展开套了 ${MAX_DEPTH} 层还没停 —— 有个模板在调自己`
      + '（直接或者绕一圈）。模板不是函数，展开是编译期做完的，所以它不能递归');
    return { kind: 'Block', stmts: [], span: call.span };
  }
  if (call.args.length !== t.params.length) {
    diags.error(call.span, `模板 '${t.name}' 要 ${t.params.length} 个实参`
      + `（${t.params.map((p) => p.name).join(' ')}），给了 ${call.args.length} 个`);
    return { kind: 'Block', stmts: [], span: call.span };
  }
  for (const a of call.args) {
    if (a.name !== null) {
      diags.error(a.span, `模板 '${t.name}' 的洞是按位置替的，不认命名实参（'${a.name}='）`);
      return { kind: 'Block', stmts: [], span: call.span };
    }
  }
  /* 定义期绑到模块级变量的那几格：调用处要是遮住了它，**报**。
   * Nim 那边靠"自由名字在定义处解析成符号"做到不遮；我们的检查器给遮蔽的声明不改名
   * （`check.js` 的 `Scope.declare` 原名入表），所以那条路这儿走不通 —— 静默取错那一个
   * 是最坏的一种，所以摆在明面上报。 */
  for (const g of t.globals) {
    if (cx.inFunc) {
      diags.error(call.span, `模板 '${t.name}' 的体引用了模块级变量 '${g}'，而这处调用在函数体里`
        + ' —— omni 的顶层语句是合成入口函数的局部，函数体看不见它们');
      return { kind: 'Block', stmts: [], span: call.span };
    }
    if (cx.binders.includes(g)) {
      diags.error(call.span, `调用处有一个局部 '${g}'，会遮住模板 '${t.name}' 的体在定义处`
        + '绑到的模块级变量 —— 这一格还没接（要做到不遮，得给检查器加一趟 alpha 改名：'
        + '遮蔽的声明现在原名入表）。换个局部名字，或者把这处调用挪出那一层');
      return { kind: 'Block', stmts: [], span: call.span };
    }
  }
  INST = INST + 1;
  const args = call.args.map((a) => a.expr);
  const stmts = t.body.stmts.map((s) => subst(s, t, args, INST, diags));
  /* 展开出来的东西里还可能有别的模板调用（模板调模板）—— 再走一遍。 */
  return { kind: 'Block', stmts: expandStmts(stmts, cx, depth + 1), span: call.span };
}

/** 这个模块顶层都有哪些名字：变量一张表（模板体里的自由名字要绑到它们），别的一张表。 */
function moduleNames(decls) {
  const vars = new Set();
  const names = new Set();
  for (const d of decls) {
    if (d.kind === 'VarDecl') for (const x of d.decls) vars.add(x.name);
    else if (d.kind === 'EnumDecl') {
      names.add(d.name);
      for (const v of d.variants) names.add(v.name);
    } else if (typeof d.name === 'string') names.add(d.name);
  }
  return { vars, names };
}

/** 展开完之后还剩下的模板调用 —— 那只可能在表达式位置上。明着报，别让检查器去报"没这个函数"。 */
function checkNoLeftover(decls, defs, diags) {
  walk(decls, (n) => {
    if (n.kind === 'Call' && isNode(n.callee) && n.callee.kind === 'Name' && defs.has(n.callee.name)) {
      diags.error(n.span, `模板 '${n.callee.name}' 只能在**语句位置**上展开（一行 `
        + `\`${n.callee.name}(…);\`）—— 它的体是一串语句，塞不进表达式。这一格还没接`
        + '（要接得让模板体只有一格表达式，见 ADR-0037 §8）');
    }
    return true;
  });
}

/**
 * 顶层入口：`template …` 收起来、从 decls 里摘掉，剩下的树里把调用点全展开。
 *
 * `on` = `#lang` 那一格开关（ADR-0037 的 D2：模板宏跟 `#lang` 一起开）。关着的时候见到
 * `template …` **当场报**并给出开法 —— 与 `#lang` 那一行同一条纪律。
 *
 * 一份文件里没有模板时**原样返回那棵树**（同一个对象），所以这一格对现有语料是逐字节中性的：
 * 一次遍历都不做。
 */
export function expandTemplates(ast, diags, on) {
  const tpls = ast.decls.filter((d) => d.kind === 'TemplateDecl');
  if (tpls.length === 0) return ast;
  if (on !== true) {
    diags.error(tpls[0].span, '`template …` 这一格默认关着 —— 它与 `#lang` 同一格开关'
      + '（ADR-0037）。开法：加 `--lang-directive`，或 `OMNI_LANG_DIRECTIVE=1`');
    return ast;
  }
  checkNoGensym(ast.decls, diags);
  if (diags.hasErrors()) return ast;
  const defs = new Map();
  for (const t of tpls) {
    if (defs.has(t.name)) {
      diags.error(t.span, `模板 '${t.name}' 重复定义`);
      continue;
    }
    t.globals = new Set();
    defs.set(t.name, t);
  }
  /* 定义期那一趟放在收齐顶层名字**之后**：'这个自由名字是不是模块级变量'这一问要整份模块的
   * 表才答得了（与模板写在文件哪儿无关）。 */
  const mod = moduleNames(ast.decls);
  for (const t of defs.values()) bindDef(t, mod, diags);
  if (diags.hasErrors()) return ast;
  const cx = { defs, diags, binders: [], inFunc: false };
  const out = [];
  for (const d of ast.decls) {
    if (d.kind === 'TemplateDecl') continue;
    if (d.kind === 'FuncDecl') {
      cx.inFunc = true;
      out.push({ ...d, body: { ...d.body, stmts: expandStmts(d.body.stmts, cx, 0) } });
      cx.inFunc = false;
      continue;
    }
    if (d.kind === 'ClassDecl') {
      cx.inFunc = true;
      out.push({
        ...d,
        methods: d.methods.map((m) => ({ ...m, body: { ...m.body, stmts: expandStmts(m.body.stmts, cx, 0) } })),
      });
      cx.inFunc = false;
      continue;
    }
    /* 顶层语句：这一层的声明是**模块级**的，不进 `cx.binders`（模板体绑到的就是它们）。 */
    out.push(expandStmt(d, cx, 0));
  }
  checkNoLeftover(out, defs, diags);
  return { ...ast, decls: out };
}

/** 一棵树上所有的节点走一遍（只读）。`f` 回 false 就不往这一格里面走。 */
function walk(n, f) {
  if (Array.isArray(n)) {
    for (const it of n) walk(it, f);
    return;
  }
  if (!isNode(n)) return;
  if (typeof n.kind === 'string' && f(n) === false) return;
  for (const k of Object.keys(n)) {
    if (isSpanKey(k)) continue;
    walk(n[k], f);
  }
}

/** `名_gensymN` —— 换名之后那一格叫什么（与 sexpr/template.js 同一个形状，理由见那儿）。 */
const gensym = (nm, inst) => `${nm}_gensym${inst}`;

/**
 * 模板体里的绑定器分两类：
 *   * `gensym`：`let`/`var` 声明、`for (var x in …)` 的循环变量 —— 展开期换名的就是这些
 *   * `opaque`：lambda 形参、match 的 case 绑定 —— 它们由那个构造自己绑住，不会捕获调用处的
 *     名字，所以原样留着（不换名也不报"自由"）
 */
function collectBinders(body) {
  const gen = new Set();
  const opaque = new Set();
  walk(body, (n) => {
    if (n.kind === 'VarDecl') {
      for (const d of n.decls) gen.add(d.name);
    } else if (n.kind === 'ForIn') {
      gen.add(n.varName);
    } else if (n.kind === 'Lambda') {
      for (const p of n.params) opaque.add(p.name);
    } else if (n.kind === 'Match') {
      for (const c of n.cases) for (const b of c.binds) opaque.add(b.name);
    }
    return true;
  });
  return { gen, opaque };
}

/**
 * 体里出现的每一个**变量位置**上的名字走一遍。
 *
 * `Call` 的被调者那一格要挑一下：`f(1)` 里的 `f` 是函数名字空间的（omni 的函数与变量是两张
 * 表），不该按变量去查；但它**是形参**的时候要替（`template apply(f, x) { f(x); }`）。
 */
function scanNames(n, env, onName) {
  if (Array.isArray(n)) {
    for (const it of n) scanNames(it, env, onName);
    return;
  }
  if (!isNode(n)) return;
  if (n.kind === 'Name') { onName(n); return; }
  if (n.kind === 'Call' && isNode(n.callee) && n.callee.kind === 'Name'
    && !env.params.includes(n.callee.name) && !env.gen.has(n.callee.name)) {
    scanNames(n.args, env, onName);
    return;
  }
  for (const k of Object.keys(n)) {
    if (isSpanKey(k)) continue;
    scanNames(n[k], env, onName);
  }
}

/** 源码里不许自己出现 `_gensym数字`：那是换名用的形状，撞上就不是卫生了。 */
function checkNoGensym(decls, diags) {
  const bad = (nm, sp) => diags.error(sp, `名字 '${nm}' 撞上了模板换名用的形状（\`_gensym数字\`）`
    + '—— 换个名字（那一格是展开期发的，见 hir/template.js）');
  walk(decls, (n) => {
    if (typeof n.name === 'string' && /_gensym[0-9]/.test(n.name)) bad(n.name, n.span);
    if (typeof n.varName === 'string' && /_gensym[0-9]/.test(n.varName)) bad(n.varName, n.varSpan ?? n.span);
    return true;
  });
}

/**
 * **定义期那一趟**（`semtempl.nim` 的 `semTemplBody`）。
 *
 * 走一遍模板体，把名字分清：形参（展开期按位置替）、体里的局部（展开期换名）、
 * **模块级变量**（记进 `t.globals` —— 调用处要是有同名局部，展开期当场报）、
 * 函数 / 类型 / 内建（原样留着，那是另一张表）、剩下的**当场报**。
 *
 * 为什么这一趟要在定义处做而不是留到调用处：这正是 Nim 那句"自由标识符在定义处解析成
 * nkSym"。留到调用处的话"模板体看见什么"就取决于谁调它，那就不是卫生了。
 */
function bindDef(t, mod, diags) {
  const b = collectBinders(t.body);
  t.locals = b.gen;
  const env = { params: t.params.map((p) => p.name), gen: b.gen };
  for (const l of b.gen) {
    if (env.params.includes(l)) {
      diags.error(t.span, `模板 '${t.name}' 的体里有一个局部与形参同名（'${l}'）——`
        + '这一格还没接（要分清得给体记一张作用域栈，Nim 那边是 openScope/closeScope）');
      return;
    }
  }
  scanNames(t.body, env, (n) => {
    const nm = n.name;
    if (env.params.includes(nm) || b.gen.has(nm) || b.opaque.has(nm)) return;
    if (mod.vars.has(nm)) { t.globals.add(nm); return; }
    if (mod.names.has(nm) || BUILTIN_FUNCS.has(nm)) return;
    diags.error(n.span, `模板 '${t.name}' 的体里引用了 '${nm}'，它既不是形参、也不是体里`
      + '声明的局部、也不是这个模块顶层的名字 —— 模板体里的自由名字要在**定义处**就查得到'
      + `（Nim 那边这是 semtempl 那一趟做的事）。这个模板的形参是 (${env.params.join(' ')})`);
  });
}

/**
 * **展开期那一趟**（`evaltempl.nim` 的 `evalTemplateAux`）：一次展开一张替换表。
 *
 * 形参 -> 实参那棵树（深拷）、要换名的局部 -> `名_gensymN`。`N` 是这次展开的号，所以
 * 同一个模板展开两次，两次的局部名不同。
 */
function subst(n, t, args, inst, diags) {
  if (Array.isArray(n)) return n.map((it) => subst(it, t, args, inst, diags));
  if (!isNode(n)) return n;
  if (n.kind === 'Name') {
    const i = t.params.findIndex((p) => p.name === n.name);
    if (i >= 0) return copy(args[i]);
    if (t.locals.has(n.name)) return { ...n, name: gensym(n.name, inst) };
    return { ...n };
  }
  const out = {};
  for (const k of Object.keys(n)) out[k] = isSpanKey(k) ? n[k] : subst(n[k], t, args, inst, diags);
  /* 声明与循环变量的**名字那一格**是字符串，不是 Name 节点 —— 也要换（它是同一格局部）。 */
  if (n.kind === 'VarDecl') {
    out.decls = n.decls.map((d, j) => (t.locals.has(d.name)
      ? { ...out.decls[j], name: gensym(d.name, inst) }
      : out.decls[j]));
  }
  if (n.kind === 'ForIn' && t.locals.has(n.varName)) out.varName = gensym(n.varName, inst);
  /* 形参在**赋值位置**上（swap 那种）：实参必须是个能赋值的东西。让检查器去报的话报的是
   * 形状（"cannot assign to ..."），说不到"这是模板的哪个洞"上，所以这儿明着报。 */
  if (n.kind === 'Assign' || n.kind === 'IncDec') {
    const tgt = out.target;
    const was = n.target;
    if (isNode(was) && was.kind === 'Name' && t.params.some((p) => p.name === was.name)
      && !(isNode(tgt) && (tgt.kind === 'Name' || tgt.kind === 'Member' || tgt.kind === 'Index'))) {
      diags.error(was.span, `模板 '${t.name}' 把形参 '${was.name}' 用在赋值位置上，`
        + '所以那一格的实参必须是一个变量（或字段 / 下标）');
    }
  }
  return out;
}
