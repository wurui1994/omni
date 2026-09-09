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
/* 写的那一族（setFullYear / setMonth / setHours / setTime / setUTC*）：Date 在这个值域里是
   "真对象 + 隐藏槽 $ms"，所以每一格都是"现搭一个宿主 Date、改完把毫秒写回槽里"，
   交出新的毫秒。从前整族缺失，d.setFullYear(2000) 是运行期 "undefined is not a function"。 */
const w = new Date(0);
console.log(w.setFullYear(2000) === w.getTime(), w.getFullYear());
w.setMonth(5, 20);
console.log(w.getMonth(), w.getDate());
w.setHours(3, 4, 5, 6);
console.log(w.getHours(), w.getMinutes(), w.getSeconds(), w.getMilliseconds());
const t2 = new Date(0);
t2.setTime(86400000);
console.log(t2.getTime(), t2.toISOString());
const u2 = new Date(0);
u2.setUTCFullYear(1999);
u2.setUTCMonth(11);
u2.setUTCDate(31);
console.log(u2.toISOString(), typeof u2.setDate(2));

/* Date.UTC(y[, mo, d, h, mi, s, ms])：与 new Date(y, mo, …) 同一族，只是**按 UTC** 算。
   年缺席就是 NaN（规范：ToNumber(undefined) 是 NaN），别的缺席按 0/1 补；0..99 的年份
   映到 1900+y（规范 MakeFullYear）；月份越界照旧进位。从前这一格当场报
   "'Date.UTC' is not in the closed ABI"。 */
console.log(Date.UTC(2020, 0, 2, 3, 4, 5, 6), Date.UTC(2020, 0, 2), Date.UTC(2020));
console.log(Date.UTC(70, 0, 1), Date.UTC());
console.log(new Date(Date.UTC(2020, 0, 2)).toISOString());
console.log(Date.UTC(2020, 12, 1) === Date.UTC(2021, 0, 1));
// 当值用（表里带 len，所以取得成一格薄包装的函数值）
const U = Date.UTC;
console.log(U(2020, 0, 1) === Date.UTC(2020, 0, 1), Date.UTC.length, Date.UTC.name);

/* Date.prototype[Symbol.toPrimitive]（规范 21.4.4.45）：隐式强转那条路早就对，缺的是
   **显式取那一格函数**。口径照规范："number" 给毫秒，"string" 与 "default" 都给
   toString —— Date 是唯一一个 default 走串的内建。 */
const sp = new Date(86400000);
console.log(typeof sp[Symbol.toPrimitive], sp[Symbol.toPrimitive]("number"));
console.log(sp[Symbol.toPrimitive]("string") === sp.toString());
console.log(sp[Symbol.toPrimitive]("default") === sp.toString());
console.log(sp - new Date(0), `${sp}` === sp.toString(), +sp);
console.log(Object.getOwnPropertySymbols(Object.getPrototypeOf(sp)).length > 0);

/* TimeClip（规范 21.4.1.31）：时间值只在 ±8.64e15 毫秒之内，出了界是 NaN，不是"很大的数"。
   从前 new Date(8.64e15 + 1).getTime() 把那个数原样交了出去 —— 静悄悄的错值，
   接着 toISOString 就印出一个规范里不存在的年份。小数照 trunc 往零走，-0 归 0。 */
console.log(new Date(8.64e15).toISOString(), new Date(8.64e15).getTime());
console.log(Number.isNaN(new Date(8.64e15 + 1).getTime()), Number.isNaN(new Date(-8.64e15 - 1).getTime()));
console.log(Number.isNaN(new Date(Infinity).getTime()), Number.isNaN(new Date(NaN).getTime()));
console.log(new Date(1.5).getTime(), new Date(-1.5).getTime(), 1 / new Date(-0.5).getTime());
console.log(Number.isNaN(Date.UTC(275760, 8, 14)), new Date(Date.UTC(275760, 8, 13)).toISOString());
/* 无效日期上的 toISOString 是**能 catch** 的 RangeError（规范 21.4.4.36 第 3 步）。从前直接
   转手宿主的同名方法 —— 宿主抛的是宿主异常，一路冒到顶把进程崩掉（印出一整片 node 栈）。
   toJSON 不一样：规范 21.4.4.37 第 3 步在无效日期上交 null，不抛。 */
try { new Date(NaN).toISOString(); } catch (e) { console.log("iso", e.name, e instanceof RangeError); }
console.log(new Date(NaN).toJSON(), JSON.stringify({ d: new Date(NaN) }), String(new Date(NaN)));
console.log(new Date(0).toJSON(), JSON.stringify({ d: new Date(0) }));
