/**
 * Omni Studio 那一页**两种跑法共用的那几格**（`docs/design/omni-serve-studio.md` §4/§5）。
 *
 * 两种跑法：
 *   * `omni serve` —— `src/core/serve.js` 起的 HTTP 服务，读真磁盘；
 *   * 单体 HTML —— `src/studio/browser-main.js`，读内联进页面的那张表。
 *
 * 共用的是**知识**，不是实现细节：哪几棵子树对外可见、后缀怎么认语言、路径闸怎么关、
 * 别的语言的等效命令怎么翻。这四样抄两份的话，加一门语言要改两处，而其中一处一定会忘。
 *
 * 这一份**只碰封闭 ABI**（`readDir` / `isDir` / `exists`），所以两条腿上同一份代码就跑 ——
 * 服务那边 `native.js` 去问文件系统，页面那边 `browser.js` 去问内联的表。
 */

import { exists, readDir, isDir, env } from '../host/native.js';
import { join } from '../host/path.js';

/**
 * **目录映射（挂载点）** —— 仓库外的例子按**它自己的结构**挂进这棵树。
 *
 * 为什么不是"把例子拷进 `ext/<语言>/examples`"：PolyDraw 与 EvalDraw 各自带着一整棵
 * 例子树（`polydraw/ken`、`polydraw/tigrou`、`evaldraw/demos` …，两边合起来两百多份）。
 * 那是**别人的语料**，不该躺在我们的源码目录里，而"挑几份摆上首页"又不是"全部例子" ——
 * 所以树上多两棵根，路径就是 `polydraw/ken/balls.pss`，结构与正本一模一样。
 *
 * 从哪儿来（`.env` 也管）：
 *   * `OMNI_MOUNTS`：`前缀=绝对路径` 用 `,` 隔开，几棵都行，后缀不挑；
 *   * 没写就试那两格默认（`OMNI_PSS_DIR` / `OMNI_KC_DIR` —— 与 `tests/eval/scan.js`
 *     同一格环境变量，所以扫语料与看语料是同一份路径）。
 *
 * **目录不在就当没有这一格**：别的机器上没有这份语料，树上少两棵根而已，不报错。
 */
export function mounts() {
  const out = [];
  const add = (name, prefix, dir, exts) => {
    if (typeof dir !== 'string' || dir.length === 0 || !isDir(dir)) return;
    out.push({ name, path: prefix, dir, exts, mount: true });
  };
  const spec = env('OMNI_MOUNTS');
  if (typeof spec === 'string' && spec.length > 0) {
    for (const part of spec.split(',')) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      const prefix = part.slice(0, i).trim();
      add(prefix, prefix, part.slice(i + 1).trim(), null);
    }
    return out;
  }
  const home = env('HOME') ?? '';
  add('PolyDraw 例子', 'polydraw', env('OMNI_PSS_DIR') ?? `${home}/Documents/polydraw`, ['.pss']);
  add('EvalDraw 例子', 'evaldraw', env('OMNI_KC_DIR') ?? `${home}/Downloads/evaldraw`, ['.kc']);
  return out;
}

/** 一格虚拟路径落在哪个挂载点上（不在就 null）。 */
export function mountOf(rel) {
  for (const m of mounts()) {
    if (rel === m.path || rel.startsWith(`${m.path}/`)) return m;
  }
  return null;
}

/**
 * 挂载点上的虚拟路径 -> **真绝对路径**（不在挂载点上或者后缀不收就 null）。
 *
 * 目录本身也回（树要走它）；文件要过后缀白名单 —— 那棵树上几十份 `.png`/`.wav` 素材
 * 不该进树（跑起来那一侧照旧按脚本旁边的相对路径找它们）。
 *
 * `more` 是**额外收的那几个后缀**：`/api/asset` 那一格要拿脚本旁边那几张图
 * （文件纹理与 `pic("a.png")`）—— 它们不进树，但**读得到**。两件事不是一件事，
 * 所以分两格参数，而不是把图塞进 `exts` 里。
 */
export function mountPath(rel, more = []) {
  const m = mountOf(rel);
  if (m === null) return null;
  const sub = rel === m.path ? '' : rel.slice(m.path.length + 1);
  const abs = sub === '' ? m.dir : join(m.dir, sub);
  if (!exists(abs)) return null;
  if (!isDir(abs) && m.exts !== null
    && !m.exts.includes(extOf(abs)) && !more.includes(extOf(abs))) return null;
  return abs;
}

/**
 * 虚拟文件树的**白名单**：只有这几棵子树对外可见。
 *
 * 为什么是白名单而不是黑名单：仓库里有 `.env`、有缓存、有 `dist/` —— 黑名单总会漏。
 * 每一格是 `{ 显示名, 仓库里的相对路径, 收哪些后缀 }`；后缀为 null = 全收。
 */
export const TREE_ROOTS = [
  { name: '文档', path: 'docs', exts: ['.md'] },
  /* `.omni` 也收：从前这棵树上**一行主语言的代码都没有** —— 十几门借来的语言都在，
     而这条链自己那门看不见。`ext/omni/examples/` 底下那几份就是给人看的 omni 例子
     （那个目录没有 `omni-ext.json`，所以它不是一格扩展，只是例子 —— 见 `ext.js` 里
     "不自述的目录不算扩展"那一句）。 */
  { name: '例子', path: 'ext', exts: ['.go', '.nim', '.v', '.lua', '.mojo', '.cpp', '.bas',
    '.awk', '.ss', '.lisp', '.asy', '.jnc', '.js', '.sx', '.html', '.omni', '.pss', '.kc'],
    only: 'examples' },
  { name: '判据', path: 'tests', exts: ['.go', '.sx', '.asy', '.wat', '.js', '.jnc', '.frag',
    '.omni'],
    /* `only` 收一串：`cases` 是各腿的判据例子，**`draw` 是 asy 真出图的那些** ——
       少了它，树上一份能出图的 `.asy` 都没有（`cases` 底下的 asy 全是算术），
       于是"预览"那一栏在 asy 上永远空着。glsl 的 `.frag` 在 cases 底下。 */
    only: ['cases', 'draw'] },
  /* **语法文件** —— 实验室模式（`docs/design/omni-lab.md`）的正事就是"改一条规则，
     看表与树怎么变"，所以那 `.grammar` 得读得到。两棵：
       * `ext/<语言>/<语言>.grammar` —— 十一门借来的语言，各一份；
       * `tests/glr/grammars/*.grammar` —— 教学用的那几份（`expr` 十五行零冲突、
         `dangling` 悬挂 else、`typename` 类型名那道墙）。
     **`src/core/frontend-asy` 那三份（asy / glsl / jnc）不在这儿**：那要放开 `src` 这个前缀，
     而 `safePath` 只比前缀不比后缀 —— 放开它等于把整个 `src/` 交出去。
     要看那三份走 IDE 模式（它们在磁盘上，不在这棵树上）。 */
  { name: '语法', path: 'ext', exts: ['.grammar'] },
  { name: '语法（判据）', path: 'tests', exts: ['.grammar'], only: ['grammars'] },
];

/** 后缀 -> 语言标签（高亮与"用哪条腿跑"两处都用它）。 */
export const LANG_OF = {
  '.omni': 'omni', '.omnid': 'omni', '.omnis': 'omni', '.sx': 'sx', '.asy': 'asy',
  '.go': 'go', '.nim': 'nim', '.v': 'v', '.lua': 'lua', '.mojo': 'mojo', '.cpp': 'cpp',
  '.c': 'c', '.h': 'c', '.bas': 'basic', '.awk': 'awk', '.ss': 'scheme', '.lisp': 'lisp',
  '.js': 'js', '.mjs': 'js', '.jnc': 'jancy', '.wat': 'wat', '.frag': 'glsl', '.vert': 'glsl',
  '.md': 'markdown', '.json': 'json', '.css': 'css', '.html': 'html',
  '.grammar': 'lisp',
  /* EVAL 两门（PolyDraw / EvalDraw）：**标签就用后缀本身** —— 递给 `/api/run` 的
     `lang` 在"编辑器里改过"那一档会拼成 `__new/live.<lang>`，标签不是后缀的话
     CLI 认不出那份临时文件（`serve.js` 的 `runRequest`）。 */
  '.pss': 'pss', '.kc': 'kc',
};

export const extOf = (p) => (p.lastIndexOf('.') < 0 ? '' : p.slice(p.lastIndexOf('.')));
export const langOf = (p) => LANG_OF[extOf(p)] ?? 'text';

/**
 * 一格路径**在不在白名单里**（`/api/file` 的闸）。
 *
 * 三道：不许绝对路径、不许 `..`、必须落在某棵白名单子树下。
 * 回真正要读的绝对路径，或者 null。
 */
export function safePath(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (rel.startsWith('/') || rel.includes('..') || rel.includes('\0')) return null;
  /* 挂载点那几棵（`polydraw/…`、`evaldraw/…`）：映射到真目录，闸照旧（不许绝对路径、
     不许 `..`、后缀要在白名单里）。 */
  const mp = mountPath(rel);
  if (mp !== null) return mp;
  const ok = TREE_ROOTS.some((r) => rel === r.path || rel.startsWith(`${r.path}/`));
  if (!ok) return null;
  const abs = join(root, rel);
  return exists(abs) ? abs : null;
}

/**
 * 把一棵子树收成 `{ name, path, kind, lang, children }`。
 *
 * `only` 那一格是"只要这一层里叫这个名字的目录"（`ext` 底下的 examples、`tests` 底下的
 * cases）—— 不然 `ext` 底下那一堆 `.js` 实现也会进树，而树是给人看例子的。
 *
 * ⚠️ 这一段里**不许写"星号紧跟斜杠"**：那会把这个块注释提前关掉
 * （见 memory 里"注释里的定界符会把宿主文件切开"那一条 —— 踩过两次）。
 */
function walk(root, rel, spec, depth, prefix = '') {
  const abs = rel === '' ? root : join(root, rel);
  if (depth > 6) return null;
  /** 报出去的路径：挂载点那几棵要带前缀（`polydraw` + `/ken/balls.pss`）。 */
  const vpath = prefix === '' ? rel : (rel === '' ? prefix : `${prefix}/${rel}`);
  const nameOf = () => (rel === '' ? prefix : rel.slice(rel.lastIndexOf('/') + 1));
  /** `only` 收一格名字或一串名字（`['cases', 'draw']`）—— 归一到数组再问。 */
  const onlyList = spec.only === undefined ? null
    : (Array.isArray(spec.only) ? spec.only : [spec.only]);
  if (!isDir(abs)) {
    const e = extOf(rel);
    if (spec.exts !== null && !spec.exts.includes(e)) return null;
    /* `only` 那一格也管**文件**：`tests/all.js` 是判据的跑手，不是一格例子。
       判据是"路径里有没有那一层"（`tests` 某个腿 `cases` 底下）。 */
    if (onlyList !== null && !onlyList.some((o) => rel.includes(`/${o}/`))) return null;
    return { name: nameOf(), path: vpath, kind: 'file', lang: langOf(rel) };
  }
  const kids = [];
  for (const nm of readDir(abs)) {
    if (nm.startsWith('.')) continue;
    const sub = rel === '' ? nm : `${rel}/${nm}`;
    /* `only`：在第二层上只放行那几个名字的目录（`ext/go/examples`、`tests/asy/draw`）。 */
    if (onlyList !== null && isDir(join(root, sub))) {
      const parts = sub.split('/');
      if (parts.length === 3 && !onlyList.includes(nm)) continue;
    }
    const k = walk(root, sub, spec, depth + 1, prefix);
    if (k !== null) kids.push(k);
  }
  if (kids.length === 0) return null;
  kids.sort(byIdeOrder);
  return { name: nameOf(), path: vpath, kind: 'dir', children: kids };
}

/**
 * **按 IDE 的次序排，不按 `ls` 的次序排**：目录在前、文件在后；名字里的数字**按数值**比。
 *
 * `ls` 是逐字节比的字典序，于是 `10-pairs` 排在 `01..09` 后面看着还行，可 `100-local-fn`
 * 会插到 `10-pairs` 与 `11-…` 之间 —— 判据目录里一百多份编号文件，人眼在那儿永远找不到
 * 下一个。每个编辑器的文件树都是"自然序"，这一格照它来。
 *
 * 实现：把名字切成"数字段 / 非数字段"交替的串，数字段按数值比、别的按小写字典序比
 * （大小写不敏感是编辑器的另一条习惯：`README` 不该被踢到所有小写名字前头）。
 */
export function byIdeOrder(a, b) {
  if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
  return natCompare(a.name, b.name);
}

export function natCompare(x, y) {
  const ax = String(x).match(/\d+|\D+/g) ?? [];
  const ay = String(y).match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ax.length, ay.length); i++) {
    const p = ax[i];
    const q = ay[i];
    const pn = /^\d/.test(p);
    const qn = /^\d/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d;
      continue;
    }
    const pl = p.toLowerCase();
    const ql = q.toLowerCase();
    if (pl !== ql) return pl < ql ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;     // 只差大小写：给一个稳定的次序
  }
  return ax.length - ay.length;
}

/** 整棵虚拟文件树（`/api/tree`）。一次给全 —— 一千多格 JSON 也就几百 KB。 */
export function buildTree(root) {
  const out = [];
  for (const spec of TREE_ROOTS) {
    const t = walk(root, spec.path, spec, 0);
    if (t !== null) out.push({ ...t, name: spec.name });
  }
  /* 挂载点那几棵（见 `mounts()` 的头注）：**根是那个真目录**，报出来的路径带上前缀，
     于是树上看见的就是正本自己的结构（`polydraw/ken/…`）。 */
  for (const m of mounts()) {
    const t = walk(m.dir, '', { exts: m.exts }, 0, m.path);
    if (t !== null) out.push({ ...t, name: m.name, path: m.path });
  }
  return { roots: out };
}

/**
 * **别的语言的等效命令**（虚拟 shell 里敲 `go run x.go` 也认）。
 *
 * 为什么要这一格：这条链的卖点就是"同一条管线编十几门语言"，而"我平时怎么敲"是
 * 每门语言的用户唯一记得住的东西。这不是新发明 —— `omni c tcc` 早就把 tcc 那一套
 * 参数解析翻成 omni 命令了（`src/core/cli/cmd-tcc.js`），这儿照它加一张表。
 *
 * 一格 = `(argv 剩下的那几个词) -> omni 的 argv`；回 null = 这条不认。
 * **一个字都不猜**：认不出来的形状原样交给 `omni`，让它自己说那句话。
 */
export const EQUIV = {
  /* go：`go run x.go` / `go build x.go` */
  go: (a) => (a[0] === 'run' ? ['run', ...a.slice(1)]
    : (a[0] === 'build' ? ['build', ...a.slice(1)] : null)),
  /* nim：`nim c x.nim`（编）/ `nim r x.nim`（编完就跑） */
  nim: (a) => (a[0] === 'r' ? ['run', ...a.slice(1)]
    : (a[0] === 'c' || a[0] === 'compile' ? ['build', ...a.slice(1)] : null)),
  /* v：`v run x.v` / `v x.v` */
  v: (a) => (a[0] === 'run' ? ['run', ...a.slice(1)] : ['build', ...a]),
  /* tcc / cc / gcc / clang：整套参数交给现成的那一份翻译器 */
  tcc: (a) => ['c', 'tcc', ...a],
  cc: (a) => ['c', 'tcc', ...a],
  gcc: (a) => ['c', 'tcc', ...a],
  clang: (a) => ['c', 'tcc', ...a],
  /* 一条命令一份源码那几门：直接 run */
  lua: (a) => ['run', ...a],
  node: (a) => ['run', ...a],
  mojo: (a) => (a[0] === 'run' ? ['run', ...a.slice(1)] : ['run', ...a]),
  /* awk：`awk -f x.awk`（`-f` 那一格是脚本文件） */
  awk: (a) => (a[0] === '-f' ? ['run', ...a.slice(1)] : null),
  /* scheme / lisp */
  scheme: (a) => ['run', ...a],
  sbcl: (a) => (a[0] === '--script' ? ['run', ...a.slice(1)] : ['run', ...a]),
  /* asy（Asymptote） */
  asy: (a) => ['run', ...a],
};

/**
 * 一整行命令 -> omni 的 argv（认不出那一格回 null）。
 *
 * `omni …` 剥掉头就是 argv；别的按 `EQUIV` 翻。**不做 shell 的引号与管道** ——
 * 那是一整台 shell，而这儿要的是"把命令交给编译器"。
 */
export function shellToArgv(line) {
  const parts = line.trim().split(/\s+/).filter((x) => x.length > 0);
  if (parts.length === 0) return null;
  const head = parts[0];
  if (head === 'omni') return parts.slice(1);
  const f = EQUIV[head];
  if (f === undefined) return null;
  return f(parts.slice(1));
}
