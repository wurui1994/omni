// ext/python/adapter/percent.js —— **老式的 `%` 格式化**（`"%d 个" % n`）
//
// python 这一族照的是 C 的 printf（`printf-style String Formatting` 那一节），而方言里
// 那几格串算子本来就是 C 的那几个转换：`sfix` = `%.*f`、`ssci` = `%.*e`、
// `sgen` = `%.*g`、`sbase` = `%x` / `%o`（小写，要大写裹一层 `supper`）。
// 所以这一份**不自己算数字的文本**，只管：切格式串、挑算子、补宽度。
//
// **格式串必须是编译期的字面量**：转换字母决定发哪一格算子，运行期的串给不了这个。
// python 那边 `fmt % x` 的 fmt 可以是变量 —— 那要一台运行期的格式化机器（就是 CPython 的
// `unicodeobject.c` 里那一大段），这一刀不做，撞上了当场说清。
//
// 收的实参：右边是元组就逐格对上，不是元组就当一格（python 的规矩，`"%s" % x`）。

/** 认得的转换字母。 */
const CONV = new Set(['s', 'r', 'd', 'i', 'f', 'e', 'g', 'x', 'X', 'o', '%']);

/**
 * 切一格格式串 → 若干段：`{ lit }` 或
 * `{ conv, flags: { left, zero, plus }, width, prec }`。
 *
 * 读不动的当场报（不猜）—— `*`（宽度从实参来）、`#`、`%(名字)s` 那一族都在这一档。
 */
export function splitPercent(fmt) {
  const parts = [];
  let lit = '';
  const flush = () => { if (lit !== '') { parts.push({ lit }); lit = ''; } };
  for (let i = 0; i < fmt.length; i += 1) {
    if (fmt[i] !== '%') { lit += fmt[i]; continue; }
    let j = i + 1;
    const flags = { left: false, zero: false, plus: false };
    for (; j < fmt.length; j += 1) {
      if (fmt[j] === '-') { flags.left = true; continue; }
      if (fmt[j] === '0') { flags.zero = true; continue; }
      if (fmt[j] === '+') { flags.plus = true; continue; }
      break;
    }
    let width = null;
    let w = '';
    for (; j < fmt.length && fmt[j] >= '0' && fmt[j] <= '9'; j += 1) w += fmt[j];
    if (w !== '') width = Number(w);
    let prec = null;
    if (fmt[j] === '.') {
      j += 1;
      let p = '';
      for (; j < fmt.length && fmt[j] >= '0' && fmt[j] <= '9'; j += 1) p += fmt[j];
      prec = p === '' ? 0 : Number(p);
    }
    const conv = fmt[j];
    if (conv === undefined || !CONV.has(conv)) {
      throw new Error(`python->IR: \`%\` 格式化里的 \`%${fmt.slice(i + 1, j + 1)}\` 还没接`
        + '（认得的是 %s %r %d %i %f %e %g %x %X %o %%，标志只有 - 0 +，'
        + '宽度与精度要写成数字 —— `*` 那一档没接）');
    }
    if (conv === '%') {
      if (j !== i + 1) throw new Error('python->IR: `%%` 后面不收标志与宽度');
      lit += '%';
      i = j;
      continue;
    }
    flush();
    parts.push({ conv, flags, width, prec });
    i = j;
  }
  flush();
  return parts;
}

/** 这一格格式串里要几个实参。 */
export const percentArity = (parts) => parts.filter((p) => p.lit === undefined).length;
