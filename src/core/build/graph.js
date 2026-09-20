// src/core/build/graph.js —— 构建图的两类顶点：**工件（Node）与任务（Edge）**
//
// 照 ninja 的模型重写（`reference/ninja/src/graph.h:43` 的 Node、`:180` 的 Edge）。
// 为什么照它：这套模型十年生产验证过，而且它的不变量正好是我们要的那两条 ——
// **图是 DAG**、**依赖解析是确定的**（`docs/design/build-system.md` 第 0 节的约束 2）。
//
// 这一层**不认识语言**，也不认识 omni：它只知道"文件 → 命令 → 文件"。语言知识住在
// 中层的规则生成里。分工的理由写在那份设计文档第 3 节。
//
// 与 ninja 刻意不同的两处：
//   1. 环**当场报整条路径**（`cycleOf`），格式与 `module/load.js:175` 那句一致 ——
//      ninja 只说一句 "dependency cycle"，那在一张几千格的图上等于没说。
//   2. **没有 weak 这一格**：缺输入是错误，且要说清"谁要它"（哪条边）。

/** 工件的存在状态。mtime 的三种取值在 `Node` 上说清。 */
export const EXIST_UNKNOWN = 0;
export const EXIST_MISSING = 1;
export const EXIST_YES = 2;

/** 查环用的 DFS 三色（ninja 的 `Edge::VisitMark`）。 */
export const VISIT_NONE = 0;
export const VISIT_IN_STACK = 1;
export const VISIT_DONE = 2;

/**
 * 一格工件。多数是文件，也可以是 `phony` 的一个名字（那时它没有内容，只有次序意义）。
 *
 * `mtime` 三态，一格都不能省：
 *   -1  还没看过（没 stat）
 *    0  看过了，不存在
 *   >0  真的 mtime；**如果它是 phony**，则是它依赖里最新的那个 mtime
 */
export class Node {
  constructor(path) {
    this.path = path;
    this.mtime = -1;
    this.exists = EXIST_UNKNOWN;
    /** 输出比输入旧、或者命令变了 —— 由 `plan.js` 的脏判定填 */
    this.dirty = false;
    /** 造出它的那条边（源文件没有） */
    this.inEdge = null;
    /** 把它当输入的那些边 */
    this.outEdges = [];
    /** 把它当 validation（`|@`）的那些边 */
    this.validationOutEdges = [];
    /** `.omni_deps` 那份日志里的稠密 id */
    this.id = -1;
    /** 从 depfile / deps 日志里冒出来的节点：缺了不算错（它不是声明的源文件） */
    this.fromDepLoader = true;
  }

  statusKnown() { return this.exists !== EXIST_UNKNOWN; }
  existsOnDisk() { return this.exists === EXIST_YES; }

  /** 看过了、不存在。mtime 留着 0（不是 -1）—— "看过"与"没看过"必须分得开。 */
  markMissing() {
    if (this.mtime === -1) this.mtime = 0;
    this.exists = EXIST_MISSING;
  }

  /** 重新当作"没看过"（`omni build` 在一趟里可能要重算两遍，dyndep 那条路要它）。 */
  resetState() {
    this.mtime = -1;
    this.exists = EXIST_UNKNOWN;
    this.dirty = false;
  }
}

/**
 * 一格命令模板。`bindings` 的值是 `EvalString`（片段序列），不是已经拼好的字符串 ——
 * 因为同一条 rule 会被许多条边用，每条边的 `$in` / `$out` 不同。
 */
export class Rule {
  constructor(name) {
    this.name = name;
    /** @type {Map<string, EvalString>} */
    this.bindings = new Map();
  }

  binding(key) { return this.bindings.get(key) ?? null; }
}

/**
 * 一格并发预算。ninja 用它限制吃内存的任务（链接）与独占终端的任务（`console`）。
 * `depth === 0` = 不限（ninja 里 `console` 池的 depth 是 1，默认池是 0）。
 */
export class Pool {
  constructor(name, depth) {
    this.name = name;
    this.depth = depth;
    this.currentUse = 0;
    /** 池满时攒着的边（按边 id 排序取出，保证次序确定） */
    this.delayed = [];
  }

  /** 还能不能再塞一条。`depth 0` 永远能。 */
  hasRoom() { return this.depth === 0 || this.currentUse < this.depth; }
}

/** 默认池（不限）与 console 池（独占终端）。 */
export const DEFAULT_POOL = new Pool('', 0);
export const CONSOLE_POOL = new Pool('console', 1);

/**
 * 一格任务。输入分三种、输出分两种，**次序编码在数组里**（照 ninja：省一个 Map，
 * 而且遍历顺序天然稳定）：
 *
 *   inputs  = [显式…, 隐式…, 仅次序…]     两个计数分别记后两段的长度
 *   outputs = [显式…, 隐式…]              一个计数记后一段的长度
 *
 * 三种输入的区别是**语义**，不是风格：
 *   显式（`$in`）      变了要重建
 *   隐式（`|`）        不进 `$in`，变了要重建 —— 头文件、语法表、编译器自己
 *   仅次序（`||`）     必须先做完，但它变了**不**触发重建 —— 建目录、代码生成器
 */
export class Edge {
  constructor(rule, env, id) {
    this.rule = rule;
    this.env = env;
    this.id = id;
    this.pool = DEFAULT_POOL;
    /** @type {Node[]} */
    this.inputs = [];
    /** @type {Node[]} */
    this.outputs = [];
    /** @type {Node[]} */
    this.validations = [];
    this.implicitDeps = 0;
    this.orderOnlyDeps = 0;
    this.implicitOuts = 0;
    this.outputsReady = false;
    this.depsLoaded = false;
    this.mark = VISIT_NONE;
    /** 关键路径权重：调度时大的先跑（`plan.js` 算） */
    this.criticalPathWeight = -1;
  }

  /** 显式输入的段（`$in` 就是它们）。 */
  explicitInputs() {
    return this.inputs.slice(0, this.inputs.length - this.implicitDeps - this.orderOnlyDeps);
  }

  /** 仅次序那一段。 */
  orderOnlyInputs() {
    return this.orderOnlyDeps === 0 ? [] : this.inputs.slice(this.inputs.length - this.orderOnlyDeps);
  }

  /** 显式输出的段（`$out` 就是它们）。 */
  explicitOutputs() {
    return this.outputs.slice(0, this.outputs.length - this.implicitOuts);
  }

  isPhony() { return this.rule !== null && this.rule.name === 'phony'; }
  useConsole() { return this.pool === CONSOLE_POOL; }

  /** 输入全都就绪了吗（造它们的边都跑完了）。源文件没有 inEdge，天然就绪。 */
  allInputsReady() {
    for (const n of this.inputs) {
      if (n.inEdge !== null && !n.inEdge.outputsReady) return false;
    }
    return true;
  }

  /** 求一格绑定（含 `$in` / `$out` 这些内建）。空串表示没有。 */
  binding(key) { return edgeEval(this, key, false); }

  /** 命令行。`$in` / `$out` 在这儿按 shell 规矩转义。 */
  command() { return edgeEval(this, 'command', true); }

  /** 不转义的那几格（depfile / rspfile / dyndep 是**文件名**，不是命令片段）。 */
  rawBinding(key) { return edgeEval(this, key, false); }
}

/**
 * `EvalString`：**字面量片段与变量引用的序列**，不是字符串。
 *
 * 为什么不直接存字符串：一条 rule 的 `command` 里的 `$in` 要按**每条边**求值，
 * 而 `$cflags` 可能在全局、rule、边三层各有一份 —— 求值时机不同，所以解析期只能存结构。
 * 形状与 ninja 的 `eval_env.h` 一致：`[['lit', s], ['var', name], …]`。
 */
export class EvalString {
  constructor(parts) {
    /** @type {Array<[string, string]>} */
    this.parts = parts ?? [];
  }

  static lit(s) { return new EvalString([['lit', s]]); }

  isEmpty() { return this.parts.length === 0; }

  /** 拿它引用到的变量名（`omni build -t vars` 这类工具要） */
  vars() {
    const out = [];
    for (const [k, v] of this.parts) if (k === 'var') out.push(v);
    return out;
  }

  /** 按一格作用域求值。`env.lookup(name)` 回字符串。 */
  evaluate(env) {
    let s = '';
    for (const [k, v] of this.parts) s += k === 'lit' ? v : env.lookup(v);
    return s;
  }
}

/**
 * 一层变量作用域。链是 全局 → subninja → rule → 边，**边级最强**。
 *
 * `rules` 只住在全局与 subninja 那两层（ninja 里 rule 不能嵌套定义）。
 */
export class BindingEnv {
  constructor(parent) {
    this.parent = parent ?? null;
    /** @type {Map<string, string>} */
    this.bindings = new Map();
    /** @type {Map<string, Rule>} */
    this.rules = new Map();
  }

  lookup(name) {
    const v = this.bindings.get(name);
    if (v !== undefined) return v;
    return this.parent === null ? '' : this.parent.lookup(name);
  }

  addBinding(name, value) { this.bindings.set(name, value); }

  addRule(rule) {
    if (this.lookupRule(rule.name) !== null) {
      throw new Error(`build: rule '${rule.name}' 定义了两次`);
    }
    this.rules.set(rule.name, rule);
  }

  lookupRule(name) {
    const r = this.rules.get(name);
    if (r !== undefined) return r;
    return this.parent === null ? null : this.parent.lookupRule(name);
  }
}

/** shell 转义：只在**真的需要**时加引号（照 ninja 的 `GetShellEscapedString`）。 */
export function shellEscape(s) {
  if (s === '') return "''";
  if (!/[^A-Za-z0-9,./:=@_+^-]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** 一串路径拼成命令里的样子（空格分隔，各自按需转义）。 */
function pathList(nodes, escape, sep) {
  const out = [];
  for (const n of nodes) out.push(escape ? shellEscape(n.path) : n.path);
  return out.join(sep);
}

/**
 * 边级求值：`$in` / `$out` / `$in_newline` 是**算出来的**，别的名字往上找
 * （边自己的绑定 → rule → 全局）。
 *
 * 这一格是 ninja `Edge::EvaluateCommand` 那套"两层 env"的等价物：rule 里的
 * `$cflags` 要能被某一条边自己的 `cflags` 盖掉，而 rule 里的 `$in` 永远是这条边的输入。
 */
function edgeEval(edge, key, escape) {
  const rule = edge.rule;
  if (rule === null) return '';
  const tmpl = rule.binding(key);
  /* 边自己写了同名绑定就用它（`build a: cc b` 底下缩进那几行） */
  const own = edge.env instanceof BindingEnv ? edge.env.bindings.get(key) : undefined;
  if (tmpl === null && own === undefined) return '';
  const env = new EdgeEnv(edge, escape);
  if (own !== undefined) return own;
  return tmpl.evaluate(env);
}

/** 求 rule 模板时用的作用域：先答内建，再问这条边的 env。 */
class EdgeEnv {
  constructor(edge, escape) {
    this.edge = edge;
    this.escape = escape;
    /** 防自引用（`cflags = $cflags -O2` 在 ninja 里是错误，不是无限递归） */
    this.lookups = new Set();
  }

  lookup(name) {
    const e = this.edge;
    if (name === 'in') return pathList(e.explicitInputs(), this.escape, ' ');
    if (name === 'in_newline') return pathList(e.explicitInputs(), this.escape, '\n');
    if (name === 'out') return pathList(e.explicitOutputs(), this.escape, ' ');
    if (this.lookups.has(name)) {
      throw new Error(`build: 变量 '${name}' 自己引用自己（rule ${e.rule.name}）`);
    }
    /* 边级绑定优先，然后 rule 级（rule 级要在这一层继续展开），最后往上找 */
    const own = e.env.bindings.get(name);
    if (own !== undefined) return own;
    const fromRule = e.rule.binding(name);
    if (fromRule !== null) {
      this.lookups.add(name);
      const s = fromRule.evaluate(this);
      this.lookups.delete(name);
      return s;
    }
    return e.env.lookup(name);
  }
}

/**
 * 整张图。`paths` 是**唯一那份**路径 → Node 的表：同一个路径必须是同一格 Node，
 * 不然"谁依赖谁"就散了。
 */
export class State {
  constructor() {
    /** @type {Map<string, Node>} */
    this.paths = new Map();
    /** @type {Edge[]} */
    this.edges = [];
    /** @type {Map<string, Pool>} */
    this.pools = new Map([['', DEFAULT_POOL], ['console', CONSOLE_POOL]]);
    this.bindings = new BindingEnv(null);
    /** @type {Node[]} `default` 行指定的目标 */
    this.defaults = [];
    /* `phony` 是内建 rule：它没有命令，只把一个名字接到一串依赖上。 */
    const phony = new Rule('phony');
    this.bindings.addRule(phony);
  }

  node(path, create) {
    const hit = this.paths.get(path);
    if (hit !== undefined) return hit;
    if (create === false) return null;
    const n = new Node(path);
    this.paths.set(path, n);
    return n;
  }

  /** 造一条边。id 按造出来的次序给 —— 调度里"同权重按 id"靠它保证次序确定。 */
  addEdge(rule, env) {
    const e = new Edge(rule, env, this.edges.length);
    this.edges.push(e);
    return e;
  }

  addIn(edge, path) {
    const n = this.node(path, true);
    edge.inputs.push(n);
    n.outEdges.push(edge);
  }

  addValidation(edge, path) {
    const n = this.node(path, true);
    edge.validations.push(n);
    n.validationOutEdges.push(edge);
  }

  /**
   * 给边挂一格输出。**一格工件只能有一条边造它** —— 这是"解析确定"的一半
   * （另一半是无环）。ninja 这儿只报一句 "multiple rules generate"，我们连
   * 两边的命令一起报，因为多数时候是规则生成那一层重复发了同一条边。
   */
  addOut(edge, path) {
    const n = this.node(path, true);
    if (n.inEdge !== null) {
      throw new Error(`build: 两条边都要造 '${path}'\n    一条：${describeEdge(n.inEdge)}\n    另一条：${describeEdge(edge)}`);
    }
    edge.outputs.push(n);
    n.inEdge = edge;
    return true;
  }

  pool(name) { return this.pools.get(name) ?? null; }

  addPool(pool) {
    if (this.pools.has(pool.name)) throw new Error(`build: pool '${pool.name}' 定义了两次`);
    this.pools.set(pool.name, pool);
  }

  /** 没写 `default` 时的目标：**没有入边的那些叶子**（照 ninja 的 root nodes）。 */
  rootNodes() {
    const out = [];
    for (const e of this.edges) {
      for (const n of e.outputs) if (n.outEdges.length === 0 && n.validationOutEdges.length === 0) out.push(n);
    }
    return out;
  }

  defaultTargets() {
    return this.defaults.length > 0 ? this.defaults.slice() : this.rootNodes();
  }
}

/** 一条边印成一行（报错与 `-t commands` 都用它）。 */
export function describeEdge(edge) {
  const outs = edge.outputs.map((n) => n.path).join(' ');
  const ins = edge.inputs.map((n) => n.path).join(' ');
  return `${edge.rule === null ? '?' : edge.rule.name}: ${outs} <- ${ins}`;
}

/**
 * **查环**（约束 2 的另一半）。从一格目标出发 DFS，用边上的三色标记：
 * 踩到还在栈上的边就是环。回 `null` 表示无环，否则回**整条路径**（节点路径的数组，
 * 首尾是同一格）。
 *
 * 为什么报整条路径而不是一句话：一张几千格的图上，"dependency cycle" 等于没说。
 * 这与 `module/load.js:175` 报 import 环的规矩一致 —— 同一个仓库里同一件事只有一种报法。
 */
export function cycleOf(state, targets) {
  for (const e of state.edges) e.mark = VISIT_NONE;
  /** @type {string[]} 当前 DFS 栈上的输出路径，用来还原环 */
  const stack = [];
  const walk = (node) => {
    const edge = node.inEdge;
    if (edge === null) return null;
    if (edge.mark === VISIT_DONE) return null;
    if (edge.mark === VISIT_IN_STACK) {
      /* 从栈里那一格开始截，末尾补上自己 —— 这就是环 */
      const at = stack.indexOf(node.path);
      return stack.slice(at === -1 ? 0 : at).concat([node.path]);
    }
    edge.mark = VISIT_IN_STACK;
    stack.push(node.path);
    for (const inp of edge.inputs) {
      const cyc = walk(inp);
      if (cyc !== null) return cyc;
    }
    stack.pop();
    edge.mark = VISIT_DONE;
    return null;
  };
  for (const t of targets) {
    const cyc = walk(t);
    if (cyc !== null) return cyc;
  }
  return null;
}

/** 有环就抛一句人话（带整条路径，一行一格）。 */
export function assertAcyclic(state, targets) {
  const cyc = cycleOf(state, targets);
  if (cyc === null) return;
  throw new Error(`build: 依赖成环：\n    ${cyc.join('\n -> ')}`);
}
