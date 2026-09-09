// 第三轮：类、访问器、静态、私有字段、迭代协议、异步
class Shape {
  static count = 0;
  #id;
  constructor(name) { this.name = name; this.#id = ++Shape.count; }
  get id() { return this.#id; }
  set label(v) { this.name = v.trim(); }
  area() { return 0; }
  toString() { return `${this.constructor.name}(${this.name})`; }
  static of(n) { return new Shape(n); }
}
class Circle extends Shape {
  constructor(r) { super("circle"); this.r = r; }
  area() { return Math.PI * this.r ** 2; }
  get diameter() { return this.r * 2; }
}
const c = new Circle(2);
console.log(c.name, c.id, c.area().toFixed(3), c.diameter);
console.log(String(c), c instanceof Circle, c instanceof Shape, Shape.count);
c.label = "  ring  ";
console.log(c.name, Shape.of("sq").id);
console.log(Object.getPrototypeOf(c) === Circle.prototype, Circle.prototype instanceof Shape);
console.log(Object.keys(c).join(","), JSON.stringify(c));

class Bag {
  constructor() { this.items = [1, 2, 3]; }
  *[Symbol.iterator]() { for (const v of this.items) yield v * 10; }
  get size() { return this.items.length; }
}
console.log([...new Bag()].join(","), new Bag().size);

const proto = { greet() { return "hi " + this.who; } };
const o = Object.create(proto);
o.who = "you";
console.log(o.greet(), Object.getPrototypeOf(o) === proto, Object.keys(o).join(","));
console.log(Reflect.get(o, "who"), Reflect.has(o, "greet"), Reflect.ownKeys(o).join(","));

const counter = {
  n: 0,
  get next() { return ++this.n; },
};
console.log(counter.next, counter.next, counter.n);

const tracked = new Proxy({ a: 1 }, {
  get(t, k) { return k in t ? t[k] : `<${String(k)}>`; },
});
console.log(tracked.a, tracked.zz);

async function work(v) { return v * 2; }
work(21).then((v) => console.log("async", v));
Promise.all([work(1), work(2)]).then((vs) => console.log("all", vs.join(",")));
