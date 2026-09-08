// 私有名 `#x`：键是一格**符号**而不是叫 "#x" 的字符串属性。
// 量的就是"私有"这件事：`o["#x"]` 取不到、`Object.hasOwn(o, "#x")` 是假、
// `Object.getOwnPropertyNames` 与 `Object.keys` 都列不出、JSON.stringify 也看不见。
// 顺带量 `#x in o`（ES2022 的 brand check —— 问的是自有，不沿原型链）。
// 代价写在明处（不在这条里量）：`Object.getOwnPropertySymbols` 还看得见它，
// 而且两个类里同名的 `#x` 共用一格键（规范靠词法作用域禁跨类访问，这儿没那一层）。
class A {
  #p = 1;
  #priv() { return "pm"; }
  static has(o) { return #p in o; }
  m() { return this.#p; }
  callPriv() { return this.#priv(); }
  bump() { this.#p = this.#p + 1; return this.#p; }
}
const a = new A();
console.log(a.m(), a.callPriv(), A.has(a), A.has({}));
console.log(Object.getOwnPropertyNames(a).length, Object.keys(a).length, JSON.stringify(a));
console.log(a["#p"], Object.hasOwn(a, "#p"), a.bump(), a.m());
class B { #x = 5; q = 1; get x() { return this.#x; } set x(v) { this.#x = v; } }
const b = new B();
b.x = 7;
console.log(b.x, Object.getOwnPropertyNames(b).join(","), JSON.stringify(b));
