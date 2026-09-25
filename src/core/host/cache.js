// Omni — 一切中间文件与缓存的根
//
// 为什么单独一个模块：`cli.js` 与 `glr/load.js` 都要它，而 JS 那条链接模型是
// **整棵 import 树摊成一个 Program、模块作用域的名字全程序唯一**（ADR-0016）——
// 两处各写一个 `cacheRoot()` 就会被链接器骂 `declared at module scope in both …`。
// 量到过：`glr/load.js` 刚拆出来时就是这么红的（mir/incr/bootstrap 三条轴一起红）。

import { env, installDir, exists, cwd, readDir, isDir, mkdirAll, spawn, fileSize, mtimeMs } from './native.js';
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

/* ------------------------------------------------------------------ 暂存与回收
 *
 * **缓存与暂存是两件事**，从前混在一格 `work/` 里，于是攒了 657 个目录 518 MB：
 *
 *   缓存（`rt/`、`glr/`、`incr/`…）  键是内容，命中就省一趟，**留着有用**
 *   暂存（编到一半的 `.o`、并行跑的 rc 文件、链接前的 `.c`）  **用完就该没了**
 *
 * 从前那些 `work/c-75d7a083…` 是后者：键是**路径的哈希**（一对一、没有去重收益），
 * 或者干脆是**时间戳的哈希**（必然每趟新建、必然永不命中）。两种都只是把可读的名字
 * 换成不可读的十六进制，然后堆着。这一组函数把那条路改掉。
 */

/**
 * 一格**一次性**的暂存目录：`work/<kind>[-<序号>]`，**建之前先清空**、用完 `dropScratch`。
 *
 * 名字里既没有时间戳也没有进程号：有时间戳就每趟多一个目录（那正是要修的毛病），
 * 而并发那一格由**各自的缓存根**分开（`OMNI_CACHE_DIR`；测试的每条轴就是这么摆的）。
 * 同一个根上并发跑同一种活会撞 —— 与 `workDirFor` 那句"确定的名字"同一条已知代价。
 */
let scratchSeq = 0;
export function scratchDir(kind) {
  scratchSeq = scratchSeq + 1;
  const name = scratchSeq === 1 ? kind : `${kind}-${scratchSeq}`;
  const dir = join(cacheRoot(), 'work', name);
  rmTree(dir);
  mkdirAll(dir);
  return dir;
}

/**
 * 整棵删掉。走 `spawn('rm', ['-rf', …])` 而不是新开一格宿主原语：**封闭 ABI 上多一个口子
 * 要在每条腿上各实现一遍**（ADR-0011 决策 2），而这件事 `rm` 已经会做，`spawn` 也已经在
 * ABI 里（`-t clean` 那一处同一条路）。代价写在明处：win32 上要另一条实现。
 */
function rmTree(p) {
  if (p === undefined || p === null || p === '') return;
  /* **win32 上那条另一份实现**（上面那段注释欠的账）：那儿没有 `rm`，量到的是
   *   `Error: cannot spawn: spawnSync rm ENOENT`（`scratchDir` 一进来就倒）。
   * cmd 自己带的 `rmdir /s /q` 做的是同一件事；路径要折成反斜杠 —— cmd 的 rmdir
   * 不认正斜杠，而我们内部一路用的是正斜杠。退出码不看：这一格的语义是「确保没有」，
   * 本来就不存在时 rmdir 回非零，那不是错。 */
  if (env('OS') === 'Windows_NT' || (env('SystemRoot') ?? '') !== '') {
    const w = p.replace(/\//g, '\\');
    if (isDir(p)) spawn('cmd', ['/c', 'rmdir', '/s', '/q', w], 'c');
    else if (exists(p)) spawn('cmd', ['/c', 'del', '/f', '/q', w], 'c');
    return;
  }
  spawn('rm', ['-rf', p], 'c');
}

/** 扔掉一格暂存目录。**失败不抛** —— 倒垃圾失败不该让构建失败。 */
export function dropScratch(dir) {
  if (dir === undefined || dir === null || dir === '') return;
  if (!dir.includes('/work/')) return;   // 只扔 work/ 底下的，别的一概不碰
  rmTree(dir);
}

/** 一棵目录有多大、最后动过是什么时候（`omni cache ls` / `gc` 用）。 */
function treeStat(p) {
  let bytes = 0;
  let newest = 0;
  const walk = (at) => {
    let names;
    try { names = readDir(at); } catch { return; }
    for (const n of names) {
      const full = join(at, n);
      if (isDir(full)) { walk(full); continue; }
      try {
        bytes = bytes + fileSize(full);
        const m = mtimeMs(full);
        if (m > newest) newest = m;
      } catch { /* 正被人删 */ }
    }
  };
  if (isDir(p)) walk(p);
  else {
    try { bytes = fileSize(p); newest = mtimeMs(p); } catch { /* 没了 */ }
  }
  return { bytes, newest };
}

/** 缓存根底下每一格的账：名字、多大、最后动过。按大小降序。 */
export function cacheList() {
  const root = cacheRoot();
  const out = [];
  let names;
  try { names = readDir(root); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const s = treeStat(join(root, n));
    out.push({ name: n, path: join(root, n), bytes: s.bytes, newest: s.newest });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/**
 * 这一格是**判据**，不是产物 —— 倒垃圾时一律留着。
 *
 * 为什么要这么一条：`.omni-cache/epsref` 里躺着近 200 份真 asy 出的图（oracle）。
 * 它长得像缓存（在缓存根底下、按名字存），可**重做一遍要跑近 200 次真 asy**（量过 5 分多钟），
 * 而且 `tests/asy/eps.js` 默认**不生成**（要 `OMNI_EPS_GEN=1`）—— 清掉之后那一轴不报错，
 * 只安静地把每个例子记成"没有参考、不计分"。这件事真发生过一次（2026-09-21 的 `cache gc`
 * 把它连根扔了，之后 `equilateral` / `cardioid` 全变成不计分），所以规矩写进代码而不是脑子里：
 * **只有显式 `--oracle` 才动它们。**
 */
function isOracle(name) {
  return name === 'epsref' || name.startsWith('epsref-');
}

/**
 * 倒垃圾。三条规矩，每条都能单独说清：
 *
 *   1. `work/` **整棵扔掉**（它是暂存，不是缓存）；
 *   2. 别的格子里，最后动过在 `days` 天之前的**整格**扔掉（默认 14 天）；
 *   3. 还超 `maxMb` 的话，从**最旧**的开始继续扔，直到降到线下（默认不限）。
 *
 * `all: true` = 整个缓存根扔掉（下一趟全部重算，慢但绝对干净）。
 * 两种都**不碰 oracle 那几格**（见 isOracle），除非 `oracle: true`。
 * 回一份账：扔了哪几格、各多少字节。
 */
export function cacheGc(opts) {
  const o = opts ?? {};
  const now = o.now ?? Date.now();
  const days = o.days === undefined ? 14 : o.days;
  const dropped = [];
  const take = (e) => { dropped.push(e); rmTree(e.path); };
  const keep = (e) => o.oracle !== true && isOracle(e.name);
  if (o.all === true) {
    for (const e of cacheList()) if (!keep(e)) take(e);
    return dropped;
  }
  const entries = cacheList();
  for (const e of entries) {
    if (keep(e)) continue;
    if (e.name === 'work') { take(e); continue; }
    if (days >= 0 && e.newest > 0 && now - e.newest > days * 86400000) take(e);
  }
  if (o.maxMb !== undefined && o.maxMb > 0) {
    const left = cacheList().sort((a, b) => a.newest - b.newest);
    let total = 0;
    for (const e of left) total = total + e.bytes;
    for (const e of left) {
      if (total <= o.maxMb * 1048576) break;
      if (keep(e)) continue;
      take(e);
      total = total - e.bytes;
    }
  }
  return dropped;
}

/** 这一格会不会被 `gc` / `clean` 留下（`omni cache` 那边印给人看，判据只有一处）。 */
export function cacheKept(name, oracle) {
  return oracle !== true && isOracle(name);
}

