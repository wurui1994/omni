// ToPrimitive 在五条腿上（ADR-0020 P1-c）。这个值域里 valueOf 在任何对象上都只交回自己，
// 所以答案只由"自带的 toString"决定：有就调它（可能交回**一个数**——那时候 + 是数值加，
// 不是拼串），没有就落回按标签那串（数组是 join(",")、普通对象是 "[object Object]"）。
// C 那条腿上"调回调"要现拼实参 list，而 omni_js.c 造不出来 —— 所以段那边登记一格钩子。
class B { toString() { return "B!"; } }
const b = new B();
console.log("" + b, `${b}`, [b].join("-"), String(b));

const c = { toString() { return "C!"; } };
console.log("" + c, `x${c}y`, [c, c].join(","));

const n = { toString() { return 42; } };
console.log(n + 1, 1 + n, n * 2, `${n}`);

console.log([1, 2] + 1, {} + 1, 1 + [2], [3] * 2, [] + 1);
console.log("" + {}, "" + [1, 2], "" + new Error("e"));
