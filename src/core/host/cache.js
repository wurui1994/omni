// Omni — 一切中间文件与缓存的根
//
// 为什么单独一个模块：`cli.js` 与 `glr/load.js` 都要它，而 JS 那条链接模型是
// **整棵 import 树摊成一个 Program、模块作用域的名字全程序唯一**（ADR-0016）——
// 两处各写一个 `cacheRoot()` 就会被链接器骂 `declared at module scope in both …`。
// 量到过：`glr/load.js` 刚拆出来时就是这么红的（mir/incr/bootstrap 三条轴一起红）。

import { env, installDir, exists, cwd } from './native.js';
import { join, dirname } from './path.js';

/**
 * 这棵树的根 —— **靠标志文件往上找**，不是数几层 `..`。
 *
 * 从前是 `join(installDir(), '..', '..', '..')`，那个 3 是照**源码布局**
 * （`src/core/host`）数出来的，别的布局全落到别处去。量出来的三种结果（同一台机器）：
 *   node src/cli.js  -> installDir = <repo>/src/core/host -> <repo>/.omni-cache
 *   dist/omni        -> installDir = <repo>/dist          -> /Users/wurui/.omni-cache
 *   /tmp/o2/omni     -> installDir = /tmp/o2              -> /.omni-cache（硬错，只读）
 * 后果是**两条腿从来不共享暖存**：`npm run build:native` 编好的那 21 个运行时 `.o`
 * 就在 `<repo>/.omni-cache/rt` 里，而 `dist/omni run` 去 `/Users/wurui/.omni-cache`
 * 找，找不到，于是每一趟都自己重编一遍（那一段还不印任何东西，见 runtimeObjectsSelf）。
 *
 * 往上找 `package.json` / `.git`：两种布局都会停在同一格 `<repo>`。找不着（真正装好的
 * 样子，`/usr/local/bin/omni`）就落到**当前目录**下的 `.omni-cache` ——
 * `$HOME` 这条路不走：那是用户的家，编译器不该往里写东西，而且它一变（CI、sudo、
 * 换用户）暖存就跟着搬家，撞不撞全靠运气。与 data.js 的 `dataRoots()` 同一条规矩：
 * 按布局认，不按层数数。
 */
function treeRoot() {
  let d = installDir();
  for (let i = 0; i < 8; i++) {
    if (exists(join(d, 'package.json')) || exists(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

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
  const root = treeRoot();
  return join(root === null ? cwd() : root, '.omni-cache');
}
