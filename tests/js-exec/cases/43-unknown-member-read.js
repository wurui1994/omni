// 读一格**不认识**的成员不能污染挂起槽（ADR-0007）。C 那条腿上 Uint8Array / DataView /
// TextEncoder 在 realm 上还没有原型，从前 proto_of_tag_ 给的是 null，于是 `typeof b.nope`
// 一边照样印 undefined、一边把 "cannot read property 'nope' of null" 留在槽里 ——
// **下一句**才炸，错记在别人头上。现在兜底是 Object.prototype：读不认识的成员就是 undefined。
// （`b.at` / `b.indexOf` 当**值**读出来在这一档还是 undefined，而 node / qjs 给函数 ——
// 那是另一处已知缺口，记在 ADR 里，这儿不量。）
const b = new Uint8Array(2);
console.log(typeof b.nope);
console.log("still here", b.length, b.byteLength);
b[0] = 7;
console.log(b.at(0), b.join("-"));
const te = new TextEncoder();
console.log(typeof te.nope, te.encode("ab").length);
console.log(typeof (1).nope, typeof (1.5).nope, typeof true.nope, typeof "s".nope);
console.log("end");
