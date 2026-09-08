// Object.defineProperty 的默认值与不可写/不可枚举（ADR-0020 P1）
const o = {};
Object.defineProperty(o, "a", { value: 1 });
Object.defineProperty(o, "b", { value: 2, writable: true, enumerable: true, configurable: true });
o.a = 99;
o.b = 3;
console.log(o.a, o.b);
console.log(Object.keys(o).join(","));
const da = Object.getOwnPropertyDescriptor(o, "a");
console.log(da.value, da.writable, da.enumerable, da.configurable);
console.log(Object.getOwnPropertyNames(o).join(","));
