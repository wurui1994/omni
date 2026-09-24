// Omni stage0 — 路径计算（纯 JS，不进封闭 ABI）
//
// 为什么不进 ABI（ADR-0011 决策 2）：join / dirname / basename / resolve / relative /
// isAbsolute 全是字符串计算。放进 ABI 就多一处"宿主实现和我的实现是否逐字符一致"的
// 分叉点；写在这里，node 直接跑它、降级之后也是同一份代码，两边不可能不一致。
//
// 只做 posix 语义（仓库的目标平台是 macOS / Linux）。唯一碰宿主的地方是 resolve 里的
// "当前目录"，它**问封闭 ABI 的 `cwd()`**（`host/native.js` 那一格，降级之后是
// `js_proc_cwd`）。
//
// 从前这儿直接写 `process.cwd()`。那在 node 上没事、编成产物也没事（那个名字有 ABI
// 对照），可**浏览器那条腿上根本没有 `process`** —— 而它又不能只是"少一格"：
// `module/load.js` 的 `LIB_DIR` 是 `resolve(installDir(), '..', '..', 'lib')` 算出来的，
// 于是页面上 `std/turtle.omni` 被解析成 `/Users/…/src/lib/turtle.omni`（判据那趟拿到的是
// node 的 cwd），而内联的那张表按仓库相对路径存 —— 报的是 `no such module`。
// 问 `cwd()` 之后两条腿各自答自己的（浏览器那格是空串，于是结果就是仓库相对的绝对形）。
import { cwd } from './native.js';

/* Windows 那条腿（第 win-c-backend 刀）：这一份从前明写「只做 posix 语义」，
 * 于是 `C:\x`、`Z:\x`、`\\server\share` 一概不认 —— `isAbsolute` 回 false，
 * `resolve` 把盘符当成普通一段吃掉。做法是**在入口把反斜杠归一成正斜杠**，
 * 再把「根」（盘符或 UNC 的 //server/share）摘下来单独拿着，中间那段仍然走
 * 原来的 posix 计算，最后把根接回去。所以 posix 上一个字符都不变（`root()` 回空串），
 * 而这一份仍然是纯字符串计算 —— 编成产物之后两条腿还是同一份代码。 */

/** 反斜杠归一。没有反斜杠时原样返回（快路：这是热点，见下面 join 那段账）。 */
function norm(p) {
  return p.indexOf("\\") < 0 ? p : p.replace(/\\/g, "/");
}

/**
 * 路径的「根」：盘符 `C:`、或 UNC 的 `//server/share`。都没有就回空串。
 *
 * UNC 的根是**两段**（服务器 + 共享名）—— `//host/share/a` 往上削到 `//host/share` 就停，
 * 再往上没有意义（`//host` 不是一个能进去的目录）。
 */
function root(p) {
  if (p.startsWith("//")) {
    const i = p.indexOf("/", 2);
    if (i < 0) return p;
    const j = p.indexOf("/", i + 1);
    return j < 0 ? p : p.slice(0, j);
  }
  if (p.length >= 2 && p.charCodeAt(1) === 58) {
    const c = p.charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return p.slice(0, 2);
  }
  return "";
}

export function isAbsolute(p) {
  const s = norm(p);
  if (s.startsWith("/")) return true;
  const r = root(s);
  /* `C:/x` 是绝对的，`C:x` 不是（那是「C 盘的当前目录」相对路径，Windows 自己的规矩）。 */
  return r !== "" && s.charCodeAt(r.length) === 47;
}

/** 拆成段，顺手丢掉空段与 "." */
function split(p) {
  return p.split("/").filter((s) => s !== "" && s !== ".");
}

/** 处理 ".."：allowUp 决定开头的 ".." 是留着（相对路径）还是吃掉（绝对路径） */
function normalizeParts(parts, allowUp) {
  const out = [];
  for (const s of parts) {
    if (s !== "..") {
      out.push(s);
    } else if (out.length !== 0 && out[out.length - 1] !== "..") {
      out.pop();
    } else if (allowUp) {
      out.push("..");
    }
  }
  return out;
}

/**
 * 要不要走一遍规整：出现 `.` / `..` **作为一整段**，或者连着两个斜杠。
 * 注意不能只看有没有点 —— `omni.h` 里那个点是名字的一部分，不用收拾。
 */
const NEEDS_NORM = /(^|\/)\.{1,2}(\/|$)|\/\//;

export function join(...parts) {
  const ps = parts.map(norm);
  const r = ps.length === 0 ? "" : root(ps[0]);
  if (r === "") return joinPosix(...ps);
  /* 有根：把根摘掉、中间照 posix 算、再接回去。`C:` + `/a/b` -> `C:/a/b`。 */
  const inner = joinPosix(ps[0].slice(r.length), ...ps.slice(1));
  if (inner === "." || inner === "") return `${r}/`;
  return inner.startsWith("/") ? r + inner : `${r}/${inner}`;
}

function joinPosix(...parts) {
  /* 快路（量出来的）：段都非空、都不用规整时直接接起来。老路一次 join 要走
   * filter -> join -> split -> filter -> normalizeParts -> join 六趟，各带一份新数组；
   * 而 `#include` 的搜索**每试一个目录就 join 一次**，20 份运行时编一遍里
   * `join` + `split` 占了前端 CPU 的 3.4%（65ms/1898ms）。结果与老路逐字符相同。 */
  let fast = parts.length !== 0;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    /* 后面的段自己带头斜杠时也走老路：`join("/", "/", "a")` 老路收成 `/a`，
       直接接会得到 `//a`（量出来的 335 组差异全在这一类上）。 */
    if (s === "" || (i !== 0 && s.startsWith("/")) || NEEDS_NORM.test(s)) { fast = false; break; }
  }
  if (fast) {
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) {
      out += out.endsWith("/") ? parts[i] : `/${parts[i]}`;
    }
    /* 末尾那个斜杠老路是**吃掉**的（`split` 把空段滤了）：`join("a", "b/")` 是 `a/b`。 */
    return out.length > 1 && out.endsWith("/") ? out.slice(0, out.length - 1) : out;
  }
  const kept = parts.filter((s) => s !== "");
  if (kept.length === 0) return ".";
  const abs = kept[0].startsWith("/");
  const segs = normalizeParts(split(kept.join("/")), !abs);
  const joined = segs.join("/");
  if (abs) return `/${joined}`;
  return joined === "" ? "." : joined;
}

export function resolve(...parts) {
  const ps = parts.map(norm);
  let out = "";
  let r = "";
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    if (p === "") continue;
    out = out === "" ? p : `${p}/${out}`;
    if (isAbsolute(p)) {
      r = root(p);
      break;
    }
  }
  /* 一路都不是绝对的：拿当前目录兜底（它自己可能带盘符）。 */
  if (r === "" && !out.startsWith("/")) {
    const c = norm(cwd());
    out = out === "" ? c : `${c}/${out}`;
    r = root(out);
  }
  return `${r}/${normalizeParts(split(out.slice(r.length)), false).join("/")}`;
}

export function dirname(p) {
  const s0 = norm(p);
  if (s0 === "") return ".";
  const r = root(s0);
  let s = s0;
  while (s.length > r.length + 1 && s.endsWith("/")) s = s.slice(0, s.length - 1);
  const i = s.lastIndexOf("/");
  if (i < 0) return r === "" ? "." : r;
  /* 削到根里头就停在根上：`C:/a` -> `C:/`、`//h/s/a` -> `//h/s/`、`/a` -> `/`。 */
  if (i <= r.length) return r === "" ? "/" : `${r}/`;
  return s.slice(0, i);
}

export function basename(p, ext) {
  let s = norm(p);
  const r = root(s);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, s.length - 1);
  if (s === r) return "";
  const i = s.lastIndexOf("/");
  let b = i < 0 ? s : s.slice(i + 1);
  // 宿主的规矩：只要结尾对得上就削掉，削光了就是空串（basename(".js", ".js") === ""）
  if (ext !== undefined && ext !== "" && b.endsWith(ext)) {
    b = b.slice(0, b.length - ext.length);
  }
  return b;
}

export function relative(from, to) {
  const fa = resolve(from);
  const tb = resolve(to);
  /* 不同盘之间没有相对路径可言（node 那边也是直接回目标的绝对形）。 */
  if (root(fa).toLowerCase() !== root(tb).toLowerCase()) return tb;
  const a = split(fa);
  const b = split(tb);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i = i + 1;
  const up = [];
  for (let k = i; k < a.length; k++) up.push("..");
  return [...up, ...b.slice(i)].join("/");
}
