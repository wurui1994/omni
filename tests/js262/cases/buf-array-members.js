// Uint8Array 上结果是原始值的那四格（join / at / indexOf / includes）：先摊成
// 字节的数组，再走 list 那一格。map / filter / slice 在 JS 里交出的是 TypedArray，
// 摊成 list 会在打印与 JSON 上撒谎，所以那几个照旧当场报错 —— 那是画出来的边界。
const u = new Uint8Array(4);
u[0] = 10;
u[1] = 20;
u[2] = 30;
u[3] = 255;
console.log(u.join(","), u.join("|"), u.join());
console.log(new Uint8Array(0).join(",") === "", new Uint8Array(1).join(","));
// at 认负下标，越界给 undefined（与数组那一格同一套规矩）
console.log(u.at(0), u.at(3), u.at(-1), u.at(-4), u.at(9), u.at(-9));
console.log(u.indexOf(20), u.indexOf(255), u.indexOf(99), new Uint8Array(0).indexOf(0));
console.log(u.includes(255), u.includes(10), u.includes(0), u.includes(-1));
// 写进去只留低 8 位，所以按 300 找不到、按 44 找得到
const w = new Uint8Array(2);
w[0] = 300;
console.log(w.indexOf(300), w.indexOf(44), w.includes(300), w.includes(44), w.join(","));
