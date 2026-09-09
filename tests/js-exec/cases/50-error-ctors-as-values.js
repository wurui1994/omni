// 异常那八族当**值**用（ADR-0020）。从前 const E = Error 是一句编译期的 unresolved
// identifier，而 e.constructor 四条腿一致地给 Object（node 给 TypeError）—— 后者是静默的
// 错答案。这一刀八个点一起落：每族一格自己的原型（原型的原型是 Error.prototype，八个
// 构造器共用一格的话它们写的 constructor 会互相盖掉）、err_new 按 $cls[0] 挑原型、
// mk_ctors 八格构造器、降级器让那八个名字走 js_realm_ctor。
// C 那条腿上异常对象仍是 dict（没有原型链），所以那儿走的是两句特判：ctor_get 按 $cls[0]
// 回构造器、instanceof 右手是这八格构造器值时查 $cls 链 —— js_ctor_get 本来就自己占一格
// op，正是为了两条腿能说同一句话。
// 量的：constructor 的同一性、instanceof（右手是变量、且不能对别族为真）、name/length、
// AggregateError 的实参次序 (errors, message, opts)、以及 Object.keys 照旧是空的。
const e = new TypeError("t");
console.log(e.constructor.name, e.constructor === TypeError, e.constructor === Error);
console.log(new Error("x").constructor.name, ({}).constructor.name);
const E = TypeError;
const e2 = new E("v");
console.log(e2.name, e2.message, e2 instanceof E, e2 instanceof Error, e2 instanceof RangeError);
console.log(TypeError.name, TypeError.length, AggregateError.length);
const A = AggregateError;
const ag = new A([1, 2], "many");
console.log(ag.name, ag.message, ag.errors.join("|"), ag instanceof Error);
console.log(String(e2), JSON.stringify(Object.keys(e2)));
try { null.f; } catch (er) { console.log(er.constructor.name, er instanceof TypeError); }
