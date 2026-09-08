// 数组与字符串上的属性描述符（规范 10.4.2.1 与 String exotic）。从前这一支一律给
// undefined，于是 Object.getOwnPropertyDescriptor([1], "0").value 当场炸。
// 口径：数组的下标是可写、可枚举、可配置；length 可写但不可枚举、不可配置；
// 字符串的下标与 length 都是只读、不可配置（下标可枚举，length 不可枚举）。
const a = [10, 20];
const d0 = Object.getOwnPropertyDescriptor(a, "0");
console.log(d0.value, d0.writable, d0.enumerable, d0.configurable);
const dl = Object.getOwnPropertyDescriptor(a, "length");
console.log(dl.value, dl.writable, dl.enumerable, dl.configurable);
console.log(Object.getOwnPropertyDescriptor(a, "5"), Object.getOwnPropertyDescriptor(a, "zz"));
a.tag = "t";
const dt = Object.getOwnPropertyDescriptor(a, "tag");
console.log(dt.value, dt.writable, dt.enumerable, dt.configurable);
const s = "ab";
const ds = Object.getOwnPropertyDescriptor(s, "1");
console.log(ds.value, ds.writable, ds.enumerable, ds.configurable);
const dsl = Object.getOwnPropertyDescriptor(s, "length");
console.log(dsl.value, dsl.writable, dsl.enumerable, dsl.configurable);
console.log(Object.getOwnPropertyDescriptor(s, "9"), Object.getOwnPropertyDescriptor(s, "x"));
// 访问器那一族照旧（真对象上）
const o = {};
Object.defineProperty(o, "g", { get() { return 1; }, enumerable: true, configurable: false });
const dg = Object.getOwnPropertyDescriptor(o, "g");
console.log(typeof dg.get, dg.set, dg.enumerable, dg.configurable, "value" in dg);
