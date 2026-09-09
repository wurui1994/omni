// toFixed / toExponential（与已有的 toPrecision 同一族）。
// **只有 JS 这一侧**：它们在恰好一半上进位（(1.5).toFixed(0) 是 "2"、2.5 是 "3"），
// 而 C 的 %.Nf 就近取偶（2.5 给 "2"）—— 要在 C 里对上得走十进制那条路，所以这两格
// 进了 P1_JS_ONLY，C 那条腿当场报错，不给一个"多数时候对"的答案。
console.log((1.005).toFixed(2), (1234.5678).toFixed(0), (0).toFixed(0), (-1.45).toFixed(1));
console.log((1.5).toFixed(0), (2.5).toFixed(0), (1e21).toFixed(2), (255).toFixed());
console.log((0.000001234).toExponential(2), (123.456).toPrecision(4), (1500).toExponential());
console.log((0.1).toFixed(20), (12).toExponential(0));
/* 这一族的实参照规范 ToIntegerOrInfinity（21.1.3.x 每一格的第一步）：串 / 布尔 / null 都
   收得下，从前非数当场报（量出来的）。越界照旧是**能 catch** 的 RangeError。 */
console.log((1.567).toFixed("2"), (1.5).toFixed(null), (1.5).toFixed(true), (255).toString("16"));
console.log((123.456).toPrecision("4"), (1234.5).toExponential("2"), (255).toString(2));
try { (1).toFixed(101); } catch (e) { console.log("fixed", e.name, e instanceof RangeError); }
try { (1).toString(1); } catch (e) { console.log("radix", e.name, e instanceof RangeError); }
try { (1).toPrecision(0); } catch (e) { console.log("prec", e.name, e instanceof RangeError); }
// repeat 的负数也是能 catch 的 RangeError（规范 22.1.3.18）—— C 那条腿还是硬错，见 ADR-0020
try { "x".repeat(-1); } catch (e) { console.log("repeat", e.name, e instanceof RangeError); }
console.log(JSON.stringify("x".repeat(0)), "x".repeat("2"), "abc".padEnd(-1));
// Math.* 的实参照规范 ToNumber
console.log(Math.abs("-3"), Math.max("2", 1), Math.round("2.5"), Math.trunc("-4.7"));
console.log(Math.sign("-2"), Math.hypot("3", 4), Math.pow("2", "3"), Math.sqrt("9"));
