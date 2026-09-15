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
//
// 第五刀（记录 / 列表两批落地之后再量一遍）又删掉三类：
//   3. **算符那八行**：`&&`/`||` 走 branch、别的查表落 prim、查不到当场报 ——
//      七门语言各抄一遍。现在是一格 `binOf`，留给语言的只有"它的表 / 它把与或写成什么 /
//      交值还是交真假"三样。顺带删掉两处冗余：`concat` 那个特判与 `bin('concat', …)`
//      本来就是同一格节点（nim 与 freebasic 各写过一遍）。
//   4. **`return` 与 `if` 那两句**：`retOf`（0/1/N 个值 —— N 个走 `values`）与
//      `branchOf`（`else` 可有可无那句 spread），七门各一遍。
//   5. **datum 那几个小函数**：chez 与 sbcl 原来各抄一份 `head`/`text`/`symName`/`asList`，
//      lua 也抄了一份 `isList`/`tag`/`kids`/`leaf` —— 全部改成用这儿的。
// 量出来的：九份映射 1460 -> 1357 行，这一份 +36。

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

/**
 * **转换名的公共表**：左边是各门语言写的名字，右边是 `conv` 那格附属 `to` 的四种取值。
 * 量过一遍才这么写的：go / V / nim / mojo / freebasic 的转换在树上**全是"调用"的形状**
 * （`int(x)` / `f64(x)` / `CInt(x)` / `Int(x)`）—— 所以"这是调用还是转换"只能靠一张
 * **名字表**分，而那张表是**语言的事**。公共的只有 `int` / `float` / `str` / `bool` 四格。
 */
export const CONV_COMMON = new Map([
  ['int', 'int'], ['float', 'float'], ['str', 'str'], ['bool', 'bool'],
]);

/** 一门语言的转换表 = 公共表 + 它自己那几格（`convs({ f64: 'float', i64: 'int' })`）。 */
export const convs = (delta = {}) => new Map([...CONV_COMMON, ...Object.entries(delta)]);

/** 切片那一格：**上界不含、下标 0 起**（各语言的差别由它自己的映射摆平）。 */
export const sliceOf = (obj, from, to) => node('slice', {
  obj, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
});

/** `conv` 那一格：目标是附属，值是端口。 */
export const convOf = (to, value) => node('conv', { value }, { to });

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
        body,
        post: [incr(name, step)],     // 步进走 `post` 端口 —— `continue` 时照跑
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
  const loop = node('loop', {
    cond: cond ?? lit(true),
    body,
    ...(post.length === 0 ? {} : { post }),   // 步进走 `post` 端口（continue 时照跑）
  });
  return init.length === 0 ? loop : node('region', { body: [...init, loop] });
}

/** `break` / `continue` —— **一格节点两个 kind**（五栏逐格相同，差的只有跳到哪儿）。 */
export const loopExit = (kind) => node('loop-exit', {}, { kind });

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
 * **一格二元算符**。七门语言原来各写一遍这八行，内容九成相同：
 * `&&` / `||`（写法各家不同）走 `branch`（第二个操作数 lazy），别的查表落 `prim`，
 * 查不到当场报。留给语言的只有三样：它的算符表、它把"与/或"写成什么、交值还是交真假。
 *
 * @param {string} opText 树上那个算符的原文
 * @param {any} a 左边（已经出好的节点）
 * @param {any} b 右边
 * @param {Map<string,string>} table 那门语言的算符表（`ops(delta)` 出来的）
 * @param {{lang?: string, and?: string[], or?: string[], keepValue?: boolean}} how
 */
export function binOf(opText, a, b, table, how = {}) {
  const t = String(opText);
  if ((how.and ?? ['&&']).includes(t)) return lazyAnd(a, b, { keepValue: how.keepValue === true });
  if ((how.or ?? ['||']).includes(t)) return lazyOr(a, b, { keepValue: how.keepValue === true });
  const o = table.get(t);
  if (o === undefined) throw new Error(`${how.lang ?? '?'}->graph: 这个算子还没接：${t}`);
  return bin(o, a, b);
}

/**
 * **一格返回**：0 个值 -> 空的 `ret`、1 个 -> 直接给、N 个 -> 一格 `values`（多值的生产侧）。
 * 七门语言同一句话。
 */
export const retOf = (vals) => node('ret', vals.length === 0 ? {} : {
  value: vals.length === 1 ? vals[0] : node('values', { args: vals }),
});

/**
 * **一格分支**：`else` 那一格可有可无（没有就不连那条边 —— 端口是 optional 的）。
 * 七门语言原来各写一遍那句 `...(els === undefined ? {} : { else: … })`。
 */
export const branchOf = (cond, then, els) => node('branch', {
  cond, then, ...(els === undefined || els === null ? {} : { else: els }),
});

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

/**
 * **列表与下标那三格的搭法**（go / lua / V / nim 四门共用）。
 * `index` 交进来时**已经是 0 起的**（lua 减那一格由 lua 的映射自己做）。
 */
export const listNew = (items) => node('list-new', { items });
export const indexGet = (obj, idx) => node('index-get', { obj, index: idx });
export const indexSet = (obj, idx, value) => node('index-set', { obj, index: idx, value });

export function destructure(names, value, { declare = true, tmp = '__mv' } = {}) {
  const holder = `${tmp}${names.join('$')}`;
  const out = [node('bind', { init: value }, { name: holder, keepMulti: true })];
  names.forEach((nm, i) => {
    const got = node('pick', { from: node('ref', {}, { name: holder }) }, { index: i });
    out.push(declare ? node('bind', { init: got }, { name: nm }) : node('set', { value: got }, { name: nm }));
  });
  return out;
}
