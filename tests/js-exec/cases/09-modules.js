// 模块（ADR-0011 落地第 6e 步）：import/export 在降级之前就被链接器解决掉
import { VERSION, twice, banner, Counter, table, TAG, add } from './09-modules/util.js';
import { ORDER, repeatStr as rep } from './09-modules/text.js';
import * as T from './09-modules/text.js';
import greet, { sideBySide } from './09-modules/dflt.js';

console.log(VERSION);
console.log(String(twice(21)));
console.log(banner("omni"));

const c = new Counter(10);
console.log(String(c.bump()));
console.log(String(c.bump()));

console.log(String(table.get("a") + table.get("b")));
console.log(table.size === 2 ? "two" : "?");

// 别名导入
console.log(rep("ab", 3));

// 依赖的模块级语句在导入方之前跑完了
ORDER.push("main");
console.log(ORDER.join(">"));

// 导入来的函数当值用
console.log([1, 2, 3].map(twice).join(","));

// 改名的导出：引用方按**导出名**写
console.log(TAG, String(add(2, 3)));

// 默认导出 / 默认导入
console.log(greet("omni"), String(sideBySide));

/* 命名空间导入：一格对象，每个导出名一格 —— 而且是**活绑定**，note() 之后再看还得跟着变。 */
console.log(T.CHARS, T.repeatStr("x", 2), typeof T.note);
console.log(String(T.seen), String(T.note()), String(T.seen));
