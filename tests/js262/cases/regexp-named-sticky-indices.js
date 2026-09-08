// 正则那一片量出来的四格：$<name> 的替换、sticky（y）的 lastIndex、d 旗标的 indices、
// RegExp.prototype.toString。前两格是**静默分叉**（换不出来 / lastIndex 一直是 0）。
const named = /(?<y>\d{4})-(?<m>\d{2})/;
console.log("2026-09".replace(named, "$<m>/$<y>"), "2026-09".replace(named, "[$<y>]"));
// 没有具名组时 $< 是普通字符（规范 22.1.3.19 表 22）；名字不存在时替空串
console.log("ab".replace(/a/, "$<x>"), "2026-09".replace(named, "$<zz>|"));
console.log("10-20".replace(/(\d+)-(\d+)/, "$2/$1"), "a".replace(/a/, "$$"), "x".replace(/x/, "[$&]"));
// sticky：与 g 一样吃 lastIndex，但要求**恰好**从那儿起匹配
const sticky = /ab/y;
console.log(sticky.test("abab"), sticky.lastIndex, sticky.test("abab"), sticky.lastIndex, sticky.test("abab"), sticky.lastIndex);
const s2 = /b/y;
console.log(s2.test("ab"), s2.lastIndex);
const se = /a/y;
console.log(JSON.stringify(se.exec("aa")), se.lastIndex, JSON.stringify(se.exec("aa")), se.lastIndex);
// 字面量当场用：每次都是新对象，lastIndex 从 0 起
console.log(/ab/y.test("abab"), /ab/y.test("abab"));
// d 旗标（hasIndices）：每格是 [起, 止]，没参与的组是 undefined
const dre = /(\d)(\w)/d;
const dm = dre.exec("1a");
console.log(JSON.stringify(dm.indices), dm.indices.length, dm.indices[0][0], dm.indices[2][1]);
const dn = /(?<a>x)(y)?/d.exec("x");
console.log(JSON.stringify(dn.indices), JSON.stringify(dn.indices.groups), String(dn.indices[2]));
console.log(dre.flags, /x/gi.flags, /x/.flags + "|");
// RegExp.prototype.toString：/源/旗标（借方法与 String(re) 都落到它）
console.log(RegExp.prototype.toString.call(/x/g), String(/a.b/im), `${/q/}`);
