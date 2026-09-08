// 松散比较与 toString 那几格（都是**静默分叉**）：数组 == 原始值要先 ToPrimitive、
// Array.prototype.toString 就是 join(",")、混着比要两边 ToNumber（后者在
// tests/js-exec/cases/01-expr.js 里五条腿一起量）。
console.log([] == false, [1] == 1, [1, 2] == "1,2", [0] == false, [null] == 0);
console.log({} == "[object Object]", "" == 0, "0" == false, [[]] == 0, [""] == 0);
console.log([] === false, [1] === 1, null == undefined, null === undefined, NaN == NaN);
console.log([1] != 1, [] != false, [2] == 1, [1, 2] == "1, 2");
// toString：数组是 join(",")，嵌套的数组接着摊
console.log([1, 2, 3].toString(), [1, [2, [3]]].toString(), [].toString() + "|");
console.log([null, undefined, 1].toString(), String([1, 2]), `${[1, 2]}`);
console.log([1, 2].join("-"), [1, 2].toString() === [1, 2].join(","));
// 关系比较（与 01-expr 那份对着看，这儿多量几格）
console.log("2" > 1, [2] > 1, [2] > [1], null >= 0, undefined > 0, "abc" < 1);
console.log(new Date === undefined ? "x" : "ok");
