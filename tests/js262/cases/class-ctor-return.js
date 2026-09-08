/* 构造器 `return {…}`：`new C()` 的值是**返回的那一格**（规范 10.2.2 第 13 步）。
   返回别的（数、字符串、undefined）就还是实例。从前 $init 的返回值整个被丢掉，
   `new F()` 于是悄悄给出一格空实例 —— silent 的错答案。 */
class F {
  constructor() { return { custom: 1 }; }
}
const f = new F();
console.log(JSON.stringify(f), f instanceof F, Object.getPrototypeOf(f) === Object.prototype);

class H {
  constructor() { this.a = 1; return 5; }
}
console.log(JSON.stringify(new H()), new H() instanceof H);

class K {
  constructor(useOther) { this.k = 1; if (useOther) return { other: true }; }
}
console.log(JSON.stringify(new K(false)), JSON.stringify(new K(true)));

// 返回数组也算对象；返回 null / undefined 不算
class L { constructor() { return [1, 2]; } }
class M { constructor() { this.m = 1; return null; } }
console.log(JSON.stringify(new L()), Array.isArray(new L()), JSON.stringify(new M()));

// 缓存实例这个套路（返回同一格）因此也成立
const cache = {};
class N {
  constructor(id) {
    if (cache[id]) return cache[id];
    this.id = id;
    cache[id] = this;
  }
}
const n1 = new N("a"), n2 = new N("a");
console.log(n1 === n2, n1.id, new N("b").id);
