// src/core/frontend-engine/syntax.js —— `syn` 的词汇：**一个节点的具体语法怎么写成数据**
//
// 这一份与任何具体语言无关（ADR-0030 第 2 节）。一个节点的 `syn` 是一串项，只有六种：
//
//   '字面记号'        照原样要一个记号
//   h(洞, 类别)       一个洞（默认 `exp` 类）
//   l(洞, 类别, …)    一串同类的洞（`sep` / `alt` / `trail` / `min` 说分隔符与个数）
//   nm(名字表)        一串**名字**（绑定用；`vararg` 时末尾可以是 `...`）
//   w(裸名字)         一个裸名字（不是绑定也不是表达式：`a.b` 的 `b`、`goto l` 的 `l`）
//   opt(…) / rep(…)   可选组、重复组
//
// 另外三种"叶子/算符"项由语言自己写在表里：`{t:'name'|'number'|'string', as:'字段'}`、
// `{o:'op'}`（算符那一格）、`{b:'字段'}`（一串语句）。
//
// 解析器（parse-driver.js）读它认，写回器（render.js）读它写 —— **一份数据两个方向用**。

// ── `syn` 里的词汇（构造器，读起来短一点）────────────────────────────────────
/** 一个洞：`h('cond')` 默认 `exp` 类。 */
export const h = (name, cls = 'exp', extra = {}) => ({ h: name, cls, ...extra });
/** 一串同类的洞，逗号分隔（`min:0` 允许空）。 */
export const l = (name, cls = 'exp', extra = {}) => ({
  l: name, cls, sep: ',', min: 1, ...extra,
});
/** 一串**名字**（绑定用；`vararg:true` 时末尾可以是 `...`）。 */
export const nm = (name, extra = {}) => ({ n: name, sep: ',', min: 1, ...extra });
/** 一个**裸名字**（不是绑定，也不是表达式：`a.b` 的 `b`、`goto l` 的 `l`）。 */
export const w = (name) => ({ w: name });
/** 可选组：下一个记号对得上组里第一项就取。 */
export const opt = (...items) => ({ opt: items });
/** 重复组（0 次或多次）：组里的洞各自收成数组。 */
export const rep = (...items) => ({ rep: items });


/** 扁平地看一个节点的洞（含可选组/重复组里的）。 */
export function holesOf(node) {
  const out = [];
  const walk = (items, inOpt, inRep) => {
    for (const it of items) {
      if (typeof it === 'string') continue;
      if (it.opt !== undefined) { walk(it.opt, true, inRep); continue; }
      if (it.rep !== undefined) { walk(it.rep, inOpt, true); continue; }
      if (it.h !== undefined) out.push({ name: it.h, cls: it.cls, list: false, opt: inOpt, rep: inRep, only: it.only });
      else if (it.l !== undefined) out.push({ name: it.l, cls: it.cls, list: true, min: it.min, opt: inOpt, rep: inRep });
    }
  };
  walk(node.syn, false, false);
  return out;
}

