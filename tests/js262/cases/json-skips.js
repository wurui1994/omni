/* JSON.stringify 里"不产生文本"的那三格：undefined、函数、**Symbol**（规范 25.5.2.2
   第 11 步）。在对象里是跳过这一格、在数组里落成 null、顶层就是 undefined。
   Symbol 那一格从前当场报 "do not know how to serialize a symbol"。 */
const sym = Symbol("x");
console.log(JSON.stringify({ u: undefined, f: function () {}, s: sym, keep: 1 }));
console.log(JSON.stringify([undefined, function () {}, sym, 1]));
console.log(String(JSON.stringify(sym)), String(JSON.stringify(undefined)), String(JSON.stringify(function () {})));
// 符号键本来就不进 own-enumerable-string 那一串，所以对象里带一格符号键也不影响
const o = { a: 1 };
o[sym] = 2;
console.log(JSON.stringify(o), Object.keys(o).join(","));
// replacer 把值换成 Symbol 也是"跳过"
console.log(JSON.stringify({ a: 1, b: 2 }, (k, v) => (k === "b" ? sym : v)));
