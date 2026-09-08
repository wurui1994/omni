/* String 上收第二个位置实参的那几格：endsWith 的**终点**（从前整格丢掉 —— silent 的
   错答案）、includes 的起点（同样丢掉了）、startsWith 的起点（本来就有）。
   split 的分隔符不给时整串是一格（从前是"undefined is not a string"当场报）。 */
console.log("abc".endsWith("b", 2), "abc".endsWith("c"), "abc".endsWith("b"), "abc".endsWith("", 0));
console.log("abc".endsWith("abc", 3), "abc".endsWith("a", 1), "abc".endsWith("a", 0), "abc".endsWith("c", 99));
console.log("abcabc".includes("b", 2), "abcabc".includes("b", 5), "abc".includes("a", 0), "abc".includes("a", 1));
console.log("abc".startsWith("b", 1), "abc".startsWith("a"), "abc".startsWith("a", 1));
console.log(JSON.stringify("abc".split()), JSON.stringify("abc".split(undefined)));
console.log(JSON.stringify("a-b-c".split("-", 2)), JSON.stringify("abc".split("")), JSON.stringify("".split("-")));
