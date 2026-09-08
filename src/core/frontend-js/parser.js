// Omni stage0 — JS 语法前端：语法分析
//
// 产出一个 ESTree 的**子集**（字段名刻意贴近 ESTree，方便对着规范核对），覆盖范围由
// `src/core` 里实际写过的 JS 决定。没覆盖的语法一律报错：这个前端要么给出正确的 AST，
// 要么明确拒绝，绝不"大概解析对了"—— 后者的 bug 会以几万行生成 C 里的段错误现身。
//
// 不支持（因为仓库里没写过）：async/await、生成器、标签、`with`、类的私有字段 `#x`、装饰器。
// **闸门是"能解析仓库里所有自己写的 js"**（编译器、测试脚本、bench 都算），所以哪天代码里
// 写了新语法，这里就得跟上 —— `do...while`（parser.js 自己的 varDecl 用了它）和 `delete`
// （tests/js-roundtrip/run.js 用了它）都是这么被加进来的。
//
// ASI 只按需要的两条实现：
//   1. 语句末尾的 `;` 在下一个 token 是 `}` / eof / 前面有换行时可省。
//   2. `return` / `throw` / `break` / `continue` 的受限产生式：换行就没有操作数。

import { lexJs } from './lexer.js';
import { span } from '../source/diag.js';

/** 二元运算符优先级。`**` 右结合，单独标出来。 */
const BINARY = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '|': 4,
  '^': 5,
  '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, in: 8, instanceof: 8,
  '<<': 9, '>>': 9, '>>>': 9,
  '+': 10, '-': 10,
  '*': 11, '/': 11, '%': 11,
  '**': 12,
};

const LOGICAL = new Set(['&&', '||', '??']);
const UNARY = new Set(['!', '~', '+', '-', 'typeof', 'void', 'delete']);
const ASSIGN_OPS_JS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
]);

// 名字带 Js 前缀：链接之后（frontend-js/link.js）所有模块级名字进同一个作用域，
// 而 parse/parser.js 里已经有一个 Parser 了 —— 两个同名的类在那里是硬错误。
class JsParser {
  constructor(file, diags) {
    this.file = file;
    this.diags = diags;
    const lexed = lexJs(file, diags);
    this.tokens = lexed.tokens;
    this.hashbang = lexed.hashbang;
    this.pos = 0;
  }

  // ------------------------------------------------------------ token 层

  peek(k = 0) { return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]; }

  // 都是方法而不是 getter：getter 不在 JS 子集里（ADR-0011 决策 13），自举要过这一关
  cur() { return this.peek(); }

  atEof() { return this.cur().kind === 'eof'; }

  next() { return this.tokens[this.pos++]; }

  /** 关键字与标点用同一个 `at`：两者都靠 `value` 区分，调用点因此不用记 kind */
  at(value, k = 0) {
    const t = this.peek(k);
    return (t.kind === 'punct' || t.kind === 'kw') && t.value === value;
  }

  /* 上下文关键字（`async` / `await`）：它们在 JS 里**词法上是普通标识符** —— `async` 可以
     当变量名，`await` 在非 async 函数里也是名字。所以不进 KEYWORDS_JS，靠调用点多问一句。 */
  atWord(w, k = 0) {
    const t = this.peek(k);
    return t.kind === 'ident' && t.value === w;
  }

  /** `await e`（ADR-0020 P2）：后面得真能开始一个表达式，否则 `await` 就是个名字 */
  awaitAhead() {
    if (!this.atWord('await')) return false;
    const t = this.peek(1);
    if (t.kind === 'eof' || t.nl === true) return false;
    if (t.kind === 'punct') return ['(', '[', '{', '!', '-', '+', '~', '...'].includes(t.value);
    return true;
  }

  eat(value) {
    if (!this.at(value)) return null;
    return this.next();
  }

  expect(value) {
    if (this.at(value)) return this.next();
    this.error(this.cur().span, `expected '${value}', found ${describeTokJs(this.cur())}`);
    return this.cur();
  }

  error(sp, msg) {
    this.diags.error(sp, msg);
  }

  /** 从 `startTok` 到"上一个已消耗的 token"的范围 */
  spanFrom(startTok) {
    const end = this.tokens[Math.max(0, this.pos - 1)];
    return span(this.file, startTok.span.start, end.span.end);
  }

  /** 语句末尾的分号。ASI：`}`、eof、或下一个 token 前面有换行时可以没有分号。 */
  semicolon() {
    if (this.eat(';')) return;
    if (this.at('}') || this.atEof() || this.cur().nl) return;
    this.error(this.cur().span, `expected ';' after statement, found ${describeTokJs(this.cur())}`);
    this.next(); // 吃掉一个，保证外层循环有进展
  }

  // ------------------------------------------------------------ 顶层

  parseProgram() {
    const body = [];
    while (!this.atEof()) {
      const before = this.pos;
      const s = this.statement();
      if (s) body.push(s);
      if (this.pos === before) this.next(); // 死循环保险
    }
    return { type: 'Program', hashbang: this.hashbang, body };
  }

  // ------------------------------------------------------------ 语句

  statement() {
    const t = this.cur();
    if (t.kind === 'punct') {
      if (t.value === '{') return this.block();
      if (t.value === ';') { this.next(); return { type: 'Empty', span: t.span }; }
    }
    if (t.kind === 'kw') {
      switch (t.value) {
        case 'const': case 'let': case 'var': return this.varDecl(true);
        case 'function': return this.funcDecl();
        case 'class': return this.classDecl();
        case 'if': return this.ifStmt();
        case 'for': return this.forStmt();
        case 'while': return this.whileStmt();
        case 'do': return this.doWhileStmt();
        case 'return': case 'throw': return this.returnLike();
        case 'break': case 'continue': return this.breakLike();
        case 'try': return this.tryStmt();
        case 'switch': return this.switchStmt();
        // `import.meta.url` 也以 import 开头，但它是表达式；靠下一个 token 分流
        case 'import': return this.at('.', 1) ? this.exprStatement() : this.importDecl();
        case 'export': return this.exportDecl();
        default: break;
      }
    }
    // `async function f() {}`（ADR-0020 P2）：async 是上下文关键字，只有紧跟 function 才分流
    if (this.atWord('async') && this.at('function', 1) && this.peek(1).nl !== true) return this.funcDecl();
    // `L: for (…)` —— 带标签的循环。靠下一个 token 是 `:` 分流（`x: 1` 那种对象字面量
    // 的键值对不会走到这里，它在表达式里）
    if (t.kind === 'ident' && this.at(':', 1)) return this.labeled();
    return this.exprStatement();
  }

  /**
   * 带标签的语句。只收**循环**上的标签：`break L` / `continue L` 会被降级成 OIR 的
   * 多层 Break/Continue（level），而 OIR 的 level 数的就是循环层数。标签打在块上
   * （`L: { … break L; }`）没有这个落点，当场拒 —— 那要的是"跳出一个块"，
   * 结构化控制流里没有这条边。
   */
  labeled() {
    const start = this.next();
    this.expect(':');
    const body = this.statement();
    const loop = body.type === 'For' || body.type === 'ForOf' || body.type === 'ForIn'
      || body.type === 'While' || body.type === 'DoWhile';
    const sp = this.spanFrom(start);
    if (loop) return { type: 'Labeled', label: start.value, body, span: sp };
    /* 标签打在**块**上（`L: { … break L; }`）：摊成 `L: while (true) { … ; break; }` ——
     * 于是 `break L` 还是"跳出一层循环"那条现成的边。降级器认 block 这一位：
     * `continue L` 在规范里就是 SyntaxError，摊完之后它会变成死循环，所以要挡住。 */
    if (body.type !== 'Block') {
      this.error(sp, 'a label is only supported on a loop or a block');
    }
    const once = {
      type: 'While',
      test: { type: 'Lit', value: true, span: sp },
      body: { type: 'Block', body: [...body.body, { type: 'Break', label: null, span: sp }], span: sp },
      span: sp,
    };
    return { type: 'Labeled', label: start.value, body: once, block: true, span: sp };
  }

  exprStatement() {
    const expr = this.expression();
    this.semicolon();
    return { type: 'ExprStmt', expr, span: expr.span };
  }

  block() {
    const start = this.expect('{');
    const body = [];
    while (!this.at('}') && !this.atEof()) {
      const before = this.pos;
      const s = this.statement();
      if (s) body.push(s);
      if (this.pos === before) this.next();
    }
    this.expect('}');
    return { type: 'Block', body, span: this.spanFrom(start) };
  }

  /** `const`/`let`/`var`。`eatSemi` 为假时是 for 的头部，分号由 for 自己处理。 */
  varDecl(eatSemi) {
    const start = this.next(); // const / let / var
    const decls = [];
    do {
      const id = this.bindingTarget();
      let init = null;
      if (this.eat('=')) init = this.assignExpr();
      decls.push({ id, init });
    } while (this.eat(','));
    if (eatSemi) this.semicolon();
    return { type: 'VarDecl', kind: start.value, decls, span: this.spanFrom(start) };
  }

  funcDecl() {
    const start = this.cur();
    // `async function`（ADR-0020 P2）：async 是上下文关键字，同一行紧跟 function 才算
    const isAsync = this.atWord('async') && this.at('function', 1);
    if (isAsync) this.next();
    this.expect('function');
    // `function*`（ADR-0020 P2）：生成器只是函数上的一格标记，体的解析一模一样
    const generator = !!this.eat('*');
    const id = this.identName('function name');
    const { params, rest } = this.paramList();
    const body = this.block();
    return { type: 'FuncDecl', id, params, rest, body, generator, async: isAsync, span: this.spanFrom(start) };
  }

  classDecl() {
    const start = this.expect('class');
    const id = this.identName('class name');
    const superClass = this.eat('extends') ? this.unaryOrCall() : null;
    const members = this.classBody();
    return { type: 'ClassDecl', id, superClass, members, span: this.spanFrom(start) };
  }

  classBody() {
    this.expect('{');
    const members = [];
    while (!this.at('}') && !this.atEof()) {
      const before = this.pos;
      if (this.eat(';')) continue;
      const mStart = this.cur();
      const isStatic = this.at('static') && !this.at('(', 1) && !this.at('=', 1) ? !!this.next() : false;
      /* static 初始化块（ADR-0020 P4）：`static { … }` —— 没有名字也没有形参，就是
         "类定义那一刻跑一段，this 是类对象"。收成一格 staticBlock 成员。 */
      if (isStatic && this.at('{')) {
        const body = this.block();
        members.push({
          kind: 'staticBlock', static: true, key: null, computed: false, body, span: this.spanFrom(mStart),
        });
        continue;
      }
      /* async 方法（ADR-0020 P2）：`async m() {}` / `static async *m() {}`。
         `async` 自己也可以是方法名（`async() {}`），所以后面紧跟 `(` / `=` 时不算。 */
      const isAsyncM = this.atWord('async')
        && !this.at('(', 1) && !this.at('=', 1) && !this.at(';', 1) && !this.at('}', 1)
        ? !!this.next() : false;
      // getter/setter：`get` / `set` 本身也可以是方法名，所以要看下一个 token
      let kind = 'method';
      if ((this.cur().kind === 'ident') && (this.cur().value === 'get' || this.cur().value === 'set')
          && !this.at('(', 1) && !this.at('=', 1) && !this.at(';', 1) && !this.at('}', 1)) {
        kind = this.next().value;
      }
      // 生成器方法（ADR-0020 P2）：`*m() {}` / `static *m() {}` / `*[Symbol.iterator]() {}`
      const generator = kind === 'method' ? !!this.eat('*') : false;
      const { key, computed } = this.propertyKey();
      if (this.at('(')) {
        const { params, rest } = this.paramList();
        const body = this.block();
        members.push({ kind, static: isStatic, key, computed, params, rest, body, generator, async: isAsyncM, span: this.spanFrom(mStart) });
      } else {
        // 类字段。`static x = 1` 用得到，实例字段 stage0 里没有，但语法一样，一起收下
        const value = this.eat('=') ? this.assignExpr() : null;
        this.semicolon();
        members.push({ kind: 'field', static: isStatic, key, computed, value, span: this.spanFrom(mStart) });
      }
      if (this.pos === before) this.next();
    }
    this.expect('}');
    return members;
  }

  ifStmt() {
    const start = this.expect('if');
    this.expect('(');
    const test = this.expression();
    this.expect(')');
    const cons = this.statement();
    const alt = this.eat('else') ? this.statement() : null;
    return { type: 'If', test, cons, alt, span: this.spanFrom(start) };
  }

  whileStmt() {
    const start = this.expect('while');
    this.expect('(');
    const test = this.expression();
    this.expect(')');
    const body = this.statement();
    return { type: 'While', test, body, span: this.spanFrom(start) };
  }

  /** `do S while (e);` —— 结尾的分号按规范可以被 ASI 省掉，所以走 semicolon() 而不是 expect */
  doWhileStmt() {
    const start = this.expect('do');
    const body = this.statement();
    this.expect('while');
    this.expect('(');
    const test = this.expression();
    this.expect(')');
    this.semicolon();
    return { type: 'DoWhile', body, test, span: this.spanFrom(start) };
  }

  /**
   * `for` 的三种形态共用一个头部。区分点在读完第一段之后看是 `of` / `in` 还是 `;`。
   * `for (const x of xs)` 里 `x` 是绑定目标而不是表达式，所以不能先当表达式解析再回头改。
   */
  forStmt() {
    const start = this.expect('for');
    // `for await (const v of xs)`（ADR-0020 P2）：只有 for-of 有这一格
    const isAwait = this.atWord('await') ? !!this.next() : false;
    this.expect('(');
    let init = null;
    let declKind = null;
    let left = null;

    if (this.at(';')) {
      this.next();
    } else if (this.at('const') || this.at('let') || this.at('var')) {
      declKind = this.cur().value;
      const kwTok = this.next();
      left = this.bindingTarget();
      if (this.at('of') || this.at('in')) {
        const kind = this.next().value;
        const right = this.assignExpr();
        this.expect(')');
        const body = this.statement();
        return { type: kind === 'of' ? 'ForOf' : 'ForIn', declKind, left, right, body, await: isAwait, span: this.spanFrom(start) };
      }
      // 普通 for：回到 varDecl 的路子，把已经读掉的第一个绑定接上
      const decls = [];
      let firstInit = this.eat('=') ? this.assignExpr() : null;
      decls.push({ id: left, init: firstInit });
      while (this.eat(',')) {
        const id = this.bindingTarget();
        decls.push({ id, init: this.eat('=') ? this.assignExpr() : null });
      }
      init = { type: 'VarDecl', kind: declKind, decls, span: this.spanFrom(kwTok) };
      this.expect(';');
    } else {
      const e = this.expression();
      if (this.at('of') || this.at('in')) {
        const kind = this.next().value;
        const right = this.assignExpr();
        this.expect(')');
        const body = this.statement();
        return {
          type: kind === 'of' ? 'ForOf' : 'ForIn',
          declKind: null, left: this.toPattern(e), right, body, await: isAwait, span: this.spanFrom(start),
        };
      }
      init = { type: 'ExprStmt', expr: e, span: e.span };
      this.expect(';');
    }

    const test = this.at(';') ? null : this.expression();
    this.expect(';');
    const update = this.at(')') ? null : this.expression();
    this.expect(')');
    const body = this.statement();
    return { type: 'For', init, test, update, body, span: this.spanFrom(start) };
  }

  /** `return` / `throw` —— 受限产生式：换行就意味着没有操作数（`throw` 除外，它必须有） */
  returnLike() {
    const start = this.next();
    const kw = start.value;
    let arg = null;
    if (!this.at(';') && !this.at('}') && !this.atEof() && !this.cur().nl) arg = this.expression();
    if (kw === 'throw' && !arg) this.error(start.span, "'throw' needs an operand on the same line");
    this.semicolon();
    return { type: kw === 'return' ? 'Return' : 'Throw', arg, span: this.spanFrom(start) };
  }

  breakLike() {
    const start = this.next();
    // `break L;` / `continue L;`：标签必须在同一行（受限产生式，和 return 一样）
    let label = null;
    if (this.cur().kind === 'ident' && !this.cur().nl) label = this.next().value;
    this.semicolon();
    return { type: start.value === 'break' ? 'Break' : 'Continue', label, span: this.spanFrom(start) };
  }

  tryStmt() {
    const start = this.expect('try');
    const block = this.block();
    let param = null;
    let handler = null;
    if (this.eat('catch')) {
      if (this.eat('(')) {
        param = this.bindingTarget();
        this.expect(')');
      }
      handler = this.block();
    }
    const finalizer = this.eat('finally') ? this.block() : null;
    if (!handler && !finalizer) this.error(this.spanFrom(start), "'try' needs a 'catch' or a 'finally'");
    return { type: 'Try', block, param, handler, finalizer, span: this.spanFrom(start) };
  }

  switchStmt() {
    const start = this.expect('switch');
    this.expect('(');
    const disc = this.expression();
    this.expect(')');
    this.expect('{');
    const cases = [];
    while (!this.at('}') && !this.atEof()) {
      const before = this.pos;
      let test = null;
      if (this.eat('case')) test = this.expression();
      else this.expect('default');
      this.expect(':');
      const body = [];
      while (!this.at('case') && !this.at('default') && !this.at('}') && !this.atEof()) {
        const b2 = this.pos;
        const s = this.statement();
        if (s) body.push(s);
        if (this.pos === b2) this.next();
      }
      cases.push({ test, body });
      if (this.pos === before) this.next();
    }
    this.expect('}');
    return { type: 'Switch', disc, cases, span: this.spanFrom(start) };
  }

  /**
   * ESM 的 import。`import.meta.url` 也以 `import` 开头，但那是表达式 —— 由 statement()
   * 提前分流，这里只处理声明形态。
   */
  importDecl() {
    const start = this.expect('import');
    /** @type {{kind: string, imported: string|null, local: string}[]} */
    const specifiers = [];
    if (this.cur().kind === 'str') {
      // `import "./x.js";` 副作用导入
      const source = this.next().value;
      this.semicolon();
      return { type: 'ImportDecl', specifiers, source, span: this.spanFrom(start) };
    }
    if (this.cur().kind === 'ident') {
      specifiers.push({ kind: 'default', imported: null, local: this.next().value });
      this.eat(',');
    }
    if (this.at('*')) {
      this.next();
      if (this.cur().kind === 'ident' && this.cur().value === 'as') this.next();
      else this.error(this.cur().span, "expected 'as' after '*' in import");
      specifiers.push({ kind: 'namespace', imported: null, local: this.identName('namespace name') });
    } else if (this.eat('{')) {
      while (!this.at('}') && !this.atEof()) {
        const before = this.pos;
        const imported = this.identName('imported name');
        let local = imported;
        if (this.cur().kind === 'ident' && this.cur().value === 'as') { this.next(); local = this.identName('local name'); }
        specifiers.push({ kind: 'named', imported, local });
        if (!this.eat(',')) break;
        if (this.pos === before) break;
      }
      this.expect('}');
    }
    if (this.cur().kind === 'ident' && this.cur().value === 'from') this.next();
    else this.error(this.cur().span, "expected 'from' in import declaration");
    let source = '';
    if (this.cur().kind === 'str') source = this.next().value;
    else this.error(this.cur().span, 'expected a quoted module path');
    this.semicolon();
    return { type: 'ImportDecl', specifiers, source, span: this.spanFrom(start) };
  }

  exportDecl() {
    const start = this.expect('export');
    if (this.eat('{')) {
      const specifiers = [];
      while (!this.at('}') && !this.atEof()) {
        const before = this.pos;
        const local = this.identName('exported name');
        let exported = local;
        if (this.cur().kind === 'ident' && this.cur().value === 'as') { this.next(); exported = this.identName('export alias'); }
        specifiers.push({ local, exported });
        if (!this.eat(',')) break;
        if (this.pos === before) break;
      }
      this.expect('}');
      let source = null;
      if (this.cur().kind === 'ident' && this.cur().value === 'from') {
        this.next();
        source = this.cur().kind === 'str' ? this.next().value : '';
      }
      this.semicolon();
      return { type: 'ExportNamed', specifiers, source, span: this.spanFrom(start) };
    }
    if (this.at('default')) {
      this.next();
      const value = this.assignExpr();
      this.semicolon();
      return { type: 'ExportDefault', value, span: this.spanFrom(start) };
    }
    const decl = this.statement();
    return { type: 'ExportDecl', decl, span: this.spanFrom(start) };
  }

  // ------------------------------------------------------------ 名字与绑定目标

  /** 只接受标识符的位置（函数名、类名、导入名…） */
  identName(what) {
    if (this.cur().kind === 'ident') return this.next().value;
    this.error(this.cur().span, `expected ${what}, found ${describeTokJs(this.cur())}`);
    return '<error>';
  }

  /** `.` 之后、以及对象字面量/类成员的名字位置：关键字与 null/true/false 在这里都是普通名字 */
  memberName() {
    const t = this.cur();
    if (t.kind === 'ident' || t.kind === 'kw') return this.next().value;
    if (t.kind === 'lit') { this.next(); return String(t.value); }
    this.error(t.span, `expected a property name, found ${describeTokJs(t)}`);
    return '<error>';
  }

  /** 对象字面量与类成员的键。返回 {key, computed}。 */
  propertyKey() {
    if (this.eat('[')) {
      const key = this.assignExpr();
      this.expect(']');
      return { key, computed: true };
    }
    const t = this.cur();
    if (t.kind === 'str') { this.next(); return { key: { type: 'Str', value: t.value, span: t.span }, computed: false }; }
    if (t.kind === 'num') { this.next(); return { key: { type: 'Num', value: t.value, raw: t.raw, span: t.span }, computed: false }; }
    const name = this.memberName();
    return { key: { type: 'Ident', name, span: t.span }, computed: false };
  }

  /** 绑定目标：标识符、数组解构、对象解构。用在声明、参数、catch、for-of 上。 */
  bindingTarget() {
    const t = this.cur();
    if (this.at('[')) return this.arrayPattern();
    if (this.at('{')) return this.objectPattern();
    return { type: 'Ident', name: this.identName('a binding name'), span: t.span };
  }

  arrayPattern() {
    const start = this.expect('[');
    const elements = [];
    let rest = null;
    while (!this.at(']') && !this.atEof()) {
      const before = this.pos;
      if (this.at(',')) { this.next(); elements.push(null); continue; } // 空洞
      if (this.eat('...')) { rest = this.bindingTarget(); break; }
      let el = this.bindingTarget();
      if (this.eat('=')) el = { type: 'AssignPattern', left: el, right: this.assignExpr(), span: el.span };
      elements.push(el);
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect(']');
    return { type: 'ArrayPattern', elements, rest, span: this.spanFrom(start) };
  }

  objectPattern() {
    const start = this.expect('{');
    const props = [];
    let rest = null;
    while (!this.at('}') && !this.atEof()) {
      const before = this.pos;
      if (this.eat('...')) { rest = this.bindingTarget(); break; }
      const { key, computed } = this.propertyKey();
      let value = this.eat(':') ? this.bindingTarget() : { type: 'Ident', name: key.name, span: key.span };
      if (this.eat('=')) value = { type: 'AssignPattern', left: value, right: this.assignExpr(), span: value.span };
      props.push({ key, computed, value });
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect('}');
    return { type: 'ObjectPattern', props, rest, span: this.spanFrom(start) };
  }

  /** 形参表。默认值与 `...rest` 都支持。 */
  paramList() {
    this.expect('(');
    const params = [];
    let rest = null;
    while (!this.at(')') && !this.atEof()) {
      const before = this.pos;
      if (this.eat('...')) { rest = this.bindingTarget(); break; }
      let p = this.bindingTarget();
      if (this.eat('=')) p = { type: 'AssignPattern', left: p, right: this.assignExpr(), span: p.span };
      params.push(p);
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect(')');
    return { params, rest };
  }

  // ------------------------------------------------------------ 表达式

  /** 逗号表达式。只在 `for` 的头部和极少数地方出现。 */
  expression() {
    const first = this.assignExpr();
    if (!this.at(',')) return first;
    const exprs = [first];
    while (this.eat(',')) exprs.push(this.assignExpr());
    return { type: 'Seq', exprs, span: span(this.file, first.span.start, exprs[exprs.length - 1].span.end) };
  }

  /**
   * 箭头函数是这门语言里唯一需要**往前看到匹配括号之后**的地方：`(a, b)` 到底是括号表达式
   * 还是形参表，只有看到后面有没有 `=>` 才知道。这里不做回溯，直接数括号往前看 ——
   * 回溯要连诊断一起回滚，容易漏，而且 `(` 嵌套很深时是指数级。
   */
  arrowAhead(base = 0) {
    if (this.peek(base).kind === 'ident' && this.at('=>', base + 1)) return true;
    if (!this.at('(', base)) return false;
    let depth = 0;
    for (let k = base; ; k++) {
      const t = this.peek(k);
      if (t.kind === 'eof') return false;
      if (t.kind === 'punct') {
        if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
        else if (t.value === ')' || t.value === ']' || t.value === '}') {
          depth--;
          if (depth === 0) return this.at('=>', k + 1);
        }
      }
    }
  }

  assignExpr() {
    /* `yield` / `yield*`（ADR-0020 P2）：优先级最低（比赋值还低），所以在这一层的最前面
       认。`yield` 后面可以什么都没有（`yield;` / `yield }`），那时值是 undefined ——
       靠"同一行还有没有能开始表达式的 token"判断。解析器不跟踪"在不在生成器体里"，
       那一条由降级器查（它知道自己在哪个函数里）。 */
    if (this.at('yield')) {
      const start = this.next();
      const delegate = !!this.eat('*');
      const t = this.cur();
      const bare = t.nl === true || t.kind === 'eof'
        || (t.kind === 'punct' && [')', ']', '}', ',', ';', ':'].includes(t.value));
      const arg = bare && !delegate ? null : this.assignExpr();
      return { type: 'Yield', arg, delegate, span: this.spanFrom(start) };
    }
    if (this.arrowAhead()) return this.arrow(null, false);
    // `async x => …` / `async (a, b) => …`（ADR-0020 P2）
    if (this.atWord('async') && this.peek(1).nl !== true && this.arrowAhead(1)) {
      return this.arrow(this.next(), true);
    }
    const left = this.conditional();
    const t = this.cur();
    if (t.kind === 'punct' && ASSIGN_OPS_JS.has(t.value)) {
      this.next();
      const value = this.assignExpr();
      const target = t.value === '=' ? this.toPattern(left) : left;
      if (!isAssignable(target)) this.error(left.span, 'left-hand side of assignment is not assignable');
      return { type: 'Assign', op: t.value, target, value, span: span(this.file, left.span.start, value.span.end) };
    }
    return left;
  }

  arrow(startTok, isAsync) {
    const start = startTok === null || startTok === undefined ? this.cur() : startTok;
    let params;
    let rest = null;
    if (this.cur().kind === 'ident') {
      const p = this.next();
      params = [{ type: 'Ident', name: p.value, span: p.span }];
    } else {
      const pl = this.paramList();
      params = pl.params;
      rest = pl.rest;
    }
    this.expect('=>');
    if (this.at('{')) {
      const body = this.block();
      return { type: 'Arrow', params, rest, body, expression: false, async: isAsync === true, span: this.spanFrom(start) };
    }
    const body = this.assignExpr();
    return { type: 'Arrow', params, rest, body, expression: true, async: isAsync === true, span: this.spanFrom(start) };
  }

  conditional() {
    const test = this.binary(0);
    if (!this.at('?')) return test;
    this.next();
    const cons = this.assignExpr();
    this.expect(':');
    const alt = this.assignExpr();
    return { type: 'Cond', test, cons, alt, span: span(this.file, test.span.start, alt.span.end) };
  }

  /** 优先级爬升。`**` 右结合；`??` 不允许和 `&&`/`||` 不加括号混用（规范如此，照做）。 */
  binary(minPrec) {
    let left = this.unary();
    for (;;) {
      const t = this.cur();
      const op = (t.kind === 'punct' || t.kind === 'kw') ? t.value : null;
      // hasOwn 而不是直接索引：`BINARY['toString']` 会摸到 Object.prototype 上的函数。
      // 这里 op 只可能是标点或关键字，摸不到；但同一个坑在词法器里真的踩过（见 LITERAL_WORDS），
      // 所以凡是"用外部字符串索引对象字面量"的地方一律加护栏。
      const prec = op !== null && Object.hasOwn(BINARY, op) ? BINARY[op] : undefined;
      if (prec === undefined || prec <= minPrec) return left;
      this.next();
      const right = op === '**' ? this.binary(prec - 1) : this.binary(prec);
      if (LOGICAL.has(op)) {
        if (op === '??' && (left.type === 'Logical' && (left.op === '&&' || left.op === '||'))) {
          this.error(t.span, "'??' cannot be mixed with '&&' or '||' without parentheses");
        }
        left = { type: 'Logical', op, left, right, span: span(this.file, left.span.start, right.span.end) };
      } else {
        left = { type: 'Binary', op, left, right, span: span(this.file, left.span.start, right.span.end) };
      }
    }
  }

  unary() {
    const t = this.cur();
    /* `await e`（ADR-0020 P2）：优先级与一元运算符同级。解析器不跟踪"在不在 async 体里"
       （与 yield 同一个立场）—— 那一条由降级器查，它知道自己在哪个函数里。 */
    if (this.awaitAhead()) {
      this.next();
      const arg = this.unary();
      return { type: 'Await', arg, span: this.spanFrom(t) };
    }
    const op = (t.kind === 'punct' || t.kind === 'kw') ? t.value : null;
    if (op !== null && UNARY.has(op)) {
      this.next();
      const arg = this.unary();
      return { type: 'Unary', op, arg, span: this.spanFrom(t) };
    }
    if (op === '++' || op === '--') {
      this.next();
      const arg = this.unary();
      if (!isAssignable(arg)) this.error(arg.span, `operand of '${op}' is not assignable`);
      return { type: 'Update', op, arg, prefix: true, span: this.spanFrom(t) };
    }
    return this.postfix();
  }

  postfix() {
    const e = this.callChain(this.newOrPrimary());
    const t = this.cur();
    // 受限产生式：`a\n++b` 里的 `++` 属于下一行，不是 a 的后缀
    if (t.kind === 'punct' && (t.value === '++' || t.value === '--') && !t.nl) {
      this.next();
      if (!isAssignable(e)) this.error(e.span, `operand of '${t.value}' is not assignable`);
      return { type: 'Update', op: t.value, arg: e, prefix: false, span: span(this.file, e.span.start, t.span.end) };
    }
    return e;
  }

  /** `new X.Y(a)`：`new` 的参数表绑得比后续的调用紧，所以成员链要单独走一遍 */
  newOrPrimary() {
    if (!this.at('new')) return this.primary();
    const start = this.next();
    // `new.target`（ADR-0020）：语法上是一格"元属性"，不是成员访问
    if (this.at('.')) {
      this.next();
      const name = this.memberName();
      if (name !== 'target') this.error(this.spanFrom(start), "only 'new.target' is a valid meta property");
      return { type: 'NewTarget', span: this.spanFrom(start) };
    }
    let callee = this.newOrPrimary();
    // 只吃成员访问，不吃调用 —— `new a.b()` 的 `()` 是 new 的实参表
    for (;;) {
      if (this.eat('.')) {
        const name = this.memberName();
        callee = { type: 'Member', object: callee, name, computed: false, optional: false, span: this.spanFrom(start) };
      } else if (this.eat('[')) {
        const prop = this.expression();
        this.expect(']');
        callee = { type: 'Member', object: callee, prop, computed: true, optional: false, span: this.spanFrom(start) };
      } else break;
    }
    const args = this.at('(') ? this.argList() : [];
    return { type: 'New', callee, args, span: this.spanFrom(start) };
  }

  /** 用在 `extends` 之后：一个不含调用的成员链就够（`class A extends B.C {}`） */
  unaryOrCall() {
    return this.callChain(this.newOrPrimary());
  }

  /** `.x` / `?.x` / `[e]` / `(args)` / 标签模板，左结合地串起来 */
  callChain(e) {
    for (;;) {
      const start = e.span;
      if (this.eat('.')) {
        const name = this.memberName();
        e = { type: 'Member', object: e, name, computed: false, optional: false, span: span(this.file, start.start, this.tokens[this.pos - 1].span.end) };
        continue;
      }
      if (this.at('?.')) {
        this.next();
        if (this.at('(')) {
          const args = this.argList();
          e = { type: 'Call', callee: e, args, optional: true, span: span(this.file, start.start, this.tokens[this.pos - 1].span.end) };
        } else if (this.eat('[')) {
          const prop = this.expression();
          this.expect(']');
          e = { type: 'Member', object: e, prop, computed: true, optional: true, span: span(this.file, start.start, this.tokens[this.pos - 1].span.end) };
        } else {
          const name = this.memberName();
          e = { type: 'Member', object: e, name, computed: false, optional: true, span: span(this.file, start.start, this.tokens[this.pos - 1].span.end) };
        }
        continue;
      }
      if (this.eat('[')) {
        const prop = this.expression();
        this.expect(']');
        e = { type: 'Member', object: e, prop, computed: true, optional: false, span: span(this.file, start.start, this.tokens[this.pos - 1].span.end) };
        continue;
      }
      if (this.at('(')) {
        const args = this.argList();
        e = { type: 'Call', callee: e, args, optional: false, span: span(this.file, start.start, this.tokens[this.pos - 1].span.end) };
        continue;
      }
      // 标签模板：`String.raw\`...\``。tag 挂在模板节点上，生成时要原样还原。
      if (this.cur().kind === 'tmpl_full' || this.cur().kind === 'tmpl_head') {
        const tpl = this.template();
        tpl.tag = e;
        tpl.span = span(this.file, start.start, tpl.span.end);
        e = tpl;
        continue;
      }
      return e;
    }
  }

  argList() {
    this.expect('(');
    const args = [];
    while (!this.at(')') && !this.atEof()) {
      const before = this.pos;
      if (this.at('...')) {
        const sp = this.next();
        const arg = this.assignExpr();
        args.push({ type: 'Spread', arg, span: this.spanFrom(sp) });
      } else {
        args.push(this.assignExpr());
      }
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect(')');
    return args;
  }

  /** 模板字符串。`quasis` 比 `exprs` 多一个，和 ESTree 一致。 */
  template() {
    const start = this.cur();
    const quasis = [];
    const exprs = [];
    const head = this.next();
    quasis.push({ cooked: head.value, raw: head.raw });
    if (head.kind === 'tmpl_full') {
      return { type: 'Template', tag: null, quasis, exprs, span: this.spanFrom(start) };
    }
    for (;;) {
      exprs.push(this.expression());
      const t = this.cur();
      if (t.kind === 'tmpl_middle') {
        this.next();
        quasis.push({ cooked: t.value, raw: t.raw });
        continue;
      }
      if (t.kind === 'tmpl_tail') {
        this.next();
        quasis.push({ cooked: t.value, raw: t.raw });
        break;
      }
      this.error(t.span, `unterminated template literal near ${describeTokJs(t)}`);
      break;
    }
    return { type: 'Template', tag: null, quasis, exprs, span: this.spanFrom(start) };
  }

  primary() {
    const t = this.cur();
    /* `async function () {}`（ADR-0020 P2）：async 是普通标识符，所以要在 ident 那一支
       之前截住 —— 不截的话它就成了名字 `async` 后面跟一个语法错误。 */
    if (this.atWord('async') && this.at('function', 1) && this.peek(1).nl !== true) {
      const start = this.next();
      this.expect('function');
      const generator = !!this.eat('*');
      const id = this.cur().kind === 'ident' ? this.next().value : null;
      const { params, rest } = this.paramList();
      const body = this.block();
      return { type: 'FuncExpr', id, params, rest, body, generator, async: true, span: this.spanFrom(start) };
    }
    switch (t.kind) {
      case 'num': this.next(); return { type: 'Num', value: t.value, raw: t.raw, span: t.span };
      case 'bigint': this.next(); return { type: 'BigIntLit', value: t.value, raw: t.raw, span: t.span };
      case 'str': this.next(); return { type: 'Str', value: t.value, quote: t.quote, span: t.span };
      case 'lit': this.next(); return { type: 'Lit', value: t.value, span: t.span };
      case 'regex': this.next(); return { type: 'Regex', body: t.value, flags: t.flags, span: t.span };
      case 'tmpl_full': case 'tmpl_head': return this.template();
      case 'ident': this.next(); return { type: 'Ident', name: t.value, span: t.span };
      default: break;
    }
    if (t.kind === 'kw') {
      switch (t.value) {
        case 'this': this.next(); return { type: 'This', span: t.span };
        case 'function': {
          const start = this.next();
          const generator = !!this.eat('*');
          const id = this.cur().kind === 'ident' ? this.next().value : null;
          const { params, rest } = this.paramList();
          const body = this.block();
          return { type: 'FuncExpr', id, params, rest, body, generator, async: false, span: this.spanFrom(start) };
        }
        case 'class': {
          const start = this.next();
          const id = this.cur().kind === 'ident' ? this.next().value : null;
          const superClass = this.eat('extends') ? this.unaryOrCall() : null;
          const members = this.classBody();
          return { type: 'ClassExpr', id, superClass, members, span: this.spanFrom(start) };
        }
        case 'import': {
          const start = this.next();
          this.expect('.');
          const name = this.memberName();
          if (name !== 'meta') this.error(this.spanFrom(start), `unsupported 'import.${name}'`);
          return { type: 'ImportMeta', span: this.spanFrom(start) };
        }
        default: break;
      }
    }
    if (this.at('(')) {
      const start = this.next();
      const e = this.expression();
      this.expect(')');
      // 记下"有括号"：生成 js 时要还原它，否则 `(a + b) * c` 会变成 `a + b * c`
      return { ...e, parenthesized: true, span: this.spanFrom(start) };
    }
    if (this.at('[')) return this.arrayLit();
    if (this.at('{')) return this.objectLit();

    this.error(t.span, `expected an expression, found ${describeTokJs(t)}`);
    this.next();
    return { type: 'Lit', value: null, span: t.span };
  }

  arrayLit() {
    const start = this.expect('[');
    const elements = [];
    while (!this.at(']') && !this.atEof()) {
      const before = this.pos;
      if (this.at(',')) { this.next(); elements.push(null); continue; }
      if (this.at('...')) {
        const sp = this.next();
        elements.push({ type: 'Spread', arg: this.assignExpr(), span: this.spanFrom(sp) });
      } else {
        elements.push(this.assignExpr());
      }
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect(']');
    return { type: 'Array', elements, span: this.spanFrom(start) };
  }

  objectLit() {
    const start = this.expect('{');
    const props = [];
    while (!this.at('}') && !this.atEof()) {
      const before = this.pos;
      if (this.at('...')) {
        const sp = this.next();
        props.push({ kind: 'spread', arg: this.assignExpr(), span: this.spanFrom(sp) });
      } else {
        const pStart = this.cur();
        let kind = 'init';
        // async 方法（ADR-0020 P2）：`{ async m() {} }`；`async` 当键名时不算
        const isAsyncM = this.atWord('async')
          && !this.at('(', 1) && !this.at(',', 1) && !this.at(':', 1) && !this.at('}', 1)
          ? !!this.next() : false;
        if (this.cur().kind === 'ident' && (this.cur().value === 'get' || this.cur().value === 'set')
            && !this.at(',', 1) && !this.at(':', 1) && !this.at('(', 1) && !this.at('}', 1)) {
          kind = this.next().value;
        }
        // 生成器方法（ADR-0020 P2）：`{ *gen() { … } }`
        const generator = kind === 'init' ? !!this.eat('*') : false;
        const { key, computed } = this.propertyKey();
        if (this.at('(')) {
          const { params, rest } = this.paramList();
          const body = this.block();
          props.push({ kind: kind === 'init' ? 'init' : kind, key, computed, method: true, params, rest, body, generator, async: isAsyncM, span: this.spanFrom(pStart) });
        } else if (this.eat(':')) {
          props.push({ kind: 'init', key, computed, method: false, value: this.assignExpr(), span: this.spanFrom(pStart) });
        } else {
          // 简写 `{ x }`。`{ x = 1 }` 只在解构里合法，这里当错误更好：对象字面量里它没有意义
          if (this.at('=')) this.error(this.cur().span, "'=' in an object literal is only valid in a destructuring pattern");
          props.push({ kind: 'init', key, computed, method: false, shorthand: true, value: { type: 'Ident', name: key.name, span: key.span }, span: this.spanFrom(pStart) });
        }
      }
      if (!this.eat(',')) break;
      if (this.pos === before) break;
    }
    this.expect('}');
    return { type: 'Object', props, span: this.spanFrom(start) };
  }

  /**
   * 把已经按表达式解析出来的东西改成绑定模式。用在 `[a, b] = xs` 和 `for ([k, v] of m)` 上：
   * 解析这两处时还不知道后面是 `=` / `of`，只能先当表达式，看到之后再转。
   * 不是模式的形态（成员访问、调用…）原样返回 —— `a.b = 1` 的左边就该是成员访问。
   */
  toPattern(e) {
    if (e.type === 'Array') {
      const elements = [];
      let rest = null;
      for (const el of e.elements) {
        if (el === null) { elements.push(null); continue; }
        if (el.type === 'Spread') { rest = this.toPattern(el.arg); continue; }
        elements.push(this.toPattern(el));
      }
      return { type: 'ArrayPattern', elements, rest, span: e.span };
    }
    if (e.type === 'Object') {
      const props = [];
      let rest = null;
      for (const p of e.props) {
        if (p.kind === 'spread') { rest = this.toPattern(p.arg); continue; }
        if (p.kind !== 'init' || p.method) {
          this.error(p.span, 'this object member cannot appear in a destructuring pattern');
          continue;
        }
        props.push({ key: p.key, computed: p.computed, value: this.toPattern(p.value) });
      }
      return { type: 'ObjectPattern', props, rest, span: e.span };
    }
    if (e.type === 'Assign' && e.op === '=') {
      return { type: 'AssignPattern', left: this.toPattern(e.target), right: e.value, span: e.span };
    }
    return e;
  }
}

/** 能不能当赋值目标。解构模式在这里也算 —— `[a, b] = xs` 是合法的。 */
function isAssignable(e) {
  return e.type === 'Ident' || e.type === 'Member'
    || e.type === 'ArrayPattern' || e.type === 'ObjectPattern' || e.type === 'AssignPattern';
}

/** 诊断里怎么称呼一个 token */
function describeTokJs(t) {
  switch (t.kind) {
    case 'eof': return 'end of file';
    case 'str': return 'a string literal';
    case 'num': case 'bigint': return 'a number literal';
    case 'regex': return 'a regular expression';
    case 'tmpl_full': case 'tmpl_head': case 'tmpl_middle': case 'tmpl_tail': return 'a template literal';
    case 'lit': return `'${t.value}'`;
    default: return `'${t.value}'`;
  }
}

/**
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 */
export function parseJs(file, diags) {
  return new JsParser(file, diags).parseProgram();
}
