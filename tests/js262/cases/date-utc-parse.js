/* Date 里**只算数**的那两格：Date.UTC 与 Date.parse（ADR-0020 P1-c）。它们交出来的是一个
   毫秒数，与真对象无关，所以四条腿都成立 —— 而 new Date(…) 造的是真对象、
   new Date(y, mo, d) 还要本地时区，那两格照旧拒。
   这条用例把边角都摊开：月份溢出、0..99 的年份映到 19xx、扩展年（±YYYYYY）、
   负的毫秒、时区偏移、闰年 2 月 29、以及 NaN 那几格。 */
console.log(Date.UTC(2020, 0, 2), Date.UTC(1970, 0, 1), Date.UTC(2000, 1, 29));
console.log(Date.UTC(2020), Date.UTC(2020, 12), Date.UTC(2020, -1));
console.log(Date.UTC(99, 0, 1), Date.UTC(1899, 11, 31));
console.log(Date.UTC(2020, 0, 2, 3, 4, 5, 6));
console.log(String(Date.UTC()), String(Date.UTC(NaN)), String(Date.UTC(Infinity)));
console.log(Date.parse("2020-01-02T00:00:00.000Z"), Date.parse("2020-01-02T00:00:00Z"));
console.log(Date.parse("2020-01-02"), Date.parse("2020-01"), Date.parse("2020"));
console.log(Date.parse("2020-01-02T03:04:05.678Z"));
console.log(Date.parse("2020-01-02T00:00:00+02:00"), Date.parse("2020-01-02T00:00:00-05:30"));
console.log(Date.parse("1969-12-31T23:59:59.999Z"), Date.parse("+020200-01-01T00:00:00Z"));
