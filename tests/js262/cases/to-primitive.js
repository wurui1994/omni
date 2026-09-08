// ToPrimitive：valueOf / toString / Symbol.toPrimitive 的次序
const a = { valueOf() { return 7; }, toString() { return "seven"; } };
console.log(a + 1, "" + a, String(a), a * 2);
const b = { toString() { return "b"; } };
console.log(b + "!", b == "b");
const c = { [Symbol.toPrimitive](hint) { return hint === "number" ? 42 : "hint:" + hint; } };
console.log(+c, "" + c, String(c), c + 1);
console.log([1, 2] + "", ({}) + "");
