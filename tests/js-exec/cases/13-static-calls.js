// 静态解析的宿主调用里几个"形状不合"的（ADR-0011 决策 2 / ADR-0013 第三刀）：
//
//   Math.imul  —— 32 位乘法。它不属于 `Math.*` 那一族，属于 i32 那三条 op：
//                 `a * b` 先在 double 里丢精度、再折回 i32 已经错了
//   Math.pow   —— 与 `**` 是同一件事，所以就是那条算术 op
//   String.fromCharCode(a, b, …) —— JS 里收可变实参，而 ABI 的 op 是定长的；
//                 语义是可结合的两两归约，所以摊成"逐个单实参调用用 + 接起来"
//   Object.hasOwn —— 这个值域里的对象没有原型链，它就是 `in`
const big = 0x7fffffff;
console.log(`imul ${Math.imul(big, big)}`);
console.log(`imul ${Math.imul(3, -4)}`);
// 这一格是 imul 与 `(a * b) | 0` 的分水岭：乘积超过 2^53，double 已经丢了低位
console.log(`imul ${Math.imul(123456789, 987654321)}`);
console.log(`pow ${Math.pow(2, 10)} ${Math.pow(9, 0.5)} ${Math.pow(2, -1)}`);
console.log(`chars ${String.fromCharCode(72)}`);
console.log(`chars ${String.fromCharCode(72, 105)}`);
console.log(`chars ${String.fromCharCode(0x4f60, 0x597d, 33)}`);
const o = { a: 1 };
console.log(`hasOwn ${Object.hasOwn(o, "a")} ${Object.hasOwn(o, "b")}`);
// 负零：`String(-0)` 丢符号，`1 / -0 < 0` 是留着符号的那条判据
const nz = -0;
console.log(`negzero ${String(nz)} ${nz === 0 && 1 / nz < 0}`);
