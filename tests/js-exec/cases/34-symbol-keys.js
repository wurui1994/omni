// 符号键的对象字面量与 Symbol.toPrimitive 在五条腿上（ADR-0020 P1-c）。
// 带**计算键**的字面量一律降成真对象：静态判不出那个键是串还是符号，而这条腿上的
// "普通对象"是一格 dict —— dict 的键是 UTF-8 串，挂不了符号。
const s = Symbol("k");
const o = { [s]: 1, a: 2, ["b" + "c"]: 3 };
console.log(o[s], o.a, o.bc, Object.keys(o).join(","), JSON.stringify(o));
console.log(s in o, Object.getOwnPropertySymbols(o).length);

// Symbol.toPrimitive：实参是 hint 的名字（"string" / "number" / "default"），
// 三个名字必须一字不差 —— 回调里按名字分派的写法很常见。
const c = { [Symbol.toPrimitive](h) { return h === "number" ? 5 : h === "string" ? "S" : "D"; } };
console.log(c + 1, c * 2, `${c}`, String(c), Number(c));

class K { [Symbol.toPrimitive](h) { return h === "number" ? 9 : "K"; } }
const k = new K();
console.log(k + 1, k * 3, `${k}`);
