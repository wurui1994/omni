// Symbol：typeof / description / 注册表 / 当属性键 / 不进 Object.keys
const s = Symbol("tag");
console.log(typeof s, s.description, s.toString());
console.log(Symbol("a") === Symbol("a"), Symbol.for("k") === Symbol.for("k"));
console.log(Symbol.keyFor(Symbol.for("k")), Symbol.keyFor(Symbol("k")));
const o = { [s]: 1, plain: 2 };
console.log(o[s], Object.keys(o).join(","), Object.getOwnPropertySymbols(o).length);
console.log(typeof Symbol.iterator, Symbol.iterator === Symbol.iterator);
