// Symbol 那一族现在**四条腿都有**（C 侧 runtime/omni_js_sym.c，ADR-0020 P1-c 的第一步）。
// 三条定死的规矩：同一性就是地址（Symbol("a") !== Symbol("a")）；Symbol.for 同名共用一格；
// Symbol() 与 Symbol("") 可观察地不同（前者 description 是 undefined）。
// 注意这儿刻意不碰 s.toString() / s.description —— 那要 Symbol.prototype（真对象那一片，还在 P1-c）。
const s1 = Symbol("a"), s2 = Symbol("a"), s3 = Symbol(""), s4 = Symbol();
console.log(typeof s1, String(s1 === s2), String(s1 === s1), String(s1 !== s2));
console.log(String(s1), String(s3), String(s4));
const f1 = Symbol.for("k"), f2 = Symbol.for("k");
console.log(String(f1 === f2), Symbol.keyFor(f1), String(Symbol.keyFor(s1)));
console.log(String(Symbol.iterator === Symbol.iterator), String(Symbol.iterator));
console.log(String(Symbol.toStringTag), String(Symbol.iterator === Symbol.toStringTag));
console.log(String(Symbol.keyFor(Symbol.iterator)));
console.log(String(Symbol.for("Symbol.iterator") === Symbol.iterator));
