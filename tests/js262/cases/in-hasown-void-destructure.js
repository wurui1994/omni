// 这一批也是自己量出来的：in / Object.hasOwn 在数组上（**元素那几格算键** —— 从前只问了
// 挂在数组身上的旁表，0 in a 静静地给 false）、void、Number.isSafeInteger、解构的三格
// 边角（模式带默认值、嵌套模式的默认值、计算键）。
const a = [1, 2, 3];
console.log(0 in a, 2 in a, 3 in a, -1 in a, "0" in a, "length" in a, "foo" in a);
a.foo = 1;
console.log("foo" in a, Object.hasOwn(a, 0), Object.hasOwn(a, 3), Object.hasOwn(a, "length"), Object.hasOwn(a, "foo"));
console.log(0 in [], Object.hasOwn([], 0), "01" in a, Object.hasOwn(a, "01"), 1.5 in a);
const o = { x: 1 };
console.log("x" in o, "y" in o, Object.hasOwn(o, "x"), Object.hasOwn(o, "toString"), "toString" in o);
console.log(Object.hasOwn({ 1: "a" }, 1), 1 in { 1: "a" });
// void：算一遍再交出 undefined（副作用要留着）
let vo = 0;
console.log(void 0, void (vo = 5), vo, void "x");
console.log(Number.isSafeInteger(3), Number.isSafeInteger(2 ** 53), Number.isSafeInteger(2 ** 53 - 1));
console.log(Number.isSafeInteger(1.5), Number.isSafeInteger("3"), Number.isSafeInteger(NaN), Number.isSafeInteger(-0));
console.log([1, 2 ** 53].map(Number.isSafeInteger).join(","));
// 解构：模式带默认值、嵌套模式的默认值、计算键（键的表达式只算一次）
const { a: aa = 1, b: { c = 2 } = {}, ...rest } = { a: undefined, x: 8, y: 9 };
console.log(aa, c, JSON.stringify(rest));
function f({ x = 1, y: z = 2 } = {}, ...tail) { return `${x}/${z}/${tail.length}`; }
console.log(f(), f({ x: 9 }, 1, 2), f({ y: 7 }));
const [p = 5, , q = 6, ...more] = [undefined, 2];
console.log(p, q, JSON.stringify(more));
let hits = 0;
function k() { hits = hits + 1; return "kk"; }
const { [k()]: got = "no", ...restC } = { kk: "yes", zz: 1 };
console.log(got, hits, JSON.stringify(restC));
const { [k()]: miss = "dflt" } = {};
console.log(miss, hits);
