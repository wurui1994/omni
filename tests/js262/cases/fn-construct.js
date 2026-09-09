// 普通函数当构造器与 new.target（ADR-0020）。
//
// 函数在这个值域里还不是真对象，所以 `f.prototype` 那一格住在运行期的一张 side table 上
// （prelude 的 $FNPROTO），`Function.prototype` 上的访问器读它。`new f(a)` 因此是：
// 造一格以 f.prototype 为原型的对象、拿它当接收者跑 f、f 返回对象就用那一格。
// new.target 与 this 同一个路子（入口取一次运行期的槽）。这一族只有 JS 那条腿。

// 具名函数取出来的值是**单件**：f === f，而且 f.prototype 每次问都是同一格
function F() {}
console.log(F === F, F.prototype === F.prototype);
console.log(typeof F.prototype, F.prototype.constructor === F);

// new.target：用 new 调起来时是那个构造器，直接调是 undefined
function Probe() { return new.target !== undefined; }
console.log(Probe());
console.log(new Probe() instanceof Probe);

// 老式构造器：this 上挂字段，方法挂原型
function Point(x, y) {
  this.x = x;
  this.y = y;
}
Point.prototype.sum = function () { return this.x + this.y; };
Point.prototype.tag = "point";
const p = new Point(2, 3);
console.log(p.x, p.y, p.sum(), p.tag);
console.log(p instanceof Point, Object.keys(p).join(","));

// 原型链走得通：自有属性遮住原型上的
p.tag = "own";
console.log(p.tag, Point.prototype.tag);

// 构造器返回一格对象就用那一格（返回别的一律给新造的）
function Ret() { this.a = 1; return { b: 2 }; }
console.log(JSON.stringify(new Ret()));
function RetPrim() { this.a = 1; return 7; }
console.log(JSON.stringify(new RetPrim()));

// 函数值（不是顶层名字）也能当构造器
const Mk = function Inner(v) { this.v = v; };
const m = new Mk(9);
console.log(m.v, m instanceof Mk);

// 实参照常求值，形参照常绑
function Many(a, b, c) { this.all = [a, b, c].join("-"); }
console.log(new Many(1, 2).all);

/* new.target 在**类**构造器里（规范 10.2.2）：类的构造走 $init 那格闭包、不经过
   js_fn_construct，所以从前那一格是 undefined —— new.target === C 静静地为假。
   子类里它是**被 new 的那一格**（子类），这一点两条路都要对上。 */
class NT { constructor() { this.who = new.target === NT ? "NT" : "other"; } }
class NTSub extends NT {}
console.log(new NT().who, new NTSub().who);
// 运行期拿到的类对象（不是顶层名字）走 js_fn_construct 那条路，答案要一样
const Held = NT;
console.log(new Held().who);
const bag = { C: NT };
console.log(new bag.C().who);
