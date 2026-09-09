/* Date 那一族（ADR-0020 P4）：真对象 + $ms 隐藏槽，取值面四十格。
   本地时区那几格也在这儿 —— 五条腿跑在同一台机器上，C 的 localtime_r 与 node / qjs 用的是
   同一份 tz 数据，所以它们必须逐字节相同（"猜一个偏移"就会在这儿露出来）。
   toString / toTimeString 与 String(d) 不在这儿：那三格括号里带时区**名字**，三把尺子各说
   各话，C 那条腿上是一句响错（记在 ADR-0020 里）。 */
const d = new Date(Date.UTC(2020, 0, 2, 3, 4, 5, 678));
console.log(d.getTime(), d.valueOf());
console.log(d.toISOString());
console.log(d.toUTCString());
console.log(d.toDateString());
console.log(d.toJSON());
console.log(JSON.stringify({ when: d }));
console.log([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay()].join(","));
console.log([d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].join(","));
console.log([d.getFullYear(), d.getMonth(), d.getDate(), d.getDay()].join(","));
console.log([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()].join(","));
console.log(d.getTimezoneOffset() === new Date(Date.UTC(2020, 0, 2)).getTimezoneOffset());

// 同一性与形状
console.log(d instanceof Date, d.constructor === Date, typeof d);
console.log(Object.keys(d).length, Object.getOwnPropertyNames(d).length, Object.values(d).length);
console.log(typeof d.getTime, typeof d.zork);

// 隐式强转：数值口径走 [Symbol.toPrimitive]("number")，于是相减是个数
console.log(new Date(1000) - new Date(400));

// 写的那一族：现算出新的毫秒写回槽里，交出来的就是那个数
const f = new Date(0);
console.log(f.setUTCFullYear(1999), f.toISOString());
console.log(f.setUTCMonth(11, 25), f.toISOString());
console.log(f.setUTCHours(1, 2, 3, 4), f.toISOString());
console.log(f.setUTCMinutes(30), f.toISOString());
console.log(f.setTime(86400000), f.toISOString());
const g = new Date(Date.UTC(2020, 0, 31));
console.log(g.setUTCDate(32), g.toISOString());

// 本地那一族：写回去再按本地读出来必须对上
const h = new Date(2020, 5, 15, 12, 30, 45, 6);
console.log([h.getFullYear(), h.getMonth(), h.getDate()].join(","));
console.log([h.getHours(), h.getMinutes(), h.getSeconds(), h.getMilliseconds()].join(","));
console.log(h.getTime() === Date.parse("2020-06-15T12:30:45.006"));
console.log(h.setFullYear(2021), h.getFullYear(), h.getMonth(), h.getDate());
console.log(h.setHours(1, 2, 3), [h.getHours(), h.getMinutes(), h.getSeconds()].join(","));

// 溢出摊平（规范就是纯加法）
console.log(new Date(Date.UTC(2020, 12, 1)).toISOString());
console.log(new Date(Date.UTC(2020, -1, 1)).toISOString());
console.log(new Date(Date.UTC(2020, 0, 32)).toISOString());
console.log(new Date(Date.UTC(99, 0, 1)).getUTCFullYear());

// 无效日期：toJSON 交 null（不抛）、toUTCString 交那句话、toISOString 是能 catch 的 RangeError
const bad = new Date(NaN);
console.log(bad.getTime(), bad.toJSON(), bad.toUTCString());
console.log(bad.getUTCMonth(), bad.setUTCMonth(3));
try { bad.toISOString(); } catch (e) { console.log(e.constructor === RangeError, e.message); }
// setFullYear 是那一族里唯一能把无效日期救回来的（规范把 t 当 +0）
const rev = new Date(NaN);
console.log(rev.setUTCFullYear(2000), rev.toISOString());

// TimeClip：±8.64e15 之外是 NaN，不是"很大的数"
console.log(new Date(8.64e15).getTime(), new Date(8.64e15 + 1).getTime());

// 负年份（扩展年那一段）
const neg = new Date(Date.UTC(-1, 0, 1));
console.log(neg.toISOString(), neg.toUTCString(), neg.toDateString());
