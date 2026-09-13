// ext/lua/scope.js —— 作用域：**每个节点一条"配方"**，查名借 src/core 的那台机器
//
// 配方（`steps`）是一串小步，只有四种词：
//
//   'open'          开一层新作用域（往后的步骤都在里面）
//   'bind:<洞名>'   把那一格的名字绑进**当前**这层
//   '<洞名>'        走那一格（递归）
//   'inline:<洞名>' 走那一格的 block，但**不让它自己开一层**（`repeat…until` 那条例外用它）
//
// Lua 的全部作用域规矩就是这几条配方（DESIGN.md 第 4 节的五条，一条一行）：
//
//   local            ['init', 'bind:names']        —— 右边先算，所以 `local x = x` 的右边是外层那个
//   local function   ['bind:names', 'body']        —— 先绑名字再算体（递归要它）
//   funcbody         ['open', 'bind:names', 'body']—— 形参绑在函数那一层
//   for-num/for-in   [...表达式, 'open', 'bind:names', 'body'] —— 循环变量只在体里
//   repeat           ['open', 'inline:body', 'cond'] —— until 看得见 body 里的 local（唯一的例外）
//
// 没写配方的节点：按 `syn` 的次序走它的洞 —— **不是特例，是默认值**。
//
// 查名用 `src/core/frontend-engine/scopes.js` 的 `lookupEntry` + `lexChain`：候选作用域
// 一层层往外，每层自己答（`get`）。Lua 里"找不着"不是错，是一次全局表查（5.2 的说法：
// `_ENV.x`），所以链末尾挂一层 `ENV`，这一格也是数据（`fallback`）。

import { lookupEntry, lexChain, LEX } from '../../src/core/frontend-engine/scopes.js';

/** 每个节点的配方。只有这七个节点有话说，其余按 syn 次序走。 */
export const SCOPE = {
  block: { steps: ['open', 'stats'] },
  funcbody: { steps: ['open', 'bind:names', 'body'] },
  local: { steps: ['init', 'bind:names'] },
  'local-function': { steps: ['bind:names', 'body'] },
  'for-num': { steps: ['from', 'to', 'step', 'open', 'bind:names', 'body'] },
  'for-in': { steps: ['exprs', 'open', 'bind:names', 'body'] },
  repeat: { steps: ['open', 'inline:body', 'cond'] },
  // `function a.b:m()` 的隐形形参 self —— Lua 的 `:` 就是糖，这一格记它是糖的代价。
  function: { steps: ['path', 'body'], selfIn: 'body' },
  // gsl-shell 的 `|x| e` 与 funcbody 同形（形参绑在自己那一层，体是一格表达式）。
  lambda: { steps: ['open', 'bind:names', 'body'] },
};

/**
 * **上下文规则**（第二类"位置"约束）。生成器一量就把它们逼出来了 —— 先前 `break` 与
 * `goto L` 我都收，luajit 说 `no loop to break` / `undefined label 'L'`。两条都不是语法，
 * 是**位置**：于是写成节点上的一格数据，不写在检查器的分支里。
 *
 *   provides   这个节点给后代提供什么上下文
 *   blocks     这个节点**挡住**哪些上下文（函数体挡 loop：循环里嵌个函数，函数里 break 不行）
 *   needs      这个节点要哪种上下文，没有就是一条错
 *   declares   标签是**第二个名字空间**：`label` 声明它
 *   needsLabel `goto` 查它 —— 可见范围到函数边界为止（Lua 5.2 §3.3.4）
 */
export const CTX = {
  while: { provides: 'loop' },
  repeat: { provides: 'loop' },
  'for-num': { provides: 'loop' },
  'for-in': { provides: 'loop' },
  // 函数体挡住 loop，也挡住 vararg —— 除非它自己的形参表里有 `...`（那它自己提供）。
  funcbody: { blocks: ['loop', 'vararg'], provides: (n) => ((n.names ?? []).includes('...') ? 'vararg' : null) },
  lambda: { blocks: ['loop', 'vararg'], provides: (n) => ((n.names ?? []).includes('...') ? 'vararg' : null) },
  break: { needs: 'loop', say: '这儿没有循环可 break' },
  // `...` 只能出现在变长参数的函数里（主 chunk 本身就是变长的，Lua 5.1 手册 §2.5.9）。
  // 这一条是 `--luajit` 那把尺子逼出来的：`|| -> ...` 我先前收，luajit 说
  // `cannot use '...' outside a vararg function`。
  vararg: { needs: 'vararg', say: "这个函数没有 `...` 形参，用不了 `...`" },
  label: { declares: 'label' },
  goto: { needsLabel: true },
};

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
    for (const nm of names ?? []) {
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
    const rule = SCOPE[node.kind];
    const ctxRule = CTX[node.kind] ?? {};
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
      if (p !== null && p !== undefined) ctx = new Set([...ctx, p]);
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
