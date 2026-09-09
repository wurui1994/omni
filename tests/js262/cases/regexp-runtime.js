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
// EscapeRegExpPattern（规范 22.2.6.13.1）：.source 交出去的那一格要能塞回 /…/ 里再读一遍。
// 裸 / 写成 \/，换行写成两个字符的 \n，空模式写成 (?:)；已经escape过的不再escape一遍，
// 字符组里的 / 不动。toString 也跟着这一格走。
console.log(new RegExp("a/b").source, new RegExp("/").source, new RegExp("a\\/b").source);
console.log(JSON.stringify(new RegExp("").source), JSON.stringify(new RegExp("a\nb").source));
console.log(new RegExp("[/]").source, /[/]/.source, new RegExp("a\\\\/").source);
console.log(new RegExp("a/b").toString(), String(new RegExp(new RegExp("a/b").source)));
console.log(new RegExp("a/b").test("a/b"), new RegExp("(?:)").test(""));
// new RegExp(re)：照抄源与旗标（不是把它印成 "/a/g" 再当模式）；旗标给了就用给的那个
const cp = new RegExp(/a\/b/gi);
console.log(JSON.stringify(cp.source), cp.flags, cp.test("xa/b"));
console.log(JSON.stringify(new RegExp(/a/g, "m").flags), JSON.stringify(new RegExp(/a/g).flags));
// 模式缺席是空模式，不是 "undefined"；null 照 ToString 走
console.log(new RegExp().source, new RegExp(undefined).source, new RegExp(null).source);
// split 收运行期的正则：转给正则那一支（从前撞在 "regexp is not a string" 上）
const sp = new RegExp("[-_]", "g");
console.log("a-b_c".split(sp).join("|"), "a-b_c".split(new RegExp("(-)")).join("|"));
console.log("a1b".split(/(\d)/).join("|"), "x".split(new RegExp("")).length);
console.log("a-b-c".split(sp, 2).join("|"), "abc".split(new RegExp("z")).join("|"));
