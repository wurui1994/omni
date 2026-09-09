// 生成器在五条腿上（ADR-0020 P2）。状态机的改写在前端（frontend-js/genfn.js）就做完了，
// 运行时这一侧只有三格：一格带 $stp（状态机闭包）/ $gst（0 没开始 / 1 跑过 / 2 完了）两槽的
// 真对象、一格 {value, done}、以及驱动它的 gen_step（next / return / throw 是 mode 0 / 1 / 2）。
// yield* 那一行落在"手写协议"那条路上：数组的 Symbol.iterator 要交出一格真迭代器对象。
function* g() { yield 1; yield 2; return 3; }
const it = g();
console.log(JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()));
console.log([...g()].join(","));
for (const v of g()) console.log(v);
function* h() { const x = yield "a"; console.log("got", x); yield x * 2; }
const i2 = h();
console.log(i2.next().value, i2.next(21).value);
function* k() { try { yield 1; } finally { console.log("fin"); } }
const i3 = k();
console.log(i3.next().value, JSON.stringify(i3.return(9)));
function* del() { yield* [1, 2]; yield 3; }
console.log([...del()].join(","));
