// 函数体里 / 块里的类声明（规范 14.7.14：它就是一格 let 绑定加一格类值）。从前这儿一律
// 当场报"只支持模块顶层" —— 而函数里放一个小类是再普通不过的 JS。
// 关键的一格是**捕获**：方法体里的 new Point(…) 引用的就是这个名字，按值捕获会在类值还没
// 装进去之前取一次（量出来的是宿主的 "Cannot access before initialization"），所以这一格
// 必须走 preCells 那条"先立 cell"的路。
function mk(n) {
  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    get sum() { return this.x + this.y; }
    scale(k) { return new Point(this.x * k, this.y * k); }
    static origin() { return new Point(0, 0); }
    toString() { return "(" + this.x + "," + this.y + ")"; }
  }
  const p = new Point(n, n + 1);
  return [String(p), String(p.sum), String(p.scale(2)), String(Point.origin()), String(p instanceof Point)].join(" ");
}
console.log(mk(1));
console.log(mk(10));
// 两次求值造出来的类互不相同
function classOf() { class A { m() { return 1; } } return A; }
const A1 = classOf(), A2 = classOf();
console.log(String(A1 === A2), String(new A1() instanceof A1), String(new A1() instanceof A2));
// 块里的类声明
{
  class B { v() { return "b"; } }
  console.log(new B().v());
}
// 闭包捕获外层局部
function counterClass(start) {
  class C { constructor() { this.n = start; } bump() { this.n += 1; return this.n; } }
  const c = new C();
  return c.bump() + "," + c.bump();
}
console.log(counterClass(5));
// 类里用私有字段
function priv() {
  class P { #v = 3; get v() { return this.#v; } }
  return new P().v;
}
console.log(String(priv()));
// 字段初始化式引用外层局部：那句表达式在 $init 那格闭包里跑，所以 nestedFns 得把
// 字段也算成"内层函数"，不然外层不给 start 装 cell —— 报的是 unresolved 'start'。
function counter2(start) {
  class C { #n = start; v = start * 2; bump() { this.#n += 1; return this.#n; } }
  const c = new C();
  return c.bump() + "," + c.bump() + "," + c.v;
}
console.log(counter2(5));
console.log(counter2(0));
