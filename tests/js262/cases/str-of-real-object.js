// String(真对象)：继承来的 Object.prototype.toString 不算"自带"（那就是 "[object Object]"），
// 自己或原型上写的那格才算 —— realm 落地之后 C 那条腿差点把所有真对象都当成自带（当场报）。
class A { }
class B { toString() { return "B!"; } }
console.log(String(new A()));
console.log(String(new B()));
console.log(String(new Error("x")));
console.log(String({ toString() { return "C!"; } }));
console.log(String(Object.create({ toString() { return "D!"; } })));
// 取值器形式的 toString 也算自带
const g = { get toString() { return () => "G!"; } };
console.log(String(g));
