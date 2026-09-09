const re = /(\w)(\d)/g;
const m = /(\w)(\d)/.exec("ab a1 b2");
console.log(m[0], m[1], m.index, m.input.length, String(m.groups));
console.log("a1 b2".match(/\w\d/g).join("|"));
const all = [..."a1 b2".matchAll(re)];
console.log(all.length, all[0][0], all[0].index, all[1][1]);
console.log(re.flags, re.global, re.source, re.lastIndex);
const nre = /(?<L>\w)(?<D>\d)/;
const nm = nre.exec("x9");
console.log(nm.groups.L, nm.groups.D);
console.log("a1b2".replace(/(\w)(\d)/g, "$2$1"));
for (const mm of "p1 q2".matchAll(/(\w)(\d)/g)) console.log(mm[0], mm[1], mm[2], mm.index);
console.log([..."aaa".matchAll(/a*/g)].map((x) => `[${x[0]}]@${x.index}`).join(","));
try { "x".matchAll(/x/); } catch (e) { console.log(e.name, e.message); }
console.log([..."no".matchAll(/z/g)].length);
