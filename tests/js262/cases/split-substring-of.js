// split 的 limit、substring、Array.of。
// **split 的 limit 从前被丢掉了** —— "a-b-c".split("-", 2) 给出三段，是个 silent 的错
// 答案（不是报错），这一条用例存在的首要理由就是把它钉住。
console.log("a-b-c".split("-", 2).join("|"), "a-b-c".split("-", 0).length, "abc".split("", 2).join("|"));
console.log("a-b-c".split("-").join("|"), "a-b-c".split("-", -1).join("|"));
// substring 两头都夹到 [0, len]、start > end 换过来，且**不认负下标**（slice 那一格认）
console.log("abc".substring(1, 2), "abc".substring(2, 1), "abc".substring(1), "abc".substring(-5, 99));
console.log("abc".slice(-2), "abc".substring(-2));
// Array.of 收可变实参 —— 就是一格数组字面量
console.log(Array.of(1, 2).join(","), Array.of().length, Array.of(...[3, 4]).join(","));
