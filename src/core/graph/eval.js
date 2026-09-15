// src/core/graph/eval.js —— **调度器 + eval：默认的解释器就是它**
//
// `docs/design/node-graph-contract.md` §5：ADR-0033 §3.5 说"次序 / 临时量 / 切段 / 释放
// 是算出来的"，`eval` 就是那句话兑现的地方 —— 它只读五栏声明，不看语言。
//
// 这一批做到哪儿（明说，不含糊）：
//   * 求值次序：`value` 边的拓扑序 + 不 pure 的节点按源序（effect 边）。树形的图上
//     它就是"按入端口声明的顺序递归"，所以这一批还看不出重排的收益 —— 那要等 CSE。
//   * 入端口的求值语义：`value` 当场算、`lazy` / `body` 交出一格 thunk（`branch` 的两支、
//     `loop` 的条件与体靠它）。**这一格是 lua 那份规格 L-007 那笔账的正解。**
//   * `may-early-exit` 切段：`ret` 用一格 JS 异常做续延（这一批只有函数边界这一种早退；
//     `suspends` 那台机器还没做，见 §7）。
//   * 释放点：这一批的值全在 JS 堆上（宿主管），所以 `lifetime` 那栏**只检查不使用** ——
//     真用它要等 C 后端（ADR-0036）。这一条现在就写清，免得以后当成"做过了"。

import { declOf } from './nodes.js';
import { primOf } from './prims.js';

/** 早退用的信号。**不是错误** —— 它是"图在这一点切开，后半段不跑"的表示。 */
class Return { constructor(value) { this.value = value; } }

/**
 * 循环的早退（`loop-exit`）。与 `Return` 是同一台机器的两个终点：
 * 一个切到函数出口、一个切到最近那格 `loop`。中间每一格 region 的出口照跑
 * （靠 `finally` —— 与 defer 一族共用那一条）。
 */
class LoopExit { constructor(kind) { this.kind = kind; } }

/** 一格作用域 = 一格 region。`bind` 边（名字 -> 定义）按这条链查，与 ADR-0029 同一件事。 */
class Env {
  /**
   * `region` 那一格：一格名字域 + 一格**出口动作表**（`exits`）。
   * 只有 region / 函数体的 Env 带 exits —— `scope-exit` 往最近的那一格挂。
   */
  constructor(parent = null, { region = false } = {}) {
    this.vars = new Map();
    this.parent = parent;
    this.exits = region ? [] : null;
  }

  /** 往最近的那格 region 挂一段出口动作（注册的那一刻就记下，实参已经算过了）。 */
  onExit(fn) {
    for (let e = this; e !== null; e = e.parent) if (e.exits !== null) { e.exits.push(fn); return; }
    throw new Error('scope-exit 没有宿主 region —— 图上它必须挂在一格域里');
  }

  /** 出口：**逆序**跑（后注册的先跑），而且早退也要经过这儿（所以调用方用 finally）。 */
  runExits() {
    if (this.exits === null) return;
    for (let i = this.exits.length - 1; i >= 0; i--) this.exits[i]();
    this.exits.length = 0;
  }

  define(name, value) { this.vars.set(name, value); }

  lookup(name) {
    for (let e = this; e !== null; e = e.parent) if (e.vars.has(name)) return e.vars.get(name);
    throw new Error(`unbound name: ${name}`);
  }

  assign(name, value) {
    for (let e = this; e !== null; e = e.parent) if (e.vars.has(name)) { e.vars.set(name, value); return; }
    throw new Error(`assign to unbound name: ${name}`);
  }
}

/**
 * **一格多值**（`values` 那一格的出端口）。它不是"一个数组值" —— 是"这一格边上有 N 个值"。
 * 消费者用 `pick` 取第 k 格；只要一格的地方（`print(f())` 那种）取第 0 格。
 */
class Values { constructor(list) { this.list = list; } }

/** 只要一格值的地方：多值收成第一格（lua / go / CL 都是这条规矩）。 */
const one = (v) => (v instanceof Values ? (v.list[0] ?? null) : v);

/** 一格闭包。`func` 的出端口声明了 `owns`，所以它是一格有寿命的值（这一批由宿主管）。 */
class Closure {
  constructor(params, body, env, name) {
    this.params = params; this.body = body; this.env = env; this.name = name;
  }
}

/** 内建那一格（`prim`）。**表在 `prims.js`** —— 一格内建一行，kernel 与效应写在同一行上。 */
function callPrim(name, args, io) {
  return primOf(name).kernel(args, io);
}

/**
 * 真值观 —— **一格能力，不是一格节点**（`ext/lua/SPEC.md` §3.1 第 2 条：
 * lua / awk / go / cpp 四家答案不同）。这一批用"最保守"的那一档：
 * 只有 `false` / `null` / `undefined` 是假。哪门语言要别的答案，由它的映射自己套一格 `prim`。
 */
export function truthy(v) { return !(v === false || v === null || v === undefined); }

export function showValue(v) {
  if (v instanceof Values) return v.list.map(showValue).join(' ');
  // js 后端把多值落成 `{ __vals: […] }`（`carry` 那一问的答案），印法要与 interp 一致
  if (v !== null && typeof v === 'object' && Array.isArray(v.__vals)) return v.__vals.map(showValue).join(' ');
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (v instanceof Closure) return `<fn ${v.name ?? '?'}>`;
  // 一格列表（`list-new` 出来的普通数组）与一格记录（普通对象）—— 两个后端共用这两句
  if (Array.isArray(v)) return `[${v.map(showValue).join(', ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v).map(([k, x]) => `${k} = ${showValue(x)}`).join(', ')}}`;
  }
  return String(v);
}

/**
 * 取多值的第 k 格。**一份实现，两个后端共用** —— `pick` 那格节点与 js 后端里那句
 * `__pick(...)` 走的是这一个函数（内建表那一刀之后，这是第二处"同一份知识只写一遍"）。
 */
export const pick = (v, i) => {
  if (v instanceof Values) return v.list[i] ?? null;
  if (v !== null && typeof v === 'object' && Array.isArray(v.__vals)) return v.__vals[i] ?? null;
  return i === 0 ? v : null;
};

/**
 * **一格记录就是一格普通 JS 对象** —— 两个后端**表示相同**（不是"各自落一种再对齐"）：
 * interp 建的是 `{x: 1}`，js 后端落出来的也是 `({x: 1})`。所以取字段这一句
 * 与 `pick` 一样只写一遍，js 后端里那句 `__field(...)` 走的是这一个函数。
 *
 * 字段不存在时的答案是**语言的事**（lua 给 nil、go 编译期就报）—— 图这一层给最保守的：
 * 没有这一格就当场报，不静默出 undefined。
 */
export const field = (obj, name) => {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    throw new Error(`field-get: 不是一格记录（.${name}）`);
  }
  if (!(name in obj)) throw new Error(`field-get: 没有这一格字段：.${name}`);
  return obj[name];
};

export const setField = (obj, name, value) => {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    throw new Error(`field-set: 不是一格记录（.${name}）`);
  }
  obj[name] = value;
  return null;
};

/**
 * 下标：**图上一律 0 起**（lua 从 1 起那一格差由 lua 的映射减掉）。越界当场报 ——
 * 那是 `index-get` 与 `field-get` 分成两格的理由之一（这一句就是"边界检查"）。
 * 两个后端共用（js 后端里那句 `__index`）。
 */
export const index = (obj, i) => {
  if (!Array.isArray(obj)) throw new Error(`index-get: 不是一格列表（[${showValue(i)}]）`);
  if (typeof i !== 'number' || i < 0 || i >= obj.length) {
    throw new Error(`index-get: 下标越界 [${showValue(i)}]（长度 ${obj.length}）`);
  }
  return obj[i];
};

export const setIndex = (obj, i, value) => {
  if (!Array.isArray(obj)) throw new Error(`index-set: 不是一格列表（[${showValue(i)}]）`);
  if (typeof i !== 'number' || i < 0 || i >= obj.length) {
    throw new Error(`index-set: 下标越界 [${showValue(i)}]（长度 ${obj.length}）`);
  }
  obj[i] = value;
  return null;
};

/**
 * 切片：**一段范围复制成一格新列表**。上界不含、下标 0 起（各语言的差别由映射摆平）。
 * 两个后端共用（js 后端里那句 `__slice`）。
 */
export const sliceOf = (obj, from, to) => {
  if (!Array.isArray(obj)) throw new Error('slice: 不是一格列表');
  const a = from === undefined || from === null ? 0 : Number(from);
  const b = to === undefined || to === null ? obj.length : Number(to);
  if (a < 0 || b > obj.length || a > b) throw new Error(`slice: 范围越界 [${a}, ${b})`);
  return obj.slice(a, b);
};

/**
 * **表示转换**（`conv` 那一格）。目标只有四种：整数 / 实数 / 串 / 真假 ——
 * 具体是 `float64` 还是 `f64` 是那门语言的写法，映射那一侧的名字表管，这儿不认。
 * 两个后端共用（js 后端里那句 `__conv`）。
 *
 * `int` 是**截断**（向零）。这一条要明写：FB 的 `CInt` 是四舍五入、Scheme 的 `exact`
 * 是取有理数 —— 谁要别的答案，由那门语言的映射自己再套一格（与真值观同一条纪律）。
 */
export const convert = (v, to, io) => {
  switch (to) {
    case 'int': return Math.trunc(Number(v));
    case 'float': return Number(v);
    case 'str': return (io?.show ?? showValue)(v);
    case 'bool': return truthy(v);
    default: throw new Error(`conv: 还没接这个目标：${to}`);
  }
};

/** 一格 thunk（`lazy` / `body` 端口交出来的东西）。调度器用它切段与延后求值。 */
const thunk = (x, env, io) => () => run(x, env, io);

function refValue(x, env, io) {
  if (x === null || x === undefined) return null;
  if (Array.isArray(x)) { let last = null; for (const y of x) last = run(y, env, io); return last; }
  if (x.lit !== undefined) return x.lit;
  return run(x, env, io);
}

/** 按声明取一格入端口：`value` 当场算、`lazy`/`body` 交 thunk、`name` 只要名字。 */
function inputOf(n, port, env, io) {
  const x = n.ins[port.name];
  if (x === undefined) return port.sem === 'lazy' || port.sem === 'body' ? null : undefined;
  if (port.sem === 'lazy' || port.sem === 'body') return thunk(x, env, io);
  if (port.rest) {
    const list = Array.isArray(x) ? x : [x];
    // 列表里**只有最后一格展开**（lua 那份规格里的 arity 契约，SDK 的 arity.js 同一条）
    const vals = list.map((y) => refValue(y, env, io));
    return vals.flatMap((v, k) => (v instanceof Values
      ? (k === vals.length - 1 ? v.list : [one(v)])
      : [v]));
  }
  // `multi` 的端口（pick 的来源、ret 的值）与 keepMulti 的 bind 原样收多值；
  // 别的端口"只要一格" ⇒ 多值收成第一格（lua / go / CL 都是这条规矩）
  const raw = port.multi === true || n.attrs?.keepMulti === true;
  return raw ? refValue(x, env, io) : one(refValue(x, env, io));
}

function run(n, env, io) {
  if (n === null || n === undefined) return null;
  if (Array.isArray(n)) { let last = null; for (const y of n) last = run(y, env, io); return last; }
  if (n.lit !== undefined) return n.lit;
  if (n.kind === 'graph') return run(n.body, new Env(env), io);

  const d = declOf(n.op);
  const arg = (name) => {
    const port = d.ins.find((p) => p.name === name);
    return inputOf(n, port, env, io);
  };

  switch (n.op) {
    case 'const': return n.attrs.value;
    case 'ref': return env.lookup(n.attrs.name);
    case 'bind': env.define(n.attrs.name, arg('init')); return null;
    case 'set': env.assign(n.attrs.name, arg('value')); return null;
    case 'prim': return callPrim(n.attrs.name, arg('args') ?? [], io);
    case 'branch': {
      // 两支都是 `lazy` 端口 —— **只算一支**，这就是那一栏求值语义的全部用处。
      const t = arg('then'); const e = arg('else');
      return truthy(arg('cond')) ? (t === null ? null : t()) : (e === null ? null : e());
    }
    case 'loop': {
      const cond = arg('cond'); const body = arg('body'); const post = arg('post');
      let guard = 0;
      while (truthy(cond())) {
        // 这一格是"函数边界之外的 may-early-exit"落地的地方：break 收在这儿、
        // continue 只吃掉本轮剩下的部分。途中每格 region 的出口由那边的 finally 跑。
        let done = false;
        try {
          if (body !== null) body();
        } catch (err) {
          if (!(err instanceof LoopExit)) throw err;
          if (err.kind === 'break') done = true;
        }
        if (done) break;
        if (post !== null) post();      // **continue 也要跑步进**（不然是死循环）
        if (++guard > 10_000_000) throw new Error('loop did not terminate (10M iterations)');
      }
      return null;
    }
    case 'region': {
      const inner = new Env(env, { region: true });   // region 边：一格新的域 + 一格出口表
      try {
        return refValue(n.ins.body, inner, io);
      } finally {
        inner.runExits();               // **早退也跑** —— 这就是 finally 在这儿的全部理由
      }
    }
    case 'scope-exit': {
      // 注册那一刻就把动作记下（`arg('action')` 交出来的是一格 thunk）
      const act = arg('action');
      env.onExit(() => { if (act !== null) act(); });
      return null;
    }
    case 'func': return new Closure(n.attrs.params ?? [], n.ins.body, env, n.attrs.name);
    case 'values': return new Values(arg('args') ?? []);
    case 'pick': return pick(arg('from'), Number(n.attrs.index ?? 0));
    case 'record-new': {
      // 字段名是**附属**（`names`），值是入端口 —— 名字表与值表按位置对上
      const vals = arg('fields') ?? [];
      const rec = {};
      (n.attrs.names ?? []).forEach((k, i) => { rec[k] = vals[i] ?? null; });
      return rec;
    }
    case 'field-get': return field(arg('obj'), n.attrs.field);    case 'field-set': return setField(arg('obj'), n.attrs.field, arg('value'));
    case 'list-new': return arg('items') ?? [];
    case 'index-get': return index(arg('obj'), arg('index'));
    case 'index-set': return setIndex(arg('obj'), arg('index'), arg('value'));
    // 表示转换：目标在附属 `to` 上。**四家的写法不同，落的是同一格**
    case 'conv': return convert(arg('value'), n.attrs.to, io);
    case 'slice': return sliceOf(arg('obj'), arg('from'), arg('to'));
    case 'ret': throw new Return(arg('value') ?? null);
    case 'loop-exit': throw new LoopExit(n.attrs.kind ?? 'break');
    case 'call': {
      const fn = arg('fn');
      const args = arg('args') ?? [];
      if (typeof fn === 'string') return callPrim(fn, args, io);   // 名字直接指到内建
      if (!(fn instanceof Closure)) throw new Error(`not callable: ${showValue(fn)}`);
      const inner = new Env(fn.env, { region: true });   // 函数体也是一格 region
      fn.params.forEach((p, i) => inner.define(p, args[i] ?? null));
      try {
        return refValue(fn.body, inner, io);
      } catch (err) {
        // `may-early-exit` 的切段在这儿收口：后半段（本次调用剩下的部分）不跑
        if (err instanceof Return) return err.value;
        throw err;
      } finally {
        inner.runExits();               // defer 一族：早退（return）之后仍要跑，逆序
      }
    }
    default: throw new Error(`eval: unhandled node ${n.op}`);
  }
}

/**
 * 跑一张图。返回 `{ value, out }` —— `out` 是 `print` 那一格内建写出去的行，
 * **判据就是它**：同一份例子、不同语言的前端，`out` 必须逐行相同（G4 的可跑版本）。
 */
export function evalGraph(g, opts = {}) {
  const io = { out: [], show: showValue, truthy };
  const env = new Env(null, { region: true });
  for (const [k, v] of Object.entries(opts.globals ?? {})) env.define(k, v);
  let value = null;
  try {
    value = run(g, env, io);
  } catch (err) {
    if (err instanceof Return) value = err.value; else throw err;
  }
  return { value, out: io.out };
}
