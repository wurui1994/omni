// 数组身上读一格**不是下标**的键：规范的答案是 undefined（负数、小数与非数字的键都
// 走属性那一支，见 omni_js_str_arr.h 的 CanonicalNumericIndexString 那段注）。
//
// C 那条腿上这条从前是**当场报错**：`omni_js_pm_init_()` 那句登记一次也没发出来
// （main 里判的 protoMemberN 在攒 main 那一刻必然是 0，表是留坑回填的），
// 于是 `omni_js_pm_find_g` 永远是 NULL，一路掉到 "还没搬到 C 那条腿" 那句 errorf。
// 量出来的：`npm run fix:self` 停在 `reading '-1' off Array.prototype`。
//
// （`a.map` 当**值**读出来在 C 这一档还是 undefined 而 node 给函数 —— 那是另一处
// 已知缺口，与 43-unknown-member-read 上记的同一格，这儿不量。）
const a = [1, 2];
const i = -1;
console.log(String(a[i]));
console.log(String(a[-1]));
console.log(String(a[a.length - 3]));
console.log(String(a["foo"]));
console.log(String(a[1.5]));
console.log(String(a[9]));
a[-1] = 7;
console.log(String(a.length), String(a[-1]), a.join(","));
console.log(typeof a.zork);
console.log("end");
