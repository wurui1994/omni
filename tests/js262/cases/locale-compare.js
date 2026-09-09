/* localeCompare（规范 22.1.3.12 的口径是"实现定义但一致"）。没有 ICU，所以照 qjs 那份：
   按**码元**比，第一处不同给 a - b 的差，一个是另一个的前缀就给长度差。
   从前这一格根本不在成员表里，`"a".localeCompare("b")` 撞在 "undefined is not a function" 上。
   node 带 ICU，所以只有**符号**在两把尺子上一致（非 ASCII 的次序更是不一样）—— 这一格
   因此只放在 js262 里（尺子是 qjs），五腿用例里不量。 */
const xs = ["b", "a", "B", "A", "é", "e", "z", "Z", "ß", "s", "日", "中"];
console.log(xs.slice().sort((a, b) => a.localeCompare(b)).join(","));
// 与默认的 sort（按 < 比串）在这一格上给同一串
console.log(xs.slice().sort().join(","));

console.log("a".localeCompare("b"), "b".localeCompare("a"), "a".localeCompare("a"));
// 差值就是码元差：0xE9 - 0x65 = 132、0xDF - 0x73 = 108
console.log("é".localeCompare("e"), "ß".localeCompare("s"), "".localeCompare("a"));
// 前缀那一档给长度差
console.log("ab".localeCompare("abc"), "abc".localeCompare("ab"), "abc".localeCompare("abc"));
// 实参先 ToString
console.log("1".localeCompare(1), "12".localeCompare(2) < 0, "a".localeCompare(undefined) < 0);
// 代理对按码元比（不是按码点）
console.log("😀".localeCompare("\uFFFF") < 0, "😀".length);
