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
  evalGraph, showValue, truthy, pick, field, setField, index, setIndex,
} from './eval.js';
import { toSx } from './graph.js';
import { PRIMS } from './prims.js';
import { emitWat, watCan, runWat, Gap } from './backend-wat.js';

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
registerBackend({
  name: 'sx',
  can: () => true,
  carry: (sort) => `(sort ${sort})`,
  effect: (e) => `(effect ${e})`,
  region: () => '(region …)',
  lower: (g) => ({ text: toSx(g), run: () => ({ value: null, out: [] }) }),
  /** 只序列化，不承诺跑得起来 —— 所以它在测试矩阵里只对"文本稳定"负责。 */
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
  carry: (sort) => (sort === 'expr' ? 'i64 值（这一批只有整数）' : '一条 wasm 指令'),
  effect: (e) => (e === 'may-early-exit'
    ? 'return 有、带标签的 break 没有（墙在 OIR）'
    : 'wasm 的次序天然是栈序'),
  region: () => '函数级的局部量 + 结构化控制流（wasm 没有独立的域）',
  lower: (g) => {
    const text = emitWat(g);
    return { text, run: () => runWat(text) };
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
      return `${jsExpr(x.ins.fn)}(${args.map(jsExpr).join(', ')})`;
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
    case 'prim': case 'call': return jsExpr(x);
    default: throw new Error(`js: 循环的步进那一格还没接：${x.op}`);
  }
}

function jsStmt(x) {
  if (x === null || x === undefined) return '';
  if (Array.isArray(x)) return x.map(jsStmt).join(' ');
  if (x.lit !== undefined) return `${JSON.stringify(x.lit)};`;
  switch (x.op) {
    case 'bind': return `let ${jsName(x.attrs.name)} = ${jsExpr(x.ins.init)};`;
    case 'set': return `${jsName(x.attrs.name)} = ${jsExpr(x.ins.value)};`;
    case 'field-set': return `__setField(${jsExpr(x.ins.obj)}, ${JSON.stringify(x.attrs.field)}, ${jsExpr(x.ins.value)});`;
    case 'index-set': return `__setIndex(${jsExpr(x.ins.obj)}, ${jsExpr(x.ins.index)}, ${jsExpr(x.ins.value)});`;
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
    case 'branch': {
      const t = `{ ${asStmts(x.ins.then).map(jsStmt).join(' ')} }`;
      const e = x.ins.else === undefined ? '' : ` else { ${asStmts(x.ins.else).map(jsStmt).join(' ')} }`;
      return `if (__truthy(${jsExpr(x.ins.cond)})) ${t}${e}`;
    }
    default: return `${jsExpr(x)};`;
  }
}

function jsLower(g) {
  const body = withExits(asStmts(g.kind === 'graph' ? g.body : g).map(jsStmt).join('\n'));
  const source = '(__out, __show, __truthy, __pick, __field, __setField, __index, __setIndex) => {'
    + `\n${body}\n}`;
  return {
    text: source,
    run: () => {
      const out = [];
      // eslint-disable-next-line no-new-func
      const f = new Function(`return ${source};`)();
      f(out, showValue, truthy, pick, field, setField, index, setIndex);
      return { value: null, out };
    },
  };
}
