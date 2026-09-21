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
const SWAP = { 'src/core/host/native.js': 'src/core/host/browser.js' };

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
const FROM_SRC = `${AT}([ \\t]*)(import|export)\\s+([^;]*?)\\s+from\\s*['"]([^'"]+)['"]\\s*;?`;
const BARE_SRC = `${AT}([ \\t]*)import\\s*['"]([^'"]+)['"]\\s*;`;

function depsOf(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(FROM_SRC, 'g'))) out.push(m[4]);
  for (const m of text.matchAll(new RegExp(BARE_SRC, 'g'))) out.push(m[2]);
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
 * 五种形状（我们的代码里只有这五种）：
 *   `import { a, b as c } from '…'`   -> `const { a, b: c } = __req('…')`
 *   `import * as ns from '…'`         -> `const ns = __req('…')`
 *   `export { a, b } from '…'`        -> re-export：拿进来再登记出去
 *   `export function f` / `export class C` / `export const x` / `export let x`
 *   `export { a, b as c }`            -> 尾部登记
 *
 * `export default` **不认**（我们的代码里一处都没有，认了反而多一条会分叉的路）。
 * 前两条的正则与扫依赖那一步**共用** `FROM_SRC` / `BARE_SRC`（见上面那段账）。
 */
function toRegistryBody(id, src) {
  const names = new Set();     /* 要登记出去的本地名 -> 导出名（同名居多） */
  const alias = new Map();     /* 导出名 -> 本地名 */
  let out = src;

  /* 1) `import … from '…'` 与 `export … from '…'` */
  out = out.replace(new RegExp(FROM_SRC, 'g'),
    (all, ind, kw, clause, spec) => {
      const to = resolveId(SWAP[id] ?? id, spec);
      const req = `__req(${JSON.stringify(to)})`;
      const star = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (star !== null) return `${ind}const ${star[1]} = ${req};`;
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
    (all, ind, spec) => `${ind}__req(${JSON.stringify(resolveId(SWAP[id] ?? id, spec))});`);

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

  /* 这一格是**闸**，不是装饰：漏掉一条 export 的表现是拼出来那份当场 SyntaxError，
     而那时错误指着一个五万行的临时文件。在这儿指名道姓地报，省掉那一趟。 */
  const left = new RegExp(`${AT}\\s*export\\s[^\\n]*`);
  if (left.test(out)) {
    throw new Error(`${id}: 还剩一条没摊平的 export —— ${out.match(left)[0].trim()}`);
  }

  const reg = [...alias.entries()].map(([ex, local]) => `__e.${ex} = ${local};`).join(' ');
  return `${out}\n${reg}\n`;
}

/* ------------------------------------------------------ 虚拟文件系统那张表 */

/** 白名单：与 `src/core/studio/shared.js` 的 `TREE_ROOTS` 同一套形状（那儿是权威）。
 *
 * 多一棵**语法文件**：`ext/<lang>/*.grammar` 不进目录树（那是给人看例子的），可图那条腿
 * 跑起来第一件事就是读它（`graph/langs.js` 的 `treeRoot()` + `glr/load.js`）。
 * 322 KB，十一门 —— 这是"单体"两个字的成本里说得清的一格。 */
const VFS_ROOTS = [
  { path: 'docs', exts: ['.md'] },
  { path: 'ext', exts: ['.grammar'] },
  { path: 'ext', exts: ['.go', '.nim', '.v', '.lua', '.mojo', '.cpp', '.bas', '.awk',
    '.ss', '.lisp', '.asy', '.jnc', '.js', '.sx'], only: 'examples' },
  { path: 'tests', exts: ['.go', '.sx', '.asy', '.wat', '.js', '.jnc', '.frag'], only: 'cases' },
];

const extOf = (p) => (p.lastIndexOf('.') < 0 ? '' : p.slice(p.lastIndexOf('.')));

function collectVfs() {
  const files = {};
  const walk = (rel, spec, depth) => {
    if (depth > 6) return;
    const abs = join(ROOT, rel);
    if (!statSync(abs).isDirectory()) {
      if (!spec.exts.includes(extOf(rel))) return;
      if (spec.only !== undefined && !rel.includes(`/${spec.only}/`)) return;
      files[rel] = readFileSync(abs, 'utf8');
      return;
    }
    for (const nm of readdirSync(abs).sort()) {
      if (nm.startsWith('.')) continue;
      const sub = `${rel}/${nm}`;
      if (spec.only !== undefined && statSync(join(ROOT, sub)).isDirectory()
        && sub.split('/').length === 3 && nm !== spec.only) continue;
      walk(sub, spec, depth + 1);
    }
  };
  for (const spec of VFS_ROOTS) walk(spec.path, spec, 0);
  return files;
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
  const html = readFileSync(join(ROOT, 'src', 'studio', 'index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src', 'studio', 'studio.css'), 'utf8');
  const ui = readFileSync(join(ROOT, 'src', 'studio', 'studio.js'), 'utf8');

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
    `window.__OMNI_VFS = ${JSON.stringify(vfs)};`,
    `__req(${JSON.stringify(ENTRY)});`,
  ].join('\n');

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
    + `${Object.keys(vfs).length} 份文件、${kb} KB\n`);
}

main();
