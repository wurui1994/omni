// src/core/build/script.js —— 构建描述：**一份 `build.js`**，不是第三门 DSL
//
// 与 zig 的 `build.zig` 同一个念头：描述就是一段普通程序，**我们不限制它做什么** ——
// "只造图、不动磁盘"是**约定**，不是我们拦着。理由：拦不住（脚本能 import 任何东西），
// 而且拦了之后每加一种需求就得给 DSL 开一个口子。约定写在这儿，违约的代价也写在这儿：
//
//   - 只造图的脚本，`omni ninja -n`（不跑）与 `--emit-ninja`（印 manifest）才有意义；
//   - 脚本自己去动磁盘，那部分就在依赖图外面，增量与并行都不管它。
//
// 用法：这份 `Builder` 是**库**，`build.js` 从 `api.js` 拿 `Build`（它继承这儿的动作）
// 自己造图、自己跑 —— 见 `api.js` 的头。这一份只管"怎么造图"与"怎么印成 manifest"。
//
// 名字与语义**与 `.ninja` 一一对应**（rule / build / pool / default / 三种输入），
// 所以 `b` 造出来的图与吃一份 manifest 造出来的图是同一种东西 —— 一层引擎，两种入口。

import { State, Rule, Pool, EvalString, BindingEnv } from './graph.js';
import { canonicalizePath } from './manifest.js';

/** 把 `$var` 那样的模板串拆成片段（与 manifest 里同一套语义，少了转义那几格）。 */
function template(s) {
  /** @type {Array<[string,string]>} */
  const parts = [];
  let lit = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '$') {
      const d = s[i + 1] ?? '';
      if (d === '$') { lit += '$'; i += 2; continue; }
      let j = i + 1;
      let name = '';
      if (d === '{') {
        const end = s.indexOf('}', i + 2);
        if (end === -1) throw new Error(`build.js: '\${' 没有收口：${s}`);
        name = s.slice(i + 2, end);
        j = end + 1;
      } else {
        while (j < s.length && /[a-zA-Z0-9_.\-/]/.test(s[j])) j++;
        name = s.slice(i + 1, j);
      }
      if (name === '') throw new Error(`build.js: '$' 后面没有名字：${s}`);
      if (lit !== '') { parts.push(['lit', lit]); lit = ''; }
      parts.push(['var', name]);
      i = j;
      continue;
    }
    lit += c;
    i++;
  }
  if (lit !== '') parts.push(['lit', lit]);
  return new EvalString(parts);
}

const asList = (x) => (x === undefined || x === null ? [] : (Array.isArray(x) ? x : [x]));

/** 传给 `build.js` 的那个 `b`。**只有这几个动作** —— 与 `.ninja` 的语句一一对应。 */
export class Builder {
  constructor(state) {
    /* 两行而不是 `??`：惰性位置上的临时量我们自己那台编译器不收（它让你抬成语句）。 */
    let st = state;
    if (st === undefined || st === null) st = new State();
    this.state = st;
  }

  /** 全局变量（`cflags = -O2`）。 */
  set(name, value) {
    this.state.bindings.addBinding(name, String(value));
    return this;
  }

  /** 一条命令模板。`opts` 的键与 `.ninja` 的 rule 绑定同名。 */
  rule(name, opts) {
    const r = new Rule(name);
    if (opts === undefined || opts.command === undefined) {
      throw new Error(`build.js: rule '${name}' 少了 command`);
    }
    for (const k of Object.keys(opts)) {
      r.bindings.set(k, template(String(opts[k])));
    }
    this.state.bindings.addRule(r);
    return this;
  }

  pool(name, depth) {
    this.state.addPool(new Pool(name, depth));
    return this;
  }

  /**
   * 一格任务。
   * @param {string|string[]} outs 显式输出
   * @param {string} ruleName
   * @param {string|string[]} ins 显式输入
   * @param {{implicit?, orderOnly?, validations?, implicitOuts?, vars?, pool?}} [opts]
   */
  build(outs, ruleName, ins, opts) {
    const o = opts ?? {};
    const rule = this.state.bindings.lookupRule(ruleName);
    if (rule === null) throw new Error(`build.js: 没有 rule '${ruleName}'`);
    const env = new BindingEnv(this.state.bindings);
    for (const [k, v] of Object.entries(o.vars ?? {})) env.addBinding(k, String(v));
    if (o.pool !== undefined) env.addBinding('pool', String(o.pool));
    const edge = this.state.addEdge(rule, env);
    const st = this.state;
    const explicit = asList(ins).map(canonicalizePath);
    const implicit = asList(o.implicit).map(canonicalizePath);
    const orderOnly = asList(o.orderOnly).map(canonicalizePath);
    for (const p of explicit) st.addIn(edge, p);
    for (const p of implicit) st.addIn(edge, p);
    for (const p of orderOnly) st.addIn(edge, p);
    edge.implicitDeps = implicit.length;
    edge.orderOnlyDeps = orderOnly.length;
    const eo = asList(outs).map(canonicalizePath);
    const io = asList(o.implicitOuts).map(canonicalizePath);
    for (const p of eo) st.addOut(edge, p);
    for (const p of io) st.addOut(edge, p);
    edge.implicitOuts = io.length;
    for (const p of asList(o.validations).map(canonicalizePath)) st.addValidation(edge, p);
    const poolName = o.pool ?? (rule.binding('pool') === null ? ''
      : rule.binding('pool').evaluate(this.state.bindings));
    if (poolName !== '' && poolName !== undefined) {
      const pool = st.pool(String(poolName));
      if (pool === null) throw new Error(`build.js: 没有 pool '${poolName}'`);
      edge.pool = pool;
    }
    return edge;
  }

  /** `phony`：给一串依赖起个名字（`omni ninja test` 那种目标就是它）。 */
  phony(name, deps) {
    return this.build(name, 'phony', asList(deps), {});
  }

  default_(...targets) {
    for (const t of targets.flat()) {
      const n = this.state.node(canonicalizePath(t), false);
      if (n === null) throw new Error(`build.js: default 说的 '${t}' 没有谁造它`);
      this.state.defaults.push(n);
    }
    return this;
  }
}

/* `default` 是保留字，所以上面那个方法叫 `default_`；这儿补一个同义词，
   让脚本里能写 `b.default('app')`（读起来与 manifest 一致）。 */
Builder.prototype.default = Builder.prototype.default_;

/**
 * 把图印成一份 `.ninja`（单向桥：我们的描述 → 生态的格式，不回头）。
 * 印出来的那份喂给真 ninja 必须跑出同一批命令 —— 那是这一格的判据。
 */
export function toNinja(state) {
  const out = ['# 由 omni 生成（build.js -> manifest）'];
  for (const [name, v] of state.bindings.bindings) out.push(`${name} = ${v}`);
  for (const pool of state.pools.values()) {
    if (pool.name === '' || pool.name === 'console') continue;
    out.push('', `pool ${pool.name}`, `  depth = ${pool.depth}`);
  }
  const seen = new Set();
  for (const e of state.edges) {
    const r = e.rule;
    if (r === null || r.name === 'phony' || seen.has(r.name)) continue;
    seen.add(r.name);
    out.push('', `rule ${r.name}`);
    for (const [k, v] of r.bindings) out.push(`  ${k} = ${ninjaEscape(v)}`);
  }
  out.push('');
  for (const e of state.edges) {
    const eo = e.explicitOutputs().map((n) => esc(n.path)).join(' ');
    const io = e.outputs.slice(e.outputs.length - e.implicitOuts).map((n) => esc(n.path));
    const ins = e.explicitInputs().map((n) => esc(n.path)).join(' ');
    const imp = [];
    const ord = [];
    for (let i = 0; i < e.inputs.length; i++) {
      if (e.isOrderOnlyIndex(i)) ord.push(esc(e.inputs[i].path));
      else if (e.isImplicitIndex(i)) imp.push(esc(e.inputs[i].path));
    }
    let line = `build ${eo}`;
    if (io.length > 0) line += ` | ${io.join(' ')}`;
    line += `: ${e.rule.name}`;
    if (ins !== '') line += ` ${ins}`;
    if (imp.length > 0) line += ` | ${imp.join(' ')}`;
    if (ord.length > 0) line += ` || ${ord.join(' ')}`;
    if (e.validations.length > 0) line += ` |@ ${e.validations.map((n) => esc(n.path)).join(' ')}`;
    out.push(line);
    for (const [k, v] of e.env.bindings) out.push(`  ${k} = ${v}`);
  }
  if (state.defaults.length > 0) {
    out.push('', `default ${state.defaults.map((n) => esc(n.path)).join(' ')}`);
  }
  return `${out.join('\n')}\n`;
}

/** 路径里的空格与冒号要按 manifest 的规矩转义。 */
const esc = (p) => p.replace(/([ :$])/g, '$$$1');

/** rule 的模板印回去：`['var', x]` → `$x`。 */
function ninjaEscape(es) {
  let s = '';
  for (const [k, v] of es.parts) s += k === 'lit' ? v : `\${${v}}`;
  return s;
}
