// String.fromCodePoint / fromCharCode 收**可变**实参（规范 22.1.2.1 / 22.1.2.2 逐个码点
// 拼串）。fromCodePoint 从前只收一格：`String.fromCodePoint(97, 98)` 直接拒（"takes at most 1"），
// 而它与 fromCharCode 是同一族可摊开的归约。零实参那格两个名字都错：落到"缺席补 undefined"
// 上，$js_idx(undefined, 0) 是 0 —— 静静地多印一格 NUL。
console.log(String.fromCodePoint(97, 98, 99));
console.log(String.fromCodePoint(0x1f600, 65));
console.log(String.fromCharCode(72, 105));
console.log(String.fromCodePoint());
console.log(String.fromCodePoint(97).length, String.fromCodePoint(0x1f600).length);
console.log(String.fromCharCode());
console.log(JSON.stringify([String.fromCodePoint(), String.fromCharCode()]));
const xs = [104, 105];
console.log(String.fromCharCode(...xs), String.fromCodePoint(...xs));
