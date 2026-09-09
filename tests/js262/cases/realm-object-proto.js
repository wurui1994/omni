/* realm 的第一刀（ADR-0020 P1-c 的第十三步）：Object.prototype 那一格在 C 上是真的可用 ——
   它的成员表短而封闭（规范 20.1.3），所以写得全；别的原型（Array / String…）是一格带 get
   陷阱的代理，读成员当场报，但**同一性**成立，所以 instanceof 这一族对得上。
   `Object.prototype.toString.call(x)` 还要 Function.prototype.call —— 那一格在 C 上还没有，
   所以这份用例走的是"从实例上继承下来"的那条路。 */
class P { constructor() { this.x = 1; } m() { return 2; } }
const p = new P();
console.log(p.hasOwnProperty("x"), p.hasOwnProperty("m"), ({ a: 1 }).hasOwnProperty("a"));
console.log(P.prototype.isPrototypeOf(p), Object.prototype.isPrototypeOf(p));
console.log(p.propertyIsEnumerable("x"), p.propertyIsEnumerable("m"));
console.log(p.valueOf() === p, p.toString(), String(p));
console.log(p instanceof P, p instanceof Object, ({}) instanceof Object);
console.log([] instanceof Array, [] instanceof Object, new Map() instanceof Map);
console.log(/x/ instanceof RegExp, (() => 1) instanceof Function, 1 instanceof Object);
console.log(Object.create(null) instanceof Object, Object.create({}) instanceof Object);
const ks = [];
for (const k in p) ks.push(k);
console.log(ks.join(","), Object.keys(p).join(","), JSON.stringify(p));
