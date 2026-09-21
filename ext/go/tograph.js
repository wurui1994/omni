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
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, lazyOr, lazyAnd, counted,
  destructure, recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet, sliceOf, deferNow,
  mapNew, mapGet, mapSet, mapHas, mapNames, mapForIn, isList, assertOf,
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
/**
 * **那些名字装的是哪一种 map**（名字 -> `(map K V)` 这格类型节点）。
 *
 * 为什么要它：go 的 `m[k]` 在**缺键时给零值**，而方言的 `dget` 缺键是**运行期错误**
 * （`nodes.js` 上 `map-get` 那句"缺键是错误，默认值归语言"）。所以 `m[k]` 要落成
 * `branch (map-has …) (map-get …) 零值` —— 而"零值"得知道值类型。
 * 量出来的代价：从前 `v, ok := m["不在的键"]` 与 `m["不在的键"]` 都是 **abort**，
 * go 给的是 `0` / `false`。这一格与 MAPS 同一趟扫查填好（名字不分作用域，与 MAPS 同）。
 */
const MAPTY = new Map();

/** 一格 `(define (lhs (name m)) (rhs (lit (map …) …)))` -> `'m'`（不是就给 null）。 */
function mapBindName(x) {
  if (!isList(x) || (tag(x) !== 'define' && tag(x) !== 'assign')) return null;
  const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
  const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
  for (let i = 0; i < lhs.length; i++) {
    if (isMapCtor(rhs[i]) && tag(lhs[i]) === 'name') {
      const nm = leaf(kids(lhs[i])[0]);
      /* 顺手记下那格 `(map K V)`（见 `MAPTY` 那段账）：字面量的类型在第一格孩子上，
         `make(map[K]V)` 的在第一格实参上。 */
      const ty = mapCtorTy(rhs[i]);
      if (ty !== null && !MAPTY.has(nm)) MAPTY.set(nm, ty);
      return nm;
    }
  }
  return null;
}

/** 一格"造 map"的右值里那格 `(map K V)` 类型节点（说不清给 null）。 */
function mapCtorTy(r) {
  if (r === undefined || r === null || !isList(r)) return null;
  if (tag(r) === 'lit') {
    const t = kids(r)[0];
    return t !== undefined && isList(t) && tag(t) === 'map' ? t : null;
  }
  if (tag(r) !== 'call') return null;
  const as = kids(r).find((y) => tag(y) === 'args');
  const a0 = as === undefined ? undefined : kids(as)[0];
  return a0 !== undefined && isList(a0) && tag(a0) === 'map' ? a0 : null;
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
  if (ty !== undefined && tag(ty) === 'map') {
    for (const n of names) if (!MAPTY.has(n)) MAPTY.set(n, ty);   // 见 MAPTY 那段账
    return names;
  }
  const ini = part(x, 'init');
  if (ini === undefined) return [];
  const rhs = kids(ini);
  return names.filter((n, i) => {
    const r = rhs[i];
    if (r === undefined || tag(r) !== 'lit' || tag(kids(r)[0]) !== 'map') return false;
    if (!MAPTY.has(n)) MAPTY.set(n, kids(r)[0]);
    return true;
  });
}


/**
 * **装着通道的那些名字**（与 `MAPS` 同一条路数：扫查得的上下文）。
 *
 * 两处要它，都是"树上同形、差别在那个名字装的是什么"：
 *   * `len(ch)` —— 通道上它是 `omni_go_chan_len`，切片上才是 `prim len`；
 *   * `for v := range ch` —— 通道上是"收到关为止"，切片上是按下标走。后者还没接，
 *     所以这一格是为了**报得出那句话**（从前两种一律当切片，通道那种给的是错答案）。
 *
 * 收三处：`var ch chan T`（类型写着）、`ch := make(chan T, n)`（右边是 make chan）、
 * 形参 `func f(ch chan T)`。字段与从函数回来的那些不收 —— 那时落回"当切片"，
 * 与 `MAPS` 的口径一样（没登记的就当序列）。
 */
const CHANS = new Set();
/** 这格类型是不是通道（三种方向都算）。 */
const isChanTy = (ty) => ty !== undefined && ty !== null && isList(ty)
  && (tag(ty) === 'chan' || tag(ty) === 'chan-send' || tag(ty) === 'chan-recv');
/** 一格 `spec` 里**装通道的名字**（照 `specMapNames` 的样子写）。 */
function specChanNames(x) {
  const nm = part(x, 'names');
  if (nm === undefined) return [];
  const names = kids(nm).map(leaf);
  const ty = kids(x).find((y) => tag(y) !== 'names' && tag(y) !== 'init');
  if (isChanTy(ty)) return names;
  const ini = part(x, 'init');
  if (ini === undefined) return [];
  const rhs = kids(ini);
  return names.filter((n, i) => isMakeChan(rhs[i]));
}
/** 这格右值是不是 `make(chan T, …)`。 */
function isMakeChan(r) {
  if (r === undefined || r === null || !isList(r) || tag(r) !== 'call') return false;
  const [f, as] = kids(r);
  if (f === undefined || tag(f) !== 'name' || leaf(kids(f)[0]) !== 'make') return false;
  return as !== undefined && isChanTy(kids(as)[0]);
}

/**
 * **装着无符号整数的那些名字**（与 `MAPS` / `CHANS` 同一条路数：扫查得的上下文）。
 *
 * 干什么用：`x >> k` / `x / y` / `x % y` / 四个大小比较在**无符号**上与有符号不是
 * 一件事（右移补零还是补符号位、商与余数的符号、比较的次序）。图上只有一族算符，
 * 所以那一格落成 `prim` 上的一位 `uns`（见 `graph/nodes.js` 上 `prim` 的注），
 * 方言那侧发 `u>>` / `u/` / `u%` / `u<` 那一族。
 *
 * 量出来的必要性：`raytrace.go` 的 LCG 是 `(r.s>>11)&1048575`，`r.s` 声明成 `uint64`。
 * 那一份**没被咬到**是因为紧跟着的 `& 1048575` 把高位全抹了（低 20 位两种移法一样）——
 * 换一个不带掩码的哈希就是静默的错答案。
 *
 * 收四处：`var x uint64` / `x := uint64(…)` / 形参 / **结构体字段**（靠接收者或变量的
 * 具名类型去 `STRUCTS` 里查）。查不出来就当有符号 —— 与 `MAPS` 的口径一样（没登记的
 * 按常态走），那一格是**已知的不精确**，不是猜。
 */
const UNS = new Set();
/** 这几个是 go 的无符号整数类型名（`uintptr` 也算 —— 它就是个地址）。 */
const UINT_TYPES = new Set(['uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'byte']);
/** 一格类型节点是不是无符号整数（具名类型跟着 `UNDER` 走一层）。 */
const isUnsTy = (ty) => {
  const n = scalarNameOf(ty);
  return n !== null && UINT_TYPES.has(n);
};
/** 一格 `spec` 里**装无符号整数的名字**（照 `specMapNames` 的样子写）。 */
function specUnsNames(x) {
  const nm = part(x, 'names');
  if (nm === undefined) return [];
  const names = kids(nm).map(leaf);
  const ty = kids(x).find((y) => tag(y) !== 'names' && tag(y) !== 'init');
  if (isUnsTy(ty)) return names;
  const ini = part(x, 'init');
  if (ini === undefined) return [];
  const rhs = kids(ini);
  return names.filter((n, i) => isUnsConv(rhs[i]));
}
/** 这格右值是不是 `uint64(…)` 那一族的转换。 */
function isUnsConv(r) {
  if (r === undefined || r === null || !isList(r) || tag(r) !== 'call') return false;
  const f = kids(r)[0];
  return f !== undefined && tag(f) === 'name' && UINT_TYPES.has(leaf(kids(f)[0]));
}
/**
 * **这格表达式是无符号的吗**（只认说得清的那几种，别的一律当有符号）。
 * `sel` 那一支是关键：`r.s` 要靠 `r` 的具名类型去 `STRUCTS` 里查字段的声明类型。
 */
function isUnsExpr(x) {
  if (x === undefined || x === null || !isList(x)) return false;
  const g = tag(x);
  if (g === 'paren') return isUnsExpr(kids(x)[0]);
  if (g === 'name') return UNS.has(leaf(kids(x)[0]));
  if (g === 'call') return isUnsConv(x);
  if (g === 'bin') return isUnsExpr(kids(x)[1]);      // `(a>>1) >> 2`：看左边那一半
  if (g === 'sel') {
    const obj = kids(x)[0];
    const fld = kids(x)[1];
    if (obj === undefined || fld === undefined || tag(obj) !== 'name') return false;
    const own = VARTYPE.get(leaf(kids(obj)[0]));
    const fs = own === undefined ? undefined : STRUCTS.get(own);
    if (fs === undefined || fs === null) return false;
    const want = leaf(fld);
    for (const [fn2, ft] of fs) if (fn2 === want) return isUnsTy(ft);
    return false;
  }
  return false;
}
/** 哪几个算符有"无符号的那一半"（与 `backend-core.js` 的 `UBINOP` 逐字对应）。 */
const UOPS = new Set(['>>', '/', '%', '<', '<=', '>', '>=']);

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

/**
 * **这个模块真的需要 `__type` 那格类型标签吗**。
 *
 * 只有**类型 switch**（`switch v := x.(type)`，落成 `__goTypeIs(v, "T")`）与方法表分派
 * 会读它。都没有的时候它是**死重量**，而代价是量出来的：每格结构体多一格串字段
 * ——`Vec{…}` 那份 60M 次迭代里就是 3.6 亿次多余的串存 + 每格结构体多 8 字节。
 *
 * 为什么用**预扫描**而不是"边走边置"：零值与字面量可能在看到 `tswitch` **之前**就落出来了，
 * 那时标志还没置上，同一个 struct 就会出两种形状（带标签的与不带的）——
 * 那正是这一趟被 `(ptr r2)` / `(ptr r3)` 咬过的那个坑。`collectDecls` 本来就走整棵树。
 */
let NEEDS_TYPETAG = false;
/**
 * **哪几个具体类型要"从接口里降回去"**（`collectDecls` 那一趟收）。
 *
 * `switch t := light.(type) { case *Sphere: t.Radius … }` —— go 在这一支里把 `t` **收窄**成
 * `*Sphere`。而按 ADR-0040，接口值是**一格方法闭包的记录**：接收者只躺在闭包里，记录上
 * 压根没有它，于是 `t.Radius` 报"记录 r16 上没有字段 'Radius'（它有的是：__type Compile
 * BoundingBox …）"（量出来的，pt 的 `DefaultSampler.sampleLight`）。
 *
 * 办法是给这几个类型各加**一格降回去的方法**：`__as_Sphere() *Sphere` —— Sphere 自己那一份
 * 返回 `__self`，别人那一份返回空引用。为什么这样可以：方言按"字段名单 + 字段类型"去重形状，
 * 而这一格的**名字与类型对同一个接口的所有实现者逐字相同**（所以 `[]Shape` 还是单态的）。
 * 为什么不把接收者直接摆一格字段：那一格的类型**跟着具体类型变**，同一个接口于是出 N 种形状。
 *
 * 只收"这支只有一个类型名、而且带绑定"的那几格 —— go 在"一支收多个类型"里本来也不收窄。
 * 预扫描的理由与 `NEEDS_TYPETAG` 同一条：零值与装箱可能在看到那处 switch 之前就落出来了。
 */
const NARROW = new Set();
/**
 * **这份程序里有"两边都不是字面量"的 `==` / `!=` 吗**（`collectDecls` 那一趟置上）。
 *
 * 它是**装箱记忆**那几格隐藏字段的闸（见 `addBoxMemoFields`）：接口值在 go 里只能与
 * 另一格接口值或 `nil` 比，而 `nil` 那一边是字面量（那条路走 `(null rN)`，不需要记忆）——
 * 所以"两边都不是字面量"是"可能在比两格接口"的**必要条件**。
 * 比 int 的 `a == b` 也会让它成立（过宽，但便宜且说得清）；`i == 0` / `f != 1` 那一族不会。
 *
 * 为什么非要这道闸：记忆那一格字段会让**每个**实现了接口的结构体多一格，而那会把下游的
 * 编译时间拖上去 —— 量出来的：`tests/go/cases/32-rand.go`（`math/rand` 三份桩一起编，
 * 105KB 的 C）本来就要 200s+ 过我们自己那台 C 前端，多这一格就越过套件 300s 的线。
 */
let NEEDS_IBOX = false;
/**
 * **这份程序要调度器吗**（`collectDecls` 那一趟置上）。
 *
 * 置上了，`func main()` 的体就得跑成**主 g**（`call __goRun(main)`，落到方言里是
 * `(ccall omni_go_run (fnref main))`）而不是一次普通调用。为什么非要这一格：
 * `omni_chansend` 阻塞时要 park 当前那条 g 再切走，而 `main` 那条线程本身不是 g ——
 * 少了这一层包，一个无缓冲 channel 上的第一次发送就是"park 一个不存在的 g"。
 *
 * 判据是**语法上看得见的三样**：`go` 语句、`chan` 那三种类型、发送语句。
 * 收得宽一点不亏：包一层对不用并发的程序也是对的（只多一次函数调用），
 * 而漏了就是运行期挂掉。
 */
let NEEDS_SCHED = false;
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

/**
 * 一格**类型**节点里的具名类型（`*T` 那一层剥掉）。切片 / map / 函数类型回 null。
 *
 * **包限定的类型名在这儿收成平名字**（`color.RGBA64` -> `RGBA64`）：`--pkgs` 把每个
 * 依赖目录的顶层声明摊进**同一个平名字空间**（`graph/run.js` 的 byPkg），所以
 * `TYPES` / `STRUCTS` / `IFACES` 里住的是 `RGBA64` 那个短名 —— 带着 `color.` 去查
 * 一定查不着，而查不着的后果是那格变量**静默地推成 int**：
 * `func (p *Image64) SetRGBA64(x, y int, c color.RGBA64)` 里的 `c.R` 报
 * "'c' 说不清形状（推出来是 int）"。这是 pt 整包撞上的墙。
 *
 * 收的判据有两道，两道都要：**头一段 import 过**（不然 `a.B` 可能是"变量 a 的字段 B"，
 * 那在树上同形）、**尾一段真是这一层认得的类型**。两样都对才收 —— 猜错比落成墙糟。
 */
function flatTyName(n) {
  if (n === null || n.indexOf('.') < 0) return n;
  const i = n.indexOf('.');
  const head = n.slice(0, i);
  const tail = n.slice(i + 1);
  if (!IMPORTS.has(head)) return n;
  if (TYPES.has(tail) || STRUCTS.has(tail) || IFACES.has(tail)) return tail;
  return n;
}

function namedTypeOf(t) {
  if (t === undefined || t === null || !isList(t)) return null;
  const g = tag(t);
  if (g === 'tname') return flatTyName(kids(t).map(leaf).join('.'));
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

/** 这格接收者是**指针接收者**吗（`func (r *Rng) …`）—— 见 `PTRRECV`。 */
function recvIsPtr(recv) {
  const p0 = kids(recv)[0];
  if (p0 === undefined) return false;
  let t = kids(p0).find((y) => tag(y) !== 'name');
  while (t !== undefined && isList(t) && tag(t) === 'paren') t = kids(t)[0];
  return t !== undefined && isList(t) && tag(t) === 'ptr';
}

/**
 * **至少有一格指针接收者方法的那些类型**（`collectDecls` 那一趟收）。
 *
 * 它们的记录落成**引用语义**（`byval` 不置上，于是 `shapeType` 给的是 `(ptr rN)`），
 * 别的结构体照旧是值语义。
 *
 * 为什么非要这一格（量出来的，raytrace 的 LCG）：`func (r *Rng) next()` 里那句
 * `r.s = …` 是要**改调用者那一格**的，而值语义的形参是一份拷贝 —— `next()` 于是每次
 * 都从同一个种子算，六次调用回的是同一个数（go 给六个不同的数）。图落得出来、跑得动，
 * 答案静默地错。
 *
 * **不精确的角，明写在这儿**：go 里 `Rng` 本身仍是值语义（`a := b` 要复制），而这一刀
 * 把整个类型转成了引用 —— 一个类型只有一格形状，值与引用两档同时要是另一件事
 * （每处用法各自定形，那要先有"用法级的类型"）。语料里"既有指针方法、又靠赋值复制"
 * 的类型极少，而"指针方法改不动东西"是**每次都错**。
 */
const PTRRECV = new Set();
/**
 * **被 `*T` 指过的那些具名类型**（`collectDecls` 那一趟收候选，扫完与 `STRUCTS` 求交
 * 再并进 `PTRRECV`）。
 *
 * 为什么与"有指针接收者方法"合成同一格：两者要的是同一件事 —— **引用语义**。
 * 量出来的必要性：pt 的 `Triangle` 有一格 `Material *Material` 字段，而 `zeroOf` 对
 * `(ptr …)` 一律回 `lit(null)` ⇒ `structZero('Triangle')` 里那一格说不清类型 ⇒
 * `pzero` 立不起来 ⇒ `func (t *Triangle) …` 的体里 `t.V1` 报
 * 「在一格说不清形状的东西上取字段 'V1'（变量 t 推出来是 int）」。pt 整包就卡在这一句。
 * 现在 `*T` 的零值是 **T 的零值记录**（引用语义那一档），字段于是有类型。
 *
 * 语料里这一条**不会把值语义的那些带坏**：pt 里一处 `*Vector` / `*Color` 都没有
 * （量过：被指的是 Mesh / Triangle / Scene / Volume … 那一族，它们本来就有指针接收者）。
 */
const PTRED = new Set();
/** 正在造零值记录的具名结构体 -> 那格**还没填完**的记录（`structZero` 的环闸）。 */
const SPEND = new Map();
/** 这格具名类型的记录要不要值语义（`recordNew` 的第二个实参）。 */
const byValFor = (n) => !(typeof n === 'string' && PTRRECV.has(n));

/* ---- 接口（ADR-0040）------------------------------------------------------
 *
 * **接口值 = 一格方法闭包的记录**（引用语义 ⇒ 一个字，装得进单态数组）：
 *     type Shape interface { Area() float64 }
 *  => 一格 `record-new`（`byval` 不置上）每个接口方法一格字段，值是**抓住了接收者**
 *     的闭包（图上一格 `func`，`backend-core.js` 的 `liftFnVals` 把它提成 `(cfn …)`）。
 * 分派 = 取字段再按值调 —— 正是 `case 'call'` 那条既有的兜底路（`fieldGet` 再 `call`）。
 *
 * 为什么不是 `dyn`、不是"标签+地址"、不是单态化：三条的账在 ADR-0040 里。
 * 这一条用的全是方言里已经有判据的东西（类的引用语义、`fnty` 字段、`mkclo`/`callfn`），
 * **一格方言节点都不用加**。
 */

/** 接口名 -> 声明里那几格 `(m 名 签名)` 的原树（嵌入的**没**摊平，`ifaceMethods` 摊）。 */
const IFACES = new Map();
/** 造好的装箱函数（键 `具体类型|接口名` -> 一格顶层 bind 节点）。一对只造一份。 */
const BOXFNS = new Map();
/** 造好的 `__nilof_接口名`（接口名 -> 一格顶层 bind 节点；null = 正在造）。 */
const NILFNS = new Map();
/** 正在造装箱函数的那几对（互相引用要截住）。 */
const BOXING = new Set();
/** 顶层函数/方法名 -> **声明的单返回类型节点**（`ret` 那一处要按它装箱）。 */
const FRET = new Map();
/** 函数 / 方法的**多返回类型节点表**（`l, r := f()` 之后每一格的声明类型）。只存多返回。 */
const FOUTS = new Map();
/**
 * **`math.F(…)` 怎么落**（go 的名字 -> 方言 `(rmath "f" …)` 里那个 C 的名字）。
 *
 * 图上仍旧只是"调一个名字"：这儿发 `call __goMath_f(…)`，`backend-core.js` 的
 * `GO_RMATH` 认出名字落 `(rmath "f" …)`。为什么不给图加一族 prim：见那儿的注。
 *
 * **不在这张表里的三格**另走：`Max`/`Min` 落成一格生成的辅助函数（`ensureMathMinMax`
 * —— 用 branch 会把实参复制一遍，那在 `math.Max(f(), g())` 上是两次求值）、
 * `Modf` 落在**语句**那一层（`assign` 里那一段 —— 多返回的辅助函数在 `retTypeOf`
 * 那一趟定不了型）、`Pi`/`E` 那一族是常量（`GO_STDLIB_STUBS.math`）。
 */
const GO_MATH_RMATH = new Map([
  ['Sqrt', 'sqrt'], ['Abs', 'fabs'], ['Floor', 'floor'], ['Ceil', 'ceil'], ['Round', 'round'],
  ['Pow', 'pow'], ['Mod', 'fmod'], ['Hypot', 'hypot'], ['Atan2', 'atan2'],
  ['Sin', 'sin'], ['Cos', 'cos'], ['Tan', 'tan'],
  ['Asin', 'asin'], ['Acos', 'acos'], ['Atan', 'atan'],
  ['Sinh', 'sinh'], ['Cosh', 'cosh'], ['Tanh', 'tanh'],
  ['Asinh', 'asinh'], ['Acosh', 'acosh'], ['Atanh', 'atanh'],
  ['Exp', 'exp'], ['Expm1', 'expm1'], ['Log', 'log'], ['Log10', 'log10'],
  ['Log1p', 'log1p'], ['Cbrt', 'cbrt'],
]);
/** 生成出来的 math 辅助函数（名字 -> `func` 节点），一趟一份，附在模块体前头。 */
const MATHFNS = new Map();
/**
 * 这一格是 go 的 `nil` 吗。**两种形状都要认**：`nil` 落成 `(const value=null)`
 * （见 `case 'name'` 那一支），而 `zeroOf` 那一路落的是字面量 `{lit: null}`。
 * 只认一种的代价量到过：`Hit{0.0, nil}` 的接口字段没换成零值记录，于是同一个 go
 * 结构体算出两格形状（`要返回 r9，给的是 r16`）。
 */
function isNilNode(v) {
  if (v === null || v === undefined || typeof v !== 'object') return false;
  if (v.op === 'const') return (v.attrs === undefined ? undefined : v.attrs.value) === null;
  return v.op === undefined && 'lit' in v && v.lit === null;
}

/** 一格左值的**根名字**（`a` / `a.f` / `a[i]` / `*a` 都算 `a`）。说不清回 null。 */
function rootNameOf(x) {
  if (x === undefined || x === null || !isList(x)) return null;
  const g = tag(x);
  if (g === 'name') return leaf(kids(x)[0]);
  if (g === 'sel' || g === 'index' || g === 'paren' || g === 'deref' || g === 'addr') {
    return rootNameOf(kids(x)[0]);
  }
  return null;
}

/** 这棵树里出现过的所有**名字**。 */
function namesIn(x, out) {
  const acc = out ?? new Set();
  if (x === undefined || x === null || !isList(x)) return acc;
  if (tag(x) === 'name') { const n = leaf(kids(x)[0]); if (n !== null) acc.add(n); }
  for (const k of kids(x)) namesIn(k, acc);
  return acc;
}

/**
 * **`a, b = b, a` 这一族要先把右边全算出来**（go 的规矩：所有右值先求值，再逐格赋）。
 *
 * 逐格顺着赋是**静默的错答案**：`x, y = y, x` 落成 `x = y; y = x` 就是 9/9 而不是 9/7
 * （量到过；pt 那个 BVH 的就地分区 `t.Shapes[i], t.Shapes[j] = t.Shapes[j], t.Shapes[i]`
 * 因此分错，13 个节点变成 33 个、校验和跟着错）。
 *
 * **只在真会互相打架时才加临时量**：左边写的那几个根名字里有一个出现在右边。这样
 * `a, b := 1, 2` 那一族的产物一个字节不动。
 */
function needsParallel(lhs, rhs) {
  const written = new Set();
  for (const t of lhs) { const n = rootNameOf(t); if (n !== null && n !== '_') written.add(n); }
  if (written.size === 0) return false;
  for (const r of rhs) {
    for (const n of namesIn(r)) if (written.has(n)) return true;
  }
  return false;
}
/** `a, b = b, a` 那一族的临时量序号（嵌套也不撞名）。 */
let ASN_N = 0;

/** 一格 `float64` 的类型节点（生成的辅助函数要拿它当 `pzero` / `rzero` / `FRET`）。 */
const F64TY = { kind: 'list', items: [{ kind: 'atom', value: 'tname' }, { kind: 'atom', value: 'float64' }] };
const f64Zero = () => zeroOf(F64TY, 'math 辅助');
const rmathCall = (rm, args) => node('call', {
  fn: node('ref', {}, { name: `__goMath_${rm}` }), args,
});

/**
 * `math.Max` / `math.Min` —— 方言的 `rmath` 里没有 `fmax`/`fmin`，所以生成一格
 * **go 级的辅助函数**：`func __goMathMax(a, b float64) float64 { if a > b { return a }; return b }`。
 *
 * 为什么不直接落 `branch (a>b) a b`：那会把两个实参各复制一遍，
 * `math.Max(f(), g())` 于是变成四次调用（其中两次的副作用多跑一遍）。
 *
 * **与 go 的差**：go 的 `math.Max` 在 NaN / ±0 上有明文规矩（有 NaN 就回 NaN、
 * `Max(+0,-0)` 回 +0），这一格的比较给不出那两条。pt 用不到，记在这儿。
 */
function ensureMathMinMax(which) {
  const nm = `__goMath${which}`;
  if (MATHFNS.has(nm)) return nm;
  MATHFNS.set(nm, null);
  const a = node('ref', {}, { name: '__ma' });
  const b = node('ref', {}, { name: '__mb' });
  const z = f64Zero();
  MATHFNS.set(nm, node('func', {
    body: [
      branchOf(binOf(which === 'Max' ? '>' : '<', a, b, OPS, { lang: 'go' }),
        node('region', { body: [retOf([a])] })),
      retOf([b]),
    ],
  }, { params: ['__ma', '__mb'], name: nm, pzero: [z, z], rzero: z }));
  FRET.set(nm, F64TY);
  return nm;
}

/** `math.Modf` 落在语句那一层（见 `assign` 里那一段）用的序号 —— 嵌套也不撞名。 */
let MODF_N = 0;
/** `copy(dst, src)` 落成一圈逐格写时用的序号（嵌套也不撞名）。 */
let CP_N = 0;

/** 这一处调用是不是 `math.<名字>(…)`（`math` 被局部量遮住就不算）。 */
function isMathCallOf(x, name) {
  if (x === undefined || !isList(x) || tag(x) !== 'call') return false;
  const f = kids(x)[0];
  if (f === undefined || !isList(f) || tag(f) !== 'sel') return false;
  const o = kids(f)[0];
  return isList(o) && tag(o) === 'name' && leaf(kids(o)[0]) === 'math'
    && VARTYPE.get('math') === undefined && leaf(kids(f)[1]) === name;
}

/**
 * 一处 `math.F(…)`：认得出来就落，认不出来回 null（照旧走下面那几条路，最后报）。
 * `math` 被局部量遮住时不走这儿（`VARTYPE` 有那个名字就是遮住了）。
 */
function goMathCall(m, argNodes) {
  /* **`math.F` 的实参里的无类型整数常量就是 float64**（go 的无类型常量规则）。
     `math.Min(1, red/255)` 那个 `1` 不抬成 real 的话，`__goMathMin` 的第一格形参
     一处收 real、一处收 int —— 方言的形参是单态的，当场报。
     只抬**字面量**：真的 int 表达式在 go 那侧本来就是类型错。 */
  const isIntLit = (a) => a !== null && a !== undefined && typeof a === 'object'
    && a.op === 'const' && a.attrs !== undefined && Number.isInteger(a.attrs.value);
  const asF = argNodes.map((a) => (isIntLit(a) ? convOf('float', a) : a));
  const rm = GO_MATH_RMATH.get(m);
  if (rm !== undefined) return rmathCall(rm, asF);
  if ((m === 'Max' || m === 'Min') && argNodes.length === 2) {
    return node('call', { fn: node('ref', {}, { name: ensureMathMinMax(m) }), args: asF });
  }
  return null;
}

/** 名字 -> 它的**声明类型节点**（形参与 `var x T`；`VARTYPE` 只存名字，这张存树）。 */
let VARTY = new Map();
/** 正在走的那格函数**声明的单返回类型节点**（`ret` 那一处按它装箱）。 */
let CUR_RET = null;
/**
 * **这个函数具名的返回值**（`func f() (left, right bool)`）—— `funcOf` 存下、
 * 光秃秃的 `return` 拿它补出返回值（go 的 "bare return"）。
 *
 * 为什么非要它：pt 的 `Box.Partition` 就是这个写法（体里只有 `switch` 赋值 + 一句 `return`）。
 * 不认它的话那句 `return` 落成光秃秃的 `(ret)`，于是整格函数"一格 ret 都没有"，
 * core 那侧当成隐式返回、报"把 'Box__Partition' 当值用，可它体里一格 ret 都没有"。
 * 名字与类型一起存（进函数时要按声明的零值绑出来）。
 */
let CUR_OUTS = [];

/** 这格类型节点是**有方法的接口**吗 —— 是就回接口名。`interface{}` 回 null（没方法可分派）。 */
function ifaceNameOf(ty) {
  if (ty === undefined || ty === null || !isList(ty)) return null;
  const t = tag(ty);
  if (t === 'paren') return ifaceNameOf(kids(ty)[0]);
  if (t === 'tname' && kids(ty).length === 1) {
    const n = leaf(kids(ty)[0]);
    if (!IFACES.has(n)) return null;
    return ifaceMethods(n).length === 0 ? null : n;
  }
  return null;
}

/**
 * **省掉类型的嵌套字面量**（`[][]int{{1},{2}}` 里那两格）：树上是 `(elit 元素…)`。
 * 把外层算出来的元素类型补回去，就成了一格正常的 `(lit 类型 元素…)`。
 *
 * 为什么不让语法直接发 `lit`：`lit` 的第一格孩子**是类型**，省掉之后第一个元素
 * 会被当类型吃掉 —— `{1,2}` 静静落成 `[2]`（**答案错而不报**），`{}` 则报
 * "一格空列表（元素类型推不出来）"。pt 的 `triangleTable` 那张表撞出来的。
 *
 * 补不出类型（外层自己也说不清）时原样交回去 —— 让后面那一支照旧报缺口。
 */
function fillElidedTy(e, tyNode) {
  if (e === undefined || e === null || tag(e) !== 'elit') return e;
  if (tyNode === undefined || tyNode === null) return e;
  return { kind: 'list', items: [{ kind: 'atom', value: 'lit' }, tyNode, ...kids(e)] };
}

/** `[]T` / `[N]T` 的元素类型节点（别的形状回 null）。 */
function elemTyOf(ty) {
  if (ty === undefined || ty === null || !isList(ty)) return null;
  const t = tag(ty);
  if (t === 'paren') return elemTyOf(kids(ty)[0]);
  if (t === 'slice') return kids(ty).find((y) => tag(y) !== 'none') ?? null;
  if (t === 'array') return kids(ty)[1] ?? null;
  /* **`map[K]V` 的"下标读出来那一格"是 V**。少了这一支，`t := m["a"]` 的 `t` 在 VARTY
     里是空的，于是 `t.At(2)` 认不出 t 是接口 —— 落成对 `Solid__At` 的**直接调用**，
     报"'Solid__At' 第 1 格形参落成了 r1，可后面有一处调用给的是 r2"（任务 #83）。 */
  if (t === 'map') return kids(ty)[1] ?? null;
  return null;
}

/**
 * `map[K]V` 的**键零值与值零值**那两格节点（`map-new` 的 `kzero` / `vzero`，#40）。
 * 算不出来那一格给 null —— 下游照旧退回"往这一层里找第一处 map-set"。
 */
function mapZeros(ty, name, pkg) {
  if (ty === undefined || ty === null || !isList(ty) || tag(ty) !== 'map') return [null, null];
  const z = (t) => {
    if (t === undefined || t === null) return null;
    try { const r = zeroOf(t, `${name ?? 'map'} 的键值`, pkg); return r === undefined ? null : r; }
    catch { return null; }
  };
  return [z(kids(ty)[0]), z(kids(ty)[1])];
}

/**
 * **`m[k]` 的读**：go 缺键给零值，方言的 `dget` 缺键是运行期错误 —— 落成
 * `branch (map-has m k) (map-get m k) 零值`。
 *
 * 量出来的必要性：从前 `m["不在的键"]` 与 `v, ok := m["不在的键"]` 都 **abort**，
 * 而 go 给 `0` / `false`。
 *
 * **与 go 的差**：go 的 `mapaccess` 一次查表两样都回，我们查两次（`dhas` 再 `dget`）——
 * 那是性能上的差，不是答案上的。
 *
 * **值是引用类型时零值就是 `lit(null)`**（`map[K]*T` / `map[K]接口`）：go 里那正是 nil，
 * 而 core 那侧 branch 的一支认得出空引用（照另一支的类型落 `(null rN)`）。
 * 从前这一档只发 `map-get`、缺键在运行期报一句话 —— 理由是"图上没有 nil 记录"，
 * 那条理由 2026-09-21 之后作废了（`record-new.fzero` / `bind.tzero` 那一刀）。
 * 值类型说不清的那一档照旧只发 `map-get`：不静静答错。
 */
function mapGetZero(oTree, oNode, kNode) {
  const g = mapGet(oNode, kNode);
  const nm = tag(oTree) === 'name' ? leaf(kids(oTree)[0]) : null;
  const ty = nm === null ? undefined : MAPTY.get(nm);
  if (ty === undefined) return g;
  const vT = kids(ty)[1];
  /* 引用类型（接口 / `*具名结构体`）：零值是空引用。 */
  if (nilFieldZero(vT, lit(null)) !== null) return branchOf(mapHas(oNode, kNode), g, lit(null));
  let z = null;
  try { z = zeroOf(vT, `${nm} 的值`); } catch { z = null; }
  const scalar = z !== null && z !== undefined && typeof z === 'object'
    && z.op === undefined && 'lit' in z && z.lit !== null;
  if (!scalar) return g;
  return branchOf(mapHas(oNode, kNode), g, z);
}

/**
 * 接口的方法表：`[[名, 签名节点], …]`，**嵌入的接口一路摊平**。
 *
 * 树上嵌入写成 `(constraint 类型)`（`go.grammar` 的 `ifitem -> type-set`）——
 * 那格类型是另一个接口名时把它的方法并进来，别的（真正的类型集约束 `~int | ~string`）
 * 跳过：泛型约束不是方法集。
 */
function ifaceMethods(n, seen) {
  const decl = IFACES.get(n);
  if (decl === undefined) return [];
  const guard = seen ?? new Set();
  if (guard.has(n)) return [];
  guard.add(n);
  const out = [];
  const have = new Set();
  const push = (m, sig) => { if (!have.has(m)) { have.add(m); out.push([m, sig]); } };
  for (const it of decl) {
    if (tag(it) === 'm') {
      const nm = leaf(kids(it)[0]);
      const sig = kids(it).find((y) => isList(y) && tag(y) === 'sig');
      if (nm !== undefined && sig !== undefined) push(nm, sig);
      continue;
    }
    if (tag(it) === 'constraint') {
      const inner = namedTypeOf(kids(it)[0]);
      if (inner !== null && IFACES.has(inner)) {
        for (const [m, s] of ifaceMethods(inner, guard)) push(m, s);
      }
    }
  }
  return out;
}

/**
 * 一格**接口方法签名**的形参 `[{nm, ty}]`。
 *
 * 为什么不用 `paramInfo`：接口里的签名几乎都**不带名字**（`Intersect(Ray) Hit`），而
 * `paramInfo` 专门为"参数组共享类型"那条歧义写的，一格名字都没有时它回空表。
 * 这儿要的正好相反 —— 只要**元数与类型**，名字自己编。
 */
function ifaceParams(sig) {
  const ins = partKids(sig, 'in');
  const anyNamed = ins.some((p) => part(p, 'name') !== undefined);
  const out = ins.map((p, i) => {
    const nm = part(p, 'name');
    let ty = kids(p).find((y) => tag(y) !== 'name' && tag(y) !== 'variadic');
    /* **参数组里"名字被当成类型"那一格**（与 `paramInfo` 同一条规矩）：
       `Sample(u, v float64)` 在树上是 `p(u)` + `p(v float64)`，头一格的 `u` 收成了类型。 */
    if (nm === undefined && anyNamed && isList(ty) && tag(ty) === 'tname' && kids(ty).length === 1) {
      return { nm: leaf(kids(ty)[0]), ty: undefined };
    }
    if (ty === undefined) ty = undefined;
    return { nm: nm === undefined ? `__a${i}` : leaf(kids(nm)[0]), ty };
  });
  /* **参数组共享类型**：从后往前补（`(a, b int)` 一组共用后面那个类型）。 */
  let lastTy;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].ty === undefined) out[i].ty = lastTy;
    else lastTy = out[i].ty;
  }
  return out;
}

/** 这格具名类型上**有没有**这个方法（本包 + 跨包两张表）。 */
const hasMethod = (tn, m) => MSET.has(`${tn}.${m}`) || XPKG.mset.has(`${tn}.${m}`);

/** 这格具名类型**满足这个接口吗**（方法一个不缺；嵌入带来的提升走 `promoteVia`）。 */
function implementsIface(tn, ifn) {
  if (typeof tn !== 'string' || tn.length === 0) return false;
  const ms = ifaceMethods(ifn);
  if (ms.length === 0) return false;
  return ms.every(([m]) => hasMethod(tn, m) || promoteVia(tn, m) !== null);
}

/**
 * 这个方法是**从哪格嵌入字段提升**上来的（回那格字段名，没有就 null）。
 *
 * 只认"嵌入的是**接口**"这一档（pt 的 `TransformedShape{ Shape; … }` 就是它）：
 * 那时转发就是"取那格字段里的闭包再调"，运行期总对。嵌入具体结构体那一档还没接。
 */
function promoteVia(tn, m) {
  const emb = EMBEDS.get(tn);
  if (emb === undefined) return null;
  for (const [fname, ety] of emb) {
    const ifn = ifaceNameOf(ety);
    if (ifn === null) continue;
    if (ifaceMethods(ifn).some(([mm]) => mm === m)) return fname;
  }
  return null;
}

/** 具名结构体 -> 它的**嵌入字段**（`[[字段名, 类型节点], …]`）。 */
const EMBEDS = new Map();

/**
 * 一格表达式的**声明类型节点**（查不出来回 null —— 不猜、不报）。
 *
 * 这是这门语言里第一处"往回看类型"的地方，刻意只认**语法上写着的**那几条路：
 * 字面量 `T{…}`、名字（`VARTY`：形参与带类型的 `var`）、下标（容器的元素类型）、
 * 取字段（`STRUCTS` 里的字段类型）、调用（`FRET` 里声明的返回类型，含接口方法）。
 * 装箱点与分派点两处都问它 —— 两处要的是同一个知识，各写一遍就会不一致。
 */
function tyOfExpr(x, depth) {
  if (x === undefined || x === null || !isList(x)) return null;
  const d = depth ?? 0;
  if (d > 8) return null;                       // 链太长就不追了（环也在这儿截住）
  const g = tag(x);
  if (g === 'paren' || g === 'addr' || g === 'deref') return tyOfExpr(kids(x)[0], d + 1);
  if (g === 'lit') return kids(x)[0] ?? null;
  if (g === 'name') return VARTY.get(leaf(kids(x)[0])) ?? null;
  if (g === 'index') return elemTyOf(tyOfExpr(kids(x)[0], d + 1));
  if (g === 'sel') {
    const on = namedTypeOf(tyOfExpr(kids(x)[0], d + 1));
    if (on === null) return null;
    const fname = leaf(kids(x)[1]);
    const fs = STRUCTS.get(on);
    if (fs !== undefined && fs !== null) {
      const hit = fs.find(([f2]) => f2 === fname);
      if (hit !== undefined) return hit[1];
    }
    const emb = EMBEDS.get(on);
    if (emb !== undefined) {
      const e = emb.find(([f2]) => f2 === fname);
      if (e !== undefined) return e[1];
    }
    return null;
  }
  if (g === 'call') {
    const f = kids(x)[0];
    if (f === undefined) return null;
    if (tag(f) === 'name') {
      const fn0 = leaf(kids(f)[0]);
      /* **`make(T, …)` / `new(T)` 的类型就写在第一格实参上**。少了这一格，
         `a := make([]Shape, 3)` 的 `a` 在 VARTY 里是空的，于是 `a[0] = &Sq{…}`
         那一句不知道目标是接口、**不装箱** —— 方言当场报"这个数组装 class，写进去的是 r2"。
         （`*T` 与 T 在这一层不分：上面 addr/deref 也是透明的，`namedTypeOf` 会剥。） */
      if (fn0 === 'make' || fn0 === 'new') {
        const as = kids(x)[1];
        const t0 = as === undefined ? undefined : kids(as)[0];
        if (t0 !== undefined) return t0;
      }
      return FRET.get(fn0) ?? null;
    }
    if (tag(f) === 'sel') {
      const base = kids(f)[0];
      const on = namedTypeOf(tyOfExpr(base, d + 1));
      const m = leaf(kids(f)[1]);
      if (m === null) return null;
      /* **`pkg.Func(…)` 交出来的类型**（`r := rand.New(rand.NewSource(42))`）。
         左边是这份文件 import 的**包名**（不是值），所以上面那一问一定回 null ——
         而声明就在 `FRET` 里：跨包那一路键是 mangle 过的（`rand__New`），
         `--pkgs` 摊成同包那一路键是光名字（`New`，`opts.also` 那一趟收的）。
         少了这一格，`r` 在 `VARTY` 里是空的，于是 `r.Int63()` 认不出主人 ——
         `Int63` 在平表里有两个主人（`Rand` 与 `rngSource`），落到"取字段再调它"
         的兜底上，core 这条腿当场报"记录 r2 上没有字段 'Int63'"。 */
      if (on === null) {
        if (tag(base) !== 'name') return null;
        const pn = leaf(kids(base)[0]);
        if (pn === null || !IMPORTS.has(pn) || VARTY.get(pn) !== undefined
          || VARTYPE.get(pn) !== undefined) return null;
        return FRET.get(mangle(pn, m)) ?? FRET.get(m) ?? null;
      }
      const t = FRET.get(mangle(on, m));
      if (t !== undefined) return t;
      if (IFACES.has(on)) {
        const hit = ifaceMethods(on).find(([mm]) => mm === m);
        if (hit !== undefined) {
          const o = partKids(hit[1], 'out');
          if (o.length === 1) return o[0];
        }
      }
      /* **从嵌入的接口提升上来的方法**（pt 的 `type SDFShape struct { SDF; … }` 里
         `box := s.BoundingBox()`）：交出来的类型写在**那个接口**的方法签名上。
         少了这一格，`box` 在 `VARTYPE` 里是空的，于是下一句 `box.Intersect(ray)` 认不出
         主人（`Intersect` 在 pt 里有十来个主人，落到"取字段再调它"的兜底上）——
         报"记录 r5 上没有字段 'Intersect'（它有的是：__type Min Max）"。 */
      {
        const via = promoteVia(on, m);
        if (via !== null) {
          const emb = EMBEDS.get(on) ?? [];
          const e = emb.find(([f2]) => f2 === via);
          const ifn = e === undefined ? null : ifaceNameOf(e[1]);
          if (ifn !== null) {
            const hit = ifaceMethods(ifn).find(([mm]) => mm === m);
            if (hit !== undefined) {
              const o = partKids(hit[1], 'out');
              if (o.length === 1) return o[0];
            }
          }
        }
      }
    }
    return null;
  }
  return null;
}

/** 这格表达式的**具名类型名**（`tyOfExpr` 再剥一层）。 */
const tnOfExpr = (x) => namedTypeOf(tyOfExpr(x));


/**
 * **一格接口的零值记录**（go 的 nil 接口值，ADR-0040）。
 *
 * 字段名与字段类型**只从接口声明来** —— 与装箱出来的那格记录同形（方言按"字段名单 + 字段
 * 类型"去重形状，所以两处必须逐字相同）。每格方法是一格**当场炸的桩**：`assert false`
 * 加上返回那个类型的零值。为什么要炸而不是安静地返回零值：在 nil 接口上调方法在 go 里是
 * 一次 panic，安静返回就是"答案静默地错"。
 *
 * 为什么非要这一格（量出来的）：`func describe(s Shape)` 的形参没有零值 ⇒ `pzero` 立不
 * 起来 ⇒ core 那侧 `s` 默认成 int ⇒ 一取字段就报"在一格说不清形状的东西上取字段 'Name'"。
 * pt 的 `Material` 有四格 `Texture` 字段，整包就卡在同一句上。
 *
 * 有一格方法的返回类型说不清（返回的是**另一个**接口、两个接口互相引用）就整个回 null ——
 * 那时行为与从前逐字相同。
 *
 * **返回自己那一族**（`type Texture interface{ Pow(float64) Texture }`，pt 里就有）：
 *   - 类型那一侧把 `rzero` 指回**这格记录自己**（节点图上一个环）：后端算形状时
 *     `recPend` 上有同一份字段名单，于是直接回自引用那个占位串，不会转下去
 *     （见 `backend-core.js` 的 `SELF_TY`）。**不能拿一格"字段是 null 的占位记录"代替** ——
 *     那一格一旦在 `recPend` 空着的时候被问到类型，就会照 null 算出 `(Sample int)`，
 *     于是同一个接口在图上多出两三种形状（量出来的：r1/r2/r4/r6 四格）。
 *   - 值那一侧交 `__nilof_接口名()` —— 一格**顶层函数**，体里造这格零值记录。不能就地
 *     再铺一份：那是无限深的节点树。
 */
function ifaceZero(ifn) {
  const ms = ifaceMethods(ifn);
  if (ms.length === 0) return null;
  /* **互相引用截在这儿**（pt 的 `Shape.Intersect(Ray) Hit` 与 `Hit.Shape Shape`）：
     正在造这格接口的零值时又被问到同一个接口 —— 交回那格**还没填完**的记录。
     为什么可以交出去：字段是**就地**填的（下面 `rec.ins.fields[fi] = …`），所以等整趟
     走完它就是完整的那一份；这与"返回自己"那一族（`rz = rec`）是同一个手法。
     从前这儿只有 `ZEROING` 那道闸（在 `structZero` 里），环一绕回来就回 null，于是
     `Hit.Shape` 落成 int —— pt 里 `shape := hit.Shape` 报"在一格说不清形状的东西上取
     字段 'NormalAt'（变量 shape 推出来是 int）"。 */
  const pend = IFPEND.get(ifn);
  if (pend !== undefined) { IFLENT.add(ifn); return pend; }
  /* 先把记录建出来（字段暂时是 null），下面逐格填 —— "返回自己"的 `rzero` 要指回它。
   * **带 `__type`**：类型 switch 比的就是这格字段。零值记录的 `__type` 是 `""` —— 哪一支
   * 都不命中，与 go 的"nil 接口不匹配任何 case"完全对齐。而装箱函数那一份带的是
   * 具体类型名 —— 靠 `typeTagged()` 那一格保证。 */
  const fieldPairs = typeTagged() ? [['__type', lit('')], ...ms.map(([m]) => [m, lit(null)])]
    : ms.map(([m]) => [m, lit(null)]);
  /* **降回去那几格**（见 `NARROW`）：摆在方法后面，名字与次序装箱那一份完全一致。 */
  const downs = downTypesFor(ifn);
  for (const dn of downs) fieldPairs.push([downName(dn), lit(null)]);
  const rec = recordNew(fieldPairs, false);
  const lentBefore = IFLENT.has(ifn);
  IFPEND.set(ifn, rec);
  let ok;
  try {
    ok = fillIfaceZero(ifn, ms, rec);
  } finally {
    IFPEND.delete(ifn);
  }
  if (ok) return rec;
  /* **借出去之后又说不清**：环那一侧已经拿着这格半成品当类型使了，这时回 null 会让
     同一个接口在图上多出一种形状（字段全是 null ⇒ 每格算成 int）。有名有姓地停下。 */
  if (!lentBefore && IFLENT.has(ifn)) {
    IFLENT.delete(ifn);
    throw new Error(`go->graph: 接口 '${ifn}' 的零值记录里有一格方法的类型说不清，`
      + '而它自己已经被"互相引用"那条环借走了 —— 再回 null 会让同一个接口在图上多出一种形状');
  }
  return null;
}

/** 正在造零值记录的接口：接口名 -> 那格**还没填完**的记录（`ifaceZero` 的环闸）。 */
const IFPEND = new Map();
/** 被环借走过的接口名（见 `ifaceZero` 末尾那一段）。 */
const IFLENT = new Set();

/**
 * 把一格接口零值记录的方法桩逐格填进去（`ifaceZero` 的体，拎出来是为了那道环闸 ——
 * 中途说不清时要走 `finally` 把 `IFPEND` 摘掉，而不是就地 `return null`）。
 * 回 false = 有一格方法的类型说不清。
 */
function fillIfaceZero(ifn, ms, rec) {
  for (let k = 0; k < ms.length; k++) {
    const [m, sig] = ms[k];
    const ps = ifaceParams(sig);
    const outs = partKids(sig, 'out');
    if (outs.length > 1) return false;              // 多返回那一档还没接
    const pz = ps.map((p) => zeroOfParam(p.ty));
    if (pz.some((z) => z === null)) return false;
    let rz = null;
    let rv = null;
    if (outs.length === 1) {
      const rIf = ifaceNameOf(outs[0]);
      if (rIf === ifn) {
        rz = rec;                                  // 指回自己（见上面那段账）
        rv = node('call', { fn: gref(ensureNilFn(rIf)), args: [] });
      } else if (rIf !== null) {
        rz = ifaceZero(rIf);
        rv = node('call', { fn: gref(ensureNilFn(rIf)), args: [] });
      } else {
        rz = zeroOfParam(outs[0]);
        rv = rz;
      }
      if (rz === null) return false;
    }
    const body = [assertOf(lit(false), lit(`在一格 nil 的 ${ifn} 上调了 ${m}`))];
    if (rv !== null) body.push(retOf([rv]));
    const fi = typeTagged() ? k + 1 : k;           /* 偏移过 `__type` 那一格 */
    rec.ins.fields[fi] = node('func', { body }, {
      params: ps.map((p) => p.nm),
      name: `__nil_${ifn}__${m}`,
      ...(pz.length > 0 ? { pzero: pz } : {}),
      ...(rz !== null ? { rzero: rz } : {}),
    });
  }
  /* **降回去那几格**（见 `NARROW`）：nil 接口上降下去就是空引用（go 里 `case *T:` 在接口是
     nil 时压根不命中，所以这一格永远不会被真调到 —— 它在的意义是形状与装箱那一份一致）。 */
  const downs = downTypesFor(ifn);
  const base = (typeTagged() ? 1 : 0) + ms.length;
  for (let j = 0; j < downs.length; j++) {
    const dz = structZero(downs[j]);
    rec.ins.fields[base + j] = node('func', { body: [retOf([lit(null)])] }, {
      name: `__nil_${ifn}__${downName(downs[j])}`,
      params: [],
      ...(dz !== null ? { rzero: dz } : {}),
    });
  }
  return true;
}

/** 降回去那格方法的字段名（`__as_具体类型`，见 `NARROW` 那段账）。 */
const downName = (tn) => `__as_${String(tn).replace(/\./g, '__')}`;

/** 装箱记忆那格隐藏字段的名字（`__boxof_接口名`，见 `addBoxMemoFields`）。 */
const boxMemoName = (ifn) => `__boxof_${String(ifn).replace(/\./g, '__')}`;

/** 合成一格 `(tname 名字)` 类型节点（语法树的形状：`{kind:'list', items:[atom…]}`）。 */
const tnameNode = (n) => ({
  kind: 'list',
  items: [{ kind: 'atom', value: 'tname' }, { kind: 'atom', value: String(n) }],
});

/**
 * **把装箱记忆在接收者上**（ADR-0040 的第二刀）：给每个"有指针接收者、而且实现了某个接口"的
 * 结构体加一格隐藏字段 `__boxof_接口名`；装箱函数先看它、没有再造（见 `ensureBoxFn`）。
 *
 * 两件事一起收：
 *  一、**接口之间的 `==` 变成句柄比较**，与 go 的"（动态类型, 数据）相等"对齐。不记忆的话
 *     `__box_T__I(x)` 每调一次造一格新箱子，同一个接收者装出来的两格句柄不同，于是
 *     `hit.Shape != light`（pt 的 `DefaultSampler.sampleLight`）恒为真 —— 答案静默地错；
 *  二、**省一次分配**：pt 的内层循环每次相交都在 `Hit{s, t, nil}` 里装箱。
 *
 * **只给指针接收者那一族**（引用语义的记录）：值语义的结构体每份副本都自带一格记忆，
 * `Shape(a)` 之后改 a 再 `Shape(a)` 会交回同一格旧快照 —— 那才是答案静默地错。
 * 值类型的接口相等在 go 里是逐字段比，那是另一件事（没接）。
 *
 * 次序按名字排（图要可重现）。这一趟**不许调 `ifaceZero` / `structZero`** ——
 * 那时字段表还没加完，造出来的记录（`NILFNS` 是记着的）会少一格，形状就对不上了。
 */
function addBoxMemoFields() {
  if (!NEEDS_IBOX || IFACES.size === 0) return;
  for (const tn of [...STRUCTS.keys()].sort()) {
    if (!PTRRECV.has(tn)) continue;
    const fs = STRUCTS.get(tn);
    if (fs === undefined || fs === null) continue;
    for (const ifn of [...IFACES.keys()].sort()) {
      const ms = ifaceMethods(ifn);
      if (ms.length === 0) continue;
      if (!ms.every(([m]) => hasMethod(tn, m) || promoteVia(tn, m) !== null)) continue;
      const nm = boxMemoName(ifn);
      if (fs.some(([f]) => f === nm)) continue;
      fs.push([nm, tnameNode(ifn)]);
    }
  }
}

/** 这格（具体类型, 接口）对有没有装箱记忆那一格字段。 */
function boxMemoOf(tn, ifn) {
  if (!PTRRECV.has(tn)) return null;
  const fs = STRUCTS.get(tn);
  if (fs === undefined || fs === null) return null;
  const nm = boxMemoName(ifn);
  return fs.some(([f]) => f === nm) ? nm : null;
}

/**
 * 一格接口要带哪几格"降回去"的方法（名字 -> 那个具体类型）。
 *
 * 判据：`NARROW` 里、登记过字段表、而且**实现了这个接口**。三条都按声明算，所以同一个接口的
 * 每个实现者算出来的名单逐字相同 —— 形状才唯一（见 `NARROW` 那段账）。次序按名字排，
 * 装箱那一份与零值那一份才对得上。
 */
function downTypesFor(ifn) {
  const out = [];
  for (const tn of [...NARROW].sort()) {
    if (STRUCTS.get(tn) === undefined || STRUCTS.get(tn) === null) continue;
    if (!implementsIface(tn, ifn)) continue;
    out.push(tn);
  }
  return out;
}

/** `__nilof_接口名` —— 造这格接口零值的顶层函数（一格接口一份）。 */
const nilFnName = (ifn) => `__nilof_${String(ifn).replace(/\./g, '__')}`;

/**
 * 保证 `__nilof_接口名` 存在，回它的名字。
 *
 * **先占位再造体**：体里那几格"返回自己"的桩会再问一次这个名字，占位让它拿得到名字而
 * 不再造一遍（不然是无限递归）。
 */
function ensureNilFn(ifn) {
  if (NILFNS.has(ifn)) return nilFnName(ifn);
  NILFNS.set(ifn, null);
  const rec = ifaceZero(ifn);
  if (rec === null) return nilFnName(ifn);
  NILFNS.set(ifn, node('bind', {
    init: node('func', {
      body: [node('bind', { init: rec }, { name: '__z' }), retOf([gref('__z')])],
    }, { params: [], name: nilFnName(ifn), rzero: ifaceZero(ifn) }),
  }, { name: nilFnName(ifn) }));
  return nilFnName(ifn);
}

/** 装箱函数的名字（`__box_具体类型__接口名`）。 */
const boxFnName = (tn, ifn) => `__box_${tn.replace(/\./g, '__')}__${ifn.replace(/\./g, '__')}`;

const gref = (n) => node('ref', {}, { name: n });

/**
 * 造一格**装箱函数**（照 ADR-0040）：`__box_Sq__Shape(self)` 交出一格方法闭包的记录。
 *
 * 为什么是"一格顶层函数"而不是在装箱点就地铺开：闭包要抓住接收者，而"抓住"在图上
 * 就是**引用外层的一格名字** —— 顶层函数的形参正好是那格名字。装箱点于是只剩一次
 * 普通调用（`call __box_Sq__Shape(值)`），表达式位置上不用造临时绑定。
 *
 * 一对（具体类型, 接口）只造一份（`BOXFNS`）；造的时候登记在案，所以互相引用截得住。
 */
function ensureBoxFn(tn, ifn) {
  const key = `${tn}|${ifn}`;
  if (BOXFNS.has(key)) return boxFnName(tn, ifn);
  if (BOXING.has(key)) return boxFnName(tn, ifn);
  BOXING.add(key);
  const self = '__self';
  const fields = [];
  try {
    for (const [m, sig] of ifaceMethods(ifn)) {
      const ps = ifaceParams(sig);
      const outs = partKids(sig, 'out');
      /* 调谁：本类型自己有这个方法就直接调它；从嵌入的接口提升上来的**当场取字段再调**
         （不是装箱那一刻把闭包抄过来 —— 嵌入的那格事后被改也对）。 */
      const via = hasMethod(tn, m) ? null : promoteVia(tn, m);
      const inner = via === null
        ? node('call', { fn: gref(mangle(tn, m)), args: [gref(self), ...ps.map((p) => gref(p.nm))] })
        : node('call', { fn: fieldGet(fieldGet(gref(self), via), m), args: ps.map((p) => gref(p.nm)) });
      const pz = ps.map((p) => zeroOfParam(p.ty));
      const rz = outs.length === 1 ? zeroOfParam(outs[0]) : null;
      fields.push([m, node('func', { body: outs.length === 0 ? [inner] : [retOf([inner])] }, {
        params: ps.map((p) => p.nm),
        name: `${boxFnName(tn, ifn)}__${m}`,
        /* **接收者是按值抄一份的**：go 里 `var s Shape = Sq{2}` 装进接口的正是 Sq 那一格
           值的副本。默认的闭包规矩不许借值语义的结构体（那一条是为 go 的**词法**闭包写的，
           它按引用捕获），所以这儿明着标一格 `bycopy`。 */
        bycopy: true,
        ...(pz.some((z) => z !== null) ? { pzero: pz } : {}),
        ...(rz !== null ? { rzero: rz } : {}),
      })]);
    }
  } finally {
    BOXING.delete(key);
  }
  /* **值语义**（`byval` 置上）：接口值在 go 里本来就是**按值抄**的两个字（类型描述符 +
     数据指针），抄的是那两个字、不是被指的那格数据 —— 我们这格记录里装的全是闭包句柄，
     抄它们的语义与 go 完全一致（接收者仍旧共享）。
     为什么不用引用语义：方言的 `(arr 元素)` 收结构体名与类名，**不收 `(ptr rN)`** ——
     而后端把引用语义的记录发成 `(ptr rN)`，于是 `[]Shape` 落不下去。
     体分两句（先绑一格局部量再交回去）：`record-new` 在**表达式位置**上落不下去
     （见 `backend-core.js` 的 `bindRecord` 那段账），`ret (record-new …)` 会当场报缺口，
     而那一报是在空跑那一趟里被吞掉的 —— 症状是调用点把它当 int。
     **带 `__type`**（有类型 switch 的程序）：`tn` 就是具体类型名。与零值记录那格 `""` 配套，
     类型 switch 比 `__type` 就能分出来。 */
  /* **降回去那几格**（见 `NARROW`）：自己那一份交回 `__self`，别人那几份交回空引用 ——
     `case *T:` 命中时降下去拿到的正是那个接收者，于是 `t.Radius` 有地方可取。 */
  for (const dn of downTypesFor(ifn)) {
    const dz = structZero(dn);
    fields.push([downName(dn), node('func', {
      body: [retOf([dn === tn ? gref(self) : lit(null)])],
    }, {
      params: [],
      name: `${boxFnName(tn, ifn)}__${downName(dn)}`,
      bycopy: true,
      ...(dz !== null ? { rzero: dz } : {}),
    })]);
  }
  const fnFields = typeTagged()
    ? [['__type', lit(tn)], ...fields]
    : fields;
  /* **装箱记忆**（见 `addBoxMemoFields`）：接收者上有那一格就先看它 ——
     同一个接收者永远交回**同一格箱子**，于是接口之间的 `==` 是句柄比较（与 go 对齐），
     而且内层循环里那次分配省掉了。 */
  const memo = boxMemoOf(tn, ifn);
  const mkBody = [
    node('bind', { init: recordNew(fnFields, false) }, { name: '__b' }),
    ...(memo === null ? [] : [fieldSet(gref(self), memo, gref('__b'))]),
    retOf([gref('__b')]),
  ];
  const fnBody = memo === null ? mkBody : [
    branchOf(
      binOf('!=', fieldGet(gref(self), memo), lit(null), OPS, { lang: 'go' }),
      node('region', { body: [retOf([fieldGet(gref(self), memo)])] }),
    ),
    ...mkBody,
  ];
  const fn = node('func', {
    body: fnBody,
  }, {
    params: [self],
    name: boxFnName(tn, ifn),
    /* **声明的返回类型**（`rzero`）：就是这格接口的零值记录 —— 与装箱出来的那格**同形**。
       为什么非要它：`retTypeOf` 跑在最前头，`ret (var __b)` 那种它只能当 int，于是
       `describe(box(…))` 在空跑那一趟把形参记成 int，出真文本那一趟再报"两处的类型
       不一样（int 与 (ptr r4)）"。`rzero` 是**在那之前**就读的（见 backend-core 的
       `declRet`）。 */
    ...(ifaceZero(ifn) !== null ? { rzero: ifaceZero(ifn) } : {}),
    ...(zeroOfNamed(tn) !== null ? { pzero: [zeroOfNamed(tn)] } : {}),
  });
  BOXFNS.set(key, node('bind', { init: fn }, { name: boxFnName(tn, ifn) }));
  return boxFnName(tn, ifn);
}

/**
 * **把一格值装进接口**：认得出具体类型就包一次 `__box_…`，认不出就原样交回。
 *
 * 认不出时**不报**：那时下游看到的与从前一样（这一刀只往上加，不往下拆）。已经是
 * 接口值的（`tn` 就是接口名、或者 `tn` 是 null）也原样交回 —— 接口赋给同族接口就是搬一个字。
 */
function boxInto(ifn, tn, valNode) {
  if (ifn === null || tn === null || tn === undefined) return valNode;
  if (IFACES.has(tn)) return valNode;
  if (!implementsIface(tn, ifn)) return valNode;
  return node('call', { fn: gref(ensureBoxFn(tn, ifn)), args: [valNode] });
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
    /* **嵌入一格接口**（pt 的 `type SDFShape struct { SDF; Material Material }`）：
       在 go 里它就是一格**名字是类型名**的普通字段（`s.SDF` 取得出来），而方法提升那一侧
       本来就只认这一档（见 `promoteVia`）。所以收成 `[接口名, 类型节点]` 即可。
       从前整份回 null，于是 `&SDFShape{sdf, material}` 这个**位置式字面量**落不成记录、
       退到"一格列表"上去了 —— 报"列表里的元素类型不一样（r23 / r10）"。
       嵌入**具体结构体**那一档仍旧回 null：go 的语义是把那份的字段提上来（`s.X` 直通），
       只当一格字段会让 `s.X` 找不到 —— 那是另一刀。 */
    if (tag(f) === 'embed') {
      const et = kids(f).find((y) => isList(y));
      const en = namedTypeOf(et);
      if (en === null || ifaceNameOf(et) === null) return null;
      out.push([en, et]);
      continue;
    }
    if (tag(f) !== 'f') return null;
    const nms = part(f, 'names');
    const ty = kids(f).find((y) => tag(y) !== 'names' && tag(y) !== 'tag' && tag(y) !== 'attrs');
    if (nms === undefined || ty === undefined) return null;
    for (const n of kids(nms)) out.push([leaf(n), ty]);
  }
  return out;
}

/**
 * **接口的方法表先单独扫一遍**（`collectDecls` 之前）。
 *
 * 为什么非要这一趟：`fieldsOf` 判"嵌入的是不是接口"要问 `IFACES`，而声明的**次序**是源码
 * 的事 —— pt 里 `type SDFShape struct { SDF; … }` 在 1735 行、`type SDF interface` 在 1800 行。
 * 一趟扫的话 `SDFShape` 的字段表在 `SDF` 登记之前就算完了，于是整份回 null，
 * `&SDFShape{sdf, material}` 退成"一格列表"（量出来：报"列表里的元素类型不一样"）。
 */
function collectIfaces(x) {
  if (!isList(x)) return;
  if (tag(x) === 'tspec' || tag(x) === 'talias') {
    const iff = kids(x).find((y) => isList(y) && tag(y) === 'interface');
    if (iff !== undefined) IFACES.set(leaf(kids(x)[0]), kids(iff));
  }
  for (const k of kids(x)) collectIfaces(k);
}

/**
 * 扫一遍顶层：登记类型名（`type Point struct …`）、每个方法的接收者类型，
 * 以及 `var` / `const` 里**装 map 的名字**（`specMapNames` 那段说了为什么要在这儿收）。
 */
function collectDecls(x, shapesOnly) {
  if (!isList(x)) return;
  /* 见 `NEEDS_TYPETAG` 那段账：整棵树里有一处类型 switch，结构体就要带 `__type`。 */
  if (tag(x) === 'tswitch') {
    NEEDS_TYPETAG = true;
    /* 见 `NARROW` 那段账：`switch t := s.(type)` 里"只有一个类型名"的那几支要收窄。 */
    if (kids(x).some((y) => tag(y) === 'bind')) {
      for (const c of kids(x).filter((y) => tag(y) === 'case')) {
        const items = partKids(c, 'items');
        if (items.length !== 1) continue;
        const tn = namedTypeOf(items[0]);
        if (tn !== null && tn !== 'nil') NARROW.add(tn);
      }
    }
  }
  /* 见 `NEEDS_IBOX` 那段账：有"两边都不是字面量"的 `==` / `!=` 才加装箱记忆那几格字段。 */
  if (!NEEDS_IBOX && tag(x) === 'bin') {
    const bop = leaf(kids(x)[0]);
    if (bop === '==' || bop === '!=') {
      const litish = (y) => tag(y) === 'num' || tag(y) === 'str'
        || (tag(y) === 'name' && leaf(kids(y)[0]) === 'nil');
      if (!litish(kids(x)[1]) && !litish(kids(x)[2])) NEEDS_IBOX = true;
    }
  }
  /* 见 `NEEDS_SCHED` 那段账：语法上看得见并发，`main` 就要跑成主 g。 */
  if (tag(x) === 'go' || tag(x) === 'send'
    || tag(x) === 'chan' || tag(x) === 'chan-send' || tag(x) === 'chan-recv') {
    NEEDS_SCHED = true;
  }
  if (tag(x) === 'tspec' || tag(x) === 'talias') {
    TYPES.add(leaf(kids(x)[0]));
    /* 见 ADR-0040：`type X interface{…}` 的方法表要登记（装箱与分派两处都读它）。 */
    const iff = kids(x).find((y) => isList(y) && tag(y) === 'interface');
    if (iff !== undefined) IFACES.set(leaf(kids(x)[0]), kids(iff));
    const body = kids(x).find((y) => tag(y) === 'struct');
    if (body !== undefined) {
      const fs = fieldsOf(body);
      /* 收不齐（有嵌入字段）就存 null —— 那时零值当场报，不猜嵌入的那一格占几格。 */
      STRUCTS.set(leaf(kids(x)[0]), fs);
      /* **嵌入字段单收一份**（方法提升要它，见 `promoteVia`）：`(embed 类型)`。
         字段名在 go 里就是**类型的名字**（`*T` 也叫 T）—— 记 `[字段名, 类型节点]`。 */
      const emb = [];
      for (const f of kids(body)) {
        if (tag(f) !== 'embed') continue;
        const et = kids(f).find((y) => isList(y));
        const en = namedTypeOf(et);
        if (en !== null) emb.push([en, et]);
      }
      if (emb.length > 0) EMBEDS.set(leaf(kids(x)[0]), emb);
    } else {
      /* 别的具名类型：记下它的**底子**（零值就是底子的零值 —— 一层间接，不是新语义）。 */
      const und = kids(x)[1];
      if (und !== undefined && isList(und)) UNDER.set(leaf(kids(x)[0]), und);
    }
  }
  /* 见 `PTRED` 那段账：`*T` 里的 T 要引用语义（扫完再与 `STRUCTS` 求交）。 */
  if (tag(x) === 'ptr') {
    const tn0 = namedTypeOf(kids(x).find((y) => isList(y)));
    if (tn0 !== null) PTRED.add(tn0);
  }
  if (tag(x) === 'spec') for (const n of specMapNames(x)) MAPS.add(n);
  /* 见 `CHANS` 那段账：装通道的名字要认得出来（`len(ch)` 与 `range ch` 两处要）。
     三处来源：`var ch chan T` / `ch := make(chan T, n)` / 形参 `func f(ch chan T)`。 */
  if (tag(x) === 'spec') for (const n of specChanNames(x)) CHANS.add(n);
  /* 见 `UNS` 那段账：无符号那几个算符与有符号不是一件事。 */
  if (tag(x) === 'spec') for (const n of specUnsNames(x)) UNS.add(n);
  if (tag(x) === 'define' || tag(x) === 'assign') {
    const lhs0 = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
    const rhs0 = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
    for (let i = 0; i < lhs0.length; i++) {
      if (tag(lhs0[i]) === 'name' && isMakeChan(rhs0[i])) CHANS.add(leaf(kids(lhs0[i])[0]));
      if (tag(lhs0[i]) === 'name' && isUnsConv(rhs0[i])) UNS.add(leaf(kids(lhs0[i])[0]));
    }
  }
  if (tag(x) === 'fn' || tag(x) === 'method') {
    const sigC = kids(x).find((y) => tag(y) === 'sig');
    if (sigC !== undefined) {
      for (const p of paramInfo(sigC)) {
        if (isChanTy(p.ty)) CHANS.add(p.nm);
        if (isUnsTy(p.ty)) UNS.add(p.nm);
      }
    }
  }
  /* **声明的形参类型**（`FSIG`）：调用点要照它转实参（见 `argsByDecl`）。
     在这一趟收是因为 go 不管声明顺序 —— `main` 里的 `mk(3, 4)` 在 `mk` 之前就落下去了。
     存的是**类型节点**而不是名字：`scalarNameOf` 要跟着 `UNDER` 走一层，而 `UNDER`
     也是这一趟才填满的（`type Real = float64` 写在函数后面时名字这会儿还查不着）。 */
  if (tag(x) === 'fn') {
    const sig0 = kids(x).find((y) => tag(y) === 'sig');
    const nm0 = leaf(kids(x)[0]);
    if (sig0 !== undefined && nm0 !== '_') {
      FSIG.set(nm0, paramInfo(sig0).map((p) => p.ty));
      /* **声明的返回类型**（`FRET`，见 ADR-0040）：`ret` 那一处要按它装箱，调用点也要靠它
         认出"这格调用交出来的是接口值"。只收单返回 —— 多返回在图上是一格多值。 */
      const o0 = partKids(sig0, 'out');
      if (o0.length === 1) FRET.set(nm0, o0[0]);
      /* **多返回那几格的声明类型**（`FOUTS`）：`l, r := f()` 之后 `l` / `r` 的类型只能
         从这儿来。少了它 `l[0].Area()` 认不出 `l` 装的是接口（方法落成静态 mangle，
         报"'Sq__Area' 第 1 格实参在两处的类型不一样"）；pt 的 `NewNode(l)` 也是这一格。 */
      if (o0.length > 1) FOUTS.set(nm0, outTypes(sig0));
    }
  }
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
      /* 见 `PTRRECV` 那段账：指针接收者的主人落成引用语义。 */
      if (recvIsPtr(recv)) PTRRECV.add(owner);
      /* 方法的形参表也收（键是 mangle 过的名字，第 0 格空着留给接收者）。 */
      const sigM = kids(x).find((y) => tag(y) === 'sig');
      if (sigM !== undefined) {
        FSIG.set(mangle(owner, name), [undefined, ...paramInfo(sigM).map((p) => p.ty)]);
        const oM = partKids(sigM, 'out');
        if (oM.length === 1) FRET.set(mangle(owner, name), oM[0]);
        if (oM.length > 1) FOUTS.set(mangle(owner, name), outTypes(sigM));
      }
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
/** 常量桩里`这一格是 real`的标记（见 `math` 那一行的注）。 */
const R = (x) => ({ __real: x });
/**
 * **宿主那几格**：`src/lib/go/omnihost` 里那几格**没有体的声明** -> 前端发的名字。
 *
 * 为什么要这么一层：标准库那几份桩（`time` / `os` / `image/png` / `fmt`）绝大部分能用
 * go 自己写，可"现在几点""几个核""往文件写一个字节"这三类**没法用 go 写** —— 它们要
 * 宿主。方言那一层已经有一条正经的路（`(lib …)` + `(cabi …)` + `(ccall …)`，见
 * `backend-core.js` 的 `C_RT`），所以这儿只需要一个**从 go 源码进那条路的入口**。
 *
 * 入口写成"一格没有体的 go 函数声明"（go 自己的 `runtime.nanotime` 就是这么声明的），
 * 调用点写成 `omnihost.Nanotime()`。这样：桩仍旧是**能读的 go**，而"哪几格靠宿主"
 * 一眼数得清 —— 就是这张表。
 *
 * 值那一栏的名字必须与 `C_RT`（原生腿）和 `ext/go/go-rt.js`（js 腿）里的**逐字相同**。
 */
const GO_HOST_FNS = new Map([
  ['Nanotime', '__goNanotime'],
  ['NumCPU', '__goNumCPU'],
  ['PathReset', '__goPathReset'],
  ['PathPush', '__goPathPush'],
  ['Open', '__goOpen'],
  ['Write', '__goWrite'],
  ['Read', '__goRead'],
  ['Close', '__goClose'],
  ['Out', '__goOut'],
]);
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
  /* **浮点常量要标记成 real**（`R(…)`）：`1.7976931348623157e308` 在 JS 里
     `Number.isInteger` 为真，不标记就落成 `(int 1.79e+308)` —— 方言的读取器当场骂
     `(int 十进制整数)`。整数常量照旧写裸数。 */
  math: { MaxInt32: 2147483647, MinInt32: -2147483648, MaxInt64: 9007199254740991,
    MaxFloat64: R(1.7976931348623157e308), SmallestNonzeroFloat64: R(5e-324),
    Pi: R(Math.PI), E: R(Math.E), Sqrt2: R(Math.SQRT2), Ln2: R(Math.LN2), Log2E: R(Math.LOG2E) },
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
/** 结构体要不要带 `__type`（见 `NEEDS_TYPETAG` 那段账）。 */
function typeTagged() { return NEEDS_TYPETAG || NEEDS_MTABLE; }

function structZero(n) {
  const fs = STRUCTS.get(n);
  if (fs === undefined || fs === null) return null;
  /* **互相引用截在这儿**（pt：`Shape.Intersect(Ray) Hit` 里的 Hit 有一格 `Shape Shape`）：
     正在造这格结构体的零值时又被问到它自己 —— 交回那格**还没填完**的记录，而不是 null。
     从前这道闸（`ZEROING`）回 null，那一格字段于是落成 int，于是 pt 的
     `shape := hit.Shape` 报"在一格说不清形状的东西上取字段 'NormalAt'"。
     为什么交半成品是安全的：字段名单在建壳那一刻就是全的（方言按"字段名单 + 字段类型"
     去重形状），值与 `fzero` 是**就地**填的，整趟走完它就是完整的那一份 ——
     与 `ifaceZero` 那道环闸、以及下面 `selfAt` 那一手（`fzero` 指回自己）同一个路数。
     go 里按值的环是写不出来的（无限大的结构体），所以环必经指针或接口 —— 那两种的值
     都是 `lit(null)`，不需要那一格先填好。 */
  const pend = SPEND.get(n);
  if (pend !== undefined) return pend;
  const off = typeTagged() ? 1 : 0;
  /* 先建壳（字段名对得上、值先占 null），下面逐格填。 */
  const shell = fs.map(([fn2]) => [fn2, lit(null)]);
  const rec = recordNew(typeTagged() ? [['__type', lit(n)], ...shell] : shell, byValFor(n));
  SPEND.set(n, rec);
  const fz = fs.map(() => null);
  try {
    /* **直接自引用的那一格**（`Left *Node` 在 Node 自己里）：值落空引用，类型在 `fzero`
       上**指回这格记录自己** —— 环只在 attrs 上（`walkCore` / `mapNodes` 只走 `ins`），
       与 ADR-0040 里接口 `rzero` 指回自己同一个手法，后端靠 `recPend` / `SELF_TY` 收敛。
       从前这一格落成 int（那道闸回 null），于是 `n.Left.X` 报
       "两处的类型不一样（r7 与 int）"（任务 #84）。 */
    const selfAt = fs.map(([, ft]) => selfPtrName(ft) === n);
    /* **声明成接口的字段，零值是空引用**（go 的 `var h Hit` 里 `h.Shape` 就是 nil）。
       值落 `lit(null)`、类型走 `fzero` —— 落那格"全是桩的零值记录"的代价是
       `h.Shape != nil` 恒为真（答案静默地错）。见 `nilFieldZero` 那段账。 */
    for (let i = 0; i < fs.length; i++) {
      const [fn2, ft] = fs[i];
      if (selfAt[i]) { fz[i] = rec; continue; }    /* 值已经是 lit(null) 了 */
      fz[i] = nilFieldZero(ft, lit(null));
      if (fz[i] === null) rec.ins.fields[off + i] = zeroOf(ft, `${n}.${fn2}`);
    }
  } finally {
    SPEND.delete(n);
  }
  const fzAll = typeTagged() ? [null, ...fz] : fz;
  if (fzAll.some((z) => z !== null)) rec.attrs.fzero = fzAll;
  return rec;
}

/** `*T` 里那个 T 的具名类型名（T 得是这份里登记过的 struct）。不是那个形状回 null。 */
function selfPtrName(ty) {
  if (ty === undefined || ty === null || !isList(ty)) return null;
  if (tag(ty) === 'paren') return selfPtrName(kids(ty)[0]);
  if (tag(ty) !== 'ptr') return null;
  const tn = namedTypeOf(kids(ty).find((y) => isList(y)));
  if (tn === null || STRUCTS.get(tn) === undefined || STRUCTS.get(tn) === null) return null;
  return tn;
}
/**
 * 字段写着 `nil`（或者压根没写）、而它声明成**引用类型**（接口 / `*具名结构体`）时，
 * 那一格的"声明的零值"（只作类型用，见 `graph/nodes.js` 上 `record-new` 的 `fzero`）。
 * 别的情形回 null —— 那时照旧走 `fieldValue`（浮点转、装箱那些）或真零值。
 *
 * 为什么 `*T` 也要（2026-09-21 补的）：`&Node{V: 2}` 里没写到的 `Left *Node` 从前落
 * `structZero(Node)` —— 一格**真记录**，于是 `root.Left.Left == nil` 是假（go 里是真）。
 * 那是"答案静默地错"。代价是 `p.In.V = 3` 这种"靠零值把嵌套那格先造出来"的写法会当场
 * 空引用 —— 而它在 go 里本来就是一次 panic。
 */
function nilFieldZero(ft, valNode) {
  if (ft === undefined || ft === null) return null;
  if (!isNilNode(valNode)) return null;
  const ifn = ifaceNameOf(ft);
  if (ifn !== null) return ifaceZero(ifn);
  const tn = selfPtrName(ft);
  if (tn !== null) return structZero(tn);      // 正在算它自己时回 null，照旧退回去
  return null;
}

/** 一格类型节点**剥到光名字**（`paren` 透传、具名类型跟着 `UNDER` 走一层）。不是光名字回 null。 */
function scalarNameOf(ty) {
  if (ty === undefined || ty === null) return null;
  if (tag(ty) === 'paren') return scalarNameOf(kids(ty)[0]);
  if (tag(ty) === 'tname' && kids(ty).length === 1) {
    const n = leaf(kids(ty)[0]);
    if (UNDER.has(n)) return scalarNameOf(UNDER.get(n));
    return n;
  }
  return null;
}

/**
 * 一格 struct 字面量里**某个字段的值**：字段声明成浮点时把值转成浮点。
 *
 * 为什么非要这一格（量出来的）：`Vec{1, 2, 3}` 的三个值是**整字面量**，而
 * `var v Vec`（走 `zeroOf`）出来的是 `convOf('float', lit(0))` —— 于是同一个 `Vec`
 * 在图上算出**两个形状**（`(ptr r1)` 与 `(ptr r2)`），core 那侧报
 * `'Vec__Dot' 第 1 格实参在两处的类型不一样`。
 * 无条件转是对的：go 里能摆进 float64 字段的值本来就可赋给 float64，转一下对浮点是空操作。
 *
 * **第二件事（ADR-0040）**：字段/形参声明成**接口**时，把值装箱（`boxInto`）。那一步要
 * 知道值的具体类型，所以第三个实参是**原树**（没递就只做浮点那一转，与从前一样）。
 */
function fieldValue(ft, v, ast) {
  const n = scalarNameOf(ft);
  const v2 = (n === 'float32' || n === 'float64') ? convOf('float', v) : v;
  const ifn = ifaceNameOf(ft);
  if (ifn === null) return v2;
  /* **接口位置上写 `nil`**（`f(nil)`）：值就落 `lit(null)`。
     从前这儿落"那格接口的零值记录"，理由是形状 —— 而那条理由 2026-09-21 之后作废了
     （`record-new.fzero` / `bind.tzero` / `func.pzero` 那一刀：值是 null、类型从声明来）。
     再落零值记录的代价是**答案静默地错**：那格记录不是 null，于是
     `switch s.(type) { case nil: }` 与 `s == nil` 在 `f(nil)` 这一趟上全不成立
     （量出来的：`nilKind(nil)` 印 0，go 印 100）。结构体字面量那一侧走的是
     `nilFieldZero` + `lit(null)`，与这儿同一条规矩。 */
  if (isNilNode(v2)) return v2;
  return ast === undefined ? v2 : boxInto(ifn, tnOfExpr(ast), v2);
}

/**
 * 每个顶层函数/方法**声明的形参类型节点**（`collectDecls` 里收，`argsByDecl` 拿来用）。
 * 键：函数名，或方法的 `Owner__Method`（那时第 0 格是接收者，存 undefined）。
 */
const FSIG = new Map();

/**
 * 一串实参**按声明的形参类型转一遍**（今天只有浮点那一格，与 `fieldValue` 同一条规矩）。
 *
 * 为什么非要它（量出来的，`tests/go/cases/04-multi-return.go`）：`mk(3, 4)` 给
 * `func mk(x, y float64)` 递的是**整字面量**，而 core 那条腿的形参是靠调用点定型的 ——
 * 同一个形参在一处是 real（`P{x,y}` 那侧推出来的）、在另一处是 int，于是报
 * 「'mk' 第 1 格形参落成了 real，可后面有一处调用给的是 int」。
 * go 的规矩是**无类型常量按形参的声明类型转** —— 声明就在 `FSIG` 里，照着转即可；
 * 对本来就是浮点的实参这一转是空操作（与 `fieldValue` 那段账同理）。
 */
function argsByDecl(name, nodes, skip, asts) {
  const tys = FSIG.get(name);
  if (tys === undefined) return nodes;
  const off = skip === true ? 1 : 0;
  return nodes.map((a, i) => {
    const ty = tys[i + off];
    return ty === undefined ? a : fieldValue(ty, a, asts === undefined ? undefined : asts[i]);
  });
}

/**
 * **这串数字字面量在 go 眼里是浮点吗**（只看写法）。
 *
 * go 的规矩：带小数点或指数的就是浮点常量（默认 float64）。十六进制那一档不一样 ——
 * `0x1F` 是整数，只有带 `p` 指数的 `0x1p-2` 才是浮点。
 */
function isGoFloatTok(s) {
  if (s.length > 1 && s[0] === '0' && (s[1] === 'x' || s[1] === 'X')) {
    return s.includes('p') || s.includes('P');
  }
  return s.includes('.') || s.includes('e') || s.includes('E');
}

/**
 * **这串整数字面量过得了 JS 的 double 吗** —— 过不了就把原文带上（`const` 的 `exact`）。
 *
 * 判据是"回写一遍还是同一串数字吗"：`BigInt(txt)` 认十进制、`0x`/`0o`/`0b` 与
 * go 的下划线分隔（先剥掉），而 `BigInt(v)` 只在 v 是整数时成立。
 * 浮点写法（带小数点或指数）不在这一格 —— 那本来就是双精度，没有"原文更准"这回事。
 */
function exactOf(txt, v) {
  if (!Number.isInteger(v) || isGoFloatTok(txt)) return {};
  let big;
  try { big = BigInt(txt.replace(/_/g, '')); } catch { return {}; }
  return String(big) === String(BigInt(v)) ? {} : { exact: String(big) };
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
  /* `[]T` 的零值：**一格带着声明的元素类型的空列表**，不是 `null`。
     go 里 nil 切片与空切片在 `== nil` 上不同，但 `len` / `append` / 取下标是一样的，
     而图上压根没有"nil 切片"这个概念 —— 落 `null` 的代价是下游连元素类型都不知道
     （core 那侧报「'spheres' 是一格 null（没赋过值）」）。`elem` 那一格见
     `graph/nodes.js` 上 `list-new` 的那段话。元素自己没有零值（接口 / 函数类型套进来）
     时退回 `null`：那时下游报的还是原来那句，不多也不少。 */
  if (t === 'slice') {
    const el = kids(ty).find((y) => tag(y) !== 'none');
    if (el === undefined) return lit(null);
    let ez = null;
    try { ez = zeroOf(el, `${name}[]`, pkg); } catch { ez = null; }
    return ez === null || ez === undefined ? lit(null) : listNew([], ez);
  }
  /* **通道的零值是 0**（不是 `null`）：channel 在这条路上是 `libomnigo` 里那格 `hchan`
     的**地址**，而方言里地址就是一个整数（见 `backend-core.js` 的 `C_RT`）。
     go 的 nil channel 也正是 0 —— 差的只有一处：go 里在它上面收发是**永久阻塞**，
     而 `omni_go_chan_send` 会报一句话再 abort（永久阻塞在我们这儿查不出来，
     一句话比挂死好）。落 `null` 的代价是下游当场报「'ch' 是一格 null」。 */
  /* **`*T` 里 T 是具名结构体时，零值是 T 的零值记录**（见 `PTRED` 那段账）：
     记录在方言里本来就是一格指针（引用语义那一档），所以这既有类型又不改语义。
     T 不是结构体（`*int` / `*任何接口`）、或者正在算它自己的零值（自引用）时落回 null。 */
  if (t === 'ptr') {
    const tn = namedTypeOf(kids(ty).find((y) => isList(y)));
    if (tn !== null && STRUCTS.get(tn) !== undefined && STRUCTS.get(tn) !== null) {
      const z = structZero(tn);
      if (z !== null) return z;
    }
  }
  if (t === 'chan' || t === 'chan-send' || t === 'chan-recv') return lit(0);
  /* **接口的零值是那格方法闭包记录的"全是桩"版**（ADR-0040，见 `ifaceZero` 那段账）：
     落 `lit(null)` 的代价是形参/字段说不清类型 —— 那正是 pt 整包卡住的那一句。
     算不出来（方法的返回类型又是接口、互相引用）时照旧落回下面的 `lit(null)`。 */
  {
    const ifn = ifaceNameOf(ty);
    if (ifn !== null) {
      const z = ifaceZero(ifn);
      if (z !== null) return z;
    }
  }
  /* **map 的零值**：值是标量时落一格空字典（不是 `null`）—— 与上头切片那一格同一条
     理由：落 `null` 的话下游连键值类型都不知道（core 报「'm' 是一格 null（没赋过值）」）。
     与 go 的差：go 的 nil map **写进去要 panic**、`== nil` 为真；读 / `len` / `range`
     两边一样。
     **值语义的结构体（byval）不收**：方言的 `(dict K V)` 的 V 现在收
     int/real/bool/string **与类**（引用语义的记录，格子里躺一个句柄）—— 值语义那档
     要格子里就地躺一整块，而三条腿现在对不上（run-c 是拷贝、interp 与 js 是别名），
     那是任务 #83。pt 的 `var textures map[string]Texture`（接口 = byval 记录）
     就在后一档上，所以它照旧落 `null`。 */
  if (t === 'map') {
    const [kz, vz] = mapZeros(ty, name, pkg);
    const ok = (z) => z !== null && z !== undefined && typeof z === 'object'
      && ((z.op === undefined && 'lit' in z && z.lit !== null)
        || (z.op === 'record-new' && (z.attrs === undefined || z.attrs.byval !== true)));
    if (ok(kz) && ok(vz)) return mapNew([], kz, vz);
  }
  if (NIL_TYPES.has(t)) return lit(null);
  // `[N]T` 的零值是**N 格元素零值**（数组是值语义的，不是切片）——
  // N 得是个整数字面量、元素也得有零值，两样缺一样就当场报。
  if (t === 'array') {
    const [n, el] = kids(ty);
    if (tag(n) !== 'num') {
      /* `[N]T` 里 N 不是字面量而是**具名常量**（真 go 标准库里到处是：`math/rand` 的
         `rngSource.vec [_LEN]int64`）—— 落 `fill(N, T 的零值)`：长度按那个常量算，
         **元素类型跟着零值走**。形状与 `makeOf` 的 `make([]T, n)` 那一支一模一样。

         从前这儿落一格**空 `list-new`**，而空列表把元素类型丢了 —— core 那侧当场报
         `记录的字段 'vec' 是一格列表，可它的类型推不出来`（`declTypeOfNode` 答 null）。
         元素自己没有零值（接口 / 函数类型）时照旧退回空列表，那一格由别处报。 */
      const ez0 = zeroOf(el, name, pkg);
      if (ez0 === null || ez0 === undefined) return listNew([]);
      return node('prim', { args: [toNode(n), ez0] }, { name: 'fill' });
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
    return recordNew(fs.map(([fn, ft]) => [fn, zeroOf(ft, `${name}.${fn}`, pkg)]), true);
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
    if (segs.length === 2 && IMPORTS.has(segs[0])) return qualZero(qual, name);
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
    if (segs.length === 2 && IMPORTS.has(segs[0])) return qualZero(qual, name);
    throw new Error(`go->graph: 带包限定的类型 ${qual} 的零值要那个包的声明 ——`
      + ' 那个名字这一份文件没 import 过（点导入 / 别名对不上）');
  }
  /* **兜底**：图上没有的类型零值（tinst 泛型实例化、ptr 指针、func 函数、chan 通道等）
     降成 null（interface / func / ptr 零值本来就是 nil，tinst 的精确零值需要单态化）。 */
  return lit(null);
}

/**
 * **包限定的类型名的零值**：先按**平名字空间**试，再退到跨包表。
 *
 * 两条路，各管一档：
 *
 * * `--pkgs`（`src/lib/go/…` 那几份桩、pt 整包）把依赖包的顶层声明摊进**同一个平
 *   名字空间**（`graph/run.js` 的 byPkg），所以 `color.RGBA64` 的声明就在本地那两张表里
 *   —— 短名去查就有。这是这一格要救的那一档。
 * * 语料那条路（go 编译器自己的 780 份）没摊平，`syntax.Pos` 只在 `XPKG` 里。
 *
 * 先试平的、再试跨包的：两张表都查不着才落回原来的行为。
 *
 * 为什么非要它（量出来的）：`func (p *Image64) SetRGBA64(x, y int, c color.RGBA64)` 的
 * `c` 拿不到 `pzero` ⇒ 形参只能靠调用点定型 ⇒ 推成 `int` ⇒ `c.R` 报
 * "'c' 说不清形状"。pt 整包就卡在这一句（它是我们自己那份 image 桩里的）。
 */
function qualZero(qual, name) {
  const tail = qual.slice(qual.indexOf('.') + 1);
  if (STRUCTS.get(tail) !== undefined && STRUCTS.get(tail) !== null) {
    try { return structZero(tail); } catch { /* 自引用之类：往下走 */ }
  }
  if (UNDER.has(tail)) {
    try { return zeroOf(UNDER.get(tail), `${name}:${tail}`); } catch { /* 往下走 */ }
  }
  return xzeroOf(qual, name);
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
function bindName(n, v, tzero) {
  if (n === '_') return [v];
  return [node('bind', { init: v },
    (tzero === undefined || tzero === null) ? { name: n } : { name: n, tzero })];
}

/**
 * `var x T` 里 T 是**引用类型**（接口 / `*具名结构体`）时那一格的"声明的零值"
 * （只作类型用，见 `bind` 的 `tzero`）。别的类型回 null —— 那时照旧落真零值。
 *
 * 与 `nilFieldZero` 差一处：字段那边**只认接口**（`*T` 字段有代码靠"那格记录一上来
 * 就在"），而**局部/包级变量**这边 `*T` 也认 —— `var p *T` 之后不先赋值就取字段在 go 里
 * 是一次 panic，没有哪份代码能靠着它。
 */
function nilVarZero(ty) {
  if (ty === undefined || ty === null) return null;
  const ifn = ifaceNameOf(ty);
  if (ifn !== null) return ifaceZero(ifn);
  if (tag(ty) === 'paren') return nilVarZero(kids(ty)[0]);
  if (tag(ty) === 'ptr') {
    const tn = namedTypeOf(kids(ty).find((y) => isList(y)));
    if (tn !== null && STRUCTS.get(tn) !== undefined && STRUCTS.get(tn) !== null) {
      return structZero(tn);
    }
  }
  return null;
}

/** 一格 spec 的名字表对初值表：数目相等就逐个绑，N 对 1 是多值，没初值就落零值。 */
/**
 * **多返回那几格的声明类型记进 `VARTY` / `VARTYPE`**（`l, r := f()` / `l, r = f()`）。
 *
 * 少了它，`l` 的类型这一层看不出来：`l[0].Area()` 会落成**静态 mangle**（`Area` 在平表里
 * 只有一个主人时尤其），报"'Sq__Area' 第 1 格实参在两处的类型不一样"；pt 的
 * `NewNode(l)` 也是这一格（`(arr r18)` 与 int）。类型从 `FOUTS`（声明）来。
 */
function noteMultiTypes(names, rhs) {
  if (rhs === undefined || rhs === null || !isList(rhs) || tag(rhs) !== 'call') return;
  const fn = kids(rhs)[0];
  let key = null;
  if (fn !== undefined && tag(fn) === 'name') key = leaf(kids(fn)[0]);
  else if (fn !== undefined && tag(fn) === 'sel') {
    const on = namedTypeOf(tyOfExpr(kids(fn)[0]));
    const m = leaf(kids(fn)[1]);
    if (on !== null && m !== null) key = mangle(on, m);
  }
  if (key === null) return;
  const outs = FOUTS.get(key);
  if (outs === undefined || outs.length !== names.length) return;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === '_') continue;
    VARTY.set(names[i], outs[i]);
    const tn = namedTypeOf(outs[i]);
    if (tn !== null) VARTYPE.set(names[i], tn);
  }
}

function specBinds(names, exprs, ty) {
  /* 声明写着类型时留一份**类型节点**（`tyOfExpr` 要它：`var xs []Shape` 的元素类型、
     `var s Shape` 的接口分派）。 */
  if (ty !== undefined) for (const n of names) VARTY.set(n, ty);
  if (exprs === null) {
    /* **没初值、而声明的是引用类型**（`var p *T` / `var s Shape`）：go 的零值是 nil。
       值落空引用、类型走 `bind` 的 `tzero`（见 `nilFieldZero` 与 nodes.js 那两段账）——
       落"那个类型的零值记录"的代价是 `p == nil` 恒为假。 */
    const nz = nilVarZero(ty);
    if (nz !== null) return names.flatMap((n) => bindName(n, lit(null), nz));
    return names.flatMap((n) => bindName(n, zeroOf(ty, n)));
  }
  if (names.length > 1 && exprs.length === 1) {
    noteMultiTypes(names, exprs[0]);
    return destructure(names, toNode(exprs[0]), { declare: true });
  }
  if (names.length !== exprs.length) {
    throw new Error(`go->graph: ${names.length} 个名字对 ${exprs.length} 个初值 —— 这一批不猜`);
  }
  /* `var s Shape = Sq{2}`：声明的类型是接口就在这儿装箱（ADR-0040）。 */
  const ifn = ifaceNameOf(ty);
  /* **`var x = f(…)`（没写类型）也要把右边的声明类型记一份** —— 与 `:=` 那一处
     （`VARTY.set(nameOf(t), tyOfExpr(rhs))`）是同一件事，只是走的是 `var` 这条语法。
     少了它，包级的 `var globalRand = New(NewSource(1))` 之后 `globalRand.Int63()`
     认不出主人：`Int63` 在平表里有两个主人（`Rand` / `rngSource`），于是落到
     "取字段再调它"上，core 那侧报"记录 r2 上没有字段 'Int63'"。 */
  if (ty === undefined) {
    for (let i = 0; i < names.length; i++) {
      const rt = tyOfExpr(exprs[i]);
      if (rt !== null) VARTY.set(names[i], rt);
      const rtn = namedTypeOf(rt);
      if (rtn !== null) VARTYPE.set(names[i], rtn);
    }
  }
  return names.flatMap((n, i) => bindName(n, ifn === null ? toNode(exprs[i])
    : boxInto(ifn, tnOfExpr(exprs[i]), toNode(exprs[i]))));
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
 * **两格左值是同一个地方吗**（只认光名字与一串取字段 —— 别的一律回 false，不猜）。
 * `s = append(s, v)` 那一格特判要它（见 `case 'assign'`）。
 */
function sameLValue(a, b) {
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (tag(a) === 'paren') return sameLValue(kids(a)[0], b);
  if (tag(b) === 'paren') return sameLValue(a, kids(b)[0]);
  if (tag(a) === 'name' && tag(b) === 'name') return nameOf(a) === nameOf(b);
  if (tag(a) === 'sel' && tag(b) === 'sel') {
    return leaf(kids(a)[1]) === leaf(kids(b)[1]) && sameLValue(kids(a)[0], kids(b)[0]);
  }
  return false;
}

/**
 * `s = append(s, v…)` 里**要推进去的那几格**（不是这个形状就回 null）。
 * 带 spread 的（`append(a, b...)`）回 null —— 那一档不是"推几格"。
 */
function appendSelfItems(lv, rv) {
  if (rv === undefined || rv === null || !isList(rv) || tag(rv) !== 'call') return null;
  const [fn, args] = kids(rv);
  if (fn === undefined || tag(fn) !== 'name' || nameOf(fn) !== 'append') return null;
  if (args === undefined) return null;
  const as = kids(args);
  if (as.length < 2 || as.some((y) => tag(y) === 'spread')) return null;
  if (!sameLValue(lv, as[0])) return null;
  return as.slice(1);
}

/**
 * `s = append(s, xs...)` 里**那一格要摊开的切片**（不是这个形状就回 null）。
 *
 * go 的规矩：spread 只能有一格、而且必须在最后。语法树上它是**缀在实参表末尾的一格空标记**
 * （`(-> (arg-list "...") ($*1 (spread)))`），不是把那个表达式包起来 —— 所以
 * `append(s, xs...)` 的实参表是 `[s, xs, (spread)]` 三格。
 */
function appendSelfSpread(lv, rv) {
  if (rv === undefined || rv === null || !isList(rv) || tag(rv) !== 'call') return null;
  const [fn, args] = kids(rv);
  if (fn === undefined || tag(fn) !== 'name' || nameOf(fn) !== 'append') return null;
  if (args === undefined) return null;
  const as = kids(args);
  if (as.length !== 3 || tag(as[2]) !== 'spread') return null;
  if (!sameLValue(lv, as[0])) return null;
  return as[1];
}

/** `s = append(s, xs...)` 那一格摊开用的序号（临时名要各不相同）。 */
let SPREAD_N = 0;

/** 类型 switch 的序号（主语那格隐藏名要各不相同）。 */
let TSW_N = 0;

/**
 * `s = append(s, xs...)` 落成**一趟数着的循环 + 一串 push**。
 *
 * 为什么不落 `call __goAppend`：那个函数的体在 **js 那条腿的运行时**里，core 上压根没有
 * （量出来：pt 整包报"调一格这一层里没有的函数 '__goAppend'"）。
 *
 * **长度先取一份**（`__spN_n`）：`a = append(a, a...)` 这种自己摊给自己的写法，go 的语义是
 * "把原来那些接上去"；条件里每趟重算 `len(a)` 的话它会一直长下去。
 */
function appendSpreadPush(lv, srcAst) {
  SPREAD_N += 1;
  const src = `__sp${SPREAD_N}_s`;
  const cnt = `__sp${SPREAD_N}_n`;
  const idx = `__sp${SPREAD_N}_i`;
  const at = (n) => node('ref', {}, { name: n });
  const elT = elemTyOf(tyOfExpr(lv));
  const elem = indexGet(at(src), at(idx));
  return node('region', {
    body: [
      node('bind', { init: toNode(srcAst) }, { name: src }),
      node('bind', { init: node('prim', { args: [at(src)] }, { name: 'len' }) }, { name: cnt }),
      counted({
        name: idx,
        from: lit(0),
        cond: bin('<', at(idx), at(cnt)),
        body: [node('prim', {
          args: [toNode(lv), elT === null ? elem : fieldValue(elT, elem, undefined)],
        }, { name: 'push' })],
      }),
    ],
  });
}

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
 * **作用域栈**（用来判断 `:=` 里哪些是新声明、哪些是重用）。
 *
 * 判据照 go 的规矩：短声明只在**同一个块**里重声明才算赋值
 * （"provided they were originally declared earlier in the same block"）；
 * 外层块里的同名是**遮蔽**，那是一格新声明。
 *
 * 为什么必须分层（量出来的）：`for i := 0 …{}` 两趟连着写时，头一趟的 `i` 落在
 * 那一格 `(do (let i …) (while …))` 里边，出了那格就没了。拿一个平的集合判，
 * 第二趟的 `i := 0` 会被当成重用发 `set` —— 方言当场报"未声明的变量 'i'"。
 */
let SCOPES = [new Set()];
const declHere = (n) => SCOPES[SCOPES.length - 1].add(n);
const seenHere = (n) => SCOPES[SCOPES.length - 1].has(n);
/** 进一层块：回调里发生的声明出了这一层就不算了。 */
function inScope(f) {
  SCOPES.push(new Set());
  try { return f(); } finally { SCOPES.pop(); }
}

/**
 * 一格签名的形参表收成 `[{nm, ty}, …]`（**只收带名字的那些**）。
 *
 * 从 `funcOf` 里抽出来是因为 `collectDecls` 也要它：调用点要按**声明的形参类型**
 * 转实参（`FSIG`，见 `argsByDecl`），那张表必须与 `funcOf` 算出的形参**同一条规则、
 * 同一个顺序** —— 两处各写一遍就会错位。
 */
/**
 * **具名的返回值**（`func f() (left, right bool)`）：`[{nm, ty}, …]`，没具名回空表。
 *
 * `(out …)` 在树上与 `(in …)` 同形，所以判据与 `paramInfo` 逐字一样（`(left, right bool)` 里
 * `left` 被语法收成了"类型"，只要有一格真带名字，那些光秃秃的 `tname` 其实是名字）。
 * 单返回不具名的那一档（`func f() bool`）回空表 —— 那时 `return` 本来就带值。
 */
function outInfo(sig) {
  const outs = partKids(sig, 'out');
  if (outs.length === 0) return [];
  const anyNamed = outs.some((p) => part(p, 'name') !== undefined);
  if (!anyNamed) return [];
  const info = outs.map((p) => {
    const nm = part(p, 'name');
    const ty = kids(p).find((y) => tag(y) !== 'name');
    if (nm !== undefined) return { nm: leaf(kids(nm)[0]), ty };
    const tn = kids(p).find((y) => isList(y) && tag(y) === 'tname');
    if (tn !== undefined && kids(tn).length === 1) return { nm: leaf(kids(tn)[0]), ty: undefined };
    return { nm: null, ty };
  }).filter((x) => x.nm !== null);
  /* 一组共享类型，从后往前补（与 `paramInfo` 同一条）。 */
  let lastTy;
  for (let i = info.length - 1; i >= 0; i--) {
    if (info[i].ty === undefined) info[i].ty = lastTy;
    else lastTy = info[i].ty;
  }
  return info.filter((x) => x.ty !== undefined);
}

/**
 * 一格签名的**多返回类型节点表**（`FOUTS` 存的就是它）。
 *
 * **不能直接用 `partKids(sig, 'out')`**：具名的返回值（`(left, right []Shape, n int)`）
 * 里 `left` 被语法收成了"类型"，那一格拿去当类型使就是垃圾（量出来：`VARTY` 里
 * `l` 的类型成了 `(tname left)`，于是 `l[0]` 的元素类型还是说不清）。
 * 具名那一档走 `outInfo`（它按参数组共享类型补齐），不具名的照旧用原表。
 */
function outTypes(sig) {
  const raw = partKids(sig, 'out');
  const named = outInfo(sig);
  if (named.length === raw.length) return named.map((o) => o.ty);
  return raw;
}

function paramInfo(sig) {
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
  return pinfo;
}

/**
 * **go 的终止语句：无条件的 `for`**（规范 "Terminating statements" 第 4 条）——
 * `for { … }` 而且**没有 break 跳出它**。以这么一句收尾的函数不需要尾随 return，
 * go 自己也不要求（真 go 的 `math/rand` 里 `Rand.NormFloat64`/`ExpFloat64` 就是这个形状）。
 *
 * break 必须按**作用域**算，不能"子树里有 break 就算有"：`NormFloat64` 的外层 `for` 里
 * 嵌着一个带 break 的**内层** `for`，那个 break 跳的是内层。所以往下走时遇到 `loop`
 * （以及吃 break 的 `switch` 那一族）就不再看它里头。判不准时一律**算有** ——
 * 那时只是退回今天的行为（core 报"体末尾不是 ret"），不会给错答案。
 */
function breaksOut(n) {
  if (n === null || n === undefined || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some(breaksOut);
  if (n.op === 'loop' || n.op === 'switch' || n.op === 'match') return false;
  if (n.op === 'loop-exit' && n.attrs !== undefined && n.attrs.kind === 'break') return true;
  return Object.values(n.ins === undefined ? {} : n.ins).some(breaksOut);
}

/** 这一句是"无条件的 for、且没人 break 出来"吗（`threePart({cond: undefined})` 出来的形状）。 */
function foreverLoop(n) {
  if (n === null || n === undefined || typeof n !== 'object' || n.op !== 'loop') return false;
  const c = n.ins === undefined ? undefined : n.ins.cond;
  if (c === null || c === undefined || typeof c !== 'object' || c.lit !== true) return false;
  return !breaksOut(n.ins.body);
}

/**
 * **无类型常量表达式的任意精度求值**（go 规范 "Constant expressions"）。算不出来回 `null`。
 *
 * 只认字面量与算符：`+ - * / % << >> & | ^` 与一元 `-`/`^`。名字、调用、转换一律算不出来
 * （回 null）—— 宁可不折，也不猜。`/` 与 `%` 按 BigInt 的截断走，与 go 的整型常量一致。
 */
/** 这棵常量表达式里有移位吗（只对含移位的折，见 `case 'bin'` 那段账）。 */
function hasShift(x) {
  const t = tag(x);
  if (t === 'bin') {
    const o = leaf(kids(x)[0]);
    if (o === '<<' || o === '>>') return true;
    return hasShift(kids(x)[1]) || hasShift(kids(x)[2]);
  }
  if (t === 'paren') return hasShift(kids(x)[0]);
  if (t === 'un') return hasShift(kids(x)[1]);
  return false;
}

function constBig(x) {
  const t = tag(x);
  if (t === 'num') {
    const s0 = String(leaf(kids(x)[0]));
    if (!/^[0-9]+$/.test(s0)) return null;          // 浮点 / 科学计数不走这条
    try { return BigInt(s0); } catch { return null; }
  }
  if (t === 'paren') return constBig(kids(x)[0]);
  if (t === 'un') {
    const o = leaf(kids(x)[0]);
    const v = constBig(kids(x)[1]);
    if (v === null) return null;
    if (o === '-') return -v;
    if (o === '^') return -v - 1n;                  // go 的一元 `^` 是按位取反
    if (o === '+') return v;
    return null;
  }
  if (t !== 'bin') return null;
  const [op, a, b] = kids(x);
  const av = constBig(a);
  const bv = constBig(b);
  if (av === null || bv === null) return null;
  switch (leaf(op)) {
    case '+': return av + bv;
    case '-': return av - bv;
    case '*': return av * bv;
    case '/': return bv === 0n ? null : av / bv;
    case '%': return bv === 0n ? null : av % bv;
    case '<<': return (bv < 0n || bv > 512n) ? null : av << bv;
    case '>>': return (bv < 0n || bv > 512n) ? null : av >> bv;
    case '&': return av & bv;
    case '|': return av | bv;
    case '^': return av ^ bv;
    default: return null;
  }
}

function funcOf(sig, blk, name, self, selfType) {
  const inParams = partKids(sig, 'in');
  const pinfo = paramInfo(sig);
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
  const savedTys = new Map(VARTY);
  const savedScopes = SCOPES;
  /* 函数体自己是一层块，形参就声明在这一层（go 的规矩把形参表算进函数体那个块）。 */
  SCOPES = [new Set()];
  for (const p of params) declHere(p);
  if (self !== undefined) declHere(self);
  if (self !== undefined && selfType !== undefined && selfType !== null) {
    VARTYPE.set(self, selfType);
    /* **接收者的类型节点也留一份**（`VARTY`）：`tyOfExpr` 靠它往下追 ——
       `func (a Box) Anchor(…) { return a.Min.Add(…) }` 里 `a.Min` 的类型要先知道
       `a` 是 Box。少这一格，`a.Min.Add(…)` 会落到"取字段再调它"的兜底上，
       core 那侧报"记录 r1 上没有字段 'Add'"（pt 的 `Box__Anchor` 撞的就是它）。
       手里只有类型**名字**（指针接收者已经剥过一层），所以现搭一格 `(tname X)`。 */
    VARTY.set(self, { kind: 'list', items: [
      { kind: 'atom', value: 'tname' }, { kind: 'atom', value: selfType },
    ] });
  }
  /* **形参的类型走 `paramInfo`**（不要自己再拆一遍 sig）。
     `func LookAt(eye, center, up Vector, fovy float64)` 这种**参数组**在树上是
     `p(eye)` `p(center)` `p(up Vector)` —— 前两格的名字被语法当成了类型，`part(p,'name')`
     是空的。从前这一处就是那么拆的，于是只有 `up` 进了 `VARTYPE`：`center.Sub(eye)` 认不出
     主人（`Sub` 在平表里有 `Vector` / `Color` 两个主人），落到"取字段再调它"的兜底上，
     core 那侧报 `'Vector__Normalize' 第 1 格实参在两处的类型不一样（r2 与 int）`。
     `paramInfo` 已经把"名字被当成类型"和"一组共用后面那个类型"两条都摆平了。 */
  for (const p of paramInfo(sig)) {
    const t = namedTypeOf(p.ty);
    if (t !== null) VARTYPE.set(p.nm, t);
    /* 形参的**类型节点**也留一份（`tyOfExpr` 要它：`[]Shape` 的元素类型、接口分派）。 */
    if (p.ty !== undefined) VARTY.set(p.nm, p.ty);
  }
  /* 当前函数**声明的返回类型**（`ret` 那一处按它装箱）。 */
  const savedRet = CUR_RET;
  const savedOuts = CUR_OUTS;
  {
    const o = partKids(sig, 'out');
    CUR_RET = o.length === 1 ? o[0] : null;
    /* **具名的返回值**（见 `CUR_OUTS`）：`(out …)` 与 `(in …)` 同形，所以用同一份
       `paramInfo` 的规矩去认（`(left, right bool)` 里 `left` 被语法当成了类型）。
       认出名字来才补得出光秃秃的 `return`。 */
    CUR_OUTS = outInfo(sig);
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
    let fbody = blk === undefined ? [] : many(kids(blk));
    /* **具名的返回值先按声明的零值绑出来**（见 `CUR_OUTS`）：go 里它们进函数就是零值、
       体里当普通局部量用，光秃秃的 `return` 交回它们当时的值。
       摆在体的最前面 —— 体里第一句就可能读它。 */
    if (CUR_OUTS.length > 0) {
      const decls = CUR_OUTS.map((o) => {
        const nz = nilVarZero(o.ty);
        return nz !== null
          ? node('bind', { init: lit(null) }, { name: o.nm, tzero: nz })
          : node('bind', { init: zeroOf(o.ty, o.nm) }, { name: o.nm });
      });
      fbody = [...decls, ...fbody];
    }
    /* 终止语句那一条（见 `foreverLoop` 的头注释）：补一格**不可达的** `ret 零值`。
       不可达所以那个值永远看不见 —— 与 core 那句"补零值会给错答案"不矛盾，
       它说的是**会真掉下去**的那一种。多返回的函数这一格还没做（`rz` 只有单返回才算）。 */
    if (rz !== null && fbody.length > 0 && foreverLoop(fbody[fbody.length - 1])) {
      fbody = [...fbody, retOf([rz])];
    }
    return node('func', { body: fbody },
      { params: self === undefined ? params : [self, ...params], name,
        ...(anyZero ? { pzero: pz } : {}),
        ...(rz !== null ? { rzero: rz } : {}),
        /* **这个函数一个返回值都没有**（go 的 `func (r *Rand) Seed(seed int64)`）。
           非说出来不可：图上"体里没有 ret"与"隐式返回（末尾那个值就是返回值）"同形，
           core 那侧的 `implicitRet` 于是把末尾那一句当成了返回值 —— 量出来是
           `(fn Rand__Seed (…) int (ret (callfn (fld (fld (var r) src) Seed) …)))`，
           方言当场 `要返回 int，给的是 void`。go 这侧本来就知道答案，说一声就行。 */
        ...(outs.length === 0 ? { noret: true } : {}),
        ...(restParam !== undefined ? { restParam } : {}) });
  } finally {
    VARTYPE.clear();
    for (const [k, v] of savedVars) VARTYPE.set(k, v);
    VARTY.clear();
    for (const [k, v] of savedTys) VARTY.set(k, v);
    CUR_RET = savedRet;
    CUR_OUTS = savedOuts;
    SCOPES = savedScopes;
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
  /* 每一支自己是一层隐式块（go 的规矩），所以两支各写 `v := …` 是两格新声明。 */
  return inScope(() => armBodyOf(c));
}

function armBodyOf(c) {
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

/** `select` 那几格用的小工具：调一格运行时的名字。 */
const rtCall = (nm, as) => node('call', { fn: node('ref', {}, { name: nm }), args: as ?? [] });

/** `select` 里的深度（临时名要唯一 —— select 能套 select）。 */
let SEL_DEPTH = 0;

/**
 * **`select { case … }`** 落成三段（照 go 规范里它的语义，见 `omni_go.h` 上那段账）：
 *   1. 把每一格 case **报上去**（`__goSelBegin` + 一串 `__goSelRecv`/`__goSelSend`/
 *      `__goSelDefault`）—— 发那一路要发的值**在这一刻就求好**，与 go 的求值次序一致；
 *   2. `idx = __goSelGo()` 真选（没有 default 且全阻塞就 park）；
 *   3. 按 `idx` 落一条 if 链，收那一路的体里先把 `v` / `ok` 从 `__goSelVal` / `__goSelOK`
 *      绑出来。
 *
 * 从前这一格是"取第一个 case 的体、无条件跑" —— 编得出来、跑得动、**答案静默地错**。
 *
 * 接四种 comm（别的当场报）：`v := <-ch` / `v, ok := <-ch` / `<-ch` / `ch <- v`。
 * 每一格 case 自己是一层块（go 的规矩），所以体走 `armOf`（它顺带管 `break`）。
 */
function selectOf(x) {
  const comms = kids(x).filter((y) => tag(y) === 'case' || tag(y) === 'default');
  if (comms.length === 0) {
    /* `select {}`：go 里那是**永久阻塞**。图上没有"停在这儿"那一格，报。 */
    throw new Error('go->graph: 空的 `select {}` 是永久阻塞 —— 图上没有那一格');
  }
  const idxName = `__sel${SEL_DEPTH}`;
  const pre = [rtCall('__goSelBegin')];
  const arms = [];
  SEL_DEPTH += 1;
  try {
    comms.forEach((c) => {
      if (tag(c) === 'default') {
        pre.push(rtCall('__goSelDefault'));
        arms.push({ body: armOf(c) });
        return;
      }
      const s0 = kids(c)[0];
      /* 光一句 `<-ch` 在树上裹着一层 `expr`（语句位置上的表达式）。 */
      const s = (isList(s0) && tag(s0) === 'expr') ? kids(s0)[0] : s0;
      /* 三种"收"与一种"发"。`simple` 那一格在树上就是一句普通语句。 */
      if (tag(s) === 'send' || tag(s) === 'chan-send') {
        const [chn, v] = kids(s);
        pre.push(rtCall('__goSelSend', [toNode(chn), toNode(v)]));
        arms.push({ body: armOf(c) });
        return;
      }
      if (tag(s) === 'recv') {
        pre.push(rtCall('__goSelRecv', [toNode(kids(s)[0])]));
        arms.push({ body: armOf(c) });
        return;
      }
      if (tag(s) === 'define' || tag(s) === 'assign') {
        const lhs = kids(s).filter((y) => tag(y) === 'lhs').flatMap(kids);
        const rhs = kids(s).filter((y) => tag(y) === 'rhs').flatMap(kids);
        if (rhs.length === 1 && tag(rhs[0]) === 'recv' && lhs.length >= 1 && lhs.length <= 2) {
          pre.push(rtCall('__goSelRecv', [toNode(kids(rhs[0])[0])]));
          /* 体的最前面把 `v`（与 `ok`）绑出来 —— 与 `v, ok := <-ch` 同一条路数。 */
          const isDef = tag(s) === 'define';
          const mk = (t, init) => (isDef
            ? node('bind', { init }, { name: nameOf(t) })
            : node('set', { value: init }, { name: nameOf(t) }));
          const head = [];
          if (nameOf(lhs[0]) !== '_') head.push(mk(lhs[0], rtCall('__goSelVal')));
          if (lhs.length > 1 && nameOf(lhs[1]) !== '_') {
            head.push(mk(lhs[1], binOf('!=', rtCall('__goSelOK'), lit(0), OPS, { lang: 'go' })));
          }
          arms.push({ body: node('region', { body: [...head, armOf(c)] }) });
          return;
        }
      }
      throw new Error(`go->graph: select 的 case 只接 \`v := <-ch\` / \`v, ok := <-ch\``
        + ` / \`<-ch\` / \`ch <- v\`（这儿是 ${tag(s)}）`);
    });
  } finally {
    SEL_DEPTH -= 1;
  }
  pre.push(node('bind', { init: rtCall('__goSelGo') }, { name: idxName }));
  /* 按下标落 if 链（从后往前串，与 `switchOf` 同一条）。 */
  let chain;
  for (let i = arms.length - 1; i >= 0; i -= 1) {
    chain = branchOf(
      binOf('==', node('ref', {}, { name: idxName }), lit(i), OPS, { lang: 'go' }),
      arms[i].body, chain,
    );
  }
  return node('region', { body: [...pre, chain] });
}

function switchOf(x) {  const all = kids(x);
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
  /* **range 的值变量也要登记类型**（`VARTY` / `VARTYPE`）—— 体里 `shape.BoundingBox()`
     那一族靠它才 mangle 得出静态调用。元素类型从主语的声明类型来
     （`for _, shape := range shapes`，`shapes` 声明成 `[]*Triangle` 就是 `*Triangle`）。
     量出来的：pt 的 `BoxForShapes`（`[]Shape`）与 `BoxForTriangles`（`[]*Triangle`）
     里那两格 `shape` 同名不同型 —— 不登记就双双落到"取字段再调它"的兜底上，
     core 那侧报"'Box__Extend' 第 2 格实参在两处的类型不一样（r2 与 int）"。
     **只在 `:=` 那一档登记**（`=` 那种名字是外层的，类型不归这儿说）。 */
  const savedRgVars = new Map(VARTYPE);
  const savedRgTys = new Map(VARTY);
  if (isDef) {
    const elT = elemTyOf(tyOfExpr(subj));
    /* 一格名字时这一份把它当**值**（见下面那段账里"1-name 在序列上绑值"那一条）。 */
    const vn = names.length === 1 ? names[0] : (names.length > 1 ? names[1] : null);
    if (elT !== null && vn !== null && vn !== '_') {
      VARTY.set(vn, elT);
      const tn = namedTypeOf(elT);
      if (tn !== null) VARTYPE.set(vn, tn);
    }
  }
  try {
    inner = blk === undefined ? [] : many(kids(blk));
  } finally {
    RG_DEPTH -= 1;
    VARTYPE.clear();
    for (const [k, v] of savedRgVars) VARTYPE.set(k, v);
    VARTY.clear();
    for (const [k, v] of savedRgTys) VARTY.set(k, v);
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
     区别：切片的 1 名字是下标，通道的 1 名字是值。
     从前这儿把主语包一层 `__goChanDrain`（"对数组是 no-op、对通道取出缓冲"）——
     **那个函数从来就没有过**（整个仓库里只有那两行提到它），所以那是一次调用不存在的
     名字；真通道那一路给的还是错答案。现在按 `CHANS` 分开：
       * 登记成通道的 —— 落成 go 规范里它的**定义**：`for { v, ok := <-ch; if !ok { break }; … }`
         （`omni_go_chan_recv2` + `omni_go_chan_ok`，见 `omni_go.h` 那段账）；
       * 别的 —— 照旧当序列（`MAPS` 那条既有约定：没登记的就当序列），主语不再包壳。
     1-name 在序列上的语义仍旧是"绑值不绑下标"：那对 `for i := range s`（只取下标）
     不精确，但对常见的 `for _, v := range` 正确。 */
  if (tag(subj) === 'name' && CHANS.has(leaf(kids(subj)[0]))) {
    const vName = names.length > 0 && names[0] !== '_' ? names[0] : `__rv${RG_DEPTH}`;
    const okName = `__rok${RG_DEPTH}`;
    const recv2 = node('call', {
      fn: node('ref', {}, { name: '__goChanRecv2' }), args: [toNode(subj)],
    });
    const okCall = node('call', { fn: node('ref', {}, { name: '__goChanOK' }), args: [] });
    const loopBody = [
      node('bind', { init: recv2 }, { name: vName }),
      node('bind', { init: binOf('!=', okCall, lit(0), OPS, { lang: 'go' }) }, { name: okName }),
      branchOf(un('not', at(okName)), node('region', { body: [loopExit('break')] })),
      ...inner,
    ];
    return node('region', {
      body: [threePart({ init: [], cond: undefined, post: [], body: loopBody })],
    });
  }
  const drainedSubj = toNode(subj);
  /* **一格名字的 `range` 拿的是下标**（go 的规矩：切片 / 数组 / 串上
     `for i := range s` 里 i 是下标，要值得写 `for _, v := range s`）。
     从前这儿落"取值" —— 那是**答案静默地错**：`for i := range t.Data { t.Data[i] = … }`
     （pt 的 `ColorTexture.Pow`）会拿一格 Color 当下标使。
     通道那一档（`for v := range ch`，一格名字拿的是**值**）在上面就返回了，不走这儿；
     map 那一档走 `mapForIn`（一格名字拿的是键），也不走这儿。 */
  if (names.length > 0 && names[0] !== '_') head.push(mk(names[0], at(idx)));
  if (names.length > 1 && names[1] !== '_') head.push(mk(names[1], indexGet(at(seq), at(idx))));
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
  if (tag(ty) === 'map') {
    const [kz, vz] = mapZeros(ty, 'make(map…)');
    return mapNew([], kz, vz);
  }
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
    case 'num': {
      /* **`0.0` 是浮点，不是 0**：go 的规矩是"带小数点或指数的无类型常量，默认类型是
         float64"。`Number("0.0")` 在 JS 里就是整数 0，图那一层于是把它定成 int ——
         `s := 0.0` 落出 `(let s int (int 0))`，随后 `s += xs[i]` 当场报类型不合。
         判据只看**写法**（源码里那串字符），不看算出来的值；已经不是整数的值图自己
         就会定成 real，不必多包一层。 */
      const txt = String(leaf(kids(x)[0]));
      const v = Number(txt);
      /* **过不了 double 的整字面量把原文带上**（`nodes.js` 上 `const` 的 `exact`）。
         量出来的：`raytrace.go` 的 LCG 常数 6364136223846793005 经 `Number` 掉成
         …3000，整条随机流于是不同 —— 而且没有任何提示。判据是"回写一遍还是同一串
         数字吗"，所以十六进制 / 下划线那几种写法也都过（`BigInt` 认它们）。 */
      const c = node('const', {}, { value: v, ...exactOf(txt, v) });
      return (Number.isInteger(v) && isGoFloatTok(txt)) ? convOf('float', c) : c;
    }
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
        const vT = kids(ty)[1] ?? null;
        const [kz, vz] = mapZeros(ty, 'map 字面量');
        return mapNew(elems.map((e) => {
          const [k, v] = kids(e);
          // 键是**值**（不是名字）—— 与记录正相反。值那边可能是省了类型的嵌套字面量。
          return [toNode(k), toNode(fillElidedTy(v, vT))];
        }), kz, vz);
      }
      /* **具名 struct 字面量带 `__type` 标签**：接口方法分派要它。
         `Circle{R:5}` → `{__type:"Circle", R:5}`，然后 `s.Area()` 在运行时
         查 `__goMethodTable["Circle.Area"]` 找到 `Circle__Area`。

         **走 `namedTypeOf` 而不是 `leaf(kids(ty)[0])`**：`(tname color RGBA64)` 底下有
         **两格**名字，只取头一格拿到的是包名 `color` —— `STRUCTS.has('color')` 当然是假，
         于是 `color.RGBA64{7,8,9,10}` 掉到下面"切片字面量"那一支，落成 `(arr int)`。
         那是"答案静默地错"的形状：图落得出来，直到形参对不上才炸（量出来的，pt 整包）。
         `namedTypeOf` 顺手把包限定收成平名字（见它头上那段）。 */
      const tyName = tag(ty) === 'tname' ? namedTypeOf(ty)
        : tag(ty) === 'name' ? leaf(kids(ty)[0]) : null;
      /* **go 的 struct 是值语义**（赋值/传参/返回都复制）—— 第二个实参就是那一格。
         例外是"有指针接收者方法"的那些类型（`PTRRECV`），它们要引用语义。 */
      const withType = (pairs, fz) => {
        const named = tyName !== null && STRUCTS.has(tyName) && typeTagged();
        return named
          ? recordNew([['__type', lit(tyName)], ...pairs], byValFor(tyName),
            Array.isArray(fz) ? [null, ...fz] : undefined)
          : recordNew(pairs, byValFor(tyName), fz);
      };
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
        const fs0 = (tyName !== null && STRUCTS.get(tyName)) || null;
        const given = new Map(elems.map((e) => [nameOf(kids(e)[0]), kids(e)[1]]));
        /* **按声明的次序铺满**（字段表认得出来的时候）：go 里没写到的字段就是零值，而方言
           按"字段名单 + 字段类型"去重形状 —— 只铺写到的那几格，`&N{V:3}` 与 `var p *N`
           就是两格形状（量出来的：`'p' 是 r2，赋的值是 r4`）。次序也得照声明来：
           `Hit{Shape: s, T: 1}` 与 `Hit{T: 1, Shape: s}` 在 go 里是同一个值。
           字段表查不到（嵌入、外部包）就照写到的那几格来 —— 与从前一样。 */
        const list = fs0 !== null
          ? [...fs0, ...[...given.keys()].filter((k) => !fs0.some(([f]) => f === k))
            .map((k) => [k, undefined])]
          : [...given.keys()].map((k) => [k, undefined]);
        const fz = [];
        const pairs = list.map(([fn2, ft]) => {
          const v0 = given.get(fn2);
          /* 没写到的那几格：接口落空引用 + `fzero`，别的落真零值。 */
          if (v0 === undefined) {
            const nz = nilFieldZero(ft, lit(null));
            fz.push(nz);
            return [fn2, nz === null ? zeroOf(ft, `${tyName ?? '?'}.${fn2}`) : lit(null)];
          }
          /* 字段声明成浮点时把值转过去（见 `fieldValue` 那段账）。 */
          const v = fillElidedTy(v0, ft);
          const vn = toNode(v);
          /* **写着 `nil` 的接口字段**：值落空引用、类型走 `fzero`（见 `nilFieldZero`）。 */
          const fzi = nilFieldZero(ft, vn);
          fz.push(fzi);
          return [fn2, fzi === null ? fieldValue(ft, vn, v) : lit(null)];
        });
        return withType(pairs, fz);
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
          const fz = [];
          /* 位置式也要**铺满**（与上面 kv 那一支同一条账）：go 的位置式字面量必须写全，
             所以正常情况下 `fs.length === elems.length`；少写了就按零值补，形状才唯一。 */
          const pairs = fs.map(([fn2, ft], i) => {
            const e0 = elems[i];
            if (e0 === undefined) {
              const nz = nilFieldZero(ft, lit(null));
              fz.push(nz);
              return [fn2, nz === null ? zeroOf(ft, `${litTypeName}.${fn2}`) : lit(null)];
            }
            const e = fillElidedTy(e0, ft);
            const en = toNode(e);
            const fzi = nilFieldZero(ft, en);
            fz.push(fzi);
            return [fn2, fzi === null ? fieldValue(ft, en, e) : lit(null)];
          });
          return withType(pairs, fz);
        }
      }
      /* **切片/数组字面量**：元素类型从声明带上（`elem`）—— 空表（`[]float64{}`，后面靠
         `append` 填）的元素类型只能从声明来，不带就报"一格空列表（元素类型推不出来）"。
         元素声明成**接口**时还要逐格装箱（`[]Shape{Sq{2}, &Rect{3,4}}`，ADR-0040），
         于是列表是**单态**的 —— 异质那一族的墙就在这一句。 */
      {
        const elT = elemTyOf(ty);
        const ifn = ifaceNameOf(elT);
        /* 元素里省了类型的那几格（`[][]int{{1},{2}}`）在这儿把外层的元素类型补回去。 */
        const els = elems.map((e) => fillElidedTy(e, elT));
        let ez = null;
        if (elT !== null) { try { ez = zeroOf(elT, 'elem'); } catch { ez = null; } }
        if (ez !== null && typeof ez === 'object' && ez.lit === null && ez.op === undefined) ez = null;
        const items = ifn === null ? many(els)
          : els.map((e) => boxInto(ifn, tnOfExpr(e), toNode(e)));
        return ez === null ? listNew(items) : listNew(items, ez);
      }
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
      return isMap(o) ? mapGetZero(o, toNode(o), toNode(i)) : indexGet(toNode(o), toNode(i));
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
      /**
       * **无类型常量表达式按任意精度折**（go 规范 "Constant expressions"：常量是无限精度的）。
       * 只在**折出来放不进 int64** 时改形（发一格实数）；放得进的照旧原样交给 `binOf` ——
       * 那条路上的语义（含无符号那一位、字节判据）一个字都不动。
       *
       * 为什么非要它（4 行就复现，**答案静默地错**）：
       *     var v int64 = 5577006791947779410
       *     println(float64(v) / (1 << 63))
       *   go 0.6046602879796196、我们 **-0.60466** —— `1 << 63` 回绕成 INT64_MIN，符号反了。
       * 而真 go 的 `math/rand.Float64` 就是 `float64(r.Int63()) / (1 << 63)`。
       *
       * **必须折整个表达式**，不能只折那一格 `<<`：`rngMask = 1<<63 - 1` 是个正经的 int64
       * 常量（9223372036854775807），只折 `1<<63` 会把它变成 real，`&` 当场骂
       * `'&' 只对 int 成立，这里是 real`（第一版就是这么错的）。
       *
       * 还欠的一格：`(1<<63) % uint64(n)` —— 右边不是常量，整个折不掉，而 go 那儿是
       * **uint64** 的取模。我们仍会把左边回绕成 INT64_MIN。真 go 的 `Int63n` 慢路走这一句
       * （`Intn` 收到非二次幂时），要治得先有无符号常量。
       */
      const cbig = constBig(x);
      if (cbig !== null && hasShift(x)) {
        /* 放不进 int64 ⇒ 只可能是浮点上下文（go 里放进整型是编译错），发实数。 */
        if (cbig > 9223372036854775807n || cbig < -9223372036854775808n) {
          return convOf('float', lit(Number(cbig)));
        }
        /* 放得进 ⇒ **就地折成一格整数字面量**，别再往下走。
           非这么做不可：`1<<63 - 1` 整体是 9223372036854775807（放得进），可它的**左子树**
           `1<<63` 单独看放不进 —— 递归下去那一格会先变成实数，于是整个表达式成了
           `real - int`，`rngMask` 变实数、`&` 当场骂。折出来的值走 BigInt，不经 Number
           （2^63-1 过 double 会变成 2^63，那正是"int64 字面量掉精度"那一族）。
           只在**含移位**的常量表达式上折（`hasShift`）：别的算术照旧原样，图的形状不动。 */
        /* 只在**过 double 不掉精度**时折（≤ 2^53）：`lit` 收的是 JS 的 number，
           9223372036854775807 过 double 会变成 2^63 —— 那正是"int64 字面量掉精度"那一族。
           折不了就原样交给 `binOf`（今天的行为），不猜。 */
        if (cbig <= 9007199254740992n && cbig >= -9007199254740992n) return lit(Number(cbig));
      }
      const nd = binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'go' });
      /* **无符号那一位**（`UNS` 那段账）：左边那一半声明成 uint 时，右移 / 除 / 取余 /
         四个大小比较要走"无符号的那一半"。只往 `prim` 上点一位 —— 图上仍旧只有一族算符。 */
      if (UOPS.has(leaf(op)) && isUnsExpr(a)
        && nd !== null && typeof nd === 'object' && nd.op === 'prim') {
        nd.attrs = { ...nd.attrs, uns: true };
      }
      return nd;
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
      /* **没有体的声明**（go 里那是"体在汇编/别处"，`func nanotime() int64` 就是这么写的）：
         一格都不绑。我们用它给 `src/lib/go/omnihost` 那几格宿主入口写签名 ——
         调用点由 `GO_HOST_FNS` 认出来落成 `__goNanotime` 那一族名字，真的体在
         `libomnigo` 里（`src/runtime-sched/omni_go.c`）。绑一格空函数反而会盖掉它。 */
      if (blk === undefined) return [];
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
    case 'block': return inScope(() => node('region', { body: many(kids(x)) }));
    case 'define': case 'assign': {
      // `a, b := 1, 2` 与 `a = 1`。`define` 出 bind、`assign` 出 set —— 一格之差，
      // 正是"decl 就是 bind"那句话（没有 decl 节点）。
      //
      // **go 的 `:=` 不全是声明**：左边只需要**至少一个新名字**，已有的名字是赋值。
      // `v, err := f()` 后面 `w, err := g()` 里 err 是 set 不是 bind。
      // 判据：这个名字在**当前这一层块**的形参或之前的 bind 里出现过 → set。
      // 分层那件事在 `SCOPES` 那段话里 —— 外层块的同名是遮蔽，照 go 的规矩算新声明。
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
        /* **`i, f := math.Modf(e)`** —— `rmath` 里没有 modf，而 go 的整数部分是
           **往零截断**（与 f 同号），`floor` 只对非负数是它。落成三句：
             bind __mfN = e        // e 只求一次值
             i = e < 0 ? -floor(-e) : floor(e)
             f = __mfN - i
           为什么摆在**语句这一层**而不是包一格辅助函数：多返回的辅助函数在
           `retTypeOf` 那一趟定不了型（那时形参还没类型，两格都成了 int），
           落出来是"要返回 m1，给的是 m3"。表达式位置上的 `math.Modf(…)` 照旧报缺口。 */
        if (lhs.length === 2 && isMathCallOf(rhs[0], 'Modf')) {
          const mk = (n, init) => {
            if (isDef && !seenHere(n)) { declHere(n); return node('bind', { init }, { name: n }); }
            return node('set', { value: init }, { name: n });
          };
          const as = kids(rhs[0]).find((y) => tag(y) === 'args');
          const a0 = as === undefined ? undefined : kids(as)[0];
          if (a0 === undefined) throw new Error('go->graph: math.Modf 一格实参都没有');
          MODF_N += 1;
          const tv = `__modf${MODF_N}`;
          const at = () => node('ref', {}, { name: tv });
          const neg = (v) => binOf('-', f64Zero(), v, OPS, { lang: 'go' });
          const trunc = branchOf(binOf('<', at(), f64Zero(), OPS, { lang: 'go' }),
            neg(rmathCall('floor', [neg(at())])), rmathCall('floor', [at()]));
          const iNm = nameOf(lhs[0]) === '_' ? `${tv}i` : nameOf(lhs[0]);
          const out = [node('bind', { init: toNode(a0) }, { name: tv }), mk(iNm, trunc)];
          if (nameOf(lhs[1]) !== '_') {
            out.push(mk(nameOf(lhs[1]),
              binOf('-', at(), node('ref', {}, { name: iNm }), OPS, { lang: 'go' })));
          }
          return out;
        }
        // **`v, ok := m[k]` 不是多值**：go 在这儿给的是"值 + 在不在"，落 map-get + map-has。
        if (lhs.length === 2 && tag(rhs[0]) === 'index' && isMap(kids(rhs[0])[0])) {
          const [o, k] = kids(rhs[0]);
          const mk = (t, init) => {
            const n = nameOf(t);
            if (isDef && !seenHere(n)) { declHere(n); return node('bind', { init }, { name: n }); }
            return node('set', { value: init }, { name: n });
          };
          const out = [];
          if (nameOf(lhs[0]) !== '_') {
            /* 值那个名字的**类型**也要留一份（`tyOfExpr` 的 index 那一支算得出来）——
               少了它 `u, ok := m[k]` 之后的 `u.At(…)` 认不出 u 是接口，落成直接调用。 */
            const vt0 = tyOfExpr(rhs[0]);
            if (vt0 !== null) VARTY.set(nameOf(lhs[0]), vt0);
            out.push(mk(lhs[0], mapGetZero(o, toNode(o), toNode(k))));
          }
          out.push(mk(lhs[1], mapHas(toNode(o), toNode(k))));
          return out;
        }
        /* **`v, ok := <-ch`** —— 与上面 `v, ok := m[k]` 同一个形状，落法也同一条路数：
           两句（`omni_go_chan_recv2` 收一格并把 ok 记在 TLS 里、`omni_go_chan_ok` 取它）。
           为什么不是一格多值：方言那一层一次调用只回一格值，而"取局部量的地址"在图上
           没有那一格 —— 那两句之间没有 park，所以 TLS 是准的（见 `omni_go.h` 的账）。
           次序要紧：**先 recv2 再 ok**。 */
        if (rhs.length === 1 && lhs.length === 2 && tag(rhs[0]) === 'recv') {
          const mk2 = (t, init) => {
            const n = nameOf(t);
            if (isDef && !seenHere(n)) { declHere(n); return node('bind', { init }, { name: n }); }
            return node('set', { value: init }, { name: n });
          };
          const chv = toNode(kids(rhs[0])[0]);
          const recvCall = node('call', { fn: node('ref', {}, { name: '__goChanRecv2' }), args: [chv] });
          const okCall = node('call', { fn: node('ref', {}, { name: '__goChanOK' }), args: [] });
          const out = [];
          /* `_` 那一格**不绑名字，但这一次收必须发生**（`_, ok := <-ch` 要的正是 ok）。 */
          out.push(nameOf(lhs[0]) === '_' ? recvCall : mk2(lhs[0], recvCall));
          if (nameOf(lhs[1]) !== '_') {
            out.push(mk2(lhs[1], binOf('!=', okCall, lit(0), OPS, { lang: 'go' })));
          }
          return out;
        }
        /* **多值 destructure 也要看作用域**：`v, err := f()` 后面
           `w, err := g()` 的 err 是已有名字。destructure 总是 bind（declare=true），
           所以这儿要把已有名字从 declare=true 改成 declare=false。 */
        const names = lhs.map(nameOf);
        const declareFlags = names.map((n) => {
          if (!isDef) return false;
          if (seenHere(n)) return false;
          declHere(n);
          return true;
        });
        // 如果全是 declare 或全不是，走原来的 destructure
        if (declareFlags.every((d) => d === declareFlags[0])) {
          noteMultiTypes(names, rhs[0]);
          return destructure(names, toNode(rhs[0]), { declare: declareFlags[0] });
        }
        noteMultiTypes(names, rhs[0]);
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
      /* **`s = append(s, v…)` 落成一串 `push`**（go 里最常见的那一格）。
         为什么值得特判：`append` 交出来的是"新切片"，图上没有那一格，所以从前一律落成
         `call __goAppend` —— 而那个函数的体在 **js 那条腿的运行时**里，core 上压根没有。
         而 `s = append(s, v)` 这个惯用法与"往 s 上推一格"是同一件事，方言里现成的一句
         `(apush …)`（图上是 `prim push`，一条**语句**）。
         判据收得紧：一个左值、一个右值、右边是 `append`、第一格实参**与左值同形**、
         没有 spread（`append(a, b...)` 那一档照旧走 `__goAppend`）。 */
      if (lhs.length === 1 && rhs.length === 1 && compoundOp === null) {
        const items = appendSelfItems(lhs[0], rhs[0]);
        if (items !== null) {
          const elT = elemTyOf(tyOfExpr(lhs[0]));
          return items.map((it) => node('prim', {
            args: [toNode(lhs[0]), elT === null ? toNode(it) : fieldValue(elT, toNode(it), it)],
          }, { name: 'push' }));
        }
        /* **`s = append(s, xs...)`**：摊开成一趟数着的循环（见 `appendSpreadPush`）。 */
        const spread = appendSelfSpread(lhs[0], rhs[0]);
        if (spread !== null) return appendSpreadPush(lhs[0], spread);
      }
      /* **右值先全算出来那一档**（`a, b = b, a`）—— 见 `needsParallel` 那段账。 */
      if (compoundOp === null && lhs.length > 1 && rhs.length === lhs.length
        && needsParallel(lhs, rhs)) {
        ASN_N += 1;
        const pre = [];
        const tmps = [];
        for (let i = 0; i < rhs.length; i++) {
          let v = toNode(rhs[i]);
          const tTy = tyOfExpr(lhs[i]);
          if (tTy !== null) v = fieldValue(tTy, v, rhs[i]);
          const nm = `__asn${ASN_N}_${i}`;
          pre.push(node('bind', { init: v }, { name: nm }));
          tmps.push(nm);
        }
        const outs = [];
        for (let i = 0; i < lhs.length; i++) {
          const t = lhs[i];
          const v = node('ref', {}, { name: tmps[i] });
          if (tag(t) === 'sel') {
            outs.push(fieldSet(toNode(kids(t)[0]), leaf(kids(t)[1]), v));
            continue;
          }
          if (tag(t) === 'index') {
            const [o, ix] = kids(t);
            outs.push(isMap(o) ? mapSet(toNode(o), toNode(ix), v)
              : indexSet(toNode(o), toNode(ix), v));
            continue;
          }
          const n = nameOf(t);
          if (n === '_') continue;
          const isNew2 = isDef && !seenHere(n);
          if (isNew2) declHere(n);
          outs.push(isNew2 ? node('bind', { init: v }, { name: n })
            : node('set', { value: v }, { name: n }));
        }
        return [...pre, ...outs];
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
          /* `xs := []Shape{…}` / `s := NewSphere(…)` 那一族：把**右边的声明类型**也记一份
             （`tyOfExpr` 靠它往下追元素类型与接口分派）。 */
          const rt = tyOfExpr(rhs[i]);
          if (rt !== null) VARTY.set(nameOf(t), rt);
        }
        /* **照目标的声明类型转一遍**（与 `fieldValue` 那段账同一条）：浮点字段收整字面量要
           转（`m.Gloss = 4`），声明成接口的要装箱（`one = &Rect{2,2}`，ADR-0040）。
           目标的类型从 `tyOfExpr` 来（名字走 `VARTY`、字段走 `STRUCTS`）。 */
        if (compoundOp === null && rhs[i] !== undefined) {
          const tTy = tyOfExpr(t);
          if (tTy !== null) v = fieldValue(tTy, v, rhs[i]);
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
           判据只看**当前这一层块**（外层的同名是遮蔽，那就是新声明）—— 见 SCOPES 那段话。 */
        const isNew = isDef && !seenHere(n);
        if (isNew) declHere(n);
        return isNew
          ? node('bind', { init: v }, { name: n })
          : node('set', { value: v }, { name: n });
      });
    }
    case 'inc': case 'dec': {
      /* **目标可以是字段或下标**，不只是名字（go 里 `rng.tap--` / `xs[i]++` 都合法）。
         从前这儿一律 `node('set', …, { name: nameOf(t) })`，而 `nameOf` 对 `sel` / `index`
         答 null —— 落出来是 `(set null …)`，方言当场 `未声明的变量 'null'`。
         量到的：真 go 的 `math/rand` 里 `rngSource.Uint64` 头两句就是 `rng.tap--`
         与 `rng.feed--`。三条分支与 `assign` 那一处（`p.y = 5` / `xs[1] = 5`）逐字同形。 */
      const t = kids(x)[0];
      const v = bin(tag(x) === 'inc' ? '+' : '-', toNode(t), lit(1));
      if (tag(t) === 'sel') return fieldSet(toNode(kids(t)[0]), leaf(kids(t)[1]), v);
      if (tag(t) === 'index') {
        const [o, i] = kids(t);
        return isMap(o) ? mapSet(toNode(o), toNode(i), v) : indexSet(toNode(o), toNode(i), v);
      }
      return node('set', { value: v }, { name: nameOf(t) });
    }
    case 'for': {
      // 三种 `for` 落成同一格 loop（**不给它开节点**）。形状与 vlang / awk 一模一样，
      // 所以那句话只写一遍 —— `threePart` 在 `src/core/graph/fromtree.js` 里。
      //
      // 头上那三段（init/cond/post）自己是一层块 —— `for i := 0 …` 的 `i` 出了这个
      // for 就没了，所以要 `inScope` 包住；体是 `block`，它再开自己那一层。
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
      return inScope(() => threePart({
        init: slot(init),
        cond: condOf(),
        post: slot(post),
        body: blk === undefined ? [] : many(kids(blk)),
      }));
    }
    case 'if': {
      const all = kids(x);
      // `if v := f(); v > 0 { … }` —— 头上那一格 init 的**作用域是整条 if 链**
      // （else 里也看得见 `v`）。所以它落成一格 region 包着 branch，
      // 不是把那句话挪到 if 外面去：挪出去就多活了一层作用域。
      const ini = all.length > 0 && tag(all[0]) === 'init' ? all[0] : undefined;
      const build = () => {
        const parts = ini === undefined ? all : all.slice(1);
        // `else` 那一格是个包装（`(else (block …))` 或 `(else (if …))` —— else-if 链）
        const els = elseOf(parts[2]);
        const br = branchOf(toNode(parts[0]), toNode(parts[1]),
          els === undefined ? undefined : toNode(els));
        if (ini === undefined) return br;
        return node('region', { body: [...many(kids(ini).filter((k) => tag(k) !== 'none')), br] });
      };
      // 那一格 init 声明的名字**只活在这条 if 链里**，所以连 init 一起进一层作用域。
      return ini === undefined ? build() : inScope(build);
    }
    /* 返回值：声明的返回类型是**接口**时在这一句装箱（ADR-0040）。
       `CUR_RET` 是 `funcOf` 存下的那格声明类型（只有单返回那一档）。 */
    case 'return': {
      const vs = kids(x);
      /* **光秃秃的 `return` + 具名的返回值**（go 的 bare return，见 `CUR_OUTS`）：
         交回那几个名字当时的值。不补的话整格函数"一格 ret 都没有"，core 那侧当成隐式返回。 */
      if (vs.length === 0 && CUR_OUTS.length > 0) {
        return retOf(CUR_OUTS.map((o) => node('ref', {}, { name: o.nm })));
      }
      const ifn = ifaceNameOf(CUR_RET);
      if (ifn !== null && vs.length === 1) {
        return retOf([boxInto(ifn, tnOfExpr(vs[0]), toNode(vs[0]))]);
      }
      return retOf(many(vs));
    }
    // range 头上绑的名字、switch 头上 init/tag 绑的名字都只活在这一格里 —— 各进一层
    case 'for-range': return inScope(() => forRangeOf(x));
    case 'switch': return inScope(() => switchOf(x));
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
      /* `switch v := s.(type)` → 主语先绑一格**隐藏名**，`v` 由每支自己绑（见 `NARROW`）：
         只有一个类型名的那几支绑**降回去之后**的那一格（`v.Radius` 要它），别的支（多个
         类型名、`case nil:`、default）照 go 的规矩仍旧绑接口那一格。 */
      const varName = bind !== undefined ? leaf(kids(bind)[0]) : null;
      const subjExpr = subj !== undefined ? toNode(kids(subj)[0]) : lit(null);
      TSW_N += 1;
      const subjName = varName === null ? null : `__tsw${TSW_N}`;
      if (subjName !== null) {
        body.push(node('bind', { init: subjExpr }, { name: subjName }));
      }
      const subjRef = () => (subjName !== null ? node('ref', {}, { name: subjName }) : subjExpr);
      /** 一支的体：要绑 `v` 的话先绑（`down` 不是 null 就绑降回去的那一格）。 */
      const armWith = (c, down, downTy) => {
        /* **收窄了就把那个名字的声明类型也换掉**：不然 `v.Area()` 还按接口那格记录分派 ——
           量出来是"记录 r2 上没有字段 'Area'"（收窄之后 v 是 `*Sq`，方法要落成
           `call Sq__Area(v)`）。出了这一支再还原。 */
        const hadTy = VARTY.get(varName);
        const hadTn = VARTYPE.get(varName);
        if (down !== null) {
          if (downTy !== undefined) VARTY.set(varName, downTy);
          VARTYPE.set(varName, down);
        }
        let inner;
        try {
          inner = armOf(c);
        } finally {
          if (down !== null) {
            if (hadTy === undefined) VARTY.delete(varName); else VARTY.set(varName, hadTy);
            if (hadTn === undefined) VARTYPE.delete(varName); else VARTYPE.set(varName, hadTn);
          }
        }
        if (varName === null) return inner;
        const init = down === null
          ? subjRef()
          : node('call', { fn: fieldGet(subjRef(), downName(down)), args: [] });
        return node('region', {
          body: [node('bind', { init }, { name: varName }), inner],
        });
      };
      let chain;
      let dflt;
      const arms = [];
      for (const c of cs) {
        if (tag(c) === 'default') { dflt = armWith(c, null); continue; }
        /* 每支的 items 是类型名，取出来做 `__goTypeIs` 判断。
         *
         * **走 `namedTypeOf` 而不是只认 `tname`/`name`**：`case *B:` 的 item 是
         * `(ptr (tname B))`，tag 是 `ptr` —— 只认那两种的话它被 `filter(Boolean)` 丢掉，
         * 于是 `typeNames.length === 0`，条件落成 `lit(true)`：**这一支永远命中**。
         * 那是"答案静默地错"最坏的形状（图落得出来、跑得动、数字是错的）：
         * pt 的 `switch shape.(type) { case *Volume, *SDFShape, *SphericalHarmonic: … }`
         * 三支全是指针类型，于是 `inside` 永远走错那一边。量出来：一格 28 印成 128。
         *
         * `namedTypeOf` 剥掉 `ptr`、顺手把包限定收成平名字 —— 与 `__goTypeIs` 比的那个
         * `__type` 标签（`&A{}` 的标签是 `"A"`）正好对得上。 */
        const items = partKids(c, 'items');
        const typeNames = [];
        let sawNil = false;
        let unnamed = false;
        for (const it of items) {
          /* `case nil:` —— 在 go 里它比的是"这格接口本身是不是 nil"，不是某个类型。 */
          if ((tag(it) === 'tname' || tag(it) === 'name') && leaf(kids(it)[0]) === 'nil') {
            sawNil = true;
            continue;
          }
          const tn = namedTypeOf(it);
          if (tn === null) { unnamed = true; continue; }
          typeNames.push(tn);
        }
        /* **说不出名字的那一支不许当 `true`**（切片 / map / 函数类型、泛型实例化…）。
           从前那样落，整支就永远命中 —— 宁可有名有姓地停下。 */
        if (unnamed) {
          throw new Error('go->graph: 类型 switch 里有一支的类型说不出名字'
            + '（切片 / map / 函数 / 泛型那几种）—— 落成"永远命中"会把答案静默地弄错');
        }
        const subjRef2 = subjRef;
        /**
         * 一支的类型判断：**直接比 `__type` 字段**，不调运行期函数。
         *
         * 从前落 `__goTypeIs(v, "T")`，而那个名字只在 `ext/go/go-rt.js`（js 那条腿的
         * 运行时）里有定义 —— core 那条腿上它是个**没人定义的名字**，返回类型推成 int，
         * 于是报"条件不是 bool"。比字段这一招三条腿都成立、不欠运行时、而且更快：
         * `NEEDS_TYPETAG` 正是"整棵树里有类型 switch"，所以那一格 `__type` 一定带着
         * （见 `typeTagged()`）。
         *
         * **nil 要先挡**：go 里 `case T:` 在接口是 nil 时不命中，而在 nil 上取字段会当场
         * 空引用。所以落 `v != nil && v.__type == "T"`。
         */
        const typeIs = (tn) => lazyAnd(
          binOf('!=', subjRef2(), lit(null), OPS, { lang: 'go' }),
          binOf('==', fieldGet(subjRef2(), '__type'), lit(tn), OPS, { lang: 'go' }),
        );
        const nilIs = () => binOf('==', subjRef2(), lit(null), OPS, { lang: 'go' });
        const checks = [...(sawNil ? [nilIs()] : []), ...typeNames.map(typeIs)];
        let cond;
        if (checks.length === 0) {
          cond = lit(true);                       /* `case:` 空的那一支（go 里写不出来） */
        } else {
          cond = checks.reduce((acc, ch, i) => (i === 0 ? ch : lazyOr(acc, ch)), null);
        }
        /* **这一支要不要收窄**（见 `NARROW`）：只有一个类型名、不是 nil、而且那个类型有
           降回去的那一格。别的支照 go 的规矩不收窄。 */
        const down = (typeNames.length === 1 && !sawNil && NARROW.has(typeNames[0])
          && STRUCTS.get(typeNames[0]) !== undefined && STRUCTS.get(typeNames[0]) !== null)
          ? typeNames[0] : null;
        arms.push([cond, armWith(c, down, down === null ? undefined : items[0])]);
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
      /* 实参的**原树**（与 `argNodes` 同序）：装箱那一步要问"这格值的具体类型是什么"。 */
      const argAsts = args === undefined ? [] : kids(args).filter((y) => tag(y) !== 'spread');
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
        /* **`math.F(…)`**（见 `GO_MATH_RMATH`）：`math` 是包名而不是值，所以要排在
           "接收者是接口"与 mangle 前头。被局部量遮住（`VARTYPE` 里有这个名字）就不走。 */
        if (recvName === 'math' && VARTYPE.get('math') === undefined) {
          const mc = goMathCall(m, argNodes);
          if (mc !== null) return mc;
        }
        /* **宿主那几格**（`omnihost.Nanotime()` 一族，见 `GO_HOST_FNS`）：落成
           `call __goNanotime` 之类的名字。`backend-core.js` 的 `C_RT` 认这些名字，
           在原生腿上落 `(ccall omni_go_nanotime)`；js 那条腿上 `ext/go/go-rt.js`
           里有同名的一份。表里没有的名字**当场报**（写错了要立刻知道，不许落成兜底）。 */
        if (recvName === 'omnihost' && VARTYPE.get('omnihost') === undefined) {
          const hf = GO_HOST_FNS.get(m);
          if (hf === undefined) {
            throw new Error(`go->graph: omnihost 上没有 '${m}' 这一格 —— `
              + `有的是 ${[...GO_HOST_FNS.keys()].join(' / ')}`);
          }
          return node('call', { fn: node('ref', {}, { name: hf }), args: argNodes });
        }
        const fromVar = recvName !== null ? VARTYPE.get(recvName) : undefined;
        const flat = METHODS.get(m);
        /* **接收者不是光名字**（`shapes[0].BoundingBox()` / `m.tree.Intersect(r)`）时也要
           认得出类型：`tnOfExpr` 顺着"下标 / 取字段 / 调用 / 字面量"往回看声明的类型。
           没有它就落到最底下那条"取字段再调它"的兜底上，而 core 这条腿上那是一句缺口
           （pt 的 `BoxForTriangles` 报的正是"记录 r21 上没有字段 'BoundingBox'"）。
           排在 `flat` 前面：`flat` 是"平表里只有一个主人"那一档的猜测，这一格是声明。 */
        const fromExpr = (!onType && fromVar === undefined) ? tnOfExpr(obj) : null;
        const owner = fromVar ?? fromExpr ?? (flat === null ? undefined : flat);
        /* **接收者是接口值**（ADR-0040）：那就**必须**取字段再调它 —— 静态 mangle 会把
           `s.Area()` 钉在某一个具体类型上（`METHODS` 里只有一个主人时尤其），
           而接口的全部意思正是"运行期才知道装了谁"。**这一条要排在 mangle 前面。** */
        if (!onType) {
          const rIf = ifaceNameOf(tyOfExpr(obj));
          if (rIf !== null && ifaceMethods(rIf).some(([mm]) => mm === m)) {
            const ms = ifaceMethods(rIf).find(([mm]) => mm === m);
            const ps = ifaceParams(ms[1]);
            const boxed = argNodes.map((a, i) => (ps[i] === undefined ? a
              : fieldValue(ps[i].ty, a, argAsts[i])));
            return node('call', { fn: fieldGet(toNode(obj), m), args: boxed });
          }
        }
        /* **左边是一格包名，不是一格值**（`rand.Float64()` / `sort.Float64s(…)`）。
           这一格**必须排在 mangle 前面**：`flat`（"平表里只有一个主人"那一档）会把
           `rand.Float64()` 钉成 `Rand__Float64(rand)` —— 把**包那格记录**当接收者递进去。
           量出来的样子是 `'Rand__Float64' 第 1 格实参在两处的类型不一样（r10{New: …、
           NewSource: …} 与 int）`：一处是包那格记录，一处是真的 `*Rand`。

           两条出路，都不猜：
             * 跨包表里有这格顶层函数 -> mangle（`rand__New`，跨包那一路）；
             * `FSIG` 里有这格顶层函数的形参表（`--pkgs` 摊成同包那一路，`opts.also`
               那一趟收的）-> **直接按名字调**；
             * 都没有 -> 取包那格记录的字段再调它（桩那一族走的是这条）。
           `math.F(…)` 在上面已经先走掉了（`GO_MATH_RMATH`）。 */
        if (recvName !== null && fromVar === undefined && !onType
          && IMPORTS.has(recvName) && VARTY.get(recvName) === undefined) {
          if (XPKG.funcs.has(`${recvName}.${m}`)) {
            return node('call', { fn: node('ref', {}, { name: mangle(recvName, m) }), args: argNodes });
          }
          /* **摊成同包那一路：直接按名字调**（不经包那格记录的字段）。
             `--pkgs` 把依赖包的顶层声明摊进了同一份 body，所以 `path.Split` 与 `Split`
             是同一格绑定 —— 记录里那个字段装的就是它。两条理由要直接调：
               * **多返回**：`d, f := path.Split(…)` 经 `callfn` 出来那一格，图上说不清
                 是多值 —— core 报 `pick 的来源不是一格多值`。按名字调时多值那格形状在。
               * 顺带省一次间接调用（性能那一栏也要这一格）。 */
          if (FSIG.has(m)) {
            return node('call', {
              fn: node('ref', {}, { name: m }),
              args: argsByDecl(m, argNodes, false, argAsts),
            });
          }
          return node('call', { fn: fieldGet(toNode(obj), m), args: argNodes });
        }
        /* 接收者的类型**带包限定**时（`func f(t syntax.Type)` 那一档，`VARTYPE` 收的就是
           `syntax.Type`），方法的声明在那个包里 —— 跨包表里查得着就照样 mangle。 */
        if (owner !== undefined && (MSET.has(`${owner}.${m}`) || XPKG.mset.has(`${owner}.${m}`))) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(owner, m) }),
            args: onType
              ? argsByDecl(mangle(owner, m), argNodes, false, argAsts)
              : [toNode(obj), ...argsByDecl(mangle(owner, m), argNodes, true, argAsts)],
          });
        }
        if (flat !== undefined && flat !== null) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(flat, m) }),
            args: onType
              ? argsByDecl(mangle(flat, m), argNodes, false, argAsts)
              : [toNode(obj), ...argsByDecl(mangle(flat, m), argNodes, true, argAsts)],
          });
        }
        /* **从嵌入的接口提升上来的方法**（pt 的 `type SDFShape struct { SDF; … }` 里
           `s.BoundingBox()`）：go 的规矩是它等于 `s.SDF.BoundingBox()`。
           不补这一条就落到下面的兜底（`fieldGet(s, 'BoundingBox')`），而那一格在具体类型的
           记录上压根不存在 —— 报"记录 r78 上没有字段 'BoundingBox'（它有的是：SDF Material…）"。
           装箱那一侧本来就走 `promoteVia`（见 `ensureBoxFn`），这儿与它同一条规矩。 */
        if (owner !== undefined && !onType && !MSET.has(`${owner}.${m}`)) {
          const via = promoteVia(owner, m);
          if (via !== null) {
            return node('call', { fn: fieldGet(fieldGet(toNode(obj), via), m), args: argNodes });
          }
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
        /* **通道上的 `len` 是另一回事**（`CHANS` 那段账）：它问的是"环里现在有几个"，
           落 `omni_go_chan_len`。没登记成通道的照旧 `prim len`。 */
        const a0 = args === undefined ? undefined : kids(args)[0];
        if (a0 !== undefined && tag(a0) === 'name' && CHANS.has(leaf(kids(a0)[0]))) {
          return node('call', { fn: node('ref', {}, { name: '__goChanLen' }), args: argNodes });
        }
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
      /* **`close(ch)` -> `call __goChanClose`**（`go.mapping` 第 125 行说的那一格）。
         从前 tograph 里没有这一支 —— 于是它落成"调一个叫 close 的函数"，而那个函数
         不存在：方言那侧报「未声明的函数 'close'」，跑起来才知道。 */
      if (callee === 'close' && argNodes.length === 1) {
        return node('call', { fn: node('ref', {}, { name: '__goChanClose' }), args: argNodes });
      }
      /* **`cap(x)` -> `len(x)`**：图上没有 capacity 的概念，降成 len 近似。 */
      if (callee === 'cap' && argNodes.length === 1) {
        return node('prim', { args: argNodes }, { name: 'len' });
      }
      /* **`copy(dst, src)`** —— 落成**一圈逐格写**（`region` + `counted`），不是调一个
         运行时函数：`__goCopy` 只在 js 那条腿有体（`ext/go/go-rt.js`），core 上报
         "调一格这一层里没有的函数 '__goCopy'"。拷几格照 go 的规矩取两边长度的小的那个。
         **两边各只求一次值**（先绑出来）—— `copy(f(), g())` 在 go 里也只求一次。
         go 的 `copy` **交出拷了几格**；这一格落在语句位置上时那个值没人要，摆在表达式
         位置上会落一格 region 进表达式 —— 那一档照旧由下游报，不静静答错。 */
      if (callee === 'copy' && argNodes.length === 2) {
        CP_N += 1;
        const d = `__cpd${CP_N}`;
        const sc = `__cps${CP_N}`;
        const n = `__cpn${CP_N}`;
        const i = `__cpi${CP_N}`;
        const at = (nm) => node('ref', {}, { name: nm });
        const lenOf = (v) => node('prim', { args: [v] }, { name: 'len' });
        return node('region', { body: [
          node('bind', { init: argNodes[0] }, { name: d }),
          node('bind', { init: argNodes[1] }, { name: sc }),
          node('bind', {
            init: branchOf(binOf('<', lenOf(at(d)), lenOf(at(sc)), OPS, { lang: 'go' }),
              lenOf(at(d)), lenOf(at(sc))),
          }, { name: n }),
          counted({
            name: i,
            from: lit(0),
            cond: binOf('<', at(i), at(n), OPS, { lang: 'go' }),
            body: [indexSet(at(d), at(i), indexGet(at(sc), at(i)))],
          }),
        ] });
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
      /* **转换到一格具名的标量类型**（`Duration(t.ns - u.ns)`、`Channel(i)`）。
         也与调用同形，靠两道闸分开：这个名字**登记过是类型**（`TYPES`），而且它的底层
         跟一层是一格标量（`UNDER`）。落的就是底层那一格的转换 —— 图上没有"具名标量类型"
         这回事，所以 `type Duration int64` 的转换与 `int64(…)` 是同一件事。
         少了这一格，`time` 那份桩里的 `Duration(…)` 会落成"调一个叫 Duration 的函数"。 */
      if (callee !== null && argNodes.length === 1 && TYPES.has(callee) && UNDER.has(callee)) {
        const sn = scalarNameOf(UNDER.get(callee));
        if (sn !== null && CONV.has(sn)) return convOf(CONV.get(sn), argNodes[0]);
      }
      return node('call', { fn: toNode(fn), args: callee === null ? argNodes : argsByDecl(callee, argNodes, false, argAsts) });
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
         别的具名类型（`type Level int` / 接口 / 泛型）仍旧绑 null —— 那几种没有字段表。

         **说不清零值的那些干脆不绑**（2026-09-20）：接口、函数类型、泛型、带嵌入字段的
         结构体都落在这一档。绑一格 null 的代价是 core 那侧当场报"'Shape' 是一格 null"，
         而那个绑定本来就没人读 —— 一个 `type Shape interface{…}` 在真代码里只当**类型**用。
         万一真有人把它当值用（`(*T).Method` 那种），那时报的是"这个名字没声明"——
         一句指着那一处的话，比一格说不清类型的全局好。 */
      const ch = kids(x);
      const nameNode = ch.find((y) => isList(y) && tag(y) === 'name') ?? ch[0];
      if (nameNode !== undefined) {
        const n = isList(nameNode) ? leaf(kids(nameNode)[0]) : leaf(nameNode);
        if (n !== undefined && typeof n === 'string' && n.length > 0) {
          let init = null;
          const fs = STRUCTS.get(n);
          if (fs !== undefined && fs !== null) {
            /* zeroOf 对说不清的类型会当场报（那是它的纪律）—— 这一格报了就不绑，
               因为"它有类型"是刚需（见上面那段账），而"类型名有个绑定"只有
               方法表达式那一处要。 */
            try { init = structZero(n); } catch { init = null; }
          } else if (UNDER.has(n)) {
            /* `type Axis int` / `type Channel int` 这一族：零值就是**底子的零值**
               （与 `zeroOf` 里 `UNDER.has(n)` 那一行同一条）。量出来的账：
               不给它，pt 里 axis.go / buffer.go / sampler.go 那几份还是卡在
               "'Axis' 是一格 null"上。接口与函数类型没有标量零值，那时不绑。 */
            try { init = zeroOf(UNDER.get(n), n); } catch { init = null; }
          }
          /* **零值是一格 null 就等于没有零值**（接口 / 函数类型 / 泛型都落在这儿）——
             `zeroOf` 对它们回的是 `lit(null)`，不报。图上的字面量是一格 `{lit: v}`
             （不是 `const` 节点，见 `fromtree.js` 的 `lit`），所以判据是 `.lit`。 */
          if (init !== null && init !== undefined && typeof init === 'object'
            && init.lit === null && init.op === undefined) {
            init = null;
          }
          if (init === null || init === undefined) return [];
          return [{ op: 'bind', ins: { init }, attrs: { name: n } }];
        }
      }
      return [];
    }
    /* `go f(x)` —— **真的撒一条 goroutine**：落成 `call __goSpawn(f, x)`，那一格在
       `backend-core` 里变成 `(ccall omni_go_spawn (fnref f) x)`，体在 `libomnigo`
       里（G/M/P 调度器，照 go 的 proc.go 写的）。
       两种形状收：`go f()` 与 `go f(一格实参)`。别的（闭包、方法、两格以上实参）落成
       一句**有名有姓的墙** —— 从前这儿是 `return toNode(kids(x)[0])`（降成普通调用、
       同步跑），那是**静默的错答案**：`ch <- v` 在同一条 g 上就是死锁，而它却"跑通"了。 */
    case 'go': {
      const c = kids(x)[0];
      if (tag(c) !== 'call') {
        throw new Error(`go->graph: go 后面不是一次调用（是 ${tag(c)}）`);
      }
      const [gfn, gargs] = kids(c);
      /* 体可以是**具名函数**，也可以是一格**匿名函数**（`go func(i int){ … }(i)`，
         pt 的 renderer.go 用的就是它）。后者交给图那一层的 lambda 提升
         （`backend-core.js` 的 `liftFnVals`）：捕获为空就提到顶层、原地换成一格 `ref`，
         于是 `(fnref …)` 照样发得出来。**借了外层局部量**的那些提不上去，落成一句
         有名有姓的墙（`crtCall` 里那句"要一个具名函数"）—— 捕获要抄进新 g，那是另一刀。 */
      const isLit = tag(gfn) === 'fnlit';
      const isSel = tag(gfn) === 'sel';
      if (tag(gfn) !== 'name' && !isLit && !isSel) {
        throw new Error('go->graph: `go` 的体只接具名函数、匿名函数与方法值'
          + `（这儿是 ${tag(gfn)}）`);
      }
      const raw = gargs === undefined ? [] : kids(gargs).filter((y) => tag(y) !== 'spread');
      /* **方法值那一档**（`go obj.M(a)`，pt 的 renderer.go 用的就是它）：包成一格
         **零参的匿名函数**再 spawn —— 那一格由 `liftFnVals` 落成方言的闭包，接收者与实参
         就成了**按值抄一份的捕获**（`mkclo` 在 `go` 这一句上求值），正是 go 的语义
         （实参在 `go` 那一刻求值）。
         所以要求接收者与实参都是**光名字或字面量**：别的（`f(g())` 那种）在 go 里
         也要在这一句上算，而包进闭包里就成了在新 g 里算 —— 那是静默的差别，报。 */
      if (isSel) {
        /* "光名字或字面量"：`&x` 与 `(x)` 剥一层也算 —— 图上没有指针那一格，`&记录`
           本来就是**读那个名字**（见 `addr` 那一支），所以按值抄一份与 go 一致。
           pt 的 `go r.writeImage(path, buf, ColorChannel, &wg)` 就靠这一条。 */
        const plain = (y) => {
          if (!isList(y)) return false;
          const g = tag(y);
          if (g === 'addr' || g === 'paren') return plain(kids(y)[0]);
          return g === 'name' || g === 'num' || g === 'str' || g === 'rune' || g === 'sel';
        };
        if (!plain(kids(gfn)[0]) || !raw.every(plain)) {
          throw new Error('go->graph: `go 接收者.方法(…)` 的接收者与实参这一刀只接光名字、'
            + '取字段与字面量 —— 别的要在 `go` 那一句上先算出来，包进闭包里就成了在新 g 里算');
        }
        const wrap = node('func', { body: [toNode(c)] },
          { params: [], name: `__gom${FN_N++}` });
        return node('call', {
          fn: node('ref', {}, { name: '__goSpawn0' }), args: [wrap],
        });
      }
      const gname = isLit ? null : leaf(kids(gfn)[0]);
      if (raw.length > 3) {
        throw new Error(`go->graph: \`go ${gname ?? 'func(…)'}(…)\` 有 ${raw.length} 格实参 —— `
          + '这一刀的门面只到 3 格（实参要在 C 那侧打包，见 omni_go.h）');
      }
      const gargNodes = gname === null ? many(raw) : argsByDecl(gname, many(raw), false);
      const SPAWN = ['__goSpawn0', '__goSpawn', '__goSpawn2', '__goSpawn3'];
      return node('call', {
        fn: node('ref', {}, { name: SPAWN[raw.length] }),
        args: [isLit ? toNode(gfn) : node('ref', {}, { name: gname }), ...gargNodes],
      });
    }
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
    /* **`select { … }`** —— 照 go 规范摊成"先把 case 表报上去、再选、再按下标分支"
       （`omni_go_sel_*`，见 `src/runtime-sched/omni_go.h` 上那段账）。
       从前这一格是 `取第一个 case 的体、无条件跑` —— 那是**静默的错答案**。 */
    case 'select': return selectOf(x);
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
  MAPTY.clear();
  MATHFNS.clear();
  CHANS.clear();
  UNS.clear();
  for (const nm of mapNames(tree, mapBindName)) MAPS.add(nm);
  // 再扫一遍**声明过的方法名与类型名**：go 的接收者写在声明里，所以这一趟就够了 ——
  // 方法在图上是"多一格实参的普通函数"，不需要运行期查表（见 METHODS 那段）。
  METHODS.clear();
  TYPES.clear();
  STRUCTS.clear();
  UNDER.clear();
  MSET.clear();
  FSIG.clear();
  PTRRECV.clear();
  PTRED.clear();
  SPEND.clear();
  IFPEND.clear();
  IFLENT.clear();
  NARROW.clear();
  NEEDS_IBOX = false;
  TSW_N = 0;
  SPREAD_N = 0;
  NEEDS_TYPETAG = false;
  NEEDS_SCHED = false;
  VARTYPE.clear();
  /* 接口那一套（ADR-0040）也按文件重来 —— 图要可重现。 */
  IFACES.clear();
  EMBEDS.clear();
  FRET.clear();
  FOUTS.clear();
  BOXFNS.clear();
  BOXING.clear();
  NILFNS.clear();
  VARTY.clear();
  CUR_RET = null;
  IMPORTS.clear();
  collectImports(tree);
  /* **标准库桩注入**：为 IMPORTS 里每个在 GO_STDLIB_STUBS 中有定义的包名，
     生成一格 `bind <pkgName> = record-new { 常量字段… }`，让后端跑到
     `utf8.RuneSelf` 时能找到 `v_utf8` 这个变量。 */
  const stubBinds = [];
  /* **`--pkgs` 供了真包的那几个名字不发桩**：真包那格 `record-new` 与这一格桩是**同名的
     两格 bind**，而方言里同一层不许重名（量出来是 `'path' 在这一层已经声明过了`）。
     从前以为"排在后面会盖掉它"——不成立：桩是在**主文件**这一趟注入的，而主文件排在
     依赖包**后面**，所以盖掉的是真包那一格。 */
  const havePkgs = new Set(opts === undefined || opts === null || opts.havePkgs === undefined
    ? [] : opts.havePkgs);
  for (const pkg of IMPORTS) {
    if (havePkgs.has(pkg)) continue;
    if (GO_STDLIB_STUBS[pkg] !== undefined) {
      const fields = Object.entries(GO_STDLIB_STUBS[pkg]);
      /* **一格常量都没有的桩不发**（`fmt` / `sort` / `strings` … 都是空表）：
         落出来是一格**没有字段名单的记录**，而方言里没有"空结构体"这回事 ——
         core 那条腿当场报「一格没有字段名单的记录」。量出来的账：`import "fmt"` 的
         go 文件从此过不了 core，而那个绑定本来就没人读（`fmt.Println` 在 `call`
         那一格特判，压根不走取字段）。 */
      if (fields.length === 0) continue;
      const rec = recordNew(fields.map(([k, v]) => {
        if (v !== null && typeof v === 'object' && '__real' in v) {
          return [k, convOf('float', lit(v.__real))];
        }
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
  /* 接口的方法表先单独扫一遍（见 `collectIfaces`）：`fieldsOf` 要靠它判"嵌入的是接口"，
     而声明的次序是源码的事。旁边那几份也一起。 */
  for (const t of opts?.also ?? []) collectIfaces(t);
  collectIfaces(tree);
  for (const t of opts?.also ?? []) {
    if (t === tree) continue;
    for (const nm of mapNames(t, mapBindName)) MAPS.add(nm);
    collectDecls(t, false);   // 方法名也收（量过 +8 份，见 collectDecls 头上那段）
  }
  collectDecls(tree);
  /* 见 `PTRED` 那段账：被 `*T` 指过、而 T 又真是个结构体的，一律引用语义。
     求交要等扫完 —— `STRUCTS` 与 `PTRED` 是同一趟里填的。 */
  for (const n of PTRED) {
    if (STRUCTS.get(n) !== undefined && STRUCTS.get(n) !== null) PTRRECV.add(n);
  }
  /* 装箱记忆那几格隐藏字段（见 `addBoxMemoFields`）：要在**落任何节点之前**加完 ——
     结构体字面量与零值都按 `STRUCTS` 的字段表铺。 */
  addBoxMemoFields();
  FN_N = 0;                                   // 匿名 func 的编号按文件重来（图要可重现）
  const items = kids(tree).slice(1);          // 第一格是包名
  const mapped = items.map(toNode).flat();
  /* **装箱函数摆在前面**（ADR-0040）：它们是走这一趟的**副产物**（`ensureBoxFn` 在装箱点
     现造），所以得等 `mapped` 算完才齐 —— 但**摆的位置要在前面**：core 那条腿按次序推
     类型，`var one Shape = __box_Sq__Shape(…)` 要先见过那格函数才知道它交出来的是记录
     （不然 `one` 默认成 int，一取字段就报"说不清形状"）。 */
  const body = [...stubBinds, ...BOXFNS.values(),
    ...[...MATHFNS.values()].filter((v) => v !== null),
    ...[...NILFNS.values()].filter((v) => v !== null), ...mapped];
  if (opts !== undefined && opts.asModule === true) return program(body);
  /* 入口那一句。**用到并发的那些包一层**（`NEEDS_SCHED`）：`func main()` 要跑成
     主 g，不然第一次在无缓冲 channel 上发送就是"park 一个不存在的 g"。 */
  const entry = NEEDS_SCHED
    ? node('call', { fn: node('ref', {}, { name: '__goRun' }),
      args: [node('ref', {}, { name: 'main' })] })
    : node('call', { fn: node('ref', {}, { name: 'main' }), args: [] });
  return program([...body, entry]);
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
