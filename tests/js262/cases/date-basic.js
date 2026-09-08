// Date（ADR-0020 P4）：一格真对象，毫秒在隐藏槽 $ms 里（不可枚举），取值面挂在 realm 的
// dateP 上。只收两种形状：不给实参（当下）与一个毫秒数 —— 字符串解析与 (y, m, d, …)
// 那一族还没做，当场报错而不是给个错的时刻。
//
// 这条用例刻意只量 UTC 那几格与 toISOString：本地时区那几格转手宿主，qjs 与 node 在
// 同一台机器上一致，但写进用例就会被时区绑住。
const d0 = new Date(0);
console.log(d0.getTime(), d0.valueOf(), d0.toISOString());
console.log(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate(), d0.getUTCDay());
console.log(d0.getUTCHours(), d0.getUTCMinutes(), d0.getUTCSeconds(), d0.getUTCMilliseconds());

const d1 = new Date(1735689600000);
console.log(d1.toISOString(), d1.getUTCFullYear(), d1.getUTCDay());
// 隐藏槽不进 Object.keys；JSON.stringify 走 toJSON（规范 SerializeJSONProperty 第 2 步）
console.log(Object.keys(d1).length, JSON.stringify({ t: d1 }), JSON.stringify([d1]));
// 数值语境走 valueOf、字符串语境走 toString
console.log(d1 - d0, d1 > d0, typeof String(d1));
// Date.now() 就是宿主时钟
console.log(typeof Date.now(), Date.now() > 1700000000000);
console.log(typeof new Date().getTime());
/* new Date 的另两种形状：一个**串**（走 Date.parse）与 (y, mo[, d, h, mi, s, ms])
   那一族（本地时区，缺的格子补 1/0）。从前两种都在降级那儿当场报。
   本地时区那一族只验"存进去再取出来"，不印 ISO —— 那会随机器的时区变。 */
const local = new Date(2024, 0, 15, 10, 30, 45, 500);
console.log(local.getFullYear(), local.getMonth(), local.getDate());
console.log(local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds());
const short = new Date(2024, 5);
console.log(short.getFullYear(), short.getMonth(), short.getDate(), short.getHours());
const fromStr = new Date("2024-01-15T00:00:00Z");
console.log(fromStr.getTime(), fromStr.toISOString(), Date.parse("2024-01-15T00:00:00Z"));
console.log(new Date("nope").getTime(), Number.isNaN(Date.parse("nope")));
console.log(new Date(0) instanceof Date, new Date(0) instanceof Object, ({}) instanceof Date);
console.log(new Date("2024-01-15T00:00:00Z").getUTCFullYear(), new Date(86400000).getTime());
