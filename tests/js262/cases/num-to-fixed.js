// toFixed / toExponential（与已有的 toPrecision 同一族）。
// **只有 JS 这一侧**：它们在恰好一半上进位（(1.5).toFixed(0) 是 "2"、2.5 是 "3"），
// 而 C 的 %.Nf 就近取偶（2.5 给 "2"）—— 要在 C 里对上得走十进制那条路，所以这两格
// 进了 P1_JS_ONLY，C 那条腿当场报错，不给一个"多数时候对"的答案。
console.log((1.005).toFixed(2), (1234.5678).toFixed(0), (0).toFixed(0), (-1.45).toFixed(1));
console.log((1.5).toFixed(0), (2.5).toFixed(0), (1e21).toFixed(2), (255).toFixed());
console.log((0.000001234).toExponential(2), (123.456).toPrecision(4), (1500).toExponential());
console.log((0.1).toFixed(20), (12).toExponential(0));
