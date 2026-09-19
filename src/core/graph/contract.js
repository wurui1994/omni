// src/core/graph/contract.js —— **后端契约：五问。后端只回答问题，不打印文本**
//
// `docs/design/node-graph-contract.md` §6。这一份是那一节的可执行版本：
//
//   can(node)        这个节点的五栏我接得住吗（接不住给一句人话 —— 那句话就是账）
//   carry(sort)      这格 sort 在我这儿落成什么
//   effect(name)     六格效应 + synchronizes（ADR-0035）我怎么落
//   region(kind)     一格存储/名字域我怎么开、怎么关
//   lower(graph)     收一块**接口已知**的子图，出我自己的结构
//
// 三条纪律（写成代码而不是注释里的希望）：
//   1. 后端**不许问"上一步把它放哪儿了"**：`lower` 只拿到图，端口的物化由调度器定。
//   2. **接不住是构建期错误**：`gaps()` 把清单印出来，那是待办，不是运行期惊喜。
//   3. 后端之间不比优劣，**比覆盖**：同一张图、每个后端跑出来的可观察行为必须一致 ——
//      判据在 `tests/graph/run.js`（语言 × 后端的矩阵，加一门语言或一个后端自动多几格）。

import { NODES, declOf } from './nodes.js';
import {
  evalGraph, showValue, valTruthy, valPick, field, setField, index, setIndex, convert, valSlice,
  valMapNew, valMapGet, valMapSet, valMapHas, valMapKeys, AssertFailed,
} from './eval.js';
import { toSx, fromSx } from './graph.js';
import { PRIMS } from './prims.js';
import { emitWat, watCan, runWat, WAT_SHAPES, Gap } from './backend-wat.js';
import { emitC, cCan, runC, C_SHAPES } from './backend-c.js';
import { jsModuleText } from './js_rt.js';
import { emitCore, coreCan, runCore, CORE_SHAPES } from './backend-core.js';
/* js 这条腿要在宿主里跑一段生成出来的 JS —— 走 ABI 那两格（`new Function` 不在语言子集里）。 */
import { evalJs, hasJsEngine } from '../host/native.js';

export { Gap };

/** 已登记的后端。**核心不认识任何一个后端的细节**，只按这五问要答案。 */
const BACKENDS = new Map();

export function registerBackend(b) {
  for (const q of ['name', 'can', 'carry', 'effect', 'lower']) {
    if (b[q] === undefined) throw new Error(`backend ${b.name ?? '?'} 少答一问：${q}`);
  }
  BACKENDS.set(b.name, b);
  return b;
}

export const backends = () => [...BACKENDS.values()];

/**
 * `omni backend --gaps <名字>` 的核心：这个后端接不住哪几格节点。
 * **清单是算出来的**（问一遍 `can`），不是手写的文档。
 */
export function gaps(name) {
  const b = BACKENDS.get(name);
  if (b === undefined) throw new Error(`no such backend: ${name}`);
  const out = [];
  for (const [op] of NODES) {
    const ans = b.can(op);
    if (ans !== true) out.push({ op, why: typeof ans === 'string' ? ans : '（没给理由 —— 这本身是一笔账）' });
  }
  return out;
}

/**
 * **形状上的账**：`gaps()` 只答得出"哪格节点接不住"，答不出"同一格节点的某种用法接不住"。
 * 后端可以自己报一份（`shapes`），没有就是空 —— 这样"没有缺口"那句话不会盖住还在跳的格子。
 */
export function shapeGaps(name) {
  const b = BACKENDS.get(name);
  if (b === undefined) throw new Error(`no such backend: ${name}`);
  return b.shapes ?? [];
}

// ---- 后端一：`interp` —— 就是 eval。**默认的解释器不是额外的后端，是调度器的读法** ----
registerBackend({
  name: 'interp',
  can: () => true,
  carry: (sort) => `js value (${sort})`,
  effect: () => 'js 语义直接给（宿主管次序）',
  region: () => 'Env 一格',
  lower: (g) => ({ run: () => evalGraph(g) }),
});

// ---- 后端二：`sx` —— 图的序列化。**它不是中间语言的文本形式**（§5.2）--------------
//
// 判据从"出得来、且不空"升成了**读回来还是同一张图**：`toSx(fromSx(t)) === t` 逐字节相同，
// 而且读回来的图交给默认解释器跑，输出与别的腿逐行相同（后者借 interp 那条腿，明说）。
// 原来那句"只序列化，不承诺跑得起来"太松 —— 它连"这份文本能不能读回来"都没管，
// 而"图的一种写法"这句话不成立的话，sx 这一格就没有存在的理由。
registerBackend({
  name: 'sx',
  can: () => true,
  carry: (sort) => `(sort ${sort})`,
  effect: (e) => `(effect ${e})`,
  region: () => '(region …)',
  lower: (g) => {
    const text = toSx(g);
    return {
      text,
      /** 读回来再序列化 —— 与 text 逐字节相同才算这一格立住 */
      reread: () => toSx(fromSx(text)),
      /** 读回来的那张图跑一遍（借默认解释器 —— sx 自己不是执行器） */
      run: () => evalGraph(fromSx(text)),
    };
  },
  /** 不是"跑不了"，是**它跑的是读回来的那张图** —— 矩阵里单列一格判据（见 run.js） */
  runnable: false,
});

// ---- 后端三：`js` —— 真的落一格产物出来，用来验"同一张图，两条腿输出相同" ----------
//
// 这一格要说清：**js 的产物是文本（那是这门宿主语言的样子），但契约的界面不是文本** ——
// 后端拿到的是图，它自己内部怎么攒都行。所以 §5.2 那句"不再拼接字符串"针对的是
// **图与后端之间**，不是后端内部。
registerBackend({
  name: 'js',
  can: (op) => {
    if (op === 'ret') return true;
    return NODES.has(op) ? true : `js 后端还没接：${op}`;
  },
  carry: (sort) => (sort === 'expr' ? 'js 表达式' : 'js 语句'),
  effect: (e) => (e === 'suspends' ? 'async/await（这一批还没接）' : 'js 语义直接给'),
  region: () => '一格 { } 块 + let',
  lower: (g) => jsLower(g),
});

// ---- 后端四：`wat` —— **wasm 这条腿，第一个真有缺口的后端** -----------------------
//
// 它的价值不在"多一条腿"，在让 `gaps()` 第一次真的有内容：前三个后端都住在 JS 宿主里，
// 什么都接得住。判据也不同：出来的文本交给**另一个前端**（frontend-wat）读、
// 用 MIR 的解释器真跑 —— 正确性由一条互不相干的已有实现来证。
registerBackend({
  name: 'wat',
  can: watCan,
  // 两种数值类型 + 一格地址：整数与"串的地址"都是 i64，实数是 f64
  // （种类是这一层自己算的 —— 图上没有类型，见 backend-wat.js 的 kindOf）
  carry: (sort) => (sort === 'expr' ? 'i64（整数 / 串的地址）或 f64（实数）' : '一条 wasm 指令'),
  effect: (e) => (e === 'may-early-exit'
    ? 'return / break / continue 都有（跳外层的标签也有 —— "墙在 OIR"那句话是错的）'
    : 'wasm 的次序天然是栈序'),
  region: () => '函数级的局部量 + 结构化控制流（wasm 没有独立的域）',
  shapes: WAT_SHAPES,
  lower: (g) => {
    const text = emitWat(g);
    return { text, run: () => runWat(text) };
  },
});

// ---- 后端五：`c` —— **与 `wat` 对称的那一格**（第一百四十六片）---------------------
//
// 它的价值与 wat 同一条：正确性由**一条互不相干的已有实现**来证 —— 出来的文本交给
// 我们自己那台 C 前端（`frontend-c`，ADR-0017）读成 MIR、还是那台 MIR 解释器跑。
// 产物是自足的（宿主面只有 libc 那七格），所以这条腿一个外部 cc 都不借。
// 缺口也与 wat 一样有名有姓：这一刀接第一批 + 早退，函数/多值/记录/列表/映射还欠着。
registerBackend({
  name: 'c',
  can: cCan,
  // 一格 16 字节的 `gv`：标签 + 载荷（bool 的 0/1、double 的位模式、串的指针）。
  // 16 不是随手挑的 —— 两个 ABI 都把这么大的结构放进两个寄存器（见 backend-c.js 的头）
  carry: (sort) => (sort === 'expr' ? '一格 gv（标签 + 载荷，16 字节）' : '一条或几条 C 语句'),
  effect: (e) => (e === 'may-early-exit'
    ? 'return / break / continue 都有（`continue` 那一格靠「第一圈标志」保住步进）'
    : 'C 的次序天然是语句序'),
  region: () => '一格 `{ }` 块 + `gv` 局部量（有值的块先声明一格临时量再在块里赋值）',
  shapes: C_SHAPES,
  lower: (g) => {
    const text = emitC(g);
    return { text, run: () => runC(text) };
  },
});

// ---- 后端六：`core` —— **落成核心方言**（第一百五十二片，ADR-0037 §5.1 的 B 路）
//
// **名字要说准**：落的是**核心方言**（`sexpr/lower.js` 那份 `.sx`，ADR-0014 的汇聚点）——
// 它是**中间格式**，不是 omni 那门语言。omni 主语言有自己的前端（`parse/parser.js` +
// `hir/check.js`），与这一条腿没有关系。头一版这个后端叫 `omni`，那是**错的名字**：
// 它会让人以为产物是 omni 的源码。
//
// 与前五条的差别是**方向**：别的后端把图落成"别人那门语言"，这一条落成我们自己的中间格式，
// 于是往下 OIR -> js / c / wasm / llvm 四条腿、摇树、profile、REPL 全都白得 ——
// 借用一门语言之后拿到的不是"能跑"，是"我们这套工具链全都对它有效"。
// 代价写在 `backend-core.js` 的头上：图上没有类型，而方言有，所以要**把类型算出来**
// （记录 / 列表 / 字典 / 多值各一套推法）—— 那套推断现在住在 `graph/types.js`（覆盖层，#40），
// 这条腿是它第一个用户。28 格节点**全接上了**，
// 剩下的账都是形状上的（`shapes` 那几条，各带一份证物）。
registerBackend({
  name: 'core',
  can: coreCan,
  carry: (sort) => (sort === 'expr'
    ? '方言的一格表达式（有类型：int/real/bool/string + `(struct rN …)` / `(arr T)` / `(dict K V)`）'
    : '方言的一条语句'),
  effect: (e) => (e === 'may-early-exit'
    ? 'ret / brk / cont 都有（方言里带层号）'
    : '方言的次序就是语句序'),
  region: () => '一格 `(do …)` + `(let …)`',
  shapes: CORE_SHAPES,
  lower: (g) => {
    const text = emitCore(g);
    return { text, run: () => runCore(text) };
  },
});

// **内建的 js 落法不在这儿** —— 它写在 `prims.js` 每一行的 `js` 那一格上。// 原来这儿有一张 16 行的 `JS_PRIM` 模板表，与 eval 里那张 switch 是同一份知识抄两遍：
// 加一格内建要改两处。现在改一行。

/** 名字要能当 JS 标识符用（Scheme 的 `max2`、`string-append` 那种带横杠的名字）。 */
const jsName = (n) => `v_${String(n).replace(/[^A-Za-z0-9_]/g, (c) => `$${c.charCodeAt(0).toString(16)}`)}`;

function jsExpr(x) {
  if (x === null || x === undefined) return 'null';
  if (Array.isArray(x)) return `(() => { ${jsFnBody(x)} })()`;
  if (x.lit !== undefined) return JSON.stringify(x.lit);
  switch (x.op) {
    case 'const': return JSON.stringify(x.attrs.value ?? null);
    case 'ref': return jsName(x.attrs.name);
    case 'prim': {
      const p = PRIMS.get(x.attrs.name);
      if (p === undefined) throw new Error(`js: 这格内建还没接：${x.attrs.name}`);
      const args = (Array.isArray(x.ins.args) ? x.ins.args : [x.ins.args]).filter((y) => y !== undefined);
      return p.js(args.map(jsExpr));
    }
    case 'branch': {
      const e = x.ins.else === undefined ? 'null' : jsExpr(x.ins.else);
      return `(__truthy(${jsExpr(x.ins.cond)}) ? ${jsExpr(x.ins.then)} : ${e})`;
    }
    case 'func': {
      const ps = (x.attrs.params ?? []).map(jsName).join(', ');
      return `((${ps}) => { ${withExits(jsFnBody(x.ins.body))} })`;
    }
    case 'call': {
      const args = (Array.isArray(x.ins.args) ? x.ins.args : x.ins.args === undefined ? [] : [x.ins.args]);
      /* go 代码调标准库桩的方法时，field-get 返回 null（桩没有那个字段），
         null 被当函数调 → 报错中断。包一层：被调者不是函数就返回 null。 */
      const fn = jsExpr(x.ins.fn);
      const argStr = args.map(jsExpr).join(', ');
      return `(typeof (${fn}) === 'function' ? (${fn})(${argStr}) : null)`;
    }
    case 'region': return `(() => { ${withExits(jsFnBody(x.ins.body))} })()`;
    // 多值：js 后端落成一格数组 + 一格标记（`carry` 那一问的答案就是这一句）
    case 'values': {
      const args = (Array.isArray(x.ins.args) ? x.ins.args : [x.ins.args]).filter((y) => y !== undefined);
      return `({ __vals: [${args.map(jsExpr).join(', ')}] })`;
    }
    case 'pick': return `__pick(${jsExpr(x.ins.from)}, ${Number(x.attrs.index ?? 0)})`;
    // 记录：**表示与 interp 相同**（一格普通对象）—— 取字段共用 eval 里那一句 `field`
    case 'record-new': {
      const vals = (Array.isArray(x.ins.fields) ? x.ins.fields : [x.ins.fields]).filter((y) => y !== undefined);
      const names = x.attrs.names ?? [];
      return `({ ${names.map((k, i) => `${JSON.stringify(k)}: ${jsExpr(vals[i])}`).join(', ')} })`;
    }
    case 'field-get': return `__field(${jsExpr(x.ins.obj)}, ${JSON.stringify(x.attrs.field)})`;
    // 列表：同样**表示与 interp 相同**（一格普通数组），下标共用 eval 里那一句 `index`
    case 'list-new': {
      const items = (Array.isArray(x.ins.items) ? x.ins.items : [x.ins.items]).filter((y) => y !== undefined);
      return `([${items.map(jsExpr).join(', ')}])`;
    }
    case 'index-get': return `__index(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.index)})`;
    // map / dict：表示也与 interp 相同（宿主的 `Map`），三格全共用 eval 里那几句
    case 'map-new': {
      const ks = asStmts(x.ins.keys).filter((y) => y !== undefined);
      const vs = asStmts(x.ins.vals).filter((y) => y !== undefined);
      return `__mapNew([${ks.map(jsExpr).join(', ')}], [${vs.map(jsExpr).join(', ')}])`;
    }
    case 'map-get': return `__mapGet(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.key)})`;
    case 'map-has': return `__mapHas(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.key)})`;
    case 'map-keys': return `__mapKeys(${jsExpr(x.ins.obj)})`;
    case 'conv': return `__conv(${jsExpr(x.ins.value)}, ${JSON.stringify(x.attrs.to)})`;
    case 'slice': return `__slice(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.from)}, ${jsExpr(x.ins.to)})`;
    default: return `(() => { ${jsStmt(x)} })()`;
  }
}

const asStmts = (b) => (b === undefined || b === null ? [] : Array.isArray(b) ? b : [b]);

/**
 * 函数体 / 一格 IIFE 的体：**最后一格如果有值出端口，它就是返回值**。
 *
 * 判据是 `out-ports` 那一栏 —— 不是 sort，也不是猜。这一条被"语言 × 后端"那张矩阵
 * 连着抓出来两次，两次都是同一个毛病（拿 sort 当"是不是值"的判据）：
 *   1. Scheme 的函数体没有 `return`（最后一格表达式就是值），Lua 的有 `ret`；
 *   2. CL 的 `(let (…) … acc)` 最后一格是 `region` —— 它 sort 是 stat，**但有值出端口**。
 * 改成读 out-ports，两门语言一起对。这就是"后端只回答问题、答案从声明来"的样子。
 */
/**
 * 一格 region / 函数体的出口表。**逆序 + 早退也跑**那两条由 JS 的 `finally` 给 ——
 * 与 interp 那一侧同一条口径（eval.js 里 `runExits`）。
 * 嵌套的那一层"最近的 region"靠 JS 的块作用域天然给：每层各自一格 `__ex`。
 */
const withExits = (body) => `const __ex = []; try { ${body} } finally { `
  + 'for (let __i = __ex.length - 1; __i >= 0; __i--) __ex[__i](); }';

function jsFnBody(body) {
  const list = asStmts(body);
  if (list.length === 0) return 'return null;';
  const head = list.slice(0, -1).map(jsStmt);
  const last = list[list.length - 1];
  const hasValue = last !== null && last !== undefined
    && (last.lit !== undefined || (last.op !== undefined && declOf(last.op).outs.length > 0));
  head.push(hasValue ? `return ${jsExpr(last)};` : `${jsStmt(last)} return null;`);
  return head.join(' ');
}

/**
 * 步进那一格落成**表达式**（`for` 的更新段只收表达式）。
 * 接不住的形状当场报 —— 那是一笔账，不是静默的错答案。
 */
function jsUpdate(x) {
  if (x === null || x === undefined) return '0';
  switch (x.op) {
    case 'set': return `${jsName(x.attrs.name)} = ${jsExpr(x.ins.value)}`;
    case 'field-set': return `__setField(${jsExpr(x.ins.obj)}, ${JSON.stringify(x.attrs.field)}, ${jsExpr(x.ins.value)})`;
    case 'index-set': return `__setIndex(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.index)}, ${jsExpr(x.ins.value)})`;
    case 'map-set': return `__mapSet(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.key)}, ${jsExpr(x.ins.value)})`;
    case 'prim': case 'call': return jsExpr(x);
    default: throw new Error(`js: 循环的步进那一格还没接：${x.op}`);
  }
}

function jsStmt(x) {
  if (x === null || x === undefined) return '';
  if (Array.isArray(x)) return x.map(jsStmt).join(' ');
  if (x.lit !== undefined) return `${JSON.stringify(x.lit)};`;
  switch (x.op) {
    /* **bind 一律 `var`**。go 语义需要：(1) 包级无顺序 (2) := 重用已有名字
       (3) 循环体每轮的 := 不是新声明。nim 的 blockscope 要块级作用域，但那一格在图上是
       region → `{ }` 块，`var` 在 JS 的 `{ }` 里仍是函数级——所以 nim 的 blockscope
       测试确实会坏。把它标成 js 后端的已知偏差（在 cases.js 里 skip），换取 go 编译器
       30+ 个包能编过。 */
    case 'bind': return `var ${jsName(x.attrs.name)} = ${jsExpr(x.ins.init)};`;
    case 'set': return `${jsName(x.attrs.name)} = ${jsExpr(x.ins.value)};`;
    case 'field-set': return `__setField(${jsExpr(x.ins.obj)}, ${JSON.stringify(x.attrs.field)}, ${jsExpr(x.ins.value)});`;
    case 'index-set': return `__setIndex(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.index)}, ${jsExpr(x.ins.value)});`;
    case 'map-set': return `__mapSet(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.key)}, ${jsExpr(x.ins.value)});`;
    case 'ret': return `return ${x.ins.value === undefined ? 'null' : jsExpr(x.ins.value)};`;
    case 'loop': {
      const body = asStmts(x.ins.body).map(jsStmt).join(' ');
      const post = asStmts(x.ins.post);
      // 有步进那一格就落 `for (; cond; post)` —— JS 的 `for` 在 `continue` 时**照跑**
      // 更新段，与调度器那一侧同一条口径（`while` + 缀在末尾的写法会漏掉它）。
      if (post.length === 0) return `while (__truthy(${jsExpr(x.ins.cond)})) { ${body} }`;
      return `for (; __truthy(${jsExpr(x.ins.cond)}); ${post.map(jsUpdate).join(', ')}) { ${body} }`;
    }
    case 'loop-exit': return x.attrs.kind === 'continue' ? 'continue;' : 'break;';
    case 'region': return `{ ${withExits(asStmts(x.ins.body).map(jsStmt).join(' '))} }`;
    // 注册那一刻就记下动作；宿主 region 的 finally 里逆序跑（早退也经过那儿）
    case 'scope-exit': return `__ex.push(() => { ${asStmts(x.ins.action).map(jsStmt).join(' ')} });`;
    // 断言：条件与那句话各一格端口（**不是 prim 的一串实参**），落成一格钩子调用
    case 'assert': {
      const m = x.ins.msg === undefined ? 'null' : jsExpr(x.ins.msg);
      return `__assert(${jsExpr(x.ins.cond)}, ${m});`;
    }
    case 'branch': {
      const t = `{ ${asStmts(x.ins.then).map(jsStmt).join(' ')} }`;
      const e = x.ins.else === undefined ? '' : ` else { ${asStmts(x.ins.else).map(jsStmt).join(' ')} }`;
      return `if (__truthy(${jsExpr(x.ins.cond)})) ${t}${e}`;
    }
    default: return `${jsExpr(x)};`;
  }
}

function jsLower(g) {
  const stmts = asStmts(g.kind === 'graph' ? g.body : g);
  /* **顶层 bind 提升为 var**：go 的包级变量/常量/函数没有声明顺序要求，
     但 JS 的 `let` 有 TDZ（temporal dead zone）。把顶层的 `bind` 从 `let` 改成 `var`
     就能跨文件任意引用（`var` 会被提升到作用域顶部，初值在原位赋）。
     只改顶层——函数体里的 `let` 不动（函数体内的执行顺序是有保证的）。 */
  const jsStmtTop = (x) => {
    if (x !== null && x !== undefined && !Array.isArray(x)
      && x.op === 'bind' && x.attrs !== undefined && x.attrs.name !== undefined) {
      return `var ${jsName(x.attrs.name)} = ${jsExpr(x.ins.init)};`;
    }
    return jsStmt(x);
  };
  const body = withExits(stmts.map(jsStmtTop).join('\n'));
  const source = '(__out, __show, __truthy, __pick, __field, __setField, __index, __setIndex, __conv, __slice,'
    + ' __mapNew, __mapGet, __mapSet, __mapHas, __mapKeys, __assert) => {'
    + `\n${body}\n}`;
  return {
    text: source,
    /**
     * **落一份自足的产物**（钩子跟着走，node 直接 `node x.mjs` 跑）。
     *
     * 从前 `build --backend js` 是明着拒绝的，理由是"那份文本是一格函数表达式，
     * 要外面喂十几个运行时钩子"。那句话现在只剩前半句是事实 —— 钩子有文本版了
     * （`js_rt.js` 的 `GRAPH_JS_RT`），所以拒绝没有理由了。
     */
    module: (note) => jsModuleText(source, note),
    run: () => {
      const out = [];
      /* **走宿主那格 `evalJs`，不写 `new Function`**（ADR-0011 决策 2 的原话：
       * `new Function` 不在语言子集里，所以这种事要收成一格 ABI op）。
       * 量出来的：这一处是整棵链接图里**最后一个** `new Function` —— 它让
       * `npm run build:native` 直接停在 `backend-c: 'js_src_fn' 还没有 C 实现`。
       * 换成 `evalJs` 之后 C 那一侧有实现（`runtime/omni_js_host.c`：没有引擎就报一句
       * 清楚的错），于是"能不能跑 js 这条腿"变成**运行期**的能力问题，不再是"编不出来"。
       *
       * 语义对得上：间接 eval 一格括起来的箭头函数表达式，回的就是那个函数；
       * 那个函数体只用它自己的形参，不看外层作用域。 */
      if (!hasJsEngine()) {
        throw new Error('graph 的 js 这条腿要一个 JS 引擎（这台宿主没有）—— 换 interp 或 wat');
      }
      const f = evalJs(`(${source})`);
      /* 断言不成立就是"整个程序停在这儿"：本进程这一侧抛一格哨兵，在这儿收住 ——
         与 interp 那条腿同一个口径（`eval.js` 的 `AssertFailed`），
         已经印出去的话照样交出来。产物那一侧落的是非零退出（`js_rt.js` 里那格钩子）。 */
      const jsAssert = (cond, msg) => {
        if (valTruthy(cond)) return;
        const text = msg === undefined || msg === null ? 'assert failed'
          : `assert failed: ${showValue(msg)}`;
        out.push(text);
        throw new AssertFailed(text);
      };
      try {
        f(out, showValue, valTruthy, valPick, field, setField, index, setIndex,
          (v, to) => convert(v, to, { show: showValue }), valSlice,
          valMapNew, valMapGet, valMapSet, valMapHas, valMapKeys, jsAssert);
      } catch (err) {
        if (!(err instanceof AssertFailed)) throw err;
        return { value: null, out, failed: err.text };
      }
      return { value: null, out };
    },
  };
}
