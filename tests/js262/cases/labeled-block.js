// 标签打在**块**上（`L: { … break L; }`）：摊成 `L: while (true) { … ; break; }`，
// 于是 break L 还是"跳出一层循环"那条现成的边。嵌套的块、以及块里套循环都通。
// `continue L` 指着一个标签块在规范里是 SyntaxError；这儿是编译期报错（摊完之后它会
// 变成死循环），所以不在这条用例里量。
lbl: { console.log("in"); break lbl; }
outer: { console.log("a"); inner: { break outer; } console.log("never"); }
console.log("after");
let n = 0;
top: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue top; n++; } }
console.log(n);
blk: { for (let i = 0; i < 5; i++) { if (i === 2) break blk; } console.log("no"); }
console.log("end");
