// src/core/graph/fromtree.js —— **"树 -> 图"的公共零件**（九门语言的映射共用）
//
// 这一份是"逐步减少冗余"的第二刀，删的是**映射层的重复**。九份 `ext/*/tograph.js` 写完
// 之后，一眼能数出来的重复有两类：
//
//   1. **走树的那几个小函数**：`isList` / `tag` / `kids` / `leaf` / `part` / `unquote`
//      —— 九份各抄一遍，而且抄错过一次（无名表的孩子是全部 items，不是 items.slice(1)：
//      mojo 与 nim 都踩了）。抄九遍的东西只该有一份。
//   2. **同一个形状的组合**：六门语言的 `for i = a to b` 都落成
//      "region + bind + loop + set"、四门的 `+=` 都落成 "set + bin"、七门的 `&&`/`||`
//      都落成"第二个操作数是 lazy 的 branch"。**这些不是节点，是节点的固定搭法** ——
//      写九遍就有九处会走样。
//
// 纪律：这一份**只出图**，不认识任何一门语言的记号。谁的树长什么样，是那门语言自己的事。

import { node, lit, bin } from './graph.js';

// ---- 走树（具体语法那一族：`(tag 孩子…)`）---------------------------------------

export const isList = (x) => x !== null && x !== undefined && x.kind === 'list';
/** 一格节点的标签（头上那个 atom）。无名表返回 null —— 那是"一组东西"，不是一格节点。 */
export const tag = (x) => (isList(x) && x.items[0]?.kind === 'atom' ? x.items[0].value : null);
export const kids = (x) => (isList(x) ? x.items.slice(1) : []);
/**
 * 叶子的值。叶子有两种 kind：`atom`（记号文本）与 `string`（解过转义的串值，语法动作里
 * 写的 `"+"` 也是它）—— 只认 `atom` 的话 `(bin "+" …)` 里那个算符就成了 null。踩过一次。
 */
export const leaf = (x) => (x === null || x === undefined || x.kind === 'list' ? null : x.value);
/** 按标签找一格部件（`(sig …)` / `(body …)` / `(params …)` 那种）。 */
export const part = (x, name) => kids(x).find((y) => tag(y) === name);
export const partKids = (x, name) => { const p = part(x, name); return p === undefined ? [] : kids(p); };
/**
 * 一"组"东西的孩子。**无名表的孩子是全部 items**（`(sig ((p …) (p …)))` 里那层）——
 * 少这一条，每个函数的第一个形参会被当成标签吃掉。mojo 与 nim 都踩过，所以它在这儿。
 */
export const groupItems = (g) => (tag(g) === null && isList(g) ? g.items : kids(g));
/** 记号文本里的引号剥掉（freebasic / mojo / nim 的串字面量带引号）。 */
export const unquote = (s) => (typeof s === 'string' && s.length >= 2 && (s[0] === '"' || s[0] === "'")
  ? s.slice(1, -1) : s);

// ---- 走树（datum 那一族：`(sym x)` / `(num 1)` —— chez 与 sbcl 共用）-------------

export const head = (x) => (isList(x) && x.items[0]?.kind === 'atom' ? x.items[0].value : null);
/** `(sym x)` / `(num 1)` 那种"标签 + 一格叶子"的取值。 */
export const text = (x) => (isList(x) && x.items.length > 1 ? leaf(x.items[1]) : null);
export const symName = (x) => (head(x) === 'sym' ? text(x) : null);
/** 一格 datum 是不是表（`(list …)`）；是就交出它的元素。 */
export const asList = (x) => (head(x) === 'list' ? kids(x) : null);

// ---- 算符名的公共表（第九门语言加进来时，这一格只该写"它自己那几格"）------------

/**
 * **算符名的公共表**：左边是各门语言的写法，右边是 `prims.js` 里那格内建的名字。
 * 七门语言原来各抄一遍这张表，抄的内容九成相同 —— 相同的那九成放这儿。
 * 注意 `==` -> `=`：**内建那一格的名字只有一个**（`=`），语言写法有几种是语言的事。
 */
export const OPS_COMMON = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='],
  ['==', '='], ['!=', '!='],
]);

/** 一门语言的算符表 = 公共表 + 它自己那几格（`ops({ '~=': '!=', '..': 'concat' })`）。 */
export const ops = (delta = {}) => new Map([...OPS_COMMON, ...Object.entries(delta)]);

// ---- 固定搭法（**不是节点** —— 是节点的组合，只写一遍）--------------------------

/**
 * **计数循环**：`for i = from to/while cond … next`。六门语言（lua / go / vlang / awk /
 * freebasic / sbcl 的 dotimes）都是这一个形状 —— 一格 region 装着"起始的 bind"、
 * 一格 loop，步进那一格 set 缀在体的最后。
 *
 * @param {{name: string, from: any, cond: any, step?: any, body: any[]}} spec
 *   `cond` 由调用方给（`i <= n` / `i < n` 的差别是那门语言的事，不是这儿的）
 */
export function counted({ name, from, cond, step, body }) {
  return node('region', {
    body: [
      node('bind', { init: from }, { name }),
      node('loop', {
        cond,
        body: [...body, incr(name, step)],
      }),
    ],
  });
}

/** `i++` / `i--` / 步进一格：落成 `set` + 一格算符。三门语言（go / vlang / awk）用它。 */
export function incr(name, by = lit(1), op = '+') {
  return node('set', { value: bin(op, node('ref', {}, { name }), by ?? lit(1)) }, { name });
}

/**
 * **三段式 `for`**：`for (init; cond; post) body`。go / vlang / awk 三门同一个形状 ——
 * 一格 region 装着 init 与 loop，post 缀在体的最后。`for {}`（没有条件）也走它。
 *
 * 与 `counted` 的差别：那一格的步进由名字与步长算出来（真的计数循环），
 * 这一格的 post 是**任意语句**（`i++`、`i += 2`、几条一起）。
 */
export function threePart({ init = [], cond, post = [], body }) {
  const loop = node('loop', { cond: cond ?? lit(true), body: [...body, ...post] });
  return init.length === 0 ? loop : node('region', { body: [...init, loop] });
}

/** `a op= b` 就是 `a = a op b`。四门语言（awk / freebasic / mojo / nim）用它。 */
export function augset(name, op, value) {
  return node('set', { value: bin(op, node('ref', {}, { name }), value) }, { name });
}

/**
 * `&&` / `||`：**第二个操作数是 lazy**，所以它们落 `branch` 而不是算符。
 * 七门语言都要这一条，而且各语言"交出来的是值还是真假"不同 ——
 * lua 的 `a and b` 交的是**值**（那笔账是 `ext/lua/SPEC.md` L-007），
 * go 的交的是 bool。差别只在 `else` 那一支给什么，所以两种都在这儿。
 */
export const lazyAnd = (a, b, { keepValue = false } = {}) => node('branch', {
  cond: a, then: b, else: keepValue ? a : lit(false),
});
export const lazyOr = (a, b, { keepValue = false } = {}) => node('branch', {
  cond: a, then: keepValue ? a : lit(true), else: b,
});

/** `else` 那一格常是个包装（`(else (block …))`）—— go / vlang / awk 三处同一个坑。 */
export const elseOf = (x) => (x === undefined || x === null ? undefined
  : (tag(x) === 'else' ? kids(x)[0] : x));

/**
 * **多值的消费侧**：`x, y := f()` / `local a, b = f()` / `(multiple-value-bind …)`。
 *
 * N 个名字对 1 个右值 ⇒ 一格临时 `bind` 装住那格多值，再一串 `pick` 各取一格。
 * 五门语言（lua / go / vlang / nim / sbcl）是同一个形状，所以它在这儿只写一遍。
 * N 对 N（`a, b = 1, 2`）不走这儿 —— 那是各配一格，语言映射自己配。
 *
 * @param {string[]} names 左边那几个名字
 * @param {any} value 右边那**一格**（多值的生产者，通常是一格 call）
 * @param {{declare?: boolean, tmp?: string}} opts declare = 是声明（bind）还是赋值（set）
 */
/**
 * **记录那三格的搭法**（go / lua / V / nim 四门共用）。字段名是**附属**不是端口 ——
 * 所以建节点这一句四门语言完全相同，各语言只剩"我的树里哪个标签是字段访问"要自己说。
 *
 * @param {Array<[string, any]>} pairs 字段名 × 已经出好的值节点
 */
export const recordNew = (pairs) => node(
  'record-new',
  { fields: pairs.map(([, v]) => v) },
  { names: pairs.map(([k]) => k) },
);
export const fieldGet = (obj, name) => node('field-get', { obj }, { field: name });
export const fieldSet = (obj, name, value) => node('field-set', { obj, value }, { field: name });

export function destructure(names, value, { declare = true, tmp = '__mv' } = {}) {
  const holder = `${tmp}${names.join('$')}`;
  const out = [node('bind', { init: value }, { name: holder, keepMulti: true })];
  names.forEach((nm, i) => {
    const got = node('pick', { from: node('ref', {}, { name: holder }) }, { index: i });
    out.push(declare ? node('bind', { init: got }, { name: nm }) : node('set', { value: got }, { name: nm }));
  });
  return out;
}
