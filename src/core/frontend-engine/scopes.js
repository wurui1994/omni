// src/core/frontend-engine/scopes.js —— 作用域图上的一次查名（ADR-0029 的 L3）
//
// 查名这件事在 `lower.js` 里是一段 40 行的字符串手术（`resolve`）：从当前那层往外退、
// 体外方法那一层、基类那一层、`using namespace` 那张表 —— 四种"往哪儿看"混在一个函数里，
// 而**次序**（谁先谁后）与**歧义规则**（同一类里撞了第二格才算歧义）藏在控制流里。
//
// 这一份把那两件事拿出来当**数据**：
//
//   path      一串惰性的候选作用域 `{label, ns}` —— 次序就是它的顺序（jancy 的次序是
//             "自己那条链 → 体外那一层 → 基类 → using 表"，见 NamespaceMgr::findItem 与
//             Namespace::findItemTraverse）。谁生成它是**语言**的事。
//   ambigOn   哪几类边上要查歧义。jancy 只在 using 那一类上报歧义：链上找着就赢，
//             两张 using 表里都有才叫撞了（jnc_ct_Parser.cpp:987 那张表）。
//
// 于是"C++ 的查名与 jancy 的差在哪"有了可写下来的答案：差在 `path` 的次序与 `ambigOn`，
// 而不是差在另写一个 40 行的函数。这就是 R2（binding-as-data）那一条要的东西。

/** 四类边。语言可以只用其中几类，也可以自己加（label 只是个记号）。 */
export const LEX = 'LEX';   // 词法上往外一层（namespace / 类体 / 块）
export const EXT = 'EXT';   // 体外写的成员：它的签名也在那个类那一层里查
export const INH = 'INH';   // 基类那一层
export const IMP = 'IMP';   // `using namespace X;` 塞进来的那一层

/**
 * 一次查名的**通用**形状：候选作用域各自回答"这个名字在你这儿是什么"。
 *
 * 为什么要这一层：两门语言"作用域长什么样"差得很远 —— jancy 的一层是**名字前缀**
 * （`a$b$S`，所以问法是"拼出来的全名在不在那张表里"），GLSL 的一层是**一张 Map**
 * （块作用域一层层往里，外面还有 const / global / uniform / in / out / 内建那几档）。
 * 差的只是"怎么问一层"，而"顺着次序问下去、第一个答上的赢、同类里撞了第二个才算歧义"
 * 是同一句话。所以让每一步自己带 `get`，次序与歧义规则留在这儿。
 *
 * @param {string} name
 * @param {object} q
 *   - path: Iterable<{label, get(name) -> entry|undefined, ns?, at?}>
 *   - ambigOn / onAmbig: 同 `lookupName`
 * @returns {{label, entry, step}|null} 命中的那一层、它给的东西
 */
export function lookupEntry(name, { path, ambigOn = [], onAmbig = null }) {
  let hit = null;
  const same = (a, b) => (a.ns !== undefined || b.ns !== undefined ? a.ns === b.ns : a === b);
  for (const st of path) {
    const entry = st.get(name);
    if (entry === undefined) continue;
    if (hit === null) {
      hit = { label: st.label, entry, step: st };
      if (!ambigOn.includes(st.label)) return hit;
      continue;
    }
    if (st.label === hit.step.label && !same(st, hit.step) && onAmbig !== null) {
      onAmbig(name, hit.step, st);
    }
  }
  return hit;
}

/**
 * 一次查名：顺着 `path` 走，**第一格命中的赢**。
 *
 * 这一层是给"作用域 = 名字前缀"那种语言的（jancy）：`join(ns, name)` 拼出全名、
 * `has(full)` 问在不在。它就是 `lookupEntry` 的一个特例。
 *
 * @param {string} name 源码里写的那个名字（已经归一成语言自己的键）
 * @param {object} q
 *   - path: Iterable<{label, ns, at?}>  候选作用域（惰性最好：命中就不必再算下去）
 *   - has(full): boolean                那个全名在不在
 *   - join(ns, name): string            一层与一个名字怎么拼成全名
 *   - ambigOn: string[]                 哪几类边要查歧义（默认一类都不查）
 *   - onAmbig(name, first, other)       撞了怎么记（默认不记）
 * @returns {string|null} 命中的全名
 */
export function lookupName(name, {
  path, has, join, ambigOn = [], onAmbig = null,
}) {
  const steps = (function* wrap() {
    for (const st of path) {
      yield { ...st, get: (nm) => { const f = join(st.ns, nm); return has(f) ? f : undefined; } };
    }
  }());
  const hit = lookupEntry(name, { path: steps, ambigOn, onAmbig });
  return hit === null ? null : hit.entry;
}

/**
 * 最常见的那种 `path` 的一段：**一层层往外退**。
 * `out(ns)` 回上一层（回 `null` 表示到顶了）—— 泛型实例那种"名字里有分隔符但不是一层"
 * 的情况由语言在 `out` 里处理（jnc 的 instNs 就是它）。
 */
export function* lexChain(from, out, label = LEX) {
  let p = from;
  for (;;) {
    yield { label, ns: p };
    const nx = out(p);
    if (nx === null) return;
    p = nx;
  }
}
