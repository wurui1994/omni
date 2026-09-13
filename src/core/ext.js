// src/core/ext.js —— **扩展的机制**：别人写的语言怎么被找到、怎么自述、怎么装进来
//
// 为什么有这一份（ADR-0030 第 4 节的更正）：`ext/` 存在的理由是**我们要当 SDK** ——
// 后面会有别人写他们自己的语言。所以"非核心的东西不许直接往 `src/` 里加"：
// 我先前给 Lua 在 `src/core/lang/` 塞了一格外壳、又往 `lang/builtin.js` 的表里加了一行，
// 那等于把"我们认识 lua"写进了核心 —— 别人的语言不可能进我们的表。
//
// 核心该给的是**机制**，扩展该做的是**自述**。三条约定（这就是那份契约）：
//
//   1. 一格扩展 = 一个目录。目录里有 `omni-ext.json`（**数据**，不是代码）——
//      于是核心"知道有这么一门语言"这件事**不必装它的任何代码**。
//   2. 自述里说清四样：`name`（叫什么）、`provides`（认哪些后缀 / 答哪几格 cap / 出哪些目标）、
//      `entry`（入口模块，相对这个目录）、`register`（入口里那个注册函数的名字）。
//   3. 真被问到那一格时（`omni run x.lua` 问 `.lua`）才装它，装法由宿主注入
//      （源码腿是 `require`，编出来的腿是插件动态库）—— 与内建那几门共用同一条迟装路
//      （`plugin.js` 的 `declareProvider`），所以**注册表这一层看不出谁是内建谁是扩展**。
//
// 搜索路径：`OMNI_EXT_PATH`（`:` 分隔）；没设就找**这份仓库/安装位置旁边的 `ext/`**
// 与 `~/.omni/ext`。找不着不是错 —— 没有扩展就是没有扩展。

import { OmniError } from './source/diag.js';
import { join } from './host/path.js';
import {
  readDir, readText, exists, isDir, env, installDir, cwd, realPath,
} from './host/native.js';
import { parseJson } from './host/json_read.js';
import { declareProvider } from './plugin.js';

/** 自述文件的名字。**一处定义** —— 文档与实现都指这一格。 */
export const MANIFEST = 'omni-ext.json';

/**
 * 扩展目录的搜索路径。`OMNI_EXT_PATH`（`:` 分隔）优先；没设就按**布局**找
 * （与 `host/data.js` 找数据同一条路子：一串候选根，存在的都算），再加 `~/.omni/ext`。
 *
 * 为什么不写死"往上两层"：`installDir()` 在源码腿上指到 `src/core/host`、编出来的腿上
 * 指到产物目录 —— 层数不一样。写死了量出来是空的（第一次就踩了这一格）。
 */
export function extDirs() {
  const set = env('OMNI_EXT_PATH');
  if (set !== undefined && set !== null && set !== '') {
    return set.split(':').filter((s) => s !== '');
  }
  const inst = installDir();
  const cands = [
    join(inst, 'ext'),                          // 装好的样子：<安装位置>/ext
    join(inst, '..', 'ext'),
    join(inst, '..', '..', 'ext'),
    join(inst, '..', '..', '..', 'ext'),        // 源码腿：src/core/host -> <仓库>/ext
    join(cwd(), 'ext'),                         // 在仓库根上直接跑
  ];
  const home = env('HOME');
  if (home !== undefined && home !== null && home !== '') cands.push(join(home, '.omni', 'ext'));
  const out = [];
  for (const d of cands) {
    if (!exists(d) || !isDir(d)) continue;
    const real = realPath(d);
    if (!out.includes(real)) out.push(real);     // 同一个目录只算一遍（层数不同会撞上同一处）
  }
  return out;
}

/** 校验一份自述。**当场说清哪一格不对** —— 别人写扩展时，这几句话就是他们的编译器。 */
function checkManifest(m, path) {
  const bad = (why) => new OmniError(`${path}: ${why}`);
  if (m === null || typeof m !== 'object') throw bad('自述该是一个对象');
  if (typeof m.name !== 'string' || m.name === '') throw bad("要一格 'name'（这门语言叫什么）");
  if (typeof m.entry !== 'string' || m.entry === '') throw bad("要一格 'entry'（入口模块，相对这个目录）");
  if (typeof m.register !== 'string' || m.register === '') throw bad("要一格 'register'（入口里那个注册函数的名字）");
  const p = m.provides;
  if (p === null || typeof p !== 'object') throw bad("要一格 'provides'（它认哪些后缀 / 答哪几格 cap / 出哪些目标）");
  const lists = ['exts', 'runnerExts', 'caps', 'targets'];
  let any = false;
  for (const k of lists) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) throw bad(`'provides.${k}' 该是一串字符串`);
    if (v.length > 0) any = true;
  }
  if (!any) throw bad(`'provides' 里一格都没有（至少要 ${lists.join(' / ')} 之一）`);
  return m;
}

/** 扫一遍搜索路径，答一串 `{dir, manifest}`。不装任何扩展的代码。 */
export function scanExts(dirs = extDirs()) {
  const out = [];
  for (const root of dirs) {
    if (!exists(root) || !isDir(root)) continue;
    for (const name of readDir(root)) {
      const dir = join(root, name);
      if (!isDir(dir)) continue;
      const path = join(dir, MANIFEST);
      if (!exists(path)) continue;                 // 不自述的目录不算扩展（比如放语料的）
      out.push({ dir, manifest: checkManifest(parseJson(readText(path)), path) });
    }
  }
  return out;
}

/**
 * 把扫到的扩展**声明**进注册表（还不装）。
 *
 * @param load `(dir, entry) -> 模块对象`。宿主注入 —— 源码腿用 `require`，
 *   编出来的腿用插件加载器。核心自己不选装法，这样"怎么装"就不是核心的知识。
 * @param api 递给扩展的 `register(api)`：就是核心的 pluginApi()。
 * @param dirs 搜索路径（默认 `extDirs()`）
 * @returns 声明了几格
 */
export function declareExts(load, api, dirs = extDirs()) {
  const found = scanExts(dirs);
  for (const { dir, manifest } of found) {
    const p = manifest.provides;
    declareProvider({
      name: manifest.name,
      exts: p.exts,
      runnerExts: p.runnerExts,
      caps: p.caps,
      targets: p.targets,
      from: `${dir}/${MANIFEST}`,
    }, () => {
      const mod = load(dir, manifest.entry);
      const reg = mod === null || mod === undefined ? undefined : mod[manifest.register];
      if (typeof reg !== 'function') {
        throw new OmniError(`${dir}/${MANIFEST}: 入口 '${manifest.entry}' 里没有 `
          + `'${manifest.register}' 这个注册函数（自述与代码走散了）`);
      }
      reg(api);
    });
  }
  return found.length;
}
