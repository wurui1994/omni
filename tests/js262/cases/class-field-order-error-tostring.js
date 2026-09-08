// 类那一片量出来的两格：派生类的字段要等 super() 回来才初始化（**静默分叉** —— 从前跑在
// 父类构造器之前，字段读到的是 undefined）、Error 的原型上少了 toString（印成 [object Object]）。
class A {
  x = 1;
  y = this.x + 1;
  constructor() { this.z = this.y + 1; }
  get sum() { return this.x + this.y + this.z; }
  set sum(v) { this.x = v; }
  static tag = "A";
  static { A.built = true; }
}
class B extends A {
  w = this.sum + 10;
  constructor() { super(); this.after = this.w + 1; }
  get sum() { return super.sum * 2; }
}
const b = new B();
console.log(b.x, b.y, b.z, b.w, b.after, b.sum, A.tag, A.built);
console.log(Object.keys(b).join(","), JSON.stringify(b));
b.sum = 9;
console.log(b.x, b instanceof B, b instanceof A, B.tag);
// 没写构造器的派生类：隐式的 constructor(...a){ super(...a) }，字段照旧在 super 之后
class C extends A { c = this.x + 100; }
console.log(new C().c, new C().z, new C() instanceof A);
// 字段的初始化次序：从上往下，后一格看得见前一格
class D { a = 1; b = this.a + 1; c = this.b + 1; }
console.log(JSON.stringify(new D()));
// Error 的 toString：name、有 message 时接 ": " 与 message
const e = new TypeError("boom", { cause: "why" });
console.log(e.name, e.message, e.cause, String(e), `${e}`);
console.log(String(new Error("")), String(new RangeError("r")), new Error("m").toString());
class MyErr extends Error {
  constructor(m) { super(m); this.name = "MyErr"; }
}
const me = new MyErr("mine");
console.log(me.name, me.message, String(me), me instanceof MyErr, me instanceof Error);
try { throw new MyErr("thrown"); } catch (err) { console.log(String(err), err.name); }
