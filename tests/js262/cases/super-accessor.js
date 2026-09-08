// super 上的**访问器**与**静态方法里的 super**。
// 两处都是这一轮量出来的：`super.v` 从前把父类原型自己当 this（getter 里读实例的私有名
// 于是拿到 undefined —— 悄悄的错答案），`super.m()` 在静态方法里指错了对象（找的是父类
// 原型而不是父类对象，运行期 undefined is not a function）。
class A {
  #p = 2;
  get v() { return this.#p; }
  set v(x) { this.#p = x * 2; }
  static m() { return "sm"; }
  static get sg() { return "sg"; }
}
class B extends A {
  get v2() { return super.v + 1; }
  static sm2() { return super.m() + "!"; }
  static get sg2() { return super.sg + "?"; }
}
const b = new B();
console.log(b.v, b.v2);
b.v = 4;
console.log(b.v, b.v2);
console.log(B.sm2(), B.sg2(), A.m(), A.sg);
// 取属性那一格也认接收者：Reflect.get 的第三个实参就是它
const proto = { get who() { return this.tag; } };
const inst = Object.create(proto);
inst.tag = "inst";
console.log(inst.who, Reflect.get(proto, "who", inst), Reflect.get(proto, "who") === undefined);
