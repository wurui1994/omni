// 字符类里的**否定类转义**（`[\D]` / `[\S]` / `[\W]`，以及 `[\s\S]` 那个惯用写法）
//
// 为什么单开一格：C 侧那份手写回溯匹配器把字符类表示成"一串范围 + 一个取反位"，
// 而 `[\D]` 要的是"数字集合的补**参与并集**" —— 一个取反位表达不出来，从前直接拒
// （`negated class escape (\D \S \W) inside [...] is not supported`）。
// 于是 `./dist/omni run x.py` 一开机就炸在 `frontend-glsl/pp.js` 那条
// `/^#\s*define\s+([A-Za-z_]\w*)([\s\S]*)$/` 上，而 node 腿一直好好的（宿主 RegExp）。
// 现在 C 侧把那几格范围**在码元空间上取补**（`re_neg_ranges`）—— 码元是 uint16，
// 补集本身就是一串范围，所以答案是精确的。
//
// 判分人是 node 自己；这条轴平时跑 node == omni-js == omni-c 三条，第三条就是要压住的那一条。

const pats = [
  /[\s\S]+/,        // "任何字符"的惯用写法（树里真正在用的那个形状）
  /[\d\D]+/,
  /[\w\W]+/,
  /^[\D]+$/,
  /^[^\D]+$/,       // 非(非数字) = 数字 —— 取补之后外层 negate 还要再取反一次
  /^[a\S]+$/,       // 补集与字面量并存
  /^[\W]+$/,
  /^[\S]+$/,
  /^[0-9\D]+$/,     // 并集正好是全集
  /^[\s]+$/,        // 不取补那一支照旧
];
const subs = ['abc', '123', 'a1b2', ' \t\n', '', 'x y', '!@#', 'A_z', '\u00a0', 'ÿÿ'];
const out = [];
for (let i = 0; i < pats.length; i++) {
  for (let j = 0; j < subs.length; j++) {
    const m = pats[i].exec(subs[j]);
    out.push(String(i) + ',' + String(j) + '=' + (m === null ? '-' : String(m[0].length)));
  }
}
console.log(out.join(' '));

// `i` flag 与取补一起：折叠只在 ASCII 字母之间移动，而 `\W` 一个字母都不含 —— 答案不该变
console.log(/^[\W]+$/i.test('!!') ? 'ci:yes' : 'ci:no');
console.log(/^[\W]+$/i.test('aA') ? 'ci2:yes' : 'ci2:no');

// `g` + 取补：替换要走遍每一格
console.log('a1b2c3'.replace(/[\D]/g, '.'));
console.log('a1b2c3'.replace(/[\S]/g, '-'));
console.log('one two\tthree'.split(/[\S]+/).length === 4 ? 'split:4' : 'split:?');
