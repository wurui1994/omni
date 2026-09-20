// src/core/build/manifest.js —— 吃 `.ninja`（照 `reference/ninja/src/manifest_parser.cc`）
//
// 为什么要完整吃这个格式：CMake / Meson / gn 都能生成它。支持它等于**我们能被现成的项目
// 当后端用**，也等于我们有一把外面的尺子 —— 同一份 manifest，与真 ninja 比
// "跑了哪些命令、什么次序、第二次跑几条"（`docs/design/build-system.md` 第 7 节）。
//
// 语法一共六种语句，没有第七种：
//
//   变量绑定     name = value
//   rule NAME    后面跟缩进的绑定（command / description / depfile / deps / …）
//   build 行     build OUTS | IMPLICIT_OUTS : RULE INS | IMPLICIT || ORDER_ONLY |@ VALID
//   default      default TARGETS
//   pool NAME    缩进里一个 depth
//   include / subninja   读另一份（**subninja 开新作用域**，include 不开）
//
// 两处容易写错、这儿写明的语义：
//   - **build 行上的边级绑定在文件作用域里求值**（ninja manifest_parser.cc:328），
//     所以那儿写 `$in` 不会展开成输入 —— `$in` 只在 rule 的模板里有意义。
//   - 求值时机：路径与边级绑定**解析时就求**；rule 的模板**留到每条边**才求。

import { Rule, Pool, EvalString, BindingEnv, State } from './graph.js';
import { Lexer, T } from './lexer.js';

/** `a/./b//c/../d` → `a/b/d`。同一个文件必须只有一格 Node，所以路径先规整。 */
export function canonicalizePath(p) {
  if (p === '') return p;
  const abs = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') { out.pop(); continue; }
    out.push(seg);
  }
  const s = out.join('/');
  if (abs) return `/${s}`;
  return s === '' ? '.' : s;
}

/**
 * 解析一份 manifest 到 `state` 上。
 *
 * @param {State} state
 * @param {string} text
 * @param {string} filename 报错用
 * @param {{ readFile?: (path: string) => string, env?: BindingEnv }} [opts]
 *        `readFile` 给 include / subninja 用；不给就把这两句当错误（判据里的最小用法）。
 */
export function parseManifest(state, text, filename, opts) {
  const p = new Parser(state, text, filename, opts ?? {});
  p.parse();
  return state;
}

class Parser {
  constructor(state, text, filename, opts) {
    this.state = state;
    this.lex = new Lexer(text, filename);
    this.opts = opts;
    this.env = opts.env ?? state.bindings;
    /** 回推一格记号（`build` 行与缩进块都要"看一眼下一个是什么"） */
    this.pending = null;
    this.pendingPos = 0;
  }

  next() {
    if (this.pending !== null) {
      const t = this.pending;
      this.pending = null;
      return t;
    }
    return this.lex.next();
  }

  /** 看一眼但不吃掉。 */
  peekTok() {
    if (this.pending === null) {
      this.pendingPos = this.lex.pos;
      this.pending = this.lex.next();
    }
    return this.pending;
  }

  expect(kind, what) {
    const t = this.next();
    if (t.t !== kind) throw this.lex.errorAt(`要 ${what ?? kind}，看到的是 ${t.t}`);
    return t;
  }

  /**
   * 要一格**名字**。关键字也算（`pool = heavy`、`build = x` 里那些）——
   * 一个词是关键字还是名字，由**位置**定，不由词本身定。
   */
  expectName(what) {
    const t = this.next();
    if (typeof t.value !== 'string') throw this.lex.errorAt(`要 ${what}，看到的是 ${t.t}`);
    return t.value;
  }

  parse() {
    for (;;) {
      const t = this.next();
      if (t.t === T.EOF) return;
      if (t.t === T.NEWLINE) continue;
      if (t.t === T.POOL) { this.parsePool(); continue; }
      if (t.t === T.RULE) { this.parseRule(); continue; }
      if (t.t === T.BUILD) { this.parseEdge(); continue; }
      if (t.t === T.DEFAULT) { this.parseDefault(); continue; }
      if (t.t === T.INCLUDE || t.t === T.SUBNINJA) { this.parseInclude(t.t === T.SUBNINJA); continue; }
      if (t.t === T.IDENT) {
        const [name, value] = this.parseBinding(t.value);
        this.env.addBinding(name, value.evaluate(this.env));
        continue;
      }
      throw this.lex.errorAt(`这儿不能是 ${t.t}`);
    }
  }

  /** `name = value`（值是 EvalString，**还没求值**）。 */
  parseBinding(name) {
    this.expect(T.EQUALS, "'='");
    const parts = this.lex.readVarValue();
    /* 值读到行尾，所以这儿要把那个换行吃掉 */
    const t = this.next();
    if (t.t !== T.NEWLINE && t.t !== T.EOF) throw this.lex.errorAt(`值后面多了 ${t.t}`);
    return [name, new EvalString(parts)];
  }

  /** 缩进块：一串 `key = value`，回一个 Map（值仍是 EvalString）。 */
  parseIndentedBindings() {
    const out = new Map();
    for (;;) {
      if (this.peekTok().t !== T.INDENT) return out;
      this.next();
      const name0 = this.expectName('一个名字');
      const [name, value] = this.parseBinding(name0);
      out.set(name, value);
    }
  }

  parsePool() {
    const name = this.expectName('pool 的名字');
    this.expect(T.NEWLINE, '换行');
    const binds = this.parseIndentedBindings();
    const depthEs = binds.get('depth');
    if (depthEs === undefined) throw this.lex.errorAt(`pool '${name}' 少了 depth`);
    const depth = Number(depthEs.evaluate(this.env));
    if (!Number.isInteger(depth) || depth < 0) {
      throw this.lex.errorAt(`pool '${name}' 的 depth 要是非负整数`);
    }
    for (const k of binds.keys()) {
      if (k !== 'depth') throw this.lex.errorAt(`pool 里不认识 '${k}'`);
    }
    this.state.addPool(new Pool(name, depth));
  }

  parseRule() {
    const name = this.expectName('rule 的名字');
    this.expect(T.NEWLINE, '换行');
    if (this.env.lookupRule(name) !== null) throw this.lex.errorAt(`rule '${name}' 定义了两次`);
    const rule = new Rule(name);
    /* rule 的绑定**不在这儿求值** —— 它们要按每条边求（`$in`/`$out` 那一格）。 */
    const ALLOWED = new Set(['command', 'depfile', 'dyndep', 'description', 'deps',
      'generator', 'pool', 'restat', 'rspfile', 'rspfile_content', 'msvc_deps_prefix']);
    for (const [k, v] of this.parseIndentedBindings()) {
      if (!ALLOWED.has(k)) throw this.lex.errorAt(`rule 里不认识 '${k}'`);
      rule.bindings.set(k, v);
    }
    if (rule.binding('rspfile') === null !== (rule.binding('rspfile_content') === null)) {
      throw this.lex.errorAt('rspfile 与 rspfile_content 要么都有、要么都没有');
    }
    if (rule.binding('command') === null) throw this.lex.errorAt(`rule '${name}' 少了 command`);
    this.env.addRule(rule);
  }

  parseDefault() {
    let n = 0;
    for (;;) {
      const parts = this.lex.readPath();
      if (parts === null) break;
      const path = canonicalizePath(new EvalString(parts).evaluate(this.env));
      const node = this.state.node(path, false);
      if (node === null) throw this.lex.errorAt(`default 说的 '${path}' 没有谁造它`);
      this.state.defaults.push(node);
      n++;
    }
    if (n === 0) throw this.lex.errorAt('default 后面要跟至少一个目标');
    const t = this.next();
    if (t.t !== T.NEWLINE && t.t !== T.EOF) throw this.lex.errorAt(`default 后面多了 ${t.t}`);
  }

  parseInclude(newScope) {
    const parts = this.lex.readPath();
    if (parts === null) throw this.lex.errorAt('include / subninja 要一个文件名');
    const path = new EvalString(parts).evaluate(this.env);
    const t = this.next();
    if (t.t !== T.NEWLINE && t.t !== T.EOF) throw this.lex.errorAt(`文件名后面多了 ${t.t}`);
    const readFile = this.opts.readFile;
    if (readFile === undefined) throw this.lex.errorAt('这一趟没给 readFile，读不了别的 manifest');
    /* **subninja 开新作用域**（父是当前那层），include 不开 —— 这是两者唯一的区别。
       写成两行而不是一个三元：我们自己那台编译器不收"惰性位置上的临时量"，它会指出来
       让你抬成语句（ARC 记账那条规矩）。这份文件要过 `check:self`，所以照它说的写。 */
    let env = this.env;
    if (newScope) env = new BindingEnv(this.env);
    parseManifest(this.state, readFile(path), path, { readFile, env });
  }

  /** 读一串路径，直到遇上 `:` `|` `||` `|@` 或换行。回规整过的字符串数组。 */
  readPaths() {
    const out = [];
    for (;;) {
      const parts = this.lex.readPath();
      if (parts === null) return out;
      out.push(canonicalizePath(new EvalString(parts).evaluate(this.env)));
    }
  }

  /**
   * `build OUTS | IMPLICIT_OUTS : RULE INS | IMPLICIT || ORDER_ONLY |@ VALIDATIONS`
   *
   * 三种输入在 `inputs` 里是**接着排**的（显式、隐式、仅次序），两个计数记后两段的长度；
   * 两种输出同理。次序即语义，所以这儿的 push 顺序不能动。
   */
  parseEdge() {
    const outs = this.readPaths();
    let implicitOuts = [];
    if (this.peekTok().t === T.PIPE) {
      this.next();
      implicitOuts = this.readPaths();
    }
    if (outs.length === 0 && implicitOuts.length === 0) {
      throw this.lex.errorAt('build 行上一个输出都没有');
    }
    this.expect(T.COLON, "':'");
    const ruleName = this.expectName('rule 的名字');
    const rule = this.env.lookupRule(ruleName);
    if (rule === null) throw this.lex.errorAt(`没有 rule '${ruleName}'`);

    const ins = this.readPaths();
    let implicitIns = [];
    let orderOnly = [];
    let validations = [];
    for (;;) {
      const t = this.peekTok().t;
      if (t === T.PIPE) { this.next(); implicitIns = this.readPaths(); continue; }
      if (t === T.PIPE2) { this.next(); orderOnly = this.readPaths(); continue; }
      if (t === T.PIPEAT) { this.next(); validations = this.readPaths(); continue; }
      break;
    }
    const nl = this.next();
    if (nl.t !== T.NEWLINE && nl.t !== T.EOF) throw this.lex.errorAt(`build 行后面多了 ${nl.t}`);

    /* 边级绑定：**在文件作用域里求值**（ninja manifest_parser.cc:328）——
       所以这儿写 `$in` 不会展开成输入，那是 rule 模板才有的东西。 */
    const edgeEnv = new BindingEnv(this.env);
    for (const [k, v] of this.parseIndentedBindings()) {
      edgeEnv.addBinding(k, v.evaluate(this.env));
    }

    const st = this.state;
    const edge = st.addEdge(rule, edgeEnv);
    for (const p of ins) st.addIn(edge, p);
    for (const p of implicitIns) st.addIn(edge, p);
    for (const p of orderOnly) st.addIn(edge, p);
    edge.implicitDeps = implicitIns.length;
    edge.orderOnlyDeps = orderOnly.length;
    for (const p of outs) st.addOut(edge, p);
    for (const p of implicitOuts) st.addOut(edge, p);
    edge.implicitOuts = implicitOuts.length;
    for (const p of validations) st.addValidation(edge, p);

    /* 池：边级绑定优先，然后 rule 上那一格。 */
    const poolName = edgeEnv.bindings.get('pool') ?? (rule.binding('pool') === null ? ''
      : rule.binding('pool').evaluate(this.env));
    if (poolName !== '') {
      const pool = st.pool(poolName);
      if (pool === null) throw this.lex.errorAt(`没有 pool '${poolName}'`);
      edge.pool = pool;
    }
    return edge;
  }
}
