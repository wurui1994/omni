// Omni — 一切中间文件与缓存的根
//
// 为什么单独一个模块：`cli.js` 与 `glr/load.js` 都要它，而 JS 那条链接模型是
// **整棵 import 树摊成一个 Program、模块作用域的名字全程序唯一**（ADR-0016）——
// 两处各写一个 `cacheRoot()` 就会被链接器骂 `declared at module scope in both …`。
// 量到过：`glr/load.js` 刚拆出来时就是这么红的（mir/incr/bootstrap 三条轴一起红）。

import { env, installDir } from './native.js';
import { join } from './path.js';

/**
 * 根是**仓库里的 `.omni-cache`**，不再用系统临时目录（第一百〇五刀）。
 *
 * 为什么不用 `/tmp` / `/var/folders`：
 *   - 系统会清它。EPS 参考那 192 份就是这么丢的（一趟 5 分钟的真 asy 重跑），
 *     而 glr 表、运行时 `.o`、链好的可执行文件都是「重算很贵、内容只由输入决定」的东西。
 *   - 看不见。`omni-l2pb0k/a.out.c` 这种名字在 `/var/folders/x6/dw0k…` 底下，
 *     出了问题连「上一趟到底编了什么」都翻不出来。
 *   - 一台机器上两个 checkout 的印记里带的是路径与 mtime，撞不撞全靠运气。
 *
 * `OMNI_CACHE_DIR` 可以把整棵搬走（CI 上想放到 workspace 之外时用）。
 */
export function cacheRoot() {
  const e = env('OMNI_CACHE_DIR');
  if (e !== undefined && e !== '') return e;
  return join(installDir(), '..', '..', '..', '.omni-cache');
}
