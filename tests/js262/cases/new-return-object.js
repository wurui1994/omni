/* 构造器 return 的那一格（规范 10.2.2 第 13 步）：返回**对象**就是结果，返回原始值一律
   还给新造的实例。判据是规范的 "Type(v) is Object" —— 数组、Map、函数、正则都算，
   所以 new Wrap(3) 是 [3, 3] 而不是一格空对象。 */
function Box(v) { this.v = v; }
function Wrap(v) { return [v, v]; }
function Num(v) { this.v = v; return 42; }
function Nul(v) { this.v = v; return null; }
function Undef(v) { this.v = v; return undefined; }
function Str(v) { this.v = v; return "no"; }
function Mapped(v) { return new Map([["k", v]]); }
function Fn(v) { return () => v; }
function Re() { return /ab+/g; }

console.log(new Box(7).v);
const w = new Wrap(3);
console.log(Array.isArray(w), w.length, w[0], w[1]);
console.log(new Num(1).v, new Nul(2).v, new Undef(3).v, new Str(4).v);
console.log(new Mapped(9).get("k"));
console.log(new Fn(5)());
console.log(new Re().source, new Re().flags);

// 类的构造器同一条规矩
class C { constructor() { return { tag: "cls" }; } }
class D { constructor() { this.tag = "inst"; return 1; } }
class E { constructor() { return [1, 2]; } }
console.log(new C().tag, new D().tag, new E().length);

// 运行期拿到的构造器（走 js_fn_construct 那条路）也一样
const ctors = { Wrap, Mapped, C, E };
console.log(new ctors.Wrap(8)[1], new ctors.Mapped(1).size, new ctors.C().tag, new ctors.E()[0]);
