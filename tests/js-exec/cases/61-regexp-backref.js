// 反向引用 `\1`..`\9`
//
// 逼出这一格的是 `ext/python/adapter/expr.js:141` 那条 —— python 的字符串字面量就是这么拆的：
//   /^([A-Za-z]{0,2})('''|"""|'|")([\s\S]*)\2$/
// 「收尾的引号必须与开头那一格**一样**」只有反向引用说得出来。C 侧那份手写回溯匹配器从前
// 直接拒（`backreference is not supported`），于是 `./dist/omni run x.py` 一开机就炸 ——
// 而 node 腿一直好好的（宿主 RegExp）。
//
// 实现是回溯匹配器里最自然的一格：取那一组捕获到的**文本**再匹配一遍（`RE_BREF`）。
// 两条边界照 JS 走：没捕获到的组匹配**空串**（不是失败）；比较过 `i` 的折叠。
//
// 判分人是 node 自己；这条轴跑 node == omni-js == omni-c 三条腿。
//
// 刻意**不放进来**的一格：`\9` 那种指到不存在的组。JS 无 `u` flag 时按 Annex B 把它当
// 八进制转义或字面量，而我们当场报错（`refers to a capture group that does not exist`）——
// 两边本来就不一样，放进对照用例只会把"我们拒得响"读成"我们错了"。

const PY_STR = /^([A-Za-z]{0,2})('''|"""|'|")([\s\S]*)\2$/;
const srcs = ["'a'", '"a"', "'''a'''", '"""a"""', "r'a'", "rb'''x'''", "'a\"", "'''a'", 'f"{x}"'];
const out = [];
for (let i = 0; i < srcs.length; i++) {
  const m = PY_STR.exec(srcs[i]);
  out.push(m === null ? '-' : m[1] + '|' + m[2] + '|' + m[3]);
}
console.log(out.join(' '));

// 基本形状
console.log(String(/(a)\1/.test('aa')) + ' ' + String(/(a)\1/.test('ab')));
console.log(String(/(ab)\1+/.exec('ababab')[0]));
console.log(String(/(\w+)\s+\1/.exec('hello hello world')[0]));

// 没捕获到的组：`\1` 匹配空串
console.log(String(/^(?:(a))?\1b$/.test('b')) + ' ' + String(/^(?:(a))?\1b$/.test('aab')));

// `i` flag：反向引用也按折叠比
console.log(String(/(a)\1/i.test('aA')) + ' ' + String(/(a)\1/.test('aA')));

// 嵌套组与组号
const n = /((x)(y))\3\2/.exec('xyyx');
console.log(n === null ? 'nest:-' : 'nest:' + n[0] + ',' + n[1] + ',' + n[2] + ',' + n[3]);

// `g` + 反向引用：叠字压掉
console.log('aabbccdd'.replace(/(.)\1/g, '$1'));
console.log('one one two two'.replace(/(\w+) \1/g, '[$1]'));
