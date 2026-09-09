// values() / keys() / entries() 交的是**真迭代器**，不是一条 list（ADR-0020）。
// 从前这三格交 list：`[...a.keys()]` 与 `for (const i of a.keys())` 都对，可
// `typeof a.values().next` 是 undefined（qjs / node 给函数），ES2025 那批 helper
// （`a.values().map(f)`）也接不上 —— 静静地错。
// 现在四条腿上都是一格真迭代器：原型是 Iterator.prototype，next / Symbol.iterator 在
// 它身上。摊平成 list 那一半拆成了内部助手（$js_map_pairs / $js_set_list、C 那侧的
// map_pairs_ / set_list_）—— for-of、new Map(x)、集合运算走的是那一半，不然 js_iter
// 收到一格真对象会当场打转。
const xs = [3, 1, 2];
console.log(typeof xs.values().next, typeof xs.keys().next, typeof xs.entries().next);
console.log([...xs.values()].join(","), [...xs.keys()].join(","));
console.log(xs.entries().next().value.join("/"));
console.log([...xs.values().map((v) => v * 2)].join(","));
for (const [i, v] of xs.entries()) console.log("e", i, v);
const m = new Map([[1, "a"], [2, "b"]]);
console.log([...m.keys()].join(","), [...m.values()].join(","));
for (const [k, v] of m.entries()) console.log("m", k, v);
for (const [k, v] of m) console.log("m2", k, v);
const s = new Set([7, 8]);
console.log([...s.values()].join(","), [...s.keys()].join(","), [...s].join(","));
console.log(s.entries().next().value.join("/"));
console.log(new Map(m).size, new Set(s).size, [...new Set([1,2]).union(new Set([3]))].join(","));
console.log(Array.from(xs.values()).join(","), Array.from(m).length);
