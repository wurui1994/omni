// ext/cpp/tograph.js —— **C++ 的树 -> 节点图**（第十门语言，最贵的那一门）
//
// 这一份的意义不在"又多一门"，在于它是**唯一一门语法本身会两解**的语言：
// `printf(...)` 与 `int x = 3;` 在 GLR 下都曾经两支都归约得成。三类歧义量下来
// 两类是"语法写松了"（至多一格 type-spec、函数定义不进语句 —— 都改在 cpp.grammar 里），
// 只有 `T * x;` 那一类是真要"回问这名字登记成类型了吗"（task #15 剩下的那一笔）。
//
// 这一批明说的约定（不猜）：
//   * **类型全丢**（与 go / V 同一条：type 是端口的 sort，不是图上的格子）；
//   * **`printf` 的格式串不是节点**：只认 `"%d\n"` 与 `"%s\n"` 两种，把它当"打印一格值"
//     收 —— 格式化本身要等一格 `format` 内建。别的格式串当场报错。
//   * 入口是 `main`：映射末尾显式补一格 `call main`（与 go / V 同一条约定）。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part,
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, listNew, indexGet, indexSet, truthyLit,
  recordNew, fieldGet, fieldSet, mapNew, mapGet, mapSet, mapHas,
} from '../../src/core/graph/fromtree.js';

const OPS = ops();
/**
 * **强制转换的目标类型 -> `conv` 那格的 `to`**。C++ 的转换不是"调用的形状"（别的门
 * 都是），它自己有语法：`(int)x` 与 `static_cast<int>(x)` —— 两种写法一格节点。
 * 定宽的那一族全往四格收（类型是端口的 sort，不是格子）。
 */
const CONV = convs({
  int: 'int', long: 'int', short: 'int', char: 'int', unsigned: 'int', signed: 'int',
  float: 'float', double: 'float', bool: 'bool',
});

/**
 * **哪个名字是记录、它有哪些字段**（`struct Point { int x; int y; };` 扫出来的）。
 *
 * 与 go / V 的 `(lit (map …))`、nim 的 `initTable[…]()` 是同一条：`{1, 2}` 这种花括号
 * 初始化式**既能填记录也能填列表**，分开靠的不是类型系统，是"造它的那一步自带标记" ——
 * cpp 这儿的标记就是**同一份文件里的 struct 声明**。扫一遍就有答案（十几行），
 * 不必回问类型（那是 `T * x;` 那笔账，另一件事）。
 *
 * 判不了的一律报错、不猜：外部头文件里声明的记录（没扫到）当场报。
 */
let STRUCTS = new Map();

/**
 * **哪些类型有 `~T()`**（RAII）。出口动作也是"名字从声明来"：析构写在类里，
 * 于是 `Say s;` 落成**一格 bind + 一格 scope-exit** —— 与 FB 的 `Destructor`、
 * mojo 的 `__exit__`、go 的 `defer` 是同一格节点。析构体自己是一格普通函数
 * （形参就叫 `this`，C++ 里本来就这么写），名字用 `__destruct_<类型>`。
 */
let DTORS = new Set();
const dtorName = (ty) => `__destruct_${ty}`;

/**
 * **装 `std::pair` 的那些名字**（一格 `auto t = std::make_pair(3, 7)` 登记一个）。
 *
 * C++ 的双值载体是 `std::pair`，而图上"一格产生两个值 + 按第几格取用"本来就有
 * （`values` / `pick`）—— 所以 `make_pair` 落 `values`、`t.first` / `t.second` 落 `pick`。
 * 要这张表的理由只有一条：`.first` 在别的类型上可能真是一格字段，
 * 所以**只有登记过的名字**才当 pick（判据还是"造它的那一步自带标记"）。
 *
 * 明说边界：`std::pair<int,int>` 当**类型**写出来（形参、返回值、`std::pair<…> t;`）
 * 这一批**没接映射**，但不是语法读不进来 —— 那句旧账这一批作废了（见文件末尾第 2 条）：
 * 名字登记过就读得进来，欠的是"取出来那两格怎么落"（`t.first` 现在只认登记过的名字）。
 */
let PAIRS = new Set();
const isMakePair = (x) => {
  if (!isList(x) || tag(x) !== 'call') return false;
  const callee = kids(x)[0];
  if (!isList(callee) || tag(callee) !== 'qual') return false;
  const parts = kids(callee).map((y) => (isList(y) ? nameOf(y) : leaf(y)));
  return parts.length === 2 && parts[0] === 'std' && parts[1] === 'make_pair';
};

/**
 * **装映射的那些名字**（`std::map<std::string, int> m;` 声明一个）。
 *
 * 与 nim 的 `initTable[K, V]()`、mojo 的 `Dict[K, V]()` 是**同一条办法**：
 * 造它的那一步自带标记，所以不必回问类型。cpp 这儿的标记就是**声明里那个模板名** ——
 * `map` / `unordered_map`（限定不限定都认：`std::map<…>` 与 `using namespace std` 之后的
 * `map<…>` 是同一件事）。
 *
 * 为什么这一格现在做得了：模板名当类型那笔账**不在语法上**了 —— `needs-type` 那台机器
 * 只要名字登记过就读得进来（量出来的：`namespace std { template <class K, class V> class map; }`
 * 之后 `std::map<std::string,int> m; m["a"] = 1;` 整段过）。所以例子把它用到的库名
 * **自己声明出来**（头文件干的就是这件事，而这一门不做预处理）。
 *
 * 边界照旧明说：只认"声明出来的那一格"。`auto m = std::map<…>{}` 这种造在原地的写法
 * 不在这一批（那要一格"表达式里的类型名"），落 `call` 之后会当场报错，不会读错。
 */
let MAPS = new Set();
const MAP_TEMPLATES = new Set(['map', 'unordered_map']);

/**
 * 一格 `specs` 是不是"映射类型"（`std::map<K,V>` / `unordered_map<K,V>`）。
 * 回那个模板名，不是就回 null。限定名按**最后一段**看 —— 与语法里 `needs-type` 的规矩一致。
 */
function mapTemplateOf(specs) {
  if (specs === undefined || specs === null) return null;
  for (const s of kids(specs)) {
    if (!isList(s)) continue;
    const t = tag(s) === 'qual' ? kids(s)[kids(s).length - 1] : s;
    if (!isList(t) || tag(t) !== 'tid') continue;
    const nm = nameOf(kids(t)[0]);
    if (MAP_TEMPLATES.has(nm)) return nm;
  }
  return null;
}

/** 一格表达式是不是"登记过的映射名"（`m` 而不是 `xs`）—— 下标那一格靠它分流。 */
const isMapName = (x) => isList(x) && (tag(x) === 'n' || tag(x) === 'name') && MAPS.has(nameOf(x));

/** `(class struct (n Point) (members …))` -> 登记字段名 */
function collectStructs(x) {
  if (Array.isArray(x)) { x.forEach(collectStructs); return; }
  if (!isList(x)) return;
  if (tag(x) === 'class') {
    const nm = kids(x).find((y) => isList(y) && (tag(y) === 'n' || tag(y) === 'name'));
    const ms = part(x, 'members');
    if (nm !== undefined && ms !== undefined) {
      const fields = [];
      for (const m of kids(ms)) {
        if (!isList(m) || tag(m) !== 'decl') continue;
        const ip = part(m, 'init');
        if (ip === undefined) continue;
        for (const d of kids(ip)) if (isList(d) && tag(d) === 'd') fields.push(declName(d));
      }
      STRUCTS.set(nameOf(nm), fields);
      // **`~Say()` 就是"这个类型的量出了作用域要跑一段"**（RAII）—— 与 FB 的
      // `Declare Destructor()`、mojo 的 `__exit__`、go 的 `defer` 是同一格 scope-exit。
      // 这儿只登记"哪个类型有析构"，析构体在 `case 'decl'` 那格提成一格顶层函数。
      for (const m of kids(ms)) {
        if (!isList(m) || tag(m) !== 'func') continue;
        const fn = part(m, 'fn');
        if (fn !== undefined && kids(fn).some((y) => isList(y) && tag(y) === 'dtor')) {
          DTORS.add(nameOf(nm));
        }
      }
    }
  }
  kids(x).forEach(collectStructs);
}

/** 这格 specs 说的是哪个**记录**（不是记录就回 null） */
function structOf(specs) {
  if (specs === undefined) return null;
  for (const s of kids(specs)) {
    if (!isList(s)) continue;
    if (tag(s) === 'n' || tag(s) === 'name') {
      const nm = nameOf(s);
      if (STRUCTS.has(nm)) return nm;
    }
    if (tag(s) === 'elaborated') {
      const nm = kids(s).find((y) => isList(y) && (tag(y) === 'n' || tag(y) === 'name'));
      if (nm !== undefined && STRUCTS.has(nameOf(nm))) return nameOf(nm);
    }
  }
  return null;
}

const many = (xs) => xs.map(toNode).flat();

/**
 * 这格 specs 里的类声明带的**析构体** -> 一串顶层函数（形参 `this`）。
 * `~Say() { … }` 在树上是类成员里的一格 `(func (fn (dtor Say) (params)) () (body …))` ——
 * 提出来就是一格普通函数，图上不加节点。**只接这一种成员函数**：别的方法要单态分派
 * 那一层（`ext/cpp` 那笔账），撞上照旧当"这一格还没接"报。
 */
function dtorFuncs(specs) {
  if (specs === undefined) return [];
  const out = [];
  for (const s of kids(specs)) {
    if (!isList(s) || tag(s) !== 'class') continue;
    const ms = part(s, 'members');
    if (ms === undefined) continue;
    for (const m of kids(ms)) {
      if (!isList(m) || tag(m) !== 'func') continue;
      const fn = part(m, 'fn');
      const dt = fn === undefined ? undefined : kids(fn).find((y) => isList(y) && tag(y) === 'dtor');
      if (dt === undefined) continue;
      const body = part(m, 'body');
      const name = dtorName(nameOf(kids(dt)[0]));
      out.push(node('bind', {
        init: node('func', { body: body === undefined ? [] : many(kids(body)) },
          { params: ['this'], name }),
      }, { name }));
    }
  }
  return out;
}

/** 一格名字：`(n x)` 或光秃秃的叶子。 */
const nameOf = (x) => (tag(x) === 'n' || tag(x) === 'name' ? leaf(kids(x)[0]) : leaf(x));

/**
 * 声明符里那个名字。修饰可以套好几层（`const char* t` 是 `(d (ptr * (n t)) …)`，
 * `int a[3]` 是 `(d (arr (n a) …))`），所以**往下找**，但有两处不进：
 *   * `init` —— `int x = y;` 里的 `y` 不是被声明的那个名字；
 *   * `specs` —— 用户定义的类型名也是名字（`myint n` 的 specs 里有 `(n myint)`），
 *     进去就会把类型名当成被声明的名字（量出来过：形参 `myint n` 一度绑成了 `myint`）。
 * 指针 / 引用 / 数组的修饰本身丢掉（类型全丢）。
 */
function findName(y) {
  if (!isList(y)) return null;
  if (tag(y) === 'n' || tag(y) === 'name') return nameOf(y);
  if (tag(y) === 'init' || tag(y) === 'specs') return null;
  for (const k of kids(y)) { const r = findName(k); if (r !== null) return r; }
  return null;
}
function declName(d) {
  const found = findName(d);
  if (found === null) throw new Error('cpp->graph: 这格声明符里找不到名字');
  return found;
}

/**
 * 一格串字面的**值**。cpp 的 STRING 是 `(token …)` 收的，记号里带着原样的
 * 前缀 / 引号 / 转义（量出来的：`"%d\n"` 的 leaf 是六个字符 `"`,`%`,`d`,`\`,`n`,`"`），
 * 与 go / V 那几门用 `(string …)` 收、词法就把这些去干净了的不一样。
 *
 * 去哪一层？**归这一层**：前缀（`u8` `L` `R`…）、转义表、相邻字面拼接（`"a" "b"` 是一格串）
 * 都是 C++ 的写法，图上只该有"一格串的值"。词法不动 —— 它要按原样收，生串才收得住。
 */
const ESC = {
  n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'",
  a: '\x07', b: '\b', f: '\f', v: '\v',
};
function oneStr(raw) {
  const s = String(raw);
  const q = s.indexOf('"');
  if (q < 0) throw new Error('cpp->graph: 这格串字面里找不到引号');
  const prefix = s.slice(0, q);
  if (prefix.includes('R')) {                       // 生串：`R"(…)"`，里头不解释转义
    return s.slice(q + 2, -2);
  }
  const body = s.slice(q + 1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const e = body[i + 1];
    if (!(e in ESC)) throw new Error(`cpp->graph: 还没接这个转义：\\${e}`);
    out += ESC[e]; i += 1;
  }
  return out;
}
/** `(str STRING…)` —— 相邻的几格字面接成一格。 */
const strVal = (x) => kids(x).map((k) => oneStr(leaf(k))).join('');

/** `printf` 的格式串：只认这几种，别的报错（格式化不是节点 —— 见文件头）。 */
const FORMATS = new Set(['%d\n', '%s\n', '%ld\n', '%f\n', '%g\n']);

function toNode(x) {
  switch (tag(x)) {
    // ---- 叶子与名字 --------------------------------------------------------
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: strVal(x) });
    case 'n': case 'name': return node('ref', {}, { name: nameOf(x) });
    // `this` —— 析构体提成顶层函数之后，它就是那一格形参的名字（见 dtorFuncs）
    case 'this': return node('ref', {}, { name: 'this' });
    // `(int)x` 与 `static_cast<int>(x)` —— **两种写法一格 conv 节点**（目标是附属）。
    // 别的九门的转换都长成"调用"的样子，靠一张名字表分开；C++ 这一门语法上就是转换，
    // 所以这儿不需要那张表 —— 需要的是"目标类型往四格里收"（见 CONV）。
    case 'cast': case 'named-cast': {
      const ty = part(x, 'type');
      const val = kids(x)[kids(x).length - 1];
      const specs = ty === undefined ? undefined : part(ty, 'specs');
      const bt = specs === undefined ? undefined : kids(specs).find((s) => isList(s) && tag(s) === 'btype');
      const base = bt === undefined ? null : String(leaf(kids(bt)[0])).toLowerCase();
      if (base === null || !CONV.has(base)) {
        throw new Error(`cpp->graph: 这一格强制转换还没接：到 ${base ?? '?'}（指针 / 用户类型不在这一批）`);
      }
      return convOf(CONV.get(base), toNode(val));
    }
    case 'paren': return toNode(kids(x)[0]);
    // `xs[i]` -> index-get（与 go / lua / 两门 Lisp 同一格节点；下标起点是语言的事，
    // C++ 与 go 一样从 0 起，所以这儿一个字不用换）
    case 'index': {
      const [obj, idx] = kids(x);
      // `m["a"]`（`m` 是登记过的映射）-> map-get。**与 `xs[i]` 同一个记号、两格节点** ——
      // 分开靠的是"造它的那一步自带标记"（MAPS），与 go / V / nim / mojo 同一条。
      if (isMapName(obj)) return mapGet(toNode(obj), toNode(idx));
      return indexGet(toNode(obj), toNode(idx));
    }
    // `p.x` -> field-get（`p->x` 也落这一格：指针是写法，图上没有取地址那件事）
    case 'dot': case 'arrow': {
      const [obj, f] = kids(x);
      // `t.first` / `t.second`（`t` 是登记过的 pair）-> pick 那一格（第 0 / 1 个出端口）
      const k = nameOf(f);
      if (isList(obj) && (tag(obj) === 'n' || tag(obj) === 'name')
        && PAIRS.has(nameOf(obj)) && (k === 'first' || k === 'second')) {
        return node('pick', { from: toNode(obj) }, { index: k === 'first' ? 0 : 1 });
      }
      return fieldGet(toNode(obj), k);
    }
    // `{10, 20, 30}` -> list-new。**记录那一侧看的是被声明的类型**（见 decl 那一格）——
    // 走到这儿的花括号就是列表。
    case 'braces': return listNew(many(kids(x)));
    case 'expr': return toNode(kids(x)[0]);
    case 'pp': return [];                       // `#include` 丢掉（这一批不做预处理）
    // `namespace std { … }` / `template <class K, class V> class map;`
    // —— 这一批只收它们**当声明用**的那一面：图上没有命名空间与模板这两格，里头那些
    // 声明该出什么就出什么（库名的前向声明出 `[]`，就是"只往类型表里登记一笔"）。
    // 例子要它是因为这一门**不做预处理**：头文件里那句 `template <class K, class V> class map;`
    // 得由例子自己写出来，`m["a"]` 才认得出 `m` 是映射。
    case 'namespace': {
      const body = part(x, 'body');
      return body === undefined ? [] : many(kids(body));
    }
    case 'template': return many(kids(x).filter((y) => isList(y) && tag(y) !== 'params'));
    case 'unit': return many(kids(x));
    case 'block': return node('region', { body: many(kids(x)) });
    case 'body': return many(kids(x));

    // ---- 算子 --------------------------------------------------------------
    case 'bin': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'cpp' });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === '!' ? 'not' : leaf(op), toNode(a));
    }
    // `i++` / `++i`：图上就是"加一再赋回去"（不给它开节点 —— 与另外八门同一条）
    case 'post': case 'pre': {
      const [op, t] = kids(x);
      return node('set', {
        value: bin(leaf(op) === '++' ? '+' : '-', toNode(t), lit(1)),
      }, { name: nameOf(t) });
    }
    case 'assign': {
      const [op, t, v] = kids(x);
      const o = leaf(op) === '=' ? null : OPS.get(String(leaf(op)).replace('=', ''));
      if (leaf(op) !== '=' && o === undefined) {
        throw new Error(`cpp->graph: 这个复合赋值还没接：${leaf(op)}`);
      }
      // 左边是一格**字段**（`p.y = 5`）⇒ field-set
      if (tag(t) === 'dot' || tag(t) === 'arrow') {
        const [obj, f] = kids(t);
        const fname = nameOf(f);
        const v2 = o === null ? toNode(v) : bin(o, fieldGet(toNode(obj), fname), toNode(v));
        return fieldSet(toNode(obj), fname, v2);
      }
      // 左边是一格**下标**（`xs[1] = 5`）⇒ index-set（与 go / lua 同一格节点）
      if (tag(t) === 'index') {
        const [obj, idx] = kids(t);
        // `m["a"] = 1`（登记过的映射）⇒ map-set
        if (isMapName(obj)) {
          const cur = () => mapGet(toNode(obj), toNode(idx));
          return mapSet(toNode(obj), toNode(idx), o === null ? toNode(v) : bin(o, cur(), toNode(v)));
        }
        const target = toNode(obj);
        const at = toNode(idx);
        return indexSet(target, at, o === null ? toNode(v) : bin(o, indexGet(toNode(obj), toNode(idx)), toNode(v)));
      }
      const name = nameOf(t);
      const value = o === null ? toNode(v) : bin(o, node('ref', {}, { name }), toNode(v));
      return node('set', { value }, { name });
    }

    // ---- 声明与函数 --------------------------------------------------------
    // `int x = 3, y;` -> 一串 bind（**decl 就是 bind**，没有 decl 节点）
    case 'decl': {
      const specs = part(x, 'specs');
      // `typedef int myint;` —— **图上没有它**。类型是端口的 sort，不是格子（与 go / V 同一条）。
      // 它在语法那侧却很要紧：那一格是驱动器"这名字登记成类型了吗"的登记处。
      if (specs !== undefined && kids(specs).some((s) => !isList(s) && leaf(s) === 'typedef')) return [];
      const initPart = part(x, 'init');
      // `struct Say { … ~Say() {…} };` —— 类**声明**在图上没有格子，可里头的析构体有：
      // 把它提成一格顶层函数（形参 `this`）。名字从声明来，不加节点、不加类型层。
      const dtors = dtorFuncs(specs);
      if (initPart === undefined) return dtors;    // `struct Foo;` / `struct P {…};`
      const rec = structOf(specs);
      // `std::map<std::string, int> m;` -> map-new + bind，并把 `m` 记进 MAPS
      // （下标那两格靠它分流）。**声明就是造**：C++ 里这一行真的构造出一个空映射。
      const mapTpl = mapTemplateOf(specs);
      return [...dtors, ...kids(initPart).filter((d) => tag(d) === 'd').map((d) => {
        const v = part(d, 'init');
        if (mapTpl !== null) {
          const nm = declName(d);
          if (v !== undefined) {
            throw new Error(`cpp->graph: ${mapTpl} 这一批只接"声明出来就是空映射"，${nm} 那格给了初值`);
          }
          MAPS.add(nm);
          return node('bind', { init: mapNew() }, { name: nm });
        }
        // `auto t = std::make_pair(3, 7)` —— **装住整格多值**（`keepMulti` 那格附属），
        // 取用那一侧是 `t.first` / `t.second` -> pick（见 dot 那一格）
        if (v !== undefined && isMakePair(kids(v)[0])) {
          const nm = declName(d);
          PAIRS.add(nm);
          return node('bind', { init: toNode(kids(v)[0]) }, { name: nm, keepMulti: true });
        }
        // `Point p = {1, 2};` —— 记录（字段名从 struct 声明来，见 STRUCTS）。
        // `{…}` 本身在 cpp 里既能填记录也能填列表，所以**看被声明的类型是不是记录**，
        // 不看花括号里长什么样。
        const braces = v !== undefined && isList(kids(v)[0]) && tag(kids(v)[0]) === 'braces'
          ? kids(kids(v)[0]) : null;
        if (rec !== null && braces !== null) {
          const names = STRUCTS.get(rec);
          if (names.length !== braces.length) {
            throw new Error(`cpp->graph: ${rec} 有 ${names.length} 个字段，这儿给了 ${braces.length} 个值`);
          }
          return node('bind', {
            init: recordNew(names.map((nm, i) => [nm, toNode(braces[i])])),
          }, { name: declName(d) });
        }
        // `Say s;` —— 类型登记过、没给初值：造一格记录（字段按 0 起）。C++ 里那几格成员
        // 本来是**未初始化**的（读了是 UB），图上没有"未初始化"这一格值，所以给 0 ——
        // 例子先写后读，绕开那件事；真要对上得有值那一层的"未定"。
        // 类型有 `~T()` -> 顺带挂一格 scope-exit（逆序、早退也跑都是那一格本来的语义）。
        if (rec !== null && v === undefined) {
          const names = STRUCTS.get(rec);
          const name = declName(d);
          const mk = node('bind', {
            init: recordNew(names.map((nm) => [nm, lit(0)])),
          }, { name });
          if (!DTORS.has(rec)) return mk;
          return [mk, node('scope-exit', {
            action: [node('call', {
              fn: node('ref', {}, { name: dtorName(rec) }),
              args: [node('ref', {}, { name })],
            })],
          })];
        }
        return node('bind', {
          init: v === undefined ? lit(null) : toNode(kids(v)[0]),
        }, { name: declName(d) });
      }).flat()];
    }
    case 'func': {
      const fn = part(x, 'fn');
      const name = nameOf(kids(fn).find((y) => tag(y) === 'n' || tag(y) === 'name'));
      const ps = part(fn, 'params');
      const params = ps === undefined ? [] : kids(ps).filter((p) => tag(p) === 'p').map(declName);
      const body = part(x, 'body');
      return node('bind', {
        init: node('func', { body: body === undefined ? [] : many(kids(body)) }, { params, name }),
      }, { name });
    }

    // ---- 控制流 ------------------------------------------------------------
    case 'return': return retOf(kids(x).length === 0 ? [] : [toNode(kids(x)[0])]);
    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'empty': return [];
    case 'if': {
      const [c, then, els] = kids(x);
      return branchOf(truthyLit(toNode(c)), toNode(then), els === undefined ? undefined : toNode(kids(els)[0]));
    }
    case 'while': {
      const [c, body] = kids(x);
      // `while (1)`：字面量的真值观在编译期就定了（见 fromtree.js 的 truthyLit）
      return node('loop', { cond: truthyLit(toNode(c)), body: body === undefined ? [] : [toNode(body)] });
    }
    // `for (init; cond; post) body` -> region + loop（**步进单列一格端口**，continue 也要跑）
    case 'for': {
      const [init, cond, post, body] = kids(x);
      return node('region', {
        body: [
          ...(init === undefined ? [] : many([init])),
          node('loop', {
            cond: cond === undefined ? lit(true) : truthyLit(toNode(cond)),
            body: body === undefined ? [] : [toNode(body)],
            post: post === undefined ? [] : many([post]),
          }),
        ],
      });
    }

    // ---- 调用与打印 --------------------------------------------------------
    case 'call': {
      const [fn, args] = kids(x);
      const argKids = args === undefined ? [] : kids(args);
      // `std::make_pair(a, b)` -> 一格 values（C++ 的双值载体就是它）
      if (isMakePair(x)) return node('values', { args: many(argKids) });
      const callee = isList(fn) && (tag(fn) === 'n' || tag(fn) === 'name') ? nameOf(fn) : null;
      // `m.count("a")` -> map-has（`m` 是登记过的映射）。C++ 里 `count` 回 0/1，
      // 在条件里就是"在不在" —— 与 go 的 comma-ok、V 的 `in`、nim 的 `hasKey`、
      // mojo 的 `in` 同一格节点（八种记号一格 map-has）。
      if (isList(fn) && (tag(fn) === 'dot' || tag(fn) === 'arrow')) {
        const [obj, m] = kids(fn);
        if (isMapName(obj) && nameOf(m) === 'count') {
          if (argKids.length !== 1) throw new Error('cpp->graph: count 那一格要正好一个键');
          return mapHas(toNode(obj), toNode(argKids[0]));
        }
      }
      // `printf("%d\n", x)` -> prim print。**格式串不是节点**：只认那几种，别的报错
      if (callee === 'printf' || callee === 'puts') {
        if (callee === 'puts') return node('prim', { args: many(argKids) }, { name: 'print' });
        const fmt = argKids[0];
        if (fmt === undefined || tag(fmt) !== 'str' || !FORMATS.has(strVal(fmt))) {
          throw new Error('cpp->graph: printf 这一批只认 "%d\\n" / "%s\\n" 那几种格式串');
        }
        return node('prim', { args: many(argKids.slice(1)) }, { name: 'print' });
      }
      return node('call', { fn: toNode(fn), args: many(argKids) });
    }
    default:
      throw new Error(`cpp->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 cpp 的 GLR 树（`(unit 项…)`）-> 一张图。入口是 `main`（末尾补一格调用）。 */
export function cppToGraph(tree) {
  if (tag(tree) !== 'unit') throw new Error('cpp->graph: 这不是 (unit …)');
  // 先扫一遍记录声明（`struct P {…}` 的字段名）—— `{1, 2}` 填记录还是填列表靠它分开
  STRUCTS = new Map();
  DTORS = new Set();        // "哪些类型有 ~T()"那张表也是**一份源码一张**
  PAIRS = new Set();        // "哪些名字装 pair"那张表同理
  MAPS = new Set();         // "哪些名字装映射"同理（声明那一行登记，见 mapTemplateOf）
  collectStructs(kids(tree));
  const body = many(kids(tree));
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 类型全丢；指针 / 引用 / 数组的修饰只从声明符里取名字（`const char* t` 的 `*` 丢掉）。
//   2. `T * x;` 那种"声明还是表达式"**已经不靠猜了** —— 驱动器会回问"这名字登记成类型
//      了吗"（`declares-type` / `needs-type`，见 cpp.grammar 与 driver.js），
//      cpp 那格 `prefer` 删掉了。
//      **这一条原来写着"模板名那一类还欠着，它挡住 map / vector / pair 三样"—— 那句话是错的，
//      这一批量出来作废**：模板名当类型**本来就读得进来**，前提只有一个 —— 那个名字登记过。
//      量出来的（探针）：`namespace std { template <class K, class V> class map; class string; }`
//      之后 `std::map<std::string,int> m; m["a"] = 1; m.count("a")` 整段过。
//      所以那两笔账欠的**不是语法**，是"库里的名字从哪儿来"：这一门不做预处理，头文件里的
//      声明进不来。map 那一族因此**接上了**（例子自己前向声明库名，见 examples/dict.cpp）；
//      `slice` 还欠着 —— C++ 那一侧要的是 `std::span` / 迭代器区间，不是一格下标写法。
//   3. 记录的字段名靠**扫同一份文件里的 struct 声明**（`STRUCTS`）—— 外部头文件里声明的
//      记录扫不到，当场报错。这与 map 那一族"造它的那一步自带标记"是同一条判据。
//   4. class 的成员函数只接**析构**（`~T()` -> 一格顶层函数 + scope-exit，第二十五批）；
//      别的方法 / 构造器 / 模板 / 命名空间 / 运算符重载 / lambda / 异常都不在这一批 ——
//      它们各要一台机器（方法调用、实例化、作用域、闭包、切段）。
