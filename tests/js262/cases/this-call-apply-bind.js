// this 是调用接收者：方法借用 / call / apply / bind
function who() { return this === undefined ? "undefined" : this.name; }
const a = { name: "a", who };
const b = { name: "b", who };
console.log(a.who(), b.who());
console.log(who.call(a), who.apply(b), who.call({ name: "c" }));
const bound = who.bind({ name: "d" });
console.log(bound(), bound.call(a));
function sum(x, y) { return this.base + x + y; }
console.log(sum.call({ base: 10 }, 1, 2), sum.apply({ base: 20 }, [1, 2]));
const psum = sum.bind({ base: 100 }, 1);
console.log(psum(2));
const arr = [3, 1, 2];
console.log(Array.prototype.join.call(arr, "|"));

// 借内建方法：数组与字符串的原型上摆着借得最多的那几个（平时它们按标签派发，
// 原型上本来一个都没有）。表外的名字仍是 undefined —— 借它会当场报"不是函数"。
console.log(Array.prototype.map.call([1, 2], (x) => x + 1).join(","));
console.log(Array.prototype.slice.call([1, 2, 3], 1).join(","));
const s = "Hello World";
console.log(String.prototype.slice.call(s, 0, 5), String.prototype.toUpperCase.call("ab"));
console.log(String.prototype.split.call("a,b,c", ",").join("|"), String.prototype.indexOf.call(s, "World"));
console.log(String.prototype.trim.call("  x  ") + "!", String.prototype.charCodeAt.call("A", 0));
console.log(String.prototype.startsWith.call(s, "Hell"), String.prototype.includes.call(s, "lo W"));
