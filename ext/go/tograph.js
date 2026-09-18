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
    if (isMapCtor(rhs[i]) && tag(lhs[i]) === 'name') return leaf(kids(lhs[i])[0]);
  }
  return null;
}

/**
 * 右边是**造一格 map** 吗。go 有两种写法，两种都要认：
 *   * 字面量：`map[K]V{…}` -> `(lit (map …) …)`；
 *   * `make`：`make(map[K]V)` -> `(call (name make) (args (map …)))`。
 * 漏掉后一种的代价是**答案错而不报**：`m["k"] = 5` 会静静落成列表下标写。
 * （V 那一侧同一天踩过同一个坑 —— 那儿是"不写类型的字面量"。）
 */
function isMapCtor(r) {
  if (r === undefined || !isList(r)) return false;
  if (tag(r) === 'lit') return tag(kids(r)[0]) === 'map';
  if (tag(r) !== 'call') return false;
  const [fn, args] = kids(r);
  if (fn === undefined || tag(fn) !== 'name' || leaf(kids(fn)[0]) !== 'make') return false;
  const first = args === undefined ? undefined : kids(args)[0];
  return first !== undefined && tag(first) === 'map';
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
 * **具名类型 -> 它的字段表**（`[[字段名, 字段类型的树], …]`，按声明顺序）。
 *
 * 为什么要登记：`var p Point` 的零值是"**每个字段各自的零值**"，而 record-new 那一格要的是
 * 字段名 + 值 —— 两样都得从**声明**来。这是"名字与顺序从声明来"那条既有路子的又一处
 * （V 的 `STRUCTS`、mojo 的 `@value struct`、CL 的 `defstruct`、Scheme 的
 * `define-record-type`、FB 的 `Type` 都是它）。
 *
 * 只登记 `type X struct{…}` 那一种。别的具名类型（`type X = Y` 别名、`type X int`）
 * 不进这张表 —— 它们的零值当场报。
 */
const STRUCTS = new Map();

/**
 * **具名类型 -> 它的底子**（`type Level int` / `type Name = string` / `type S []int`）。
 *
 * 零值那一格要它：`var a Level` 的零值就是**底子的零值**（go 里具名类型与它的底层类型
 * 零值相同，别名更是同一个类型）。所以这一格是**一层间接**，不是新语义。
 * 结构体那一种走上面的 `STRUCTS`（那一族要字段名，不是一层间接）。
 */
const UNDER = new Map();

/**
 * **方法名按接收者类型压平**（`docs/design/cross-file-methods.md` 那条 A 路，V 那一份先落的）。
 *
 * `MSET` 收 **`类型.方法名`**（`Value.String`），`mangle()` 压成图上一格函数名
 * （`Value__String`）。为什么值得做（两条都是量出来的）：
 *   * **撞名不再是墙**：一个包摊开看 `Error` / `String` / `Format` 重名到处都是，
 *     而平表（名字 -> 接收者类型）一撞就当场报；
 *   * **`opts.also` 那几份的方法名现在可以收**（按 `类型.名字` 存不会撞）——
 *     原来只收字段名，量过"整包收方法名"会把 go 从 81 打到 47，那条死路的根是平表。
 *
 * **接收者的类型从哪儿来**：`VARTYPE`（名字 -> 具名类型），只收**语法上写着的**三处 ——
 * 方法的接收者、带具名类型的形参、`x := T{…}` / `x := &T{…}`。不是推断。
 */
const MSET = new Set();
const VARTYPE = new Map();
const mangle = (owner, name) => `${String(owner).replace(/\./g, '__')}__${name}`;

/** 一格**类型**节点里的具名类型（`*T` 那一层剥掉）。切片 / map / 函数类型回 null。 */
function namedTypeOf(t) {
  if (t === undefined || t === null || !isList(t)) return null;
  const g = tag(t);
  if (g === 'tname') return kids(t).map(leaf).join('.');
  if (g === 'ptr') return namedTypeOf(kids(t)[0]);
  return null;
}

/** `T{…}` / `&T{…}` 那格**复合字面量**的具名类型（别的形状回 null —— 不猜）。 */
function litTypeNameOf(r) {
  if (r === undefined || r === null || !isList(r)) return null;
  const g = tag(r);
  if (g === 'addr' || g === 'paren') return litTypeNameOf(kids(r)[0]);
  if (g !== 'lit') return null;
  return namedTypeOf(kids(r)[0]);
}

/** `(struct (f (names x y) 类型) …)` -> `[[名, 类型], …]`（一格 `f` 里能有好几个名字）。 */
function fieldsOf(st) {
  const out = [];
  for (const f of kids(st)) {
    if (tag(f) !== 'f') return null;          // 嵌入字段（`embed`）这一批不接
    const nms = part(f, 'names');
    const ty = kids(f).find((y) => tag(y) !== 'names' && tag(y) !== 'tag' && tag(y) !== 'attrs');
    if (nms === undefined || ty === undefined) return null;
    for (const n of kids(nms)) out.push([leaf(n), ty]);
  }
  return out;
}

/**
 * 扫一遍顶层：登记类型名（`type Point struct …`）、每个方法的接收者类型，
 * 以及 `var` / `const` 里**装 map 的名字**（`specMapNames` 那段说了为什么要在这儿收）。
 */
function collectDecls(x, shapesOnly) {
  if (!isList(x)) return;
  if (tag(x) === 'tspec' || tag(x) === 'talias') {
    TYPES.add(leaf(kids(x)[0]));
    const body = kids(x).find((y) => tag(y) === 'struct');
    if (body !== undefined) {
      const fs = fieldsOf(body);
      /* 收不齐（有嵌入字段）就存 null —— 那时零值当场报，不猜嵌入的那一格占几格。 */
      STRUCTS.set(leaf(kids(x)[0]), fs);
    } else {
      /* 别的具名类型：记下它的**底子**（零值就是底子的零值 —— 一层间接，不是新语义）。 */
      const und = kids(x)[1];
      if (und !== undefined && isList(und)) UNDER.set(leaf(kids(x)[0]), und);
    }
  }
  if (tag(x) === 'spec') for (const n of specMapNames(x)) MAPS.add(n);
  /* `shapesOnly` 是**同一包里别的文件**那一趟用的（`opts.also`）：类型与字段名要收，
     **方法名不收** —— 那张表是"名字 -> 接收者类型"的单态分派，一个包摊开看重名到处都是
     （`Error` / `String` / `Format` …）。量过：整包一起收方法名，go 那一栏从 81 掉到 47。
     跨文件的方法调用因此仍旧走"取字段再调它" —— 那条墙留着，它要的正是类型那一层。 */
  if (tag(x) === 'method') {
    const [recv, nm] = kids(x);
    const name = leaf(nm);
    const ty = part(kids(recv)[0], 'tname');
    const owner = ty === undefined ? '?' : leaf(kids(ty)[0]);
    /* **按 `类型.名字` 收**（`opts.also` 那几份也收 —— 这样存不会撞名，见 `MSET` 那一段）。 */
    MSET.add(`${owner}.${name}`);
    if (shapesOnly !== true) {
      /* 平表仍旧留着：接收者的类型看不出来时靠它（只认"这个名字只有一个主人"）。
         撞名**不再当场报** —— 压平之后声明这一步没有冲突，报不报要等调用点。 */
      const had = METHODS.get(name);
      METHODS.set(name, had === undefined || had === owner ? owner : null);
    }
  }
  for (const k of kids(x)) collectDecls(k, shapesOnly);
}

// go 的算符表：标准那一批。位运算那一族（`<<` / `>>` / `&` / `|` / `^` / `&^`）
// **不在这张表里** —— 它们要的是 prim 表里加那几格，归"词汇表"那一刀。
// `binOf` 查不到就当场报，不是静默落成别的东西。
/* go 的位运算：`&` `|` `<<` `>>` 在公共表里，这儿补 go 自己那两格 ——
   **`^` 在 go 里是 xor**（图上 `^` 是幂，所以映到 `bxor`），`&^` 是 and-not（下面拼）。 */
const OPS = ops({ '^': 'bxor' });
/** 转换名 -> `conv` 的目标。go 的定宽整数与浮点各自那几格都往这四格收。 */
const CONV = convs({
  int8: 'int', int16: 'int', int32: 'int', int64: 'int',
  uint: 'int', uint8: 'int', uint16: 'int', uint32: 'int', uint64: 'int',
  float32: 'float', float64: 'float', string: 'str',
});
/**
 * `fmt.Println` / `println` / `print` 都落 `prim print`（**print 不是节点**）。
 *
 * **`Printf` 不在这张表里**：它带格式串，而"把格式串当成第一个要印的东西"是
 * **答案错而不报** —— `fmt.Printf("x=%d\n", 3)` 会印成 `x=%d\n 3`。
 * 它走 `fmtOf` 那一路（见下面）。
 */
const PRINTS = new Set(['Println', 'Print', 'println', 'print']);

/** 这三格带格式串：`Sprintf` / `Errorf` 交一格串，`Printf` 印出去。 */
const FORMATS = new Set(['Sprintf', 'Errorf', 'Printf']);

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
  // `[N]T` 的零值是**N 格元素零值**（数组是值语义的，不是切片）——
  // N 得是个整数字面量、元素也得有零值，两样缺一样就当场报。
  if (t === 'array') {
    const [n, el] = kids(ty);
    if (tag(n) !== 'num') {
      throw new Error(`go->graph: [N]T 的零值要 N 是整数字面量（这儿是 ${tag(n)}）`);
    }
    const cnt = Number(leaf(kids(n)[0]));
    if (!Number.isInteger(cnt) || cnt < 0 || cnt > 1024) {
      throw new Error(`go->graph: [${cnt}]T 的零值这一批只接 0..1024 格`);
    }
    /* **每格各算一遍**（不是复制同一格）：`lit(0)` 出的是 `{lit: 0}` 而不是一格节点，
       复制那条路要分两种形状 —— 而"再算一遍"本来就更直白，零值也没有作用。 */
    return listNew(Array.from({ length: cnt }, () => zeroOf(el, name)));
  }
  // 匿名 struct（`var x struct{ n int }`）的零值 = 每个字段各自的零值
  if (t === 'struct') {
    const fs = fieldsOf(ty);
    if (fs === null) {
      throw new Error(`go->graph: ${name} 那格 struct 有嵌入字段 —— 零值这一批不猜`);
    }
    return recordNew(fs.map(([fn, ft]) => [fn, zeroOf(ft, `${name}.${fn}`)]));
  }
  if (t === 'tname' && kids(ty).length === 1) {
    const n = leaf(kids(ty)[0]);
    if (INT_TYPES.has(n)) return lit(0);
    if (n === 'float32' || n === 'float64') return convOf('float', lit(0));
    if (n === 'string') return lit('');
    if (n === 'bool') return lit(false);
    if (NIL_NAMES.has(n)) return lit(null);
    // **具名 struct**：字段名与顺序从声明来（`STRUCTS` 那段），每个字段各算一遍零值。
    // 声明不在这一份文件里、或者那个 struct 有嵌入字段，都当场报 —— 不猜。
    if (STRUCTS.has(n)) {
      const fs = STRUCTS.get(n);
      if (fs === null) {
        throw new Error(`go->graph: ${n} 有嵌入字段 —— 它在零值里占几格要展开被嵌类型才知道`);
      }
      return recordNew(fs.map(([fn, ft]) => [fn, zeroOf(ft, `${n}.${fn}`)]));
    }
    // 别的具名类型：零值就是**底子的零值**（`type Level int` / `type Name = string`）。
    if (UNDER.has(n)) return zeroOf(UNDER.get(n), `${name}:${n}`);
    throw new Error(`go->graph: ${n} 的零值还没接 —— 这份文件里没见过它的声明`
      + '（跨模块的类型在这一格上）');
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

/**
 * `(*p).f` / `(*p)[i]` 里的那一层 `deref` **剥掉**（`(paren …)` 也一并剥）。
 * 只在"当对象用"那几处调它 —— 光秃秃的 `*p` 仍旧当场报（见 `case 'deref'`）。
 */
function unwrapDeref(x) {
  let y = x;
  while (tag(y) === 'paren') y = kids(y)[0];
  return tag(y) === 'deref' ? kids(y)[0] : x;
}

/** 匿名 `func(){…}` 的名字（`func` 那一格的 name 是附属，可它得有一个）。 */
let FN_N = 0;

function funcOf(sig, blk, name, self, selfType) {
  const params = partKids(sig, 'in').map((p) => {
    const nm = part(p, 'name');
    return nm === undefined ? null : leaf(kids(nm)[0]);
  }).filter((n) => n !== null);
  /* **形参与接收者的具名类型收进 `VARTYPE`**（只收语法上写着的那一档，见那一段）。
     一格函数一层：进来存一份、出去还原 —— 内层函数不许把外层的表改脏。 */
  const savedVars = new Map(VARTYPE);
  if (self !== undefined && selfType !== undefined && selfType !== null) {
    VARTYPE.set(self, selfType);
  }
  for (const p of partKids(sig, 'in')) {
    const nm = part(p, 'name');
    if (nm === undefined) continue;
    const ty = kids(p).find((y) => tag(y) !== 'name');
    const t = namedTypeOf(ty);
    if (t !== null) VARTYPE.set(leaf(kids(nm)[0]), t);
  }
  try {
    return node('func', { body: blk === undefined ? [] : many(kids(blk)) },
      { params: self === undefined ? params : [self, ...params], name });
  } finally {
    VARTYPE.clear();
    for (const [k, v] of savedVars) VARTYPE.set(k, v);
  }
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

/**
 * `make(T, …)` —— go 里造 map / 切片 / 通道的那一格。**第一格实参是一格类型**，
 * 所以它在树上与普通调用同形却不能按调用走（实参里躺着类型，`toNode` 收不了）。
 *
 * 接两种，别的当场报：
 *   * `make(map[K]V)` -> 一格空 map（容量那格提示丢掉 —— 图上没有容量）；
 *   * `make([]T, n[, cap])` -> 一格内建 `fill(n, T 的零值)`。**长度 0 那种也走这一条**：
 *     从前它落一格空 `list-new`，而空列表**把元素类型丢了** —— core 那条腿当场报
 *     "一格空列表（元素类型推不出来）"，可 go 的声明里那个 T 写得清清楚楚。
 *     `fill(0, T 的零值)` 交出来的值一模一样（空列表），多留下的正是那格类型。
 */
/**
 * **格式串落成一格 `concat`**（`fmt.Sprintf` / `Errorf` / `Printf`）。
 *
 * 只接三格动词，别的**当场报**（不猜宽度、精度、进制 —— 那几样要一台真的格式化机器）：
 *   * `%d` 整数 · `%s` 串 · `%v` 按 show 印 —— 图上这三格是**同一件事**：
 *     `concat` 那格内建本来就是"把各格印出来接起来"（`prims.js` 那一行）。
 *   * `%%` 一个百分号。
 *
 * `Errorf` 交出来的在 go 里是 `error` 不是 string —— 这一批把那一层**类型丢掉了**
 * （图上没有 error 那一格），所以它与 `Sprintf` 落同一格。明说在文件末尾。
 */
function fmtOf(text, args) {
  const parts = [];
  let run = '';
  let ai = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '%') { run += text[i]; continue; }
    const v = text[i + 1];
    if (v === '%') { run += '%'; i += 1; continue; }
    if (v !== 'd' && v !== 's' && v !== 'v') {
      throw new Error(`go->graph: 格式动词 %${v ?? '?'} 还没接`
        + '（这一批只有 %d / %s / %v / %%，别的要一台真的格式化机器）');
    }
    if (ai >= args.length) throw new Error('go->graph: 格式串里的动词比实参多');
    if (run !== '') { parts.push(lit(run)); run = ''; }
    parts.push(args[ai]);
    ai += 1;
    i += 1;
  }
  if (run !== '') parts.push(lit(run));
  if (ai !== args.length) {
    throw new Error(`go->graph: 格式串里 ${ai} 个动词，实参给了 ${args.length} 个`);
  }
  return node('prim', { args: parts.length === 0 ? [lit('')] : parts }, { name: 'concat' });
}

function makeOf(args) {
  if (args.length === 0) throw new Error('go->graph: make() 一格实参都没有');
  const ty = args[0];
  if (tag(ty) === 'map') return mapNew([]);
  if (tag(ty) === 'slice') {
    const n = args[1];
    /* `make([]T, n)` —— 落一格内建 `fill(n, T 的零值)`（列表上的一个库函数 -> 内建，
       与 `push` / `contains` 同一类）。零值走的还是 `zeroOf` 那一格：**具名结构体的零值
       在那儿本来就当场报**，所以"初值是一格聚合"那条约束在两边是对上的。
       **长度省掉或者是 0 也走这一条**（见上面那段）：空 `list-new` 会把元素类型丢掉。 */
    return node('prim', {
      args: [n === undefined ? lit(0) : toNode(n), zeroOf(kids(ty)[0])],
    }, { name: 'fill' });
  }
  throw new Error(`go->graph: make 的第一格是 ${tag(ty)} —— 这一批只接 map 与切片`);
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
    // `p.x` -> field-get（与 lua/nim 的 `(dot …)`、V 的 `(sel …)` 同一格节点）。
    // 左边是 `(deref …)` 时**剥掉那一层**：`(*p).f` 读的就是那一格聚合的字段（见 addr 那一段）。
    case 'sel': return fieldGet(toNode(unwrapDeref(kids(x)[0])), leaf(kids(x)[1]));
    // ---- 指针：图上没有那一格，所以只接**与图的语义正好重合**的那一半 -------------
    //
    // 图上的记录与列表本来就是**引用**（`record-new` 交出来的是同一格对象，见 eval.js 的
    // 那一格）—— 所以 `&T{…}`（取一格刚造出来的聚合的地址）在图上**就是那一格聚合本身**，
    // 这不是近似，是重合：go 里 `p := &T{}` 之后 `p.f = 1` 改的是那一格，图上一样。
    //
    // 反过来两处刻意当场报，因为它们**要真的指针**：
    //   * `&x`（一个名字的地址）—— 两处名字要指同一格，图上没有那一格；
    //   * 光秃秃的 `*p` 当值用 —— 要么是标量指针（图上没有），要么是"换掉被指的那一整格"
    //     （`*p = v`）。`(*p).f` / `(*p)[i]` 那两处是例外：它们读的是聚合，剥一层就对。
    case 'addr': {
      const a = kids(x)[0];
      if (tag(a) === 'lit') return toNode(a);
      /* **`&x` 里 x 是一格已知的 struct** —— 图上的记录就是引用（`q := &p` 之后 `q.f = 5`
         改的是同一格，与 go 一样），所以 `&x` **就是 x**。不是近似，是重合 ——
         与 `&T{…}` 那一半逐字同理。"知道 x 是不是 struct"是 mangle 那一刀顺带带来的
         （`VARTYPE` + `STRUCTS`）。类型没写在语法上的（`&f()`）仍旧报。 */
      if (tag(a) === 'name') {
        const t = VARTYPE.get(leaf(kids(a)[0]));
        if (t !== undefined && STRUCTS.has(t)) return toNode(a);
      }
      throw new Error('go->graph: `&` 只接"刚造出来的那一格聚合"（`&T{…}`）'
        + '与"已经是一格 struct 的名字"——别的（标量 / 类型没写在语法上）是真别名，'
        + '图上没有指针那一格');
    }
    case 'deref':
      throw new Error('go->graph: `*p` 只接"当对象用"那一处（`(*p).f` / `(*p)[i]`）——'
        + '当值用要指针那一格');
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
      const [o0, i] = kids(x);
      const o = unwrapDeref(o0);
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
      /* `a &^ b` 是 go 独有的 and-not —— 拼成 `band(a, bnot(b))`，不给它开一格内建。 */
      if (leaf(op) === '&^') {
        return node('prim', { args: [toNode(a), un('bnot', toNode(b))] }, { name: 'band' });
      }
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'go' });
    }
    case 'un': {
      const [op, a] = kids(x);
      const o = leaf(op);
      if (o === '!') return un('not', toNode(a));
      if (o === '^') return un('bnot', toNode(a));      // go 的一元 `^` 是按位取反
      return un(o, toNode(a));
    }

    // ---- 说清楚的三条墙（原来只印"这一格还没接：X"，落进了"没归类"那一栏）------
    //
    // `[]byte(s)` / `(*T)(p)` / `map[K]V(m)` 那一族是**表示层的转换**：字节表示、
    // 指针重解释、底层类型的换名。`conv` 那格节点只管四种值的类型（int/float/str/bool）——
    // 表示层要类型才说得清（`byte` 在图上没有那一格），所以这一条留着等类型覆盖层。
    /* `x.(T)` 是**类型断言** —— 树上的标签叫 `assert`（与图上那格断言节点同名，
       两件事毫无关系）。单值那一种在 go 里断言不成立就 panic、双值那一种交出一格 bool ——
       两种都要"这格值到底是什么类型"，而这一层没有类型。所以这一条留着等类型覆盖层。 */
    case 'assert':
      throw new Error('go->graph: `x.(T)` 是**类型断言**（树上的标签与图上那格 assert 同名，'
        + '两件事无关）—— 断言成不成立要类型，这一格要类型覆盖层');
    case 'conv':
      throw new Error('go->graph: `[]byte(s)` / `(*T)(p)` 这一族是**表示层的转换**（字节'
        + '表示 / 指针重解释）—— `conv` 那格只管 int / float / str / bool 四种，'
        + '这一格要类型覆盖层');
    // `fallthrough` 是"接着走下一支"——而 switch 落成的是 branch 链（每支各自一格 region），
    // 链上没有"下一支"这个概念。要接得把 case 体拆成一串带标签的块，那是另一种降级。
    case 'fallthrough':
      throw new Error('go->graph: `fallthrough` 落不进 branch 链（链上没有"下一支"）——'
        + '要接得把 switch 换成带标签的块，那是另一种降级');
    // `L: for { … continue L }` —— 带标签的语句。`loop-exit` 那格节点只认"最近的一层"，
    // 标签要一格"跳到哪儿"的附属。带标签的 break / continue 早就当场报了（switch 那一刀），
    // 这一格是**标签本身**（声明的那一侧）。
    case 'label':
      throw new Error('go->graph: 带标签的语句（`L: for …`）——`loop-exit` 只认最近的'
        + '那一层，标签要一格"跳到哪儿"的附属，这一格没接');

    // ---- 声明与语句 --------------------------------------------------------
    // `func(x int) int { … }` 当值用 —— **图上一格新节点也不用加**：`func` 那一格本来就是
    // 表达式（`nodes.js` 里它的 sort 是 expr），只是从前这门映射没接它，于是 60 份文件
    // 卡在"这一格还没接：fnlit"上。名字这一格是附属，匿名的就现取一个（`__fnN`）——
    // 提升与按值调用那几条形状账（c / wat / core）本来就照着名字走。
    case 'fnlit': {
      const sig = kids(x).find((y) => tag(y) === 'sig');
      const blk = kids(x).find((y) => tag(y) === 'block');
      return funcOf(sig, blk, `__fn${FN_N++}`);
    }
    case 'fn': {
      // **按标签找，不按位置数**：泛型函数多出一格 `(tparams …)`
      // （`(fn IDENT type-params signature block)`），按位置数就把 tparams 当成了签名、
      // 把签名当成了体 —— 于是 `(in …)` 会被当成一条语句走进 `toNode`。
      // 那正是 `in` 那 13 份墙的来历（尺子印的是"这一格还没接：in"，看着像 V 的 `in` 算子）。
      // **类型参数丢掉**：类型不进图，单态化是另一层的事。
      const nm = kids(x)[0];
      const sig = kids(x).find((y) => tag(y) === 'sig');
      const blk = kids(x).find((y) => tag(y) === 'block');
      const name = leaf(nm);
      return node('bind', { init: funcOf(sig, blk, name) }, { name });
    }
    // `func (p Point) total() int { … }` -> 与 `fn` **同一格 bind + func**，
    // 差的只有一件事：**接收者当第一格形参**。方法不是一格新节点，分派也不查表 ——
    // 接收者的类型写在声明里，所以这一格在图上就是个多一个实参的普通函数。
    case 'method': {
      const [recv, nm] = kids(x);
      const sig = kids(x).find((y) => tag(y) === 'sig');
      const blk = kids(x).find((y) => tag(y) === 'block');
      const name = leaf(nm);
      const self = part(kids(recv)[0], 'name');
      if (self === undefined) {
        throw new Error(`go->graph: ${name} 的接收者没有名字 —— 匿名接收者这一批没接`);
      }
      /* **方法名按接收者类型压平**（见 `MSET` / `mangle` 那一段）。 */
      const recvTy = kids(kids(recv)[0]).find((y) => tag(y) !== 'name');
      const ownerTn = namedTypeOf(recvTy);
      const graphName = ownerTn !== null ? mangle(ownerTn, name) : name;
      return node('bind', {
        init: funcOf(sig, blk, graphName, leaf(kids(self)[0]), ownerTn),
      }, { name: graphName });
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
        /* `x := T{…}` / `x := &T{…}` —— **语法上写着的具名类型**，收进 VARTYPE
           （方法调用要拿它挑主人 + `&x` 那一半要它，见 `MSET` 那一段）。 */
        if (isDef && rhs[i] !== undefined && tag(t) !== 'sel' && tag(t) !== 'index') {
          const tn = litTypeNameOf(rhs[i]);
          if (tn !== null) VARTYPE.set(nameOf(t), tn);
        }
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
      // `make(…)` 要在 `many(kids(args))` **之前**拦：它的第一格实参是**一格类型**
      // （`make(map[K]V)` / `make([]T, 0, 8)`），`toNode` 收不了类型 —— 先算实参就先炸了。
      // 头一版正是把这一格放在后面，于是 `map` 那 20 份一份都没动（尺子当场说了话）。
      if (tag(fn) === 'name' && leaf(kids(fn)[0]) === 'make') {
        return makeOf(args === undefined ? [] : kids(args));
      }
      const argNodes = args === undefined ? [] : many(kids(args));
      // `fmt.Println(x)`：选择器那一格在这一批还没有节点（`record` 排在后面），
      // 所以只认"打印"这一族，别的 sel 调用当场报 —— 不猜、不静默。
      if (tag(fn) === 'sel') {
        const m = leaf(kids(fn)[1]);
        if (PRINTS.has(m)) return node('prim', { args: argNodes }, { name: 'print' });
        // 带格式串那三格。**格式串必须是字面量**（要在这一层读它的动词），不是就报。
        if (FORMATS.has(m)) {
          const raw = args === undefined ? [] : kids(args);
          if (raw.length === 0 || tag(raw[0]) !== 'str') {
            throw new Error(`go->graph: ${m} 的格式串不是字面量 —— 这一层读不出它的动词`);
          }
          let text = leaf(kids(raw[0])[0]);
          const rest = argNodes.slice(1);
          if (m !== 'Printf') return fmtOf(text, rest);
          /* `Printf` **自己不换行**，而图上那格 `print` 换行 —— 所以格式串以 `\n` 收尾时
             把它去掉（两边正好对上）；不以 `\n` 收尾的这一批接不了：图上没有"不换行的印"。 */
          if (!text.endsWith('\n')) {
            throw new Error('go->graph: Printf 的格式串不以换行收尾 —— 图上那格 print 自带换行，'
              + '没有"不换行的印"那一格');
          }
          text = text.slice(0, -1);
          return node('prim', { args: [fmtOf(text, rest)] }, { name: 'print' });
        }
        // `p.total()` -> `total(p)`：接收者是**第一格实参**（声明里写着是哪个类型，
        // 所以这一步是纯改写，不查表、不加节点）。
        // `Point.total(p)`（方法表达式）是**同一件事的另一种写法** —— 左边是登记过的
        // 类型名时，接收者已经在实参里了，不再补。
        /* `p.total()` -> 方法调用 —— **三条路**（与 V 那一份同一条，见
           `docs/design/cross-file-methods.md`）：
             1. 接收者的类型**知道**（`VARTYPE` 里有 · 或平表里只有一个主人）：mangle
             2. `Point.total(p)`（方法表达式）：接收者已经在实参里，不再补
             3. 都不知道：当场报（这一门一直是这个口径 —— 不走"取字段再调它"那条兜底） */
        const obj = kids(fn)[0];
        const onType = tag(obj) === 'name' && TYPES.has(leaf(kids(obj)[0]));
        const recvName = tag(obj) === 'name' ? leaf(kids(obj)[0]) : null;
        const fromVar = recvName !== null ? VARTYPE.get(recvName) : undefined;
        const flat = METHODS.get(m);
        const owner = fromVar ?? (flat === null ? undefined : flat);
        if (owner !== undefined && MSET.has(`${owner}.${m}`)) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(owner, m) }),
            args: onType ? argNodes : [toNode(obj), ...argNodes],
          });
        }
        if (flat !== undefined && flat !== null) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(flat, m) }),
            args: onType ? argNodes : [toNode(obj), ...argNodes],
          });
        }
        if (flat === null) {
          throw new Error(`go->graph: 好几个类型都声明了方法 ${m}，而接收者的类型这一层`
            + '看不出来 —— 要类型那一层（`VARTYPE` 只收语法上写着的那一档）');
        }
        throw new Error(`go->graph: 这一批只接 fmt.Print* 与声明过的方法，收不了 .${m}`);
      }
      const callee = tag(fn) === 'name' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      // `len(x)` 是 go 的内建，落 `prim len` —— 与 lua 的 `#s`、awk 的 `length(s)`、
      // V 的 `.len` **同一格节点**（写法归语言）。原来它落成"调一个叫 len 的函数"，
      // 而那个函数不存在 —— 跑起来才报，不如在这儿就对。
      if (callee === 'len' && argNodes.length === 1) {
        return node('prim', { args: argNodes }, { name: 'len' });
      }
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
  STRUCTS.clear();
  UNDER.clear();
  MSET.clear();
  VARTYPE.clear();
  /* **同一包里别的文件先扫**（`opts.also`）：go 的一个包摊在好几份文件上，
     `var x SomeType` 的零值、`T{…}` 的字段名都可能声明在旁边那份里。
     这一趟只收声明，不落节点；**旁边的先扫、自己的后扫**（同名时自己这一份说了算）。 */
  for (const t of opts?.also ?? []) {
    if (t === tree) continue;
    for (const nm of mapNames(t, mapBindName)) MAPS.add(nm);
    collectDecls(t, true);   // shapesOnly：类型与字段名要，方法名不要（重名太多）
  }
  collectDecls(tree);
  FN_N = 0;                                   // 匿名 func 的编号按文件重来（图要可重现）
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
//   1a. `fmt.Errorf` 交出来的在 go 里是 `error` 不是 string —— 这一批把那一层**类型丢掉了**
//      （图上没有 error 那一格），所以它与 `Sprintf` 落同一格 `concat`。
//   1b. `range` 那一格**判不出来的两种**沿用 `MAPS` 那条既有约定（没登记成 map 的当序列），
//      所以这两种会落成"按下标走"而不报：**串**（go 给的是 rune，`s[i]` 给的是字节 ——
//      ASCII 上同值，别的不同）与**通道**。判得出来的两种（map、整数字面量）当场报。
//   2. 多返回值、`x, ok = m[k]`、defer、goroutine、channel 都不在这一批
//      （`ext/go/SPEC.md` §五那张顺序表说了它们各排在哪一步）。
//   3. 选择器（`a.b`）落 `field-get`（第四批），但**只当它是取字段** ——
//      `fmt.Println` 那种"包名点方法"仍在 `call` 那一格特判，因为它不是取字段。
//   4. 方法：接收者提到形参表第一格（第二十四批）。**指针接收者、接口、方法值**都不在这一批 ——
//      重名的方法（两个类型各有一个 `total`）当场报：分开它们要的正是类型那一层。
