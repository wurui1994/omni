// 正则对象的 lastIndex（ADR-0020 P4）。它本来就在两侧的三元组里（src/flags/li），
// 这一刀只是让它能读能写：读走成员表（js_re_last_index），写走 idx_set 上 regexp 那一格。
//
// 一句只做一件事：会抛的调用会被提到语句前面做 pending 检查（ADR-0007），
// 把 exec 和读 lastIndex 写在同一句里，次序就不是从左往右了。
const r = /a(b)?/g;
console.log(`li ${r.lastIndex}`);
let m = r.exec("xaby");
console.log(`li ${JSON.stringify(m)} ${r.lastIndex}`);
m = r.exec("xaby");
console.log(`li ${JSON.stringify(m)} ${r.lastIndex}`);

// 写回去：下一次 exec 从这儿起
r.lastIndex = 1;
console.log(`li ${r.lastIndex}`);
m = r.exec("abab");
console.log(`li ${JSON.stringify(m)} ${r.lastIndex}`);

// 不带 g 的一律从 0 起，也不动 lastIndex
const n = /a/;
console.log(`li ${n.lastIndex}`);
m = n.exec("xa");
console.log(`li ${JSON.stringify(m)} ${n.lastIndex}`);

// .source 是 escape 过的那一格（规范 22.2.6.13.1）：裸 / 写成 \/，空模式写成 (?:)，
// 已经escape过的不再escape一遍，字符组里的 / 不动。塞回 new RegExp 还是同一个正则。
console.log(`src ${new RegExp("a/b").source} ${new RegExp("a\\/b").source} ${new RegExp("[/]").source}`);
console.log(`src ${JSON.stringify(new RegExp("").source)} ${JSON.stringify(new RegExp("a\nb").source)}`);
console.log(`src ${new RegExp("a/b").test("a/b")} ${new RegExp(new RegExp("a/b").source).test("a/b")}`);
// new RegExp(re)：照抄源与旗标；模式缺席是空模式，不是 "undefined"
const cp = new RegExp(/a\/b/i);
console.log(`cp ${cp.source} ${cp.flags} ${cp.test("XA/B")} ${new RegExp(/a/g, "").flags === ""}`);
console.log(`cp ${new RegExp().source} ${new RegExp(undefined).source} ${new RegExp(null).source}`);
