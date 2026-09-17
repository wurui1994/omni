// ext/go/tograph.js —— **Go 的树 -> 节点图**（第三个前端，同一张 13 格节点清单）
//
// 三门语言对着看，这一步的意义才完整：Scheme 只有 datum、Lua 是具体语法、Go 是
// 静态类型 + 分号自动插入的语言 —— **树差得越远，落到的节点越是同一批**。
//
// Go 这一份多出来的两格"约定"，都不是节点的事，写在这儿：
//   * **类型全丢掉**（`(sig (in (p (tname int) (name n))) (out (tname int))`）：
//     type 是端口的 sort，不是图上的格子（`src/core/graph/nodes.js` 文件头第一条）。
//     这一批只取形参**名字**；类型要用起来是 `carry` 那一问的事（契约 §6）。
//   * **入口是 `main`**：图从上到下跑，所以映射末尾显式补一格 `call main` ——
//     那是这门语言的约定，不是新节点。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  tag, kids, leaf, part, partKids, threePart, elseOf,
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, lazyOr, counted,
  destructure, recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet, sliceOf, deferNow,
  mapNew, mapGet, mapSet, mapHas, mapNames, isList,
} from '../../src/core/graph/fromtree.js';

/**
 * 装 map 的那些名字（一趟扫查填好，见 goToGraph）。
 * `m[k]` 与 `xs[i]` 在树上同形 —— 分开它们靠的不是驱动器回问类型，是**字面量自带标记**。
 */
const MAPS = new Set();
const isMap = (x) => tag(x) === 'name' && MAPS.has(leaf(kids(x)[0]));

/** 一格 `(define (lhs (name m)) (rhs (lit (map …) …)))` -> `'m'`（不是就给 null）。 */
function mapBindName(x) {
  if (!isList(x) || (tag(x) !== 'define' && tag(x) !== 'assign')) return null;
  const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
  const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
  for (let i = 0; i < lhs.length; i++) {
    const r = rhs[i];
    if (r !== undefined && tag(r) === 'lit' && tag(kids(r)[0]) === 'map' && tag(lhs[i]) === 'name') {
      return leaf(kids(lhs[i])[0]);
    }
  }
  return null;
}


/**
 * 一格 `(spec (names a b) 类型? (init …))` 里**装 map 的那几个名字**。
 *
 * `mapBindName` 那一格只认 `:=` 与 `=`，而 `var m = map[K]V{…}` / `var m map[K]V` 是
 * 另一条产生式 —— 漏了它，后面 `m[k]` 就会静静落成列表下标（**答案错而不报**）。
 * 声明这一格比赋值还清楚：**类型写着 map 的时候连字面量都不必看**。
 */
function specMapNames(x) {
  const nm = part(x, 'names');
  if (nm === undefined) return [];
  const names = kids(nm).map(leaf);
  const ty = kids(x).find((y) => tag(y) !== 'names' && tag(y) !== 'init');
  if (ty !== undefined && tag(ty) === 'map') return names;
  const ini = part(x, 'init');
  if (ini === undefined) return [];
  const rhs = kids(ini);
  return names.filter((n, i) => {
    const r = rhs[i];
    return r !== undefined && tag(r) === 'lit' && tag(kids(r)[0]) === 'map';
  });
}


/**
 * **方法名 -> 它声明的接收者类型名**，以及**登记过的类型名**。
 *
 * 两张表都是一趟扫查得的（见 goToGraph），存在的理由是同一句话：
 * go 的接收者写在声明里（`func (p Point) total() int`），所以分派是**单态的** ——
 * 图上不需要运行期查表，方法就是"名字从声明来 + 接收者当第一格实参"。
 * 重名（两个类型各有一个 `total`）要类型才分得开，这一批**当场报**，不猜。
 */
const METHODS = new Map();
const TYPES = new Set();

/**
 * 扫一遍顶层：登记类型名（`type Point struct …`）、每个方法的接收者类型，
 * 以及 `var` / `const` 里**装 map 的名字**（`specMapNames` 那段说了为什么要在这儿收）。
 */
function collectDecls(x) {
  if (!isList(x)) return;
  if (tag(x) === 'tspec' || tag(x) === 'talias') TYPES.add(leaf(kids(x)[0]));
  if (tag(x) === 'spec') for (const n of specMapNames(x)) MAPS.add(n);
  if (tag(x) === 'method') {
    const [recv, nm] = kids(x);
    const name = leaf(nm);
    const ty = part(kids(recv)[0], 'tname');
    const owner = ty === undefined ? '?' : leaf(kids(ty)[0]);
    const had = METHODS.get(name);
    if (had !== undefined && had !== owner) {
      throw new Error(`go->graph: ${had} 与 ${owner} 都声明了方法 ${name} —— `
        + '重名要类型才分得开，这一批不猜');
    }
    METHODS.set(name, owner);
  }
  for (const k of kids(x)) collectDecls(k);
}

const OPS = ops();
/** 转换名 -> `conv` 的目标。go 的定宽整数与浮点各自那几格都往这四格收。 */
const CONV = convs({
  int8: 'int', int16: 'int', int32: 'int', int64: 'int',
  uint: 'int', uint8: 'int', uint16: 'int', uint32: 'int', uint64: 'int',
  float32: 'float', float64: 'float', string: 'str',
});
/** `fmt.Println` / `println` / `print` 都落 `prim print`（**print 不是节点**）。 */
const PRINTS = new Set(['Println', 'Printf', 'Print', 'println', 'print']);

const many = (xs) => xs.map(toNode).flat();

/**
 * `var x int` 那一格的**零值**：go 里"什么都没写时它是几"。
 *
 * 这**不是**类型进图了 —— 图上落的仍是一格 `const`，只是"落几"这句话由 go 说。
 * 定宽整数那一族全收 0、`float64` 走一格 `conv float`（图上没有类型，那格转换正是
 * "这个 0 是实数"唯一说得出口的地方）、指针 / 切片 / map / 通道 / 接口是 nil。
 * 具名结构体的零值**当场报**：它是"每个字段各自的零值"，而字段表按约定不进图。
 */
const INT_TYPES = new Set(['int', 'int8', 'int16', 'int32', 'int64', 'rune', 'byte',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr']);
const NIL_TYPES = new Set(['ptr', 'slice', 'map', 'chan', 'chan-send', 'chan-recv',
  'fntype', 'interface']);
const NIL_NAMES = new Set(['error', 'any']);

function zeroOf(ty, name) {
  if (ty === undefined) {
    throw new Error(`go->graph: ${name} 既没类型也没初值 —— go 不许这么写`);
  }
  const t = tag(ty);
  if (t === 'paren') return zeroOf(kids(ty)[0], name);
  if (NIL_TYPES.has(t)) return lit(null);
  if (t === 'tname' && kids(ty).length === 1) {
    const n = leaf(kids(ty)[0]);
    if (INT_TYPES.has(n)) return lit(0);
    if (n === 'float32' || n === 'float64') return convOf('float', lit(0));
    if (n === 'string') return lit('');
    if (n === 'bool') return lit(false);
    if (NIL_NAMES.has(n)) return lit(null);
    throw new Error(`go->graph: ${n} 的零值还没接 —— 具名类型要字段表才写得出来`);
  }
  throw new Error(`go->graph: 这一格的零值还没接：${t}`);
}

/**
 * **`iota` 当下的值**（一格 const 组里"这是第几条 spec"）。
 *
 * 组外是 null —— 那时 `iota` 就是个普通名字（go 自己也是这样：它只在 const 里有意义）。
 * 拿一格模块变量记这个状态，与 `MAPS` / `METHODS` 同一条路子：**扫查得的上下文**。
 */
let IOTA = null;

/** `_` 是 go 的空位：**不绑名字**，但初值里的作用（调用）要留下。 */
function bindName(n, v) {
  if (n === '_') return v.op === 'call' || v.op === 'prim' ? [v] : [];
  return [node('bind', { init: v }, { name: n })];
}

/** 一格 spec 的名字表对初值表：数目相等就逐个绑，N 对 1 是多值，没初值就落零值。 */
function specBinds(names, exprs, ty) {
  if (exprs === null) return names.flatMap((n) => bindName(n, zeroOf(ty, n)));
  if (names.length > 1 && exprs.length === 1) {
    return destructure(names, toNode(exprs[0]), { declare: true });
  }
  if (names.length !== exprs.length) {
    throw new Error(`go->graph: ${names.length} 个名字对 ${exprs.length} 个初值 —— 这一批不猜`);
  }
  return names.flatMap((n, i) => bindName(n, toNode(exprs[i])));
}

/**
 * `var` / `const` -> 一串 **bind**（没有 decl 节点，那句话在 `define` 那一格已经说过）。
 *
 * 两条 go 自己的规矩在这儿摆平，都不是图的事：
 *   * **const 组里省略初值 = 重复上一条**（`k1` / `k2` 抄 `k0 = iota` 那一句）；
 *   * **`iota` 是这一条 spec 在组里的序号** —— 所以重复的那几条各拿自己的号。
 * `var` 没有这两条（go 里 `var` 的 spec 省了初值就是零值，`iota` 也写不进去）。
 */
function valSpecs(x) {
  const isConst = tag(x) === 'const';
  const specs = kids(x);
  const out = [];
  let last = null;
  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i];
    if (tag(sp) !== 'spec') throw new Error(`go->graph: ${tag(x)} 里不该有 ${tag(sp)}`);
    const nm = part(sp, 'names');
    if (nm === undefined) throw new Error(`go->graph: ${tag(x)} 的 spec 里没有名字`);
    const names = kids(nm).map(leaf);
    const ty = kids(sp).find((y) => tag(y) !== 'names' && tag(y) !== 'init');
    const ini = part(sp, 'init');
    let exprs = null;
    if (ini !== undefined) {
      exprs = kids(ini);
      if (isConst) last = exprs;
    } else if (isConst) {
      exprs = last;
    }
    IOTA = isConst ? i : null;
    try {
      out.push(...specBinds(names, exprs, ty));
    } finally {
      IOTA = null;
    }
  }
  return out;
}

/** `(name x)`。Go 的 lhs 也是它。 */
const nameOf = (x) => (tag(x) === 'name' ? leaf(kids(x)[0]) : leaf(x));

function funcOf(sig, blk, name, self) {
  const params = partKids(sig, 'in').map((p) => {
    const nm = part(p, 'name');
    return nm === undefined ? null : leaf(kids(nm)[0]);
  }).filter((n) => n !== null);
  return node('func', { body: blk === undefined ? [] : many(kids(blk)) },
    { params: self === undefined ? params : [self, ...params], name });
}

/**
 * **`switch` 落一条 branch 链**（不给它开节点）。go 这一格与 C 家族差得远，正好是
 * "写法归语言、格子归节点"的又一例：**没有隐式贯穿**，所以它就是一串 if / else if / else。
 *
 * 三件事归 go 自己：
 *   * 主语**只算一次** —— 落一格 `bind` 到 `__swN`，各分支拿 `ref` 去比（`==`）；
 *     `switch { case cond: }`（没主语）那一路直接拿分支的表达式当条件。
 *   * 一个 case 里几个值 = 或 —— 落 `lazyOr`（第二格是 lazy，与 `||` 同一格 branch）。
 *   * `default` 是**最里那一层 else**，写在中间也一样（条件按源码次序判，default 垫底）。
 *
 * `__swN` 的 N 是**嵌套深度**不是全局计数：兄弟位置上的两格 switch 各自一格 region，
 * 名字撞不上；而嵌了一层的那个换个号，免得读的人以为是同一个临时量。
 *
 * **`break` 在 switch 里是跳出 switch**，落成 branch 链之后它会变成跳出循环 ——
 * 那是"答案错而不报"，所以当场报。`fallthrough` 走 toNode 的兜底（那一格还没接）。
 */
let SW_DEPTH = 0;

/** case 体里不许有 `break`（进不去内层的循环 / switch / 函数 —— 那几格各管自己）。 */
const BREAK_STOP = new Set(['for', 'switch', 'tswitch', 'select', 'fn', 'fnlit', 'method']);
function noBreak(x) {
  if (!isList(x)) return;
  if (tag(x) === 'break') {
    throw new Error('go->graph: switch 里的 break 是跳出 switch —— 落成 branch 链会变成'
      + '跳出循环，这一格当场报');
  }
  if (BREAK_STOP.has(tag(x))) return;
  for (const k of kids(x)) noBreak(k);
}

/** 一格分支的体：`(body 语句…)` -> 一格 region（go 的 case 体自带一层作用域）。 */
function armOf(c) {
  const stmts = partKids(c, 'body');
  for (const st of stmts) noBreak(st);
  return node('region', { body: many(stmts) });
}

function switchOf(x) {
  const all = kids(x);
  const ini = all.length > 0 && tag(all[0]) === 'init' ? all[0] : undefined;
  const rest = ini === undefined ? all : all.slice(1);
  const subj = rest.length > 0 && tag(rest[0]) === 'tag' ? kids(rest[0])[0] : undefined;
  const cs = subj === undefined ? rest : rest.slice(1);
  const holder = `__sw${SW_DEPTH}`;
  const arms = [];
  let dflt;
  SW_DEPTH += 1;
  try {
    for (const c of cs) {
      if (tag(c) === 'default') {
        if (dflt !== undefined) throw new Error('go->graph: 一格 switch 里两个 default');
        dflt = armOf(c);
        continue;
      }
      if (tag(c) !== 'case') throw new Error(`go->graph: switch 里不该有 ${tag(c)}`);
      const items = partKids(c, 'items');
      if (items.length === 0) throw new Error('go->graph: case 后面一个值都没有');
      // 比较落的是**算符表里那一格**（`==` 在图上写成 `=`）—— 表是唯一的出处，
      // 所以这儿走 `binOf` 而不是自己拼一格 `bin`
      const conds = items.map((it) => (subj === undefined ? toNode(it)
        : binOf('==', node('ref', {}, { name: holder }), toNode(it), OPS, { lang: 'go' })));
      arms.push([conds.reduce((a, b) => lazyOr(a, b)), armOf(c)]);
    }
  } finally {
    SW_DEPTH -= 1;
  }
  let chain = dflt;
  for (let i = arms.length - 1; i >= 0; i -= 1) chain = branchOf(arms[i][0], arms[i][1], chain);
  const body = ini === undefined ? [] : many(kids(ini).filter((k) => tag(k) !== 'none'));
  if (subj !== undefined) body.push(node('bind', { init: toNode(subj) }, { name: holder }));
  if (chain !== undefined) body.push(chain);
  return body.length === 0 ? [] : node('region', { body });
}

/**
 * **`for i, v := range xs` 落一格计数循环**（`counted`，与三段式 for 同一格 loop）。
 *
 * 三样归 go 自己，都不是节点的事：
 *   * **序列只算一次**、**长度也只算一次** —— go 的规范就是这么说的（切片的 len 在开头
 *     取一次），所以落两格 bind（`__rgN` / `__rnN`）而不是每轮重算；
 *   * 第一格是**下标**、第二格是**那一格元素**（`index-get`）—— `_` 那一格不绑名字；
 *   * `:=` 出 bind、`=` 出 set（与 `define` / `assign` 那一格同一条）。
 *
 * **能判出来的两种当场报**（图上没有那一格，不拿列表下标充）：
 *   * `range` 一格 map —— 要按键遍历，而次序在 go 里本来也是不定的；
 *   * `range` 一格整数字面量（go 1.22 起的写法）。
 * 判不出来的那两种（串按 rune 走、通道）写在文件末尾"明说的不足"里 —— 这一份沿用
 * `MAPS` 那条既有约定：**没登记成 map 的就当序列**。
 *
 * `__rgN` 的 N 是**嵌套深度**（与 `__swN` 同一条理由）。
 */
let RG_DEPTH = 0;

function forRangeOf(x) {
  const lhs = kids(x).find((y) => tag(y) === 'define' || tag(y) === 'assign');
  const vals = part(x, 'values');
  const blk = kids(x).find((y) => tag(y) === 'block');
  if (vals === undefined) throw new Error('go->graph: for-range 里没有 (values …)');
  const subj = kids(vals)[0];
  if (isMap(subj)) {
    throw new Error('go->graph: range 一格 map 要按键遍历 —— 图上还没有那一格'
      + '（次序在 go 里本来也是不定的，不能拿列表下标充）');
  }
  if (tag(subj) === 'num') {
    throw new Error('go->graph: range 一格整数（go 1.22 起）这一批还没接');
  }
  const names = lhs === undefined ? [] : kids(lhs).map(nameOf);
  if (names.length > 2) throw new Error(`go->graph: range 左边最多两格，给了 ${names.length}`);
  const isDef = lhs === undefined || tag(lhs) === 'define';
  const seq = `__rg${RG_DEPTH}`;
  const idx = `__ri${RG_DEPTH}`;
  const cnt = `__rn${RG_DEPTH}`;
  const at = (n) => node('ref', {}, { name: n });
  RG_DEPTH += 1;
  let inner;
  try {
    inner = blk === undefined ? [] : many(kids(blk));
  } finally {
    RG_DEPTH -= 1;
  }
  const mk = (n, v) => (isDef
    ? node('bind', { init: v }, { name: n })
    : node('set', { value: v }, { name: n }));
  const head = [];
  if (names.length > 0 && names[0] !== '_') head.push(mk(names[0], at(idx)));
  if (names.length > 1 && names[1] !== '_') head.push(mk(names[1], indexGet(at(seq), at(idx))));
  return node('region', {
    body: [
      node('bind', { init: toNode(subj) }, { name: seq }),
      node('bind', { init: node('prim', { args: [at(seq)] }, { name: 'len' }) }, { name: cnt }),
      counted({
        name: idx,
        from: lit(0),
        cond: bin('<', at(idx), at(cnt)),
        body: [node('region', { body: [...head, ...inner] })],
      }),
    ],
  });
}

function toNode(x) {
  switch (tag(x)) {
    // ---- 叶子 --------------------------------------------------------------
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: leaf(kids(x)[0]) });
    case 'name': {
      const n = leaf(kids(x)[0]);
      if (n === 'true') return node('const', {}, { value: true });
      if (n === 'false') return node('const', {}, { value: false });
      if (n === 'nil') return node('const', {}, { value: null });
      // 一格 const 组里的 `iota` 是**序号**，不是名字（见 IOTA 那段）
      if (n === 'iota' && IOTA !== null) return node('const', {}, { value: IOTA });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    // `(none)` 是 go.grammar 里 opt-h-simple / opt-h-expr 的空产生式
    // （三段 for 的任何一格省略时会出现）—— 它不是节点，丢掉。
    case 'none': return [];
    // `p.x` -> field-get（与 lua/nim 的 `(dot …)`、V 的 `(sel …)` 同一格节点）
    case 'sel': return fieldGet(toNode(kids(x)[0]), leaf(kids(x)[1]));
    // `Point{x: 1, y: 2}` -> record-new；`[]int{10, 20}` -> list-new。
    // **同一条产生式两种字面量**：带字段名的落记录、不带的落列表（混着的当场报）。
    case 'lit': {
      const ty = kids(x)[0];
      const elems = kids(x).slice(1);
      // **map 字面量自带标记**：`map[K]V{…}` 在树上就是 `(lit (map …) (kv …)…)` ——
      // 所以"这名字是不是 map"不用回问驱动器（那笔账在 map 这一格上是不必的）。
      // 判据要在"全是 kv"之前：记录字面量的 kv 也长这样，差的正是类型那一格。
      if (tag(ty) === 'map') {
        return mapNew(elems.map((e) => {
          const [k, v] = kids(e);
          return [toNode(k), toNode(v)];     // 键是**值**（不是名字）—— 与记录正相反
        }));
      }
      if (elems.length > 0 && elems.every((e) => tag(e) === 'kv')) {
        return recordNew(elems.map((e) => {
          const [k, v] = kids(e);
          return [nameOf(k), toNode(v)];
        }));
      }
      if (elems.some((e) => tag(e) === 'kv')) {
        throw new Error('go->graph: 这一批不接"字段名与位置混着"的复合字面量');
      }
      return listNew(many(elems));
    }
    // `m[k]` 与 `xs[i]` 在树上同形，差别在**那个名字装的是什么**（`MAPS` 那一趟扫查）
    case 'index': {
      const [o, i] = kids(x);
      return isMap(o) ? mapGet(toNode(o), toNode(i)) : indexGet(toNode(o), toNode(i));
    }
    // `xs[1:3]` -> slice（**上界不含**，与图上那格一致，go 不用调）
    case 'slice3': {
      const [o, a, b] = kids(x);
      return sliceOf(toNode(o), a === undefined ? undefined : toNode(a),
        b === undefined ? undefined : toNode(b));
    }

    // ---- 算子 --------------------------------------------------------------
    case 'bin': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'go' });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === '!' ? 'not' : leaf(op), toNode(a));
    }

    // ---- 声明与语句 --------------------------------------------------------
    case 'fn': {
      const [nm, sig, blk] = kids(x);
      const name = leaf(nm);
      return node('bind', { init: funcOf(sig, blk, name) }, { name });
    }
    // `func (p Point) total() int { … }` -> 与 `fn` **同一格 bind + func**，
    // 差的只有一件事：**接收者当第一格形参**。方法不是一格新节点，分派也不查表 ——
    // 接收者的类型写在声明里，所以这一格在图上就是个多一个实参的普通函数。
    case 'method': {
      const [recv, nm, sig, blk] = kids(x);
      const name = leaf(nm);
      const self = part(kids(recv)[0], 'name');
      if (self === undefined) {
        throw new Error(`go->graph: ${name} 的接收者没有名字 —— 匿名接收者这一批没接`);
      }
      return node('bind', { init: funcOf(sig, blk, name, leaf(kids(self)[0])) }, { name });
    }
    case 'block': return node('region', { body: many(kids(x)) });
    case 'define': case 'assign': {
      // `a, b := 1, 2` 与 `a = 1`。`define` 出 bind、`assign` 出 set —— 一格之差，
      // 正是"decl 就是 bind"那句话（没有 decl 节点）。
      const isDef = tag(x) === 'define';
      const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
      const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
      // `x, y := f()` / `x, ok = m[k]`：N 个名字对 1 个右值 ⇒ 多值的消费侧
      if (lhs.length > 1 && rhs.length === 1) {
        // **`v, ok := m[k]` 不是多值**：go 在这儿给的是"值 + 在不在"，落 map-get + map-has。
        // `_` 那一格跳过取值 —— 缺键在图上是错误（默认值归语言），而 comma-ok 的用处
        // 正是"键可能不在"，所以问在不在的那种写法不许去取值。
        if (lhs.length === 2 && tag(rhs[0]) === 'index' && isMap(kids(rhs[0])[0])) {
          const [o, k] = kids(rhs[0]);
          const mk = (t, init) => (isDef
            ? node('bind', { init }, { name: nameOf(t) })
            : node('set', { value: init }, { name: nameOf(t) }));
          const out = [];
          if (nameOf(lhs[0]) !== '_') out.push(mk(lhs[0], mapGet(toNode(o), toNode(k))));
          out.push(mk(lhs[1], mapHas(toNode(o), toNode(k))));
          return out;
        }
        return destructure(lhs.map(nameOf), toNode(rhs[0]), { declare: isDef });
      }
      return lhs.map((t, i) => {
        const v = rhs[i] === undefined ? lit(null) : toNode(rhs[i]);
        // 左边是一格字段（`p.y = 5`）或一格下标（`xs[1] = 5`）⇒ field-set / index-set；
        // `set` 只认名字
        if (tag(t) === 'sel') return fieldSet(toNode(kids(t)[0]), leaf(kids(t)[1]), v);
        if (tag(t) === 'index') {
          const [o, i] = kids(t);
          return isMap(o) ? mapSet(toNode(o), toNode(i), v) : indexSet(toNode(o), toNode(i), v);
        }
        return isDef
          ? node('bind', { init: v }, { name: nameOf(t) })
          : node('set', { value: v }, { name: nameOf(t) });
      });
    }
    case 'inc': case 'dec': return node('set', {
      value: bin(tag(x) === 'inc' ? '+' : '-', toNode(kids(x)[0]), lit(1)),
    }, { name: nameOf(kids(x)[0]) });
    case 'for': {
      // 三种 `for` 落成同一格 loop（**不给它开节点**）。形状与 vlang / awk 一模一样，
      // 所以那句话只写一遍 —— `threePart` 在 `src/core/graph/fromtree.js` 里。
      const init = part(x, 'init');
      const cond = part(x, 'cond');
      const post = part(x, 'post');
      const blk = kids(x).find((y) => tag(y) === 'block');
      // 三段里省掉的那几格在树上是 `(none)`（`go.grammar` 的空产生式）。
      // **条件那一格不能落成"空列表"**：`for ;; {}` 是无条件循环，那是 `cond: undefined`。
      const slot = (p) => (p === undefined ? [] : many(kids(p).filter((k) => tag(k) !== 'none')));
      const condOf = () => {
        const c = cond === undefined ? undefined : kids(cond)[0];
        return c === undefined || tag(c) === 'none' ? undefined : toNode(c);
      };
      return threePart({
        init: slot(init),
        cond: condOf(),
        post: slot(post),
        body: blk === undefined ? [] : many(kids(blk)),
      });
    }
    case 'if': {
      const all = kids(x);
      // `if v := f(); v > 0 { … }` —— 头上那一格 init 的**作用域是整条 if 链**
      // （else 里也看得见 `v`）。所以它落成一格 region 包着 branch，
      // 不是把那句话挪到 if 外面去：挪出去就多活了一层作用域。
      const ini = all.length > 0 && tag(all[0]) === 'init' ? all[0] : undefined;
      const parts = ini === undefined ? all : all.slice(1);
      // `else` 那一格是个包装（`(else (block …))` 或 `(else (if …))` —— else-if 链）
      const els = elseOf(parts[2]);
      const br = branchOf(toNode(parts[0]), toNode(parts[1]),
        els === undefined ? undefined : toNode(els));
      if (ini === undefined) return br;
      return node('region', { body: [...many(kids(ini).filter((k) => tag(k) !== 'none')), br] });
    }
    case 'return': return retOf(many(kids(x)));
    case 'for-range': return forRangeOf(x);
    case 'switch': return switchOf(x);
    // `break` / `continue` -> **同一格节点**，差的只有一格附属 kind。
    // **带标签的那两个当场报**：`break L` 跳的是 L 那一层，而图上这一格跳的是最近一层 ——
    // 原来把标签直接丢了，那是"答案错而不报"。
    case 'break': case 'continue': {
      if (kids(x).length > 0) {
        throw new Error(`go->graph: 带标签的 ${tag(x)} 跳的不是最近那一层 —— 这一格当场报`);
      }
      return loopExit(tag(x));
    }
    case 'expr': return toNode(kids(x)[0]);
    // `defer f(x)` -> scope-exit（挂在**当前 region**上，逆序、早退也跑 —— 八家共用那一格）。
    // go 独有的一条在 `deferNow` 里：**实参在注册那一刻就算掉**（CL / nim / V 不是这样，
    // 它们 defer 的是一整块语句）。办法是把实参先绑到临时名字 —— 用现成的 bind + ref
    // 说清"什么时候求值"，不给 scope-exit 加端口。
    case 'defer': return deferNow(many(kids(x)));
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      // `fmt.Println(x)`：选择器那一格在这一批还没有节点（`record` 排在后面），
      // 所以只认"打印"这一族，别的 sel 调用当场报 —— 不猜、不静默。
      if (tag(fn) === 'sel') {
        const m = leaf(kids(fn)[1]);
        if (PRINTS.has(m)) return node('prim', { args: argNodes }, { name: 'print' });
        // `p.total()` -> `total(p)`：接收者是**第一格实参**（声明里写着是哪个类型，
        // 所以这一步是纯改写，不查表、不加节点）。
        // `Point.total(p)`（方法表达式）是**同一件事的另一种写法** —— 左边是登记过的
        // 类型名时，接收者已经在实参里了，不再补。
        if (METHODS.has(m)) {
          const obj = kids(fn)[0];
          const onType = tag(obj) === 'name' && TYPES.has(leaf(kids(obj)[0]));
          return node('call', {
            fn: node('ref', {}, { name: m }),
            args: onType ? argNodes : [toNode(obj), ...argNodes],
          });
        }
        throw new Error(`go->graph: 这一批只接 fmt.Print* 与声明过的方法，收不了 .${m}`);
      }
      const callee = tag(fn) === 'name' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      // 转换（`int(x)` / `float64(x)`）在树上与调用**同形** —— 靠一张名字表分开
      if (callee !== null && CONV.has(callee) && argNodes.length === 1) {
        return convOf(CONV.get(callee), argNodes[0]);
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    // `var` / `const` 落**一串 bind**（顶层与语句里同一格 —— go 两处都写得下）。
    // 树上的标签是 `var` / `const`（`go.grammar` 的 const-decl / var-decl 两条产生式
    // 出的就是它们）—— 这儿原来写的是 `const-decl` / `var-decl` 两格**死代码**，
    // 所以 720 份里 285 份卡在"这一格还没接：var / const"上。
    case 'var': case 'const': return valSpecs(x);
    // 顶层的这几样在这一批里没有对应物（包、导入、类型声明）—— 丢掉，不猜。
    // `typedecl` 那格：**struct 的字段表不进图**（record-new 的字段名从字面量那儿来），
    // 树上的标签是 `typedecl` 不是 `type-decl` —— 原来写错了一格，record 那份例子量出来的。
    case 'import': case 'typedecl': return [];
    default:
      throw new Error(`go->graph: 这一格还没接：${tag(x) ?? String(JSON.stringify(x)).slice(0, 40)}`);
  }
}

/**
 * 一棵 go 的 GLR 树（`(file 包名 顶层项…)`）-> 一张图。末尾补一格 `call main`。
 *
 * `opts.asModule` = 这一份是**被 import 进来的**（第一百五十一片第二格）：那时**不补**
 * 那一格 `call main` —— 被导入的那份文件里若也有个 `main`，补了就会跑两次。
 */
export function goToGraph(tree, opts) {
  if (tag(tree) !== 'file') throw new Error('go->graph: 这不是 (file …)');
  // **先扫一遍哪些名字装 map**：`m := map[K]V{…}` 在树上自带标记，所以这一趟就够了
  // —— `m[k]` 与 `xs[i]` 同形那笔账，在 go 上不需要驱动器回问类型。
  MAPS.clear();
  for (const nm of mapNames(tree, mapBindName)) MAPS.add(nm);
  // 再扫一遍**声明过的方法名与类型名**：go 的接收者写在声明里，所以这一趟就够了 ——
  // 方法在图上是"多一格实参的普通函数"，不需要运行期查表（见 METHODS 那段）。
  METHODS.clear();
  TYPES.clear();
  collectDecls(tree);
  const items = kids(tree).slice(1);          // 第一格是包名
  const body = items.map(toNode).flat();
  if (opts !== undefined && opts.asModule === true) return program(body);
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

/**
 * 这份文件 `import` 了哪几格（第一百五十一片第二格）。回一串 specifier 的原文。
 *
 * 树上的形状是 `(import (path "fmt"))` —— 一句 `import (…)` 里几格就是几格实参。
 * **这一格知识归这门语言**：驱动那一层只问"你 import 了什么"，不认识 go 的树。
 */
export function goImports(tree) {
  const out = [];
  const walk = (x) => {
    if (!isList(x)) return;
    if (tag(x) === 'import') {
      /* `kids()` 不含标签（`fromtree.js:34`），所以这儿直接遍历它。 */
      for (const it of kids(x)) {
        if (isList(it) && tag(it) === 'path') {
          const s = kids(it)[0];
          if (s !== undefined && s.kind === 'string') out.push(s.value);
        }
      }
      return;
    }
    for (const k of kids(x)) walk(k);
  };
  walk(tree);
  return out;
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 类型全丢（见文件头）。`var` / `const` 现在接了（落一串 bind），但类型只用在
//      **零值**那一处（`zeroOf`）—— 具名结构体的零值当场报，字段表不进图。
//   1b. `range` 那一格**判不出来的两种**沿用 `MAPS` 那条既有约定（没登记成 map 的当序列），
//      所以这两种会落成"按下标走"而不报：**串**（go 给的是 rune，`s[i]` 给的是字节 ——
//      ASCII 上同值，别的不同）与**通道**。判得出来的两种（map、整数字面量）当场报。
//   2. 多返回值、`x, ok = m[k]`、defer、goroutine、channel 都不在这一批
//      （`ext/go/SPEC.md` §五那张顺序表说了它们各排在哪一步）。
//   3. 选择器（`a.b`）落 `field-get`（第四批），但**只当它是取字段** ——
//      `fmt.Println` 那种"包名点方法"仍在 `call` 那一格特判，因为它不是取字段。
//   4. 方法：接收者提到形参表第一格（第二十四批）。**指针接收者、接口、方法值**都不在这一批 ——
//      重名的方法（两个类型各有一个 `total`）当场报：分开它们要的正是类型那一层。
