// 展开落在剩下那几个位置上（ADR-0020 P1-f）：成员调用、构造器、Error 那一家。
// 成员派发器与构造器都是定长的，所以整条实参表先求成一个 list，再按下标取头几格
// （越界给 undefined —— 与"缺席的实参补 js_undef"是同一件事）。
const ab = [1, 3];
const xs = [1, 2, 3, 4, 5];
console.log(xs.slice(...ab).join(","), "abcdef".slice(...ab));
console.log("a-b-c".split(...["-"]).join("|"), xs.indexOf(...[3]));
// concat 收可变实参，而派发器是定长的：它可结合，所以摊成一串调用 / 运行期 reduce
console.log([1, 2].concat([3], [4]).join(","), [1, 2].concat(...[[3], [4]]).join(","));
console.log("a".concat("b", "c"), "a".concat(...["b", "c"]), [].concat(...[]).length);
// 构造器：用户类、内建 Error 那一家、以及普通函数当构造器
class P { constructor(a, b) { this.s = a + b; } }
console.log(new P(...ab).s);
function F(a) { this.v = a; }
console.log(new F(...[7]).v);
console.log(new Error(...["boom"]).message, new Error(...[]).message === "");
const ag = new AggregateError(...[[new Error("e1")], "many"]);
console.log(ag.name, ag.message, ag.errors.length);
// new Error(undefined) 的 message 照规范是空串（那一格只在给了非 undefined 时才设）
console.log(JSON.stringify(new RangeError(undefined).message));
