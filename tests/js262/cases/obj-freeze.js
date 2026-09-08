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
