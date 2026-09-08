/* 迭代方法的第二个实参 thisArg（规范 23.1.3.*）：回调的 this 就是它。从前这一格被丢掉
   （编译期就当"用户自己的同名方法"走运行期原型派发，而原型上那几格只看第一个实参），
   于是回调里的 this 是 undefined —— 用得上 this 的回调因此拿到错答案或当场报错。
   C 那条腿上这条路仍旧是 loud（真函数对象还没有，见 ADR-0020 P1-c），所以只在这儿量。 */
const ctx = { k: 2 };
console.log([1, 2, 3].map(function (x) { return this.k * x; }, ctx).join(","));
console.log([1, 2, 3, 4].filter(function (x) { return x % this.k === 0; }, ctx).join(","));
const seen = [];
[1, 2].forEach(function (x) { seen.push(this.k + x); }, ctx);
console.log(seen.join(","));
console.log([1, 2, 3].some(function (x) { return x === this.k; }, ctx),
  [2, 4].every(function (x) { return x % this.k === 0; }, ctx));
console.log([1, 2, 3].find(function (x) { return x === this.k; }, ctx),
  [1, 2, 3].findIndex(function (x) { return x === this.k; }, ctx));
console.log([1, 2, 3].findLast(function (x) { return x < this.k; }, ctx),
  [1, 2, 3].findLastIndex(function (x) { return x < this.k; }, ctx));
console.log([1, 2].flatMap(function (x) { return [x, x * this.k]; }, ctx).join(","));
// 不给 thisArg（或给 undefined）时不该白包一层：回调照旧、this 还是 undefined
console.log([1, 2, 3].map(function (x) { return x * 2; }).join(","),
  [1, 2, 3].map(function (x) { return x; }, undefined).join(","));
// 不给 thisArg 时回调里的 this 是什么，是**严格/宽松模式**的事（qjs 把脚本当宽松跑，
// this 成了 globalThis；我们与 node 的模块语义一致，是 undefined）—— 见 ADR-0020，不在这儿量
// 回调的三个实参照旧（值、下标、整个数组）
console.log([9, 8].map(function (v, i, arr) { return [this.k, v, i, arr.length].join("-"); }, ctx).join(" "));
