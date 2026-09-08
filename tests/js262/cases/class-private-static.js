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
