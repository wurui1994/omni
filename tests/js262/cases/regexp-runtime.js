// 运行期的正则：`new RegExp(src[, flags])` 与它身上的 source / flags / test。
// 字面量那条路由降级器静态发成 js_re_*（模式与旗标是编译期常量）；这一条量的是
// **接收者在运行期**的那一支 —— test 与 exec 共用同一套 lastIndex 行为。
const re = new RegExp("b", "g");
console.log(re.source, re.flags, re.test("abc"), re.lastIndex);
console.log(/a/gi.flags, /a\.b/.source, /x/.flags === "");
// 存进变量的正则交给 replace / replaceAll：转给正则那一支，语义与字面量一字不差
console.log("abcb".replace(new RegExp("b", "g"), "-"), "abcb".replace(new RegExp("b"), "-"));
const dyn = new RegExp("[0-9]+");
console.log(dyn.test("a1"), dyn.exec("a12")[0], dyn.source, dyn.lastIndex);
console.log(new RegExp("a").flags === "", new RegExp("a", "").source);
// 旗标照样起作用（i 与 g 都从运行期的串来）
const ci = new RegExp("A", "i");
console.log(ci.test("a"), new RegExp("a|b", "g").exec("zb")[0]);
