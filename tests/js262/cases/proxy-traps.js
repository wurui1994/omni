// Proxy（ADR-0020 P4）。代理与普通对象是**同一种值**（$dynTag 都给 "object"），
// 差别只在属性访问的那几个入口上多问一句陷阱：get / set / has / deleteProperty /
// ownKeys / getOwnPropertyDescriptor / defineProperty。处理器上没有那一格就落到目标身上。
//
// 不做的写在明处：规范里那一整套"不变量校验"，与 Proxy.revocable。
// getPrototypeOf / setPrototypeOf / isExtensible / preventExtensions 这四格补上了（见文末）。
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

/* getOwnPropertyDescriptor / defineProperty 两格陷阱。gOPD 交回来的描述符要**补齐**
   （规范 6.2.6.6：缺的 writable / enumerable / configurable 一律 false）；Object.keys
   那一档也改成问描述符（**走陷阱**）而不是直接翻目标 —— 从前这两格都不问陷阱，于是
   Object.keys(代理) 与 getOwnPropertyDescriptor(代理, k) 悄悄给出目标上的答案。 */
const dt = { a: 1 };
const dp = new Proxy(dt, {
  ownKeys() { return ["a", "extra"]; },
  getOwnPropertyDescriptor() { return { value: 7, enumerable: true, configurable: true }; },
  defineProperty(tt, k, d) { return Reflect.defineProperty(tt, k, d); },
});
console.log(Object.keys(dp).join(","), JSON.stringify(Object.getOwnPropertyDescriptor(dp, "a")));
Object.defineProperty(dp, "made", { value: 3, enumerable: true, configurable: true });
console.log(dt.made, Object.getOwnPropertyNames(dt).join(","));
// 没有那两格陷阱时落到目标
const dp2 = new Proxy({ q: 4 }, {});
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(dp2, "q")));
Object.defineProperty(dp2, "r", { value: 5, enumerable: false, configurable: false });
console.log(Object.keys(dp2).join(","), Object.getOwnPropertyNames(dp2).join(","));

/* 可调用的代理（apply / construct 两格陷阱）。目标是函数时代理自己也得**可调用** ——
   typeof 给 "function"、p(…) 走 apply、new p(…) 走 construct。这一支不造真对象而是造
   一格闭包记录（见 prelude 的 $js_proxy_new）：dynTag 的兜底认的正是那个形状。
   从前 new Proxy(函数, …) 在收实参那一步就当场报。 */
function greet(who) { return "hi " + who; }
const cp = new Proxy(greet, {
  get(t, k) { return k === "tag" ? "T" : t[k]; },
  apply(t, th, a) { return t(a[0]) + "!"; },
});
console.log(cp("a"), cp.tag, cp.name, cp.length, typeof cp);
// 没有 apply 陷阱：落到目标上；get 陷阱照旧生效
const cq = new Proxy(greet, { get(t, k) { return "g:" + String(k); } });
console.log(cq("b"), cq.whatever);
// 类目标 + construct 陷阱：第三个实参是 newTarget
class Box { constructor(v) { this.v = v; } m() { return this.v; } }
const cr = new Proxy(Box, { construct(t, a, nt) { return { seen: a[0], same: nt === cr }; } });
console.log(JSON.stringify(new cr(9)));
// 没有 construct 陷阱：照旧造真实例（类目标与函数目标两种都试）
const cs = new Proxy(Box, {});
console.log(new cs(4).m(), new cs(4) instanceof Box);
function Pt(x) { this.x = x; }
console.log(new (new Proxy(Pt, {}))(6).x);
// 陷阱看得见完整实参表；代理当回调用
const cv = new Proxy(function () { return arguments.length; }, {
  apply(t, th, a) { return a.length * 100 + t.apply(th, a); },
});
console.log(cv(1, 2, 3));
console.log([1, 2, 3].map(new Proxy(function (n) { return n; },
  { apply(t, th, a) { return a[0] * 2; } })).join(","));

/* getPrototypeOf / setPrototypeOf / isExtensible / preventExtensions 这四格陷阱
   （规范 10.5.1-10.5.4）。从前一格都不问 —— Object.getPrototypeOf(proxy) 静静地报的是
   **目标**那一格，instanceof 也跟着错（它走的是同一条链）。 */
const plog = [];
const pp = new Proxy({ a: 1 }, {
  getPrototypeOf(o) { plog.push("gp"); return Array.prototype; },
  setPrototypeOf(o, v) { plog.push("sp:" + (v === null)); return true; },
  isExtensible(o) { plog.push("ie"); return Reflect.isExtensible(o); },
  preventExtensions(o) { plog.push("pe"); return Reflect.preventExtensions(o); },
});
console.log(Object.getPrototypeOf(pp) === Array.prototype, pp instanceof Array);
console.log(Object.setPrototypeOf(pp, null) === pp, Object.isExtensible(pp));
console.log(Reflect.setPrototypeOf(pp, null), Reflect.getPrototypeOf(pp) === Array.prototype);
console.log(plog.join("|"));
// 没有陷阱时一路落到目标身上（原型链、instanceof、可扩展性都跟着目标）
const bareP = new Proxy(Object.create(Array.prototype), {});
console.log(Object.getPrototypeOf(bareP) === Array.prototype, bareP instanceof Array, Object.isExtensible(bareP));
