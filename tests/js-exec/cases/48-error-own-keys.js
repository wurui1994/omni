// 异常对象的"自有属性"四种视图（ADR-0011 决策 15 + ADR-0020）。$cls 是内部标记，
// **任何**视图里都不该出现；name 在规范里住在原型上；message / cause 是 own 但不可枚举 ——
// 于是 keys / entries / values / for-in / JSON 里没有它们，getOwnPropertyNames 里有。
// 量出来的两处分叉：C 那条腿上异常对象是一格 dict（没有"可枚举"这一格属性），
// Object.keys / entries / values 会把 ["$cls","name","message"] 一起吐出来；
// 而 getOwnPropertyNames 连 JS 那条腿都在漏 $cls。现在四条腿一个口径。
// （stack 我们没有 —— 那一格与 node 的差另算，所以这儿把它滤掉再比。）
const e = new TypeError("t");
console.log(JSON.stringify(Object.keys(e)), JSON.stringify(e));
console.log(JSON.stringify(Object.entries(e)), JSON.stringify(Object.values(e)));
const ks = []; for (const k in e) ks.push(k);
console.log(JSON.stringify(ks));
console.log(JSON.stringify(Object.getOwnPropertyNames(e).filter((k) => k !== "stack")));
const e2 = new Error("c", { cause: 7 });
console.log(JSON.stringify(Object.keys(e2)), e2.cause, e2.message, e2.name);
console.log(JSON.stringify(Object.getOwnPropertyNames(e2).filter((k) => k !== "stack")));
// 抛出来的那一路照旧：catch 得到、instanceof 认得出、文本对得上
try { null.f; } catch (er) { console.log(er.name, er instanceof TypeError, JSON.stringify(Object.keys(er))); }
console.log(String(e), e.message, e.name);
