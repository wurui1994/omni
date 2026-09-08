// Object.prototype 上那几个名字 + 字面量里的 __proto__。
//
// 这一条是**回归**用例：降级器的几张表（JS_METHODS / JS_PROPS / GLOBAL_CALLS /
// STATIC_*）都拿用户写的名字当键，而 hasOwnProperty / valueOf / constructor 这些名字
// 在 Object.prototype 上 —— `表[名字]` 会拿到继承来的函数当成"表里有这一格"，于是
// `({a:1}).hasOwnProperty("a")` 当场崩在降级器里（不是运行期）。现在一律 Object.hasOwn。
const o = { a: 1 };
console.log(o.hasOwnProperty("a"), o.hasOwnProperty("b"));
console.log(o.valueOf() === o, {}.toString());
console.log(o.propertyIsEnumerable("a"), Object.prototype.isPrototypeOf(o));

const base = { x: 1, m() { return "m"; } };
const d = { __proto__: base, y: 2 };
console.log(d.x, d.y, d.m(), Object.keys(d).join("|"));
console.log(Object.getPrototypeOf(d) === base, d.hasOwnProperty("x"));
console.log(Object.getPrototypeOf({ __proto__: null }) === null);
// 简写与计算键都是普通属性，不是"设原型"
const key = "__proto__";
console.log(Object.keys({ [key]: base }).length);
