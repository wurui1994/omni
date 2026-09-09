/* 局部类与"普通函数当构造器"这两条路在 C 那条腿上通了（ADR-0020 P1-c 的第十一步）。
   局部类是一格**局部量**，所以 `new P()` 走的是通用那条 js_fn_construct —— 右边是一格
   类对象而不是函数值，构造要走它身上的 prototype 与 Symbol.omni.classInit 那格闭包。
   普通函数那一支的 prototype 住在一张按同一性索引的旁表上（函数不是真对象）。 */
function mkPoint(n) {
  class P {
    constructor(x, y) { this.x = x; this.y = y; }
    get sum() { return this.x + this.y; }
    scale(k) { return new P(this.x * k, this.y * k); }
    static origin() { return new P(0, 0); }
    toString() { return "(" + this.x + "," + this.y + ")"; }
  }
  const p = new P(n, n + 1);
  return [String(p), String(p.sum), String(p.scale(2)), String(P.origin()),
    String(p instanceof P)].join(" ");
}
console.log(mkPoint(1));
console.log(mkPoint(10));

// 每次求值都是一格新的类
function classOf() { class A { m() { return 1; } } return A; }
const A1 = classOf(), A2 = classOf();
console.log(A1 === A2, new A1() instanceof A1, new A1() instanceof A2);

// 捕获外层局部 + 私有字段
function counterClass(start) {
  class C { #n = start; bump() { this.#n += 1; return this.#n; } }
  const c = new C();
  return c.bump() + "," + c.bump();
}
console.log(counterClass(5));

// 普通函数当构造器
function F(a) { this.a = a; }
F.prototype.twice = function () { return this.a * 2; };
const f = new F(5);
console.log(f.a, f.twice(), f instanceof F, Object.keys(f).join(","));
function Wrap(v) { return [v, v]; }
console.log(new Wrap(3).length, JSON.stringify(new F(1)));
