#!/usr/bin/env node
// ext/python/rt/build-lxml.js —— **把 lxml 从源码编进来**（`npm run py:lxml`）
//
// 用户定的原则：**越过兼容性是我们的能力，不是被限制**。所以这一份不去"等上游支持
// 我们钉的那一支"，而是自己把路铺平：
//
//   1. **源码准备**：lxml 的 wheel 里带着 `.pyx` / `.pxi` / `includes/*.pxd` 与
//      `etree_defs.h`，但**没打包三份声明表**（顶层 `python.pxd` / `cvarargs.pxd`，
//      与 `includes/tree.pxd` 被裁掉的尾巴）。那三份在 `ext/python/compat/lxml/` 下 ——
//      是我们自己写的，写清了每个名字等于什么。
//   2. **被删掉的 CPython API**：`ext/python/compat/omni_py_compat.h` 里一格一格顶
//      （`PyUnicode_AS_DATA` 那一族在 3.12 删了，`_PyEval_SliceIndex` 在 3.11 删了）。
//   3. **Cython 3.2 的严格性**：`xsltext.pxi` 里两处把 `bytes` 传给 C 变参，新 Cython
//      不收 —— 我们在**工作副本**上改成 `_cstr(message)`（不碰仓库里的第三方源码）。
//   4. **编**：cython 出 30 万行 C，**过我们自己那台 C 前端**（`-DCYTHON_CCOMPLEX=0`
//      与 `-DCYTHON_ATOMICS=0` 两格开关见 SPEC），`clang -shared` 链成按我们 SOABI
//      命名的 `.so`。
//   5. **判据**：同一段 XML 在「我们的产物 + 我们编的 lxml」与「本机 python3 + 它自己的
//      lxml」上跑，**逐字节相同**才算过。
//
// 一格如实记账：**XSLT 那一半要一套匹配的 libxslt**。本机只有 SDK 那份 1.1.34（配
// libxml2 2.9），而 lxml 6.x 要 2.10+ 的 API，只有 brew 那份 2.15 —— 两份 libxml2 在同一
// 进程里必崩（量到 segfault）。brew 没有 libxslt 的 bottle，所以 XSLT 那一格现在跳过、
// 记在账上，不假装绿。
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagsFor, perFileFlags } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const CLI = join(root, 'src', 'cli.js');
const COMPAT = join(root, 'ext', 'python', 'compat');
const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? d : argv[i + 1];
};
const SRC = argOf('--src', process.env.OMNI_CPYTHON
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython'));
const WORK = join(root, '.omni-cache', 'py-rt');
const INC = join(WORK, 'inc-rt');
const OUT = join(WORK, 'lxml');
const A = join(WORK, 'embed', 'libomnipython.a');
const CC = argOf('--cc', process.env.CC ?? 'clang');
const say = (s) => process.stdout.write(`${s}\n`);
const skip = (why) => { say(`py-rt/lxml: ${why} —— 跳过`); process.exit(0); };
/* 0) 前置：参考树、`.a`、cython、本机那份 lxml 的源码（wheel 里带 .pyx）、libxml2 */
if (!existsSync(join(SRC, 'Include', 'Python.h'))) skip(`参考树不在（${SRC}）`);
if (!existsSync(A)) skip('还没打出 libomnipython.a（先 `npm run py:embed -- --runtime`）');
if (spawnSync('python3', ['-m', 'cython', '--version'], { encoding: 'utf8' }).status !== 0) {
  skip('本机没有 cython（要它把 .pyx 变成 C）');
}
const site = (spawnSync('python3', ['-c',
  'import sys;p=[x for x in sys.path if x.endswith("site-packages")];print(p[0] if p else "")'],
{ encoding: 'utf8' }).stdout ?? '').trim();
const LXSRC = site === '' ? '' : join(site, 'lxml');
if (LXSRC === '' || !existsSync(join(LXSRC, 'etree.pyx'))) {
  skip('本机那份 lxml 里没有 .pyx（wheel 一般带着）');
}
/* libxml2 要 2.10+（lxml 6.x 用它那一族新 API）：brew 那份合用，SDK 那份 2.9 不合用。 */
const XML2 = ['/opt/homebrew/opt/libxml2', '/usr/local/opt/libxml2']
  .find((p) => existsSync(join(p, 'include', 'libxml2', 'libxml', 'tree.h')));
if (XML2 === undefined) skip('本机没有 2.10+ 的 libxml2');
const SDK = (spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).stdout ?? '').trim();

/* 1) 源码准备：工作副本 + 三份声明表 + 两处 Cython 3.2 适配 */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'pkg'), { recursive: true });
const PKG = join(OUT, 'pkg', 'lxml');
cpSync(LXSRC, PKG, { recursive: true });
for (const f of ['python.pxd', 'cvarargs.pxd']) cpSync(join(COMPAT, 'lxml', f), join(PKG, f));
/* `includes/tree.pxd` 被裁掉的尾巴：**追加**，不替换（那份里是几百行 libxml2 的声明）。 */
const treePxd = join(PKG, 'includes', 'tree.pxd');
writeFileSync(treePxd, `${readFileSync(treePxd, 'utf8')}\n`
  + readFileSync(join(COMPAT, 'lxml', 'tree-extra.pxd'), 'utf8'));
/* Cython 3.2 不收「把 bytes 传给 C 变参」（`xsltext.pxi` 两处）。上游是按更老的 Cython
   发布的，所以在工作副本上补一层 `_cstr(…)` —— 语义一样（那个宏就是取字节指针）。 */
const xt = join(PKG, 'xsltext.pxi');
writeFileSync(xt, readFileSync(xt, 'utf8').split(
  'xslt.xsltTransformError(c_ctxt, NULL, c_inst_node, "%s", message)').join(
  'xslt.xsltTransformError(c_ctxt, NULL, c_inst_node, "%s", _cstr(message))'));
say(`py-rt/lxml: 源码副本备好（补 3 份声明表、打 2 处 Cython 3.2 适配）`);

/* 2) cython：.pyx -> C */
const cFile = join(OUT, 'etree.c');
const t0 = Date.now();
const cy = spawnSync('python3', ['-m', 'cython', '-3', '--module-name', 'lxml.etree',
  '-I', join(OUT, 'pkg'), '-I', PKG, '-I', join(PKG, 'includes'), '-I', COMPAT,
  '-o', cFile, join(PKG, 'etree.pyx')], { encoding: 'utf8' });
if (cy.status !== 0 || !existsSync(cFile)) {
  say(`py-rt/lxml: cython 没过：\n${(cy.stderr ?? '').split('\n').slice(-8).join('\n')}`);
  process.exit(1);
}
const lines = readFileSync(cFile, 'utf8').split('\n').length;
say(`cython: ${lines} 行 C（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
/* 3) 编：**过我们自己那台 C 前端**（这才是被试者），再 clang -shared 链成 `.so` */
const obj = join(OUT, 'etree.o');
const CYD = ['-DCYTHON_CCOMPLEX=0', '-DCYTHON_ATOMICS=0'];
const t1 = Date.now();
const cc = spawnSync(process.execPath, [CLI,
  ...flagsFor(obj, INC, SRC, [...perFileFlags('Modules/arraymodule.c', SRC), ...CYD,
    '-I', join(PKG, 'includes'), '-I', join(XML2, 'include', 'libxml2'),
    '-I', `${SDK}/usr/include`, '-I', COMPAT,
    '-include', join(COMPAT, 'omni_py_compat.h')]),
  cFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (cc.status !== 0 || !existsSync(obj)) {
  const errs = (cc.stderr ?? '').split('\n').filter((l) => /error:/.test(l)).slice(0, 6);
  say(`py-rt/lxml: 我们编不出那份 C：\n${errs.join('\n')}`);
  process.exit(1);
}
say(`cc: ${lines} 行 C -> ${(statSync(obj).size / 1048576).toFixed(1)}M 的 .o`
  + `（我们自己的 C 前端，${((Date.now() - t1) / 1000).toFixed(1)}s）`);

const PKGOUT = join(OUT, 'out', 'lxml');
mkdirSync(PKGOUT, { recursive: true });
cpSync(PKG, PKGOUT, { recursive: true });
for (const f of ['etree.cpython-314-darwin.so', '_elementpath.cpython-314-darwin.so',
  'builder.cpython-314-darwin.so', 'objectify.cpython-314-darwin.so',
  'sax.cpython-314-darwin.so']) {
  rmSync(join(PKGOUT, f), { force: true });   // 别人编的那些一律不要（ABI 不是一套）
}
const so = join(PKGOUT, 'etree.cpython-316.so');
const ld = spawnSync(CC, ['-shared', '-undefined', 'dynamic_lookup', '-o', so, obj,
  '-L', join(XML2, 'lib'), '-lxml2', '-L', `${SDK}/usr/lib`, '-lxslt', '-lexslt'],
{ encoding: 'utf8' });
if (ld.status !== 0 || !existsSync(so)) {
  say(`py-rt/lxml: 链不起来：\n${(ld.stderr ?? '').split('\n').slice(0, 6).join('\n')}`);
  process.exit(1);
}
say(`ld: ${(statSync(so).size / 1048576).toFixed(1)}M 的 etree.cpython-316.so`);

/* 4) 判据：同一段 XML 两边跑，逐字节比。
      XSLT 那一格**不在这里面** —— 本机没有配 libxml2 2.10+ 的 libxslt（见文件头那段账）。 */
const PY = `import sys
sys.path.insert(0, sys.argv[1])
from lxml import etree

root = etree.fromstring('<a><b x="1">hi</b><b x="2">yo</b></a>')
print("tags", [e.tag for e in root])
print("xpath", root.xpath('//b[@x="2"]/text()'))
print("tostring", etree.tostring(root).decode())
print("attrib", dict(root[0].attrib), root[1].get("x"))
doc = etree.XML("<r><i n='1'/><i n='2'/><i n='3'/></r>")
print("iter", [i.get("n") for i in doc.iter("i")])
print("slice", [e.get("n") for e in doc[1:3]])
print("len", len(doc))
t = etree.ElementTree(doc)
print("findall", [e.get("n") for e in t.findall("//i")])
try:
    etree.fromstring("<a><b></a>")
except etree.XMLSyntaxError as e:
    print("语法错", type(e).__name__)
`;
const p = join(OUT, 'gate.py');
writeFileSync(p, PY);
const BIN = join(WORK, '3rd', 'pyrun');
if (!existsSync(BIN)) skip('还没编出 pyrun（先 `npm run py:3rd`）');
const a = spawnSync(BIN, [join(SRC, 'Lib'), p, join(OUT, 'out')], { encoding: 'utf8', cwd: root });
const b = spawnSync('python3', [p, site], { encoding: 'utf8', cwd: root });
const ao = (a.stdout ?? '').trimEnd();
const bo = (b.stdout ?? '').trimEnd();
say('');
if (a.status !== 0 || ao !== bo) {
  say(`门：**lxml 从源码编进来** —— 没过（exit=${a.status}）`
    + `\n      我们：${JSON.stringify(ao.slice(0, 400))}\n      py  ：${JSON.stringify(bo.slice(0, 400))}`
    + `${(a.stderr ?? '') === '' ? '' : `\n      stderr：${(a.stderr ?? '').split('\n').slice(0, 4).join(' / ')}`}`);
  process.exit(1);
}
say('门：**lxml 从源码编进来** —— 九行与「本机 python3 + 它自己那份 lxml」逐字节相同');
say('账：XSLT 那一半还没量（要一套配 libxml2 2.10+ 的 libxslt，本机只有 SDK 那份 1.1.34）');
