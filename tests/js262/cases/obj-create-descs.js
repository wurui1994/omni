/* Object.create(proto, descs) 与 Object.defineProperties 在 C 那条腿上也成立了 ——
   槽表本来就带 writable / enumerable / configurable 三个位（ADR-0020 P1-c）。
   落在**普通对象字面量**上的 defineProperty 照旧当场报：那一格在这条腿上是一格 dict，
   没有属性位 —— 收下就是悄悄的错答案。所以这份用例里被定义的那一格都是真对象
   （Object.create 造的）。 */
const o = Object.create({ base: 1 }, {
  a: { value: 1, enumerable: true, writable: true, configurable: true },
  hidden: { value: 2 },
  g: { get() { return 7; }, enumerable: true },
});
console.log(o.a, o.hidden, o.g, o.base);
console.log(Object.keys(o).join(","), JSON.stringify(o));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(o, "hidden")));
console.log(Object.getOwnPropertyNames(o).join(","));
o.hidden = 9;
console.log(o.hidden, delete o.hidden, o.hidden);
const q = Object.create(null);
Object.defineProperties(q, { x: { value: 3, enumerable: true }, y: { value: 4 } });
console.log(q.x, q.y, Object.keys(q).join(","), JSON.stringify(q));
const acc = Object.create(null, { v: { get() { return this.n; }, set(x) { this.n = x * 2; }, enumerable: true } });
acc.v = 5;
console.log(acc.v, acc.n);
