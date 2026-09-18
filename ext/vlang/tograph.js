// ext/vlang/tograph.js —— **V 的树 -> 节点图**（第五个前端）
//
// 与 `ext/go/tograph.js` 对着看：两门语言的树几乎同形（`file` / `fn` / `define` /
// `for` / `inc` / `if` / `return` / `call`），差的只有三处小地方 ——
//   * 形参在 `(params (p 名字 (tname …)))` 里（go 是 `(sig (in (p (tname …) (name …))))`）；
//   * 左值可以带 `mut` 包一层（`mut acc := 0`）—— **不可变是默认的**，`mut` 是一格
//     不产生代码的检查（`ext/vlang/SPEC.md` §四第 2 条），这一批直接拆掉；
//   * `println` 是内建，不用走 `fmt.` 那一格选择器。
// 三处都不影响节点：**落到的还是那 13 格**。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  tag, kids, leaf, part, threePart, elseOf,
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, lazyOr, counted, partKids,
  recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet, sliceOf, destructure,
  mapNew, mapGet, mapSet, mapHas, mapNames, mapForIn, isList, assertOf,
} from '../../src/core/graph/fromtree.js';

/** 装 map 的那些名字（`vlangToGraph` 里一趟扫查填好）—— 与 go 那一份同一条办法。 */
const MAPS = new Set();
const isMap = (x) => tag(x) === 'name' && MAPS.has(leaf(kids(x)[0]));

/** `(define (lhs (mut (name m))) (rhs (lit (map …) …)))` -> `'m'`（`mut` 要拆一层）。 */
function mapBindName(x) {
  if (!isList(x)) return null;
  // `const m = map[K]V{…}` 也要进这张表（树上是 `(c 名 值)`）—— 漏了它，后面 `m[k]`
  // 会静静落成列表下标，那是"答案错而不报"
  if (tag(x) === 'c') {
    const [nm, v] = kids(x);
    return isMapLit(v) ? leaf(nm) : null;
  }
  if (tag(x) !== 'define' && tag(x) !== 'assign') return null;
  const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
  const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
  for (let i = 0; i < lhs.length; i++) {
    if (isMapLit(rhs[i])) return nameOf(lhs[i]);
  }
  return null;
}

/**
 * 右边是一格 **map 字面量**吗。V 有**两种写法**，两种都要认：
 *   * 写类型的：`map[string]int{…}` -> `(lit (map …) (kv …)…)`；
 *   * 不写类型的：`{'a': 1}` -> `(map (kv …)…)`（`map-lit` 那条产生式）。
 * 漏掉后一种的代价是**答案错而不报**：后面 `m['b']` 会静静落成列表下标。
 */
function isMapLit(r) {
  if (r === undefined || !isList(r)) return false;
  if (tag(r) === 'lit') return tag(kids(r)[0]) === 'map';
  return tag(r) === 'map' && kids(r).every((e) => tag(e) === 'kv');
}


/* V 的位运算：`&` `|` `>>` 在公共表里，这儿补 V 自己那一格 —— **V 的 `^` 是 xor**
   （V 没有幂算符，而图上 `^` 是幂，所以映到 `bxor`）。
   `<<` **不走这张表**：在 V 里它压倒性地是列表追加，`case 'bin'` 那儿先截住了。 */
const OPS = ops({ '^': 'bxor' });
const CONV = convs({
  i8: 'int', i16: 'int', i32: 'int', i64: 'int',
  u8: 'int', u16: 'int', u32: 'int', u64: 'int',
  f32: 'float', f64: 'float', string: 'str',
});
const PRINTS = new Set(['println', 'print', 'eprintln', 'dump']);

/**
 * **方法名 -> 它声明的接收者类型名**（一趟扫查得的，见 vlangToGraph）。
 * V 的接收者写在声明里（`fn (p Point) total() int`）—— 与 go 同一件事：分派是单态的，
 * 图上方法就是"多一格实参的普通函数"，不加节点、不查表。重名当场报，不猜。
 */
const METHODS = new Map();

/**
 * **类型名 -> 它声明里的字段名与顺序**（同一趟扫查）。
 *
 * `Point{1, 2}` 是**按声明顺序**的构造，而 `record-new` 那一格要的是**字段名** ——
 * 位置型字面量只给了值，所以"名字与顺序从声明来"（mojo / sbcl / chez / freebasic
 * 那四门都是这一条，不是这一门特有的办法）。
 *
 * 段标记（`pub:` / `mut:`）不是字段，跳过。**带嵌入字段的存成 null**：嵌入的那一格在
 * 构造顺序里占几格要展开被嵌类型才知道 —— 那一批不猜，位置型构造当场报。
 */
const STRUCTS = new Map();

/**
 * **声明过的字段名**（所有 struct 的字段名摊平成一个集合）与**严格档的开关**。
 *
 * 这两格是给 `--strict-calls` 那一档用的（`bench/tograph.js` 的同名开关传进来）。
 * 由来是一笔量出来的账：`x.M(…)` 里 M 没登记成方法时，这一份的兜底是"**取字段再调它**"
 * ——而那条兜底对**方法**调用运行期跑不通（记录上没有那个字段）。量出来 V 的 1310 份里
 * **423 份（32.3%）**含这种调用（3133 处，点得最多的是 `.contains` / `.join_path` /
 * `.execute` / `.str`，全是标准库里的方法）。**go 那一份在同一个形状上当场报**
 * （475 份卡在墙上）—— 两门的口径不一样，于是两栏的百分比不是一件事。
 *
 * 严格档的判据：选择子**要么是声明过的方法**（那条路已经在了），**要么是声明过的字段**
 * （那时"取字段再调它"是真的：字段里装着一格函数值）；两样都不是就当场报，
 * 措辞与 go 那一份对齐。默认**不开** —— 开了 V 那一栏会掉下来，而"掉多少"本身是一笔账
 * （见 ADR-0037 §5.1a）。
 */
const FIELDS = new Set();
let STRICT_CALLS = false;

/**
 * **这份文件 import 了哪几格模块**（名字那一段：`import os` -> `os`、
 * `import v.ast` -> `ast`、`import x as y` -> `y`）。
 *
 * 为什么要它：严格档里那句话得分得清**两件不同的事**（`docs/design/cross-file-methods.md` §5）：
 *   * `os.join_path(…)` / `os.getenv(…)` —— **模块限定的库函数**，声明在**标准库**里
 *     （`vlib/os`）。尺子的分母是"那门编译器自己的源码"，标准库不在里头 ——
 *     这一族要等"真的编 stdlib"那一层（ADR-0037 §5.1a 的 ① 档），**不是**这一层的欠账；
 *   * `x.M(…)` 里 M 声明在**同一棵源码树的别的目录**里 —— 那一族才是 mangle 那一刀要治的。
 * 两族混在一句话里，"下一刀该做什么"就看不出来了（量出来 599 份里绝大多数是前者）。
 */
const IMPORTS = new Set();

/**
 * **方法名按接收者类型压平**（`docs/design/cross-file-methods.md` 那条 A 路）。
 *
 * `MSET` 收的是 **`类型.方法名`**（`Ship.instance`），`mangle()` 把它压成图上一格函数名
 * （`Ship__instance`）。为什么这一格值得做：
 *
 *   * **撞名不再是墙**：`Ship.instance` 与 `GameObject.instance` 压出来是两个名字。
 *     原来那张平表（名字 -> 接收者类型）一撞就当场报，而"整目录一起收"会把撞名放大
 *     （量过：vlang 1044 -> 338）—— 那条死路的根就是**平表**，不是"收得太多"。
 *   * **跨文件的方法接得住了**：`MSET` 连 `opts.also` 那几份也收（按 `类型.名字` 存不会撞），
 *     于是"方法声明在同一模块的别的文件里"这一档能落成一格有名有姓的调用。
 *
 * **接收者的类型从哪儿来**：`VARTYPE`（名字 -> 具名类型），只收**语法上写着的**那三处 ——
 * 方法的接收者、带具名类型的形参、`x := T{…}` / `x := &T{…}`。
 * **这不是类型推断**（没有合一、没有传播）：写着就收，没写就不知道，不知道就走老路。
 * 真正的推断归覆盖层（#40），而覆盖层今天答的是"长什么样"不是"叫什么名字"。
 */
const MSET = new Set();
const VARTYPE = new Map();
const mangle = (owner, name) => `${String(owner).replace(/\./g, '__')}__${name}`;

/** 一格**类型**节点里的具名类型（`&T` / `?T` / `!T` / `mut T` 那几层剥掉）。别的回 null。 */
function namedType(t) {
  if (t === undefined || t === null || !isList(t)) return null;
  const g = tag(t);
  if (g === 'tname') return tnameText(t);
  if (g === 'ref' || g === 'ptr' || g === 'option' || g === 'result'
    || g === 'shared' || g === 'atomic') return namedType(kids(t)[0]);
  return null;      // 数组 / map / fntype / tinst 那几格不是具名类型
}

/**
 * **接收者那一格的具名类型**（V 的树形状：`(recv (p c (tname Counter) mut))`）。
 *
 * 那一格里**名字与 `mut` 都是记号**（不是子表），所以"按标签挑"挑不出来 ——
 * 直接拿 `namedType` 逐个问，第一个答得出名字的就是它（记号一律回 null）。
 */
function recvOwner(recv) {
  const inner = kids(recv)[0];
  if (inner === undefined) return null;
  return kids(inner).map(namedType).find((t) => t !== null) ?? null;
}

/** `T{…}` / `&T{…}` 那格**结构字面量**的具名类型（别的形状回 null —— 不猜）。 */
function litTypeName(r) {
  if (r === undefined || r === null || !isList(r)) return null;
  const g = tag(r);
  if (g === 'addr' || g === 'paren' || g === 'mut') return litTypeName(kids(r)[0]);
  if (g !== 'lit') return null;
  return namedType(kids(r)[0]);
}

/**
 * **枚举**：`枚举名.变体名 -> 值`，加一张"变体名出现在几个枚举里"的账。
 *
 * 枚举的**声明在图上是丢掉的**（类型不进图），可 `.red` / `Color.red` 这两种写法要拿到**值**
 * —— 所以名字与值要登记，与 `STRUCTS`（字段名与顺序从声明来）同一条路子。
 *
 * V 的值规则：默认从 0 数上去，写了 `= 表达式` 就从那儿接着数。这一批只接**整数字面量**
 * 那一档（别的当场报 —— 那要编译期求值）。
 *
 * `.red` 那种短写法**类型从上下文来**，而上下文这一层看不见。办法与方法重名那一格同一条：
 * 变体名在整份文件里唯一就用它，撞了就当场报（不猜）。
 */
const ENUMS = new Map();          // '枚举名.变体名' -> 值
const EVARIANTS = new Map();      // '变体名' -> 值（撞名的存 null）

/** `(tname Point)` -> `'Point'`、`(tname mod Point)` -> `'mod.Point'`；别的形状回 null。 */
const tnameText = (tn) => (tn !== undefined && tag(tn) === 'tname'
  ? kids(tn).map(leaf).join('.') : null);

/**
 * 扫一遍顶层：登记每个方法的接收者类型，以及每个 struct 的字段名与顺序。
 *
 * `shapesOnly` 那一格是**旁边那几份文件**用的（`opts.also`）：只收"这个类型长什么样"
 * （struct 的字段名与顺序 · enum 的变体），**不收方法名**。理由是量出来的：
 * 方法名那张表是"名字 -> 接收者类型"的单态分派，一个模块摊开看**重名到处都是**
 * （`Ship` 与 `GameObject` 都有 `instance`）—— 整目录一起收，V 那一栏当场从 1044 掉到 338。
 * 跨文件的方法调用因此仍旧走"取字段再调它"，那条墙留着（它要的正是类型那一层）。
 */
function collectDecls(x, shapesOnly) {
  if (!isList(x)) return;
  if (tag(x) === 'struct' || tag(x) === 'union') {
    const nm = tnameText(kids(x)[0]);
    if (nm !== null) {
      const fs = [];
      let embedded = false;
      for (const f of kids(x).slice(1)) {
        if (tag(f) === 'f') fs.push(leaf(kids(f)[0]));
        else if (tag(f) === 'embed') embedded = true;
      }
      STRUCTS.set(nm, embedded ? null : fs);
      for (const f of fs) FIELDS.add(f);      // 声明过的字段名（`--strict-calls` 那一档要它）
    }
  }
  if (tag(x) === 'enum') {
    const en = leaf(kids(x)[0]);
    let next = 0;
    for (const v of kids(x).slice(1)) {
      if (tag(v) !== 'v') continue;              // `(as 类型)` 那一格不是变体
      const vn = leaf(kids(v)[0]);
      const explicit = kids(v).find((y) => tag(y) === 'num');
      if (explicit !== undefined) next = Number(leaf(kids(explicit)[0]));
      ENUMS.set(`${en}.${vn}`, next);
      EVARIANTS.set(vn, EVARIANTS.has(vn) ? null : next);   // 撞名存 null
      next += 1;
    }
  }
  if (tag(x) === 'method') {
    const [recv, nm] = kids(x);
    const name = leaf(nm);
    const owner = recvOwner(recv);
    /* **主人认不出来时不登记**（与 go 那一份同一条纪律 —— 见 `recvOwner` 那段）。 */
    if (owner !== null) {
      MSET.add(`${owner}.${name}`);
      if (shapesOnly !== true) {
        const had = METHODS.get(name);
        METHODS.set(name, had === undefined || had === owner ? owner : null);
      }
    }
  }
  for (const k of kids(x)) collectDecls(k, shapesOnly);
}

const many = (xs) => xs.map(toNode).flat();

/** 图上是**引用**的那几种字面量（`&` 只接它们 —— 见 `case 'addr'`）。 */
const AGG = new Set(['lit', 'array', 'array-fixed', 'map']);

/**
 * `@FN` / `@METHOD` / `@STRUCT` / `@MOD` 问的是"**我在谁里头**"——
 * 这几格上下文遍历时随手记着（模块名在 `vlangToGraph` 那一趟扫出来）。
 */
let MODNAME = null;
let CUR_FN = null;
let CUR_TYPE = null;

/** Option / Result 那一族的三个标签（`x or { … }` · `f()!` · `f()?`）。 */
const OPT_TAGS = new Set(['or-block', 'propagate-err', 'propagate']);
let OPT_N = 0;
/** 语句位置上那一格临时名（`f() or { … }` 自己没有名字）。 */
const freshOpt = () => `__opt${OPT_N++}`;

/** 匿名 `fn (…) { … }` 的名字（`func` 那一格的 name 是附属，可它得有一个）。 */
let FN_N = 0;

/**
 * **声明过的编译期环境**（`$if windows` / `$if linux` 那一族）。
 *
 * 为什么是"声明"而不是"看这台机器"：**尺子要可重现**。同一份源码在 macOS 上与在 linux 上
 * 落出的图必须是同一张，不然 `bench/tograph.js` 的数就跟着机器变。所以这儿定死一个
 * **参考目标**（linux · x64 · gcc），跑在哪台机器上都按它算。
 *
 * 三条规矩，两条来自 V 自己：
 *   * `$if 名字`（不带 `?`）—— 名字必须在这张表里，**不在就当场报**（猜一支就少一段代码
 *     或者多一段，两种都是静默的错答案）；
 *   * `$if 名字 ?` —— V 说这一种"没定义也不报"（树上是 `(propagate (name …))`），
 *     所以**没声明就是 false**：这是那门语言的默认，不是我们猜的；
 *   * `$if T is $struct` / `$if field.typ is int` —— 要类型才说得清，照旧报（类型那一层）。
 */
const CT_ENV = new Map(Object.entries({
  // 参考目标：linux / x64 / gcc
  linux: true, x64: true, gcc: true, native: true, little_endian: true,
  // 别的平台与位宽
  windows: false, macos: false, darwin: false, ios: false, android: false, termux: false,
  freebsd: false, openbsd: false, netbsd: false, dragonfly: false, solaris: false,
  serenity: false, plan9: false, haiku: false, qnx: false, vinix: false, wasm32: false,
  x32: false, i386: false, arm64: false, arm32: false, rv64: false, rv32: false,
  s390x: false, ppc64le: false, loongarch64: false, big_endian: false,
  // 编译器与档
  msvc: false, tinyc: false, clang: false, mingw: false, cross: false,
  debug: false, prod: false, test: false, js: false, js_node: false, js_browser: false,
}));

/**
 * **声明过的那几格路径与目标**（`@VEXE` 那一族）。
 *
 * 与 `CT_ENV` 同一条理由、同一条纪律：这几格问的是"**编译这一趟**跑在什么环境里"
 * （V 的可执行文件在哪、目标操作系统是什么、用哪个 C 编译器）。看本机就不可重现，
 * 所以**声明**一个参考环境 —— 与交叉编译给一个 sysroot 是同一件事。
 *
 * 代价说清：落进图的是这几个**声明过的串**。程序若拿 `@VEXE` 去 exec，跑的就是这个
 * 声明的路径 —— 那正是"按声明的环境编"的含义，不是我们猜出来的某台机器。
 *
 * **不进这张表的三格**：`@VHASH`（那次构建的 git 哈希）· `@BUILD_TIMESTAMP`（构建时刻）·
 * `@VMOD_FILE`（那份 v.mod 的**内容**）—— 它们是"某一次构建"的产物，声明一个值等于编一个，
 * 所以照旧当场报。
 */
const CT_PATHS = new Map(Object.entries({
  '@VEXE': '/usr/local/bin/v',
  '@VEXEROOT': '/usr/local/lib/v',
  '@VROOT': '/usr/local/lib/v',          // 老名字，V 里与 @VEXEROOT 同义
  '@VMODROOT': '/usr/local/lib/v',
  '@OS': 'linux',                        // 参考目标（与 CT_ENV 那一行对齐）
  '@CCOMPILER': 'gcc',
  '@BACKEND': 'c',
}));

/**
 * **这一格节点在源码里的位置**（`@FILE` / `@DIR` / `@LINE` / `@COLUMN` 那一族要它）。
 *
 * 位置本来就在树上：每格节点带一格 `span`（`{file, start, end}`，`glr/driver.js` 发的），
 * 而 `SourceFile.lineCol(offset)` 就是行列。**落的路径是我们收到的那一个** ——
 * 不绝对化：绝对路径跟机器走，而这把尺子要可重现（与 `CT_ENV` 同一条理由）。
 * 没有 span 的（模板拼出来的节点）回 null，调用方照旧报缺口。
 */
function locOf(x) {
  const sp = x === null || x === undefined ? null : x.span;
  if (sp === null || sp === undefined) return null;
  const f = sp.file;
  if (f === null || f === undefined || typeof f.lineCol !== 'function') return null;
  const path = String(f.path);
  const cut = path.lastIndexOf('/');
  const { line, col } = f.lineCol(sp.start);
  return { path: path, dir: cut < 0 ? '.' : path.slice(0, cut), line: line, col: col };
}

/** 编译期条件求值。认不出来的形状**当场报** —— 这一格不许猜（见 `CT_ENV` 那一段）。 */
function ctimeCond(c) {
  const t = tag(c);
  if (t === 'paren') return ctimeCond(kids(c)[0]);
  if (t === 'bool') return leaf(kids(c)[0]) === 'true';
  if (t === 'un' && leaf(kids(c)[0]) === '!') return !ctimeCond(kids(c)[1]);
  if (t === 'bin') {
    const o = leaf(kids(c)[0]);
    if (o === '&&') return ctimeCond(kids(c)[1]) && ctimeCond(kids(c)[2]);
    if (o === '||') return ctimeCond(kids(c)[1]) || ctimeCond(kids(c)[2]);
  }
  /* `$if flag ?` —— 树上与错误传播**同一个标签**（`(propagate (name flag))`）。 */
  if (t === 'propagate' && tag(kids(c)[0]) === 'name') {
    return CT_ENV.get(leaf(kids(kids(c)[0])[0])) === true;
  }
  if (t === 'name') {
    const nm = leaf(kids(c)[0]);
    if (CT_ENV.has(nm)) return CT_ENV.get(nm) === true;
    throw new Error(`v->graph: 编译期条件里的 \`${nm}\` 不在**声明过的那张表**里（CT_ENV）`
      + ' —— 这一层不猜（猜一支就少一段代码或者多一段）');
  }
  throw new Error(`v->graph: 编译期条件是 \`${t}\` 这个形状 —— 类型层的那几种`
    + '（`T is $struct` / `field.typ is int`）要类型才说得清');
}

/**
 * **表达式位置上的临时量（"物化"）**：`g(f() or { 0 })` 那一族。
 *
 * `or-block` / `f()!` 落出来的是**一串语句**（绑一格 + 一格 branch），塞不进表达式位置。
 * 这一格的办法是把那一串**提到当前语句前面**，表达式位置上只留一格 `ref`。
 *
 * **提升会改求值次序，所以要一条判据**：`g(a(), f() or { 0 })` 里把 `f()` 提到 `a()`
 * 前面，两个都有副作用 —— 答案就变了。判据是**它前面不许有带副作用的东西**：
 * 按求值次序走一遍当前语句，走到这一格之前**不许遇到**调用 / 赋值 / 自增 / 另一格
 * or-block / match。遇到了就照旧当场报（那一族留在墙上，不猜）。
 *
 * `HOIST` 由 `stmts()` 逐条排空：一条语句映射完，它这一趟攒下的绑定摆在它**前面**。
 */
const HOIST = [];
let CUR_STMT = null;

/** 树上这一格**带副作用**吗（提升那条判据只认这几样 —— 别的当纯的）。 */
const EFFECTFUL = new Set([
  'call', 'define', 'assign', 'inc', 'dec', 'or-block', 'propagate', 'propagate-err',
  'match', 'if-bind', 'assert', 'unsafe', 'spawn', 'go',
]);

/**
 * 按求值次序走一遍 `stmt`，看 `target` **前面**有没有带副作用的东西。
 * 走到 target 就停（它自己那棵子树里的副作用不算 —— 那一串整个一起提）。
 */
function safeToHoist(stmt, target) {
  if (stmt === null) return false;
  /* target 在这棵子树里头吗（**包着它的那格调用不算"先发生"** —— 一格调用的实参先算、
     它自己后发生，所以往里走；不包着它的那格调用才是"先发生"的那个）。 */
  const has = (x) => x === target || (isList(x) && kids(x).some(has));
  let dirty = false;
  const walk = (x) => {
    if (dirty) return false;
    if (x === target) return true;
    if (!isList(x)) return false;
    if (EFFECTFUL.has(tag(x)) && !has(x)) { dirty = true; return false; }
    for (const k of kids(x)) {
      if (walk(k)) return true;
      if (dirty) return false;
    }
    return false;
  };
  const hit = walk(stmt);
  return hit && !dirty;
}

/** 一串**语句**：逐条映射，把这一条攒下的提升摆在它前面。 */
const stmts = (xs) => xs.flatMap((one) => {
  const mark = HOIST.length;
  const saved = CUR_STMT;
  CUR_STMT = one;
  let out;
  try {
    out = [toNode(one)].flat();
  } finally {
    CUR_STMT = saved;
  }
  return [...HOIST.splice(mark), ...out];
});

/** 这棵子树里提到 `err` 这个名字吗？（or-block 里的错误值 —— 这一批没有它。） */
function mentionsErr(x) {
  if (!isList(x)) return false;
  if (tag(x) === 'name' && leaf(kids(x)[0]) === 'err') return true;
  return kids(x).some(mentionsErr);
}

/** `panic('…')` / `exit(N)` 那一类"到这儿就停"（or-block 的体常常以它收尾）。 */
const stopsHere = (s) => {
  if (tag(s) === 'return' || tag(s) === 'break' || tag(s) === 'continue') return true;
  const e = tag(s) === 'expr' ? kids(s)[0] : s;
  return tag(e) === 'call' && ['panic', 'exit'].includes(leaf(kids(kids(e)[0])[0]));
};

/**
 * **Option / Result 落成一串语句**（不是一格表达式）—— 这一批的口径写在这儿：
 *
 * 这一层没有类型，Option / Result 那格值只剩"**有没有**"（`if-bind` 那一格已经是这个
 * 口径：`!= nil`）。于是：
 *   * `x := e or { blk }` -> `bind x = e` · `if x == nil { blk }`，而 blk 的**末一句是
 *     表达式**时那就是垫底的值 -> `set x = 那个值`；末一句是 return / break / continue /
 *     `panic(…)` 时照原样放（那一路根本不回来）；
 *   * `x := f()!` / `f()?` -> `bind x = f()` · `if x == nil { return x }`（把"没有值"
 *     原样传上去 —— 这一批的错误值就是"没有"）。
 *
 * **两处刻意不接**：or-block 的体里用了 `err`（错误消息不在图上，印出来会是 nil ——
 * 那是静默的错答案），以及这一族出现在**表达式里头**（`f(g() or { 0 })`）—— 那要临时量
 * 那一刀。`target` 给 `{ name, kind }`：kind 是 bind（`:=`）/ set（`=`）/ 别的（临时量）。
 */
function optOf(r, target) {
  const kind = tag(r);
  const src = kids(r)[0];
  const nm = target.name;
  const at = () => node('ref', {}, { name: nm });
  const head = target.kind === 'set'
    ? node('set', { value: toNode(src) }, { name: nm })
    : node('bind', { init: toNode(src) }, { name: nm });
  const missing = () => binOf('==', at(), lit(null), OPS, { lang: 'v' });
  if (kind !== 'or-block') {
    // `f()!` / `f()?`：没有值就原样传上去
    return [head, branchOf(missing(), node('region', { body: [retOf([at()])] }))];
  }
  const blk = kids(r)[1];
  if (mentionsErr(blk)) {
    /* **`err` 在 or-block 的体里出现** —— 这一批一律报，96 份卡在这一条上（V 那一栏最大的
       单条墙）。为什么不放松：试过一版"体以 panic / return 收尾就把 err 当 nil 放过去"
       （量到 1291 -> 1357，+66 份），可那样 `or { panic(err.msg()) }` 落出来的程序是
       **在 nil 上调 msg()**：V 印一行错误消息，我们这条腿当场炸在别的地方 ——
       用"分子涨 66"换一处**可观察的行为差**，那不是这把尺子要的东西，所以退掉了。
       真要接住这一族得先把**错误值本身**放进图（Option / Result 现在只剩"有没有" ——
       `error('x')` 落的是 nil，见 `case 'call'` 那一处）。那是一格设计决定：
       Result 变成两格（值 + 错），而不是一格 nil。记在 ADR-0037 §5.1a 上。 */
    throw new Error('v->graph: `or { … }` 的体里用了 `err` —— 这一批把 Option / Result'
      + '丢成了"有没有值"，错误消息不在图上，补个 nil 上去是静默的错答案');
  }
  const stmts = kids(blk);
  const last = stmts[stmts.length - 1];
  // **语句位置上那一路（`temp`）不补垫底的值**：`f() or { println('…') }` 的体交出来的
  // 是那句 print 的值，没人要 —— 把它落成 `set` 反而把一格 print 塞进了值位置
  // （量过：wat 那条腿当场报"值位置上还接不住 set"）。
  const body = last !== undefined && !stopsHere(last) && target.temp !== true
    ? [...many(stmts.slice(0, -1)),
      node('set', { value: toNode(tag(last) === 'expr' ? kids(last)[0] : last) }, { name: nm })]
    : many(stmts);
  return [head, branchOf(missing(), node('region', { body: body }))];
}

/**
 * `(*p).f` / `(*p)[i]` 里那一层 `deref` **剥掉**（`(paren …)` 也一并剥）。
 * 只在"当对象用"那几处调它 —— 光秃秃的 `*p` 仍旧当场报（见 `case 'deref'`）。
 */
function unwrapDeref(x) {
  let y = x;
  while (tag(y) === 'paren') y = kids(y)[0];
  return tag(y) === 'deref' ? kids(y)[0] : x;
}


/**
 * `const a = 1` / `const ( … )` / `__global ( … )` -> **一串 bind**（没有 decl 节点）。
 *
 * 树上每一格是 `(c 名 值)`。V 这一格比 go 干净：语法里就写着 `IDENT "=" expr` ——
 * **没有** go 那两条规矩（省略初值重复上一条、`iota`），所以这儿一格一格绑就完了。
 */
function cbinds(x) {
  return kids(x).map((c) => {
    if (tag(c) !== 'c') throw new Error(`v->graph: ${tag(x)} 里不该有 ${tag(c)}`);
    return node('bind', { init: toNode(kids(c)[1]) }, { name: leaf(kids(c)[0]) });
  });
}

/** 左值：`(name x)` 或 `(mut (name x))`。`mut` 只是一格检查，拆掉。 */
function nameOf(x) {
  if (tag(x) === 'mut') return nameOf(kids(x)[0]);
  if (tag(x) === 'name') return leaf(kids(x)[0]);
  return leaf(x);
}

function funcOf(x, name, self, typeName, srcName) {
  const ps = part(x, 'params');
  const params = ps === undefined ? [] : kids(ps).map((p) => leaf(kids(p)[0]));
  const blk = kids(x).find((y) => tag(y) === 'block');
  // `@FN` / `@METHOD` / `@STRUCT` 问的就是"我在谁里头" —— 落一格常量串要这两格上下文
  const savedFn = CUR_FN;
  const savedType = CUR_TYPE;
  CUR_FN = srcName ?? name;
  CUR_TYPE = typeName ?? null;
  /* **形参与接收者的具名类型收进 `VARTYPE`**（只收语法上写着的那一档，见那一段）。
     一格函数一层：进来存一份、出去还原 —— 内层函数不许把外层的表改脏。 */
  const savedVars = new Map(VARTYPE);
  if (self !== undefined && typeName !== undefined && typeName !== null) {
    VARTYPE.set(self, typeName);
  }
  if (ps !== undefined) {
    for (const p of kids(ps)) {
      const pn = leaf(kids(p)[0]);
      const t = namedType(kids(p)[1]);
      if (t !== null) VARTYPE.set(pn, t);
    }
  }
  try {
    return node('func', { body: blk === undefined ? [] : stmts(kids(blk)) },
      { params: self === undefined ? params : [self, ...params], name });
  } finally {
    CUR_FN = savedFn;
    CUR_TYPE = savedType;
    VARTYPE.clear();
    for (const [k, v] of savedVars) VARTYPE.set(k, v);
  }
}

/**
 * **`match` 落一条 branch 链**（与 go 的 `switch` 同一件事 —— V 也没有隐式贯穿）。
 *
 * V 的 match **既是语句也是表达式**，而这两件事在图上不同形，所以这一格收一个 `asStmt`：
 *   * **语句位置**：主语落一格 `bind` 到 `__mtN`（只算一次），各支的体是一格 region；
 *   * **表达式位置**：每一支要交出一个**值**，而 `bind` 摆不进表达式位置 ——
 *     所以那一路**把主语原样抄进每一格比较**，并且只接主语是名字或常量的那种
 *     （别的当场报："主语要算好几遍"）。每一支的体必须正好是一格表达式，
 *     而且**必须有 `else`** —— 不然掉出去那一路没有值。
 *
 * 分支左边是**类型**的那一族（sum type 的 match：`[]int` / `map[string]int` / `&T`）
 * 当场报：分开它们要的正是类型那一层。`.foo` 那种枚举短写法走 toNode 的兜底
 * （枚举声明整格丢掉了，所以那个名字没有出处 —— 明说在文件末尾）。
 */
let MT_DEPTH = 0;

function armConds(a, subjText) {
  return partKids(a, 'items').map((it) => {
    if (tag(it) === 'array' || tag(it) === 'map' || tag(it) === 'ref') {
      throw new Error(`v->graph: match 的分支左边是类型（${tag(it)}）—— sum type 那一族`
        + '要类型才分得开，这一批不猜');
    }
    return binOf('==', subjText(), toNode(it), OPS, { lang: 'v' });
  });
}

function matchOf(x, asStmt) {
  const all = kids(x);
  let subj = all[0];
  if (tag(subj) === 'mut') subj = kids(subj)[0];      // `match mut x` —— mut 只拆不检查
  const holder = `__mt${MT_DEPTH}`;
  const bindSubj = asStmt;
  if (!asStmt && tag(subj) !== 'name' && tag(subj) !== 'num' && tag(subj) !== 'str'
    && tag(subj) !== 'bool') {
    /* 还有一条路：主语可以**物化** —— 提一格临时量到语句前面，这儿只放一格 ref。
       前提是 safeToHoist 通过（前面没有带副作用的东西改次序）。 */
    if (!safeToHoist(CUR_STMT, x)) {
      throw new Error('v->graph: 表达式位置上的 match 主语要算好几遍 —— 那儿摆不进一格临时量，'
        + '这一批只接主语是名字或常量的');
    }
    /* 物化：把主语 bind 到 __mtN，提到当前语句前面。 */
    const nm = holder;
    HOIST.push(node('bind', { init: toNode(subj) }, { name: nm }));
    const subjRef = () => node('ref', {}, { name: nm });
    const arms2 = [];
    let dflt2;
    MT_DEPTH += 1;
    try {
      for (const a of all.slice(1)) {
        if (tag(a) === 'else') { dflt2 = armValue(a, false); continue; }
        if (tag(a) !== 'arm') throw new Error(`v->graph: match 里不该有 ${tag(a)}`);
        const conds = armConds(a, subjRef);
        if (conds.length === 0) throw new Error('v->graph: match 的分支左边一个值都没有');
        arms2.push([conds.reduce((p, q) => lazyOr(p, q)), armValue(a, false)]);
      }
    } finally {
      MT_DEPTH -= 1;
    }
    if (dflt2 === undefined) {
      throw new Error('v->graph: 表达式位置上的 match 没有 else —— 掉出去那一路没有值');
    }
    let chain2 = dflt2;
    for (let i = arms2.length - 1; i >= 0; i -= 1) chain2 = branchOf(arms2[i][0], arms2[i][1], chain2);
    return chain2;
  }
  const subjText = () => (bindSubj ? node('ref', {}, { name: holder }) : toNode(subj));
  const arms = [];
  let dflt;
  MT_DEPTH += 1;
  try {
    for (const a of all.slice(1)) {
      if (tag(a) === 'else') {
        if (dflt !== undefined) throw new Error('v->graph: 一格 match 里两个 else');
        dflt = armValue(a, asStmt);
        continue;
      }
      if (tag(a) !== 'arm') throw new Error(`v->graph: match 里不该有 ${tag(a)}`);
      const conds = armConds(a, subjText);
      if (conds.length === 0) throw new Error('v->graph: match 的分支左边一个值都没有');
      arms.push([conds.reduce((p, q) => lazyOr(p, q)), armValue(a, asStmt)]);
    }
  } finally {
    MT_DEPTH -= 1;
  }
  if (!asStmt && dflt === undefined) {
    /* **没有 else 但是每支都以 return / panic 收尾** —— V 的 match exhaustiveness 是类型检查器
       的事，这一层没有类型。但如果**每一支都不回来**，那"掉出去那一路没有值"就不可能发生。
       这一档靠 `stopsHere` 判：每支的体**最后一条是 return / break / continue / panic / exit**
       就放过去，给一格 nil 垫底（那一路跑不到）。 */
    const allStop = arms.every(([, body]) => {
      /* body 是那一支交出来的图节点。如果它是 region，检里面最后一条；
         如果它是单格表达式（不带 region），那它"交出了值"说明不是 stopsHere 那一族。 */
      return false;   // 保守：没有 else 就报 —— 判分支体是不是都 stopsHere 要回源树，不值得
    });
    if (!allStop) {
      throw new Error('v->graph: 表达式位置上的 match 没有 else —— 掉出去那一路没有值');
    }
  }
  let chain = dflt;
  for (let i = arms.length - 1; i >= 0; i -= 1) chain = branchOf(arms[i][0], arms[i][1], chain);
  if (chain === undefined) return [];
  if (!bindSubj) return chain;
  return node('region', {
    body: [node('bind', { init: toNode(subj) }, { name: holder }), chain],
  });
}

/** 一支的体：语句位置上是一格 region；表达式位置上**取最后一格表达式当值**。
 * 原来只接"正好是一格表达式"，13 份因此被挡 —— V 允许分支体里有好几条语句，
 * 最后一条是表达式就交出它（与 Rust 的块表达式同一个规矩）。 */
function armValue(a, asStmt) {
  const blk = kids(a).find((y) => tag(y) === 'block');
  const ss = blk === undefined ? [] : kids(blk);
  if (asStmt) return node('region', { body: many(ss) });
  if (ss.length === 0) {
    throw new Error('v->graph: 表达式位置上的 match，分支体是空的 —— 没有值');
  }
  const last = ss[ss.length - 1];
  const valNode = tag(last) === 'expr' ? kids(last)[0] : last;
  if (ss.length === 1) return toNode(valNode);
  /* 多条语句：前几条当语句，最后一条当值 —— 落成 region 会把值吞掉，
     所以这儿走"bind 到临时量 + ref" 的路子。 */
  const nm = `__arm${MT_DEPTH}`;
  return node('region', {
    body: [...many(ss.slice(0, -1)), node('bind', { init: toNode(valNode) }, { name: nm }),
      node('ref', {}, { name: nm })],
  });
}

/**
 * **`for x in …` 落一格计数循环**（`counted` —— 与 go 的 `range` 同一格 loop）。
 *
 * 两条 V 自己的规矩：
 *   * **一个名字给的是元素**（`for x in xs` 里 x 是元素），两个名字才是"下标 + 元素" ——
 *     这一格与 go 正相反（go 的 `for i := range xs` 里 i 是**下标**）。写法归语言。
 *   * `for i in 0..n` 是**区间**（`(range a b)`）：那一路没有序列，i 直接从 a 走到 b；
 *     终点只算一次（落一格 bind），上界**不含**。
 *
 * `range` 一格 map 当场报（要按键遍历，图上没有那一格）。串与通道判不出来 ——
 * 沿用 `MAPS` 那条既有约定（没登记成 map 的当序列），明说在文件末尾。
 */
let FI_DEPTH = 0;

function forInOf(x) {
  const nms = part(x, 'names');
  const vals = part(x, 'values');
  const blk = kids(x).find((y) => tag(y) === 'block');
  if (nms === undefined || vals === undefined) {
    throw new Error('v->graph: for-in 里没有 (names …) 或 (values …)');
  }
  const names = kids(nms).map(nameOf);
  if (names.length > 2) throw new Error(`v->graph: for-in 左边最多两格，给了 ${names.length}`);
  const subj = kids(vals)[0];
  const at = (n) => node('ref', {}, { name: n });
  const seq = `__in${FI_DEPTH}`;
  const idx = `__ix${FI_DEPTH}`;
  const cnt = `__nc${FI_DEPTH}`;
  FI_DEPTH += 1;
  let inner;
  try {
    inner = blk === undefined ? [] : stmts(kids(blk));
  } finally {
    FI_DEPTH -= 1;
  }
  // 区间：`for i in 0..n` —— 没有序列，那格名字就是计数量本身
  if (tag(subj) === 'range') {
    if (names.length !== 1) {
      throw new Error('v->graph: 区间那一路只能有一格名字（`for i in a..b`）');
    }
    const [lo, hi] = kids(subj);
    return node('region', {
      body: [
        node('bind', { init: toNode(hi) }, { name: cnt }),
        counted({
          name: names[0],
          from: toNode(lo),
          cond: bin('<', at(names[0]), at(cnt)),
          body: [node('region', { body: inner })],
        }),
      ],
    });
  }
  /* 一格 map：**按键遍历**（第三十批）。V 的规矩是"第一格键、第二格值" ——
     与列表那一格（一个名字给的是元素）不同，所以这一支单走 `mapForIn`。
     那一份三门共用：先要一格键的列表（`map-keys`），再走同一格 counted。 */
  if (isMap(subj)) {
    return mapForIn({
      subject: toNode(subj),
      keyName: names[0],
      valName: names.length > 1 ? names[1] : null,
      body: inner,
      mapVar: seq,
      keysVar: `__mk${FI_DEPTH}`,
      idxVar: idx,
      cntVar: cnt,
    });
  }
  const head = [];
  const elem = indexGet(at(seq), at(idx));
  if (names.length === 1) {
    if (names[0] !== '_') head.push(node('bind', { init: elem }, { name: names[0] }));
  } else {
    if (names[0] !== '_') head.push(node('bind', { init: at(idx) }, { name: names[0] }));
    if (names[1] !== '_') head.push(node('bind', { init: elem }, { name: names[1] }));
  }
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
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: leaf(kids(x)[0]) });
    case 'name': {
      const n = leaf(kids(x)[0]);
      if (n === 'true') return node('const', {}, { value: true });
      if (n === 'false') return node('const', {}, { value: false });
      if (n === 'none' || n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    case 'mut': return toNode(kids(x)[0]);
    // `true` / `false` 在 V 的语法里是**自己一条产生式**（`(bool $1)`），不是名字 ——
    // `name` 那一格里认 'true'/'false' 只兜住了写成标识符的那一路
    case 'bool': return node('const', {}, { value: leaf(kids(x)[0]) === 'true' });
    // `.red` —— 枚举的短写法。**值从声明来**（`ENUMS` 那段说了为什么要登记）；
    // 类型从上下文来而这一层看不见，所以靠"变体名在整份文件里唯一"定，撞了当场报。
    case 'evariant': {
      const vn = leaf(kids(x)[0]);
      if (!EVARIANTS.has(vn)) {
        throw new Error(`v->graph: .${vn} 是枚举的短写法，而这份文件里没见过那个枚举的声明`);
      }
      const val = EVARIANTS.get(vn);
      if (val === null) {
        throw new Error(`v->graph: .${vn} 在这份文件里的两个枚举里都有 —— `
          + '分开它们要类型那一层，这一批不猜（写成 `枚举名.变体名`）');
      }
      return node('const', {}, { value: val });
    }
    // `?int(x)` / `?string(none)` —— 往 **Option 类型**上的转换。这一批把 Option 那一层
    // **类型丢掉了**（`ext/vlang/SPEC.md` §五第 1 项），所以：实参是 `none` 就落 nil、
    // 里头那格类型认得出就落一格 conv、认不出就原样交出去（丢掉那层包装）。
    case 'cast': {
      const args = kids(x).find((y) => tag(y) === 'args');
      const inner = args === undefined ? [] : kids(args);
      if (inner.length !== 1) {
        throw new Error(`v->graph: ?T(…) 收了 ${inner.length} 格实参（要一格）`);
      }
      if (tag(inner[0]) === 'none') return lit(null);
      const opt = kids(x)[0];
      const ty = opt !== undefined && tag(opt) === 'option' ? kids(opt)[0] : undefined;
      const tn = ty !== undefined && tag(ty) === 'tname' && kids(ty).length === 1
        ? leaf(kids(ty)[0]) : null;
      const v = toNode(inner[0]);
      return tn !== null && CONV.has(tn) ? convOf(CONV.get(tn), v) : v;
    }
    // `p.x` -> field-get；`Point{ x: 1 }` -> record-new（**类型名不进图**）。
    // V 的字段表标签是 `f`，go 的是 `kv`，lua 的是 `named` —— 三种记号一格节点。
    case 'sel': {
      // `Color.red` 与 `p.x` 在树上同形 —— 左边是**登记过的枚举名**时它是那个变体的值。
      // 左边是 `(*p)` 时剥掉那一层（见 addr / deref 那一段）。
      const obj = unwrapDeref(kids(x)[0]);
      const fld = kids(x)[1];
      if (tag(obj) === 'name') {
        const key = `${leaf(kids(obj)[0])}.${leaf(fld)}`;
        if (ENUMS.has(key)) return node('const', {}, { value: ENUMS.get(key) });
      }
      return fieldGet(toNode(obj), leaf(fld));
    }
    // 结构字面量与 **map 字面量**在树上都叫 `lit`，差的是类型那一格：
    // `map[K]V{…}` 是 `(lit (map …) …)` —— **自带标记**，所以不必回问"这名字是什么类型"
    case 'lit': {
      if (tag(kids(x)[0]) === 'map') {
        return mapNew(kids(x).slice(1).filter((e) => tag(e) === 'kv').map((e) => {
          const [k, v] = kids(e);
          return [toNode(k), toNode(v)];
        }));
      }
      const elems = kids(x).slice(1);
      // **位置型**（`Point{1, 2}`）：字段名与顺序从**声明**来（见 STRUCTS 那段）。
      if (elems.some((e) => tag(e) === 'positional')) {
        if (!elems.every((e) => tag(e) === 'positional')) {
          throw new Error('v->graph: 结构字面量里位置与字段名混着 —— V 也不许这么写');
        }
        const nm = tnameText(kids(x)[0]);
        const fs = nm === null ? undefined : STRUCTS.get(nm);
        if (fs === undefined) {
          throw new Error(`v->graph: 位置型结构字面量要字段名与顺序，而 ${nm ?? '这个类型'} 的`
            + '声明不在这一份文件里');
        }
        if (fs === null) {
          throw new Error(`v->graph: ${nm} 有嵌入字段 —— 它在构造顺序里占几格要展开被嵌类型`
            + '才知道，这一批不猜');
        }
        if (fs.length !== elems.length) {
          throw new Error(`v->graph: ${nm} 声明了 ${fs.length} 格字段，`
            + `位置型字面量给了 ${elems.length} 格`);
        }
        return recordNew(elems.map((e, i) => [fs[i], toNode(kids(e)[0])]));
      }
      return recordNew(elems.map((e) => {
        if (tag(e) !== 'f') throw new Error(`v->graph: 结构字面量里这一格是 ${tag(e)} ——`
          + ' 这一批只接带字段名的与位置型的');
        return [leaf(kids(e)[0]), toNode(kids(e)[1])];
      }));
    }
    // `[10, 20, 30]` -> list-new；`xs[0]` -> index-get（V 与 go 从 0 起，不用减）
    case 'array': return listNew(many(kids(x)));
    // `[10, 20, 30]!` 是**定长数组**字面量 —— 元素都写出来了，落的还是那一格 list-new：
    // "定长"是**类型上**的性质，而类型不进图（`nodes.js` 文件头第一条）。
    case 'array-fixed': return listNew(many(kids(x)));
    // `{'a': 1, 'b': 2}` 是**不写类型的 map 字面量**（`map-lit` 那条产生式）——
    // 落的就是那一格 map-new。**同一个标签 `map` 还是那格类型**（`map[K]V`）：
    // 类型那一路的孩子是两格类型、字面量那一路的孩子全是 `kv`，靠这个分开；
    // 类型出现在表达式位置上当场报（那要"表达式里的类型名"那台机器）。
    case 'map': {
      const ps = kids(x);
      if (ps.length > 0 && !ps.every((e) => tag(e) === 'kv')) {
        throw new Error('v->graph: 一格 map **类型**出现在表达式位置上 —— 这一批不猜');
      }
      return mapNew(ps.map((e) => {
        const [k, v] = kids(e);
        return [toNode(k), toNode(v)];
      }));
    }
    // `unsafe { … }` 是一格**块**：`unsafe` 本身不产生代码（它只是放开指针那几样的检查），
    // 所以拆成一格 region —— 与 `mut` / `pub` 同一类（不产生代码的修饰）。
    case 'unsafe': {
      const blk = kids(x).find((y) => tag(y) === 'block');
      return node('region', { body: blk === undefined ? [] : stmts(kids(blk)) });
    }
    // `none` 是 V 的 Option 空值 —— 与 `nil` 落同一格（`name` 那一格里也认它，
    // 但语法给 `none` 一条**自己的产生式**，与 `(bool …)` 是同一种错）。
    // 注意它与三段 for 里那个空格子**同一个标签**：那几处在 `for` 那一格上先滤掉了。
    case 'none': return lit(null);
    /**
     * `` `e` `` —— V 的字符字面量。**落一格单字符的串**：这一层没有 char 类型，
     * 而语料里 508 处 `` c == `e` `` vs 4 处 `` c + `0` ``（算术） —— 99.2% 是比较。
     * 比较两个字符落成串比较就对了。`c + `0`` 那种算术要类型才说得清（它把 char 当数），
     * 落成串接也不报错但答案不同 —— 那是"类型层"那一族的事，不在这一刀。
     */
    case 'char': {
      /**
       * `` `e` `` —— V 的字符字面量。**落一格单字符的串**（图上没有 char 那一格）。
       *
       * 这一格是**语料量出来的**：V 自己的编译器里 `` c == `e` `` 508 处、
       * `` c + `0` ``（把字符当数算）只有 4 处 —— 99.2% 是"比较两个字符"，落成串比较就对了。
       *
       * **两端的 backtick 要去掉**：记号里带着它们（`leaf` 拿到的是 `` `e` `` 三个字符），
       * 不去掉就成了三字符的串 —— 与真的单字符串比一律不等，那是静默的错答案。
       * 转义（`` `\n` `` / `` `\t` ``）在这儿解开。
       *
       * 算术那 4 处照旧走 `bin`：串减串在 js 那侧是 NaN、在方言那侧当场报 ——
       * 要把字符当数得有类型层（`ord()` 那一格），不在这一刀。
       */
      const raw = leaf(kids(x)[0]);
      const inner = raw.length >= 2 && raw[0] === '`' ? raw.slice(1, -1) : raw;
      const ch = inner.length === 2 && inner[0] === '\\'
        ? ({ n: '\n', t: '\t', r: '\r', '0': '\u0000' })[inner[1]] ?? inner[1]
        : inner;
      return lit(ch);
    }
    /**
     * `$if 条件 { … } $else { … }` —— **编译期分支**：按声明过的那张环境表求值，
     * 走中的那一支**摊开**、没走的那一支**整格丢掉**（V 也不要求它编得过）。
     * 图上一格新节点也没加 —— 这一格根本不该落成运行期的 branch。
     *
     * 交出来的东西看那一支有几条：正好一条就交那一格（`x := $if windows { 1 } $else { 2 }`
     * 那种表达式位置要的是一格值），几条就交一串语句。
     */
    case 'ctime': {
      const kw = leaf(kids(x)[0]);
      /* `$for` 是编译期循环（遍历 struct 的字段列表 / enum 的变体列表）——
         那一整个循环要类型才知道走几遍，图上没有那一格。不是"等以后补"：
         不展开它就少一段代码、展开它要类型元数据 —— 两头都超出这一层。 */
      if (kw !== '$if') {
        throw new Error(`v->graph: 编译期那一格是 ${kw} —— \`$for\` 遍历 struct/enum 的`
          + '字段列表，需要类型元数据（每一趟的 field 是不同的名字与类型），这一层没有');
      }
      const chosen = ctimeCond(kids(x)[1]) ? kids(x)[2] : (() => {
        const els = kids(x)[3];
        return els === undefined ? null : kids(els)[0];
      })();
      if (chosen === null) return [];
      if (tag(chosen) === 'ctime') return toNode(chosen);      // `$else $if …`
      const out = stmts(kids(chosen));
      return out.length === 1 ? out[0] : out;
    }
    // ---- `@FN` 那一族：**"我在谁里头"落一格常量串** ------------------------------
    //
    // V 的编译期常量分两类，这一格只接**第一类**：
    //   * `@FN` / `@METHOD` / `@STRUCT` / `@MOD` —— 答案就在这棵树里（当前函数 / 接收者的
    //     类型 / 模块名），落一格 const 串是**准确的**，不是猜；
    //   * `@FILE` / `@DIR` / `@LINE` / `@COLUMN` / `@FILE_LINE` / `@LOCATION` —— **答案也在
    //     树里**：每格节点带着 `span`（`{file, start, end}`），而 `SourceFile.lineCol()` 就是
    //     行列（`src/core/source/diag.js`）。原来这儿写"这一层的树上没有行号"，**那句话是错的**
    //     —— 只 grep 了 tograph 这一份，没去看 span 那一格。落的路径是**我们收到的那一个**
    //     （不绝对化：绝对路径跟机器走，而尺子要可重现）；
    //   * `@VEXE` / `@VEXEROOT` / `@VMODROOT` / `@VROOT` / `@OS` / `@CCOMPILER`
    //     （**编译那台机器**上的路径与目标平台）—— 当场报。编个串上去就是静默的错答案。
    case 'ctconst': {
      const w = leaf(kids(x)[0]);
      if (w === '@FN' && CUR_FN !== null) return lit(CUR_FN);
      if (w === '@MOD' && MODNAME !== null) return lit(MODNAME);
      if (w === '@STRUCT' && CUR_TYPE !== null) return lit(CUR_TYPE);
      if (w === '@METHOD' && CUR_TYPE !== null && CUR_FN !== null) {
        return lit(`${CUR_TYPE}.${CUR_FN}`);
      }
      const loc = locOf(x);
      if (loc !== null) {
        if (w === '@FILE') return lit(loc.path);
        if (w === '@DIR') return lit(loc.dir);
        if (w === '@LINE') return lit(String(loc.line));     // V 里这几格都是**串**
        if (w === '@COLUMN') return lit(String(loc.col));
        if (w === '@FILE_LINE') return lit(`${loc.path}:${loc.line}`);
        /* `@LOCATION` 是 `文件:行:函数()` —— 函数名不知道就照旧报（不编） */
        if (w === '@LOCATION' && CUR_FN !== null) {
          const fn = CUR_TYPE === null ? CUR_FN : `${CUR_TYPE}.${CUR_FN}`;
          return lit(`${loc.path}:${loc.line}:${fn}()`);
        }
      }
      /* 声明过的那几格（`@VEXE` / `@OS` / …）—— 见 `CT_PATHS` 那一段。 */
      if (CT_PATHS.has(w)) return lit(CT_PATHS.get(w));
      throw new Error(`v->graph: 编译期常量 ${w} 这一格答不出来 —— `
        + '`@FN` / `@METHOD` / `@STRUCT` / `@MOD` / `@LOCATION` 要在函数（方法）里头才有答案，'
        + '`@VHASH` / `@BUILD_TIMESTAMP` / `@VMOD_FILE` 是某一次构建的产物（声明一个值等于编一个），'
        + '`$tmpl` / `$embed_file` / `$d` 要在编译期读一份别的文件');
    }

    // ---- 指针：只接**与图的语义正好重合**的那一半（与 go 那一门同一条口径）--------
    //
    // 图上的记录 / 列表 / map 本来就是**引用**，所以 `&Foo{…}`（V 的语料里到处是它：
    // `&ast.Ident{…}`）在图上**就是那一格聚合本身** —— 不是近似，是重合。
    // `&x`（名字的地址）与光秃秃的 `*p` 当场报：那两处要真的指针。
    // V 的 `&Foo` 当**类型**用时走的是另一条产生式（`(ref …)`），类型不进图，与这儿无关。
    case 'addr': {
      const a = kids(x)[0];
      if (AGG.has(tag(a))) return toNode(a);
      /**
       * **`&x` 里 x 已经是一格聚合**（`VARTYPE` 说它是登记过的 struct）—— 那 `&x` **就是 x**。
       *
       * 理由与 `&T{…}` 那一半**逐字相同**：图上的记录本来就是引用（`q := &p` 之后
       * `q.f = 5` 改的是同一格记录，与 V 一样）。这不是近似，是重合 ——
       * 而"知道 x 是不是 struct"这件事是 mangle 那一刀顺带带来的（`VARTYPE` + `STRUCTS`）。
       *
       * **仍旧报的那一半**：类型没写在语法上的、或者是标量（`&int`）—— 前者要类型层，
       * 后者是真别名（`*p = v` 那种写回，图上没有那一格）。
       */
      if (tag(a) === 'name') {
        const t = VARTYPE.get(leaf(kids(a)[0]));
        if (t !== undefined && STRUCTS.has(t)) return toNode(a);
      }
      throw new Error('v->graph: `&` 只接"刚造出来的那一格聚合"（`&T{…}` / `&[…]`）'
        + '与"已经是一格 struct 的名字"——别的（标量 / 类型没写在语法上）是真别名，'
        + '图上没有指针那一格');
    }
    case 'deref':
      throw new Error('v->graph: `*p` 只接"当对象用"那一处（`(*p).f` / `(*p)[i]`）——'
        + '当值用要指针那一格');
    case 'index': {
      const o = unwrapDeref(kids(x)[0]);
      const i = kids(x)[1];
      return isMap(o) ? mapGet(toNode(o), toNode(i)) : indexGet(toNode(o), toNode(i));
    }
    // `k in m` -> map-has（键在不在，go 那门写成 comma-ok —— 同一格节点）、
    // `x in arr` -> `prim contains`（**找元素**，线性扫）。
    // 两件事在树上同形，分开靠的还是那一趟扫查（`MAPS`）—— 与 `m[k]` / `xs[i]` 同一条。
    // `x !in arr` 是 `(not-in …)`，套一层 `not`。
    case 'in': case 'not-in': {
      const [k, o] = kids(x);
      const yes = isMap(o)
        ? mapHas(toNode(o), toNode(k))
        : node('prim', { args: [toNode(o), toNode(k)] }, { name: 'contains' });
      return tag(x) === 'in' ? yes : un('not', yes);
    }
    // `xs[1..3]` / `xs#[1..3]`（安全切片）-> slice —— V 的上界**不含**，与 go 同一个节点
    case 'slice': case 'slice-safe': {
      const [o, a, b] = kids(x);
      return sliceOf(toNode(o), a === undefined ? undefined : toNode(a),
        b === undefined ? undefined : toNode(b));
    }

    case 'bin': {
      const [op, a, b] = kids(x);
      const o = leaf(op);
      // V 的 `<<` **压倒性地是列表追加**（V 自己的编译器里 3228 行含 `<<`，抽样 20 行
      // 只有词法表里那几行是位移，其余全是 `arr << x`）。所以这一格落 `prim push`。
      // **位运算那一刀落地之后这一条更要留着**：公共表里 `<<` 已经是 `shl` 了，
      // 而 V 这一门要的是 push —— 截在这儿，不动那张公共表（`fromtree.js` 的注也写着）。
      if (o === '<<') {
        return node('prim', { args: [toNode(a), toNode(b)] }, { name: 'push' });
      }
      return binOf(o, toNode(a), toNode(b), OPS, { lang: 'v' });
    }
    case 'un': {
      const [op, a] = kids(x);
      const uo = leaf(op);
      if (uo === '~') return un('bnot', toNode(a));      // V 的 `~x` 是按位取反
      return un(uo === '!' ? 'not' : uo, toNode(a));
    }

    case 'fn': {
      const name = leaf(kids(x)[0]);
      return node('bind', { init: funcOf(x, name) }, { name });
    }
    /**
     * `fn (x int) int { … }` 当值用 —— **图上一格新节点也不用加**：`func` 那一格本来就是
     * 表达式，只是这门映射从前没接它（92 份文件卡在"这一格还没接：fnlit"上）。
     *
     * **带捕获表的那一种当场报**（`fn [a] (x int) { … }`，语料里 82 份）：V 的 `[a]` 是
     * **按值抄一份**，而图上的闭包是按引用看外层那一格 —— 外层那个名字后来改了，两者的
     * 答案就不一样。要接得先有"创建时抄一份"那一刀（一格新绑定 + 体里改名），不在这一刀。
     */
    case 'fnlit': {
      if (part(x, 'captures') !== undefined) {
        throw new Error('v->graph: `fn [a] (…) { … }` 的捕获表是**按值抄一份**，'
          + '而图上的闭包按引用看外层那一格 —— 要接得先有"创建时抄一份"那一刀');
      }
      return funcOf(x, `__fn${FN_N++}`);
    }
    // `fn (p Point) total() int { … }` -> 与 `fn` **同一格 bind + func**，
    // 差的只有"接收者当第一格形参"（go 那份一字不差 —— 接收者在声明里，分派是单态的）。
    // **方法名按接收者类型压平**（见 `MSET` / `mangle` 那一段）。
    case 'method': {
      const [recv, nm] = kids(x);
      const srcName = leaf(nm);                           // 源码里的名字（`@FN` 用它）
      const self = kids(kids(recv)[0])[0];
      if (self === undefined) {
        throw new Error(`v->graph: ${srcName} 的接收者没有名字 —— 匿名接收者这一批没接`);
      }
      /* **与登记那一处同一个算法**（`recvOwner`）：从前这儿按位置取 `[1]`，
         而登记那儿用 `part(…, 'tname')` —— `&Counter` / `mut Counter` 两种接收者
         在两处的答案不一样，调用点就落一格指向不存在的函数的 `ref`（go 那边同一个坑）。 */
      const ownerTn = recvOwner(recv);
      const graphName = ownerTn !== null ? mangle(ownerTn, srcName) : srcName;
      return node('bind', {
        init: funcOf(x, graphName, leaf(self), ownerTn, srcName),
      }, { name: graphName });
    }
    case 'block': return node('region', { body: stmts(kids(x)) });
    case 'define': case 'assign': {
      const isDef = tag(x) === 'define';
      const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
      const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
      // `a, b := two()`：**N 个名字对 1 个右值** ⇒ 多值的消费侧（一串 pick）。
      // 与 go 那一份同一条（`destructure` 在 fromtree.js）—— V 的多返回写成
      // `fn two() (int, int)` + `return 3, 7`，生产侧落 `values`，这儿落 pick。
      if (lhs.length > 1 && rhs.length === 1) {
        return destructure(lhs.map(nameOf), toNode(rhs[0]), { declare: isDef });
      }
      // `x := f() or { … }` / `x := f()!` -> **一串语句**（见 optOf 那一段的口径）
      if (lhs.length === 1 && rhs.length === 1 && OPT_TAGS.has(tag(rhs[0]))
        && tag(lhs[0]) !== 'sel' && tag(lhs[0]) !== 'index') {
        return optOf(rhs[0], { name: nameOf(lhs[0]), kind: isDef ? 'bind' : 'set' });
      }
      return lhs.map((t, i) => {
        const v = rhs[i] === undefined ? lit(null) : toNode(rhs[i]);
        /* `x := T{…}` / `x := &T{…}` —— **语法上写着的具名类型**，收进 VARTYPE
           （方法调用要拿它挑主人，见 `MSET` 那一段）。别的右值一律不收：不猜。 */
        if (isDef && rhs[i] !== undefined && tag(t) !== 'sel' && tag(t) !== 'index') {
          const tn = litTypeName(rhs[i]);
          if (tn !== null) VARTYPE.set(nameOf(t), tn);
        }
        // 左边是一格字段（`p.y = 5`）或一格下标（`xs[1] = 5`）⇒ field-set / index-set
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
      const init = part(x, 'init');
      const cond = part(x, 'cond');
      const post = part(x, 'post');
      const blk = kids(x).find((y) => tag(y) === 'block');
      // 形状与 go / awk 一模一样 —— `threePart` 只写一遍（fromtree.js）。
      // 三段里省掉的那几格在树上是 `(none)`（`vlang.grammar` 的空产生式），
      // 而 `(none)` 在**表达式位置**上是 Option 的空值（落 nil）—— 两件事同一个标签。
      // **条件那一格不能落成 nil**：`for ;; {}` 是无条件循环，那是 `cond: undefined`
      // （落成 nil 就是"条件为假"，循环一次都不跑 —— 答案错而不报）。
      const slot = (g) => (g === undefined ? [] : stmts(kids(g).filter((k) => tag(k) !== 'none')));
      const condOf = () => {
        const c = cond === undefined ? undefined : kids(cond)[0];
        return c === undefined || tag(c) === 'none' ? undefined : toNode(c);
      };
      return threePart({
        init: slot(init),
        cond: condOf(),
        post: slot(post),
        body: blk === undefined ? [] : stmts(kids(blk)),
      });
    }
    /**
     * `if x := opt() { … } else { … }` —— V 的**语句头上的绑定**（Option / Result 那一族的
     * 拆法）。落成一格 region 包着"绑一格 + branch"：
     *
     *   region { bind x = opt() ; branch (x != nil) then else }
     *
     * 三件事要说清：
     *   * **绑的那一格作用域是整条链**（else 里也看得见 `x`）—— 与 go 的 `if v := f(); cond`
     *     同一条，所以同样用 region 包着，不是把那句话挪到外面去。
     *   * 条件是"**拆得开吗**"。这一批把 Option 那一层的**类型丢掉了**
     *     （`ext/vlang/SPEC.md` §五第 1 项），所以"拆得开"落成 `x != nil` ——
     *     那是这一批的口径，不是 V 的完整语义（真的 V 里那是"有没有值"）。
     *   * `mut x` 只拆不检查（与别处同一条）。
     */
    case 'if-bind': {
      const all = kids(x);
      const nm = nameOf(all[0]);
      const src = all[1];
      const then = all[2];
      const e = elseOf(all[3]);
      const at = node('ref', {}, { name: nm });
      return node('region', {
        body: [
          node('bind', { init: toNode(src) }, { name: nm }),
          branchOf(
            binOf('!=', at, lit(null), OPS, { lang: 'v' }),
            toNode(then),
            e === undefined ? undefined : toNode(e),
          ),
        ],
      });
    }
    case 'if': {
      const [cond, then, els] = kids(x);
      const e = elseOf(els);
      return branchOf(toNode(cond), toNode(then), e === undefined ? undefined : toNode(e));
    }
    case 'return': {
      const one = kids(x)[0];
      // `return f() or { … }` / `return f()!`：先落成那一串语句，再把那一格交出去
      if (kids(x).length === 1 && OPT_TAGS.has(tag(one))) {
        const nm = freshOpt();
        return [...optOf(one, { name: nm, kind: 'bind' }),
          retOf([node('ref', {}, { name: nm })])];
      }
      return retOf(many(kids(x)));
    }

    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'expr': {
      // `match` **既是语句也是表达式**，而两者在图上不同形（语句那一路的体是 region、
      // 表达式那一路每支要交出一个值）。这儿是唯一知道"它在语句位置上"的地方。
      const inner = kids(x)[0];
      if (tag(inner) === 'match') return matchOf(inner, true);
      // `f() or { … }` / `f()!` 单独当一条语句：交出来的值没人要，落一格临时名
      if (OPT_TAGS.has(tag(inner))) {
        return optOf(inner, { name: freshOpt(), kind: 'bind', temp: true });
      }

      return toNode(inner);
    }
    /**
     * 长在**表达式里头**的那一族（`g(f() or { 0 })`）—— 走**物化**那条路：
     * 把"绑一格 + branch"提到当前语句前面，这儿只留一格 `ref`。
     * 提不了（它前面有带副作用的东西）就照旧当场报 —— 见 `safeToHoist` 那一段。
     */
    case 'or-block': case 'propagate-err': case 'propagate': {
      if (!safeToHoist(CUR_STMT, x)) {
        throw new Error(`v->graph: \`${tag(x)}\` 长在表达式里头，而它**前面还有带副作用的`
          + '东西** —— 提一格临时量上去会改求值次序，这一格不猜');
      }
      const nm = freshOpt();
      HOIST.push(...optOf(x, { name: nm, kind: 'bind' }));
      return node('ref', {}, { name: nm });
    }
    case 'match': return matchOf(x, false);
    case 'for-in': return forInOf(x);
    // `assert cond` / `assert cond, msg` -> 一格 assert 节点（第二十九批）。
    // 这一格是**账上算出来的**：V 自己的编译器里 578 份文件的第一堵墙就是它。
    case 'assert': {
      const m = part(x, 'msg');
      return assertOf(toNode(kids(x)[0]), m === undefined ? undefined : toNode(kids(m)[0]));
    }
    // `defer { … }` / `defer: …` -> scope-exit（与 go 的 defer、CL 的 unwind-protect
    // **同一格节点**：逆序、早退也跑，八家共用那一格）
    case 'defer': return node('scope-exit', { action: stmts(kids(x)) });
    case 'call': {
      const [fn, args] = kids(x);
      const rawArgs = args === undefined ? [] : kids(args);
      /**
       * `f(a: 3, b: 4)` —— V 的**"命名实参"其实是那格参数结构体的字面量**
       * （`fn f(o Opts)` 可以写成 `f(a: 3, b: 4)`，等价于 `f(Opts{a: 3, b: 4})`）。
       *
       * 所以它落的是**一格 record-new 当唯一的实参**，不是"按形参名排回位置" ——
       * 那些名字是**结构体的字段名**，不是形参名（形参只有一个，叫 `o`）。
       * 按形参名排会错得很难看：字段名与形参名根本不是同一族名字。
       * 混着写（有名的与位置的一起）V 自己也不许 —— 当场报。
       */
      if (rawArgs.length > 0 && rawArgs.some((a) => tag(a) === 'named')) {
        if (!rawArgs.every((a) => tag(a) === 'named')) {
          throw new Error('v->graph: 实参里"有名的"与"位置的"混着 —— V 也不许这么写');
        }
        const rec = recordNew(rawArgs.map((a) => [leaf(kids(a)[0]), toNode(kids(a)[1])]));
        return node('call', { fn: toNode(fn), args: [rec] });
      }
      const argNodes = many(rawArgs);
      const callee = tag(fn) === 'name' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      // `panic('…')` -> **那格 assert**（条件恒假 + 消息）：图上"印一句话再停下来"只有那一格，
      // 而 or-block 的体十有八九以 panic 收尾 —— 这一格是 Option 那一刀的前提。
      if (callee === 'panic' && argNodes.length === 1) return assertOf(lit(false), argNodes[0]);
      // `error('…')` -> **nil**：这一批的 Result 只剩"有没有值"（见 optOf 那一段），
      // 错误消息不在图上。`or { … }` 的体里一用 `err` 就当场报 —— 消息丢了不许装作没丢。
      if (callee === 'error' && argNodes.length === 1) return lit(null);

      if (callee !== null && CONV.has(callee) && argNodes.length === 1) {
        return convOf(CONV.get(callee), argNodes[0]);   // `int(x)` / `f64(x)`
      }
      // `p.total()` -> `total(p)`：接收者是**第一格实参**（声明里写着是哪个类型，
      // 所以这一步是纯改写）。名字没登记成方法就仍然是"取字段再调它" —— 判据在声明里。
      // `p.total()` -> 方法调用 —— **三条路**（见 `docs/design/cross-file-methods.md`）：
      //   1. 接收者的类型**知道**（`VARTYPE` 里有 · 或 `MSET` 里只有一个主人）：mangle
      //   2. 接收者的类型**不知道**但名字只有一个主人（`METHODS` 值不是 null）：走老路（当第一个实参）
      //   3. 两样都不知道：严格档当场报、松的那一档走兜底（"取字段再调它"）
      if (tag(fn) === 'sel') {
        const selName = leaf(kids(fn)[1]);
        const recv = kids(fn)[0];
        const recvName = tag(recv) === 'name' ? leaf(kids(recv)[0]) : null;
        // 路 1：从 VARTYPE 查接收者的具名类型
        const ownerFromVar = recvName !== null ? VARTYPE.get(recvName) : null;
        // 路 1b：从 MSET 查 —— 如果 `类型.名字` 只有一个（没撞名就只有一个主人）
        const ownerFromMethods = METHODS.get(selName);
        const owner = ownerFromVar ?? (ownerFromMethods !== null ? ownerFromMethods : null);
        if (owner !== null && owner !== undefined && MSET.has(`${owner}.${selName}`)) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(owner, selName) }),
            args: [toNode(recv), ...argNodes],
          });
        }
        /* 路 2：平表里有且只有一个主人（值不是 null）—— 走老路 */
        if (ownerFromMethods !== undefined && ownerFromMethods !== null) {
          return node('call', {
            fn: node('ref', {}, { name: mangle(ownerFromMethods, selName) }),
            args: [toNode(recv), ...argNodes],
          });
        }
        /* 路 3：都不知道 —— 严格档报、松的走兜底 */
        if (STRICT_CALLS && !FIELDS.has(selName)) {
          if (recvName !== null && IMPORTS.has(recvName)) {
            throw new Error(`v->graph: 库函数 ${recvName}.${selName} 声明在标准库里`
              + '（这棵源码树里没有它）—— 那是尺子的下一层，不是这一层的欠账');
          }
          throw new Error('v->graph: 这一批只接声明过的方法与声明过的字段，收不了 '
            + `.${selName} —— 跨模块的方法要类型那一层`);
        }
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    // 顶层的这几样在这一批里没有对应物 —— 丢掉，不猜。
    // `typedecl`（`type X = A | B` —— 别名与 sumtype）与 `interface` 都是**类型的声明**，
    // 而类型不进图。树上的标签是 `typedecl` 不是 `type-decl` —— 原来写的那一格是**死代码**
    // （283 份卡在这儿，与 go 那份 `var-decl` / `const-decl` 是同一个错）。
    case 'module': case 'import': case 'struct': case 'enum':
    case 'typedecl': case 'interface': case 'union': return [];
    /**
     * `#flag -lm` / `#include <stdio.h>` / `#pkgconfig gtk+-3.0` —— **给 C 后端的搭建指令**，
     * 不产生一行运行期代码（V 自己把它们交给 cc 与链接器）。所以这一格与 `import` 同一类：
     * **丢掉**。
     *
     * 为什么丢掉不算"藏账"：一份文件真要用那些 C 名字得写 `C.foo(…)`，而 `C` 不是
     * import 进来的模块，也没有登记成方法 —— 严格档那儿当场报"收不了 .foo"、松的那一档
     * 落成兜底并被「取字段调」那一栏数着。**指令丢掉了，用它的那一处仍旧在账上。**
     * 43 份文件卡在这一格上（V 那一栏第四高的墙）。
     */
    case 'cdirective': return [];
    // `pub` 是可见性、`attrs` 是属性表 —— 两样都**不产生代码**（与 `mut` 同一类），
    // 拆一层接着走。`(attributed (attrs …) (module …))` 那一路拆完落到 module，也就是空。
    case 'pub': return toNode(kids(x)[0]);
    case 'attributed': return toNode(kids(x)[1]);
    case 'const': case 'global': return cbinds(x);
    default:
      throw new Error(`v->graph: 这一格还没接：${tag(x) ?? String(JSON.stringify(x)).slice(0, 40)}`);
  }
}

/**
 * 一棵 V 的 GLR 树（`(file 顶层项…)`）-> 一张图。末尾补一格 `call main`（同 go）。
 * `opts.asModule` = 被 import 进来的那份：**不补**那一格（不然被导入的 `main` 也会跑）。
 */
export function vlangToGraph(tree, opts) {
  if (tag(tree) !== 'file') throw new Error('v->graph: 这不是 (file …)');
  // 先扫一遍哪些名字装 map（`m := map[K]V{…}` 自带标记）—— 与 go 那一份同一条办法
  MAPS.clear();
  for (const nm of mapNames(tree, mapBindName)) MAPS.add(nm);
  // 再扫一遍**声明过的方法名**（接收者的类型写在声明里 —— 单态分派，不查表）
  METHODS.clear();
  STRUCTS.clear();
  FIELDS.clear();
  MSET.clear();
  VARTYPE.clear();
  STRICT_CALLS = opts !== undefined && opts.strictCalls === true;
  /* import 进来的模块名（严格档里要拿它分"库函数"与"别的目录里的方法"两族）。
     `import v.ast` 的名字是最后那一段；`import x as y` 用别名。 */
  IMPORTS.clear();
  for (const spec of vlangImports(tree)) {
    const segs = String(spec).split('.');
    IMPORTS.add(segs[segs.length - 1]);
  }
  for (const it of kids(tree)) {
    if (!isList(it) || tag(it) !== 'import') continue;
    const al = kids(it).find((y) => isList(y) && tag(y) === 'as');
    if (al !== undefined) IMPORTS.add(leaf(kids(al)[0]));
  }
  ENUMS.clear();
  EVARIANTS.clear();
  /**
   * **同一格模块里别的文件先扫**（`opts.also`）：V 里同一个目录就是同一个模块，
   * `Point{1, 2}` 的字段名与顺序**可能声明在旁边那份文件里**。这一趟只收声明
   * （struct / enum / method / 装 map 的名字），不落一格节点 —— 落节点是各自那一趟的事。
   * **旁边的先扫、自己的后扫**：同名时自己这一份说了算。
   */
  for (const t of opts?.also ?? []) {
    if (t === tree) continue;
    for (const nm of mapNames(t, mapBindName)) MAPS.add(nm);
    /* **平表也收**（`shapesOnly` 传 false，与 go 那一份对齐 —— 2026-09-18 量出来的）。
       这道闸管的只有**平表** `METHODS`（`MSET` 那张按 `类型.名字` 存的表在闸外头，
       本来就收 `opts.also` 那几份）。量的是「取字段调」那一栏（分子里的虚数）：
         * 平表不收旁边那几份：**485 份**（`flat === undefined` 就走兜底）
         * 平表也收：            **468 份**（少 17 份）
       "撞名会多"这一半是真的，可撞名本来也走兜底 —— 而"这名字只声明在旁边那份里"
       那一半从前**一律**走兜底。两边相抵之后收着更好。落成图的数两种都是 1389。 */
    collectDecls(t, false);
  }
  collectDecls(tree);
  /* 匿名 fn 与 Option 那格临时名的编号**按文件重来** —— 同一份源码要落出同一张图
     （`tests/graph/stat.js` 那一条"两遍一样"就是判这个）。 */
  FN_N = 0;
  OPT_N = 0;

  // 模块名（`@MOD` 要它）—— 顶层那一条 `(module 名)`，没写就是 null（那时 `@MOD` 当场报）
  const mod = kids(tree).find((y) => tag(y) === 'module');
  MODNAME = mod === undefined ? null : leaf(kids(mod)[0]);
  CUR_FN = null;
  CUR_TYPE = null;

  HOIST.length = 0;
  const body = stmts(kids(tree));
  /* 提升必须**全被排空**（每条语句一趟）—— 剩下就是漏了一处语句列表，
     那时表达式里那格 `ref` 会指向一个没绑过的名字。宁可当场报。 */
  if (HOIST.length !== 0) {
    throw new Error(`v->graph: 有 ${HOIST.length} 格提升没人收 —— 漏了一处语句列表`);
  }
  if (opts !== undefined && opts.asModule === true) return program(body);
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

/**
 * 这份文件 `import` 了哪几格（第一百五十一片第二格）。树上是 `(import <mod-path> [(as 名)])`；
 * mod-path 可能是一格名字、也可能点分几格 —— 一律拼回原文（`a.b` 那种）。
 */
export function vlangImports(tree) {
  const out = [];
  const text = (x) => {
    if (!isList(x)) return leaf(x) ?? '';
    /* `kids()` 不含标签（`fromtree.js:34`）—— 别再 slice 一次。 */
    return kids(x).map(text).filter((s) => s !== '').join('.');
  };
  const walk = (x) => {
    if (!isList(x)) return;
    if (tag(x) === 'import') {
      const spec = text(kids(x)[0]);
      if (spec !== '') out.push(spec);
      return;
    }
    for (const k of kids(x)) walk(k);
  };
  walk(tree);
  return out;
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. option/result（`?T` / `!T` / `or {}` / `!` 传播）不在这一批 —— 它是
//      **错误出端口 + 切段**，排在 `multi-value` 那一步（`ext/vlang/SPEC.md` §五第 1 项）。
//   2. `mut` 只拆不检查（它是一格不产生代码的检查特性）。
//   2b. `for … in` 那一格**判不出来的两种**沿用 `MAPS` 那条既有约定（没登记成 map 的当
//      序列），所以串与通道会落成"按下标走"而不报。map 与区间判得出来：前者当场报、
//      后者落 counted。
//   2c. `match` 的分支左边是**类型**的那一族（sum type）当场报；`.foo` 那种枚举短写法
//      走兜底（枚举声明整格丢掉了，那个名字没有出处 —— 见下面第 3 条）。
//   3. struct / enum / interface / `type X = …` 的**声明**在图上都丢掉，但 struct 的
//      **字段名与顺序要登记**（`STRUCTS`）—— 位置型字面量 `Point{1, 2}` 只给了值，
//      名字得从声明来。声明不在这一份文件里、或者那个 struct 有嵌入字段，都当场报。
//      spawn / chan 不在这一批。
//      **enum 丢掉是有代价的**：`.red` / `Color.red` 那种引用还没有出处（这一格还在墙上）。
//   3b. `assert` 要的是一格"停下来"的内建（图上的 prim 表里没有），所以它留在墙上 ——
//      那不是映射的账。
//   4. 方法：接收者提到形参表第一格（第二十四批，与 go 同一条办法）。`mut` 接收者只拆不检查、
//      接口与方法值不在这一批；同名方法当场报 —— 分开它们要的是类型那一层。
