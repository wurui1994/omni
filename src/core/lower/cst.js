// src/core/lower/cst.js —— **走具体语法树的那几个小函数**（ADR-0044，正本在这儿）
//
// 这几格原来长在 `src/core/graph/fromtree.js` 里（"树 -> 图"的公共零件）。它们与图**没有
// 关系** —— 认的是 GLR 出来的那棵树（`(tag 孩子…)`），出的是名字与孩子。adapter
// （CST → 标准 IR）要用的正是它们，而图那一层按 ADR-0044 是要拆掉的，所以正本搬到这儿，
// 旧址改成 re-export（与上一笔 sx.js / place.js / int.js / fmt.js 同一条办法）。
//
// 抄错过的那两处留在注释里，别再踩：
//   * 无名表的孩子是**全部 items**，不是 `items.slice(1)`（mojo 与 nim 都踩过）；
//   * 叶子有两种 kind（`atom` 与 `string`），只认 `atom` 的话 `(bin "+" …)` 里那个算符是 null。

export const isList = (x) => x !== null && x !== undefined && x.kind === 'list';
/** 一格节点的标签（头上那个 atom）。无名表返回 null —— 那是"一组东西"，不是一格节点。 */
export const tag = (x) => (isList(x) && x.items[0]?.kind === 'atom' ? x.items[0].value : null);
export const kids = (x) => (isList(x) ? x.items.slice(1) : []);
/** 叶子的值（`atom` 是记号文本、`string` 是解过转义的串值 —— 两种都要认）。 */
export const leaf = (x) => (x === null || x === undefined || x.kind === 'list' ? null : x.value);
/** 按标签找一格部件（`(sig …)` / `(body …)` / `(params …)` 那种）。 */
export const part = (x, name) => kids(x).find((y) => tag(y) === name);
export const partKids = (x, name) => { const p = part(x, name); return p === undefined ? [] : kids(p); };
/** 一"组"东西的孩子。**无名表的孩子是全部 items**（见文件头那条教训）。 */
export const groupItems = (g) => (tag(g) === null && isList(g) ? g.items : kids(g));
/** 记号文本里的引号剥掉（freebasic / mojo / nim 的串字面量带引号）。 */
export const unquote = (s) => (typeof s === 'string' && s.length >= 2 && (s[0] === '"' || s[0] === "'")
  ? s.slice(1, -1) : s);

// ---- 走树（datum 那一族：`(sym x)` / `(num 1)` —— 两门 Lisp 共用）-----------------
//
// Scheme 与 Common Lisp 的语法只出 datum（`ext/chez/chez.grammar` 12 条产生式），
// 于是"哪个 datum 是 `if`、哪个是调用"在那门语言的 adapter 里说 —— 这几格是走 datum 的手。

export const head = (x) => (isList(x) && x.items[0]?.kind === 'atom' ? x.items[0].value : null);
/** `(sym x)` / `(num 1)` 那种"标签 + 一格叶子"的取值。 */
export const text = (x) => (isList(x) && x.items.length > 1 ? leaf(x.items[1]) : null);
export const symName = (x) => (head(x) === 'sym' ? text(x) : null);
/** 一格 datum 是不是表（`(list …)`）；是就交出它的元素。 */
export const asList = (x) => (head(x) === 'list' ? kids(x) : null);
