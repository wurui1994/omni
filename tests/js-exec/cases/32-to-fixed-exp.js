// toFixed / toExponential 在五条腿上（ADR-0020 P1-c）。舍入口径是全部难处：JS 在那个 double 的
// **精确十进制值**上舍、恰好一半时取绝对值更大的那个（(2.5).toFixed(0) 是 "3"），而 C 的 %.Nf
// 是就近取偶（给 "2"）。C 那条腿因此自己走精确展开 + "下一位 >= 5 就进"。
// 里头故意排了几处平局与"进位一路推到头"（9.995 / 999.995 / 9.99e0）。
console.log((2.5).toFixed(0), (1.5).toFixed(0), (0.5).toFixed(0), (-2.5).toFixed(0));
console.log((123.456).toFixed(1), (123.456).toFixed(0), (123.456).toFixed(5));
console.log((0).toFixed(2), (-0).toFixed(2), (1e21).toFixed(2), (1e-7).toFixed(3));
console.log((9.995).toFixed(2), (1.005).toFixed(2), (0.615).toFixed(2));
console.log((999.995).toFixed(2), (9.999).toFixed(2), (0.0001).toFixed(0));
console.log((1.25).toExponential(1), (1.35).toExponential(1), (0).toExponential(2));
console.log((123456).toExponential(), (0.000001234).toExponential(2), (1e21).toExponential(3));
console.log((-1.5).toExponential(0), (9.99).toExponential(1), (1).toExponential());
console.log((255).toString(16), (0.1).toFixed(20));
