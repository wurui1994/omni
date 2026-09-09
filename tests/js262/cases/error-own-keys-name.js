// 错误对象的"自有可枚举"口径与 name 的归属（规范 20.5）。这一族从前有三处静默分叉：
//   1. $cls 这个内部标记漏进 JSON.stringify 与 Object.keys；
//   2. name 定在实例上、值取 $cls 的链头，于是 class A extends Error {} 的实例
//      name 是 "A"（规范里 name 在原型上、还是 "Error"），String(a) 也跟着错；
//   3. { cause } 定成了可枚举的。
// 现在 name 是 errP 上的一对存取器（读顺着链找第一个内建错误名，写在实例上定一格
// 自有可枚举的数据属性 —— 与"给继承来的数据属性赋值"一致）。
const e = new Error("zero");
console.log(JSON.stringify(e), Object.keys(e).length, JSON.stringify({ ...e }));
console.log(e.message, e.name, String(e), e instanceof Error);
const t = new TypeError("bad");
console.log(JSON.stringify(t), t.name, String(t), t instanceof TypeError, t instanceof Error);
e.code = 5;
console.log(JSON.stringify(e), Object.keys(e).join(","));
let seen = "";
for (const k in t) seen += k + ";";
console.log("in:" + seen + "|");
// 子类：不写 name 就还是父类那一格；写了就是自有可枚举的（进得了 JSON）
class A extends Error {}
const a = new A("m");
console.log(a.name, a.message, String(a), JSON.stringify(a), a instanceof A, a instanceof Error);
class B extends Error { constructor(m) { super(m); this.name = "B"; this.extra = 1; } }
const b = new B("x");
console.log(b.name, b.message, String(b), JSON.stringify(b));
// extends TypeError：链是 [C2, TypeError, Error]，两个 instanceof 都成立，name 认中间那格
class C2 extends TypeError {}
const c2 = new C2("t");
console.log(c2.name, String(c2), c2 instanceof C2, c2 instanceof TypeError, c2 instanceof Error);
console.log(new RangeError("r").name, new SyntaxError("s").name, new ReferenceError("q").name);
// cause：own 但不可枚举
const ec = new Error("c", { cause: 7 });
console.log(JSON.stringify(ec), ec.cause, Object.keys(ec).length);
// 带数组 replacer 那一格走 [[Get]]，不可枚举的自有属性照样看得见
console.log(JSON.stringify(t, ["message"]), JSON.stringify(t, ["name"]));
// AggregateError 的 errors 那一格、剩下两个内建错误名，与 Object.prototype.toString 的标签
const ag = new AggregateError([new Error("a"), new Error("b")], "many");
console.log(ag.message, ag.name, ag.errors.length, ag instanceof AggregateError, ag instanceof Error);
console.log(new URIError("u").name, new EvalError("v").name, new Error().message === "");
console.log(Object.prototype.toString.call(e), Object.prototype.toString.call(t));
// cause 的值是对象也照样只是 own 不可枚举
const deep = new Error("m", { cause: new Error("inner") });
console.log(deep.cause.message, "cause" in new Error("no"), JSON.stringify(deep));
// err.stack 这个值域里没有（"stack" in e 是 false）。它是**已知的差**，不在这儿断言 ——
// 这条门要求与 qjs 逐字节相同，理由与补法写在 ADR-0020 的"没做"那一节。
