const t = { a: 1, b: 2 };
const p = new Proxy(t, {
  get(o, k) { return k in o ? o[k] : "<" + String(k) + ">"; },
  set(o, k, v) { o[k] = v * 10; return true; },
  has(o, k) { return k === "secret" || k in o; },
  deleteProperty(o, k) { delete o[k]; return true; },
  ownKeys(o) { return ["a"]; },
});
console.log(p.a, p.zz, "secret" in p, "zz" in p);
p.c = 3;
console.log(t.c, p.c);
console.log(Object.keys(p).join(","), JSON.stringify(p));
console.log(delete p.a, t.a, p.a);
const bare = new Proxy({ x: 1 }, {});
console.log(bare.x, "x" in bare, Object.keys(bare).join(","));
