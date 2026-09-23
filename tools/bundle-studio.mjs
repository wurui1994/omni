#!/usr/bin/env node
/**
 * 把编译器 + Studio 拼成**一份 HTML**（`docs/design/omni-serve-studio.md` §5）。
 *
 * 一份 `omni-studio.html`，双击就开，**不要 serve、不要 node**。
 *
 * 怎么拼（三件事，一件也不多）：
 *
 *   1. **换宿主那一层**。`src/core/host/native.js` 是封闭 ABI 的 node 那份实现；
 *      这儿把那个模块 id 指到 `src/core/host/browser.js`（第四条腿）。
 *      编译器本体**一行不改** —— 39 个引用方照旧写 `./host/native.js`。
 *   2. **把 ESM 图摊成一张登记表**。每份文件包成一个函数，`__req(id)` 按需跑一遍并缓存
 *      （CommonJS 那一套最小形态）。`import {a} from './x.js'` 变
 *      `const { a } = __req('x 的 id')`，`export function f` 变 `function f` + 一格登记。
 *   3. **虚拟文件系统内联**。文档与例子序列化成一张 `路径 -> 文本` 的表 ——
 *      这是**刻意的例外**（设计文档 §5：抽离 node 依赖，虚拟文件系统除外）。
 *
 * 为什么不用现成的打包器：要"零依赖、零构建"。而我们的 ESM 图**没有环**（这份脚本自己
 * 查，有环就红着停），所以 `const {a} = __req(…)` 这种最笨的摊法是对的 —— 不需要
 * 活绑定，也就不需要重写每一处引用。
 *
 * 用法：`node tools/bundle-studio.mjs [-o dist/omni-studio.html]`
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 入口：浏览器那一侧的小壳子（它自己 import 编译器与宿主）。 */
const ENTRY = 'src/studio/browser-main.js';

/** **换腿**：这个 id 被拼进去的时候，用的是右边那份文件。 */
const SWAP = {
  'src/core/host/native.js': 'src/core/host/browser.js',
  /* 内建语言那张表有三份实现，接缝与 `cli.js` 的 `readModule` 换 `--fat` 时同一处：
   *   `lang/builtin.js`      迟装 —— 靠 `createRequire`（`node:module`），只给 node 那条腿
   *   `lang/builtin-fat.js`  一次全装 —— 八门语言四个目标全是**静态 import**
   *   `lang/builtin-web.js`  fat 再加上 `ext/` 里那三格 JS 扩展（lua / gsl-shell / tiny）
   * 浏览器这条腿上既没有 `require` 也没有 `dlopen`，而这份打包器只认静态 import，
   * 所以换成 web 那一份。代价明写：八门语言 + 三格扩展全进这份 HTML（体积账见 `--split`）。 */
  'src/core/lang/builtin.js': 'src/core/lang/builtin-web.js',
};

/**
 * **同一格宿主只许有一份**：`browser.js` 里有几格 `native.js` 上没有的东西
 * （`mountFiles` / `takeOutput` / `setArgs`），所以 `browser-main.js` 直接写
 * `./host/browser.js`。可 `native.js` 已经被 `SWAP` 换成同一份文件了 —— 两个 id
 * 各收一份的话，宿主的那张 `FILES` 表就有两份，**装进去的与读出来的不是同一格**。
 *
 * 踩过一次，表现是 `ENOENT: ext/go/go.grammar（浏览器这条腿上只有内联的那张表）`
 * 而那张表明明有它。所以这儿把两个 id 收成一个。
 */
const ALIAS = { 'src/core/host/browser.js': 'src/core/host/native.js' };

/* ------------------------------------------------------------------ ESM 图 */

/**
 * 静态 import / re-export 的两种形状，**一处定义、两处用**（扫依赖与改写各用一遍）。
 *
 *   `FROM`  `import … from '…'` / `export … from '…'`
 *   `BARE`  只为副作用的 `import '…';`（`mir/opt/index.js` 里那七条 pass 就是它）
 *
 * `AT` 是锚点：行首**或**紧跟在块注释的收尾之后 —— 树里真有"块注释收尾之后紧接着
 * `export const …`"这种一行两件事的写法（`lang/jnc/value.js`）。
 * （这一段里**不许写"星号紧跟斜杠"** —— 那会把本注释提前关掉。踩过第三次了。）
 *
 * 子句里**必须允许换行**：`export {\n a,\n b,\n} from '…'` 是这棵树里最常见的写法。
 * 踩过一次：扫依赖那条写成 `[^;\n]*?`、改写那条写成 `[^;]*?`，于是 `__req('…')` 发了出来
 * 而那份模块从没被收进登记表 —— 报的是"没有这一格模块"，而根因在**另一条正则**上。
 * 两处用同一对定义就没有这一类。
 */
const AT = '(?:^|(?<=\\n)|(?<=\\*/))';
/* 子句只有两种形状：`{ … }` 与 `* as ns`。**必须这么钉死**，不能写成"到 from 之前的
 * 随便什么" —— 那一版把 `export const ROOT = {`（`cli/cmds.js` 顶层那格）当成子句的开头，
 * 一路吞过几十行帮助文本，撞上里头教人用的那句 `… from 'omni-lang/build';`，
 * 然后报"`omni-lang/build` 不是相对路径"，而那份文件里一条 node 依赖都没有。 */
const CLAUSE = '(\\{[^{}]*\\}|\\*\\s+as\\s+[A-Za-z_$][\\w$]*|[A-Za-z_$][\\w$]*)';
const FROM_SRC = `${AT}([ \\t]*)(import|export)\\s+${CLAUSE}\\s+from\\s*['"]([^'"]+)['"]\\s*;?`;
const BARE_SRC = `${AT}([ \\t]*)import\\s*['"]([^'"]+)['"]\\s*;`;

/**
 * 这一处匹配**真的是一条顶层 import** 吗 —— 还是某个字符串里长得像的一段？
 *
 * 判据只有一条：真的那条**贴着行首**（这棵树里的顶层 import 一律不缩进）。缩进了的只有
 * 一种情形算真的：紧跟在块注释收尾之后（`lang/jnc/value.js` 那种一行两件事）。
 *
 * 为什么要这一格：`cli/cmds.js` 的帮助文本里印着一句 `import { Build } from
 * 'omni-lang/build';`（教人怎么在自己项目里用我们这个包）—— 它缩进两格躺在模板串里。
 * 少了这一判，打包器把它当成一条真 import，报的是"`omni-lang/build` 不是相对路径"，
 * 而那份文件里一条 node 依赖都没有。
 */
function atTopLevel(text, idx, ind) {
  if (ind.length === 0) return true;
  return text.slice(0, idx).endsWith('*/');
}

function depsOf(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(FROM_SRC, 'g'))) {
    if (atTopLevel(text, m.index, m[1])) out.push(m[4]);
  }
  for (const m of text.matchAll(new RegExp(BARE_SRC, 'g'))) {
    if (atTopLevel(text, m.index, m[1])) out.push(m[2]);
  }
  return out;
}

/** 相对说明符 -> 仓库里的相对路径（就是模块 id，过一遍 `ALIAS` 收成唯一那一格）。 */
function resolveId(fromId, spec) {
  if (!spec.startsWith('.')) return null;   /* `node:*` 与裸名字：不该有，见下面的闸 */
  const id = relative(ROOT, resolve(ROOT, dirname(fromId), spec)).split('\\').join('/');
  return ALIAS[id] ?? id;
}

/** 从入口走一遍，回 `[id, 文本]` 的拓扑序（叶子在前）+ 环的清单。 */
function collect(entry) {
  const text = new Map();
  const deps = new Map();
  const stack = [entry];
  while (stack.length > 0) {
    const id = stack.pop();
    if (text.has(id)) continue;
    const real = SWAP[id] ?? id;
    const src = readFileSync(join(ROOT, real), 'utf8');
    text.set(id, src);
    const ds = [];
    for (const spec of depsOf(src)) {
      const to = resolveId(real, spec);
      if (to === null) {
        throw new Error(`${real} 里有一条不是相对路径的 import：${spec}\n`
          + '  浏览器那条腿上不许有 `node:*` 与裸名字 —— 要么进封闭 ABI，要么别用。');
      }
      ds.push(to);
      stack.push(to);
    }
    deps.set(id, ds);
  }
  /* 拓扑序 + 找环（Tarjan 那一套的最小形态：白/灰/黑三色）。 */
  const order = [];
  const color = new Map();
  const cycles = [];
  const path = [];
  const visit = (id) => {
    const c = color.get(id);
    if (c === 2) return;
    if (c === 1) { cycles.push([...path.slice(path.indexOf(id)), id].join(' -> ')); return; }
    color.set(id, 1);
    path.push(id);
    for (const d of deps.get(id)) visit(d);
    path.pop();
    color.set(id, 2);
    order.push(id);
  };
  visit(entry);
  return { order, text, cycles };
}

/* -------------------------------------------------------- ESM -> 登记表函数 */

/**
 * 一份 ESM 改成"登记表里的一格函数体"。
 *
 * 七种形状（我们的代码里只有这七种）：
 *   `import { a, b as c } from '…'`   -> `const { a, b: c } = __req('…')`
 *   `import * as ns from '…'`         -> `const ns = __req('…')`
 *   `import x from '…'`               -> `const x = __req('…').default`
 *   `export { a, b } from '…'`        -> re-export：拿进来再登记出去
 *   `export function f` / `export class C` / `export const x` / `export let x`
 *   `export { a, b as c }`            -> 尾部登记
 *   `export default <表达式>;`         -> `__e.default = <表达式>;`
 *
 * 默认那两格从前**不认**，理由写的是"我们的代码里一处都没有"。现在有了：
 * `src/lang/jnc/features/*.js` 那六份（一个特性一份 `export default feature({…})`，
 * `features/index.js` 按默认名字把它们收起来）。所以这儿认下来 —— 拒的话就得去改那门
 * 语言的写法，而那与"能不能装进一份 HTML"毫无关系。
 *
 * 前三条的正则与扫依赖那一步**共用** `FROM_SRC` / `BARE_SRC`（见上面那段账）。
 */
function toRegistryBody(id, src) {
  const names = new Set();     /* 要登记出去的本地名 -> 导出名（同名居多） */
  const alias = new Map();     /* 导出名 -> 本地名 */
  /* 开头那行 `#!/usr/bin/env node` 去掉：它在文件头上是合法的（node 与 shell 都认），
     可这儿每份模块被包进一个函数体，`#` 在那儿是硬语法错 —— `cli.js` 就有这一行，
     踩出来的样子是拼好的那份在第 152574 行报 `Invalid or unexpected token`。 */
  let out = src.startsWith('#!') ? src.slice(src.indexOf('\n') + 1) : src;

  /* 1) `import … from '…'` 与 `export … from '…'` */
  out = out.replace(new RegExp(FROM_SRC, 'g'),
    (all, ind, kw, clause, spec, offset, whole) => {
      /* 字符串里长得像 import 的那种原样留着（判据与扫依赖那一步**同一格**）。 */
      if (!atTopLevel(whole, offset, ind)) return all;
      const to = resolveId(SWAP[id] ?? id, spec);
      const req = `__req(${JSON.stringify(to)})`;
      const star = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (star !== null) return `${ind}const ${star[1]} = ${req};`;
      /* 默认导入：`import fields from './fields.js'`（jnc 那几份特性）。 */
      const bare = clause.match(/^[A-Za-z_$][\w$]*$/);
      if (bare !== null) {
        if (kw === 'export') throw new Error(`${id}: 不认的 export 形状 —— ${all.trim()}`);
        return `${ind}const ${clause} = ${req}.default;`;
      }
      const braced = clause.match(/^\{([\s\S]*)\}$/);
      if (braced === null) {
        throw new Error(`${id}: 不认的 import 形状 —— ${all.trim()}`);
      }
      const parts = braced[1].split(',').map((x) => x.trim()).filter((x) => x.length > 0);
      const binds = [];
      for (const p of parts) {
        const as = p.split(/\s+as\s+/);
        const from = as[0].trim();
        const local = (as[1] ?? as[0]).trim();
        binds.push(from === local ? from : `${from}: ${local}`);
        /* `export {…} from '…'`：进来之后还要出去 */
        if (kw === 'export') { names.add(local); alias.set(local, local); }
      }
      return `${ind}const { ${binds.join(', ')} } = ${req};`;
    },
  );

  /* 2) 只为副作用的 `import '…';`（`mir/opt/index.js` 里那七条 pass） */
  out = out.replace(new RegExp(BARE_SRC, 'g'),
    (all, ind, spec, offset, whole) => (atTopLevel(whole, offset, ind)
      ? `${ind}__req(${JSON.stringify(resolveId(SWAP[id] ?? id, spec))});` : all));

  /* 3) `export function f` / `export class C` / `export const|let|var x` */
  out = out.replace(
    new RegExp(`${AT}([ \\t]*)export\\s+(async\\s+)?(function\\*?|class|const|let|var)\\s+([A-Za-z_$][\\w$]*)`, 'g'),
    (all, ind, asy, kind, nm) => { names.add(nm); alias.set(nm, nm); return `${ind}${asy ?? ''}${kind} ${nm}`; },
  );
  /* `export const {a, b} = …` / `export const [a] = …`（解构那一档） */
  out = out.replace(
    new RegExp(`${AT}([ \\t]*)export\\s+(const|let|var)\\s+(?=[[{])`, 'g'),
    (all, ind, kind) => `${ind}${kind} `,
  );

  /* 4) 光秃秃的 `export { a, b as c };` */
  out = out.replace(new RegExp(`${AT}[ \\t]*export\\s*\\{([^}]*)\\}\\s*;?`, 'g'), (all, body) => {
    for (const p of body.split(',').map((x) => x.trim()).filter((x) => x.length > 0)) {
      const as = p.split(/\s+as\s+/);
      const local = as[0].trim();
      const ex = (as[1] ?? as[0]).trim();
      names.add(local); alias.set(ex, local);
    }
    return '';
  });

  /* 5) `export default <表达式>;` —— 登记成 `default` 那一格（jnc 的六份特性用它）。
     摆在 3)、4) 之后：`export default function f(){}` 这种写法这棵树里没有，真出现了
     下面那道闸会指名道姓地报。 */
  out = out.replace(new RegExp(`${AT}([ \\t]*)export\\s+default\\s+`, 'g'),
    (all, ind) => `${ind}__e.default = `);

  /* 这一格是**闸**，不是装饰：漏掉一条 import/export 的表现是拼出来那份当场 SyntaxError，
     而那时错误指着一个五万行的临时文件。在这儿指名道姓地报，省掉那一趟。
     `import` 那一半是后来补的：子句钉死成三种形状之后，没认出来的那条会**安静地留在
     原地**，而留下的 `import` 在登记表函数体里是硬语法错。
     判"是不是真的一条"用的还是 `atTopLevel` —— `cli/cmds.js` 的帮助文本里印着一句
     教人怎么用这个包的 `import { Build } from 'omni-lang/build';`，那是数据。 */
  const left = new RegExp(`${AT}([ \\t]*)(?:export|import)\\s[^\\n]*`, 'g');
  for (const m of out.matchAll(left)) {
    if (atTopLevel(out, m.index, m[1])) {
      throw new Error(`${id}: 还剩一条没摊平的 import/export —— ${m[0].trim()}`);
    }
  }

  const reg = [...alias.entries()].map(([ex, local]) => `__e.${ex} = ${local};`).join(' ');
  return `${out}\n${reg}\n`;
}

/* ------------------------------------------------------------- UI 那一份 */

/**
 * `studio.js` 拼进去之前要动的**唯一一处**：它 `import` 的那份 `render.js`。
 *
 * 为什么必须动：单体 HTML 是一份 `file://` 的文件，而 `import './render.js'` 在那条路上
 * 是**跨源请求**（`已拦截跨源请求：…（原因：CORS 请求不是 http）`）—— 页面白着开不起来。
 * UI 这一份又不能进上面那张登记表：它跟编译器那一侧是两个 `<script type="module">`
 * （`__req` 在这一格里看不见），而且它得留着 `import` 那条写法给 `omni serve` 用。
 *
 * 于是：`browser-main.js` 把 `render.js` 整个挂在 `window.__OMNI_RENDER` 上，这儿把
 * `import { a, b } from './render.js'` 改成 `const { a, b } = window.__OMNI_RENDER;`。
 * 别的说明符一律红着停 —— UI 再多一条 import 时要在这儿做个决定，而不是半夜白屏。
 */
function uiScript(src) {
  return src.replace(new RegExp(FROM_SRC, 'g'), (all, ind, kw, clause, spec) => {
    if (!spec.endsWith('/render.js')) {
      throw new Error(`studio.js 里多了一条 import：${all.trim()}\n`
        + '  单体那一份不经登记表，要么挂到 window 上（像 render.js 那样），要么别用。');
    }
    const braced = clause.match(/^\{([\s\S]*)\}$/);
    if (braced === null) throw new Error(`studio.js: 不认的 import 形状 —— ${all.trim()}`);
    const binds = braced[1].split(',').map((x) => x.trim()).filter((x) => x.length > 0)
      .map((p) => {
        const as = p.split(/\s+as\s+/);
        return as[1] === undefined ? as[0].trim() : `${as[0].trim()}: ${as[1].trim()}`;
      });
    return `${ind}const { ${binds.join(', ')} } = window.__OMNI_RENDER;`;
  });
}

/* ------------------------------------------------------ 虚拟文件系统那张表 */
/** 白名单：与 `src/core/studio/shared.js` 的 `TREE_ROOTS` 同一套形状（那儿是权威）。
 *
 * 多一棵**语法文件**：`ext/<lang>/*.grammar` 不进目录树（那是给人看例子的），可图那条腿
 * 跑起来第一件事就是读它（`lower/langs.js` 的 `treeRoot()` + `glr/load.js`）。
 * 322 KB，十一门 —— 这是"单体"两个字的成本里说得清的一格。 */
const VFS_ROOTS = [
  { path: 'docs', exts: ['.md'] },
  { path: 'ext', exts: ['.grammar'] },
  /* 扩展的**自述**（`ext/<名字>/omni-ext.json`）：`ext.js` 的 `scanExts` 读它才知道
     "有这么一门语言"。代码由 `lang/builtin-web.js` 静态带进来，这一格是它的那半份数据。 */
  { path: 'ext', exts: ['.json'] },
  /* 自家那几门前端的语法也在源码树里（`frontend-asy/asy.grammar` 88KB 三份合计）——
     `.asy` / `.jnc` / `.glsl` 在页面上跑起来第一件事就是读它。少了这一格，报的是
     "找不到 asy 语法文件（试过 …四条路…）"。
     `.tab` 是 asy 那张**内建绑定表**（`frontend-asy/builtins.tab`）—— 同一类东西：
     不是代码，是前端启动就要读的数据。 */
  { path: 'src/core', exts: ['.grammar', '.tab'] },
  /* asy 的那套库（`asy_builtins.asy` 584KB + settings + gsl + version）：asy 的前端
     一上来就 import 它们。**主语言那几份 `.omni` 库一起带**（turtle / plot / num …
     加起来 68KB）—— `.omni` 的例子现在也是真跑的，不再只是"看得见、编辑得了"。 */
  { path: 'src/lib', exts: ['.asy', '.omni'] },
  /* `.pss` / `.kc` 是 EVAL 那两门（polydraw / evaldraw）—— 它们与上面那几门同一条路
     （`lower/langs.js` 登记、`ext/polydraw/polydraw.grammar` 由上面那格 `.grammar` 带上）。 */
  { path: 'ext', exts: ['.go', '.nim', '.v', '.lua', '.mojo', '.cpp', '.bas', '.awk',
    '.ss', '.lisp', '.asy', '.jnc', '.js', '.sx', '.html', '.omni', '.pss', '.kc'], only: ['examples'] },
  /* tiny 那格扩展的例子在 `ext/tiny/tests/`（它没有 examples 目录）—— 一共两三份，
     整格带上比给"哪些目录算例子"再开一条规矩便宜。 */
  { path: 'ext/tiny', exts: ['.tiny'] },
  /* **图形库那一份**（`ext/js/lib/ege.js`）：它不在 `examples` 底下，而例子第一行就
     `import … from '../lib/ege.js'` —— 少了这一格，页面上那三格 gfx 例子报的是
     "no such module"，而库的代码就在同一份 HTML 里。 */
  { path: 'ext/js/lib', exts: ['.js'] },
  /* **C 那一侧的同一套库**（`ext/jnc/lib/ege.jnc`）：例子第一行就 `import "../lib/ege.jnc"`
     —— 与上面那一格同一笔账（库不在 `examples` 底下）。 */
  { path: 'ext/jnc/lib', exts: ['.jnc'] },
  { path: 'tests', exts: ['.go', '.sx', '.asy', '.wat', '.js', '.jnc', '.frag'],
    only: ['cases', 'draw'] },
];

const extOf = (p) => (p.lastIndexOf('.') < 0 ? '' : p.slice(p.lastIndexOf('.')));

function collectVfs() {
  const files = {};
  const walk = (rel, spec, depth) => {
    if (depth > 6) return;
    const abs = join(ROOT, rel);
    if (!statSync(abs).isDirectory()) {
      if (!spec.exts.includes(extOf(rel))) return;
      if (spec.only !== undefined && !spec.only.some((o) => rel.includes(`/${o}/`))) return;
      files[rel] = readFileSync(abs, 'utf8');
      return;
    }
    for (const nm of readdirSync(abs).sort()) {
      if (nm.startsWith('.')) continue;
      const sub = `${rel}/${nm}`;
      if (spec.only !== undefined && statSync(join(ROOT, sub)).isDirectory()
        && sub.split('/').length === 3 && !spec.only.includes(nm)) continue;
      walk(sub, spec, depth + 1);
    }
  };
  for (const spec of VFS_ROOTS) walk(spec.path, spec, 0);
  return files;
}

/**
 * **把构好的 LR 表一起打包进去**（不然页面上每门语言第一趟都要现构一张）。
 *
 * 为什么值得：构表在 GLSL 那份语法上量到 **559ms**、go 那份 300ms 上下 —— 而它在
 * `glr/load.js` 里是**内容寻址缓存**的：键是 `TABLE_FORMAT|语法正文`，落在
 * `<缓存根>/glr/<键的哈希>/table.txt`。浏览器那条腿的缓存根是内存里那棵 `.omni-cache`
 * （`host/browser.js` 的 ENV），刷新页面就空 —— 于是"换一门语言"在页面上就是一次
 * 半秒到一秒的停顿，而那张表**与源码无关**、打包时就能算好。
 *
 * 做法：在这儿（node 上）把每份语法过一遍 `loadGrammarTable`，它会把表写进本机的
 * 缓存；然后按**同一个哈希目录名**塞进 VFS。两条腿算出来的键逐字节相同（纯函数），
 * 所以页面上那一问直接命中。
 *
 * `.y` / `.ebnf` 那两族不在这儿：它们先要转成 `(grammar …)` 文本，而这条腿上还没有
 * 哪门语言从那儿来。真有了的话这儿会**静静地不命中**（页面照旧现构），不会算错。
 */
async function collectGlrTables(files) {
  const { loadGrammarTable } = await import('../src/core/glr/load.js');
  const grammars = Object.keys(files).filter((p) => p.endsWith('.grammar'));
  let bytes = 0;
  let n = 0;
  for (const g of grammars) {
    let r = null;
    try {
      r = loadGrammarTable(join(ROOT, g));
    } catch {
      continue;                     /* 这份语法自己不成立 —— 那是它那门语言的事，不在这儿报 */
    }
    if (r === null || r === undefined || r.cachePath === undefined) continue;
    const segs = r.cachePath.split('/');
    const key = `.omni-cache/glr/${segs[segs.length - 2]}/table.txt`;
    if (files[key] !== undefined) continue;
    files[key] = readFileSync(r.cachePath, 'utf8');
    bytes += files[key].length;
    n += 1;
  }
  return { n, bytes };
}

/**
 * 文件表写成 JS 字面量。**每个 `<` 都写成 `\u003c`**。
 *
 * 不是洁癖：HTML 的解析器在 `<script>` 里见着 `</script` 就把这一格收掉 —— 而
 * `ext/html/examples/02-canvas.html` 是一份**真的网页**，里头就有一个。那一下的表现是
 * 整份单体 HTML 从文件表那一行起全部当 HTML 读，页面白屏、控制台一句
 * `SyntaxError: Invalid or unexpected token`。踩过一次（2026-09-22 加 html 例子那天）。
 *
 * 为什么只转义文件表、不转义代码：JSON 里的 `<` 全在字符串里，换成 `\u003c` 语义不变；
 * 代码里的 `<` 有比较运算，换了就是语法错。代码那一段改用**闸**来管（见 `main`）。
 */
function vfsText(files) {
  return JSON.stringify(files).replace(/</g, '\\u003c');
}

/* ------------------------------------------------------------------ 拼那一份 */

function main() {
  const oi = process.argv.indexOf('-o');
  const outPath = oi >= 0 ? process.argv[oi + 1] : 'dist/omni-studio.html';

  const { order, text, cycles } = collect(ENTRY);
  if (cycles.length > 0) {
    process.stderr.write(`bundle-studio: ESM 图里有环，这种摊法撑不住：\n  ${cycles.join('\n  ')}\n`);
    process.exit(1);
  }

  const mods = order.map((id) => `__M[${JSON.stringify(id)}] = (__e, __req) => {\n`
    + `${toRegistryBody(id, text.get(id))}};\n`);

  const vfs = collectVfs();
  return { outPath, order, mods, vfs };
}

async function build() {
  const { outPath, order, mods, vfs } = main();
  const tabs = await collectGlrTables(vfs);
  const html = readFileSync(join(ROOT, 'src', 'studio', 'index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src', 'studio', 'studio.css'), 'utf8');
  const ui = uiScript(readFileSync(join(ROOT, 'src', 'studio', 'studio.js'), 'utf8'));

  const loader = [
    'const __M = {};',
    'const __C = {};',
    'function __req(id) {',
    '  if (__C[id] !== undefined) return __C[id];',
    '  const e = {};',
    '  __C[id] = e;',
    '  if (__M[id] === undefined) throw new Error("bundle: 没有这一格模块 " + id);',
    '  __M[id](e, __req);',
    '  return e;',
    '}',
  ].join('\n');

  /* 单体那一份的 UI：把 `api()` 那一层换成"就在本页跑"。`studio.js` 认
     `window.__OMNI_LOCAL` 这一格（见那份文件里 `api` 的头注）。 */
  const bundleJs = [
    loader,
    ...mods,
    `window.__OMNI_VFS = ${vfsText(vfs)};`,
    `__req(${JSON.stringify(ENTRY)});`,
  ].join('\n');

  /* **代码那一段里不许出现 `</script`**：HTML 的解析器见着它就把这一格 script 收了，
     后半截当 HTML 读 —— 页面当场白屏。文件表那一半已经在 `vfsText` 里转义过了
     （`ext/html/examples/02-canvas.html` 里就有一个），这儿只剩代码那一半。 */
  for (const seg of [...mods, ui]) {
    if (seg.includes('</script')) {
      throw new Error('拼进去的代码里有 `</script`（HTML 会在那儿把 script 收掉）：\n'
        + `  …${seg.slice(Math.max(0, seg.indexOf('</script') - 60), seg.indexOf('</script') + 20)}…`);
    }
  }

  /* 两处替换都走**函数**形态的 replacer，不能给字符串：`$'` / `` $` `` / `$&` 在替换串里
     是特殊记号，而拼进去的正是一整个编译器（满地 `$js_*` 与模板串）。
     踩过一次：`$'` 把"匹配之后的全文"又塞了一遍，出来 6.9 MB 而 script 标签还在原处。 */
  const body = html
    .replace(/<link[^>]*studio\.css[^>]*>/, () => `<style>\n${css}\n</style>`)
    .replace(/<script[^>]*studio\.js[^>]*><\/script>/,
      () => `<script type="module">\n${bundleJs}\n</script>\n`
        + `<script type="module">\n${ui}\n</script>`);

  mkdirSync(dirname(join(ROOT, outPath)), { recursive: true });
  writeFileSync(join(ROOT, outPath), body);
  const kb = (body.length / 1024).toFixed(0);
  process.stderr.write(`bundle-studio: ${outPath} —— ${order.length} 份模块、`
    + `${Object.keys(vfs).length} 份文件（含 ${tabs.n} 张构好的 LR 表 `
    + `${(tabs.bytes / 1024).toFixed(0)} KB）、${kb} KB\n`);
}

await build();
