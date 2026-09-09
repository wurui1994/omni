/* String 上收第二个位置实参的那几格：endsWith 的**终点**（从前整格丢掉 —— silent 的
   错答案）、includes 的起点（同样丢掉了）、startsWith 的起点（本来就有）。
   split 的分隔符不给时整串是一格（从前是"undefined is not a string"当场报）。 */
console.log("abc".endsWith("b", 2), "abc".endsWith("c"), "abc".endsWith("b"), "abc".endsWith("", 0));
console.log("abc".endsWith("abc", 3), "abc".endsWith("a", 1), "abc".endsWith("a", 0), "abc".endsWith("c", 99));
console.log("abcabc".includes("b", 2), "abcabc".includes("b", 5), "abc".includes("a", 0), "abc".includes("a", 1));
console.log("abc".startsWith("b", 1), "abc".startsWith("a"), "abc".startsWith("a", 1));
console.log(JSON.stringify("abc".split()), JSON.stringify("abc".split(undefined)));
console.log(JSON.stringify("a-b-c".split("-", 2)), JSON.stringify("abc".split("")), JSON.stringify("".split("-")));
/* 下标那一族的实参照规范走 ToIntegerOrInfinity（7.1.5）：先 ToNumber，NaN 当 0，其余截尾。
   所以串 / 布尔 / null 都收得下 —— 从前非数当场报 "string index must be a number" 与
   "fromIndex expects a number"（量出来的）。 */
console.log("abcd".indexOf("c", "1"), "abcd".indexOf("c", true), "abcd".indexOf("c", null), "abcd".indexOf("c", NaN));
console.log("abcd".slice("1", "3"), "abcd".slice(1.9), "abcd".at("2"), "abcd".at(1.7), "abcd".charAt("1"));
console.log([1, 2, 3].indexOf(2, "1"), [1, 2, 3].indexOf(2, 1.9), [1, 2, 3].indexOf(2, null), [1, 2, 3].includes(3, "2"));
console.log([1, 2, 3].slice("1").join(","), [1, 2, 3].at("2"), [1, 2, 3, 4].fill(0, "2").join(","));
console.log("a-b-c".split("-", "2").length, "abc".repeat("2"), "5".padStart("3", "0"));
// 空表 + 没给初值的 reduce 是**能 catch** 的 TypeError（规范 23.1.3.24 第 3 步 / .25）
try { [].reduce((s, x) => s + x); } catch (e) { console.log("reduce", e.name, e instanceof TypeError); }
try { [].reduceRight((s, x) => s + x); } catch (e) { console.log("reduce", e.name, e instanceof TypeError); }
console.log([].reduce((s, x) => s + x, 7), [1].reduce((s, x) => s + x), "after");
