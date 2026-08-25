// Omni stage0 — 语法分析：递归下降（声明/语句）+ Pratt（表达式）
// 「声明 vs 表达式」歧义用 tentative parse（保存/回滚 token 位置）解决，与 Clang 的做法同源。

import { lex } from './lexer.js';
import { span } from '../source/diag.js';

const BUILTIN_TYPES = new Set(['int', 'real', 'bool', 'string', 'void', 'dynamic', 'json']);
/** 编译器内建的参数化容器（ADR-0006：先不做用户自定义泛型） */
const GENERIC_TYPES = new Map([['list', 1], ['dict', 2], ['set', 1]]);

// 二元运算符优先级（数字越大越紧）
const BINARY_PREC = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, in: 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=']);

class Parser {
  /**
   * @param {import('../source/diag.js').SourceFile} file
   * @param {import('../source/diag.js').Diagnostics} diags
   */
  constructor(file, diags) {
    this.file = file;
    this.diags = diags;
    this.tokens = lex(file, diags);
    this.pos = 0;
    /** @type {Set<string>} 已见过的 struct 名，帮助类型识别 */
    this.typeNames = new Set();
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  get atEof() {
    return this.peek().kind === 'eof';
  }

  /** 当前 token 是否为给定标点/关键字 */
  at(value, offset = 0) {
    const t = this.peek(offset);
    return (t.kind === 'punct' || t.kind === 'kw') && t.value === value;
  }

  next() {
    return this.tokens[this.pos++];
  }

  eat(value) {
    if (this.at(value)) { this.pos++; return true; }
    return false;
  }

  expect(value, what = value) {
    if (this.at(value)) return this.next();
    const t = this.peek();
    this.error(t.span, `expected '${what}', found ${describe(t)}`);
    return t;
  }

  error(sp, msg) {
    this.diags.error(sp, msg);
  }

  spanFrom(startTok) {
    const prev = this.tokens[Math.max(0, this.pos - 1)];
    return span(this.file, startTok.span.start, prev.span.end);
  }

  // ---------------------------------------------------------------- 类型

  /** 当前位置是否可以作为类型的开头 */
  atTypeStart() {
    const t = this.peek();
    if (t.kind === 'kw' && (BUILTIN_TYPES.has(t.value) || GENERIC_TYPES.has(t.value))) return true;
    if (t.kind === 'kw' && t.value === 'fn') return true;
    return t.kind === 'ident' && this.typeNames.has(t.value);
  }

  /** 关闭类型实参列表。`list<list<int>>` 的 `>>` 是一个 token，需要就地拆开。 */
  expectGt() {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '>') { this.next(); return; }
    if (t.kind === 'punct' && (t.value === '>>' || t.value === '>>=')) {
      this.tokens[this.pos] = {
        ...t,
        value: t.value.slice(1),
        text: t.text.slice(1),
        span: { ...t.span, start: t.span.start + 1 },
        trivia: '',
      };
      return;
    }
    this.error(t.span, `expected '>' to close type arguments, found ${describe(t)}`);
  }

  parseType() {
    if (this.at('fn')) return this.parseFnType();
    const t = this.next();
    const arity = t.kind === 'kw' ? GENERIC_TYPES.get(t.value) : undefined;
    if (arity !== undefined) {
      this.expect('<');
      const args = [];
      for (;;) {
        args.push(this.parseType());
        if (!this.eat(',')) break;
      }
      this.expectGt();
      if (args.length !== arity) {
        this.error(this.spanFrom(t), `'${t.value}' takes ${arity} type argument(s), got ${args.length}`);
      }
      return { kind: 'GenericType', name: t.value, args, span: this.spanFrom(t) };
    }
    if (t.kind !== 'ident' && !(t.kind === 'kw' && BUILTIN_TYPES.has(t.value))) {
      this.error(t.span, `expected type name, found ${describe(t)}`);
      return { kind: 'TypeRef', name: 'int', span: t.span };
    }
    return { kind: 'TypeRef', name: t.value, span: t.span };
  }

  /**
   * 函数值类型：`fn(int, string) -> bool`、`fn() -> void`。
   * 只有类型，没有参数名 —— 参数名属于 lambda 不属于类型（ADR-0010）。
   */
  parseFnType() {
    const start = this.expect('fn');
    this.expect('(');
    const params = [];
    while (!this.at(')') && !this.atEof) {
      const before = this.pos;
      params.push(this.parseType());
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect(')');
    this.expect('->', "-> after the parameter list of a 'fn' type");
    const ret = this.parseType();
    return { kind: 'FnType', params, ret, span: this.spanFrom(start) };
  }

  /**
   * lambda：`fn(int x, int y) -> int { return x + y; }`。
   *
   * 参数与返回类型都必须写出来。理由是实参在重载解析**之前**就要定型：如果 lambda 的类型
   * 要靠形参位置的期望类型倒推，那"选哪个重载"和"实参是什么类型"就互相依赖了。
   * 写全注解让 lambda 自带类型，这个环就不存在。
   */
  parseLambda() {
    const start = this.expect('fn');
    this.expect('(');
    const params = [];
    while (!this.at(')') && !this.atEof) {
      const before = this.pos;
      const type = this.parseType();
      const p = this.peek();
      if (p.kind !== 'ident') { this.error(p.span, 'expected parameter name'); break; }
      this.next();
      params.push({ type, name: p.value, def: null, span: p.span });
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect(')');
    this.expect('->', "-> and a return type after a lambda's parameter list");
    const retType = this.parseType();
    const body = this.parseBlock();
    return { kind: 'Lambda', retType, params, body, span: this.spanFrom(start) };
  }

  /**
   * tentative：`Type ident` 前缀？用于区分变量声明与表达式语句。
   * 未知标识符 + 标识符 也判定为声明（本子集无并置表达式），这样前向引用的类型也能工作。
   */
  looksLikeVarDecl() {
    const t0 = this.peek();
    if (t0.kind === 'kw' && GENERIC_TYPES.has(t0.value)) return true;
    // `fn` 开头：可能是 `fn(int)->int f = ...`（声明），也可能是一个 lambda 表达式语句。
    // tryDeclHead 会试着解析类型再要求一个名字，不成就整体回滚，所以这里放行即可。
    if (t0.kind === 'kw' && t0.value === 'fn') return true;
    const t1 = this.peek(1);
    const typeStart = (t0.kind === 'kw' && BUILTIN_TYPES.has(t0.value)) || t0.kind === 'ident';
    return typeStart && t1.kind === 'ident';
  }

  /** 试探解析 `Type ident` 头部；失败则回滚 token 位置与诊断，返回 null */
  tryDeclHead() {
    if (!this.looksLikeVarDecl()) return null;
    const savePos = this.pos;
    const saveDiags = this.diags.items.length;
    const type = this.parseType();
    const nameTok = this.peek();
    if (nameTok.kind !== 'ident') {
      this.pos = savePos;
      this.diags.items.length = saveDiags;
      return null;
    }
    this.next();
    return { type, nameTok };
  }

  /**
   * `var` / `let` 声明头。`type: null` 表示"类型省略，交给检查器推断"（ADR-0008）。
   * 作用域差异（var 函数作用域 / let 块作用域）记在 `form` 上，由检查器落实。
   */
  parseInferredDecl(consumeSemi) {
    const kw = this.next();
    const n = this.peek();
    if (n.kind !== 'ident') {
      this.error(n.span, `expected variable name after '${kw.value}'`);
      return { kind: 'VarDecl', type: null, form: kw.value, decls: [], span: this.spanFrom(kw) };
    }
    this.next();
    const node = this.parseVarDeclRest(null, n, consumeSemi);
    node.form = kw.value;
    node.span = this.spanFrom(kw);
    return node;
  }

  // ------------------------------------------------------------ 顶层 / 声明

  parseProgram() {
    // 预扫描 struct / class 名，使前向引用的类型也能被识别
    for (let i = 0; i < this.tokens.length - 1; i++) {
      const t = this.tokens[i];
      const isTypeDecl = t.kind === 'kw' && (t.value === 'struct' || t.value === 'class');
      if (isTypeDecl && this.tokens[i + 1].kind === 'ident') {
        this.typeNames.add(this.tokens[i + 1].value);
      }
    }
    const decls = [];
    while (!this.atEof) {
      const before = this.pos;
      const d = this.parseTopLevel();
      if (d) decls.push(d);
      if (this.pos === before) this.next(); // 死循环保险
    }
    return { kind: 'Program', decls };
  }

  parseTopLevel() {
    if (this.at('import')) return this.parseImport();
    if (this.at('private')) {
      const kw = this.next();
      const d = this.parseTopLevel();
      const CAN_HIDE = new Set(['FuncDecl', 'StructDecl', 'ClassDecl', 'VarDecl']);
      if (!d || !CAN_HIDE.has(d.kind)) {
        this.error(kw.span, "'private' can only precede a function, struct, class or variable declaration");
      } else d.isPrivate = true;
      return d;
    }
    if (this.at('struct')) return this.parseAggregate('struct');
    if (this.at('class')) return this.parseAggregate('class');
    if (this.at('var') || this.at('let')) return this.parseInferredDecl(true);
    const head = this.tryDeclHead();
    if (head) {
      if (this.at('(')) return this.parseFuncRest(head.type, head.nameTok, null);
      return this.parseVarDeclRest(head.type, head.nameTok, true);
    }
    return this.parseStatement();
  }

  /**
   * `import "./util";` / `import "std/json";`
   *
   * 只有一种形态：一个带引号的路径，别的什么都没有 —— 没有 `from`、没有名字列表、
   * 没有别名、没有 `import *`。被导入模块的公开顶层名字整体进入导入方的作用域
   * （Asymptote 的 import 模型），要藏的东西由被导入方自己写 `private`，
   * 而不是由导入方挑选。路径的合法形态与解析规则见 ADR-0009 与 module/load.js。
   */
  parseImport() {
    const start = this.expect('import');
    const t = this.peek();
    if (t.kind !== 'str') {
      this.error(t.span, "expected a quoted module path after 'import', e.g. import \"./util\";");
      return { kind: 'Import', path: '', pathSpan: t.span, span: this.spanFrom(start) };
    }
    this.next();
    this.expect(';');
    return { kind: 'Import', path: t.value, pathSpan: t.span, span: this.spanFrom(start) };
  }

  /** struct 与 class 的语法相同；差别在语义（值语义 vs 引用语义 + 方法） */
  parseAggregate(keyword) {
    const start = this.expect(keyword);
    const nameTok = this.peek();
    const name = nameTok.kind === 'ident'
      ? this.next().value
      : (this.error(nameTok.span, `expected ${keyword} name`), '<error>');
    this.typeNames.add(name);
    this.expect('{');
    const fields = [];
    const methods = [];
    while (!this.at('}') && !this.atEof) {
      const before = this.pos;
      const head = this.tryDeclHead();
      if (!head) {
        this.error(this.peek().span, `expected field or method declaration in ${keyword} '${name}'`);
        this.next();
        continue;
      }
      if (this.at('(')) {
        const m = this.parseFuncRest(head.type, head.nameTok, name);
        if (keyword === 'struct') {
          this.error(m.span, `struct '${name}' cannot declare methods; use a free function (UFCS makes it callable as a method)`);
        } else methods.push(m);
      } else {
        fields.push({ type: head.type, name: head.nameTok.value, span: head.nameTok.span });
        this.expect(';');
      }
      if (this.pos === before) this.next();
    }
    this.expect('}');
    this.eat(';');
    const kind = keyword === 'struct' ? 'StructDecl' : 'ClassDecl';
    return { kind, name, fields, methods, span: this.spanFrom(start) };
  }

  /** 头部（返回类型 + 名字）已被消耗；`owner` 非空表示这是 class 方法 */
  parseFuncRest(retType, nameTok, owner) {
    this.expect('(');
    const params = [];
    while (!this.at(')') && !this.atEof) {
      const before = this.pos;
      const type = this.parseType();
      const p = this.peek();
      if (p.kind !== 'ident') { this.error(p.span, 'expected parameter name'); break; }
      this.next();
      let def = null;
      if (this.eat('=')) def = this.parseExpr();
      params.push({ type, name: p.value, def, span: p.span });
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect(')');
    const body = this.parseBlock();
    return { kind: 'FuncDecl', retType, name: nameTok.value, params, body, owner, span: this.spanFrom(nameTok) };
  }

  // ---------------------------------------------------------------- 语句

  parseBlock() {
    const start = this.expect('{');
    const stmts = [];
    while (!this.at('}') && !this.atEof) {
      const before = this.pos;
      const s = this.parseStatement();
      if (s) stmts.push(s);
      if (this.pos === before) this.next();
    }
    this.expect('}');
    return { kind: 'Block', stmts, span: this.spanFrom(start) };
  }

  parseStatement() {
    const t = this.peek();
    if (this.at('{')) return this.parseBlock();
    if (this.at('if')) return this.parseIf();
    if (this.at('while')) return this.parseWhile();
    if (this.at('for')) return this.parseFor();
    if (this.at('return')) {
      this.next();
      const value = this.at(';') ? null : this.parseExpr();
      this.expect(';');
      return { kind: 'Return', value, span: this.spanFrom(t) };
    }
    if (this.at('break')) { this.next(); this.expect(';'); return { kind: 'Break', span: this.spanFrom(t) }; }
    if (this.at('continue')) { this.next(); this.expect(';'); return { kind: 'Continue', span: this.spanFrom(t) }; }
    if (this.at(';')) { this.next(); return null; }
    if (this.at('var') || this.at('let')) return this.parseInferredDecl(true);
    const head = this.tryDeclHead();
    if (head) return this.parseVarDeclRest(head.type, head.nameTok, true);
    const expr = this.parseExpr();
    this.expect(';');
    return { kind: 'ExprStmt', expr, span: this.spanFrom(t) };
  }

  /** `Type a = 1, b;` —— 类型与第一个名字已被 tryDeclHead 消耗 */
  parseVarDeclRest(type, firstName, consumeSemi) {
    const decls = [];
    let n = firstName;
    for (;;) {
      let init = null;
      if (this.eat('=')) init = this.parseExpr();
      decls.push({ name: n.value, init, span: n.span });
      if (!this.eat(',')) break;
      n = this.peek();
      if (n.kind !== 'ident') { this.error(n.span, 'expected variable name'); break; }
      this.next();
    }
    if (consumeSemi) this.expect(';');
    return { kind: 'VarDecl', type, decls, span: this.spanFrom(firstName) };
  }

  parseIf() {
    const start = this.expect('if');
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    const then = this.parseStatement();
    let otherwise = null;
    if (this.eat('else')) otherwise = this.parseStatement();
    return { kind: 'If', cond, then, otherwise, span: this.spanFrom(start) };
  }

  parseWhile() {
    const start = this.expect('while');
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    const body = this.parseStatement();
    return { kind: 'While', cond, body, span: this.spanFrom(start) };
  }

  parseFor() {
    const start = this.expect('for');
    this.expect('(');
    // for-in：`for (T x in expr)`，或省略类型的 `for (var x in expr)` / `for (let x in expr)`
    if ((this.at('var') || this.at('let')) && this.peek(1).kind === 'ident' && this.at('in', 2)) {
      this.next();
      const nameTok = this.next();
      this.next(); // 'in'
      const iterable = this.parseExpr();
      this.expect(')');
      const body = this.parseStatement();
      return {
        kind: 'ForIn',
        varType: null,
        varName: nameTok.value,
        varSpan: nameTok.span,
        iterable,
        body,
        span: this.spanFrom(start),
      };
    }
    let inferredInit = null;
    if (this.at('var') || this.at('let')) inferredInit = this.parseInferredDecl(false);
    const head = inferredInit ? null : this.tryDeclHead();
    if (head && this.at('in')) {
      this.next();
      const iterable = this.parseExpr();
      this.expect(')');
      const body = this.parseStatement();
      return {
        kind: 'ForIn',
        varType: head.type,
        varName: head.nameTok.value,
        varSpan: head.nameTok.span,
        iterable,
        body,
        span: this.spanFrom(start),
      };
    }
    let init = inferredInit;
    if (head) init = this.parseVarDeclRest(head.type, head.nameTok, false);
    else if (!init && !this.at(';')) init = { kind: 'ExprStmt', expr: this.parseExpr(), span: this.peek().span };
    this.expect(';');
    const cond = this.at(';') ? null : this.parseExpr();
    this.expect(';');
    const step = this.at(')') ? null : this.parseExpr();
    this.expect(')');
    const body = this.parseStatement();
    return { kind: 'For', init, cond, step, body, span: this.spanFrom(start) };
  }

  // ---------------------------------------------------------------- 表达式

  parseExpr() {
    return this.parseAssign();
  }

  parseAssign() {
    const left = this.parseTernary();
    const t = this.peek();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.value)) {
      this.next();
      const value = this.parseAssign(); // 右结合
      return { kind: 'Assign', op: t.value, target: left, value, span: span(this.file, left.span.start, value.span.end) };
    }
    return left;
  }

  parseTernary() {
    const cond = this.parseBinary(1);
    if (!this.eat('?')) return cond;
    const then = this.parseAssign();
    this.expect(':');
    const otherwise = this.parseAssign();
    return { kind: 'Ternary', cond, then, otherwise, span: span(this.file, cond.span.start, otherwise.span.end) };
  }

  parseBinary(minPrec) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      // `in` 是关键字形态的二元运算符（成员测试），其余都是标点
      if (t.kind !== 'punct' && !(t.kind === 'kw' && t.value === 'in')) break;
      const prec = BINARY_PREC[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseBinary(prec + 1); // 全部左结合
      left = { kind: 'Binary', op: t.value, left, right, span: span(this.file, left.span.start, right.span.end) };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.kind === 'punct' && (t.value === '-' || t.value === '+' || t.value === '!' || t.value === '~')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'Unary', op: t.value, operand, span: span(this.file, t.span.start, operand.span.end) };
    }
    if (t.kind === 'punct' && (t.value === '++' || t.value === '--')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'IncDec', op: t.value, prefix: true, operand, span: span(this.file, t.span.start, operand.span.end) };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at('(')) {
        expr = this.parseCall(expr);
      } else if (this.at('.')) {
        this.next();
        const n = this.peek();
        if (n.kind !== 'ident') { this.error(n.span, 'expected member name'); break; }
        this.next();
        expr = { kind: 'Member', object: expr, name: n.value, nameSpan: n.span, span: span(this.file, expr.span.start, n.span.end) };
      } else if (this.at('[')) {
        this.next();
        const index = this.parseExpr();
        const close = this.expect(']');
        expr = { kind: 'Index', object: expr, index, span: span(this.file, expr.span.start, close.span.end) };
      } else if (this.at('++') || this.at('--')) {
        const op = this.next();
        expr = { kind: 'IncDec', op: op.value, prefix: false, operand: expr, span: span(this.file, expr.span.start, op.span.end) };
      } else break;
    }
    return expr;
  }

  /** 实参支持 Asymptote 风格命名实参：`f(y=2, x=1)` */
  parseCall(callee) {
    this.expect('(');
    const args = [];
    while (!this.at(')') && !this.atEof) {
      let name = null;
      if (this.peek().kind === 'ident' && this.at('=', 1) && !this.at('==', 1)) {
        name = this.next().value;
        this.next(); // '='
      }
      const expr = this.parseExpr();
      args.push({ name, expr, span: expr.span });
      if (!this.eat(',')) break;
    }
    const close = this.expect(')');
    return { kind: 'Call', callee, args, span: span(this.file, callee.span.start, close.span.end) };
  }

  parsePrimary() {
    const t = this.peek();
    switch (t.kind) {
      case 'int': this.next(); return { kind: 'IntLit', value: t.value, span: t.span };
      case 'real': this.next(); return { kind: 'RealLit', value: t.value, span: t.span };
      case 'str': this.next(); return { kind: 'StrLit', value: t.value, span: t.span };
      case 'bool': this.next(); return { kind: 'BoolLit', value: t.value, span: t.span };
      case 'ident': this.next(); return { kind: 'Name', name: t.value, span: t.span };
      default: break;
    }
    if (this.at('null')) { this.next(); return { kind: 'NullLit', span: t.span }; }
    if (this.at('fn')) return this.parseLambda();
    if (this.at('new')) {
      this.next();
      const type = this.parseType();
      const args = [];
      if (this.eat('(')) {
        while (!this.at(')') && !this.atEof) {
          args.push({ name: null, expr: this.parseExpr(), span: this.peek().span });
          if (!this.eat(',')) break;
        }
        this.expect(')');
      }
      return { kind: 'New', type, args, span: this.spanFrom(t) };
    }
    // list 字面量 `[a, b, c]`
    if (this.at('[')) {
      this.next();
      const items = [];
      while (!this.at(']') && !this.atEof) {
        items.push(this.parseExpr());
        if (!this.eat(',')) break;
      }
      this.expect(']');
      return { kind: 'ListLit', items, span: this.spanFrom(t) };
    }
    // dict 字面量 `{k: v, ...}` / 空 dict `{:}`
    // 注意：语句位置的 `{` 永远是块（parseStatement 先拦），只有表达式位置才走到这里（ADR-0006）
    if (this.at('{')) {
      this.next();
      const entries = [];
      if (this.eat(':')) {
        this.expect('}');
        return { kind: 'DictLit', entries, span: this.spanFrom(t) };
      }
      while (!this.at('}') && !this.atEof) {
        const key = this.parseExpr();
        this.expect(':');
        const value = this.parseExpr();
        entries.push({ key, value });
        if (!this.eat(',')) break;
      }
      this.expect('}');
      return { kind: 'DictLit', entries, span: this.spanFrom(t) };
    }
    if (this.at('(')) {
      this.next();
      const inner = this.parseExpr();
      this.expect(')');
      return inner;
    }
    // 内建类型名当转换函数用：int(x) / real(x) / string(x)；set(...) 构造集合
    if (t.kind === 'kw' && (BUILTIN_TYPES.has(t.value) || t.value === 'set')) {
      this.next();
      return { kind: 'Name', name: t.value, span: t.span };
    }
    this.error(t.span, `expected expression, found ${describe(t)}`);
    this.next();
    return { kind: 'IntLit', value: 0n, span: t.span };
  }
}

function describe(t) {
  if (t.kind === 'eof') return 'end of file';
  if (t.kind === 'str') return 'string literal';
  return `'${t.text}'`;
}

/**
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 */
export function parse(file, diags) {
  return new Parser(file, diags).parseProgram();
}
