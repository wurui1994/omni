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
//
// **正本在 `src/core/lower/cst.js`**（ADR-0044）：这几格与图没有关系 —— 认的是 GLR 出来的
// 那棵树，而 adapter（CST → 标准 IR）要用的正是它们，图那一层按 ADR-0044 要拆掉。
// 这儿留一层转口，旧的 import 路径一处都不用改。
//
// **一条 import + 一条光秃秃的 export**，不是 `export … from`：这份文件自己也要用
// `isList` / `tag` / `kids` / `leaf`，而两条都写就是同一格名字进来两遍 —— 单体 HTML 那个
// 打包器把两种形状都摊成 `const { … } = __req(…)`，于是拼出来的文件当场
// `Identifier 'isList' has already been declared`（`tests/studio/run.js` 量出来的）。
import {
  isList, tag, kids, leaf, part, partKids, groupItems, unquote,
  head, text, symName, asList,
} from '../lower/cst.js';

export {
  isList, tag, kids, leaf, part, partKids, groupItems, unquote,
  head, text, symName, asList,
};

// ---- 走树（datum 那一族：`(sym x)` / `(num 1)`）—— 正本也在 lower/cst.js -----------

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
  /* **位运算那四格**（2026-09-18）：符号在 go / V / cpp / freebasic 那几门里一模一样，
     所以放公共表；图上那格内建叫 `band` / `bor` / `shl` / `shr`（**不能用符号** ——
     `^` 在图上早就是幂，见 `prims.js` 那一段）。
     `^` 与 `~` 不在这儿：go 的 `^` 是 xor、V 的 `^` 是幂、C 家族的 `~` 是取反 ——
     那三格各归各门语言的 delta。 */
  ['&', 'band'], ['|', 'bor'], ['<<', 'shl'], ['>>', 'shr'],
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

/**
 * **断言**那一格：条件一个端口、那句话一个端口。
 *
 * 为什么不是 `prim`：`prim` 的实参是一串，分不出"哪个是条件、哪个是话"（`nodes.js` 里
 * `assert` 那一格的注释写了全部三条理由）。两门语言（V 与 mojo）共用这一行。
 */
export const assertOf = (cond, msg) => node('assert', {
  cond, ...(msg === undefined || msg === null ? {} : { msg }),
});

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
 * **数字字面量当条件**：`while (1)` / `if (0)`。
 *
 * 这一格的答案在编译期就定了（C 家族与 awk 都是"非零为真"），所以落成一格 **bool 字面量**
 * —— 那是这几门语言的真值观在这一处的**准确**样子，不是猜。
 *
 * **变量当条件不在这儿**：那要按类型说（C 是 `!= 0`、awk 的串是 `!= ""`、lua 里 0 是真），
 * 而图上没有类型 —— 所以那一格留给各门自己的映射（能定的补一格比较，定不了的当场报），
 * 这一格只管"字面量"这一档。收在这儿而不是抄两遍：cpp 与 awk 的 `while (1)` 是同一件事。
 */
export const truthyLit = (c) => {
  if (c !== null && c !== undefined && typeof c.lit === 'number') return lit(c.lit !== 0);
  if (c !== null && c !== undefined && c.op === 'const' && typeof c.attrs?.value === 'number') {
    return lit(c.attrs.value !== 0);
  }
  return c;
};

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
 * @param {boolean} [byval] 值语义（go 的 struct）还是引用语义（lua/js 的表）
 * @param {Array<any>} [fzero] 每格字段**声明的零值**（类型覆盖层 #40）。只在那一格的值是
 *   **空引用**时才用得上 —— 空引用自己说不出类型，而 go 的 `Material{…, nil}` 里那个
 *   nil 是一格接口，后端要靠它算字段类型（`(fnty …)` 那张表），不然同一个结构体会算出
 *   两格形状。不需要的那几格给 `null`；整份都不需要就别传（attrs 上也不出现）。
 */
export const recordNew = (pairs, byval, fzero) => node(
  'record-new',
  { fields: pairs.map(([, v]) => v) },
  {
    names: pairs.map(([k]) => k),
    ...(byval === true ? { byval: true } : {}),
    ...(Array.isArray(fzero) && fzero.some((z) => z !== null && z !== undefined)
      ? { fzero } : {}),
  },
);
export const fieldGet = (obj, name) => node('field-get', { obj }, { field: name });
export const fieldSet = (obj, name, value) => node('field-set', { obj, value }, { field: name });

/**
 * **列表与下标那三格的搭法**（go / lua / V / nim 四门共用）。
 * `index` 交进来时**已经是 0 起的**（lua 减那一格由 lua 的映射自己做）。
 *
 * `listNew` 的第二个实参 `elem` 是**声明的元素类型**，拿"它的零值"那格节点带着 ——
 * 空列表（`var xs []T`）的元素类型只能从声明来，见 nodes.js 上 `list-new` 那段话。
 */
export const listNew = (items, elem) => node(
  'list-new',
  { items },
  elem === undefined || elem === null ? {} : { elem },
);
export const indexGet = (obj, idx) => node('index-get', { obj, index: idx });
export const indexSet = (obj, idx, value) => node('index-set', { obj, index: idx, value });

/**
 * **map / dict 那四格的搭法**（go / V 的 `map[K]V{…}`、awk 的关联数组、nim 的 `Table`）。
 * 键与值各一格 rest 端口 —— 交替表要靠"偶数格是键"这种约定，而约定不是端口。
 *
 * @param {Array<[any, any]>} pairs 键 × 值（都已经是出好的节点）
 * @param {any} [kzero] 声明的**键**类型（拿它的零值那格节点带着）
 * @param {any} [vzero] 声明的**值**类型（同上）—— 空字典的类型只能从声明来，
 *   见 nodes.js 上 `map-new` 那段话。与 `listNew` 的 `elem` 是同一条规矩。
 */
export const mapNew = (pairs = [], kzero, vzero) => node('map-new', {
  keys: pairs.map(([k]) => k),
  vals: pairs.map(([, v]) => v),
}, {
  ...(kzero === undefined || kzero === null ? {} : { kzero }),
  ...(vzero === undefined || vzero === null ? {} : { vzero }),
});
export const mapGet = (obj, key) => node('map-get', { obj, key });
export const mapSet = (obj, key, value) => node('map-set', { obj, key, value });
/** 键排成一格列表（**插入序**）—— `for k in m` 那一族的降级靠它，见 `mapForIn`。 */
export const mapKeys = (obj) => node('map-keys', { obj });

/**
 * **`for k[, v] in 一格 map` 落成现成的 counted**（第三十批，三门共用这一份）。
 *
 * 一格新的循环节点都不加：先要一格**键的列表**（`map-keys`），再走列表那条路 ——
 * 于是"遍历"这件事在这一层只有一份降级代码（列表的 for-each 也是 counted）。
 *
 * 三门语言的差别只在**名字给的是什么**，那一格由调用方递进来：
 *   * V   `for k, v in m` —— 第一格键、第二格值（`for k in m` 只有键）；
 *   * go  `for k := range m` / `for k, v := range m` —— 同上；
 *   * nim `for k in t` / `for k, v in t.pairs` —— 同上。
 * 也就是说三门在这一格上**恰好同形**（与列表那一格 go/V 相反不同）—— 所以合成一份。
 *
 * 值那一格走 `map-get`（键一定在，所以缺键报错那条规矩碰不到）。
 * `_` 的那一格不绑名字（三门都用 `_` 表示"不要"）。
 *
 * @param opts `{ subject, keyName, valName, body, mapVar, keysVar, idxVar, cntVar }`
 */
export function mapForIn(opts) {
  const at = (n) => node('ref', {}, { name: n });
  const head = [];
  if (opts.keyName !== undefined && opts.keyName !== null && opts.keyName !== '_') {
    head.push(node('bind', { init: indexGet(at(opts.keysVar), at(opts.idxVar)) },
      { name: opts.keyName }));
  }
  if (opts.valName !== undefined && opts.valName !== null && opts.valName !== '_') {
    /* 值要按**键**取，而键那一格可能没绑名字（`for _, v in m`）—— 所以这儿一律
       从键的列表上现取一次，不依赖 `keyName` 绑上了没有。 */
    head.push(node('bind', { init: node('map-get', { obj: at(opts.mapVar), key: indexGet(at(opts.keysVar), at(opts.idxVar)) }) },
      { name: opts.valName }));
  }
  return node('region', {
    body: [
      node('bind', { init: opts.subject }, { name: opts.mapVar }),
      node('bind', { init: mapKeys(at(opts.mapVar)) }, { name: opts.keysVar }),
      node('bind', { init: node('prim', { args: [at(opts.keysVar)] }, { name: 'len' }) },
        { name: opts.cntVar }),
      counted({
        name: opts.idxVar,
        from: node('const', {}, { value: 0 }),
        cond: node('prim', { args: [at(opts.idxVar), at(opts.cntVar)] }, { name: '<' }),
        body: [node('region', { body: [...head, ...(opts.body ?? [])] })],
      }),
    ],
  });
}
export const mapHas = (obj, key) => node('map-has', { obj, key });

/**
 * **哪些名字装的是 map** —— 一门语言自己的一趟扫查，不是驱动器回问类型。
 *
 * 那笔"要驱动器回问'这名字登记成类型了吗'"的账在 map 这一格上**量出来是不必的**：
 * go 与 V 的 map 字面量自带标记（`map[K]V{…}` 在树上就是 `(lit (map …) …)`），
 * nim 的是 `initTable[…]()`，awk 的所有下标都是关联数组 —— 三种都能在树上认出来。
 * 剩下真要回问的只有 cpp 的"声明还是表达式"与 nim 的 `T(x: 1)` vs `f(x = 1)`。
 *
 * @param {any} x 树（整棵或一块）
 * @param {(node: any) => string|null} isMapBind 一格节点 -> 它绑的 map 名字（不是就给 null）
 */
export function mapNames(x, isMapBind, out = new Set()) {
  if (x === null || x === undefined) return out;
  if (Array.isArray(x)) { for (const y of x) mapNames(y, isMapBind, out); return out; }
  const nm = isMapBind(x);
  if (nm !== null && nm !== undefined) out.add(nm);
  if (isList(x)) for (const y of x.items) mapNames(y, isMapBind, out);
  return out;
}

export function destructure(names, value, { declare = true, tmp = '__mv' } = {}) {
  const holder = `${tmp}${names.join('$')}`;
  const out = [node('bind', { init: value }, { name: holder, keepMulti: true })];
  names.forEach((nm, i) => {
    const got = node('pick', { from: node('ref', {}, { name: holder }) }, { index: i });
    out.push(declare ? node('bind', { init: got }, { name: nm }) : node('set', { value: got }, { name: nm }));
  });
  return out;
}

let deferSeq = 0;

/**
 * **注册那一刻就把实参算掉的出口动作**（go 的 `defer f(x)` 就是这一条）。
 *
 * `scope-exit` 那一格的 `action` 是 lazy 的：动作**整条**在出口才跑 —— CL 的
 * `unwind-protect`、nim 与 V 的 `defer`（它们收的是一整块语句）都正是这个语义。
 * 但 go 不同：`defer fmt.Println(i)` 在**注册那一刻**就把 `i` 算掉了，出口只是调用。
 *
 * **这不需要新节点**（那条账原来记成"要把 action 拆成 callee + args 两格端口"，
 * 量一遍发现拆错了）：用现成的 `bind` + `ref` 就说得清 ——
 * 每个实参先绑到一格新名字（注册点求值，那是 `bind` 的语义），动作里改用 `ref` 那个名字。
 * 于是"什么时候求值"归**语言**，不归节点 —— 与"写法归语言、格子归节点"同一条。
 *
 * 常量不必物化（它没有"什么时候算"的问题）。别的形状（动作不是 `prim` / `call`）
 * 原样留着 —— 那种 `defer` go 里写不出来。
 *
 * @param {any[]} actions 出口要跑的那几格（已经出好的节点）
 * @returns {any[]} `[bind…, scope-exit]` —— 前面几格是注册点的求值
 */
export function deferNow(actions) {
  const pre = [];
  const acts = (Array.isArray(actions) ? actions : [actions]).map((a) => {
    if (a === null || a === undefined || (a.op !== 'prim' && a.op !== 'call')) return a;
    const args = (Array.isArray(a.ins.args) ? a.ins.args : [a.ins.args])
      .filter((y) => y !== undefined)
      .map((y) => {
        if (y === null || y === undefined || y.lit !== undefined || y.op === 'const') return y;
        const nm = `__defer${++deferSeq}`;
        pre.push(node('bind', { init: y }, { name: nm }));
        return node('ref', {}, { name: nm });
      });
    return node(a.op, { ...a.ins, args }, { ...a.attrs });
  });
  return [...pre, node('scope-exit', { action: acts })];
}
