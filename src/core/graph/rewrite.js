// src/core/graph/rewrite.js —— **第二层：图 → 图的改写**
//
// 两层变换模型的第二层（第一层是 `.mapping` 的 CST → 图）：
//
//   第一层  CST 标签 → 图节点。**无条件**：一个标签一条规则，不查任何表。
//   第二层  图节点 → 图节点。**查上下文**：语义分析的结果在这儿用。
//
// 为什么要分两层（这是整份设计的支点）：
//
// `t.a` 在 lua 里落 `field-get` 还是 `map-get`，取决于 `t` 被怎么用过 —— 那是
// **lua 的 table 既是数组又是字典**这条语义的复杂度，不是 `dot` 这个 CST 标签的复杂度。
// 混在第一层就等于给每个标签的规则加一个 `if`，而"规则里有条件"正是 DSL 在漏的样子
// （`docs/design/when-sexpr.md` 教训二）。
//
// 分开之后：
//   * 第一层是一张**纯表**（没有 native、没有逃逸口）
//   * 第二层是一串**图模式 → 图模式**的改写，它操作的是 28 格节点，不是各门语言的树
//
// 纪律：这一份**只走图**，不认识任何一门语言的记号（与 fromtree.js 同一条）。
// 谁要改写成什么，由那门语言的规则表说（`rules` 那个参数）。

/**
 * 一条改写规则。
 *
 * @typedef {object} Rule
 * @property {string} op     只看这一种节点（先按 op 过一遍，省得每条规则都扫全图）
 * @property {function} when (node, ctx) => boolean —— 这一格要不要改
 * @property {function} make (node, ctx) => node    —— 改成什么
 * @property {string} why    这条规则为什么存在（判据：没有理由的规则不许存在）
 */

/**
 * 按规则改写一张图，**自底向上**（孩子先改完，父亲才看得到改完的样子）。
 *
 * 为什么是自底向上：`t.a.b` 里 `t.a` 先落成 `map-get`，`.b` 那一层才能问
 * "我的 obj 是一格 map-get 吗"。反过来（自顶向下）那一问的答案还没出来。
 *
 * @param {any} x      一格节点 / 一格字面量 / 一串（图上三种引用都收）
 * @param {Rule[]} rules
 * @param {object} ctx 语义分析的结果（MAPS / PRIM / VARTYPE …），规则自己去查
 */
export function rewrite(x, rules, ctx) {
  if (x === null || x === undefined) return x;
  if (Array.isArray(x)) return x.map((y) => rewrite(y, rules, ctx)).flat();
  if (x.lit !== undefined) return x;            // 字面量没有孩子
  if (x.op === undefined) return x;             // 不是节点（span / 别的附属）

  // 一·先改孩子（自底向上的那一半）
  const ins = {};
  for (const [k, v] of Object.entries(x.ins)) ins[k] = rewrite(v, rules, ctx);
  const cur = { ...x, ins };

  // 二·再看这一格自己。**第一条命中的规则说了算**（有序选择，与解析那一侧同一条）
  for (const r of rules) {
    if (r.op !== cur.op) continue;
    if (!r.when(cur, ctx)) continue;
    // 改完之后**不再对同一格重跑规则表**：改写要停得下来，所以一格只改一次。
    // 要连着改两步就写两条规则（第二条匹配第一条的产物）—— 那样次序是写出来的，不是撞出来的。
    return r.make(cur, ctx);
  }
  return cur;
}

/** 一整张图（`program()` 出来那个 `{kind:'graph', body}`）。 */
export function rewriteGraph(g, rules, ctx) {
  if (g === null || g === undefined || g.kind !== 'graph') return g;
  return { ...g, body: rewrite(g.body, rules, ctx) };
}

/**
 * 判据：每条规则都要有 `why`。
 * 没有理由的改写就是"撞出来的"，那种规则会在下一次改动里悄悄失效。
 */
export function checkRules(rules) {
  const bad = [];
  for (const [i, r] of rules.entries()) {
    if (typeof r.op !== 'string') bad.push(`第 ${i} 条没有 op`);
    if (typeof r.when !== 'function') bad.push(`第 ${i} 条（${r.op}）没有 when`);
    if (typeof r.make !== 'function') bad.push(`第 ${i} 条（${r.op}）没有 make`);
    if (typeof r.why !== 'string' || r.why.length === 0) {
      bad.push(`第 ${i} 条（${r.op}）没有 why —— 没有理由的改写规则不许存在`);
    }
  }
  if (bad.length > 0) throw new Error(`rewrite 规则表不合规：\n  ${bad.join('\n  ')}`);
  return rules;
}
