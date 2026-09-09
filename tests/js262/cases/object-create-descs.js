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

/* Object.defineProperties(o, descs)：与上面那一支共用同一段（规范里就是同一个步骤
   ObjectDefineProperties）。从前当场报 "'Object.defineProperties' is not in the closed ABI"。 */
const dp = {};
console.log(Object.defineProperties(dp, {
  a: { value: 1, enumerable: true },
  b: { value: 2 },
  c: { get() { return 3; }, enumerable: true },
}) === dp);
console.log(dp.a, dp.b, dp.c, Object.keys(dp).join(","), Object.getOwnPropertyNames(dp).join(","));
// 已有的键上"缺的字段保持原样"；不可配置不可写的槽上改 value 是 TypeError
try { Object.defineProperties(dp, { a: { value: 9 } }); } catch (e) { console.log("redef", e.name, dp.a); }
const dw = {};
Object.defineProperties(dw, { k: { value: 1, writable: true, enumerable: true } });
Object.defineProperties(dw, { k: { value: 2 } });
console.log(dw.k, Object.keys(dw).join(","));
console.log(JSON.stringify(Object.getOwnPropertyDescriptors({ x: 1 })));
