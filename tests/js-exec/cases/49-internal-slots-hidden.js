// 运行时自己的**内部槽**不该从任何视图里露出来（ADR-0020）。枚举那几种视图靠"不可枚举"
// 就挡住了，getOwnPropertyNames 这一档得按名字挡 —— 量出来的：new Promise 露
// ["$st","$val","$cbs"]、生成器露 ["$stp","$gst"]、new Date(0) 露 ["$ms"]，node 都给 []。
// 槽名是一张**封闭表**（prelude 的 $JS_SLOTS 与 C 的 omni_js_slot_ 逐字对应），
// 所以用户自己往对象上挂的同名属性也会被一起挡掉 —— 这是画出来的边界。
// 迭代器与 helper 上的 next / return 也一起搬到原型上了（%IteratorHelperPrototype% 与
// %ArrayIteratorPrototype%）—— 从前那两格是自有属性，也在这条口子上漏。
// （异常对象那一族在 48 号用例里：它多一格 stack 的差要单独滤，所以不放这儿。）
const show = (label, o) => console.log(label, JSON.stringify(Object.getOwnPropertyNames(o)), JSON.stringify(Object.keys(o)));
show("promise", new Promise((r) => r(1)));
function* g() { yield 1; }
show("gen", g());
// 挡掉的只是那张表里的名字：普通对象上的属性照旧全在
const o = { a: 1, b: 2 };
show("plain", o);
function* g2() { yield 1; }
show("helper", g2().map((x) => x));
show("arriter", [1, 2].values());
show("setiter", new Set([1]).values());
console.log([...[3, 4].values()].join(","), [...g2().take(1)].join(","));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(o, "a")));
// 内部槽读得着（它们只是不可枚举、不进那两张表），别把"挡住名字"做成"读不到"
const p = new Promise((r) => r(5));
p.then((v) => console.log("then still works", v));
console.log(g().next().value);
