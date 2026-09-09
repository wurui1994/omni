/* 真对象（ADR-0020 P1-c 的第十步）：OMNI_DYN_OBJ + 有序槽表 + 原型链。
   这条腿上"普通对象"照旧是 dict（对象字面量、JSON 摊出来的那些），真对象只在**要原型**
   或**要属性位**的地方出现 —— Object.create、访问器、（下一步的）类的实例。所以原型链
   的末端常常是一格 dict：取属性、in、for-in 都要接着在那一格上按容器找。 */
const p = { greet() { return "hi " + this.who; }, kind: "proto" };
const o = Object.create(p);
o.who = "you";
console.log(o.who, o.kind, o.greet());
console.log(Object.keys(o).join(","), Object.getPrototypeOf(o) === p);
console.log("who" in o, "kind" in o, "zz" in o, Object.hasOwn(o, "kind"));
const ks = [];
for (const k in o) ks.push(k);
console.log(ks.join(","));
console.log(typeof o, JSON.stringify(o), String(o));
o.n = 1;
o.n += 2;
console.log(o.n, delete o.n, o.n);
const bare = Object.create(null);
bare.x = 5;
console.log(bare.x, Object.keys(bare).join(","), Object.getPrototypeOf(bare));
console.log(Reflect.get(o, "kind"), Reflect.set(o, "w", 9), o.w);
console.log(Object.entries(o).map(([k, v]) => k + "=" + v).join(","));
console.log(Object.values(o).join(","));
