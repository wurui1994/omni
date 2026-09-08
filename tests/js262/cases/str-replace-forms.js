// 串模式的 replace（只换第一处）与正则的 replaceAll。
// 替换可以是函数（收 (match, offset, string)）或带 $ 的串（串模式没有编号组，
// 所以只有 $$ / $& / 前后文那两个）。正则那一支由降级器发成 js_re_replace。
console.log("abc".replace("b", "X"), "abc".replace("z", "X"), "aab".replace("a", "-"));
console.log("abc".replace("b", (m) => m.toUpperCase()), "abc".replace("b", (m, i, s) => `${m}${i}${s}`));
console.log("abc".replace("b", "[$&]"), "abc".replace("b", "$$"), "abc".replace("", "-"));
console.log("aXbXc".replaceAll(/X/g, "-"), "a1b2".replace(/\d/g, (m, i) => `${m}@${i}`));
console.log("abc".replace(/(a)(b)/, "$2$1"), "a-b".replaceAll("-", "+"));
// 不带 g 的正则交给 replaceAll 在规范里是 TypeError；这儿是编译期报错，所以不在这条里量
console.log("aaa".replace("a", "b"), "aaa".replaceAll("a", "b"));
