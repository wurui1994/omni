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
