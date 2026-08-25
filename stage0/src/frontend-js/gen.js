// Omni stage0 — JS 语法前端：从 AST 生成 JS
//
// 存在的唯一理由是当 oracle（ADR-0001 第三条测试轴）。js -> 解析 -> 生成 js 是恒等变换，
// 没有任何产品价值，但它给出两个别处拿不到的断言：
//
//   幂等：gen(parse(gen(parse(x)))) 与 gen(parse(x)) 逐字节相同。
//         AST 里丢了信息、或者结合性/优先级搞错了，第二轮就会漂移。
//   语义一致：把整个 stage0/src 重新生成一遍，用生成出来的编译器跑全部测试，结果必须一样。
//         这一条才是真正的验证 —— 它把"前端有没有理解对"变成了 29 个测试用例的问题。
//
// 括号**不照抄源码**，一律按优先级重新算。照抄的话 `(a)` 会永远留着那层括号，幂等就失去意义；
// 按优先级算则输出是规范形式，幂等成为一个真断言。

const INDENT = '  ';

/** 表达式优先级。数字越大绑得越紧，和 parser.js 的 BINARY 表对齐。 */
const PREC = {
  Seq: 0,
  Assign: 1,
  Arrow: 1,
  Cond: 2,
  '??': 3, '||': 4, '&&': 5,
  '|': 6, '^': 7, '&': 8,
  '==': 9, '!=': 9, '===': 9, '!==': 9,
  '<': 10, '>': 10, '<=': 10, '>=': 10, in: 10, instanceof: 10,
  '<<': 11, '>>': 11, '>>>': 11,
  '+': 12, '-': 12,
  '*': 13, '/': 13, '%': 13,
  '**': 14,
  Unary: 15,
  UpdatePrefix: 15,
  UpdatePostfix: 16,
  Call: 17,
  New: 17,
  Member: 17,
  Primary: 18,
};

/** 运算符优先级查表。用 hasOwn 挡住原型链（`PREC['toString']` 会摸到函数）。 */
function opPrec(op) {
  if (!Object.hasOwn(PREC, op)) throw new Error(`js gen: unknown operator '${op}'`);
  return PREC[op];
}

function prec(n) {
  switch (n.type) {
    case 'Seq': return PREC.Seq;
    case 'Assign': return PREC.Assign;
    case 'Arrow': return PREC.Arrow;
    case 'Cond': return PREC.Cond;
    case 'Binary': case 'Logical': return opPrec(n.op);
    case 'Unary': return PREC.Unary;
    case 'Update': return n.prefix ? PREC.UpdatePrefix : PREC.UpdatePostfix;
    case 'Call': return PREC.Call;
    case 'New': return n.args.length ? PREC.New : PREC.Primary;
    case 'Member': return PREC.Member;
    default: return PREC.Primary;
  }
}

/** 选转义更少的那种引号；平手用单引号。 */
function quote(s) {
  const single = (s.match(/'/g) ?? []).length;
  const double = (s.match(/"/g) ?? []).length;
  const q = double < single ? '"' : "'";
  let out = q;
  for (const ch of s) {
    if (ch === q || ch === '\\') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\v') out += '\\v';
    else if (ch === '\0') out += '\\0';
    else if (ch < ' ' || ch === '\u2028' || ch === '\u2029') {
      out += `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return out + q;
}

const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 一个语句以什么 token 开头。表达式语句以 `{` / `function` / `class` 开头时必须加括号。 */
function startsBadly(e) {
  for (let n = e; n; ) {
    switch (n.type) {
      case 'Object': return true;
      case 'FuncExpr': case 'ClassExpr': return true;
      case 'Binary': case 'Logical': n = n.left; continue;
      case 'Assign': n = n.target; continue;
      case 'Cond': n = n.test; continue;
      case 'Seq': n = n.exprs[0]; continue;
      case 'Call': n = n.callee; continue;
      case 'Member': n = n.object; continue;
      case 'Template': n = n.tag; continue;
      case 'Update': return n.prefix ? false : startsBadly(n.arg);
      default: return false;
    }
  }
  return false;
}

class Gen {
  constructor() {
    this.out = [];
    this.depth = 0;
  }

  emit(s) { this.out.push(s); }

  text() { return this.out.join(''); }

  // ------------------------------------------------------------ 表达式

  /** `min` 是"父节点要求的最小优先级"；不够紧就加括号 */
  expr(n, min = 0) {
    const need = prec(n) < min;
    if (need) this.emit('(');
    this.exprInner(n);
    if (need) this.emit(')');
  }

  exprInner(n) {
    switch (n.type) {
      case 'Num': this.emit(n.raw); return;
      case 'BigIntLit': this.emit(n.raw); return;
      case 'Str': this.emit(quote(n.value)); return;
      case 'Lit': this.emit(String(n.value)); return;
      case 'Regex': this.emit(`/${n.body}/${n.flags}`); return;
      case 'Ident': this.emit(n.name); return;
      case 'This': this.emit('this'); return;
      case 'ImportMeta': this.emit('import.meta'); return;

      case 'Template': {
        // 数字字面量后面直接跟模板是合法的，但 `1`...` 读起来像错的；tag 一律按 Member 级别要求
        if (n.tag) this.expr(n.tag, PREC.Member);
        this.emit('`');
        for (let i = 0; i < n.quasis.length; i++) {
          this.emit(n.quasis[i].raw);
          if (i < n.exprs.length) {
            this.emit('${');
            this.expr(n.exprs[i]);
            this.emit('}');
          }
        }
        this.emit('`');
        return;
      }

      case 'Array': {
        this.emit('[');
        this.arrayElements(n.elements, null, (el) => {
          if (el.type === 'Spread') { this.emit('...'); this.expr(el.arg, PREC.Assign); }
          else this.expr(el, PREC.Assign);
        });
        this.emit(']');
        return;
      }

      case 'Object': {
        if (!n.props.length) { this.emit('{}'); return; }
        this.emit('{ ');
        n.props.forEach((p, i) => {
          if (i) this.emit(', ');
          this.objectProp(p);
        });
        this.emit(' }');
        return;
      }

      case 'Arrow': {
        this.params(n.params, n.rest, n.params.length === 1 && !n.rest && n.params[0].type === 'Ident');
        this.emit(' => ');
        if (n.expression) {
          // `() => ({...})`：不加括号会被读成函数体
          if (n.body.type === 'Object') { this.emit('('); this.expr(n.body); this.emit(')'); }
          else this.expr(n.body, PREC.Assign);
        } else this.block(n.body);
        return;
      }

      case 'FuncExpr': {
        this.emit(`function${n.id ? ` ${n.id}` : ''}`);
        this.params(n.params, n.rest, false);
        this.emit(' ');
        this.block(n.body);
        return;
      }

      case 'ClassExpr': this.classTail('class', n); return;

      case 'Member': {
        // `1 .toString()` 需要括号：不加的话 `.` 会被当成小数点
        if (n.object.type === 'Num') { this.emit('('); this.expr(n.object); this.emit(')'); }
        else this.expr(n.object, PREC.Member);
        if (n.computed) {
          this.emit(n.optional ? '?.[' : '[');
          this.expr(n.prop);
          this.emit(']');
        } else {
          this.emit(n.optional ? '?.' : '.');
          this.emit(n.name);
        }
        return;
      }

      case 'Call': {
        this.expr(n.callee, PREC.Call);
        this.emit(n.optional ? '?.(' : '(');
        this.args(n.args);
        this.emit(')');
        return;
      }

      case 'New': {
        this.emit('new ');
        this.expr(n.callee, PREC.Member);
        this.emit('(');
        this.args(n.args);
        this.emit(')');
        return;
      }

      case 'Unary': {
        const word = /^[a-z]/.test(n.op);
        this.emit(word ? `${n.op} ` : n.op);
        // `- -a` / `+ +a` / `-(--a)`：相同符号贴在一起会被读成 `--` / `++`
        const clash = !word && n.arg.type !== 'Num'
          && ((n.arg.type === 'Unary' && n.arg.op === n.op)
              || (n.arg.type === 'Update' && n.arg.prefix && n.arg.op[0] === n.op));
        if (clash) { this.emit('('); this.expr(n.arg); this.emit(')'); }
        else this.expr(n.arg, PREC.Unary);
        return;
      }

      case 'Update': {
        if (n.prefix) { this.emit(n.op); this.expr(n.arg, PREC.UpdatePrefix); }
        else { this.expr(n.arg, PREC.UpdatePostfix); this.emit(n.op); }
        return;
      }

      case 'Binary': case 'Logical': {
        const p = opPrec(n.op);
        // `**` 右结合：左边同级要括号；其余左结合：右边同级要括号
        if (n.op === '**') {
          this.expr(n.left, p + 1);
          this.emit(' ** ');
          this.expr(n.right, p);
        } else {
          this.expr(n.left, p);
          this.emit(` ${n.op} `);
          this.expr(n.right, p + 1);
        }
        return;
      }

      case 'Cond': {
        this.expr(n.test, PREC.Cond + 1);
        this.emit(' ? ');
        this.expr(n.cons, PREC.Assign);
        this.emit(' : ');
        this.expr(n.alt, PREC.Assign);
        return;
      }

      case 'Assign': {
        this.pattern(n.target);
        this.emit(` ${n.op} `);
        this.expr(n.value, PREC.Assign);
        return;
      }

      case 'Seq': {
        n.exprs.forEach((e, i) => {
          if (i) this.emit(', ');
          this.expr(e, PREC.Assign);
        });
        return;
      }

      case 'Spread': this.emit('...'); this.expr(n.arg, PREC.Assign); return;

      // 解构模式在赋值左边也会走到这里
      case 'ArrayPattern': case 'ObjectPattern': case 'AssignPattern': this.pattern(n); return;

      default:
        throw new Error(`js gen: unhandled expression node '${n.type}'`);
    }
  }

  // ------------------------------------------------------------ 片段

  /** 对象/类成员的键。能写成标识符就写成标识符（规范形式，幂等靠它）。 */
  key(k, computed) {
    if (computed) { this.emit('['); this.expr(k); this.emit(']'); return; }
    if (k.type === 'Ident') { this.emit(IDENT_KEY.test(k.name) ? k.name : quote(k.name)); return; }
    if (k.type === 'Str') { this.emit(IDENT_KEY.test(k.value) ? k.value : quote(k.value)); return; }
    this.expr(k);
  }

  objectProp(p) {
    if (p.kind === 'spread') { this.emit('...'); this.expr(p.arg, PREC.Assign); return; }
    if (p.kind === 'get' || p.kind === 'set') {
      this.emit(`${p.kind} `);
      this.key(p.key, p.computed);
      this.params(p.params, p.rest, false);
      this.emit(' ');
      this.block(p.body);
      return;
    }
    if (p.method) {
      this.key(p.key, p.computed);
      this.params(p.params, p.rest, false);
      this.emit(' ');
      this.block(p.body);
      return;
    }
    // 简写只在"键是标识符且值是同名标识符"时还原，别的情况写全 —— 少一条特例少一处漂移
    if (p.value.type === 'Ident' && !p.computed
        && (p.key.type === 'Ident' ? p.key.name : p.key.value) === p.value.name
        && IDENT_KEY.test(p.value.name)) {
      this.emit(p.value.name);
      return;
    }
    this.key(p.key, p.computed);
    this.emit(': ');
    this.expr(p.value, PREC.Assign);
  }

  /** `bare` 为真时是单参数箭头函数，可以省掉括号 */
  params(params, rest, bare) {
    if (bare) { this.pattern(params[0]); return; }
    this.emit('(');
    params.forEach((p, i) => {
      if (i) this.emit(', ');
      this.pattern(p);
    });
    if (rest) {
      if (params.length) this.emit(', ');
      this.emit('...');
      this.pattern(rest);
    }
    this.emit(')');
  }

  pattern(p) {
    switch (p.type) {
      case 'Ident': this.emit(p.name); return;
      case 'AssignPattern': this.pattern(p.left); this.emit(' = '); this.expr(p.right, PREC.Assign); return;
      case 'ArrayPattern': {
        this.emit('[');
        this.arrayElements(p.elements, p.rest, (el) => this.pattern(el));
        this.emit(']');
        return;
      }
      case 'ObjectPattern': {
        this.emit('{ ');
        p.props.forEach((pr, i) => {
          if (i) this.emit(', ');
          const shorthand = pr.value.type === 'Ident' && !pr.computed
            && (pr.key.type === 'Ident' ? pr.key.name : pr.key.value) === pr.value.name;
          if (shorthand) { this.emit(pr.value.name); return; }
          if (pr.value.type === 'AssignPattern' && pr.value.left.type === 'Ident' && !pr.computed
              && (pr.key.type === 'Ident' ? pr.key.name : pr.key.value) === pr.value.left.name) {
            this.pattern(pr.value);
            return;
          }
          this.key(pr.key, pr.computed);
          this.emit(': ');
          this.pattern(pr.value);
        });
        if (p.rest) {
          if (p.props.length) this.emit(', ');
          this.emit('...');
          this.pattern(p.rest);
        }
        this.emit(' }');
        return;
      }
      default: this.expr(p, PREC.Assign);
    }
  }

  args(list) {
    list.forEach((a, i) => {
      if (i) this.emit(', ');
      if (a.type === 'Spread') { this.emit('...'); this.expr(a.arg, PREC.Assign); }
      else this.expr(a, PREC.Assign);
    });
  }

  /**
   * 数组字面量与数组模式共用的元素列表，含空洞。
   *
   * 空洞就是"两个逗号之间什么都没有"，所以它**不额外发逗号** —— 分隔符本身就是它的全部。
   * 早先给空洞多发了一个逗号，于是 `[, r]` 生成成 `[,, r]`：这不是"生成得难看"，是
   * 生成出了**语义不同**的东西（元素位置整体右移一位）。幂等测试第二轮才抓到它。
   * 末位是空洞时必须补一个尾逗号：`[a,]` 长度 1，`[a,,]` 长度 2。
   */
  arrayElements(elements, rest, emitOne) {
    elements.forEach((el, i) => {
      if (i) this.emit(', ');
      if (el !== null) emitOne(el);
    });
    if (elements.length && elements[elements.length - 1] === null) this.emit(',');
    if (rest) {
      if (elements.length) this.emit(', ');
      this.emit('...');
      this.pattern(rest);
    }
  }

  // ------------------------------------------------------------ 语句

  nl() { this.emit(`\n${INDENT.repeat(this.depth)}`); }

  block(b) {
    if (!b.body.length) { this.emit('{}'); return; }
    this.emit('{');
    this.depth++;
    for (const s of b.body) { this.nl(); this.stmt(s); }
    this.depth--;
    this.nl();
    this.emit('}');
  }

  /** `if (x) stmt;` 的分支体：是块就贴着写，不是块就缩进换行 */
  body(s) {
    if (s.type === 'Block') { this.emit(' '); this.block(s); return; }
    this.depth++;
    this.nl();
    this.stmt(s);
    this.depth--;
  }

  classTail(head, n) {
    this.emit(head);
    if (n.id) this.emit(` ${n.id}`);
    if (n.superClass) { this.emit(' extends '); this.expr(n.superClass, PREC.Member); }
    this.emit(' ');
    if (!n.members.length) { this.emit('{}'); return; }
    this.emit('{');
    this.depth++;
    for (const m of n.members) {
      this.nl();
      if (m.static) this.emit('static ');
      if (m.kind === 'field') {
        this.key(m.key, m.computed);
        if (m.value) { this.emit(' = '); this.expr(m.value, PREC.Assign); }
        this.emit(';');
        continue;
      }
      if (m.kind === 'get' || m.kind === 'set') this.emit(`${m.kind} `);
      this.key(m.key, m.computed);
      this.params(m.params, m.rest, false);
      this.emit(' ');
      this.block(m.body);
    }
    this.depth--;
    this.nl();
    this.emit('}');
  }

  varDecl(n) {
    this.emit(`${n.kind} `);
    n.decls.forEach((d, i) => {
      if (i) this.emit(', ');
      this.pattern(d.id);
      if (d.init) { this.emit(' = '); this.expr(d.init, PREC.Assign); }
    });
  }

  stmt(s) {
    switch (s.type) {
      case 'Empty': this.emit(';'); return;
      case 'Block': this.block(s); return;
      case 'VarDecl': this.varDecl(s); this.emit(';'); return;

      case 'ExprStmt': {
        // 以 `{` / `function` / `class` 开头的表达式语句必须加括号，否则被读成块/声明
        if (startsBadly(s.expr)) { this.emit('('); this.expr(s.expr); this.emit(')'); }
        else this.expr(s.expr);
        this.emit(';');
        return;
      }

      case 'FuncDecl': {
        this.emit(`function ${s.id}`);
        this.params(s.params, s.rest, false);
        this.emit(' ');
        this.block(s.body);
        return;
      }

      case 'ClassDecl': this.classTail('class', s); return;

      case 'Return': case 'Throw': {
        this.emit(s.type === 'Return' ? 'return' : 'throw');
        if (s.arg) { this.emit(' '); this.expr(s.arg); }
        this.emit(';');
        return;
      }

      case 'Break': this.emit('break;'); return;
      case 'Continue': this.emit('continue;'); return;

      case 'If': {
        this.emit('if (');
        this.expr(s.test);
        this.emit(')');
        this.body(s.cons);
        if (s.alt) {
          if (s.cons.type === 'Block') this.emit(' else');
          else { this.nl(); this.emit('else'); }
          // `else if` 不缩进成阶梯：链式条件写成阶梯会一路顶到右边
          if (s.alt.type === 'If') { this.emit(' '); this.stmt(s.alt); }
          else this.body(s.alt);
        }
        return;
      }

      case 'While': {
        this.emit('while (');
        this.expr(s.test);
        this.emit(')');
        this.body(s.body);
        return;
      }

      case 'DoWhile': {
        this.emit('do');
        this.body(s.body);
        if (s.body.type === 'Block') this.emit(' while (');
        else { this.nl(); this.emit('while ('); }
        this.expr(s.test);
        this.emit(');');
        return;
      }

      case 'For': {
        this.emit('for (');
        if (s.init) {
          if (s.init.type === 'VarDecl') this.varDecl(s.init);
          else this.expr(s.init.expr);
        }
        this.emit('; ');
        if (s.test) this.expr(s.test);
        this.emit('; ');
        if (s.update) this.expr(s.update);
        this.emit(')');
        this.body(s.body);
        return;
      }

      case 'ForOf': case 'ForIn': {
        this.emit('for (');
        if (s.declKind) this.emit(`${s.declKind} `);
        this.pattern(s.left);
        this.emit(s.type === 'ForOf' ? ' of ' : ' in ');
        this.expr(s.right, PREC.Assign);
        this.emit(')');
        this.body(s.body);
        return;
      }

      case 'Try': {
        this.emit('try ');
        this.block(s.block);
        if (s.handler) {
          this.emit(' catch ');
          if (s.param) { this.emit('('); this.pattern(s.param); this.emit(') '); }
          this.block(s.handler);
        }
        if (s.finalizer) { this.emit(' finally '); this.block(s.finalizer); }
        return;
      }

      case 'Switch': {
        this.emit('switch (');
        this.expr(s.disc);
        this.emit(') {');
        this.depth++;
        for (const c of s.cases) {
          this.nl();
          if (c.test) { this.emit('case '); this.expr(c.test); this.emit(':'); }
          else this.emit('default:');
          this.depth++;
          for (const b of c.body) { this.nl(); this.stmt(b); }
          this.depth--;
        }
        this.depth--;
        this.nl();
        this.emit('}');
        return;
      }

      case 'ImportDecl': {
        this.emit('import ');
        const def = s.specifiers.find((x) => x.kind === 'default');
        const ns = s.specifiers.find((x) => x.kind === 'namespace');
        const named = s.specifiers.filter((x) => x.kind === 'named');
        const parts = [];
        if (def) parts.push(def.local);
        if (ns) parts.push(`* as ${ns.local}`);
        if (named.length) {
          parts.push(`{ ${named.map((x) => (x.imported === x.local ? x.local : `${x.imported} as ${x.local}`)).join(', ')} }`);
        }
        if (parts.length) this.emit(`${parts.join(', ')} from `);
        this.emit(`${quote(s.source)};`);
        return;
      }

      case 'ExportNamed': {
        const list = s.specifiers.map((x) => (x.local === x.exported ? x.local : `${x.local} as ${x.exported}`));
        this.emit(`export { ${list.join(', ')} }`);
        if (s.source !== null) this.emit(` from ${quote(s.source)}`);
        this.emit(';');
        return;
      }

      case 'ExportDefault': {
        this.emit('export default ');
        this.expr(s.value, PREC.Assign);
        this.emit(';');
        return;
      }

      case 'ExportDecl': this.emit('export '); this.stmt(s.decl); return;

      default:
        throw new Error(`js gen: unhandled statement node '${s.type}'`);
    }
  }
}

/** @param {any} program parseJs 的产物 */
export function genJs(program) {
  const g = new Gen();
  if (program.hashbang) g.emit(`${program.hashbang}\n`);
  program.body.forEach((s, i) => {
    if (i) g.emit('\n');
    g.stmt(s);
  });
  g.emit('\n');
  return g.text();
}
