// 内部标记不该被观察到。JSON.stringify 从前用 [[Get]] 去问"这一格是不是类对象"
// （omni.classInit 那个符号键），于是**代理的 get 陷阱把这一问也接住了** —— 一个"每个键都
// 答一句"的校验代理上 JSON.stringify 静静地给 undefined，而两把尺子都老老实实序列化。
// 现在判据取自有的槽（$js_is_class），不走 [[Get]]。
const t = { a: 1, b: "x" };
const combos = {
  none: {},
  get: { get: (o, k, r) => Reflect.get(o, k, r) },
  ownKeys: { ownKeys: (o) => Reflect.ownKeys(o) },
  answerAll: { get: (o, k, r) => (k in o ? Reflect.get(o, k, r) : "<no " + String(k) + ">") },
  guard: {
    get: (o, k, r) => (k in o ? Reflect.get(o, k, r) : "<no " + String(k) + ">"),
    set: (o, k, v, r) => Reflect.set(o, k, v, r),
    has: (o, k) => Reflect.has(o, k),
    ownKeys: (o) => Reflect.ownKeys(o),
  },
};
for (const [name, h] of Object.entries(combos)) {
  const p = new Proxy(t, h);
  console.log(name, JSON.stringify(p), Object.keys(p).join(","), String(p.a));
}
// 非函数的 toJSON 照规范忽略（不是"整格不序列化"）
console.log(JSON.stringify({ a: 1, toJSON: "not a fn" }), JSON.stringify({ a: 1, toJSON: 42 }));
console.log(JSON.stringify({ a: 1, toJSON: null }), JSON.stringify({ a: 1, toJSON: undefined }));
console.log(JSON.stringify({ a: 1, toJSON() { return { b: 2 }; } }));
// 真的类对象照旧是 undefined（JS 里类是函数）
class K { m() { return 1; } }
console.log(String(JSON.stringify(K)), String(typeof K), JSON.stringify({ k: K }));
