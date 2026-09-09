// ToPrimitive：valueOf / toString / Symbol.toPrimitive 的次序
const a = { valueOf() { return 7; }, toString() { return "seven"; } };
console.log(a + 1, "" + a, String(a), a * 2);
const b = { toString() { return "b"; } };
console.log(b + "!", b == "b");
const c = { [Symbol.toPrimitive](hint) { return hint === "number" ? 42 : "hint:" + hint; } };
console.log(+c, "" + c, String(c), c + 1);
console.log([1, 2] + "", ({}) + "");
/* Object.prototype.toString 的那格标签（规范 20.1.3.6）：先问 Symbol.toStringTag，再看
   builtinTag。Map / Set / 正则 / Symbol 在这个值域里不是"真对象"，所以照标签直说；
   Date / Error / Promise 造出来的对象自己没有 cl，认它们的原型。从前这一族全是
   "[object Object]" —— 静悄悄的错值，按它分派类型的库会全走错。
   WeakMap / WeakSet 报 Map / Set，ArrayBuffer / Uint8Array 报 Object：那两格是
   "同一种值"这条边界的后果（ADR-0011 决策 10 / ADR-0020 P4），不在这儿量。 */
const ts = Object.prototype.toString;
console.log(ts.call(new Map()), ts.call(new Set()), ts.call(/x/), ts.call(Symbol("s")));
console.log(ts.call(new Date(0)), ts.call(new Error("e")), ts.call(Promise.resolve()));
console.log(ts.call([]), ts.call({}), ts.call(function(){}), ts.call("s"), ts.call(1));
console.log(ts.call(true), ts.call(null), ts.call(undefined));
console.log(ts.call(new TypeError("t")), ts.call(Object.create(null)));
// String(new Map()) 走的是同一格（ToPrimitive -> Object.prototype.toString）
console.log(String(new Map()), String(new Set()), `${new Map()}`);
