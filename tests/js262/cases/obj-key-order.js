// 自有键的次序（规范 OrdinaryOwnPropertyKeys）：下标键按数值升序，然后字符串按插入序
const o = { b: 1, 2: 2, a: 3, 10: 4, 1: 5 };
o.c = 6;
o[0] = 7;
console.log(Object.keys(o).join(","));
console.log(JSON.stringify(o));
const vals = [];
for (const k in o) vals.push(k + "=" + o[k]);
console.log(vals.join(" "));
