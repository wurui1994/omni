// ES2025 的迭代器 helper（Iterator.prototype 上那 11 格）。JS / 解释器两条腿共用 prelude 的
// iterP，本来就有；C 那条腿自己建 realm，从前 Iterator.prototype 是"读成员就报"的代理，
// 于是 nat().take(3) 在那儿是一句响错。现在那边也是真对象：惰性的五格（take/drop/map/
// filter/flatMap）交一格状态全摊在槽里的 helper 对象（$k/$up/$fn/$n/$i/$f/$c/$in），
// 终结的六格就地拉完或短路。量的是**惰性**（无穷源上照样收）与 return 一层层链下去
// （fin() 的 finally 在 take(2) 拉完之后就跑）。
function* nat() { let i = 1; while (true) yield i++; }
function* fin() { try { yield 1; yield 2; yield 3; yield 4; } finally { console.log("cleanup"); } }
console.log([...fin().map((x) => x * 10).take(2)].join(","));
console.log([...nat().take(3)].join(","));
console.log(nat().take(4).reduce((a, b) => a + b));
const h = nat().map((x) => x);
console.log(typeof h.next, typeof h.take, Object.keys(h).length);
h.return();
console.log(h.next().done);
nat().take(3).forEach((x, i) => console.log("fe", i, x));
console.log(nat().take(0).toArray().length, [...nat().drop(3).take(1)].join(","));
for (const x of nat().map((v) => v * 3)) { if (x > 8) break; console.log("of", x); }
console.log(nat().take(9).find((x) => x > 4), nat().take(3).some((x) => x === 2), nat().take(3).every((x) => x < 3));
console.log([...nat().take(2).flatMap((x) => [x, -x])].join(","));
console.log([...nat().filter((x) => x % 3 === 0).take(2)].join(","));
