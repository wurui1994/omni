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
    const path = (function* steps() {
      for (const st of chain(scope)) {
        yield { label: st.label, ns: st.ns, get: (nm) => st.ns.names.get(nm) };
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
  root.labels = new Set();

  const open = (parent, why) => newScopeAt(parent, why);

  const bindNames = (names, scope, node) => {
    /* 那一格里怎么读出名字：语言不说就当它本来是一串名字（读表那条腿的形参表就是）；
       说了就照它读（拼法在 `.grammar` 里的语言那一格是棵子树）。 */
    const list = lang.namesOf === undefined ? names : lang.namesOf(names);
    for (const nm of list ?? []) {
      if (nm === '...') continue;                    // 变长参数不是个名字，别占格
      scope.names.set(nm, { name: nm, scope: scope.id, node });
      decls.push({ name: nm, scope: scope.id, node });
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
      if (step === 'open') { cur = open(cur, node.kind); continue; }
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
  walkHole(ast.stats, root, { ctx: new Set(['vararg']) });

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
