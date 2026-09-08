// 往 super 上写（`super.x = v`）与 Reflect.set 的第四个实参。
// 规范里两者是同一格：从**父类原型**（或给的对象）上找那一格，但访问器的 this 与
// 数据格的落点都是**接收者**。所以下面第二段里 super.d = "own" 落在实例身上，
// 父类原型那一格一动不动。
class A { #p = 1; get v() { return this.#p; } set v(x) { this.#p = x * 2; } }
class B extends A { get v2() { return super.v; } set v2(x) { super.v = x; } }
const b = new B();
b.v2 = 5;
console.log(b.v, b.v2, b.v2 === 10);
class C { }
C.prototype.d = "proto";
class D extends C { setIt() { super.d = "own"; } }
const d = new D();
d.setIt();
console.log(d.d, C.prototype.d, Object.hasOwn(d, "d"));
// Reflect.set 交出的是**布尔**（赋值表达式交出的是 v）—— 写不进去时是 false
const proto = { set s(v) { this.got = v; } };
const inst = Object.create(proto);
Reflect.set(proto, "s", 3, inst);
console.log(inst.got, Object.hasOwn(inst, "got"), Reflect.set({}, "k", 1));
const froz = Object.freeze({ a: 1 });
console.log(Reflect.set(froz, "a", 2), froz.a, Reflect.set(froz, "b", 1));
const noSet = {};
Object.defineProperty(noSet, "ro", { value: 1, writable: false });
console.log(Reflect.set(noSet, "ro", 2), noSet.ro);
