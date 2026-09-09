/* Object.getOwnPropertyNames 在**真对象以外**那几格上也要有答案：数组与串在 JS 里都是
   对象，length 是它们的一格自有属性（不可枚举），下标也是。从前一律给空表 —— 悄悄的
   错答案。次序照规范：整数下标升序在前，然后是别的字符串键（length 建得最早）。 */
const a = [1, 2, 3];
a.tag = "t";
console.log(Object.getOwnPropertyNames(a).join(","));
console.log(Object.keys(a).join(","), Object.values(a).join(","));
console.log(Object.getOwnPropertyNames([]).join(","));
console.log(Object.getOwnPropertyNames("ab").join(","));
console.log(Object.getOwnPropertyNames("").join(","));

// 描述符那一档早就对上了，这儿一并钉住（length 不可枚举、元素三个位全 true）
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(a, "length")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(a, "1")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(a, "tag")));

// Symbol 那一档在这几格上确实是空的：旁表只收字符串键
console.log(Object.getOwnPropertySymbols(a).length, Object.getOwnPropertySymbols("ab").length);

// Map / Set 身上没有自有的字符串键（条目不是属性）
console.log(Object.getOwnPropertyNames(new Map([["k", 1]])).join(","));
console.log(Object.getOwnPropertyNames(new Set([1])).join(","));

// 真对象那一档没变
const o = { a: 1 };
Object.defineProperty(o, "h", { value: 2 });
console.log(Object.getOwnPropertyNames(o).join(","), Object.keys(o).join(","));
