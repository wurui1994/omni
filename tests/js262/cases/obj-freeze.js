// freeze / seal / preventExtensions
const o = { a: 1 };
Object.freeze(o);
o.a = 2;
o.b = 3;
console.log(o.a, o.b, Object.isFrozen(o), Object.isSealed(o), Object.isExtensible(o));
const s = { x: 1 };
Object.seal(s);
s.x = 2;
s.y = 3;
console.log(s.x, s.y, Object.isFrozen(s), Object.isSealed(s));
const p = { z: 1 };
Object.preventExtensions(p);
p.z = 5;
p.w = 6;
console.log(p.z, p.w, Object.isExtensible(p));
/* 数组还不是真对象（P4 的 array exotic 那一片），`Object.freeze(数组)` 是空操作 ——
   所以 isFrozen / isSealed 在数组、Map、Set 上照实说"没冻住"。从前它们跟着"不是对象就算
   冻住"那条走，给出 true（代码会以为改不动了，是更危险的一边）。原始值照规范算冻住。 */
const arr = [1, 2];
console.log(Object.isFrozen(arr), Object.isSealed(arr), Object.isExtensible(arr));
console.log(Object.isFrozen([...arr]), Object.isFrozen(new Map()), Object.isFrozen(new Set()));
console.log(Object.isFrozen(3), Object.isFrozen("ab"), Object.isFrozen(null), Object.isFrozen(undefined));
console.log(Object.isSealed(3), Object.isSealed("ab"), Object.isFrozen(true));
