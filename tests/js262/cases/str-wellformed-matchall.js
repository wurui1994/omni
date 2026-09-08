// isWellFormed / toWellFormed（ES2024）与 matchAll（ES2020）。
// 落单的代理项（没配对的 D800..DFFF）算"不良"，toWellFormed 把每个落单的替成 U+FFFD。
// matchAll 交出来的是**数组**而不是迭代器对象 —— 展开、for-of、Array.from 都成，
// next() 那一面不在这个值域里（画出来的边界，写在 ADR-0020 里）。
console.log("ab".isWellFormed(), "\ud800".isWellFormed(), "\ud800\udc00".isWellFormed());
console.log("a\udfffb".isWellFormed(), "".isWellFormed());
const fixed = "\ud800x".toWellFormed();
console.log(fixed.length, fixed.charCodeAt(0) === 0xfffd, "ab".toWellFormed());
console.log("\ud800\udc00".toWellFormed().length, "a\udfffb".toWellFormed().charCodeAt(1) === 0xfffd);
// 每一趟的结果与 exec 同形：整体匹配在 0、捕获组依次在后，外加 index / input / groups
const out = [...("1a 2b".matchAll(/(\d)(\w)/g))].map((m) => `${m[0]}|${m[1]}${m[2]}|${m.index}`);
console.log(out.join(" "));
console.log([..."abc".matchAll(/./g)].length, [..."".matchAll(/x/g)].length);
const named = [..."k=v".matchAll(/(?<key>\w)=(?<val>\w)/g)];
console.log(named[0].groups.key, named[0].groups.val, named[0].input);
// 空匹配往前挪一格，不然在原地打转
console.log([..."ab".matchAll(/(?:)/g)].length);
