// ext/polydraw/units.js —— **EVAL 两门切成两格单元产物**（`.pss` / `.kc`）
//
// 为什么要切：一份脚本编出来的核心方言里，`gl_*` / `g3_*` / `gfx_*` 那一层
// （GL 的状态机与光栅器在语言这一侧）**每份脚本一字不差**。量过 `02-gl.pss`：129 项里
// 127 项是它，脚本自己只有 `fn eval$frame` 与 `main` 两项。整份重发一遍是纯浪费
// （`docs/design/omni-serve-studio.md` §9.3）。
//
// 怎么切（零件全在公共层，这一份只是接线）：
//   1. `coreSxText(path, argv, out)` —— 跑**一趟**降级，顺手拿回 `out.rtNames`（那张名单）；
//   2. `sxForms(text)` 切成顶层项、`sxDoStmts` 把 `(main (do …))` 拆成语句；
//   3. 名字在名单里的归 `ev_rt`、其余归入口，拼成 `sections` 交给 `asyUnitModules`。
//
// `ev_rt` 的**名字按内容算**（`ev_rt_<哈希>`）：于是换个脚本它一定命中盘上那一份，
// 而我们改了 `gl-rt.js` 它就自动变成另一份 —— 与 `UnitIndex` 那套"内容定址"同一条纪律。

import { coreSxText } from '../../src/core/lower/drive.js';
import { sxForms, sxDoStmts } from '../../src/core/build/modules.js';
import { asyUnitModules } from '../../src/core/frontend-asy/link.js';
import { hash16 } from '../../src/core/host/hash.js';

/** 空的一格 `secs`（四格都是"顶层项正文"的数组，见 `link.js` 那个循环）。 */
const emptySec = () => ({ cls: [], glb: [], fns: [], wraps: [] });

/** 一项该进 `secs` 的哪一格。 */
function putForm(sec, form) {
  if (form.head === 'class' || form.head === 'struct') sec.cls.push(form.text);
  else if (form.head === 'global') sec.glb.push(form.text);
  else sec.fns.push(form.text);
}

/** 入口那份产物的名字：脚本的基名（去掉目录与后缀）+ 路径哈希（同名不同路不撞）。 */
function entryName(path) {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  return `${base.replace(/[^A-Za-z0-9_]/g, '_')}_${hash16(path).slice(0, 6)}`;
}

/**
 * 回 `{units, reused}`（与 `cap('asy.unitTexts')` 同一个形状）——
 * 驱动那一格（`cli.js` 的按单元产物那条路）拿它去比印记、只编该编的那几份。
 */
export function evalUnitTexts(path, argv = []) {
  const out = {};
  const text = coreSxText(path, argv, out);
  if (text === null || text === undefined) return null;
  const rt = new Set(Array.isArray(out.rtNames) ? out.rtNames : []);
  const app = emptySec();
  const lib = emptySec();
  let main = [];
  for (const f of sxForms(text)) {
    if (f.head === 'main') { main = sxDoStmts(f.text); continue; }
    putForm(rt.has(f.name) ? lib : app, f);
  }
  /* 运行时那一层一项都没有（纯算术的 `.pss`）：一格单元都不必切。 */
  const libItems = [...lib.cls, ...lib.glb, ...lib.fns];
  if (libItems.length === 0) {
    const secs = new Map([[0, app]]);
    return asyUnitModules({
      ids: [0], secs, keys: new Map([[0, { file: path }]]), weak: [], main,
    }, () => entryName(path));
  }
  const rtName = `ev_rt_${hash16(libItems.join('\n')).slice(0, 8)}`;
  const keys = new Map([[0, { file: path }], [1, { file: `<${rtName}>` }]]);
  const nameOf = (k) => (k.file === `<${rtName}>` ? rtName : entryName(path));
  return asyUnitModules({
    ids: [0, 1], secs: new Map([[0, app], [1, lib]]), keys, weak: [], main,
  }, nameOf);
}
