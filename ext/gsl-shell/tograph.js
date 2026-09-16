// ext/gsl-shell/tograph.js —— gsl-shell 的树 -> 图。**它就是 lua 那份，一个字不改。**
//
// 这不是偷懒，是那份语法的**设计后果**：`ext/gsl-shell/gsl-shell.grammar` 里那两条
// 短 lambda 产生式刻意出的是与 `function` 逐格相同的树（`(fn (body (params …) (block …)))`），
// 所以"多出来的写法"在映射这一层根本不存在 —— 这正是"写法归语言、格子归节点"那条纪律
// 在方言这一层的样子：**新写法不带来新节点，也不带来新映射**。
//
// 单独留这一份文件（而不是让 langs.js 直接指向 lua 的映射）有一条理由：
// **方言迟早会有自己要处理的东西**（gsl-shell 的 `|>`、矩阵字面量那一族），
// 那时候这儿就是它的落脚点；现在它是一行转手，将来它长出来也不必动别处。
// 名字换过来是为了报错里认得出是谁在映射。**先导入、再导出**（而不是 `export … from …`）：
// 我们自己那个 JS 前端不收后者 —— 整棵 import 树是拼成**一个**程序的，转口那一步得落成
// 一句真的模块级绑定（`frontend-js/link.js` 里那句 "import it and export it again"）。
// 这条不是风格：`tests/mir/run.js` 那格"编译器自己也要降得下来"会当场红。
import { luaToGraph } from '../lua/tograph.js';

export { luaToGraph as gslShellToGraph };
