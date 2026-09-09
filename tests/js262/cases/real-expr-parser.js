// 端到端回归：一段真程序（算术表达式的词法 + 递归下降 + 求值 + 打印 + 报错那几格）。
// 这一类用例专门用来抓"单点探针看不出、跑起来才露出的"分叉 —— Math.max 当值用只拿前两格
// 那一格就是在这儿露出来的（见 ADR-0020 的"收可变实参的内建当值用"）。
// 一小段真程序：算术表达式的词法 + 递归下降 + 求值 + 打印
const TOK = /\s*(?:(\d+\.?\d*)|([A-Za-z_]\w*)|(\*\*|[-+*/%()^,]))/g;
function lex(src) {
  const out = [];
  let m, last = 0;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(src)) !== null) {
    if (m.index !== last) throw new SyntaxError(`unexpected char at ${last}`);
    last = TOK.lastIndex;
    if (m[1] !== undefined) out.push({ k: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ k: "id", v: m[2] });
    else out.push({ k: m[3], v: m[3] });
  }
  if (last !== src.length) throw new SyntaxError(`unexpected char at ${last}`);
  return out;
}
class Parser {
  constructor(toks) { this.t = toks; this.i = 0; }
  peek() { return this.i < this.t.length ? this.t[this.i] : null; }
  eat(k) { const p = this.peek(); if (p && p.k === k) { this.i++; return p; } return null; }
  expect(k) { const p = this.eat(k); if (!p) throw new SyntaxError(`expected ${k}`); return p; }
  expr(min = 0) {
    let lhs = this.unary();
    for (;;) {
      const p = this.peek();
      if (!p) break;
      const info = Parser.OPS[p.k];
      if (!info || info.prec < min) break;
      this.i++;
      const rhs = this.expr(info.right ? info.prec : info.prec + 1);
      lhs = { k: "bin", op: p.k, l: lhs, r: rhs };
    }
    return lhs;
  }
  unary() {
    if (this.eat("-")) return { k: "neg", e: this.unary() };
    if (this.eat("(")) { const e = this.expr(); this.expect(")"); return e; }
    const n = this.eat("num");
    if (n) return { k: "num", v: n.v };
    const id = this.eat("id");
    if (id) {
      if (this.eat("(")) {
        const args = [];
        if (!this.eat(")")) {
          do { args.push(this.expr()); } while (this.eat(","));
          this.expect(")");
        }
        return { k: "call", name: id.v, args };
      }
      return { k: "var", name: id.v };
    }
    throw new SyntaxError("unexpected end");
  }
  static OPS = {
    "+": { prec: 1 }, "-": { prec: 1 },
    "*": { prec: 2 }, "/": { prec: 2 }, "%": { prec: 2 },
    "**": { prec: 3, right: true },
  };
}
const FNS = { sqrt: Math.sqrt, min: Math.min, max: Math.max, abs: Math.abs };
function evalNode(n, env) {
  switch (n.k) {
    case "num": return n.v;
    case "var": {
      if (!(n.name in env)) throw new ReferenceError(`unknown var ${n.name}`);
      return env[n.name];
    }
    case "neg": return -evalNode(n.e, env);
    case "call": {
      const f = FNS[n.name];
      if (!f) throw new ReferenceError(`unknown fn ${n.name}`);
      return f(...n.args.map((a) => evalNode(a, env)));
    }
    case "bin": {
      const l = evalNode(n.l, env), r = evalNode(n.r, env);
      switch (n.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "%": return l % r;
        case "**": return l ** r;
        default: throw new Error("bad op " + n.op);
      }
    }
    default: throw new Error("bad node " + n.k);
  }
}
function show(n) {
  switch (n.k) {
    case "num": return String(n.v);
    case "var": return n.name;
    case "neg": return "-" + show(n.e);
    case "call": return n.name + "(" + n.args.map(show).join(", ") + ")";
    case "bin": return "(" + show(n.l) + " " + n.op + " " + show(n.r) + ")";
    default: return "?";
  }
}
const env = { x: 3, y: 4 };
const cases = [
  "1+2*3", "2**3**2", "-x*y", "(1+2)*(3+4)", "sqrt(x*x + y*y)",
  "max(1, 2, 3) - min(4, 5)", "10 % 4", "abs(-7)/2", "x ** 2 + y ** 2",
  "1 +", "2 @ 3", "z + 1", "nope(1)",
];
for (const src of cases) {
  try {
    const ast = new Parser(lex(src)).expr();
    console.log(`${src} => ${show(ast)} = ${evalNode(ast, env)}`);
  } catch (e) {
    console.log(`${src} !! ${e.name}: ${e.message}`);
  }
}
