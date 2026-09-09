// 类（ADR-0011 落地第 6c 步）：实例是普通对象，方法是每实例一份的闭包，this 是捕获
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  sum() {
    return this.x + this.y;
  }
  scaled(k) {
    return this.x * k + this.y * k;
  }
  label(prefix = "p") {
    return `${prefix}(${this.x},${this.y})`;
  }
}

const p = new Point(3, 4);
console.log(String(p.sum()));
console.log(String(p.scaled(2)));
console.log(p.label());
console.log(p.label("q"));
console.log(String(p.x));

// 每个实例有自己的状态
const q = new Point(10, 20);
console.log(`${p.sum()} ${q.sum()}`);
q.x = 100;
console.log(`${p.sum()} ${q.sum()}`);

// 方法之间互相调用（this.m()）
class Counter {
  constructor() {
    this.n = 0;
  }
  bump() {
    this.n = this.n + 1;
    return this;
  }
  bumpTwice() {
    this.bump();
    this.bump();
    return this.n;
  }
  value() {
    return this.n;
  }
}
const c = new Counter();
console.log(String(c.bumpTwice()));
console.log(String(c.bump().value()));

// 构造器里带默认参数、可变参数、以及提前 return
class Box {
  constructor(v = "empty", ...rest) {
    this.v = v;
    this.extra = rest.length;
    if (v === "stop") return;
    this.tag = `${v}/${rest.join("-")}`;
  }
  show() {
    return `${this.v} ${this.extra} ${this.tag}`;
  }
}
console.log(new Box().show());
console.log(new Box("a", 1, 2).show());
console.log(new Box("stop", 1).show());

// 构造器里用闭包与回调
class Adder {
  constructor(base) {
    this.base = base;
    this.add = (x) => x + base;
  }
  mapAll(xs) {
    return xs.map((x) => x + this.base);
  }
}
const a = new Adder(10);
console.log(String(a.add(5)));
console.log(a.mapAll([1, 2, 3]).join(","));

// 方法当值传出去。注意：这里必须**照着宿主的写法**保住接收者（宿主的方法在原型上，
// 摘下来就丢 this）；这套降级里方法是每实例一份的闭包，早就绑好了 —— 差异只体现在
// "摘下来直接调"的坏写法上，所以测试里不写那种。
const c2 = new Counter();
const f = () => c2.bump();
f();
f();
console.log(String(c2.value()));

// 实例存在容器里
const pts = [new Point(1, 1), new Point(2, 2)];
console.log(pts.map((it) => it.sum()).join(","));
const byName = new Map();
byName.set("origin", new Point(0, 0));
console.log(String(byName.get("origin").sum()));

// 类里的方法名和 Map/Set 的成员名撞车（get / set / has / keys / size）
class Bag {
  constructor() {
    this.items = [];
  }
  get(i) {
    return this.items[i];
  }
  set(v) {
    this.items.push(v);
    return this.items.length;
  }
  has(v) {
    return this.items.includes(v);
  }
  keys() {
    return this.items.length;
  }
}
const bag = new Bag();
console.log(String(bag.set("a")));
console.log(String(bag.set("b")));
console.log(bag.get(1));
console.log(String(bag.has("a")));
console.log(String(bag.has("z")));
console.log(String(bag.keys()));

// 自己的方法叫 push：零实参与展开这两种形状降级时走的是定长的整段追加 op，
// 静态分不出接收者是 list 还是对象 —— 派发器得在运行期看标签。
// asy 前端的 AsyLower.push() 正是这个形状（压一层作用域），从前装好的那份一跑就
// "dynamic value is dict, expected list"。
class Scopes {
  constructor() {
    this.depth = 0;
    this.log = [];
  }
  push(...names) {
    this.depth = this.depth + 1;
    for (const n of names) this.log.push(n);
    return this.depth;
  }
}
const sc = new Scopes();
console.log(String(sc.push()));
const more = ["a", "b"];
console.log(String(sc.push(...more)));
console.log(String(sc.push("c", "d")));
console.log(`${sc.depth} ${sc.log.join(",")}`);
// 真数组上这三种形状照旧
const xs = [1];
console.log(String(xs.push()));
console.log(String(xs.push(...[2, 3])));
console.log(String(xs.push(4, 5)));
console.log(xs.join(","));

// 函数体里 / 块里的类声明（规范 14.7.14 就是一格 let 绑定加一格类值）。方法体里引用类名
// 那一格靠 preCells 先立的 cell —— 按值捕获会在类值装进去之前取一次。
function mkPoint(n) {
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
console.log(mkPoint(1));
console.log(mkPoint(10));
// 每次求值都是一格新的类
function classOf() { class A { m() { return 1; } } return A; }
const A1 = classOf(), A2 = classOf();
console.log(String(A1 === A2), String(new A1() instanceof A1), String(new A1() instanceof A2));
{
  class B { v() { return "b"; } }
  console.log(new B().v());
}
// 捕获外层局部 + 私有字段
function counterClass(start) {
  class C { #n = start; bump() { this.#n += 1; return this.#n; } }
  const c = new C();
  return c.bump() + "," + c.bump();
}
console.log(counterClass(5));
