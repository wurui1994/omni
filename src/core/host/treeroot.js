/**
 * `src/core/host/treeroot.js` —— **"这棵树的根在哪儿"只有一份**。
 *
 * 为什么要单开一份文件：这一句话从前长在 `lower/langs.js` 上（语言登记处），
 * 于是任何想知道树根的人都得 import 那一份 —— 而 `langs.js` 自己要 import 各门语言的
 * adapter，**环就这么合上了**（`ext/r/rt/ffi.js` 与 `ext/r/libr-run.js` 撞的正是这一格：
 * `tests/mir/run.js` 的 `lower/cli.js` 那道门不收 import 环）。
 *
 * 树根这件事与语言无关，它只问宿主两句话（`installDir` 与 `exists`），所以它该在
 * `host/` 这一层。`langs.js` 现在从这儿再导出一次，老的 import 路径照旧能用。
 *
 * **按布局认，不数层数**（2026-09-22 改的一个真错，与 `host/cache.js` 的 `treeRoot()`
 * 同一条规矩）：从前是"往上 pop 三格"（照 `src/core/host` 数出来的），于是
 *   node src/cli.js  installDir = <repo>/src/core/host -> <repo>          ✓
 *   dist/omni        installDir = <repo>/dist          -> <repo> 的上一级 ✗
 * 症状是原生那一代 `./dist/omni build x.go` 报
 * `ENOENT: …/Train/ext/go/go.grammar`（少了 `Omni/` 那一节）。往上找标志文件两种布局都
 * 停在 `<repo>` 上，于是**在仓库里跑的那份 dist 产物也认得语法文件**。
 *
 * 找不着标志文件（真装到 `/usr/local/bin` 的样子）就退回老办法 —— 那一档的语法文件该由
 * "产物怎么装"那一格摆进 `share/`（与 runtime/ 和 lib/ 一样，见 `host/data.js`），
 * 不是这儿的事。
 */
import { installDir, exists } from './native.js';

export function treeRoot() {
  let d = installDir();
  for (let i = 0; i < 8; i++) {
    if (exists(`${d}/package.json`) || exists(`${d}/.git`)) return d;
    const parts = d.split('/');
    if (parts.length <= 1) break;
    parts.pop();
    const up = parts.join('/');
    if (up === d || up === '') break;
    d = up;
  }
  const parts = installDir().split('/');
  parts.pop();            // host
  parts.pop();            // core
  parts.pop();            // src
  return parts.join('/');
}
