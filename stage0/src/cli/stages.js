/**
 * 管线是**数据**（ADR-0018 决策五）。
 *
 * 从前 `-v` 是散在实现里的 `vlog(名字, 毫秒)`：每个调用点自己决定印什么，于是「前端 /
 * 中端 / 后端 / 执行」分不出来，中间形态（AST / OIR / MIR / tokens）也不成一串，管线长的
 * 时候（`c -> cpp -> MIR -> x86_64 -> ELF .o -> 链接 -> PE .exe`）尤其看不出走了哪条路。
 *
 * 这一份把管线变成一张**先建好的表**，`--explain` 与 `-v` 是它的两个渲染：
 *
 *   --explain  印出来就停，一个字节都不写盘、不执行
 *   -v         边跑边印同一张表，每行末尾补上这一格花了多少毫秒
 *
 * 两者永不失同步 —— 因为它们不是两段代码，是同一份数据的两种印法。列宽由**整张表**算，
 * 所以表必须在动手之前就齐；这也正是 `--explain` 能做到「不执行也说得准」的原因。
 *
 * 一格：
 *
 *   { phase: 'front' | 'mid' | 'back' | 'exec',
 *     verb:  'read' | 'cpp' | 'parse' | 'check' | 'lower' | 'codegen' | 'emit'
 *            | 'write' | 'link' | 'exec' | …,
 *     in:    '进来的是什么形态（或文件）',
 *     out:   '出去的是什么形态'（没有就省掉，比如 exec）,
 *     note:  '一句为什么/怎么样'（可省）,
 *     artifact: '落在盘上的那个文件'（可省）}
 *
 * `phase` 那一格就是「前端与后端分不清」的解法：它是**标注**，不靠人从名字猜。
 */

/** 一条管线。`summary` 是那行箭头（只印形态，不印文件名与开关）。 */
export function newPlan(cmd, summary) {
  return { cmd, summary, stages: [], widths: null };
}

/** 加一格。回它的下标 —— `-v` 那一路要拿它来标完成。 */
export function addStage(plan, s) {
  plan.stages.push(s);
  plan.widths = null;   // 表变了，列宽要重算
  return plan.stages.length - 1;
}

/**
 * 印出来占几列。汉字与全角标点占**两列**，而 `.length` 只当一个 —— 不算这一格，
 * 带中文的注释会把后面的列顶歪（量到过 `x86_64 + 数据三段` 那一行）。
 *
 * 判据取常用的那几段（CJK 表意、CJK 标点、全角形式、谚文），够这儿用。
 */
function cols(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f)
      || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

function widthsOf(plan) {
  if (plan.widths !== null) return plan.widths;
  let ph = 5;
  let vb = 4;
  let ino = 2;
  let ou = 2;
  for (const s of plan.stages) {
    if (cols(s.phase) > ph) ph = cols(s.phase);
    if (cols(s.verb) > vb) vb = cols(s.verb);
    if (cols(s.in ?? '') > ino) ino = cols(s.in ?? '');
    if (cols(s.out ?? '') > ou) ou = cols(s.out ?? '');
  }
  plan.widths = { ph, vb, ino, ou };
  return plan.widths;
}

/* 名字要与 `interp/libc.js` 里那个 `padTo` 分开 —— 自举那条链把 import 树链成一份
 * 程序，模块作用域的名字必须全局唯一。 */
function padCol(s, n) {
  let out = s;
  while (cols(out) < n) out += ' ';
  return out;
}

/**
 * 一格印成一行。`ms` 给了就在末尾补 `+Nms`（`-v` 那一路）。
 *
 * 列是 `# phase verb in -> out note/artifact`。`->` 只在真的有 `out` 时印 ——`exec` 那一格
 * 没有产物形态，硬印一个箭头就是在骗人。
 */
export function renderStage(plan, i, ms) {
  const w = widthsOf(plan);
  const s = plan.stages[i];
  const no = `${i + 1}`;
  const arrow = s.out === undefined ? '   ' : '-> ';
  const tail = [s.note, s.artifact].filter((x) => x !== undefined).join('  ');
  let line = `  ${padCol(no, 3)}${padCol(s.phase, w.ph + 2)}${padCol(s.verb, w.vb + 2)}`
    + `${padCol(s.in ?? '', w.ino + 2)}${arrow}${padCol(s.out ?? '', w.ou + 2)}${tail}`;
  line = line.replace(/\s+$/, '');
  return ms === undefined ? line : `${line}${line.length > 0 ? '  ' : ''}+${ms}ms`;
}

/** `--explain`：摘要行 + 编号清单。长管线靠编号列表读，不靠一行长箭头。 */
export function renderPlan(plan) {
  const out = [`pipeline  ${plan.summary}`];
  for (let i = 0; i < plan.stages.length; i++) out.push(renderStage(plan, i));
  return `${out.join('\n')}\n`;
}

/** 摘要那行（`-v` 开头也印它，好知道后面这串行属于哪条管线）。 */
export function renderSummary(plan) {
  return `pipeline  ${plan.summary}\n`;
}
