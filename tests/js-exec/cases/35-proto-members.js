// 内建原型上的成员在五条腿上（ADR-0020 P1-c）。降级器碰到 `[].map(f)` 时直接发 js_m_map、
// 不走原型，所以这条用例要的是**把成员当值取**：借方法、当回调传、按名字取。
// C 那条腿的表是照 JS_MEMBERS 生成的（93 格），原型上那格 get 陷阱照表答：
// 表里有的发一个原生、表里有而 C 那侧没落地的当场报、**根本不在表里的名字给 undefined**。
const arr = [1, 2, 3];
const m = arr.map;
console.log(typeof m, m.name, m.length);
console.log(Array.prototype.map.call(arr, (x) => x * 2).join(","));
console.log(Array.prototype.join.call(arr, "-"), Array.prototype.slice.call(arr, 1).join(","));
console.log(Array.prototype.includes.call(arr, 2), Array.prototype.indexOf.call(arr, 3));
console.log(String.prototype.toUpperCase.call("ab"), "ab".toUpperCase.call("cd"));
console.log([1, 2].join.call([3, 4], "+"), typeof "x".slice, typeof (5).toFixed);

// 这个值域里本来就没有的名字：undefined，不是响错
console.log([].zork, "ab".zork, (5).zork);

// Number.prototype / Boolean.prototype 也在里头：JS 那条腿从前一格都没挂（numP 是空的），
// 于是 `(5).toFixed` 在那儿是 undefined、在 C 上是函数 —— 五条腿那道闸门当场抓住。
console.log(typeof (5).toFixed, typeof (5).toString, typeof (5).valueOf, typeof true.toString);
console.log((1.567).toFixed(2), Number.prototype.toFixed.call(2.5, 0), (255).toString(16));
console.log((5).valueOf(), true.toString(), Number.prototype.toPrecision.call(1.23456, 3));
