// 类对象身上的 name / length（都不可枚举）与 own keys 的那一套。这一族从前有三处静默分叉：
//   1. A.name 是 undefined（规范里类有 name 与 length 两格自有属性）；
//   2. 内部那格"初始化实例的闭包"用的是字符串键 "$init"，于是漏进
//      Object.getOwnPropertyNames；现在换成符号键（Symbol.omni.classInit）；
//   3. JSON.stringify(SomeClass) 印 {} —— JS 里类是函数，答案是 undefined。
// typeof A 仍是 "object"（类在这个值域里不是函数值，见 ADR-0020）。
class A {}
class B { constructor(a, b) {} }
class C { constructor(a, b = 1, ...r) {} }
console.log(A.name, B.name, B.length, C.length, A.length);
console.log(Object.keys(A).length, Object.getOwnPropertyNames(B).sort().join(","));
console.log(JSON.stringify(A), JSON.stringify({ k: A }), JSON.stringify([A]));
console.log(Object.getOwnPropertyDescriptor(B, "name").enumerable, B.prototype.constructor === B);
class D { static name = "custom"; static length = 9; }
console.log(D.name, D.length);
// 继承：类对象的原型是父类对象，所以 name 也能从父类那儿查到（自己有就用自己的）
class E extends A {}
console.log(E.name, Object.getPrototypeOf(E) === A, E.length);
// new <运行期的值>() 走的是那格符号键，改键之后这条路要照旧成立
class F { constructor(v) { this.v = v === undefined ? 7 : v; } static make(v) { return new this(v); } }
class G extends F {}
console.log(F.make(1).v, G.make().v, G.make(2) instanceof G, G.name);
