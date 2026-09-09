// 内建原型上的成员**当值读**（`typeof [1,2].at`）。这一档之前 prelude 里那批原型成员是
// 手写的一小半，而 C 那条腿的成员表是 emit 期照 JS_MEMBERS 生成的 —— 于是同一个写法在
// C 上给函数、在 JS / 解释器上给 undefined（既与 node/qjs 不同，也是腿之间的分叉）。
// 现在两边同源：prelude 末尾那一段也是照 JS_MEMBERS 生成的，三条腿一起拿到（整程序、
// 片段、以及解释器那条腿 new Function 跑起来的那一份）。
const xs = [3, 1, 2];
console.log(typeof xs.at, typeof xs.push, typeof xs.lastIndexOf, typeof xs.toSorted);
console.log(typeof "s".padStart, typeof "s".replace, typeof "s".substring, typeof "s".codePointAt);
console.log(typeof new Map().get, typeof new Set().add, typeof /a/.exec);
// 取出来的那格就是能调的（接收者靠 this 传进去）
const at = xs.at;
console.log(at.call(xs, 0), at.call(xs, -1));
const pad = "7".padStart;
console.log(pad.call("7", 3, "0"));
// 名字与形参个数也跟着那格函数走
console.log(xs.at.name, xs.at.length, "s".replace.name, "s".replace.length);
// 表外的名字照旧是 undefined —— "成员表缺一格"与"这个名字本来就没有"不能挤成一个答案
console.log(typeof xs.zork, typeof "s".zork);
