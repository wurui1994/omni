// 函数体里 / 块里的类**带 extends**（规范 14.7.14 + 15.7.14）。原型链要拿父类的原型对象与
// $init，那两格是模块级全局 —— 只有顶层声明过的非 Error 类才有，所以这一格只认那一种父类。
// super.m() 与 super(...) 靠 fn.classOf 去 classes 表里问父类名，而类表达式没有自己的表项，
// 所以配一格合成的键 @cls<n>（不是合法的 JS 标识符，撞不上用户的类名）。
class Base { constructor(n) { this.n = n; } m() { return "base" + this.n; } static tag() { return "B"; } }
function mk(n) {
  class Kid extends Base {
    constructor(x) { super(x); this.extra = x * 2; }
    m() { return "kid(" + super.m() + ")," + this.extra; }
    static tag2() { return Kid.tag() + "-kid"; }
  }
  const k = new Kid(n);
  return [k.m(), String(k instanceof Kid), String(k instanceof Base), Kid.tag2(), Kid.name].join(" | ");
}
console.log(mk(1));
console.log(mk(3));
{
  class InBlock extends Base { m() { return "blk:" + super.m(); } }
  console.log(new InBlock(7).m());
}
const C = class extends Base { m() { return "anon:" + super.m(); } };
console.log(new C(9).m());
// 两次求值造出来的类互不相同，但都还是 Base 的子类
function mk2() { class T extends Base {} return T; }
const T1 = mk2(), T2 = mk2();
console.log(String(T1 === T2), String(new T1(0) instanceof Base), String(new T1(0) instanceof T2));
