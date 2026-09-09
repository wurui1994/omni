/* Object.create(proto[, descs])：第二个实参那一支等于"造完再 defineProperty 一遍"
   （规范 20.1.2.2 的 ObjectDefineProperties）。descs 上只算**自有可枚举**的键，Symbol 键
   也算。从前第二个实参在降级那儿当场报 "'Object.create' takes at most 1 argument(s)"。 */
const base = { get g() { return "bg"; }, m() { return "bm"; } };
const derived = Object.create(base, {
  own: { value: 1, enumerable: true },
  hid: { value: 2 },
  acc: { get() { return "ga"; }, enumerable: true },
});
console.log(derived.g, derived.m(), derived.own, derived.hid, derived.acc);
console.log(Object.keys(derived).join(","), Object.getOwnPropertyNames(derived).join(","));
console.log("g" in derived, Object.hasOwn(derived, "g"), Object.getPrototypeOf(derived) === base);
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(derived, "own")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(derived, "hid")));

// 一个实参那一支一格不变；null 原型也照旧
const bare = Object.create(null);
bare.k = 1;
console.log(Object.getPrototypeOf(bare), bare.k, Object.keys(bare).join(","));
console.log(Object.getPrototypeOf(Object.create(base)) === base);
// 第二个实参给 undefined / null 都当"没给"
console.log(Object.keys(Object.create(base, undefined)).length);

// descs 上不可枚举的键不算（规范：只走自有可枚举）
const hidden = {};
Object.defineProperty(hidden, "skipped", { value: { value: 9 }, enumerable: false });
Object.defineProperty(hidden, "taken", { value: { value: 8 }, enumerable: true });
const d2 = Object.create(null, hidden);
console.log(d2.skipped, d2.taken);

// Symbol 键那一支
const sk = Symbol("sk");
const d3 = Object.create(null, { [sk]: { value: 3, enumerable: true } });
console.log(d3[sk], Object.getOwnPropertySymbols(d3).length);
