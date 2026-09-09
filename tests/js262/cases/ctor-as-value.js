// 内建构造器**当值用**（ADR-0020 P1-f 的第二半）：`const A = Array` 与 `x.constructor`。
// 从前两头都不成：`Array` 当值用是编译期 "can only be used as a member base"，
// 而 `[].constructor` **静静地给 undefined** —— `if (x.constructor === Array)` 悄悄为假。
// 现在 realm 上每个原型都坐着一格构造器对象，两条路给的是**同一个值**，所以 === 为真。
//
// 画出来的边界：静态面挂不到函数值上（函数在这个值域里还不是真对象），所以 `A.isArray`
// 是运行期 "undefined is not a function" —— 响的，不在这条用例里量（见 ADR-0020）。
console.log([].constructor === Array, "".constructor === String, (5).constructor === Number);
console.log({}.constructor === Object, (true).constructor === Boolean);
console.log(typeof Array, Array.name, Array.length, Object.name, Number.length);
const A = Array;
console.log(A === Array, A.name, new A(3).length, A(1, 2).join(","));
console.log(Object.prototype.toString.call([]), [].constructor.name);
console.log(Array.prototype.constructor === Array, [] instanceof A);
// String / Number / Boolean 这三个既是命名空间也是函数：当值用时给的是构造器那一格，
// 于是 `"".constructor === String` 与 `S(5)` 说的是同一个东西
const S = String, N = Number, B = Boolean;
console.log(S(5), N("2.5"), B(0), S.name, N.name, B.name);
console.log("".constructor === S, (1).constructor === N, (false).constructor === B);
const R = RegExp;
const rx = new R("a/b", "i");
console.log(rx.source, rx.flags, rx.test("XA/B"), /a/.constructor === RegExp);
const Sy = Symbol;
console.log(typeof Sy("d"), Sy("d").description, Symbol("x").constructor === Symbol);
console.log((function(){}).constructor === Function, [].constructor === Object);
console.log(new Map().constructor === Map, new Set().constructor === Set);
// 类的实例照旧走它自己原型上那一格 constructor（这条路本来就通，别被上面那格盖掉）
class C {}
console.log(new C().constructor === C, new C().constructor.name);
console.log(({}).constructor.name, Object.getPrototypeOf([]) === Array.prototype);
