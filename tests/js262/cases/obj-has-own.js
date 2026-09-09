/* Object.hasOwn / in / Reflect.has / Reflect.deleteProperty。这条腿上"普通对象"是 dict、
   数组是一段 items —— 没有原型链，所以"自有键"就是全部键，三格都落回容器那一套。
   两格从前的错：串上的下标与 length 也是自有属性（规范 10.4.3），而 Object.hasOwn("ab", 0)
   静静地给 false；C 那条腿上删一格不存在的名字给 false，规范说 true（删不掉才是 false）。 */
const o = { a: 1, b: undefined };
console.log(Object.hasOwn(o, "a"), Object.hasOwn(o, "b"), Object.hasOwn(o, "z"));
const a = [7, 8];
a.tag = "t";
console.log(Object.hasOwn(a, 0), Object.hasOwn(a, "1"), Object.hasOwn(a, 2), Object.hasOwn(a, "length"), Object.hasOwn(a, "tag"));
console.log(Object.hasOwn("ab", 0), Object.hasOwn(1, "x"));
console.log("a" in o, "z" in o, 0 in a, 5 in a, "length" in a, "tag" in a);
console.log(Reflect.has(o, "a"), Reflect.has(o, "z"), Reflect.has(a, 1));
console.log(Reflect.deleteProperty(o, "a"), JSON.stringify(o), Reflect.deleteProperty(o, "nope"));
const s = Object.seal({ k: 1 });
console.log(Reflect.deleteProperty(s, "k"), JSON.stringify(s));
