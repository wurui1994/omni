// Proxy（ADR-0020 P4）。代理与普通对象是**同一种值**（$dynTag 都给 "object"），
// 差别只在属性访问的五个入口上多问一句陷阱：get / set / has / deleteProperty / ownKeys。
// 处理器上没有那一格就落到目标身上。
//
// 不做的写在明处：apply / construct（代理还不能当函数调）、getPrototypeOf、
// defineProperty、getOwnPropertyDescriptor，以及规范里那一整套"不变量校验" ——
// 只有 Object.keys 那一档（ownKeys + 可枚举性）照规范再问了一遍目标的描述符。
const always42 = new Proxy({}, { get() { return 42; } });
console.log(always42.anything, always42.x);

const log = [];
const t = { a: 1 };
const p = new Proxy(t, {
  get(tt, k) { log.push(`g:${String(k)}`); return tt[k]; },
  set(tt, k, v) { log.push(`s:${String(k)}`); tt[k] = v; return true; },
  has(tt, k) { return k === "magic" || k in tt; },
  deleteProperty(tt, k) { log.push(`d:${String(k)}`); delete tt[k]; return true; },
  ownKeys() { return ["a", "notOnTarget"]; },
});
console.log(p.a);
p.b = 2;
console.log(t.b, "magic" in p, "nope" in p, "a" in p);
// ownKeys 报了但目标上没有的键不进 Object.keys（规范要过一遍目标的描述符）
console.log(Object.keys(p).join("|"));
const del = delete p.b;
console.log(del, t.b, log.join(","));

// 空处理器：五个入口全部落到目标
const pass = new Proxy({ v: 7 }, {});
console.log(pass.v, "v" in pass, Object.keys(pass).join("|"));
pass.w = 8;
console.log(pass.w, Object.keys(pass).join("|"));
