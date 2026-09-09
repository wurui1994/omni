/* 属性描述符（规范 6.2.6 / 10.4.2.1）。这条腿上"普通对象"是 dict、数组是一段 items —— 都
   没有属性位，所以描述符是照实合成的那一格：数据属性 + 三档锁算出来的三个位。
   两处从前的错：C 那条腿整格拒（js_obj_desc / js_obj_descs / js_obj_own_keys 在
   P1_JS_ONLY 里），而 JS 那条腿把冻住的数组说成 writable: true —— 写进去确实被拦下了，
   描述符却还说能写，是悄悄的错答案。 */
const d = { a: 1, b: "s" };
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(d, "a")));
console.log(String(Object.getOwnPropertyDescriptor(d, "zz")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptors(d)));
console.log(Object.getOwnPropertyNames(d).join(","));

const a = [7, 8];
a.tag = "t";
console.log(Object.getOwnPropertyNames(a).join(","));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(a, "0")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(a, "length")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(a, "tag")));
console.log(String(Object.getOwnPropertyDescriptor(a, "9")));

console.log(Object.getOwnPropertyNames("ab").join(","));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor("ab", "0")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor("ab", "length")));

const fz = Object.freeze([1, 2]);
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(fz, "0")));
const fd = Object.freeze({ k: 1 });
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(fd, "k")));
const sd = Object.seal({ k: 1 });
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(sd, "k")));
