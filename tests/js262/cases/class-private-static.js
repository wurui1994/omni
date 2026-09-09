// 私有名与 static 初始化块（ADR-0020 P4）。
//
// 私有名的做法：词法器把 `#x` 整个当一个标识符，于是 `this.#x` 就是"成员名叫 #x"、
// `#m(){}` 就是"方法名叫 #m"，后面一路走普通属性。字段那一格定义成**不可枚举**，
// 所以 Object.keys / JSON.stringify 看不见它。画出来的边界：`o["#x"]` 能绕过去
// （真做要给每个类一格 WeakMap）。
class Counter {
  #n = 0;
  static #made = 0;
  constructor() { Counter.#made++; }
  #step() { return 1; }
  inc() { this.#n += this.#step(); return this.#n; }
  static made() { return Counter.#made; }
}
const c = new Counter();
console.log(c.inc(), c.inc(), Counter.made());
console.log(Object.keys(c).length, JSON.stringify(c), Object.keys(Counter).length);
new Counter();
console.log(Counter.made());

// static 初始化块：类定义那一刻跑，this 是类对象
class Cfg {
  static a;
  static {
    Cfg.a = 1;
    this.b = this.a + 1;
  }
  static {
    Cfg.c = Cfg.b + 1;
  }
}
console.log(Cfg.a, Cfg.b, Cfg.c);
// 块里的局部量不漏出去（它跑在一格闭包里）
class Scoped {
  static v;
  static {
    const tmp = 41;
    Scoped.v = tmp + 1;
  }
}
console.log(Scoped.v, typeof tmp);

/* typeof 一格类对象是 "function"。类在这个值域里是**真对象**（原型 + 一格符号键的
   初始化闭包），可 typeof A === "function" 是最常见的鸭子判断，说 "object" 就是静静地
   走错分支 —— 判据取自有的 Symbol.omni.classInit 槽，不走 [[Get]]。 */
console.log(typeof Counter, typeof Cfg, typeof class {}, typeof class Named {});
console.log(typeof Counter === "function", typeof {} === "object", typeof (() => {}));
// #x in o（ES2022 的 ergonomic brand check）与 super 上的取值器
class Base { #p = 3; get v() { return this.#p; } has(o) { return #p in o; } call() { return this.#p; } }
class Sub extends Base { get v() { return super.v * 10; } callSuper() { return super.call(); } }
const s = new Sub();
console.log(s.v, s.callSuper(), s.has(s), s.has({}), s instanceof Base);
// 字段初始化跑在 super() 之后、构造体之前
class P { constructor() { this.order = []; } }
class Q extends P { f = (this.order.push("f"), 1); constructor() { super(); this.order.push("ctor"); } }
console.log(new Q().order.join(","), Object.getOwnPropertyNames(Base.prototype).sort().join(","));
// static 的计算键 / 串键 / 数字键
class K { static [Symbol.iterator]() {} static "str"() {} static 5() {} }
console.log(typeof K.str, typeof K[5], typeof K[Symbol.iterator]);
