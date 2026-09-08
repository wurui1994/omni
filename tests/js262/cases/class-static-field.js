// 类：static 成员 / 实例字段 / 访问器 / 原型上的方法
class Counter {
  static created = 0;
  static describe() { return "Counter(" + Counter.created + ")"; }
  n = 0;
  step = 2;
  constructor(start) {
    this.n = start;
    Counter.created = Counter.created + 1;
  }
  get next() { return this.n + this.step; }
  set next(v) { this.n = v - this.step; }
  bump() { this.n = this.next; return this; }
}
const c = new Counter(1);
console.log(c.n, c.step, c.next);
c.next = 10;
console.log(c.n, c.bump().n);
console.log(Counter.created, Counter.describe());
console.log(typeof Counter.prototype.bump, c.hasOwnProperty("bump"), "bump" in c);
console.log(Object.keys(c).join(","));
