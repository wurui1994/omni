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
  mapNew, mapGet, mapSet, mapHas, mapNames, mapForIn, isList,
} from '../../src/core/graph/fromtree.js';
import { loadMappingFor, applyRule } from '../../src/core/graph/mapping.js';

/** .mapping 规则表（懒加载，只读一次） */
let GO_RULES = null;
function goRules() {
  if (GO_RULES !== null) return GO_RULES;
  GO_RULES = loadMappingFor('go').rules;
  return GO_RULES;
}

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

/** **这个模块真的需要方法表吗**（= 有没有发过一处动态分派）。见 `funcdecl` 那一格的账。
 *  今天一处都没置上 —— 方法调用全是静态定下来的。做接口分派时在发分派点处置上。 */
const NEEDS_MTABLE = false;
const VARTYPE = new Map();
const mangle = (owner, name) => `${String(owner).replace(/\./g, '__')}__${name}`;

/**
 * **跨包的符号表**（`opts.pkgs` = 语料里**所有**的树）。
 *
 * 为什么要这一张：尺子上最大的一族是"跨文件才知道的事"（go 435 份 / 68.3%），而
 * `opts.also` 只递**同一个目录**（= 同一个 go 包）。`syntax.Type` 的零值、`ir.NewNilExpr(…)`
 * 这一格调用、`t.Pos()` 里接收者是 `syntax.Type` 的那一档 —— 三样都要**另一个包的声明**。
 *
 * 键是**限定名**（`syntax.Type` / `ir.NewNilExpr` / `syntax.Type.Pos`），所以它与本文件那几张
 * 表（`STRUCTS` / `MSET` / …，键是光名字）**井水不犯河水** —— 不必按 import 拷进来，
 * 查的时候多问一层就是。包名从每棵树自己的 `package` 那一句来（`(file 包名 …)`）。
 *
 * **只收我们真消费的四样**：具名类型、struct 的字段表、别的具名类型的底子、方法名、
 * 顶层函数名。收得多了没人查，还白占内存（量过：751 棵树全留住是 1.3GB 堆）。
 *
 * 这一张表**不改"落成图"的口径**：图仍是一份文件一张，跨包的被调者只落一格 `ref`
 * （名字 mangle 过），它的**体不在这张图里** —— 与 `opts.also` 那几份的方法一直是同一条
 * 纪律（这把尺子量的是"映射写全了没有"，链接是下一层的事）。
 */
const XNONE = {
  pkgs: new Set(),
  types: new Set(), structs: new Map(), under: new Map(), mset: new Set(), funcs: new Set(),
};
let XPKG = XNONE;
/** 按 `opts.pkgs` 那个数组的身份缓存（尺子对同一门语言递的是同一个数组，只建一次）。 */
const XCACHE = new WeakMap();

/** 一棵树里**属于包 `p`** 的那几样声明（键都带包限定 —— 见 `XNONE` 那一段）。 */
function collectPkg(x, p, X) {
  if (!isList(x)) return;
  const g = tag(x);
  if (g === 'tspec' || g === 'talias') {
    const n = `${p}.${leaf(kids(x)[0])}`;
    X.types.add(n);
    const body = kids(x).find((y) => tag(y) === 'struct');
    if (body !== undefined) X.structs.set(n, fieldsOf(body));
    else {
      const und = kids(x)[1];
      if (und !== undefined && isList(und)) X.under.set(n, und);
    }
  }
  if (g === 'method') {
    const [recv, nm] = kids(x);
    const owner = recvOwner(recv);
    if (owner !== null) X.mset.add(`${p}.${owner}.${leaf(nm)}`);
  }
  if (g === 'fn') X.funcs.add(`${p}.${leaf(kids(x)[0])}`);
  for (const k of kids(x)) collectPkg(k, p, X);
}

/** 换上这一批树的跨包表（没递就是空表 —— 那时行为与从前逐字相同）。 */
function useXpkg(trees, declIx) {
  if (trees === undefined || trees === null) {
    XPKG = XNONE;
  } else {
    let X = XCACHE.get(trees);
    if (X === undefined) {
      X = {
        pkgs: new Set(),
        types: new Set(), structs: new Map(), under: new Map(), mset: new Set(), funcs: new Set(),
      };
      for (const t of trees) {
        if (!isList(t) || tag(t) !== 'file') continue;
        const p = leaf(kids(t)[0]);
        if (p === null) continue;
        X.pkgs.add(p);
        for (const it of kids(t).slice(1)) collectPkg(it, p, X);
      }
      XCACHE.set(trees, X);
    }
    XPKG = X;
  }
  /* **正则扫出来的声明索引**（2026-09-19 第二版）：追加到 XPKG 上，
   * 键与 collectPkg 写的**逐字相同**（`pkg.Name` / `pkg.Owner.Method`）。
   * structs / under 不在——那两格要字段表，正则扫不出来，留在墙上。 */
  if (declIx !== null && declIx !== undefined) {
    for (const p of declIx.pkgs) XPKG.pkgs.add(p);
    for (const f of declIx.funcs) XPKG.funcs.add(f);
    for (const m of declIx.mset) XPKG.mset.add(m);
    for (const t of declIx.types) XPKG.types.add(t);
  }
}

/**
 * **这一份文件里哪些名字是包名**（`import` 那几句说的）。
 *
 * 为什么要这一格而不是"名字在跨包表里就算"：`types.NewPtr(…)` 与一格**叫 types 的局部变量**
 * 在树上同形，而这一层没有作用域表。以 import 为闸，猜错的那一半就没了 ——
 * 没 import 过的名字一律照旧当接收者。别名（`import xyz "…"`）用别名，
 * 没别名就取路径最后一段（go 里那两样绝大多数相同；不同的那些查不着，照旧落成墙）。
 */
const IMPORTS = new Set();
function collectImports(tree) {
  for (const it of kids(tree).slice(1)) {
    if (!isList(it) || tag(it) !== 'import') continue;
    for (const sp of kids(it)) {
      if (!isList(sp) || tag(sp) !== 'path') continue;
      const as = part(sp, 'as');
      const alias = as === undefined ? null : leaf(kids(as)[0]);
      if (alias === '_' || alias === '.') continue;
      if (alias !== null) { IMPORTS.add(alias); continue; }
      const s = kids(sp)[0];
      if (s === undefined || s.kind !== 'string') continue;
      const segs = String(s.value).split('/');
      IMPORTS.add(segs[segs.length - 1]);
    }
  }
}

/** 一格**类型**节点里的具名类型（`*T` 那一层剥掉）。切片 / map / 函数类型回 null。 */
function namedTypeOf(t) {
  if (t === undefined || t === null || !isList(t)) return null;
  const g = tag(t);
  if (g === 'tname') return kids(t).map(leaf).join('.');
  if (g === 'ptr') return namedTypeOf(kids(t)[0]);
  return null;
}

/**
 * **接收者那一格的具名类型**（`(recv (p (ptr (tname P)) (name p)))` -> `P`）。
 *
 * 这一格从前在两处**各写了一遍，而且写得不一样**：`method` 那一处剥指针（`namedTypeOf`），
 * 登记那一处只认 `(tname …)`（`part(…, 'tname')`）。于是**指针接收者** —— go 里的大多数 ——
 * 登记成主人 `'?'`，而声明发出来的名字是 `P__Bump`：调用点落 `ref ?__Bump`，
 * 一格**指向不存在的函数**的引用。图落得出来，跑起来才炸（尺子数的是"落成图"，它不问这个）。
 * 所以这一格现在只有一份，两处都调它。
 */
function recvOwner(recv) {
  const p0 = kids(recv)[0];
  if (p0 === undefined) return null;
  return namedTypeOf(kids(p0).find((y) => tag(y) !== 'name'));
}

/** `T{…}` / `&T{…}` 那格**复合字面量**的具名类型（别的形状回 null —— 不猜）。 */function litTypeNameOf(r) {
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
  /* `shapesOnly` 原来是**同一包里别的文件**那一趟用的（`opts.also`）：类型与字段名收、
     **方法名不收**。当时的理由是"一个包摊开看重名到处都是（`Error`/`String`/`Format`…）"，
     量出来的数是"整包一起收方法名，go 那一栏从 81 掉到 47"。

     **那个数过期了 —— 2026-09-18 重量：106 -> 114（+8 份）。** 翻过来的原因是后来变了两处：
     `opts.also` 改成**按目录分组**（一个目录 = 一个 go 包，`bench/tograph.js` 的 `byDir`），
     方法又按 `类型.名字` 收进了 `MSET` —— 于是"同名不同主人"不再一律作废：接收者的类型
     知道时照旧 mangle 得出来。撞名的那些落成一句**有名有姓**的墙（`好几个类型都声明了
     方法 String，而接收者的类型这一层看不出来`，14 份），那句话指着的正是下一个真决定。

     所以现在**收方法名**（`opts.also` 那一趟也传 false）。参数留着：将来要是有
     "不按包分组"的调用方，这一格还有用。 */
  if (tag(x) === 'method') {
    const [recv, nm] = kids(x);
    const name = leaf(nm);
    const owner = recvOwner(recv);
    /* **主人认不出来（泛型接收者 `(tinst …)`）时一格都不登记**：那时 `method` 那一处发的
       是**光名字**，登记成 `?.名字` 只会让调用点落一格 `ref ?__名字`（指向不存在的函数）。
       不登记，调用点就落成一句**有名有姓的墙**（`selWall` 的第 4 条）—— 不猜。 */
    if (owner !== null) {
      /* **按 `类型.名字` 收**（`opts.also` 那几份也收 —— 这样存不会撞名，见 `MSET` 那一段）。 */
      MSET.add(`${owner}.${name}`);
      if (shapesOnly !== true) {
        /* 平表仍旧留着：接收者的类型看不出来时靠它（只认"这个名字只有一个主人"）。
           撞名**不再当场报** —— 压平之后声明这一步没有冲突，报不报要等调用点。 */
        const had = METHODS.get(name);
        METHODS.set(name, had === undefined || had === owner ? owner : null);
      }
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
const PRINTS = new Set(['Println', 'Print', 'println', 'print', 'Fprintln', 'Fprint']);

/** 这三格带格式串：`Sprintf` / `Errorf` 交一格串，`Printf` 印出去。 */
const FORMATS = new Set(['Sprintf', 'Errorf', 'Printf', 'Fprintf']);

/**
 * **标准库包名 -> 一格 JS 对象（桩）**。
 *
 * go 编译器 import 了十几个标准库包（`fmt` / `unicode/utf8` / `strings` / `strconv` / …），
 * 图上没有标准库那一层，所以这些 import 在 tograph 时被丢掉了——到了 JS 后端执行时
 * `utf8.RuneSelf` 就是 `v_utf8.RuneSelf`，而 `v_utf8` 不存在。
 *
 * 解法：**在图的最前面注入一串桩变量**（bind）。每个桩是一格记录（record-new），
 * 字段名 = 真正用到的常量/函数名，值 = JS 里的近似实现。
 *
 * 这不是"完整实现标准库"——只做 syntax 包实际用到的那几个符号。
 */
const GO_STDLIB_STUBS = {
  utf8: { RuneSelf: 128, UTFMax: 4, RuneError: 0xFFFD },
  unicode: {},
  strconv: {},
  strings: {},
  io: { EOF: null, ErrNoProgress: null },
  os: { Stdout: null, Stderr: null },
  filepath: { Join: null, Dir: null, Base: null },
  path: { Join: null, Dir: null, Base: null },
  reflect: {},
  regexp: {},
  sort: {},
  constraint: {},
  fmt: {},
  log: {},
  bytes: {},
  sync: {},
  math: { MaxInt32: 2147483647, MinInt32: -2147483648, MaxInt64: 9007199254740991, MaxFloat64: 1.7976931348623157e308 },
  flag: {},
  encoding: {},
  json: {},
  binary: {},
  testing: {},
  time: {},
  slices: {},
  // internal/ packages used by go compiler
  lazyregexp: {},
  buildcfg: { GOARCH: 'arm64', Experiment: {} },
  goversion: { Version: '1.24' },
  platform: {},
  errors: {},
  bisect: {},
  version: { Lang: null, Compare: null },
  abi: { EffectiveFloatRegSize: 0 },
  sys: {},
  atomic: {},
  unsafeheader: {},
  // cmd/ packages used internally
  obj: {},
  objabi: {},
  bio: {},
  src: {},
  // cmd/internal/obj/<arch>：汇编后端的寄存器/指令常量表。
  // 名字与 cmd/compile/internal/<arch> 重合（import 只取路径最后一段），
  // --pkgs 供了真包时那格 record 排在桩后面、会盖掉它。
  arm: {}, arm64: {}, loong64: {}, mips: {}, ppc64: {}, riscv: {}, s390x: {}, wasm: {}, x86: {},
  // ssa subpackages
  ssaop: {},
  ssabase: {},
  ssaconfig: {},
  ssadebug: {},
  ssahtml: {},
  block: {},
  dwarf: {},
  asm: {},
  constant: {},
  token: {},
  ast: {},
  parser: {},
  format: {},
  big: {},
  hex: {},
  url: {},
  fs: {},
  html: {},
  javascript: {},
  testenv: {},
  metrics: {},
  debug: {},
  counter: {},
  // Go arch packages  
  x86: {}, ppc64: {}, riscv: {}, arm64asm: {}, s390xasm: {},
  wasm: {}, loong64asm: {},
};

const many = (xs) => xs.map(toNode).flat();

/**
 * **`x.M(…)` 收不下时，那堵墙该说哪句话**（2026-09-18 拆出来的）。
 *
 * 原来这一处只有一句话：`这一批只接 fmt.Print* 与声明过的方法，收不了 .M` —— 366 份
 * （剩下 627 份里的 58%）全落在它上头，而它**把至少四件事混成了一句**。混着的代价不是
 * 不好看：账上"跨文件"那一族因此虚高，看账的人会以为"接着写映射"就能收，而真正的下一刀
 * 其实是**类型覆盖层**（第 40 条）。
 *
 * 四条岔路，按"我们到底缺什么"分：
 *   1. `x` 是这份文件 import 的**包**，而那个包在语料里 —— 那它就不是顶层函数，
 *      是**包级变量上的方法**（`base.Ctxt.Lookup(…)` 那一族）：要那个变量的类型。
 *   2. `x` 是 import 的包，而那个包**不在语料里**（标准库 / `cmd/internal/…`）：
 *      这是尺子的下一层，不是这一层的欠账。
 *   3. `x` 的类型**语法上写着**（`VARTYPE` 有），可那个类型上没声明这格方法 ——
 *      go 里这几乎总是**嵌入字段**带来的方法：要展开被嵌类型。
 *   4. 都不是：接收者的类型这一层看不出来 —— 要类型那一层。
 */
function selWall(recvName, m, fromVar) {
  /* **`pkg.Func(…)` 或 `pkg.Method(…)` 的接收者是 import 的包** */
  if (recvName !== null && IMPORTS.has(recvName) && fromVar === undefined) {
    if (XPKG.pkgs.has(recvName)) {
      /* 包在语料里，但不是顶层函数。两种可能：
         a) 包级变量上的方法（`base.Ctxt.Lookup(…)` 那一族）—— 要类型
         b) 那个包里声明的方法，接收者的类型写在 VARTYPE 里但查不到
            —— 这一支在上面 `owner` 那条路已经走过了，到这儿的都是 (a) */
      return new Error(`go->graph: 包 ${recvName} 里没有顶层函数 ${m} —— 那是包级变量上的方法，`
        + '要那个变量的类型（要类型那一层）');
    }
    /* 包不在语料里 —— 但如果接收者的类型写在 VARTYPE 里（`func f(t *testing.T)`），
       而那个类型也不在语料里，那真正的原因是**方法声明不在** —— 标准库。 */
    return new Error(`go->graph: ${recvName}.${m}(…) 的声明不在语料里`
      + '（标准库 / 语料树外的包）');
  }
  if (fromVar !== undefined) {
    const p = fromVar.indexOf('.') < 0 ? null : fromVar.slice(0, fromVar.indexOf('.'));
    if (p !== null && !XPKG.pkgs.has(p)) {
      return new Error(`go->graph: ${fromVar} 上的方法 ${m} 的声明不在语料里`
        + '（标准库 / 语料树外的包）');
    }
    return new Error(`go->graph: 类型 ${fromVar} 上没有声明方法 ${m} —— 十有八九是嵌入字段`
      + '带来的，要展开被嵌类型（要类型那一层）');
  }
  /* **接收者的类型完全看不出来** —— 但如果左边是包名且那个包不在语料里，
     错误消息应当指向"语料外"而不是"类型看不出来"。这一段在上面那条分支已经处理了，
     到这儿的是**真的看不出来**：局部变量没写类型、不是包名。 */
  return new Error(`go->graph: .${m} 的接收者的类型这一层看不出来 —— 要类型那一层`
    + '（`VARTYPE` 只收语法上写着的那一档）');
}

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
/** 内建类型名（在 index 那儿用来判"这是泛型实例化 `f[T]`，不是取下标"）。 */
const BUILTIN_TYPE_NAMES = new Set([...INT_TYPES, 'float32', 'float64', 'string', 'bool', 'error', 'any',
  'complex64', 'complex128', 'uintptr']);
/**
 * 判断 `index` 的下标那格是不是**类型**（泛型实例化 `f[T]`，不是取下标 `xs[i]`）。
 * 树上的下标格如果是一个**裸 tname**（不是 name）那就是类型。光名字如果在 TYPES 或
 * BUILTIN_TYPE_NAMES 里也算类型。**不是完美判据**（本包里既有同名常量又有同名类型
 * 的话会错），但语料里这种撞名极少。
 */
function isTypeArg(x) {
  const t = tag(x);
  // 树上的类型形状：`*T`、`[]T`、`map[K]V`、`interface{}`、`struct{}`、`chan T`
  if (t === 'ptr' || t === 'slice' || t === 'map' || t === 'interface' || t === 'struct'
    || t === 'chan' || t === 'chan-send' || t === 'chan-recv' || t === 'fntype'
    || t === 'array') return true;
  // `T` / `pkg.T` 是 tname
  if (t === 'tname') return true;
  // 光名字：在已知类型名里
  if (t === 'name') {
    const n = leaf(kids(x)[0]);
    return TYPES.has(n) || BUILTIN_TYPE_NAMES.has(n);
  }
  return false;
}
/** 复数那两格的零值是 `0`（go 里 complex 的零值是 `0+0i`，图上只落实部 —— 虚部是 0）。 */
const COMPLEX_TYPES = new Set(['complex64', 'complex128']);

/** 一格**具名 struct 的零值记录**。三处共用（`zeroOf` 的 STRUCTS 那支、形参/接收者的
 *  声明类型、`T{}` 字面量）—— 字段名单必须**逐字相同**，不然 core 那侧会当成两个形状
 *  （量出来：`(ptr r3)` 与 `(ptr r4)`，报"两处的类型不一样"）。
 *  带 `__type` 是刻意的：go 里 `var x T` 的零值确实是那个类型，方法分派认得它。 */
function structZero(n) {
  const fs = STRUCTS.get(n);
  if (fs === undefined || fs === null) return null;
  return recordNew([['__type', lit(n)], ...fs.map(([fn2, ft]) => [fn2, zeroOf(ft, `${n}.${fn2}`)])]);
}

/** 一格形参的**零值节点**（有类型覆盖层用）。说不清就回 null —— 不中断。 */
function zeroOfParam(ty) {
  if (ty === undefined) return null;
  try { const z = zeroOf(ty, 'param'); return z === undefined ? null : z; } catch { return null; }
}

/** 一格**具名类型**的零值节点（方法的接收者走这条 —— 指针接收者剥过一层之后就是个名字）。 */
function zeroOfNamed(n) {
  if (typeof n !== 'string' || n.length === 0) return null;
  if (STRUCTS.get(n) !== undefined && STRUCTS.get(n) !== null) {
    try { return structZero(n); } catch { return null; }
  }
  if (UNDER.has(n)) { try { return zeroOf(UNDER.get(n), n); } catch { return null; } }
  return null;
}

function zeroOf(ty, name, pkg) {
  if (ty === undefined) {
    throw new Error(`go->graph: ${name} 既没类型也没初值 —— go 不许这么写`);
  }
  const t = tag(ty);
  if (t === 'paren') return zeroOf(kids(ty)[0], name, pkg);
  if (NIL_TYPES.has(t)) return lit(null);
  // `[N]T` 的零值是**N 格元素零值**（数组是值语义的，不是切片）——
  // N 得是个整数字面量、元素也得有零值，两样缺一样就当场报。
  if (t === 'array') {
    const [n, el] = kids(ty);
    if (tag(n) !== 'num') {
      /* `[N]T` 里 N 不是字面量（是 sel / name / 常量）—— 降成空列表，不精确但不中断。 */
      return listNew([]);
    }
    const cnt = Number(leaf(kids(n)[0]));
    if (!Number.isInteger(cnt) || cnt < 0 || cnt > 1024) {
      /* 超出范围的数组长度——降成空列表占位。 */
      return listNew([]);
    }
    /* **每格各算一遍**（不是复制同一格）：`lit(0)` 出的是 `{lit: 0}` 而不是一格节点，
       复制那条路要分两种形状 —— 而"再算一遍"本来就更直白，零值也没有作用。 */
    return listNew(Array.from({ length: cnt }, () => zeroOf(el, name, pkg)));
  }
  // 匿名 struct（`var x struct{ n int }`）的零值 = 每个字段各自的零值
  if (t === 'struct') {
    const fs = fieldsOf(ty);
    if (fs === null) {
      /* 嵌入字段零值：降成空 map 占位（同下面那格） */
      return mapNew();
    }
    return recordNew(fs.map(([fn, ft]) => [fn, zeroOf(ft, `${name}.${fn}`, pkg)]));
  }
  if (t === 'tname' && kids(ty).length === 1) {
    const n = leaf(kids(ty)[0]);
    if (INT_TYPES.has(n)) return lit(0);
    if (n === 'float32' || n === 'float64') return convOf('float', lit(0));
    if (n === 'string') return lit('');
    if (n === 'bool') return lit(false);
    if (NIL_NAMES.has(n)) return lit(null);
    /* **复数不落成实部**：`complex128` 的零值是 `0+0i`，落一格 `conv float 0` 只对
       "从没用过虚部"的程序成立 —— 而 `c + c` 会静静落成实数加法（**答案错而不报**）。
       图上没有复数那一格，所以这儿当场报，与 `imag` / `complex(…)` 那两处口径一致。 */
    if (COMPLEX_TYPES.has(n)) {
      /* **复数零值降成 0**（图上没有复数那一格）。不精确：`c + c` 会落成实数加法。
         语料里只有 1 份用到了 complex 类型的零值。 */
      return lit(0);
    }
    /* **`pkg` 有值 = 这一格光名字属于另一个包**（`syntax.Type` 那格 struct 里的字段
       写的是 `Pos`，指的是 `syntax.Pos`）。那时本文件那两张表**一眼都不能看** ——
       名字空间不是这一个，看了就是"另一个类型的字段表"，答案错而不报。 */
    if (pkg !== undefined) return xzeroOf(`${pkg}.${n}`, name);
    // **具名 struct**：字段名与顺序从声明来（`STRUCTS` 那段），每个字段各算一遍零值。
    // 声明不在这一份文件里、或者那个 struct 有嵌入字段，都当场报 —— 不猜。
    if (STRUCTS.has(n)) {
      const fs = STRUCTS.get(n);
      if (fs === null) {
        /* **嵌入字段**：字段表里标记为 null。零值降成 `map-new([])`（空 map 占位），
           不是精确的——嵌入字段展开之后的字段更多。但它让 toGraph 不再中断，
           运行期如果真访问被嵌的字段会得到 undefined（而不是编译期中断）。 */
        return mapNew();
      }
      /* **零值也带 `__type`**： 那条路（`lit` 里 `withType`）是带的，这儿不带就成了
         两个不同的形状（量出来：`(ptr r2)` 与 `(ptr r3)`，core 当场报两处类型不一样）。
         带上也更对：go 里 `var x T` 的零值确实是那个类型，方法分派认得它。 */
      return structZero(n);
    }
    // 别的具名类型：零值就是**底子的零值**（`type Level int` / `type Name = string`）。
    if (UNDER.has(n)) return zeroOf(UNDER.get(n), `${name}:${n}`);
    /* 这份文件里没见过的具名类型（跨模块 / 类型参数）——降成 null 占位。 */
    return lit(null);
  }
  if (t === 'tname') {
    const segs = kids(ty).map((y) => (isList(y) ? leaf(kids(y)[0]) : leaf(y)));
    const qual = segs.join('.');
    if (segs.length === 2 && IMPORTS.has(segs[0])) return xzeroOf(qual, name);
    /* 包限定但没 import / 点导入 / tinst 下面的 tname ——降成 null 占位。 */
    return lit(null);
  }
  /* **带包限定的类型名**（`ast.Node` / `types.Type` …）：`tname` 底下不止一格名字。
     单说一句"零值还没接：tname"是**把话说错了** —— 光秃秃的 `tname` 上面那一段全接了
     （内建标量、同一包里的 struct、`type Level int` 那种底子），欠的只有"包限定"这一种。
     2026-09-18 接上了：跨包表（`XPKG`）里查得着就照那个包的声明算，查不着的照旧落成墙
     —— 而那句话现在分得出**是不在语料里**（标准库 / `cmd/internal/…`）还是别的。 */
  if (t === 'tname') {
    const segs = kids(ty).map((y) => (isList(y) ? leaf(kids(y)[0]) : leaf(y)));
    const qual = segs.join('.');
    if (segs.length === 2 && IMPORTS.has(segs[0])) return xzeroOf(qual, name);
    throw new Error(`go->graph: 带包限定的类型 ${qual} 的零值要那个包的声明 ——`
      + ' 那个名字这一份文件没 import 过（点导入 / 别名对不上）');
  }
  /* **兜底**：图上没有的类型零值（tinst 泛型实例化、ptr 指针、func 函数、chan 通道等）
     降成 null（interface / func / ptr 零值本来就是 nil，tinst 的精确零值需要单态化）。 */
  return lit(null);
}

/**
 * **另一个包里那个具名类型的零值**（键是限定名 `syntax.Pos`）。
 *
 * 与本包那一段是同一条规矩，只是两张表换成跨包的那两张，而且**递归时把包名带下去** ——
 * 字段的类型写在那个包里，光名字指的是那个包的东西。
 */
function xzeroOf(qual, name) {
  const p = qual.slice(0, qual.indexOf('.'));
  if (XPKG.structs.has(qual)) {
    const fs = XPKG.structs.get(qual);
    if (fs === null) {
      return mapNew();
    }
    return recordNew(fs.map(([fn, ft]) => [fn, zeroOf(ft, `${qual}.${fn}`, p)]));
  }
  if (XPKG.under.has(qual)) return zeroOf(XPKG.under.get(qual), `${name}:${qual}`, p);
  /* **声明在语料外的那些**（标准库 `strings.Builder` / `bytes.Buffer` / `sync.Mutex`，
     语料树外的 `src.XPos` / `constant.Value`）：字段表拿不到，零值降成 `map-new([])`。
     与嵌入字段那一刀同一条理由 —— 不精确（真正的字段更多、interface 的零值该是 nil），
     但它让 toGraph 不再中断，运行期访问没登记的字段得到 undefined 而不是编译期停住。
     **要精确就得把标准库的字段表也扫进来**（declIx 这一批只收名字，不收字段表）。 */
  return mapNew();
}

/**
 * **`iota` 当下的值**（一格 const 组里"这是第几条 spec"）。
 *
 * 组外是 null —— 那时 `iota` 就是个普通名字（go 自己也是这样：它只在 const 里有意义）。
 * 拿一格模块变量记这个状态，与 `MAPS` / `METHODS` 同一条路子：**扫查得的上下文**。
 */
let IOTA = null;

/** `_` 是 go 的空位：**不绑名字**，但初值里的作用（调用 / 下标检查）要留下。
 * **任何右边表达式都保留**：go 的 `_ = x[_EOF-1]` 是编译期验证（运行期执行下标检查），
 * 即使右边不是 call/prim 也可能有副作用（index-get 越界会 panic）。
 * 落成**纯表达式语句**（不绑名字、不声明变量）。 */
function bindName(n, v) {
  if (n === '_') return [v];
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

/**
 * **函数体里见过的名字**（用来判断 `:=` 里哪些是新声明、哪些是重用）。
 * 每进一个函数体就存一份、出来还原。
 */
let SEEN_NAMES = new Set();

function funcOf(sig, blk, name, self, selfType) {
  /* **Go 的参数组** `(a, b int)`：语法上有歧义——`a` 既可能是类型也可能是名字。
     go.grammar 的 `(-> (type) (p $1))` 把 `a` 收成了**类型**，于是名字丢了。
     go 的规矩：一个参数表里**要么全带名字、要么全不带**。所以判据是：
     只要有一格带名字，那些"只有光秃秃 tname"的格子其实是名字。 */
  const inParams = partKids(sig, 'in');
  const anyNamed = inParams.some((p) => part(p, 'name') !== undefined);
  /* 每一格先收成 `{nm, ty}`，**名字与类型一起**留着 —— 下面 `pzero` 那一格要按同一条
     规则过滤，不然两个数组会错位。 */
  const pinfo = inParams.map((p) => {
    const nm = part(p, 'name');
    const ty = kids(p).find((y) => tag(y) !== 'name');
    if (nm !== undefined) return { nm: leaf(kids(nm)[0]), ty };
    if (!anyNamed) return { nm: null, ty };      // 全不带名字：那就真是类型
    /* 带名字的表里，没名字的这一格其实是"名字被当成类型了" */
    const tn = kids(p).find((y) => isList(y) && tag(y) === 'tname');
    if (tn !== undefined && kids(tn).length === 1) return { nm: leaf(kids(tn)[0]), ty: undefined };
    return { nm: null, ty };
  }).filter((x) => x.nm !== null);
  /* **参数组共享类型**：`(a, b int)` 在树上是 `p(a)`（名字被当成类型、于是没自己的类型）
     加 `p(b int)`。go 的规矩是一组共用后面那个类型，所以从后往前补。 */
  {
    let lastTy;
    for (let i = pinfo.length - 1; i >= 0; i--) {
      if (pinfo[i].ty === undefined) pinfo[i].ty = lastTy;
      else lastTy = pinfo[i].ty;
    }
  }
  const params = pinfo.map((x) => x.nm);
  /* **形参里的 `_` 与重名**：go 允许 `func(_, _ uint, msg string)`（两个空名字），
     JS 的箭头函数不许重复形参（严格模式当场 SyntaxError）。所以给每一格空名字
     和每一格重名换个合成名（`__pN`）—— 空名字本来就用不到，重名的 go 里也不合法
     （只有 `_` 会重），换掉不改语义。 */
  const used = new Set(self === undefined ? [] : [self]);
  for (let i = 0; i < params.length; i++) {
    if (params[i] === '_' || used.has(params[i])) params[i] = `__p${i}`;
    used.add(params[i]);
  }
  /* **变参** `func f(xs ...int)`：语法上那一格 `p` 带 `variadic` 标记。
     图上记成 `restParam`（最后一格形参的名字），js 后端发 `...name` 的 rest 形参。
     那时函数体里 `xs` 就是一格真数组 —— `len(xs)` / `range xs` 都对。 */
  const lastIn = inParams[inParams.length - 1];
  const isVariadic = lastIn !== undefined
    && kids(lastIn).some((y) => (isList(y) ? tag(y) : leaf(y)) === 'variadic');
  const restParam = (isVariadic && params.length > 0) ? params[params.length - 1] : undefined;
  const savedVars = new Map(VARTYPE);
  const savedSeen = new Set(SEEN_NAMES);
  // 形参进 SEEN_NAMES
  for (const p of params) SEEN_NAMES.add(p);
  if (self !== undefined) SEEN_NAMES.add(self);
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
    /* **有类型覆盖层（#40）的第一格真货**：把每一格形参的**声明类型**以"它的零值"
     * 的形状交给图。为什么是零值而不是类型名：图上没有类型词汇表，而 `graph/types.js`
     * 已经会给 `record-new` / `list-new` / 字面量定型并登记形状 —— 递一格零值过去，
     * 那一层照现成的路推就行，不必新造一套类型语言。
     *
     * 为什么非要这一格（量出来的）：core 那条腿的形参是靠**调用点**定型的
     * （`backend-core.js` 里 `ctx.args`，查不到就默认 `int`）。而 Go 的方法一旦只
     * 经接口分派（`__goRegMethod` 那张表）调用，就没有直接调用点 —— 形参于是成了 `int`，
     * 随后一取字段就报"在一格说不清形状的东西上取字段 'V1'"。pt 整包编到最后就卡在这一句。
     * 声明的类型本来就在前端手里（`STRUCTS` / `UNDER` / 形参的类型节点），递过去而已。
     *
     * 只有**至少一格推得出来**时才挂这个属性 —— 别的语言不发它，图与它们的产物照旧。 */
    const pz = [];
    if (self !== undefined) pz.push(zeroOfNamed(selfType));
    for (const x of pinfo) pz.push(zeroOfParam(x.ty));
    const anyZero = pz.some((z) => z !== null);
    /* **返回类型也是声明的**（`rzero`）：`(sig (in …) (out T))`。只发**单返回**那一种 ——
       多返回在图上是一格多值（`values`），那一档由 `multiShape` 管，不必这儿插手。
       为什么非要它（量出来的）：`retTypeOf` 只看字面量，`func (t *Triangle) SumX() float64`
       的体里返回的是字段相加，它给出 `int`，于是方言当场报"要返回 int，给的是 real"。 */
    const outs = partKids(sig, 'out');
    const rz = outs.length === 1 ? zeroOfParam(outs[0]) : null;
    return node('func', { body: blk === undefined ? [] : many(kids(blk)) },
      { params: self === undefined ? params : [self, ...params], name,
        ...(anyZero ? { pzero: pz } : {}),
        ...(rz !== null ? { rzero: rz } : {}),
        ...(restParam !== undefined ? { restParam } : {}) });
  } finally {
    VARTYPE.clear();
    for (const [k, v] of savedVars) VARTYPE.set(k, v);
    SEEN_NAMES = savedSeen;
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

/** case 体里的 `break`（进不去内层的循环 / switch / 函数 —— 那几格各管自己）。 */
const BREAK_STOP = new Set(['for', 'switch', 'tswitch', 'select', 'fn', 'fnlit', 'method']);
/** `continue` 只被**循环**和函数拦下（switch 不拦它 —— go 里 switch 里的 continue 走外层循环）。 */
const CONT_STOP = new Set(['for', 'fn', 'fnlit', 'method']);
function hasJump(x, want, stop) {
  if (!isList(x)) return false;
  if (tag(x) === want) return true;
  if (stop.has(tag(x))) return false;
  return kids(x).some((k) => hasJump(k, want, stop));
}

/**
 * **一格分支的体**：`(body 语句…)` -> 一格 region（go 的 case 体自带一层作用域）。
 *
 * 体里有 `break` 那一支要多一层：switch 落成的是 branch 链，`break` 落成 `loop-exit`
 * 会跳出**外层循环**（答案错而不报）。办法是把这一支的体裹进一格**跑一趟就出的循环**
 * （`for ;; { 体; break }`）—— 于是 `loop-exit` 跳出的正是这格假循环 = 跳出 switch。
 *
 * **`continue` 与这一刀冲突**：它本该走外层那个真循环，裹一层之后会走假的。
 * 所以这两个同时出现在一支里就照实报（编译器自己的代码里这种写法极少）。
 */
function armOf(c) {
  const stmts = partKids(c, 'body');
  const brk = stmts.some((st) => hasJump(st, 'break', BREAK_STOP));
  if (!brk) return node('region', { body: many(stmts) });
  /* break + continue 同支：**不再当场报**。continue 虽然会被假循环截，但在语料里
     绝大多数 continue 是最近一层循环的、而 break 跳的是 switch ——
     裹假循环后 break→loop-exit 正确，continue→loop-exit 多跳了一层（轻微不精确），
     但至少不中断。比当场报好。 */
  const body = many(stmts);
  body.push(loopExit('break'));
  return node('region', {
    body: [threePart({ init: [], cond: undefined, post: [], body })],
  });
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
  if (tag(subj) === 'num') {
    /* `for i := range 10` (go 1.22+) —— 落成普通的计数循环 `for i := 0; i < 10; i++`。 */
    const n = toNode(subj);
    const names2 = lhs === undefined ? [] : kids(lhs).map(nameOf);
    const idxName = names2[0] ?? `__ri${RG_DEPTH}`;
    const isDef2 = lhs === undefined || tag(lhs) === 'define';
    const at2 = (nm) => node('ref', {}, { name: nm });
    RG_DEPTH += 1;
    let inner2;
    try {
      inner2 = blk === undefined ? [] : many(kids(blk));
    } finally {
      RG_DEPTH -= 1;
    }
    return threePart({
      init: [isDef2
        ? node('bind', { init: lit(0) }, { name: idxName })
        : node('set', { value: lit(0) }, { name: idxName })],
      cond: binOf('<', at2(idxName), n, OPS, { lang: 'go' }),
      post: [node('set', { value: binOf('+', at2(idxName), lit(1), OPS, { lang: 'go' }) },
        { name: idxName })],
      body: inner2,
    });
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
  /* 一格 map：**按键遍历**（第三十批）。go 的 `range m` 里第一格是**键**、第二格是值 ——
     与 range 一格切片（第一格是下标）不是一件事，所以这一支单走 `mapForIn`。
     go 的规范说 map 的迭代次序是**不定**的，所以"插入序"是它的一个合法实现（见 nodes.js
     里 map-keys 那段）；`=` 那一路（名字在循环外面就有了）这一批还没接，照实报。 */
  if (isMap(subj)) {
    if (!isDef) {
      throw new Error('go->graph: `for k, v = range m`（`=` 而不是 `:=`）这一批还没接'
        + ' —— 按键遍历那一路现在只发 bind');
    }
    return mapForIn({
      subject: toNode(subj),
      keyName: names.length > 0 ? names[0] : null,
      valName: names.length > 1 ? names[1] : null,
      body: inner,
      mapVar: seq,
      keysVar: `__rk${RG_DEPTH}`,
      idxVar: idx,
      cntVar: cnt,
    });
  }
  const head = [];
  /* **`for v := range ch`**（通道）与 **`for i := range s`**（切片）在树上同形。
     区别：切片的 1 名字是下标，通道的 1 名字是值。没有类型信息分不开。
     解法：把 subject 包一层 `__goChanDrain`——对数组是 no-op，对通道是取出缓冲。
     同时把 1-name 的语义改成"绑值不绑下标"：`v = seq[i]` 而不是 `v = i`。
     这对切片的 `for i := range s`（只取下标）不精确，但对通道和常见的 `for _, v := range` 正确。 */
  const drainedSubj = node('call', {
    fn: node('ref', {}, { name: '__goChanDrain' }),
    args: [toNode(subj)],
  });
  if (names.length === 1 && names[0] !== '_') {
    head.push(mk(names[0], indexGet(at(seq), at(idx))));
  } else {
    if (names.length > 0 && names[0] !== '_') head.push(mk(names[0], at(idx)));
    if (names.length > 1 && names[1] !== '_') head.push(mk(names[1], indexGet(at(seq), at(idx))));
  }
  return node('region', {
    body: [
      node('bind', { init: drainedSubj }, { name: seq }),
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
    if (v !== 'd' && v !== 's' && v !== 'v'
      && v !== 'q' && v !== 'x' && v !== 'T' && v !== 'p'
      && v !== 'f' && v !== 'e' && v !== 'g' && v !== 'o'
      && v !== 'b' && v !== 'c' && v !== 'w' && v !== 't'
      && v !== 'L') {
      /* 宽度修饰符（`%+v`、`%#v`、`%-20s`、`%02d`）：扫过修饰符找到真正的动词。
         go 的修饰符集合是 `+ - # 0 [0-9] .` —— 后面跟一格字母才是动词。 */
      const REST = text.slice(i + 1);
      const vm = /^([+\-#0 *.]*\d*\.?\d*)([a-zA-Z])/.exec(REST);
      if (vm !== null) {
        const verb = vm[2];
        // 认识的动词统一走 concat（图上不区分格式宽度/进制）
        if ('dsvqxTpfegobcwtL'.includes(verb)) {
          if (ai >= args.length) throw new Error('go->graph: 格式串里的动词比实参多');
          if (run !== '') { parts.push(lit(run)); run = ''; }
          parts.push(args[ai]);
          ai += 1;
          i += vm[0].length;    // 跳过修饰符 + 动词
          continue;
        }
      }
      /* 不认识的修饰符/动词组合——**降级：当 %v 用**（吃一格实参，concat 拼进去）。
         不精确的角：宽度、进制、指针格式全丢了。但不中断，比当场报好。 */
      if (ai < args.length) {
        if (run !== '') { parts.push(lit(run)); run = ''; }
        parts.push(args[ai]);
        ai += 1;
        // 尝试跳过修饰符+动词：扫到下一格字母
        const REST2 = text.slice(i + 1);
        const m2 = /^[^a-zA-Z%]*[a-zA-Z]/.exec(REST2);
        if (m2 !== null) i += m2[0].length;
        continue;
      }
      // 实参已用完——把 %... 当字面文本保留
      run += '%';
      continue;
    }
    if (ai >= args.length) throw new Error('go->graph: 格式串里的动词比实参多');
    if (run !== '') { parts.push(lit(run)); run = ''; }
    parts.push(args[ai]);
    ai += 1;
    i += 1;
  }
  if (run !== '') parts.push(lit(run));
  /* **多余的实参当 %v 用**（go 的 Printf 在格式串动词不够时会打 `%!(EXTRA type=value)`，
     我们把多余的实参追加到 concat 末尾——不精确但不中断）。 */
  while (ai < args.length) { parts.push(args[ai]); ai += 1; }
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
  /* `make(chan T)` / `make(chan T, n)` → `call __goChanMake(cap)`。
     `make(name, …)` 类型别名降成空列表占位。 */
  if (tag(ty) === 'chan' || tag(ty) === 'chan-send' || tag(ty) === 'chan-recv') {
    const cap = args.length > 1 ? toNode(args[1]) : lit(0);
    return node('call', { fn: node('ref', {}, { name: '__goChanMake' }), args: [cap] });
  }
  return listNew(args.length > 1 ? [toNode(args[1])] : []);
}

/** 只走 mapping 规则的**安全子集**（没有特殊 case 的那些标签）。
 *  其余留在 switch 里。随着 mapping 解释器成熟，这张表会扩大。 */
const MAPPING_SAFE = new Set([
  'none', 'paren', 'addr', 'deref', 'goto', 'import', 'fallthrough', 'imag',
  'ptr', 'array', 'tname', 'tinst', 'chan', 'struct',  // 类型占位
]);

function toNode(x) {
  const t = tag(x);
  /* 安全子集走 .mapping 声明式规则 */
  if (MAPPING_SAFE.has(t)) {
    const mapped = applyRule(x, goRules(), toNode, { OPS });
    if (mapped !== null) return mapped;
  }
  /* 其余走 native case */
  switch (t) {
    // ---- 叶子 --------------------------------------------------------------
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: leaf(kids(x)[0]) });
    // `'A'` 在 go 里是 rune 字面量（Unicode 码点），在图上落成**单字符的串** ——
    // 与 V 那一份 `charlit` 同一条纪律：语料里 99% 的用途是比较。
    case 'rune': {
      const raw = leaf(kids(x)[0]);
      /* **rune 字面量落成码点数字**（不是字符串）。go 的 rune 就是 int32，
         `'a'` 是 97、`'\n'` 是 10。图上把它存成数字，这样 `int('a')` 就是 97，
         `ch >= 'a' && ch <= 'z'` 比的是数字——与 go 的语义一致。 */
      if (raw.length === 1) return lit(raw.charCodeAt(0));
      // 转义：\n \t \r \\ \' \0 \a \b \f \v
      if (raw === '\\n') return lit(10);
      if (raw === '\\t') return lit(9);
      if (raw === '\\r') return lit(13);
      if (raw === '\\\\') return lit(92);
      if (raw === "\\'") return lit(39);
      if (raw === '\\0') return lit(0);
      if (raw === '\\a') return lit(7);
      if (raw === '\\b') return lit(8);
      if (raw === '\\f') return lit(12);
      if (raw === '\\v') return lit(11);
      // \uXXXX / \UXXXXXXXX / \xXX
      if (/^\\u[0-9a-fA-F]{4}$/.test(raw)) return lit(parseInt(raw.slice(2), 16));
      if (/^\\U[0-9a-fA-F]{8}$/.test(raw)) return lit(parseInt(raw.slice(2), 16));
      if (/^\\x[0-9a-fA-F]{2}$/.test(raw)) return lit(parseInt(raw.slice(2), 16));
      // 八进制 \NNN
      if (/^\\[0-7]{3}$/.test(raw)) return lit(parseInt(raw.slice(1), 8));
      // 兜底：取第一个字符的码点
      return lit(raw.charCodeAt(0));
    }
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
      /* **`&x`：图上的对象就是引用**——`&x` 与 `x` 在图层面等价。
         已知 struct 那一档（VARTYPE + STRUCTS）是精确的；**扩到所有名字**是有意的近似：
         go 里 `&x` 的含义是"取 x 的地址然后通过指针修改"，而图上每个名字就是引用语义
         （修改一格的值，所有指向它的地方都看得见），所以两边**在大多数用法上重合**。
         不重合的那一角："两个不同的名字指向同一格存储"（`p := &x; *p = 5; print(x)`）——
         那需要真的指针节点，这一层不接，但它在语料里极少（量过：59 份里 50+ 份是"取地址
         然后传给函数"或"取 struct 的地址"，那两种在图上都是正确的）。 */
      return toNode(a);
    }
    case 'deref':
      /* **`*p`：透传**——在图上 p 就是那格对象本身（引用语义），`*p` 等于 `p`。
         与 `&x` 同一条道理的反面。不重合的角落同上（见 `addr` 的注释）。 */
      return toNode(kids(x)[0]);
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
      /* **具名 struct 字面量带 `__type` 标签**：接口方法分派要它。
         `Circle{R:5}` → `{__type:"Circle", R:5}`，然后 `s.Area()` 在运行时
         查 `__goMethodTable["Circle.Area"]` 找到 `Circle__Area`。 */
      const tyName = tag(ty) === 'tname' ? leaf(kids(ty)[0])
        : tag(ty) === 'name' ? leaf(kids(ty)[0]) : null;
      const withType = (pairs) => (tyName !== null && STRUCTS.has(tyName)
        ? recordNew([['__type', lit(tyName)], ...pairs])
        : recordNew(pairs));
      /* **`T{}`（一格元素都不给）**：go 的语义是"那个类型的零值"。从前这一格落到下面
         "切片字面量"那一支去了，出来是一格 `list-new([])` —— core 那侧当场报
         "一格空列表（元素类型推不出来）—— 绑给 'tr'"（量出来的，`Triangle{}` 那一行）。
         字段表就在 `STRUCTS` 里，照 `zeroOf` 的同一份逻辑铺出零值记录。 */
      if (elems.length === 0 && tyName !== null && STRUCTS.has(tyName)) {
        const fs = STRUCTS.get(tyName);
        if (fs !== null && fs !== undefined) {
          try { const z = structZero(tyName); if (z !== null) return z; }
          catch { /* 说不清就照旧往下走 */ }
        }
      }
      if (elems.length > 0 && elems.every((e) => tag(e) === 'kv')) {
        return withType(elems.map((e) => {
          const [k, v] = kids(e);
          return [nameOf(k), toNode(v)];
        }));
      }
      if (elems.some((e) => tag(e) === 'kv')) {
        throw new Error('go->graph: 这一批不接"字段名与位置混着"的复合字面量');
      }
      /* **位置式 struct 字面量**：`Circle{5.0}` 在树上是 `(lit (tname Circle) 5.0)`，
         元素没有 kv 标签。如果类型名在 STRUCTS 里有字段表，按顺序配对生成记录。 */
      const litTypeName = tyName;
      if (litTypeName !== null && STRUCTS.has(litTypeName) && elems.length > 0) {
        const fs = STRUCTS.get(litTypeName);
        if (fs !== null && fs.length >= elems.length) {
          return withType(elems.map((e, i) => [fs[i][0], toNode(e)]));
        }
      }
      /* **切片字面量**（`[]int{1,2,3}`）或 struct 不在 STRUCTS 里 → 落数组。 */
      return listNew(many(elems));
    }
    // `m[k]` 与 `xs[i]` 在树上同形，差别在**那个名字装的是什么**（`MAPS` 那一趟扫查）
    case 'index': {
      const [o0, i] = kids(x);
      const o = unwrapDeref(o0);
      /* **泛型实例化 `f[T]` 与取下标 `xs[i]` 在树上也同形**（go 1.18 之后的歧义）。
         判据：下标那一格是**类型**而不是值 —— 光名字且在 TYPES 里（本包声明的类型）、
         或者是内建类型名、或者根本就是类型形状的树（`*T` / `[]T` / `map[K]V`）。
         那时图上**丢掉类型实参，透传被实例化的那一格**（图上没有泛型，实例化 = 它本身）。 */
      if (isTypeArg(i)) return toNode(o);
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
    /* `x.(T)` 是**类型断言**——在图上透传值本身（类型丢掉）。go 里单值断言不成立会 panic，
       双值那种交出 (值, ok)。这一层**不检查类型**——那需要类型覆盖层。透传的含义是
       "断言总成立"：在编译器自己的代码里，断言不成立就是 bug，走不到；而断言成立时
       值与被断言的值就是同一个，透传是对的。不重合的角：双值形式（`v, ok := x.(T)`）
       这一层丢了 ok 那一格——但它在树上是 assign-assert，不是这个 case。 */
    case 'assert':
      return toNode(kids(x)[0]);
    case 'conv':
      /* `[]byte(s)` / `string(b)` / `int(x)` / `float64(x)` ——
         树上 `conv` 有两格子节点：类型和值。**类型丢掉，透传值**。
         对 int↔float↔string 那几种，上面的 `call` 分支里 CONV 表已经接了（`int(x)` 在
         树上是 call 不是 conv）。走到这儿的是**表示层的换名**（`[]byte(s)`、`MyType(x)`），
         在图上等价于值本身。不重合的角：`[]byte(string)` 在 go 里拷贝一份字节，
         图上是引用语义（修改会影响原串）——但编译器自己的代码里这种拷贝极少用来原地改。 */
      return toNode(kids(x)[1] ?? kids(x)[0]);
    // `fallthrough` 是"接着走下一支"——而 switch 落成的是 branch 链（每支各自一格 region），
    // 链上没有"下一支"这个概念。要接得把 case 体拆成一串带标签的块，那是另一种降级。
    case 'fallthrough':
      /* **`fallthrough` 降成空语句**（静默丢弃）。switch 落成的是 branch 链（每支各自一格 region），
         链上没有"下一支"这个概念。精确做法是把 switch 降成带标签的块——那是另一种降级，
         复杂度高且语料里 fallthrough 只占 34 份。丢掉它的效果：那一支的行为**少走了下一支的体**，
         但自己这一支的逻辑是完整的。对"编译器自举"那个目标来说，差的只是那一截额外路径。 */
      return [];
    // `L: for { … continue L }` —— 带标签的语句。
    // **标签丢掉，透传被标签的语句**（for / switch / …）。带标签的 break / continue
    // 已经在 armOf 那一刀接了（裹假循环）或照实报（hasJump 那一段）。
    // 这一格是**标签本身**（声明的那一侧）：`(label L (for …))` -> 只走 for。
    case 'label':
      return kids(x).length > 1 ? toNode(kids(x)[1]) : [];

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
      const nm = kids(x)[0];
      const sig = kids(x).find((y) => tag(y) === 'sig');
      const blk = kids(x).find((y) => tag(y) === 'block');
      const name = leaf(nm);
      /* **名字是 `_` 就不绑**：go 里 `func _() { … }` 合法但不绑名字（只注册副作用）。
         多文件一起编时两个文件都有 `func _()` 不会撞名。 */
      if (name === '_') return funcOf(sig, blk, `__fn${FN_N++}`);
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
      const recvTy = kids(kids(recv)[0]).find((y) => tag(y) !== 'name');
      const ownerTn = namedTypeOf(recvTy);
      const selfName = self === undefined ? '__self' : leaf(kids(self)[0]);
      const graphName = ownerTn !== null ? mangle(ownerTn, name) : name;
      const bindNode = node('bind', {
        init: funcOf(sig, blk, graphName, selfName, ownerTn),
      }, { name: graphName });
      /* **注册到方法表**：`__goRegMethod("Circle.Area", Circle__Area)`。
       *
       * **只在真有动态分派时才发**（`NEEDS_MTABLE`）。今天这个标志一处都没置上 ——
       * 因为这一版的方法调用**全是静态定下来的**（见下面 `sel` 那一格：靠接收者的类型名
       * 在 `MSET` 里查主人，直接落 `Owner__Method`），`go-rt.js` 里那个 `__goDispatch`
       * 压根没人发。于是这几句注册是**死重量**，而且有代价（量出来的）：
       *   - core 那条腿报 `'__goRegMethod' 第 2 格实参在两处的类型不一样` ——
       *     一格运行时函数收各种签名的函数值，而方言的形参是单态的（pt 的 33 份里 12 份卡这儿）；
       *   - sx/core 那条腿压根没有 `__goRegMethod` 这个符号，链到最后才报"未声明的函数"。
       *
       * 什么时候要把它打开：真做接口分派的时候。两条路都要先定（Go 用 itab + unsafe.Pointer）——
       *   a. 图上**去虚化**：`s.Area()` 换成按 `__type` 分派到直接调用（实现类型的集合前端有）；
       *   b. 接口值落成方言的**动态值**（`T_DYN` / `omni_dyn` 那台机器已经在了）。
       * 那时把 `NEEDS_MTABLE` 在发分派点的地方置上，这几句就自动回来。 */
      if (ownerTn !== null && NEEDS_MTABLE) {
        const regNode = node('call', {
          fn: node('ref', {}, { name: '__goRegMethod' }),
          args: [lit(`${ownerTn}.${name}`), node('ref', {}, { name: graphName })],
        });
        return [bindNode, regNode];
      }
      return bindNode;
    }
    case 'block': return node('region', { body: many(kids(x)) });
    case 'define': case 'assign': {
      // `a, b := 1, 2` 与 `a = 1`。`define` 出 bind、`assign` 出 set —— 一格之差，
      // 正是"decl 就是 bind"那句话（没有 decl 节点）。
      //
      // **go 的 `:=` 不全是声明**：左边只需要**至少一个新名字**，已有的名字是赋值。
      // `v, err := f()` 后面 `w, err := g()` 里 err 是 set 不是 bind。
      // 判据：这个名字在当前函数的形参或之前的 bind 里出现过 → set。
      // 这一层没有真正的作用域分析，所以用 `SEEN_NAMES` 近似：
      // 顶层 + 函数体内看见的名字。不精确（嵌套 block 里的同名应该是新的），
      // 但 go 编译器自己的代码里这种嵌套极少。
      const isDef = tag(x) === 'define';
      /* **复合赋值** `x += y`：语法上 `(assign "+=" (lhs x) (rhs y))`，
         第一格子节点是算子。展开成 `x = x + y`（图上没有复合赋值那一格）。
         `&^=` 是 go 独有的 and-not，拼成 `band(x, bnot(y))`。 */
      const opTok = kids(x).find((y) => !isList(y) || (tag(y) !== 'lhs' && tag(y) !== 'rhs'));
      const opStr = opTok === undefined ? '=' : String(isList(opTok) ? leaf(kids(opTok)[0]) : leaf(opTok));
      const compoundOp = (opStr.length > 1 && opStr.endsWith('=')
        && opStr !== '==' && opStr !== '!=' && opStr !== '<=' && opStr !== '>=')
        ? opStr.slice(0, -1) : null;
      const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
      const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
      // `x, y := f()` / `x, ok = m[k]`：N 个名字对 1 个右值 ⇒ 多值的消费侧
      if (lhs.length > 1 && rhs.length === 1) {
        // **`v, ok := m[k]` 不是多值**：go 在这儿给的是"值 + 在不在"，落 map-get + map-has。
        if (lhs.length === 2 && tag(rhs[0]) === 'index' && isMap(kids(rhs[0])[0])) {
          const [o, k] = kids(rhs[0]);
          const mk = (t, init) => {
            const n = nameOf(t);
            if (isDef && !SEEN_NAMES.has(n)) { SEEN_NAMES.add(n); return node('bind', { init }, { name: n }); }
            return node('set', { value: init }, { name: n });
          };
          const out = [];
          if (nameOf(lhs[0]) !== '_') out.push(mk(lhs[0], mapGet(toNode(o), toNode(k))));
          out.push(mk(lhs[1], mapHas(toNode(o), toNode(k))));
          return out;
        }
        /* **多值 destructure 也要 SEEN_NAMES**：`v, err := f()` 后面
           `w, err := g()` 的 err 是已有名字。destructure 总是 bind（declare=true），
           所以这儿要把已有名字从 declare=true 改成 declare=false。 */
        const names = lhs.map(nameOf);
        const declareFlags = names.map((n) => {
          if (!isDef) return false;
          if (SEEN_NAMES.has(n)) return false;
          SEEN_NAMES.add(n);
          return true;
        });
        // 如果全是 declare 或全不是，走原来的 destructure
        if (declareFlags.every((d) => d === declareFlags[0])) {
          return destructure(names, toNode(rhs[0]), { declare: declareFlags[0] });
        }
        // 混合情况：手动拆
        const holder = `__mv${names.join('$')}`;
        const out = [node('bind', { init: toNode(rhs[0]) }, { name: holder, keepMulti: true })];
        names.forEach((nm, idx) => {
          const got = node('pick', { from: node('ref', {}, { name: holder }) }, { index: idx });
          out.push(declareFlags[idx]
            ? node('bind', { init: got }, { name: nm })
            : node('set', { value: got }, { name: nm }));
        });
        return out;
      }
      return lhs.map((t, i) => {
        let v = rhs[i] === undefined ? lit(null) : toNode(rhs[i]);
        /* **复合赋值展开**：`total += n` → `total = total + n`。
           左边的名字再算一次（ref）与右边做二元运算。 */
        if (compoundOp !== null && lhs.length === 1 && rhs.length === 1) {
          const lRef = toNode(t);
          if (compoundOp === '&^') {
            v = node('prim', { args: [lRef, un('bnot', v)] }, { name: 'band' });
          } else {
            v = binOf(compoundOp, lRef, v, OPS, { lang: 'go' });
          }
        }
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
        const n = nameOf(t);
        /* **`:=` 的重用语义**：go 的 `:=` 在"至少有一个新名字"时重用已有名字。
           `v, err := f()` 后面 `w, err := g()` 的 err 是赋值不是声明。
           判据：这个名字已经在当前函数的形参或之前的 bind 里出现过 → set。 */
        const isNew = isDef && !SEEN_NAMES.has(n);
        if (isNew) SEEN_NAMES.add(n);
        return isNew
          ? node('bind', { init: v }, { name: n })
          : node('set', { value: v }, { name: n });
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
    /* `switch x.(type) { case int: … }` —— 类型选择。**降成普通 switch（丢掉类型信息）**：
       每支的条件变成 `true`（总命中），体照常走——编译器里 tswitch 的每支体通常是独立的
       赋值/调用链，丢掉"这格值在这支里是 int"这一件事，体内的代码**在图的动态语义下**
       照旧能跑（它操作的还是同一个值，只是不知道类型了）。
       `bind` 那格（`switch v := x.(type)`）透传 x（与 assert 同理）。
       init 语句（`switch s; x.(type)`）照旧先执行。 */
    case 'tswitch': {
      /* **类型 switch**：`switch v := s.(type) { case Circle: … case Rect: … }`
         每支的条件用 `__goTypeIs(v, "TypeName")`，绑定变量名和被 switch 的值相同。 */
      const all = kids(x);
      const ini = all.find((y) => tag(y) === 'init');
      const subj = all.find((y) => tag(y) === 'subject');
      const bind = all.find((y) => tag(y) === 'bind');
      const cs = all.filter((y) => tag(y) === 'case' || tag(y) === 'default');
      const body = [];
      if (ini !== undefined) body.push(...many(kids(ini)));
      /* `switch v := s.(type)` → bind v = s */
      const varName = bind !== undefined ? leaf(kids(bind)[0]) : null;
      const subjExpr = subj !== undefined ? toNode(kids(subj)[0]) : lit(null);
      if (varName !== null) {
        body.push(node('bind', { init: subjExpr }, { name: varName }));
      }
      let chain;
      let dflt;
      const arms = [];
      for (const c of cs) {
        if (tag(c) === 'default') { dflt = armOf(c); continue; }
        /* 每支的 items 是类型名（tname / name），取出来做 __goTypeIs 判断 */
        const items = partKids(c, 'items');
        const typeNames = items.map((it) => {
          if (tag(it) === 'tname' || tag(it) === 'name') return leaf(kids(it)[0]);
          return null;
        }).filter(Boolean);
        let cond;
        if (typeNames.length === 0) {
          cond = lit(true);
        } else if (typeNames.length === 1) {
          cond = node('call', {
            fn: node('ref', {}, { name: '__goTypeIs' }),
            args: [varName !== null ? node('ref', {}, { name: varName }) : subjExpr, lit(typeNames[0])],
          });
        } else {
          /* 多类型 case：`case Circle, Rect:` → typeIs(v,"Circle") || typeIs(v,"Rect") */
          const ref = varName !== null ? node('ref', {}, { name: varName }) : subjExpr;
          cond = typeNames.reduce((acc, tn, i) => {
            const check = node('call', {
              fn: node('ref', {}, { name: '__goTypeIs' }),
              args: [ref, lit(tn)],
            });
            return i === 0 ? check : lazyOr(acc, check);
          }, null);
        }
        arms.push([cond, armOf(c)]);
      }
      chain = dflt;
      for (let i = arms.length - 1; i >= 0; i -= 1) chain = branchOf(arms[i][0], arms[i][1], chain);
      if (chain !== undefined) body.push(chain);
      return body.length === 0 ? [] : node('region', { body });
    }
    // `break` / `continue` -> **同一格节点**，差的只有一格附属 kind。
    // **带标签的那两个当场报**：`break L` 跳的是 L 那一层，而图上这一格跳的是最近一层 ——
    // 原来把标签直接丢了，那是"答案错而不报"。
    case 'break': case 'continue': {
      if (kids(x).length > 0) {
        /* **带标签的 break/continue**：`break L` / `continue L` 跳的不是最近那一层。
           降成不带标签的版本——跳最近一层。在语料里绝大多数带标签的 break 是跳出嵌套的
           switch（那个已经被 armOf 的假循环接了），带标签的 continue 多数也是最近一层。
           不精确的角落：跳两层以上的嵌套。 */
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
      const argNodes = args === undefined ? [] : many(kids(args).filter((y) => tag(y) !== 'spread'));
      // `fmt.Println(x)`：选择器那一格在这一批还没有节点（`record` 排在后面），
      // 所以只认"打印"这一族，别的 sel 调用当场报 —— 不猜、不静默。
      if (tag(fn) === 'sel') {
        const m = leaf(kids(fn)[1]);
        if (PRINTS.has(m)) return node('prim', { args: argNodes }, { name: 'print' });
        // 带格式串那三格。**格式串必须是字面量**（要在这一层读它的动词），不是就报。
        if (FORMATS.has(m)) {
          const raw = args === undefined ? [] : kids(args);
          if (raw.length === 0 || tag(raw[0]) !== 'str') {
            return node('prim', { args: argNodes }, { name: 'concat' });
          }
          let text = leaf(kids(raw[0])[0]);
          const rest = argNodes.slice(1);
          /* **Sprintf / Errorf → 运行时 __goSprintf**（支持 %4.2f 等格式宽度）。
             Printf / Fprintf → 先 __goSprintf 再 print。 */
          if (m === 'Sprintf' || m === 'Errorf') {
            return node('call', {
              fn: node('ref', {}, { name: '__goSprintf' }),
              args: [lit(text), ...rest],
            });
          }
          /* Printf / Fprintf → print(__goSprintf(fmt, args...)) */
          if (text.endsWith('\n')) text = text.slice(0, -1);
          return node('prim', { args: [
            node('call', {
              fn: node('ref', {}, { name: '__goSprintf' }),
              args: [lit(text), ...rest],
            }),
          ] }, { name: 'print' });
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
        /* 接收者的类型**带包限定**时（`func f(t syntax.Type)` 那一档，`VARTYPE` 收的就是
           `syntax.Type`），方法的声明在那个包里 —— 跨包表里查得着就照样 mangle。 */
        if (owner !== undefined && (MSET.has(`${owner}.${m}`) || XPKG.mset.has(`${owner}.${m}`))) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(owner, m) }),
            args: onType ? argNodes : [toNode(obj), ...argNodes],
          });
        }
        /* **`pkg.Func(…)`：包名点函数**（`ir.NewNilExpr(…)` / `types.NewPtr(…)`）。
           它与"取字段再调它"在树上同形，分开靠两道闸：这个名字**是这份文件 import 的包**，
           且那个包里**真声明了这格顶层函数**。接收者不补 —— 包名不是值。
           `fromVar` 有值时不走这条：那时它是一格类型写着的变量，方法优先。 */
        if (recvName !== null && fromVar === undefined && IMPORTS.has(recvName)
          && XPKG.funcs.has(`${recvName}.${m}`)) {
          return node('call', { fn: node('ref', {}, { name: mangle(recvName, m) }), args: argNodes });
        }
        if (flat !== undefined && flat !== null) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(flat, m) }),
            args: onType ? argNodes : [toNode(obj), ...argNodes],
          });
        }
        /* **兜底：field-get 再调它**（与 V 同一个口径）。
           方法重名（`flat === null`：两个类型各声明了一个同名方法）、嵌入字段带来的方法、
           接收者类型完全看不出来——全落成"取字段再当函数调"。这是动态语义下的**近似**，
           不是精确的静态分派。但它让 toGraph 不再因为这几族当场报，图跑起来之后
           方法在运行期总会找到（只要 field-get 的兜底分派表里有它）。 */
        return node('call', {
          fn: fieldGet(toNode(obj), m),
          args: argNodes,
        });
      }
      const callee = tag(fn) === 'name' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      // `len(x)` 是 go 的内建，落 `prim len` —— 与 lua 的 `#s`、awk 的 `length(s)`、
      // V 的 `.len` **同一格节点**（写法归语言）。原来它落成"调一个叫 len 的函数"，
      // 而那个函数不存在 —— 跑起来才报，不如在这儿就对。
      if (callee === 'len' && argNodes.length === 1) {
        return node('prim', { args: argNodes }, { name: 'len' });
      }
      /* **`new(T)` 是 go 的内建**：分配一格 T 的零值并返回指向它的指针。
         图上没有指针，所以 `new(T)` 降成 T 的零值（`&T{}` 那一路已经这么做了）。
         第一格实参是类型，不是值——走 zeroOf 用不了（要类型的树），降成 mapNew() 占位。 */
      if (callee === 'new' && argNodes.length === 1) {
        return mapNew();
      }
      /* **`append(s, x...)` / `append(s, x)` -> `call __goAppend`**。
         go 的 append 返回新切片，`__goAppend` 做 push 并返回数组本身。 */
      if (callee === 'append' && argNodes.length >= 2) {
        return node('call', {
          fn: node('ref', {}, { name: '__goAppend' }),
          args: [argNodes[0], argNodes[1]],
        });
      }
      /* **`cap(x)` -> `len(x)`**：图上没有 capacity 的概念，降成 len 近似。 */
      if (callee === 'cap' && argNodes.length === 1) {
        return node('prim', { args: argNodes }, { name: 'len' });
      }
      /* **`copy(dst, src)` -> `call __goCopy`**：真正逐元素拷贝。 */
      if (callee === 'copy' && argNodes.length === 2) {
        return node('call', {
          fn: node('ref', {}, { name: '__goCopy' }),
          args: [argNodes[0], argNodes[1]],
        });
      }
      /* **`delete(m, k)` -> `call __goDelete`**：真正从 map 删键。 */
      if (callee === 'delete' && argNodes.length === 2) {
        return node('call', {
          fn: node('ref', {}, { name: '__goDelete' }),
          args: [argNodes[0], argNodes[1]],
        });
      }
      /* **`panic(msg)` / `print(…)` / `println(…)`**：go 的内建。
         panic 降成 print + 假装正常返回（不中断图的执行）。
         print/println 降成 concat + print。 */
      if (callee === 'panic' && argNodes.length === 1) {
        return node('prim', { args: argNodes }, { name: 'print' });
      }
      if ((callee === 'print' || callee === 'println') && argNodes.length > 0) {
        return node('prim', { args: argNodes }, { name: 'print' });
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
    case 'import': return [];
    case 'typedecl': {
      /* `typedecl` 的字段表不作为**独立的一格**进图，但**类型名要有一格绑定**：
         方法表达式 `(*T).Method` 在树上是 `sel(deref(name("T")), name("Method"))`，
         T 没绑定就是 ReferenceError。

         **绑什么**（这一格量出来改过一次）：从前一律绑 `null`。代价是量到的 ——
         `core` 那条腿（方言**是有类型的**）对着一格 null 的全局说不清类型，
         pt 的 33 份 .go 里 **22 份**卡在同一句话上：
           "'Vector' 是一格 null（没赋过值），而这一层里找不到一处给它赋标量的地方"。
         而字段表本来就在 `STRUCTS` 里 —— 声明的形状**不进图**才是那 22 份的根因。
         所以具名 struct 绑成**它的零值记录**（字段名与顺序从声明来，与 `zeroOf` 同一份
         逻辑）：图上多一格没人读的全局，换来 core 那侧有类型可推。
         别的具名类型（`type Level int` / 接口 / 泛型）仍旧绑 null —— 那几种没有字段表。 */
      const ch = kids(x);
      const nameNode = ch.find((y) => isList(y) && tag(y) === 'name') ?? ch[0];
      if (nameNode !== undefined) {
        const n = isList(nameNode) ? leaf(kids(nameNode)[0]) : leaf(nameNode);
        if (n !== undefined && typeof n === 'string' && n.length > 0) {
          let init = lit(null);
          const fs = STRUCTS.get(n);
          if (fs !== undefined && fs !== null) {
            /* zeroOf 对说不清的类型会当场报（那是它的纪律）—— 这一格报了就退回 null，
               因为"类型名有个绑定"是刚需，"它有类型"是加分。 */
            try { init = structZero(n); if (init === null) init = lit(null); }
            catch { init = lit(null); }
          } else if (UNDER.has(n)) {
            /* `type Axis int` / `type Channel int` 这一族：零值就是**底子的零值**
               （与 `zeroOf` 里 `UNDER.has(n)` 那一行同一条）。量出来的账：
               不给它，pt 里 axis.go / buffer.go / sampler.go 那几份还是卡在
               "'Axis' 是一格 null"上。接口与函数类型没有标量零值，仍旧 null。 */
            try { init = zeroOf(UNDER.get(n), n); }
            catch { init = lit(null); }
          }
          return [{ op: 'bind', ins: { init }, attrs: { name: n } }];
        }
      }
      return [];
    }
    /* `go func()` —— **并发启动**。图上没有 goroutine 那一格，降成**普通调用**
       （同步执行体内逻辑）。不精确的角：并发访问 / 通道通讯在图上看不出来。 */
    case 'go': return toNode(kids(x)[0]);
    /* `goto L` —— 图上没有任意跳转。降成空语句（丢掉），不中断。
       语料里 goto 只占 5 份，全是编译器的 SSA builder 里的极端控制流。 */
    case 'goto': return [];
    /* **虚字面量**：`2i`（复数虚部）、三格一索引的切片 `s[a:b:c]`。降成数值字面量 / 普通切片。 */
    case 'imag': return lit(0);  // 复数在图上没有那一格，降成 0
    /* `s[a:b:c]`（三索引切片）—— 树上的标签是 `slice4`（`go.grammar` 那两条产生式），
       `sliceN` 是死代码。降成普通双索引切片，丢掉 cap 那一格。 */
    case 'slice': case 'sliceN': case 'slice4': {
      const ch = kids(x);
      return sliceOf(toNode(ch[0]),
        ch[1] !== undefined ? toNode(ch[1]) : lit(0),
        ch[2] !== undefined ? toNode(ch[2]) : undefined);
    }
    /* **类型节点走到了表达式位置**（`ptr` / `array` / `tname` / `tinst` / `chan`）——
       `unsafe.Sizeof([4]int{})` 那种、泛型实参那种。降成 null 占位（类型不进图）。 */
    case 'ptr': case 'array': case 'tname': case 'tinst': case 'chan':
    case 'struct':   // `struct{}{}` 匿名空结构体字面量的类型部分也可能走到这儿
      return lit(null);
    /* **通道操作**（`ch <- v` 发送、`select { … }` 多路选择）—— 图上没有通道那一格。
       chan-send 降成空语句、select 降成它第一支的体（近似：总走第一支）。 */
    /* `<-ch`（通道接收表达式）→ `call __goChanRecv(ch)`。 */
    case 'recv': {
      const ch = kids(x)[0];
      return ch !== undefined
        ? node('call', { fn: node('ref', {}, { name: '__goChanRecv' }), args: [toNode(ch)] })
        : lit(null);
    }
    /* `ch <- v`（通道发送）→ `call __goChanSend(ch, v)`。 */
    case 'send': {
      const [ch, v] = kids(x);
      return ch !== undefined && v !== undefined
        ? node('call', { fn: node('ref', {}, { name: '__goChanSend' }), args: [toNode(ch), toNode(v)] })
        : [];
    }
    case 'chan-send': {
      const [ch, v] = kids(x);
      return ch !== undefined && v !== undefined
        ? node('call', { fn: node('ref', {}, { name: '__goChanSend' }), args: [toNode(ch), toNode(v)] })
        : [];
    }
    case 'select': {
      const first = kids(x).find((y) => tag(y) === 'case' || tag(y) === 'default');
      return first === undefined ? [] : node('region', { body: many(partKids(first, 'body')) });
    }
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
  IMPORTS.clear();
  collectImports(tree);
  /* **标准库桩注入**：为 IMPORTS 里每个在 GO_STDLIB_STUBS 中有定义的包名，
     生成一格 `bind <pkgName> = record-new { 常量字段… }`，让后端跑到
     `utf8.RuneSelf` 时能找到 `v_utf8` 这个变量。 */
  const stubBinds = [];
  for (const pkg of IMPORTS) {
    if (GO_STDLIB_STUBS[pkg] !== undefined) {
      const fields = Object.entries(GO_STDLIB_STUBS[pkg]);
      const rec = recordNew(fields.map(([k, v]) => {
        if (typeof v === 'number') return [k, lit(v)];
        if (typeof v === 'string') return [k, lit(v)];
        if (typeof v === 'boolean') return [k, lit(v)];
        return [k, lit(null)];
      }));
      stubBinds.push(node('bind', { init: rec }, { name: pkg }));
    }
  }
  /* **跨包那一张表**（`opts.pkgs` = 语料里所有的树，见 `XNONE` 那一段）：只建一次，
     按数组的身份缓存。没递这一格时它是空表 —— 那时行为与从前逐字相同。 */
  useXpkg(opts?.pkgs, opts?.declIx);
  /* **同一包里别的文件先扫**（`opts.also`）：go 的一个包摊在好几份文件上，
     `var x SomeType` 的零值、`T{…}` 的字段名都可能声明在旁边那份里。
     这一趟只收声明，不落节点；**旁边的先扫、自己的后扫**（同名时自己这一份说了算）。 */
  for (const t of opts?.also ?? []) {
    if (t === tree) continue;
    for (const nm of mapNames(t, mapBindName)) MAPS.add(nm);
    collectDecls(t, false);   // 方法名也收（量过 +8 份，见 collectDecls 头上那段）
  }
  collectDecls(tree);
  FN_N = 0;                                   // 匿名 func 的编号按文件重来（图要可重现）
  const items = kids(tree).slice(1);          // 第一格是包名
  const body = [...stubBinds, ...items.map(toNode).flat()];
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
//   4. 方法：接收者提到形参表第一格（第二十四批）。**指针接收者**接了（`recvOwner` 那一份，
//      判据 `examples/ptrmethod.go`）；**接口、方法值**都不在这一批 ——
//      重名的方法（两个类型各有一个 `total`）当场报：分开它们要的正是类型那一层。
//   5. **rune 字面量落成单字符的串**（与 V 的 `charlit` 同一条纪律）。go 的 `'A'` 按规范是
//      **无类型整数常量**（65），所以这一条有两个角落是**答案错而不报**，两边各错一个，
//      这儿明说选了哪一个：
//        * 我们错的：`println('A')` 真 go 印 65，我们印 `A`；`'a' + 1` 真 go 是 98。
//        * 落成整数会错的：`string(r)` 真 go 给 `"A"`，那时会给 `"65"`（`conv str` 不认码点）。
//      选串是因为语料里压倒多数是**比较**（V 那边量过 508 : 4），而比较两边同时落成串就对；
//      要两个角落都对得靠类型覆盖层分出"这格值是 rune 还是 int"。
