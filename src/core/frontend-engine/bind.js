// src/core/frontend-engine/bind.js —— 作用域与位置：**读表的走一遍**
//
// 与任何具体语言无关（ADR-0030 第 2 节）。语言交两张表：
//
//   lang.scope  每个节点一条**配方**（`steps`），四种词：
//                 'open'          开一层新作用域
//                 'bind:<洞名>'   把那一格的名字绑进**当前**这层
//                 '<洞名>'        走那一格
//                 'inline:<洞名>' 走那一格的 block，但**不让它自己开一层**
//               没写配方的节点：按 `syn` 的次序走它的洞 —— 不是特例，是默认值。
//   lang.ctx    上下文规则：`provides` / `blocks` / `needs` / `declares` / `needsLabel`
//               （"这儿没有循环可 break"、"标签是第二个名字空间"这一类**位置**约束）
//
// 查名用 `scopes.js` 的 `lookupEntry` + `lexChain`：候选作用域一层层往外，每层自己答。
// "找不着"算不算错由语言定 —— Lua 里那是一次全局表查，所以这儿只报 `found: 'ENV'`。

import { lookupEntry, lexChain, LEX } from './scopes.js';
import { holesOf } from './syntax.js';

let seq = 0;

function newScope(parent, why) {
  seq += 1;
  return {
    id: `s${seq}`, parent, why, names: new Map(),
  };
}

/**
 * 走一遍 AST，答：
 *   scopes  全部作用域（`{id, parent, why, names}`）
 *   decls   每个绑定：`{name, scope, node, at}`
 *   uses    每个 `name` 节点查到了哪儿：`{node, name, scope, found, where}`
 *           `found` ∈ 'local' | 'ENV'；`where` 是命中的作用域 id（ENV 时为 null）
 */
export function bind(ast, lang) {
  const scopes = [];
  const decls = [];
  const uses = [];
  const errors = [];
  const gotos = [];
  const root = newScope(null, 'chunk');
  scopes.push(root);

  const chain = (from) => lexChain(
    from,
    (s) => s.parent,
    LEX,
  );

  const lookup = (name, scope) => {
    /* 一层里可能还**接着几层**（基类那一族：`class C: A, B` 查不着就往 A、B 里查）。
       接的是哪几层由 `inherit:` 那一步填在 `s.bases` 里 —— 这一层只管照着走，
       顺带防环（`class A: A` 那种写错的写法不该把驱动器转死）。 */
    const withBases = (s, out = []) => {
      if (out.includes(s)) return out;
      out.push(s);
      for (const b of s.bases ?? []) withBases(b, out);
      return out;
    };
    const path = (function* steps() {
      for (const st of chain(scope)) {
        for (const ns of withBases(st.ns)) {
          yield { label: st.label, ns, get: (nm) => ns.names.get(nm) };
        }
      }
    }());
    return lookupEntry(name, { path });
  };

  const newScopeAt = (parent, why) => {
    const s = newScope(parent, why);
    s.labels = new Set();
    scopes.push(s);
    return s;
  };
  /** 哪个节点开出了哪一层 —— `in-owner:` 要靠它把体外定义接回那个类。 */
  const scopeOf = new Map();
  root.labels = new Set();

  const open = (parent, why) => newScopeAt(parent, why);

  const bindNames = (names, scope, node) => {
    /* 那一格里怎么读出名字：语言不说就当它本来是一串名字（读表那条腿的形参表就是）；
       说了就照它读（拼法在 `.grammar` 里的语言那一格是棵子树）。 */
    const list = lang.namesOf === undefined ? names : lang.namesOf(names);
    for (const nm of list ?? []) {
      if (nm === '...') continue;                    // 变长参数不是个名字，别占格
      /* 同一格声明绑第二遍不再记一笔账：**先收齐再查**的作用域（`hoist:`）会先绑一次，
         走到那条声明时又绑一次 —— 那是一件事，不是两个名字。 */
      const had = scope.names.get(nm);
      scope.names.set(nm, { name: nm, scope: scope.id, node });
      if (had !== undefined && had.node === node) continue;
      decls.push({ name: nm, scope: scope.id, node });
    }
  };

  /**
   * **先收齐再查**：一串声明里每一条声明的名字先全绑进这层，再走它们的体。
   * 类的成员、命名空间与文件顶层的名字都不看先后（jancy 的 declare/compile 两趟）。
   * 怎么知道"这一条声明哪一格是名字"？—— 就看它自己的配方里那几个 `bind:` 步。
   * 配方写了 `through`（一串洞名）的节点是**透明壳**（属性块裹着一条声明那种），穿过去接着收。
   */
  const hoistList = (list, scope) => {
    if (!Array.isArray(list)) return;
    for (const it of list) {
      if (it === null || it === undefined || typeof it !== 'object' || Array.isArray(it)) continue;
      const r = (lang.scope ?? {})[it.kind];
      if (r === undefined) continue;
      for (const st of r.steps ?? []) {
        if (typeof st === 'string' && st.startsWith('bind:')) bindNames(it[st.slice(5)], scope, it);
      }
      for (const h of r.through ?? []) hoistList([it[h]], scope);
    }
  };

  /** 走一格（可能是节点、数组、字符串名字）。 */
  const walkHole = (v, scope, opts = {}) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { for (const x of v) walkHole(x, scope, opts); return; }
    if (typeof v === 'string') return;               // 裸名字（`a.b` 的 b、goto 的标签）
    walk(v, scope, opts);
  };

  function walk(node, scope, opts = {}) {
    if (node.kind === 'name') {
      const hit = lookup(node.value, scope);
      uses.push({
        node,
        name: node.value,
        scope: scope.id,
        found: hit === null ? 'ENV' : 'local',
        where: hit === null ? null : hit.entry.scope,
      });
      return;
    }
    const n = lang.NODE.get(node.kind);
    if (n === undefined) throw new Error(`scope：${lang.name} 里没有节点 ${node.kind}`);
    const rule = (lang.scope ?? {})[node.kind];
    const ctxRule = (lang.ctx ?? {})[node.kind] ?? {};
    let ctx = opts.ctx ?? new Set();

    // 上下文那三格：要什么、提供什么、挡什么 —— 全是表里的数据。
    if (ctxRule.needs !== undefined && !ctx.has(ctxRule.needs)) {
      errors.push({ node, why: ctxRule.say ?? `这儿没有 ${ctxRule.needs} 上下文` });
    }
    if (ctxRule.declares === 'label') scope.labels.add(node.label);
    if (ctxRule.needsLabel === true) gotos.push({ node, scope, label: node.label });
    if (ctxRule.blocks !== undefined) {
      ctx = new Set([...ctx].filter((x) => !ctxRule.blocks.includes(x)));
    }
    if (ctxRule.provides !== undefined) {
      const p = typeof ctxRule.provides === 'function' ? ctxRule.provides(node) : ctxRule.provides;
      /* 一格可以提供**好几种**上下文（`for` 既是"能 break 的地方"又是"能 continue 的地方"）。
         写一个还是写一串都收 —— 这是默认值，不是特例。 */
      if (Array.isArray(p)) ctx = new Set([...ctx, ...p]);
      else if (p !== null && p !== undefined) ctx = new Set([...ctx, p]);
    }
    const down = { ...opts, ctx };
    let cur = scope;

    if (rule === undefined) {                        // 默认：按 syn 的次序走洞
      for (const h of holesInOrder(n)) walkHole(node[h], cur, down);
      return;
    }
    for (const step of rule.steps) {
      if (step === 'open') { cur = open(cur, node.kind); scopeOf.set(node, cur); continue; }
      /* **体外定义接回那个类**（`void C.f() {}` / `C.construct() {}`）：那一格的"东家"是谁由
         `lang.ownerOf` 说（语言自己读，核心不认识限定名这回事）。查着了就把后面几步挪进
         那一层 —— 于是 `open` 开出来的函数层挂在类那一层底下，体里裸写的成员名查得着。
         查不着（东家在别的文件、或者写在这条声明后面）就原地不动 —— 那是一笔账，不是错。 */
      if (step.startsWith('in-owner:')) {
        const owner = lang.ownerOf === undefined ? null : lang.ownerOf(node[step.slice(9)]);
        if (owner !== null && owner !== undefined) {
          const hit = lookup(owner, cur);
          const s = hit === null ? undefined : scopeOf.get(hit.entry.node);
          if (s !== undefined) cur = s;
        }
        continue;
      }
      if (step.startsWith('inherit:')) {
        /* **这一层还往那几层查**（基类）：把那一格里的名字查出来，取它们开出的那一层，
           挂在 `cur.bases` 上。查不着（基类在别的文件）就少挂一层 —— 记账，不报错。 */
        const list = lang.namesOf === undefined
          ? node[step.slice(8)] : lang.namesOf(node[step.slice(8)]);
        for (const nm of list ?? []) {
          const hit = lookup(nm, cur);
          const s = hit === null ? undefined : scopeOf.get(hit.entry.node);
          if (s !== undefined && s !== cur) (cur.bases ??= []).push(s);
        }
        continue;
      }
      if (step.startsWith('hoist:')) {                // 先收齐这一串声明的名字，再走它们的体
        hoistList(node[step.slice(6)], cur);
        continue;
      }
      if (step.startsWith('bind:')) {
        bindNames(node[step.slice(5)], cur, node);
        if (opts.extra !== undefined) bindNames(opts.extra, cur, node);
        continue;
      }
      if (step.startsWith('inline:')) {              // 让 block 的语句长在**这一层**
        const b = node[step.slice(7)];
        walkHole(b?.stats, cur, down);
        continue;
      }
      const child = node[step];
      const extra = rule.selfIn === step && node.method !== undefined ? ['self'] : undefined;
      walkHole(child, cur, extra === undefined ? down : { ...down, extra });
    }
  }

  // chunk 本身是个 block；它的那层已经是 root，所以直接走语句（别再开一层）。
  // 主 chunk 本身是变长参数的函数（Lua 5.1 手册 §2.5.9），所以根上下文带 vararg。
  /* **根那一层也可以有配方**（键写 `'@root'`，洞就是 ast 自己那几格）：文件顶层的名字
     不看先后的语言（jancy、C++ 的命名空间）在这儿写一句 `hoist:stats` 就够了。
     不写配方还是老样子 —— 直接走语句。 */
  const rootRule = (lang.scope ?? {})['@root'];
  const rootOpts = { ctx: new Set(['vararg']) };
  if (rootRule === undefined) walkHole(ast.stats, root, rootOpts);
  else {
    for (const step of rootRule.steps) {
      if (step.startsWith('hoist:')) { hoistList(ast[step.slice(6)], root); continue; }
      walkHole(ast[step], root, rootOpts);
    }
  }

  // 标签是**后判**的：`goto` 可以往前跳（Lua 5.2 §3.3.4），所以走完再解。
  // 可见范围：从自己那层往外，到函数边界（`funcbody` / `lambda` 那层）为止。
  for (const g of gotos) {
    let s = g.scope;
    let ok = false;
    for (;;) {
      if (s.labels?.has(g.label) === true) { ok = true; break; }
      if (s.why === 'funcbody' || s.why === 'lambda' || s.parent === null) break;
      s = s.parent;
    }
    if (!ok) errors.push({ node: g.node, why: `没有能跳到的标签 '${g.label}'` });
  }
  return { scopes, decls, uses, errors };
}

/** 节点的洞名，按 `syn` 次序（含可选组/重复组与名字表/块）。 */
function holesInOrder(n) {
  /* 没有 `syn` 的语言（拼法在 `.grammar` 里的那条腿）按**洞的声明次序**走 ——
     这不是特例，是默认值：表里洞的次序本来就是产生式里子项的次序。 */
  if (n.syn === undefined) return Object.keys(n.holes ?? {});
  const out = [];
  const walkItems = (items) => {
    for (const it of items) {
      if (typeof it === 'string') continue;
      if (it.opt !== undefined) { walkItems(it.opt); continue; }
      if (it.rep !== undefined) { walkItems(it.rep); continue; }
      for (const k of ['h', 'l', 'b']) if (it[k] !== undefined) out.push(it[k]);
    }
  };
  walkItems(n.syn);
  return out;
}
