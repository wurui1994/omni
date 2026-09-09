// Reflect 与 own-keys 那一族。这一条是**回归**用例：`js_obj_own_keys` 的 lit 字段
// 原先叫 kind，而 kind 是 IR 节点自己的判别字段 —— Reflect.ownKeys / 两个
// getOwnProperty*Names 一调就在发射器里当场 `js.expr: a`（lit 落在节点身上把它盖了）。
const o = { b: 1, a: 2 };
const s = Symbol("s");
o[s] = 3;
console.log(Reflect.has(o, "a"), Reflect.has(o, "zz"));
console.log(Reflect.ownKeys(o).length, Object.getOwnPropertyNames(o).join("|"));
console.log(Object.getOwnPropertySymbols(o).length, Object.keys(o).join("|"));
console.log(Reflect.get(o, "a"), Reflect.getPrototypeOf(o) === Object.prototype);
Reflect.set(o, "c", 4);
// 一句一件事：带副作用的调用与读键放在同一句里的话，"会抛的那一格"会被提到前面
// （ADR-0007 的 pending 检查），实参次序就不是从左往右了 —— 那是另一条账。
const del = Reflect.deleteProperty(o, "b");
console.log(del, Object.keys(o).join("|"));
/* Reflect 那几格交出**布尔**，而且"做不到"是 false 而不是抛（规范 28.1.3 / 28.1.9 / 28.1.10）
   —— 与 Object 同名的三个不是一回事：Object.defineProperty 抛，Reflect.defineProperty 给
   false。从前 defineProperty / setPrototypeOf / preventExtensions 这三格把**那个对象**交了
   出来（静悄悄的错值：typeof 是 "object" 而不是 "boolean"）。 */
const t = {};
console.log(typeof Reflect.defineProperty(t, "k", { value: 1 }), Reflect.defineProperty(t, "k2", { value: 1 }));
console.log(typeof Reflect.setPrototypeOf(t, null), typeof Reflect.preventExtensions({}));
const fz = Object.freeze({ a: 1 });
console.log(Reflect.defineProperty(fz, "a", { value: 2 }), Reflect.set(fz, "a", 3), Reflect.deleteProperty(fz, "a"));
console.log(Reflect.preventExtensions(fz), Reflect.setPrototypeOf(fz, null), fz.a);
const ne = Object.preventExtensions({});
console.log(Reflect.defineProperty(ne, "n", { value: 1 }), Reflect.set(ne, "n", 1));
// Object.setPrototypeOf 走的是另一格：不可扩展的对象上换原型是**能 catch 的** TypeError
// （规范 10.1.2）。换成同一格原型不算换，照规范放过。
try { Object.setPrototypeOf(fz, null); console.log("no-throw"); }
catch (e) { console.log("threw", e instanceof TypeError); }
console.log(Object.getPrototypeOf(fz) === Object.prototype, Object.setPrototypeOf(fz, Object.prototype) === fz);
