// Omni stage0 — 名字解析 / 类型检查 / 重载与 UFCS 解析，输出 OIR
//
// OIR v0：typed + 已解析（所有隐式转换显式化、所有调用绑定到具体函数）的结构化 IR。
// 刻意还不是 SSA —— SSA 构造、dialect 分层留到 P2，等 C 后端跑通、需要做优化 pass 时再上。
// 约束：后端只允许消费 OIR，不许回看 AST；OIR 里不许出现任何只对某个后端成立的语义。

import {
  BUILTINS, INT, REAL, BOOL, STRING, VOID, DYNAMIC, NULLT,
  structType, classType, listType, dictType, setType, fnType,
  typeName, typeKey, same, isNumeric, isRef, isHashable, castCost, commonType, zeroValue,
} from './types.js';

const PRINTABLE = new Set(['int', 'real', 'bool', 'string']);

class Scope {
  constructor(parent) {
    this.parent = parent;
    /** @type {Map<string, {name: string, type: any}>} */
    this.vars = new Map();
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      const v = s.vars.get(name);
      if (v) return v;
    }
    return null;
  }

  declare(name, type) {
    const v = { name, type };
    this.vars.set(name, v);
    return v;
  }
}

class Checker {
  /**
   * @param {import('../source/diag.js').Diagnostics} diags
   * @param {'mixed'|'dynamic'|'static'} mode 缺省类型注解的处理方式（ADR-0008）
   */
  constructor(diags, mode = 'mixed') {
    this.diags = diags;
    /** 整程序缺省模式；每个 decl 自带的 `mode`（来自它所在文件的后缀）会覆盖它 */
    this.defaultMode = mode;
    this.mode = mode;
    /** @type {Map<number, Set<number>>} 模块 id -> 它直接导入的模块 id（ADR-0009） */
    this.imports = new Map();
    /** 当前正在检查哪个模块的代码；决定私有名字是否可见 */
    this.curMod = 0;
    /** @type {Map<string, any>} 类型名 -> 类型 */
    this.types = new Map(Object.entries(BUILTINS));
    /** @type {Map<string, any[]>} 函数名 -> 重载组 */
    this.funcs = new Map();
    /** @type {any[]} */
    this.structs = [];
    /** @type {any[]} */
    this.classes = [];
    this.scope = new Scope(null);
    this.loopDepth = 0;
    this.currentRet = VOID;
    /** @type {Set<string>} 已用的 mangled 名，防撞 */
    this.mangled = new Set();
    /** @type {Map<string, any>} 用到的容器类型实例化（typeKey -> type），供后端生成代码 */
    this.containers = new Map();
    /** 当前正在检查的 class（方法体内裸名可解析到字段） */
    this.thisType = null;
    /**
     * 函数作用域变量的提升表（ADR-0008）：`var` 与裸赋值声明的变量收集到这里，
     * 在函数顶部统一声明，语句原地退化成赋值。
     * @type {{name: string, type: any}[] | null}
     */
    this.hoist = null;
    /** @type {Scope | null} 当前函数的根作用域，`var` 与裸赋值绑定在这里 */
    this.fnScope = null;
    /**
     * lambda（ADR-0010）。每个 lambda 被提升成一个顶层函数 + 一份闭包记录：
     *  - `lifted`   提升出来的 OIR 函数，最后并进 funcs
     *  - `closures` 闭包记录的布局（捕获了哪些名字、哪些类型）
     *  - `fnTypes`  用到的函数值签名，C 后端要为每个签名发一个类型化的调用助手
     *  - `frames`   正在检查的 lambda 栈，名字查找靠它决定"这是捕获还是外面的变量"
     */
    this.lifted = [];
    this.closures = [];
    this.fnTypes = new Map();
    this.frames = [];
    /** @type {Map<string, any>} 具名函数 -> 它的适配器闭包节点（同一个函数只包一次） */
    this.adapters = new Map();
  }

  /** 进入一个函数体：重置提升表与函数根作用域 */
  enterFunction() {
    this.scope = new Scope(null);
    this.fnScope = this.scope;
    this.hoist = [];
  }

  /** 离开函数体：把提升的声明前置到语句列表最前面 */
  exitFunction(body) {
    const decls = this.hoist.map((h) => ({
      kind: 'Local', name: h.name, type: h.type, init: zeroValue(h.type),
    }));
    this.hoist = null;
    this.fnScope = null;
    return decls.length ? { kind: 'Block', stmts: [...decls, ...body.stmts] } : body;
  }

  // ------------------------------------------------------- 函数值 / lambda（ADR-0010）

  /**
   * lambda 字面量。做法是**提升成顶层函数 + 一份闭包记录**，而不是给后端一个"嵌套函数"节点：
   * C 没有嵌套函数，把这层降级放在检查器里，两个后端就都只看见普通函数。
   *
   * 捕获**按值**：闭包创建的那一刻把值拷进记录。JS 的词法闭包是按引用的，所以这里绝不能
   * 依赖宿主的作用域，必须显式把捕获写进记录 —— 否则 C 与 JS 会在"循环变量被闭包捕获"
   * 这种经典场景上给出不同答案。
   */
  lambda(node) {
    const params = node.params.map((p) => ({ name: p.name, type: this.resolveType(p.type) }));
    const ret = this.resolveType(node.retType);
    const type = this.useType(fnType(params.map((p) => p.type), ret));
    const seen = new Set();
    for (const p of params) {
      if (seen.has(p.name)) this.err(node.span, `duplicate parameter '${p.name}' in lambda`);
      seen.add(p.name);
    }

    const frame = { outerScope: this.scope, captures: new Map() };
    const saved = {
      scope: this.scope,
      fnScope: this.fnScope,
      hoist: this.hoist,
      ret: this.currentRet,
      loopDepth: this.loopDepth,
    };
    this.frames.push(frame);
    this.enterFunction();
    this.currentRet = ret;
    this.loopDepth = 0; // break / continue 不能穿过 lambda 边界
    for (const p of params) this.scope.declare(p.name, p.type);
    const body = this.exitFunction(this.block(node.body));
    this.frames.pop();
    this.scope = saved.scope;
    this.fnScope = saved.fnScope;
    this.hoist = saved.hoist;
    this.currentRet = saved.ret;
    this.loopDepth = saved.loopDepth;

    const captures = [...frame.captures.values()];
    return this.addClosure(`lambda#${this.closures.length}`, { ret, params, body }, captures, type);
  }

  /** 登记一个闭包（lambda 或具名函数的适配器），返回创建它的 OIR 节点 */
  addClosure(name, fn, captures, type) {
    const id = this.closures.length;
    const mangled = `omni_clo_${id}`;
    const make = `omni_mk_${id}`;
    this.closures.push({ id, mangled, make, captures: captures.map((c) => ({ name: c.name, type: c.type })) });
    this.lifted.push({ name, mangled, ret: fn.ret, params: fn.params, body: fn.body, closureId: id });
    return { kind: 'MakeClosure', closure: id, make, args: captures.map((c) => c.value), type };
  }

  /**
   * 在 lambda 里引用外层的名字。逐层往外找，**每一层都登记一次捕获**：内层的值来自外层的
   * 捕获槽，而不是直接跨层读外面的栈 —— 外层函数早就返回了，跨层读会读到已经失效的帧。
   */
  captureRef(name) {
    const find = (depth) => {
      const frame = this.frames[depth];
      const outer = frame.outerScope.lookup(name);
      const src = outer
        ? { kind: 'VarRef', name: outer.name, type: outer.type }
        : (depth > 0 ? find(depth - 1) : null);
      if (!src) return null;
      if (!frame.captures.has(name)) frame.captures.set(name, { name, type: src.type, value: src });
      return { kind: 'CaptureRef', name, type: src.type };
    };
    return this.frames.length ? find(this.frames.length - 1) : null;
  }

  /** 变量查找的唯一入口：先看本函数的作用域，再看外层（触发捕获） */
  lookupValue(name) {
    const v = this.scope.lookup(name);
    if (v) return { kind: 'VarRef', name: v.name, type: v.type };
    return this.captureRef(name);
  }

  /** 具名函数当值用。有多个重载时必须有期望类型来定案，否则报错让用户写 lambda。 */
  funcValue(name, group, expected, span) {
    const sig = (sym) => fnType(sym.params.map((p) => p.type), sym.ret);
    let sym = null;
    if (expected?.k === 'fn') sym = group.find((s) => same(sig(s), expected)) ?? null;
    else if (group.length === 1) sym = group[0];
    if (!sym) {
      const why = expected?.k === 'fn'
        ? `no overload of '${name}' has type '${typeName(expected)}'`
        : `'${name}' has ${group.length} overloads, so using it as a value is ambiguous`;
      this.err(span, `${why}; wrap the one you mean in a lambda, e.g. 'fn(int x) -> int { return ${name}(x); }'`);
      return { kind: 'Const', type: INT, value: 0n };
    }
    return this.funcRef(sym);
  }

  /**
   * 具名函数 -> 函数值。生成一个薄适配器（形参照抄、转手调用），让**所有**函数值共用
   * 同一套调用约定（第一个参数是闭包记录自己）。代价是一次多余的调用，换来的是调用处
   * 不需要区分"这是 lambda 还是具名函数"。
   */
  funcRef(sym) {
    const type = this.useType(fnType(sym.params.map((p) => p.type), sym.ret));
    const cached = this.adapters.get(sym.mangled);
    if (cached) return { ...cached, args: [] };
    const params = sym.params.map((p, i) => ({ name: `a${i}`, type: p.type }));
    const call = {
      kind: 'Call',
      func: sym.mangled,
      name: sym.name,
      args: params.map((p) => ({ kind: 'VarRef', name: p.name, type: p.type })),
      type: sym.ret,
    };
    const body = {
      kind: 'Block',
      stmts: [sym.ret.k === 'void' ? { kind: 'ExprStmt', expr: call } : { kind: 'Return', value: call }],
    };
    const node = this.addClosure(`&${sym.name}`, { ret: sym.ret, params, body }, [], type);
    this.adapters.set(sym.mangled, node);
    return node;
  }

  /** 调用一个函数值。函数值没有参数名，所以命名实参与默认值在这里都不存在。 */
  callFnValue(callee, args, span) {
    const t = callee.type;
    if (args.some((a) => a.name !== null)) {
      this.err(span, 'a function value has no parameter names, so named arguments cannot be used here');
    }
    if (args.length !== t.params.length) {
      this.err(span, `'${typeName(t)}' takes ${t.params.length} argument(s), got ${args.length}`);
      return zeroValue(t.ret) ?? { kind: 'Const', type: INT, value: 0n };
    }
    this.useType(t);
    return {
      kind: 'CallFn',
      callee,
      fnType: t,
      args: args.map((a, i) => this.coerce(a.expr, t.params[i], a.span)),
      type: t.ret,
    };
  }

  err(span, msg) {
    this.diags.error(span, msg);
  }

  /**
   * 登记容器实例化。除了元素类型自身，dict/set 还要顺带登记 `list<键>`：
   * `keys()` / `items()` 返回它，C 后端的宏展开无条件引用它。
   */
  useType(t) {
    if (!t) return t;
    switch (t.k) {
      case 'list': this.useType(t.elem); break;
      case 'dict': this.useType(t.key); this.useType(t.val); this.useType(listType(t.key)); break;
      case 'set': this.useType(t.elem); this.useType(listType(t.elem)); break;
      case 'fn': {
        for (const p of t.params) this.useType(p);
        this.useType(t.ret);
        const fk = typeKey(t);
        if (!this.fnTypes.has(fk)) this.fnTypes.set(fk, t);
        return t;
      }
      default: return t;
    }
    const key = typeKey(t);
    if (!this.containers.has(key)) this.containers.set(key, t);
    return t;
  }

  /** dynamic 的运行期分派操作（ADR-0008 第 5 节的封闭清单） */
  dynOp(name, args, type) {
    this.useType(this.dynListType());
    this.useType(dictType(STRING, DYNAMIC));
    return { kind: 'Builtin', name, args, recvType: DYNAMIC, type };
  }

  dynListType() { return listType(DYNAMIC); }

  resolveType(ref) {
    if (ref.kind === 'FnType') {
      const params = ref.params.map((p) => this.resolveType(p));
      for (const [i, p] of params.entries()) {
        if (p.k === 'void') this.err(ref.params[i].span, 'function parameter type cannot be void');
      }
      return this.useType(fnType(params, this.resolveType(ref.ret)));
    }
    if (ref.kind === 'GenericType') {
      const args = ref.args.map((a) => this.resolveType(a));
      switch (ref.name) {
        case 'list':
          if (args[0].k === 'void') this.err(ref.span, 'list element type cannot be void');
          return this.useType(listType(args[0]));
        case 'set':
          if (!isHashable(args[0])) {
            this.err(ref.span, `set element type must be int/real/bool/string, found '${typeName(args[0])}'`);
            return this.useType(setType(STRING));
          }
          return this.useType(setType(args[0]));
        case 'dict':
          if (!isHashable(args[0])) {
            this.err(ref.span, `dict key type must be int/real/bool/string, found '${typeName(args[0])}'`);
            return this.useType(dictType(STRING, args[1]));
          }
          if (args[1].k === 'void') this.err(ref.span, 'dict value type cannot be void');
          return this.useType(dictType(args[0], args[1]));
        default:
          this.err(ref.span, `unknown generic type '${ref.name}'`);
          return INT;
      }
    }
    const t = this.types.get(ref.name);
    if (!t || !this.visible(t)) {
      this.err(ref.span, `unknown type '${ref.name}'`);
      return INT;
    }
    return t;
  }

  // ------------------------------------------------------- 模块可见性（ADR-0009）

  /**
   * 一个顶层名字对当前模块可见，当且仅当：它就在本模块里，或者本模块**直接**导入了
   * 它所在的模块且它没被 `private` 挡住。
   *
   * 传递性刻意没有：A 导入 B、B 导入 C，A 看不见 C 的名字。否则 B 换个实现依赖就会
   * 悄悄改变 A 能用的名字集合，而 A 的源码里根本没提到 C。
   */
  visible(sym) {
    if (sym.mod === undefined || sym.mod === this.curMod) return true;
    if (sym.isPrivate) return false;
    return this.imports.get(this.curMod)?.has(sym.mod) ?? false;
  }

  /** 名字查找的唯一入口：不可见的候选当作不存在，于是错误文本和"没定义"一致 —— 别人的私有名字不该出现在诊断里 */
  lookupFuncs(name) {
    const group = this.funcs.get(name);
    if (!group) return undefined;
    const vis = group.filter((s) => this.visible(s));
    return vis.length ? vis : undefined;
  }

  // ---------------------------------------------------------------- 顶层

  /** @param {any} program */
  run(program) {
    this.imports = program.imports ?? new Map();
    // 每个 decl 自带所属模块与所在文件的模式；`at` 在检查它之前把这两个"当前上下文"摆好
    const at = (d) => {
      this.curMod = d.mod ?? 0;
      this.mode = d.mode ?? this.defaultMode;
    };

    // pass 1：struct / class 名先占位，允许字段互相前向引用
    const aggs = program.decls.filter((d) => d.kind === 'StructDecl' || d.kind === 'ClassDecl');
    for (const d of aggs) {
      if (this.types.has(d.name)) this.err(d.span, `redefinition of type '${d.name}'`);
      const t = d.kind === 'StructDecl' ? structType(d.name, []) : classType(d.name, []);
      t.mod = d.mod ?? 0;
      t.isPrivate = d.isPrivate === true;
      this.types.set(d.name, t);
    }
    for (const d of aggs) {
      at(d);
      const t = this.types.get(d.name);
      const seen = new Set();
      for (const f of d.fields) {
        if (seen.has(f.name)) this.err(f.span, `duplicate field '${f.name}' in ${t.k} '${d.name}'`);
        seen.add(f.name);
        const ft = this.resolveType(f.type);
        if (ft.k === 'void') this.err(f.type.span, 'field cannot have type void');
        t.fields.push({ name: f.name, type: ft });
      }
      if (t.k === 'struct') this.structs.push(t);
      else this.classes.push(t);
    }

    // pass 2：函数签名。**class 方法在这里被降级成第一参数为 this 的自由函数，
    // 并注册进同一张全局重载表** —— ADR-0006 第 5 节：方法与自由函数是同一件事，
    // 于是 UFCS、扩展方法、"函数自动挂钩" 都落在同一套重载解析上。
    const decls = [];
    for (const d of program.decls) if (d.kind === 'FuncDecl') decls.push({ decl: d, owner: null });
    for (const d of aggs) {
      if (d.kind !== 'ClassDecl') continue;
      // 方法跟着它的 class 走：模块归属与可见性都取 class 的（方法没有单独的 private）
      for (const m of d.methods ?? []) {
        m.mod = d.mod;
        m.mode = d.mode;
        m.isPrivate = d.isPrivate;
        decls.push({ decl: m, owner: this.types.get(d.name) });
      }
    }

    for (const { decl, owner } of decls) {
      at(decl);
      const ret = this.resolveType(decl.retType);
      const declared = decl.params.map((p) => ({
        name: p.name,
        type: this.resolveType(p.type),
        defAst: p.def,
        def: null,
      }));
      const params = owner
        ? [{ name: 'this', type: owner, defAst: null, def: null }, ...declared]
        : declared;
      const group = this.funcs.get(decl.name) ?? [];
      for (const prev of group) {
        if (prev.params.length !== params.length) continue;
        if (!prev.params.every((p, i) => same(p.type, params[i].type))) continue;
        // 两个模块各自的 private 同名同签名函数不冲突 —— 谁也看不见谁
        const clash = prev.mod === (decl.mod ?? 0) || !(prev.isPrivate || decl.isPrivate);
        if (clash) this.err(decl.span, `redefinition of '${decl.name}' with the same parameter types`);
      }
      const base = owner ? `${owner.name}_${decl.name}` : decl.name;
      const sym = {
        name: decl.name, mangled: this.mangle(base), ret, params, ast: decl, owner,
        mod: decl.mod ?? 0, isPrivate: decl.isPrivate === true, mode: decl.mode ?? this.defaultMode,
      };
      group.push(sym);
      this.funcs.set(decl.name, group);
    }

    // pass 3：默认实参（在空作用域里求值，只允许常量表达式的简单形式）
    for (const group of this.funcs.values()) {
      for (const sym of group) {
        at(sym);
        for (const p of sym.params) {
          if (!p.defAst) continue;
          p.def = this.coerce(this.expr(p.defAst, { expected: p.type }), p.type, p.defAst.span);
        }
      }
    }

    // pass 4：函数体
    const funcs = [];
    for (const group of this.funcs.values()) {
      for (const sym of group) {
        at(sym);
        this.enterFunction();
        this.currentRet = sym.ret;
        this.thisType = sym.owner;
        for (const p of sym.params) this.scope.declare(p.name, p.type);
        const body = this.exitFunction(this.block(sym.ast.body));
        funcs.push({
          name: sym.name,
          mangled: sym.mangled,
          ret: sym.ret,
          params: sym.params.map((p) => ({ name: p.name, type: p.type })),
          body,
        });
      }
    }
    this.thisType = null;

    // pass 5：顶层语句 -> 合成 main
    this.enterFunction();
    this.currentRet = VOID;
    const mainStmts = [];
    for (const d of program.decls) {
      if (d.kind === 'StructDecl' || d.kind === 'ClassDecl' || d.kind === 'FuncDecl') continue;
      at(d);
      const s = this.stmt(d);
      if (s) mainStmts.push(s);
    }
    funcs.push({
      name: 'main', mangled: 'omni_main', ret: VOID, params: [],
      body: this.exitFunction({ kind: 'Block', stmts: mainStmts }),
    });

    return {
      structs: this.structs,
      classes: this.classes,
      containers: sortedContainers(this.containers),
      // lambda 提升出来的函数排在最后：它们是编译器合成的，放在用户函数之后便于阅读生成物
      funcs: [...funcs, ...this.lifted],
      closures: this.closures,
      fnTypes: [...this.fnTypes.keys()].sort().map((k) => this.fnTypes.get(k)),
      entry: 'omni_main',
    };
  }

  mangle(name) {
    let m = `u_${name}`;
    let i = 2;
    while (this.mangled.has(m)) m = `u_${name}__${i++}`;
    this.mangled.add(m);
    return m;
  }

  // ---------------------------------------------------------------- 语句

  block(node) {
    const saved = this.scope;
    this.scope = new Scope(saved);
    const stmts = [];
    for (const s of node.stmts) {
      const lowered = this.stmt(s);
      if (lowered) stmts.push(lowered);
    }
    this.scope = saved;
    return { kind: 'Block', stmts };
  }

  stmt(node) {
    switch (node.kind) {
      case 'Block': return this.block(node);
      case 'VarDecl': return this.varDecl(node);
      case 'ExprStmt': {
        // Python 形态：给未声明的裸名赋值就是声明它（函数作用域），等价于 `var`（ADR-0008 第 2 节）
        const bare = this.bareDeclName(node.expr);
        if (bare) {
          if (this.mode === 'static') {
            this.err(node.expr.target.span, `'${bare}' is not declared; this file's static mode requires an explicit type (or use 'let'/'var' in a '.omni' file)`);
          }
          return this.inferredVarDecl({
            kind: 'VarDecl',
            type: null,
            form: 'var',
            decls: [{ name: bare, init: node.expr.value, span: node.expr.target.span }],
          });
        }
        return { kind: 'ExprStmt', expr: this.expr(node.expr, { stmtCtx: true }) };
      }
      case 'If': {
        const cond = this.condition(node.cond);
        return {
          kind: 'If',
          cond,
          then: this.stmtAsBlock(node.then),
          otherwise: node.otherwise ? this.stmtAsBlock(node.otherwise) : null,
        };
      }
      case 'While': {
        const cond = this.condition(node.cond);
        this.loopDepth++;
        const body = this.stmtAsBlock(node.body);
        this.loopDepth--;
        return { kind: 'While', cond, body };
      }
      case 'For': {
        const saved = this.scope;
        this.scope = new Scope(saved);
        const init = node.init ? this.stmt(node.init) : null;
        const cond = node.cond ? this.condition(node.cond) : null;
        const step = node.step ? this.expr(node.step, { stmtCtx: true }) : null;
        this.loopDepth++;
        const body = this.stmtAsBlock(node.body);
        this.loopDepth--;
        this.scope = saved;
        return { kind: 'For', init, cond, step, body };
      }
      case 'ForIn': {
        let iterable = this.expr(node.iterable);
        // dynamic 的迭代在运行期分派：list 给元素，dict 给键；统一物化成 list<dynamic>
        if (iterable.type.k === 'dynamic') iterable = this.dynOp('dynIter', [iterable], this.dynListType());
        const elem = this.elementType(iterable.type, node.iterable.span);
        const declared = node.varType ? this.resolveType(node.varType) : (elem ?? DYNAMIC);
        if (elem && castCost(elem, declared) < 0) {
          this.err(node.varSpan, `cannot iterate '${typeName(iterable.type)}' as '${typeName(declared)}' (element type is '${typeName(elem)}')`);
        }
        const saved = this.scope;
        this.scope = new Scope(saved);
        const v = this.scope.declare(node.varName, declared);
        this.loopDepth++;
        const body = this.stmtAsBlock(node.body);
        this.loopDepth--;
        this.scope = saved;
        return {
          kind: 'ForIn',
          varName: v.name,
          varType: declared,
          elemType: elem ?? declared,
          iterable,
          body,
        };
      }
      case 'Return': {
        if (!node.value) {
          if (this.currentRet.k !== 'void') this.err(node.span, `non-void function must return a value of type '${typeName(this.currentRet)}'`);
          return { kind: 'Return', value: null };
        }
        if (this.currentRet.k === 'void') {
          this.err(node.span, 'void function cannot return a value');
          return { kind: 'ExprStmt', expr: this.expr(node.value) };
        }
        return { kind: 'Return', value: this.coerce(this.expr(node.value), this.currentRet, node.value.span) };
      }
      case 'Break':
        if (this.loopDepth === 0) this.err(node.span, "'break' outside of a loop");
        return { kind: 'Break' };
      case 'Continue':
        if (this.loopDepth === 0) this.err(node.span, "'continue' outside of a loop");
        return { kind: 'Continue' };
      default:
        throw new Error(`check.stmt: unhandled ${node.kind}`);
    }
  }

  /** 裸赋值声明的识别：`x = e;` 且 `x` 既不是变量也不是 this 字段 */
  bareDeclName(expr) {
    if (!expr || expr.kind !== 'Assign' || expr.op !== '=') return null;
    const t = expr.target;
    if (!t || t.kind !== 'Name') return null;
    if (this.scope.lookup(t.name)) return null;
    // lambda 里给外层的名字赋值不是"声明一个新变量"：让它走正常路径，由 requireLvalue
    // 报出"捕获是按值的"这条更准确的错误
    if (this.outerHas(t.name)) return null;
    if (this.thisType?.fields.some((f) => f.name === t.name)) return null;
    if (!this.fnScope) return null;
    return t.name;
  }

  /** 这个名字是否存在于任何外层 lambda 之外的作用域里（只查，不登记捕获） */
  outerHas(name) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].outerScope.lookup(name)) return true;
    }
    return false;
  }

  stmtAsBlock(node) {
    if (!node) return { kind: 'Block', stmts: [] };
    if (node.kind === 'Block') return this.block(node);
    const saved = this.scope;
    this.scope = new Scope(saved);
    const s = this.stmt(node);
    this.scope = saved;
    return { kind: 'Block', stmts: s ? [s] : [] };
  }

  varDecl(node) {
    if (node.type === null) return this.inferredVarDecl(node);
    const type = this.resolveType(node.type);
    if (type.k === 'void') this.err(node.type.span, 'variable cannot have type void');
    const stmts = [];
    for (const d of node.decls) {
      if (this.scope.vars.has(d.name)) this.err(d.span, `redeclaration of '${d.name}' in the same scope`);
      const init = d.init ? this.coerce(this.expr(d.init, { expected: type }), type, d.init.span) : zeroValue(type);
      const v = this.scope.declare(d.name, type);
      stmts.push({ kind: 'Local', name: v.name, type, init });
    }
    return stmts.length === 1 ? stmts[0] : { kind: 'Block', stmts, transparent: true };
  }

  /**
   * 省略类型的声明：`let`（块作用域）/ `var`（函数作用域）/ 裸赋值（函数作用域，等价于 var）。
   * 推断只看初始化器，绝不跨函数（ADR-0008 第 3 节）。
   */
  inferredVarDecl(node) {
    const hoisted = node.form !== 'let';
    const stmts = [];
    for (const d of node.decls) {
      const target = hoisted ? this.fnScope : this.scope;
      if (target.vars.has(d.name)) this.err(d.span, `redeclaration of '${d.name}' in the same scope`);
      if (!d.init) {
        // 没有初始化器就没有推断依据
        if (this.mode === 'static') {
          this.err(d.span, `'${node.form} ${d.name}' has no initializer, so its type cannot be inferred; write the type explicitly`);
        }
        const t = DYNAMIC;
        const v = this.declareIn(target, d.name, t, hoisted);
        if (!hoisted) stmts.push({ kind: 'Local', name: v.name, type: t, init: zeroValue(t) });
        continue;
      }
      const e = this.expr(d.init, { expected: this.mode === 'dynamic' ? DYNAMIC : null });
      const t = this.inferDeclType(e, d.span, node.form, d.name);
      const init = this.coerce(e, t, d.init.span);
      const v = this.declareIn(target, d.name, t, hoisted);
      stmts.push(hoisted
        ? { kind: 'ExprStmt', expr: { kind: 'Assign', target: { kind: 'VarRef', name: v.name, type: t }, value: init, type: t } }
        : { kind: 'Local', name: v.name, type: t, init });
    }
    if (!stmts.length) return null;
    return stmts.length === 1 ? stmts[0] : { kind: 'Block', stmts, transparent: true };
  }

  declareIn(scope, name, type, hoisted) {
    const v = scope.declare(name, type);
    v.inferred = true;
    if (hoisted) this.hoist.push({ name: v.name, type });
    return v;
  }

  /** 由初始化器的类型定出声明类型；`null` 推不出具体 class，退到 dynamic */
  inferDeclType(e, span, form, name) {
    if (this.mode === 'dynamic') return DYNAMIC;
    let t = e.type;
    if (t.k === 'null' || t.k === 'void') t = DYNAMIC;
    // 静态模式禁的是**隐式** dynamic：容器元素里的 dynamic 同样是隐式装箱
    if (this.mode === 'static' && mentionsDynamic(t)) {
      this.err(span, `'${form} ${name}' would be inferred as '${typeName(t)}', and this file's static mode forbids implicit dynamic; write the type explicitly or use a '.omni' file`);
    }
    return t;
  }

  condition(ast) {
    const e = this.expr(ast);
    // dynamic 可以直接当条件：运行期要求标签是 bool 并解包。
    // 刻意**不**引入 JS 的 truthiness（0/""/null 为假），那是跨后端分叉源（ADR-0008 第 5 节）
    if (e.type.k === 'dynamic') {
      return { kind: 'Builtin', name: 'asBool', args: [e], recvType: DYNAMIC, type: BOOL };
    }
    if (e.type.k !== 'bool') {
      this.err(ast.span, `condition must be bool, found '${typeName(e.type)}'`);
    }
    return e;
  }

  // ---------------------------------------------------------------- 表达式

  /** 把 expr 转成 target 类型，插入显式 Cast / Box 节点；不可转换则报错 */
  coerce(e, target, span) {
    if (e.type.k === 'null' && target.k === 'class') return { kind: 'NullRef', type: target };
    if (e.type.k === 'null' && target.k === 'dynamic') return { kind: 'DynNull', type: target };
    const cost = castCost(e.type, target);
    if (cost === 0) return e;
    if (cost > 0) {
      // 装箱边界在 OIR 里是一个显式 op（ADR-0006 第 2 节），便于将来做消解
      if (target.k === 'dynamic') return { kind: 'Box', type: target, from: e.type, expr: e };
      return { kind: 'Cast', type: target, from: e.type, expr: e };
    }
    this.err(span, `cannot convert '${typeName(e.type)}' to '${typeName(target)}'`);
    return { ...e, type: target };
  }

  /** @param {{stmtCtx?: boolean, expected?: any}} [opts] */
  expr(node, opts = {}) {
    switch (node.kind) {
      case 'IntLit': return { kind: 'Const', type: INT, value: node.value };
      case 'RealLit': return { kind: 'Const', type: REAL, value: node.value };
      case 'StrLit': return { kind: 'Const', type: STRING, value: node.value };
      case 'BoolLit': return { kind: 'Const', type: BOOL, value: node.value };
      case 'NullLit': return { kind: 'NullLit', type: NULLT };
      case 'ListLit': return this.listLit(node, opts.expected);
      case 'DictLit': return this.dictLit(node, opts.expected);
      case 'New': return this.newExpr(node);
      case 'Index': return this.indexGet(node);
      case 'Name': {
        const v = this.lookupValue(node.name);
        if (v) return v;
        // class 方法体内的裸名可以解析到字段（"数据成员自动挂钩"）
        const field = this.thisType?.fields.find((f) => f.name === node.name);
        if (field) {
          const self = this.lookupValue('this');
          if (self) return { kind: 'Field', object: self, name: field.name, type: field.type, viaThis: true };
        }
        // 具名函数当值用（ADR-0010）：唯一重载直接成立，多重载要靠期望类型定案
        const group = this.lookupFuncs(node.name);
        if (group) return this.funcValue(node.name, group, opts.expected, node.span);
        if (BUILTIN_FUNCS.has(node.name)) {
          this.err(node.span, `'${node.name}' is a builtin, and builtins cannot be used as function values; wrap it in a lambda`);
        } else {
          this.err(node.span, `undefined variable '${node.name}'`);
        }
        return { kind: 'Const', type: INT, value: 0n };
      }
      case 'Lambda': return this.lambda(node);
      case 'Binary': return this.binary(node);
      case 'Unary': return this.unary(node);
      case 'Ternary': {
        const cond = this.condition(node.cond);
        const a = this.expr(node.then);
        const b = this.expr(node.otherwise);
        const t = commonType(a.type, b.type);
        if (!t) {
          this.err(node.span, `incompatible branch types in '?:': '${typeName(a.type)}' and '${typeName(b.type)}'`);
          return { kind: 'Const', type: INT, value: 0n };
        }
        return { kind: 'Ternary', cond, then: this.coerce(a, t, node.then.span), otherwise: this.coerce(b, t, node.otherwise.span), type: t };
      }
      case 'Assign': return this.assign(node);
      case 'IncDec': {
        if (!opts.stmtCtx) {
          this.err(node.span, `'${node.op}' may only be used as a statement in this version (its value cannot be used)`);
        }
        const target = this.expr(node.operand);
        this.requireLvalue(target, node.operand.span);
        if (!isNumeric(target.type)) {
          this.err(node.span, `'${node.op}' requires a numeric operand, found '${typeName(target.type)}'`);
        }
        const one = { kind: 'Const', type: target.type, value: target.type.k === 'int' ? 1n : 1 };
        const bin = { kind: 'Bin', op: node.op === '++' ? '+' : '-', opType: target.type, left: target, right: one, type: target.type };
        return { kind: 'Assign', target, value: bin, type: target.type };
      }
      case 'Member': {
        const object = this.expr(node.object);
        const agg = object.type.k === 'struct' || object.type.k === 'class';
        const field = agg ? object.type.fields.find((f) => f.name === node.name) : null;
        if (field) return { kind: 'Field', object, name: field.name, type: field.type };
        // 内建伪字段：容器与字符串的 .length
        if (node.name === 'length' && LENGTH_TYPES.has(object.type.k)) {
          return { kind: 'Builtin', name: 'len', args: [object], recvType: object.type, type: INT };
        }
        if (node.name === 'length' && object.type.k === 'dynamic') {
          return this.dynOp('dynLen', [object], INT);
        }
        this.err(node.nameSpan, `type '${typeName(object.type)}' has no member '${node.name}'`);
        return { kind: 'Const', type: INT, value: 0n };
      }
      case 'Call': return this.call(node);
      default:
        throw new Error(`check.expr: unhandled ${node.kind}`);
    }
  }

  // ------------------------------------------------------- 容器：字面量 / 索引 / 迭代

  /** list 字面量；空 `[]` 需要上下文提供元素类型 */
  listLit(node, expected) {
    const elem = this.expectedElem(expected) ?? this.probeElem(node.items, node.span);
    const items = node.items.map((it, i) => this.coerce(this.expr(it, { expected: elem }), elem, node.items[i].span));
    return { kind: 'ListLit', type: this.useType(listType(elem)), items };
  }

  /** 期望类型自上而下传播：某一层落到 dynamic，它的子字面量就整棵以 dynamic 推断（ADR-0008 第 4 节） */
  expectedElem(expected) {
    if (expected?.k === 'list') return expected.elem;
    if (expected?.k === 'dynamic') return DYNAMIC;
    return null;
  }

  /**
   * 先试探地求值一遍元素、统一类型，再丢弃试探期的诊断 —— 正式一遍会带着确定的期望类型重新产生。
   * 双次求值在 stage0 不是问题，换来的是"异质字面量自动降级为 dynamic"这条规则的干净实现。
   */
  probeElem(items, span) {
    if (this.mode === 'dynamic') return DYNAMIC;
    const mark = this.diags.items.length;
    const probe = items.map((it) => this.expr(it));
    const t = this.unifyElems(probe);
    this.diags.items.length = mark;
    if (t) return t;
    this.err(span, "cannot infer element type of empty list literal; annotate the target (e.g. 'list<int> xs = [];')");
    return INT;
  }

  /** 统一一组元素的类型；统一不了就降级为 dynamic（不引入联合类型，ADR-0008 第 4 节） */
  unifyElems(items) {
    if (!items.length) return null;
    let t = items[0].type;
    for (const it of items) {
      const c = commonType(t, it.type);
      if (!c) return DYNAMIC;
      t = c;
    }
    return (t.k === 'null' || t.k === 'void') ? DYNAMIC : t;
  }

  /** dict 字面量；空 `{:}` 需要上下文提供键值类型 */
  dictLit(node, expected) {
    let keyT = expected?.k === 'dict' ? expected.key : (expected?.k === 'dynamic' ? STRING : null);
    let valT = expected?.k === 'dict' ? expected.val : (expected?.k === 'dynamic' ? DYNAMIC : null);
    if (!keyT || !valT) {
      if (!node.entries.length) {
        this.err(node.span, "cannot infer key/value types of empty dict literal; annotate the target (e.g. 'dict<string,int> d = {:};')");
        keyT = keyT ?? STRING;
        valT = valT ?? INT;
      } else {
        const mark = this.diags.items.length;
        const pk = node.entries.map((e) => this.expr(e.key));
        const pv = node.entries.map((e) => this.expr(e.value));
        this.diags.items.length = mark;
        if (!keyT) keyT = this.mode === 'dynamic' ? STRING : this.unifyElems(pk);
        if (!valT) valT = this.mode === 'dynamic' ? DYNAMIC : this.unifyElems(pv);
        if (keyT.k === 'dynamic') {
          // 键要参与哈希与插入序，跨标签比较是泥潭：键不允许降级（ADR-0008 第 4 节）
          this.err(node.span, 'dict keys must share one hashable type; only values may degrade to dynamic');
          keyT = STRING;
        }
      }
    }
    if (!isHashable(keyT)) {
      this.err(node.span, `dict key type must be int/real/bool/string, found '${typeName(keyT)}'`);
      keyT = STRING;
    }
    const entries = node.entries.map((e, i) => ({
      key: this.coerce(this.expr(e.key, { expected: keyT }), keyT, node.entries[i].key.span),
      value: this.coerce(this.expr(e.value, { expected: valT }), valT, node.entries[i].value.span),
    }));
    return { kind: 'DictLit', type: this.useType(dictType(keyT, valT)), entries };
  }

  newExpr(node) {
    const type = this.resolveType(node.type);
    if (type.k !== 'class') {
      this.err(node.span, `'new' requires a class type, found '${typeName(type)}'`);
      return { kind: 'Const', type: INT, value: 0n };
    }
    if (node.args.length) {
      this.err(node.span, 'constructors with arguments are not supported yet; assign fields after new');
    }
    return { kind: 'NewObject', type };
  }

  /** 容器/字符串索引读取；索引本身带边界检查（安全指针的雏形） */
  indexGet(node) {
    const obj = this.expr(node.object);
    const idx = this.expr(node.index);
    switch (obj.type.k) {
      case 'list':
        return { kind: 'IndexGet', obj, index: this.coerce(idx, INT, node.index.span), recvType: obj.type, type: obj.type.elem };
      case 'dict':
        return { kind: 'IndexGet', obj, index: this.coerce(idx, obj.type.key, node.index.span), recvType: obj.type, type: obj.type.val };
      case 'string':
        // 字符串索引返回字节（还没有 char 类型），与 byteAt 等价
        return { kind: 'Builtin', name: 'byteAt', args: [obj, this.coerce(idx, INT, node.index.span)], recvType: STRING, type: INT };
      case 'dynamic':
        // 索引一并装箱：接收者是 list 还是 dict 只有运行期知道（ADR-0008 第 5 节）
        return this.dynOp('dynGet', [obj, this.coerce(idx, DYNAMIC, node.index.span)], DYNAMIC);
      default:
        this.err(node.span, `type '${typeName(obj.type)}' is not indexable`);
        return { kind: 'Const', type: INT, value: 0n };
    }
  }

  /** for-in 的元素类型 */
  elementType(t, span) {
    switch (t.k) {
      case 'list': case 'set': return t.elem;
      case 'dict': return t.key; // 借 Python：迭代 dict 得到键
      default:
        this.err(span, `type '${typeName(t)}' is not iterable`);
        return null;
    }
  }
  requireLvalue(e, span) {
    let cur = e;
    while (cur.kind === 'Field') {
      // 通过 class 引用改字段是允许的，即使这个引用是被捕获来的：改的是对象，不是引用
      if (cur.object.type.k === 'class') return true;
      cur = cur.object;
    }
    if (cur.kind === 'CaptureRef') {
      this.err(span, `'${cur.name}' is captured by value, so a lambda cannot assign to it`
        + ' — return the new value, or capture a class/container and mutate that');
      return false;
    }
    if (cur.kind !== 'VarRef') {
      this.err(span, 'expression is not assignable');
      return false;
    }
    return true;
  }

  binary(node) {
    const op = node.op;
    if (op === '&&' || op === '||') {
      return { kind: 'Logic', op, left: this.condition(node.left), right: this.condition(node.right), type: BOOL };
    }
    if (op === 'in') return this.membership(node);
    const a = this.expr(node.left);
    const b = this.expr(node.right);

    if (CMP_OPS.has(op)) {
      const t = commonType(a.type, b.type);
      if (!t || NOT_COMPARABLE.has(t.k)) {
        this.err(node.span, `cannot compare '${typeName(a.type)}' with '${typeName(b.type)}'`);
        return { kind: 'Const', type: BOOL, value: false };
      }
      if (EQ_ONLY.has(t.k) && op !== '==' && op !== '!=') {
        this.err(node.span, `operator '${op}' cannot be applied to '${typeName(t)}' (only == and != are supported)`);
      }
      return { kind: 'Cmp', op, opType: t, left: this.coerce(a, t, node.left.span), right: this.coerce(b, t, node.right.span), type: BOOL };
    }

    if (BIT_OPS.has(op)) {
      if (a.type.k !== 'int' || b.type.k !== 'int') {
        this.err(node.span, `operator '${op}' requires int operands, found '${typeName(a.type)}' and '${typeName(b.type)}'`);
      }
      return { kind: 'Bin', op, opType: INT, left: a, right: b, type: INT };
    }

    // 算术：+ 在双方都是 string 时是拼接
    if (op === '+' && a.type.k === 'string' && b.type.k === 'string') {
      return { kind: 'Bin', op: '+', opType: STRING, left: a, right: b, type: STRING };
    }
    if (!isNumeric(a.type) || !isNumeric(b.type)) {
      this.err(node.span, `operator '${op}' cannot be applied to '${typeName(a.type)}' and '${typeName(b.type)}'`);
      return { kind: 'Const', type: INT, value: 0n };
    }
    const t = commonType(a.type, b.type);
    return { kind: 'Bin', op, opType: t, left: this.coerce(a, t, node.left.span), right: this.coerce(b, t, node.right.span), type: t };
  }

  unary(node) {
    const e = this.expr(node.operand);
    if (node.op === '!') {
      if (e.type.k !== 'bool') this.err(node.span, `operator '!' requires bool, found '${typeName(e.type)}'`);
      return { kind: 'Un', op: '!', operand: e, type: BOOL };
    }
    if (node.op === '~') {
      if (e.type.k !== 'int') this.err(node.span, `operator '~' requires int, found '${typeName(e.type)}'`);
      return { kind: 'Un', op: '~', operand: e, type: INT };
    }
    if (!isNumeric(e.type)) this.err(node.span, `unary '${node.op}' requires a numeric operand, found '${typeName(e.type)}'`);
    if (node.op === '+') return e;
    return { kind: 'Un', op: '-', operand: e, type: e.type };
  }

  /** `x in c` 成员测试：dict 查键、set/list 查值（借 Python） */
  membership(node) {
    const value = this.expr(node.left);
    const container = this.expr(node.right);
    const t = container.type;
    let want = null;
    if (t.k === 'dict') want = t.key;
    else if (t.k === 'set' || t.k === 'list') want = t.elem;
    else {
      this.err(node.span, `'in' requires a list/dict/set on the right, found '${typeName(t)}'`);
      return { kind: 'Const', type: BOOL, value: false };
    }
    if (!EQUATABLE.has(want.k)) {
      this.err(node.span, `'in' requires an element type with equality, found '${typeName(want)}'`);
    }
    return {
      kind: 'Builtin',
      name: 'contains',
      args: [container, this.coerce(value, want, node.left.span)],
      recvType: t,
      type: BOOL,
    };
  }

  assign(node) {
    // 索引赋值走单独的 op（容器需要在越界/缺键时报错，而不是静默扩张）
    if (node.target.kind === 'Index') {
      const target = this.indexGet(node.target);
      // dynamic 的索引写入同样是运行期分派
      if (target.kind === 'Builtin' && target.name === 'dynGet') {
        const valueAst = node.op === '='
          ? node.value
          : { kind: 'Binary', op: node.op.slice(0, -1), left: node.target, right: node.value, span: node.span };
        const value = this.coerce(this.expr(valueAst, { expected: DYNAMIC }), DYNAMIC, node.value.span);
        return this.dynOp('dynSet', [target.args[0], target.args[1], value], DYNAMIC);
      }
      if (target.kind === 'Builtin') {
        this.err(node.span, `cannot assign through index on '${typeName(target.recvType)}'`);
        return target;
      }
      const valueAst = node.op === '='
        ? node.value
        : { kind: 'Binary', op: node.op.slice(0, -1), left: node.target, right: node.value, span: node.span };
      const value = this.coerce(this.expr(valueAst, { expected: target.type }), target.type, node.value.span);
      return { kind: 'IndexSet', obj: target.obj, index: target.index, value, recvType: target.recvType, type: target.type };
    }
    const target = this.expr(node.target);
    this.requireLvalue(target, node.target.span);
    if (node.op === '=') {
      const raw = this.expr(node.value, { expected: target.type });
      // 推断出来的变量是单态的：这条错误消息要把出路写清楚（ADR-0008 已知代价）
      const v = target.kind === 'VarRef' ? this.scope.lookup(target.name) : null;
      if (v?.inferred && castCost(raw.type, target.type) < 0) {
        this.err(node.value.span, `cannot assign '${typeName(raw.type)}' to '${target.name}', whose type was inferred as '${typeName(target.type)}'; inferred variables are monomorphic — declare it as 'dynamic ${target.name}' or put this code in a '.omnid' file`);
        return { kind: 'Assign', target, value: { ...raw, type: target.type }, type: target.type };
      }
      const value = this.coerce(raw, target.type, node.value.span);
      return { kind: 'Assign', target, value, type: target.type };
    }
    // 复合赋值降级为 target = target <op> value，语义只在这里定义一次
    const binOp = node.op.slice(0, -1);
    const bin = this.binary({ kind: 'Binary', op: binOp, left: node.target, right: node.value, span: node.span });
    const value = this.coerce(bin, target.type, node.span);
    return { kind: 'Assign', target, value, type: target.type };
  }

  // ------------------------------------------------- 调用：重载 / 默认实参 / 命名实参 / UFCS

  call(node) {
    const callee = node.callee;

    // 实参先降级；命名实参必须在位置实参之后
    /** @type {{name: string|null, expr: any, span: any}[]} */
    const args = [];
    let sawNamed = false;
    for (const a of node.args) {
      if (a.name) sawNamed = true;
      else if (sawNamed) this.err(a.span, 'positional argument cannot follow a named argument');
      args.push({ name: a.name, expr: this.expr(a.expr), span: a.span });
    }

    if (callee.kind === 'Name') {
      // 函数值优先：`f(x)` 里的 f 如果是一个 fn 类型的变量（或被捕获的变量），
      // 那它就是被调用的东西，具名函数表在这一层根本不参与 —— 局部名字遮蔽全局名字
      const value = this.lookupValue(callee.name);
      if (value && value.type.k === 'fn') return this.callFnValue(value, args, node.span);
      if (value) {
        this.err(callee.span, `'${callee.name}' is a variable of type '${typeName(value.type)}', not a function`);
        return { kind: 'Const', type: INT, value: 0n };
      }
      if (BUILTIN_FUNCS.has(callee.name)) return this.builtinCall(callee.name, args, node.span);
      const group = this.lookupFuncs(callee.name);
      if (!group) {
        this.err(callee.span, `undefined function '${callee.name}'`);
        return { kind: 'Const', type: INT, value: 0n };
      }
      // 方法体内的裸调用：先按原样解析，失败再补上隐式 this（方法就是自由函数，见 ADR-0006）
      const direct = this.tryResolve(group, args);
      if (direct.best) return this.buildCall(callee.name, direct, node.span);
      if (this.thisType) {
        const withThis = this.tryResolve(group, [
          { name: null, expr: { kind: 'VarRef', name: 'this', type: this.thisType }, span: callee.span },
          ...args,
        ]);
        if (withThis.best) return this.buildCall(callee.name, withThis, node.span);
      }
      return this.buildCall(callee.name, direct, node.span);
    }

    if (callee.kind === 'Member') {
      const recv = this.expr(callee.object);
      const name = callee.name;
      const recvType = recv.type;
      const field = (recvType.k === 'struct' || recvType.k === 'class')
        ? recvType.fields.find((f) => f.name === name)
        : null;
      if (field) {
        // 字段里存着函数值就调用它；否则维持原来的诊断（字段不是函数）
        if (field.type.k === 'fn') {
          const target = { kind: 'Field', object: recv, name: field.name, type: field.type };
          return this.callFnValue(target, args, node.span);
        }
        this.err(callee.nameSpan, `member '${name}' is a field, not a function`);
        return { kind: 'Const', type: INT, value: 0n };
      }
      // 内建容器/字符串/dynamic 的方法优先（用户无法为内建类型定义同名成员）
      const builtin = this.builtinMethod(recvType, name, recv, args, node.span);
      if (builtin) return builtin;
      // UFCS：候选合并成一个重载集（ADR-0006 第 5 节）。class 方法此时已在同一张表里。
      const group = this.lookupFuncs(name);
      const ufcsArgs = [{ name: null, expr: recv, span: callee.object.span }, ...args];
      if (group) return this.buildCall(name, this.tryResolve(group, ufcsArgs), node.span);
      if (BUILTIN_FUNCS.has(name)) return this.builtinCall(name, ufcsArgs, node.span);
      this.err(callee.nameSpan, `no method or function '${name}' applicable to '${typeName(recvType)}'`);
      return { kind: 'Const', type: INT, value: 0n };
    }

    // 其它形态的被调方：`fs[0](x)`、`adder(1)(2)`、`(cond ? f : g)(x)` ——
    // 一律求值出来看类型，是函数值就调用。这里不再枚举语法形态，免得每加一种表达式就漏一次。
    const value = this.expr(callee);
    if (value.type.k === 'fn') return this.callFnValue(value, args, node.span);
    this.err(node.span, `cannot call a value of type '${typeName(value.type)}'`);
    return { kind: 'Const', type: INT, value: 0n };
  }

  /** 内建类型的方法表；命中则返回 Builtin 节点，否则 null */
  builtinMethod(recvType, name, recv, args, span) {
    const table = BUILTIN_METHODS[recvType.k];
    // hasOwn 而不是直接索引：`name` 是用户写下的字符串，`a.constructor()` / `a.toString()`
    // 会摸到 Object.prototype 上的函数，于是 make(recvType) 返回的不是签名而是一个对象，
    // 编译器当场崩在读 sig.params 上。这类"用户输入索引对象字面量"的地方一律要护栏。
    const make = table && Object.hasOwn(table, name) ? table[name] : undefined;
    if (!make) return null;
    const sig = make(recvType);
    if (args.some((a) => a.name !== null)) {
      this.err(span, `builtin method '${name}' does not accept named arguments`);
    }
    if (args.length !== sig.params.length) {
      this.err(span, `'${typeName(recvType)}.${name}' takes ${sig.params.length} argument(s), got ${args.length}`);
      return { kind: 'Const', type: sig.ret, value: 0n };
    }
    const lowered = args.map((a, i) => this.coerce(a.expr, sig.params[i], a.span));
    if (sig.requireEq && !EQUATABLE.has(sig.requireEq.k)) {
      this.err(span, `'${typeName(recvType)}.${name}' requires an element type with equality, found '${typeName(sig.requireEq)}'`);
    }
    if (sig.requireKind && sig.requireKind.type.k !== sig.requireKind.kind) {
      this.err(span, `'${typeName(recvType)}.${name}' requires '${sig.requireKind.kind}' elements, found '${typeName(sig.requireKind.type)}'`);
    }
    if (sig.ret.k === 'list' || sig.ret.k === 'dict' || sig.ret.k === 'set') this.useType(sig.ret);
    // dynamic 的运行期分派需要 list<dynamic> / dict<string,dynamic> 这两个具体容器兜底
    if (recvType.k === 'dynamic') {
      this.useType(this.dynListType());
      this.useType(dictType(STRING, DYNAMIC));
    }
    return { kind: 'Builtin', name: sig.op ?? name, args: [recv, ...lowered], recvType, type: sig.ret };
  }

  /**
   * 重载解析（不报错版本）：把实参按「位置 + 名字 + 默认值」映射到形参槽位，
   * 用隐式转换代价之和择优；并列最优即歧义。
   */
  tryResolve(group, args) {
    const failures = [];
    let best = null;
    let bestTied = false;

    for (const sym of group) {
      const slots = new Array(sym.params.length).fill(null);
      let ok = true;
      let cost = 0;
      let pos = 0;

      for (const a of args) {
        if (a.name === null) {
          if (pos >= slots.length) { ok = false; failures.push(`${describeSym(sym)}: too many arguments`); break; }
          slots[pos++] = a;
        } else {
          const idx = sym.params.findIndex((p) => p.name === a.name);
          if (idx < 0) { ok = false; failures.push(`${describeSym(sym)}: no parameter named '${a.name}'`); break; }
          if (slots[idx]) { ok = false; failures.push(`${describeSym(sym)}: parameter '${a.name}' specified twice`); break; }
          slots[idx] = a;
        }
      }
      if (!ok) continue;

      for (let i = 0; i < slots.length && ok; i++) {
        const p = sym.params[i];
        if (!slots[i]) {
          if (!p.def) { ok = false; failures.push(`${describeSym(sym)}: missing argument for '${p.name}'`); }
          continue;
        }
        const c = castCost(slots[i].expr.type, p.type);
        if (c < 0) {
          ok = false;
          failures.push(`${describeSym(sym)}: cannot convert '${typeName(slots[i].expr.type)}' to '${typeName(p.type)}' for '${p.name}'`);
        } else cost += c;
      }
      if (!ok) continue;

      if (!best || cost < best.cost) { best = { sym, slots, cost }; bestTied = false; }
      else if (cost === best.cost) bestTied = true;
    }

    return { best, bestTied, failures };
  }

  /** 把 tryResolve 的结果变成 OIR 调用节点，顺带报错 */
  buildCall(name, res, span) {
    if (!res.best) {
      const detail = res.failures.length ? `\n  candidates:\n    ${res.failures.join('\n    ')}` : '';
      this.err(span, `no matching overload for '${name}'${detail}`);
      return { kind: 'Const', type: INT, value: 0n };
    }
    if (res.bestTied) {
      this.err(span, `ambiguous call to '${name}': multiple overloads match equally well`);
    }
    const finalArgs = res.best.sym.params.map((p, i) => {
      const slot = res.best.slots[i];
      return slot ? this.coerce(slot.expr, p.type, slot.span) : p.def;
    });
    return { kind: 'Call', func: res.best.sym.mangled, name: res.best.sym.name, args: finalArgs, type: res.best.sym.ret };
  }

  builtinCall(name, args, span) {
    if (args.some((a) => a.name !== null)) this.err(span, `builtin '${name}' does not accept named arguments`);
    if (name === 'set') return this.setCtor(args, span);
    if (args.length !== 1) {
      this.err(span, `builtin '${name}' takes exactly 1 argument, got ${args.length}`);
      return { kind: 'Const', type: INT, value: 0n };
    }
    const a = args[0].expr;
    const k = a.type.k;
    switch (name) {
      case 'print':
        if (k === 'dynamic') {
          const text = this.dynText(a, args[0].span);
          return { kind: 'Builtin', name: 'print', args: [text], type: VOID, recvType: STRING, argType: STRING };
        }
        if (!PRINTABLE.has(k)) this.err(args[0].span, `cannot print a value of type '${typeName(a.type)}'`);
        return { kind: 'Builtin', name: 'print', args: [a], type: VOID, recvType: a.type, argType: a.type };
      case 'int':
        if (k === 'int') return a;
        if (k === 'real') return { kind: 'Builtin', name: 'trunc', args: [a], type: INT, argType: REAL };
        if (k === 'string') return { kind: 'Builtin', name: 'int_of_string', args: [a], type: INT, argType: STRING };
        if (k === 'dynamic') return { kind: 'Builtin', name: 'asInt', args: [a], type: INT, recvType: DYNAMIC };
        this.err(args[0].span, `cannot convert '${typeName(a.type)}' to int`);
        return { kind: 'Const', type: INT, value: 0n };
      case 'real':
        if (k === 'real') return a;
        if (k === 'int') return { kind: 'Cast', type: REAL, from: INT, expr: a };
        if (k === 'string') return { kind: 'Builtin', name: 'real_of_string', args: [a], type: REAL, argType: STRING };
        if (k === 'dynamic') return { kind: 'Builtin', name: 'asReal', args: [a], type: REAL, recvType: DYNAMIC };
        this.err(args[0].span, `cannot convert '${typeName(a.type)}' to real`);
        return { kind: 'Const', type: REAL, value: 0 };
      case 'string':
        if (k === 'string') return a;
        if (k === 'dynamic') return this.dynText(a, args[0].span);
        if (!PRINTABLE.has(k)) this.err(args[0].span, `cannot convert '${typeName(a.type)}' to string`);
        return { kind: 'Builtin', name: 'to_string', args: [a], type: STRING, argType: a.type };
      case 'chr':
        return { kind: 'Builtin', name: 'chr', args: [this.coerce(a, INT, args[0].span)], type: STRING, argType: INT };
      case 'fail':
        if (k !== 'string') this.err(args[0].span, `fail() takes a string message, found '${typeName(a.type)}'`);
        return { kind: 'Builtin', name: 'fail', args: [a], type: VOID, argType: STRING };
      case 'repr':
        // 往返无损的 real 文本（序列化用），与 print 的 %.6g 是两条不同规则（ADR-0005）
        if (k === 'real') return { kind: 'Builtin', name: 'repr', args: [a], type: STRING, argType: REAL };
        if (k === 'int') return { kind: 'Builtin', name: 'to_string', args: [a], type: STRING, argType: INT };
        this.err(args[0].span, `repr() takes int or real, found '${typeName(a.type)}'`);
        return { kind: 'Const', type: STRING, value: '' };
      case 'dyn':
        return this.coerce(a, DYNAMIC, args[0].span);
      default:
        throw new Error(`builtinCall: ${name}`);
    }
  }

  /**
   * `print(dynamic)` / `string(dynamic)`：标签是 string 取原文，其余取 JSON 文本（对齐 Python 的 print/str）。
   * 刻意降级为对 stdlib `dynToText` 的调用 —— json 的序列化实现只有一份，在 `lib/json.omni` 里。
   */
  dynText(e, span) {
    // 这是编译器内部的降级钩子，不是用户写下的名字，所以**不过可见性**：
    // 只要模块图里有人导入了 std/json，`print(dynamic)` 就该能用。
    const group = this.funcs.get('dynToText');
    if (!group) {
      this.err(span, 'printing a dynamic value needs the json library; add \'import "std/json.omni";\', or call x.asString() explicitly');
      return { kind: 'Const', type: STRING, value: '' };
    }
    return this.buildCall('dynToText', this.tryResolve(group, [{ name: null, expr: e, span }]), span);
  }

  /** `set(1, 2, 3)` —— set 刻意不给字面量语法（ADR-0006：`{1,2}` 与块语句冲突） */
  setCtor(args, span) {
    if (!args.length) {
      this.err(span, "cannot infer element type of 'set()'; use a typed variable and add() instead");
      return { kind: 'Const', type: INT, value: 0n };
    }
    const elem = args.reduce((acc, a) => commonType(acc, a.expr.type) ?? acc, args[0].expr.type);
    if (!isHashable(elem)) {
      this.err(span, `set element type must be int/real/bool/string, found '${typeName(elem)}'`);
      return { kind: 'Const', type: INT, value: 0n };
    }
    const type = this.useType(setType(elem));
    return { kind: 'SetLit', type, items: args.map((a) => this.coerce(a.expr, elem, a.span)) };
  }
}

const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const BIT_OPS = new Set(['&', '|', '^', '<<', '>>']);
const LENGTH_TYPES = new Set(['list', 'dict', 'set', 'string']);
/** 只支持 == / != 的类型 */
const EQ_ONLY = new Set(['bool', 'class', 'dynamic', 'fn']);
const NOT_COMPARABLE = new Set(['struct', 'list', 'dict', 'set', 'void']);
/** 有相等语义的类型：list.contains / `in` 要求元素落在这里（两个后端才能给出同一答案） */
const EQUATABLE = new Set(['int', 'real', 'bool', 'string', 'class', 'dynamic']);

/**
 * 内建类型的方法表。用户不能为内建类型定义同名成员，所以这里优先命中；
 * 想扩展内建类型请写自由函数，UFCS 会让它以方法形式可用（ADR-0006 第 5 节）。
 */
const BUILTIN_METHODS = {
  list: {
    push: (t) => ({ params: [t.elem], ret: VOID }),
    pop: (t) => ({ params: [], ret: t.elem }),
    clear: () => ({ params: [], ret: VOID }),
    length: () => ({ params: [], ret: INT, op: 'len' }),
    contains: (t) => ({ params: [t.elem], ret: BOOL, requireEq: t.elem }),
    // 一次算总长、一次分配。编译器最热的形态就是 out.push(片段) 然后 join，
    // 逐个 + 起来即使有 arena 的原地追加快路径，也要多走 n 次调用和 n 次长度检查。
    join: (t) => ({ params: [STRING], ret: STRING, requireKind: { type: t.elem, kind: 'string' } }),
  },
  dict: {
    has: (t) => ({ params: [t.key], ret: BOOL, op: 'contains' }),
    get: (t) => ({ params: [t.key], ret: t.val, op: 'dictGet' }),
    set: (t) => ({ params: [t.key, t.val], ret: VOID, op: 'dictSet' }),
    remove: (t) => ({ params: [t.key], ret: BOOL }),
    keys: (t) => ({ params: [], ret: listType(t.key) }),
    length: () => ({ params: [], ret: INT, op: 'len' }),
  },
  set: {
    add: (t) => ({ params: [t.elem], ret: VOID }),
    contains: (t) => ({ params: [t.elem], ret: BOOL }),
    remove: (t) => ({ params: [t.elem], ret: BOOL }),
    items: (t) => ({ params: [], ret: listType(t.elem) }),
    length: () => ({ params: [], ret: INT, op: 'len' }),
  },
  string: {
    length: () => ({ params: [], ret: INT, op: 'len' }),
    byteAt: () => ({ params: [INT], ret: INT }),
    substr: () => ({ params: [INT, INT], ret: STRING }),
    indexOf: () => ({ params: [STRING], ret: INT }),
  },
  dynamic: {
    tag: () => ({ params: [], ret: STRING }),
    asInt: () => ({ params: [], ret: INT }),
    asReal: () => ({ params: [], ret: REAL }),
    asBool: () => ({ params: [], ret: BOOL }),
    asString: () => ({ params: [], ret: STRING }),
    asList: () => ({ params: [], ret: listType(DYNAMIC) }),
    asDict: () => ({ params: [], ret: dictType(STRING, DYNAMIC) }),
    // 运行期分派的容器操作，让 json 不用先 asList()/asDict() 就能读写
    push: () => ({ params: [DYNAMIC], ret: VOID, op: 'dynPush' }),
    has: () => ({ params: [DYNAMIC], ret: BOOL, op: 'dynHas' }),
    keys: () => ({ params: [], ret: listType(DYNAMIC), op: 'dynKeys' }),
    length: () => ({ params: [], ret: INT, op: 'dynLen' }),
  },
};


/**
 * 容器按依赖拓扑排序：后端生成 `list<list<int>>` 的函数前必须先有 `list<int>`，
 * 生成 `dict<K,V>` 前必须先有 `list<K>`（keys() 用它）。
 */
function sortedContainers(map) {
  const deps = (t) => {
    switch (t.k) {
      case 'list': return [t.elem];
      case 'set': return [t.elem, listType(t.elem)];
      case 'dict': return [t.key, t.val, listType(t.key)];
      default: return [];
    }
  };
  const out = [];
  const done = new Set();
  const visit = (t) => {
    const key = typeKey(t);
    if (done.has(key) || !map.has(key)) return;
    done.add(key);
    for (const d of deps(t)) visit(d);
    out.push(map.get(key));
  };
  // 先按 typeKey 排序，保证同一份源码总是产出同一份 C（可复现构建）
  for (const key of [...map.keys()].sort()) visit(map.get(key));
  return out;
}
export const BUILTIN_FUNCS = new Set(['print', 'int', 'real', 'string', 'chr', 'dyn', 'set', 'fail', 'repr']);

/** 类型里是否出现 dynamic（含容器元素）：静态模式用它拦下隐式装箱 */
function mentionsDynamic(t) {
  switch (t.k) {
    case 'dynamic': return true;
    case 'list': case 'set': return mentionsDynamic(t.elem);
    case 'dict': return mentionsDynamic(t.key) || mentionsDynamic(t.val);
    case 'fn': return t.params.some(mentionsDynamic) || mentionsDynamic(t.ret);
    default: return false;
  }
}

function describeSym(sym) {
  return `${typeName(sym.ret)} ${sym.name}(${sym.params.map((p) => `${typeName(p.type)} ${p.name}`).join(', ')})`;
}

/**
 * AST -> OIR
 * @param {any} program
 * @param {import('../source/diag.js').Diagnostics} diags
 * @param {'mixed'|'dynamic'|'static'} [mode] 缺省类型注解的处理方式（ADR-0008）
 */
export function check(program, diags, mode = 'mixed') {
  return new Checker(diags, mode).run(program);
}
