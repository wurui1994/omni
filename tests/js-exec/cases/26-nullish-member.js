// null / undefined 上取属性 / 写属性是**能 catch** 的 TypeError（规范 7.3.2 的 GetV 与
// 7.3.4 的 SetV 都先 ToObject）。从前这几格是硬错，整个进程当场没了。
// 这里只量"抛没抛、是哪一族、之后还跑不跑" —— 消息文本两把尺子自己不一致
// （qjs 是 "cannot read property 'x' of null"，node 是 "Cannot read properties of
// null (reading 'x')"），逐字节那一份在 tests/js262/cases/nullish-member.js 里。
function kind(f) {
  try {
    f();
    return "no-throw";
  } catch (e) {
    return (e instanceof TypeError ? "TypeError" : e.name) + (e instanceof Error ? "+Error" : "");
  }
}

console.log(kind(() => null.x));
console.log(kind(() => undefined.x));
console.log(kind(() => { const o = null; o.x = 1; }));
console.log(kind(() => null[0]));
console.log(kind(() => undefined.f()));
console.log(kind(() => { const u = undefined; u[1] = 2; }));

// 链子中间断了
const deep = { a: { b: null } };
console.log(kind(() => deep.a.b.c), kind(() => deep.z.y));

// catch 之后照旧往下跑（从前这一句根本到不了）
console.log([1, 2].map((v) => v * 2).join(","));

// 可选链不抛
console.log(String(deep.a.b?.c), String(deep.z?.y), String(deep.z?.y?.x));

// 一格真的对象上取不存在的名字照旧是 undefined，不抛
console.log(String(deep.a.zork), kind(() => deep.a.zork));
