/* match / matchAll / search 的实参不是**字面量**正则时（`const re = /…/g` 带了 g、或者
   `new RegExp(s)` 存进了变量），把它在运行期摊成 (源, 旗标) 再交给同一格 op —— 与
   $js_str_replace 那一族早就在用的办法一字不差。从前这三格是编译期硬报错
   （"'matchAll' needs a regex literal as its first argument"）。
   差的一格写在明处：matchAll 照规范该从实参的 lastIndex 起走，这儿总是从 0 起。 */
const re = /(\d+)-(?<w>\w+)/g;
const s = "12-ab 34-cd";
console.log([...s.matchAll(re)].map((m) => `${m[1]}/${m.groups.w}`).join(","));
console.log(JSON.stringify(s.match(re)));
console.log(s.search(re));

// new RegExp 存进变量
const dyn = new RegExp("(\\w)(\\d)", "g");
console.log(JSON.stringify("a1 b2".match(dyn)));
console.log([..."a1 b2".matchAll(dyn)].map((m) => m[2]).join(","));
console.log("a1 b2".search(dyn), "zz".search(dyn));

// 不带 g 的运行期正则：match 给一次匹配那一格（带 index / groups）
const one = new RegExp("(b)(c)");
const m1 = "abc".match(one);
console.log(m1[0], m1[1], m1.index, m1.input);
console.log(JSON.stringify([..."abc".matchAll(new RegExp("b", "g"))].map((m) => m[0])));

// 实参是**串**时照规范当模式收（不是当字面量），undefined 是空模式
console.log(JSON.stringify("a.c".match(".")), "a.c".search("\\."));
console.log(JSON.stringify("abc".match(undefined)));

// 字面量那条老路一格不变
console.log(JSON.stringify("12-ab".match(/(\d+)/)), "12-ab".search(/-/));
