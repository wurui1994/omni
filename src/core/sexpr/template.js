// src/core/sexpr/template.js —— 卫生模板（ADR-0037 的事情一，**照 Nim 那两趟**）
//
// 参考实现是 Nim 的 `compiler/semtempl.nim` 与 `compiler/evaltempl.nim`（本机
// `~/Documents/Lang/reference/Nim/`）。为什么照它而不照 Racket 的 set-of-scopes：
// Nim 用**两趟**拿到同一份卫生，而这两趟落在我们已有的结构上，不必给每个节点挂一格作用域集、
// 也不必写"子集最大匹配"的解析器。两趟各管一件事：
//
//   一、**定义期**（`bindDef`，对着 `semtempl.nim`）：模板体在**定义处**走一遍。
//       体里 `(let …)` 引入的名字记成「要换名的」（Nim 的 "locals default to 'gensym'"），
//       体里引用的**自由名字在定义处解析**：是模块级变量就当场改写成 `(gvar 名)`
//       —— 那正是 Nim 把自由标识符换成 `nkSym` 的那一手，也是"调用处的同名局部遮不住它"
//       这条性质的全部来源。
//   二、**展开期**（`expandNode`，对着 `evaltempl.nim`）：形参**按位置**替成实参那棵树，
//       要换名的局部换成 `名`gensymN`（`N` 一次展开一个号，就是 Nim 的 `instID`）。
//
// 这门方言让这件事比 Nim 简单的两处（都是**已有**的性质，不是我们省事）：
//   * 变量引用只有 `(var 名)` 一种形状，运算符是 `(bin "+" …)` 里的**字符串** ——
//     所以"模板里的 `+` 被调用处的局部 `+` 遮住"那种事在这门方言里根本表达不出来；
//     同一条性质在这儿的样子是**模块级变量**被局部遮住，判据也就钉在那上头。
//   * 函数名与变量名是两个命名空间（`(call f …)` 只查函数），所以 `(call …)` 不必绑。
//
// 明着不接的两格（报错，不猜）：体里的局部与形参同名、形参出现在赋值位置上而实参不是一个变量。

/** 一次展开一个号（Nim 的 `instID`）。进程内单调递增 —— 同一个模板展开两次名字必须不同。 */
let INST = 0;

const isList = (n) => n !== null && n !== undefined && n.kind === 'list';
const isAtom = (n) => n !== null && n !== undefined && n.kind === 'atom';

function head(n) {
  if (!isList(n) || n.items.length === 0) return null;
  return isAtom(n.items[0]) ? n.items[0].value : null;
}

const atomName = (n) => (isAtom(n) ? n.value : null);

const mkAtom = (value, span) => ({ kind: 'atom', value: value, span: span });
const mkList = (items, span) => ({ kind: 'list', items: items, span: span });

/**
 * `(define-template 名 (形参…) 体…)` 读成一格模板。形状不对就交 null（错已经记在 diags 上）。
 */
function readDef(n, diags) {
  const nm = atomName(n.items[1]);
  const ps = n.items[2];
  if (nm === null || !isList(ps)) {
    diags.error(n.span, '(define-template 名字 (形参...) 体...)');
    return null;
  }
  const params = [];
  for (const p of ps.items) {
    const pn = atomName(p);
    if (pn === null) { diags.error(p.span, '形参只能是一个名字'); return null; }
    if (params.includes(pn)) { diags.error(p.span, `形参 '${pn}' 重复`); return null; }
    params.push(pn);
  }
  const body = n.items.slice(3);
  if (body.length === 0) { diags.error(n.span, `模板 '${nm}' 的体是空的`); return null; }
  return { name: nm, params: params, body: body, locals: new Set(), span: n.span };
}

/** 体里所有 `(let 名 …)` 声明的名字（递归收全）——Nim 的 "locals default to 'gensym'"。 */
function collectLocals(n, out) {
  if (!isList(n)) return;
  if (head(n) === 'let') {
    const nm = atomName(n.items[1]);
    if (nm !== null) out.add(nm);
  }
  for (const it of n.items) collectLocals(it, out);
}

/**
 * **定义期那一趟**（`semtempl.nim` 的 `semTemplBody`）。
 *
 * 走一遍模板体，把三种名字分清，并把**自由名字当场绑到定义处**：
 *   - 形参        原样留着（展开期按位置替）
 *   - 体里的局部  原样留着（展开期换名），名字记进 `t.locals`
 *   - 模块级变量  **当场改写**成 `(gvar 名)` / `(gset 名 值)` —— 这一手是卫生的另一半
 *   - 别的        报错（Nim 那边这一格是 `mixin`：明说"这个名字留到用处再查"，我们还没有）
 */
function bindDef(t, globals, diags) {
  collectLocals(mkList(t.body, t.span), t.locals);
  for (const l of t.locals) {
    if (t.params.includes(l)) {
      diags.error(t.span, `模板 '${t.name}' 的体里有一个局部与形参同名（'${l}'）——`
        + '这一格还没接（要分清得给体记一张作用域栈，Nim 那边是 openScope/closeScope）');
      return;
    }
  }
  t.body = t.body.map((f) => bindNode(f, t, globals, diags));
}

/** 一个名字在模板体里算哪一类。 */
function classify(nm, t, globals) {
  if (t.params.includes(nm)) return 'param';
  if (t.locals.has(nm)) return 'local';
  if (globals.has(nm)) return 'global';
  return 'free';
}

function bindNode(n, t, globals, diags) {
  if (!isList(n)) return n;
  const h = head(n);
  /* `(var 名)`：三类各走一条路。`global` 那一条就是"在定义处绑定"。 */
  if (h === 'var' && n.items.length === 2) {
    const nm = atomName(n.items[1]);
    if (nm !== null) {
      const k = classify(nm, t, globals);
      if (k === 'global') return mkList([mkAtom('gvar', n.items[0].span), n.items[1]], n.span);
      if (k === 'free') {
        diagFree(diags, n, nm, t);
        return n;
      }
      return n;
    }
  }
  /* `(set 名 值)`：目标那一格同上，值那一格照常往下走。 */
  if (h === 'set' && n.items.length === 3) {
    const nm = atomName(n.items[1]);
    if (nm !== null) {
      const k = classify(nm, t, globals);
      const val = bindNode(n.items[2], t, globals, diags);
      if (k === 'global') {
        return mkList([mkAtom('gset', n.items[0].span), n.items[1], val], n.span);
      }
      if (k === 'free') {
        diagFree(diags, n, nm, t);
        return n;
      }
      return mkList([n.items[0], n.items[1], val], n.span);
    }
  }
  return mkList(n.items.map((it) => bindNode(it, t, globals, diags)), n.span);
}

function diagFree(diags, n, nm, t) {
  diags.error(n.span, `模板 '${t.name}' 的体里引用了 '${nm}'，它既不是形参、`
    + '也不是体里 (let …) 声明的局部、也不是模块级变量 —— 模板体里的自由名字要在**定义处**'
    + '就查得到（Nim 那边这是 semtempl 那一趟做的事）。'
    + `这个模板的形参是 (${t.params.join(' ')})`);
}

/**
 * `名_gensymN` —— 换名之后那一格叫什么。
 *
 * Nim 印的是 `` 名`gensymN ``（`evaltempl.nim`），**这门方言不能照抄那个反引号**：
 * 它在 s-expr 的 idchar 表里读得回来，可再往下 js 后端会把 `v_t`gensym1` 发成一段
 * 模板字符串（量到的原话：`SyntaxError: Unexpected template string`），C 后端更不认。
 * 所以挑 `_` —— js 与 C 的标识符里都合法的那一格。
 *
 * 撞名这件事不靠运气：`expandTemplates` 一进门就扫一遍整棵树，源码里自己写了 `_gensym数字`
 * 的话**当场报**（见 `checkNoGensym`）。
 */
const gensym = (nm, inst) => `${nm}_gensym${inst}`;

/** 源码里不许自己出现 `_gensym数字` —— 那是换名用的形状，撞上就不是卫生了。 */
function checkNoGensym(n, diags) {
  if (isAtom(n)) {
    if (/_gensym[0-9]/.test(String(n.value))) {
      diags.error(n.span, `名字 '${n.value}' 撞上了模板换名用的形状（\`_gensym数字\`）——`
        + '换个名字（那一格是展开期发的，见 sexpr/template.js）');
    }
    return;
  }
  if (!isList(n)) return;
  for (const it of n.items) checkNoGensym(it, diags);
}

/** 深拷一棵树：同一个实参可能被替进去**好几处**（`(dbl (var x))` 里 `x` 出现两次），不共享节点。 */
function copy(n) {
  if (!isList(n)) return n;
  return mkList(n.items.map(copy), n.span);
}

/**
 * **展开期那一趟**（`evaltempl.nim` 的 `evalTemplateAux`）。
 *
 * 一次展开一张替换表（Nim 的 `TemplCtx.mapping`）：形参 -> 实参那棵树、
 * 局部 -> `名`gensymN`。`N` 是这次展开的号，所以同一个模板展开两次，两次的局部名不同。
 */
function substitute(n, t, args, inst, diags) {
  if (!isList(n)) return n;
  const h = head(n);
  if (h === 'var' && n.items.length === 2) {
    const nm = atomName(n.items[1]);
    if (nm !== null && t.params.includes(nm)) return copy(args[t.params.indexOf(nm)]);
    if (nm !== null && t.locals.has(nm)) {
      return mkList([n.items[0], mkAtom(gensym(nm, inst), n.items[1].span)], n.span);
    }
    return n;
  }
  /* `(let 名 类型 初值)` 与 `(set 名 值)` 的**名字那一格**也要换（它是同一格局部）。 */
  if ((h === 'let' || h === 'set') && n.items.length >= 3) {
    const nm = atomName(n.items[1]);
    const rest = n.items.slice(2).map((it) => substitute(it, t, args, inst, diags));
    if (nm !== null && t.locals.has(nm)) {
      return mkList([n.items[0], mkAtom(gensym(nm, inst), n.items[1].span), ...rest], n.span);
    }
    /* 形参在**赋值位置**上（`swap!` 那种）：实参必须是一个变量，不然赋给谁都说不清。
     * Nim 那边这一格由"模板体在定义处 sem 过"兜住，这门方言没有类型，所以在这儿明着报 ——
     * 比让 `(set (var a) …)` 那种坏形状漏到降级器去报好（那时报的是形状，不是原因）。 */
    if (nm !== null && h === 'set' && t.params.includes(nm)) {
      const a = args[t.params.indexOf(nm)];
      const an = head(a) === 'var' ? atomName(a.items[1]) : null;
      if (an === null) {
        diags.error(a.span, `模板 '${t.name}' 把形参 '${nm}' 用在赋值位置上，`
          + '所以那一格的实参必须是一个变量（写成 (var 名字)）');
        return n;
      }
      return mkList([n.items[0], mkAtom(an, a.span), ...rest], n.span);
    }
    return mkList([n.items[0], n.items[1], ...rest], n.span);
  }
  return mkList(n.items.map((it) => substitute(it, t, args, inst, diags)), n.span);
}

/** 展开一层套一层的上限。到顶就报 —— 一个模板调自己（直接或绕一圈）是写错了，不是慢。 */
const MAX_DEPTH = 64;

/** 一棵树上所有的模板调用点都展开（自底向上：先把实参里的展开，再展开这一层）。 */
function expandNode(n, defs, diags, depth) {
  if (!isList(n)) return n;
  if (depth > MAX_DEPTH) {
    diags.error(n.span, `模板展开套了 ${MAX_DEPTH} 层还没停 —— 有个模板在调自己`
      + '（直接或者绕一圈）。模板不是函数，展开是编译期做完的，所以它不能递归');
    return n;
  }
  const items = n.items.map((it) => expandNode(it, defs, diags, depth));
  const h = isAtom(items[0]) ? items[0].value : null;
  const t = h === null ? undefined : defs.get(h);
  if (t === undefined) return mkList(items, n.span);
  const args = items.slice(1);
  if (args.length !== t.params.length) {
    diags.error(n.span, `模板 '${t.name}' 要 ${t.params.length} 个实参`
      + `（${t.params.join(' ')}），给了 ${args.length} 个`);
    return mkList(items, n.span);
  }
  INST++;
  const forms = t.body.map((f) => substitute(f, t, args, INST, diags));
  /* 体只有一格就原地替进去（表达式位置也能用）；好几格就裹一层 `(do …)` —— 那是这门方言里
   * "一串语句当一格"的写法。 */
  const one = forms.length === 1 ? forms[0] : mkList([mkAtom('do', n.span), ...forms], n.span);
  /* 展开出来的东西里还可能有别的模板调用（模板调模板）——再走一遍。 */
  return expandNode(one, defs, diags, depth + 1);
}

/**
 * 顶层入口：`(define-template …)` 收起来、从模块里摘掉，剩下的树里把调用点全展开。
 *
 * `on` = `#lang` 那一格开关（ADR-0037 的 D2：模板宏跟 `#lang` 一起开）。关着的时候
 * 见到 `(define-template …)` **当场报**并给出开法 —— 与 `#lang` 那一行同一条纪律。
 *
 * 一份文件里没有模板时**原样返回那棵树**（同一个对象），所以这一格对现有的 `.sx` 是
 * 逐字节中性的：一次遍历都不做。
 */
export function expandTemplates(nodes, diags, on) {
  const mod = nodes.length === 1 && head(nodes[0]) === 'module' ? nodes[0] : null;
  const items = mod === null ? nodes : nodes[0].items.slice(1);
  let any = false;
  for (const it of items) {
    if (head(it) === 'define-template') { any = true; break; }
  }
  if (!any) return nodes;
  if (on !== true) {
    const first = items.find((it) => head(it) === 'define-template');
    diags.error(first.span, '(define-template …) 这一格默认关着 —— 它与 `#lang` 同一格开关'
      + '（ADR-0037）。开法：加 `--lang-directive`，或 `OMNI_LANG_DIRECTIVE=1`');
    return nodes;
  }
  const defs = new Map();
  const globals = new Set();
  const kept = [];
  for (const it of items) checkNoGensym(it, diags);
  if (diags.hasErrors()) return nodes;
  for (const it of items) {
    const h = head(it);
    if (h === 'global') {
      const nm = atomName(it.items[1]);
      if (nm !== null) globals.add(nm);
      kept.push(it);
      continue;
    }
    if (h !== 'define-template') { kept.push(it); continue; }
    const t = readDef(it, diags);
    if (t === null) continue;
    if (defs.has(t.name)) {
      diags.error(it.span, `模板 '${t.name}' 重复定义`);
      continue;
    }
    defs.set(t.name, t);
  }
  /* 定义期那一趟：**每个模板各走一遍自己的体**。放在收齐 `global` 之后 ——
   * "自由名字是不是模块级变量"这一问要整份模块的表才答得了（与模板写在文件哪儿无关）。 */
  for (const t of defs.values()) bindDef(t, globals, diags);
  if (diags.hasErrors()) return nodes;
  const out = kept.map((it) => expandNode(it, defs, diags, 0));
  if (mod === null) return out;
  return [mkList([nodes[0].items[0], ...out], nodes[0].span)];
}



