// 原型链：Object.create / getPrototypeOf / setPrototypeOf / 属性遮蔽
const base = { greet() { return "hi " + this.name; }, kind: "base" };
const o = Object.create(base);
o.name = "x";
console.log(o.greet(), o.kind, Object.getPrototypeOf(o) === base);
console.log(base.isPrototypeOf(o), Object.prototype.isPrototypeOf(o));
o.kind = "own";
console.log(o.kind, base.kind, Object.keys(o).join(","));
console.log(o.hasOwnProperty("kind"), o.hasOwnProperty("greet"), "greet" in o);
const other = { kind: "other" };
Object.setPrototypeOf(o, other);
console.log(o.kind, typeof o.greet);
const bare = Object.create(null);
bare.a = 1;
console.log(Object.getPrototypeOf(bare), bare.a);
