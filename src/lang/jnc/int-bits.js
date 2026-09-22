// src/lang/jnc/int-bits.js —— 整数那一族的**底宽**表（就这一张表，别的什么都不放）
//
// 为什么单开一份文件：这张表有两个用户（`resolve-type.js` 与 `const-eval.js`），而那两份
// **本来就互相 import**（resolve-type 要算常量、const-eval 要查位宽）。原来的写法是
// const-eval 从 resolve-type 里拿它，并在注释里说"环是安全的，只在调用时才用到"——
// 那句话对 node 成立，对**我们自己那个 JS 前端不成立**：它把整棵 import 树拼成一个程序，
// 成环就报错（`frontend-js/link.js`）。于是 `tests/mir/run.js` 那格"编译器自己也要降得
// 下来"上一直有一条 `import cycle through 'resolve-type.js'`。
//
// 抄两份表是错的（一处家那条纪律），所以把家搬到这儿：**叶子模块，谁都能进，不成环**。
//
// 出处：jancy 的 `setupStdTypedef`（`jnc_ct_TypeMgr.cpp:1759-1782`）与那几个关键字的 TypeKind。
// 方言里它们一律是 `int`，宽度只在两处要用：位域怎么挤成一格（见 `emit-agg.js` 那条规则）、
// 以后的截断规则。
// **家搬到公共那一层了**（`src/core/lower/cfam.js` 的 `C_INT_BITS`）：C++ 那侧有一张
// 一模一样的表，抄两份就是两处会分叉的账。这儿留一格转口（**一格一格写，不许 `export *`**
// —— 我们自己那个 JS 前端不收星号，见 int-table.js 头上那段）。
import { C_INT_BITS } from '../../core/lower/cfam.js';

export const INT_BITS = C_INT_BITS;
