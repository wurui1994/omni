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

export function isAbsolute(p) {
  return p.startsWith("/");
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
  let out = "";
  let abs = false;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p === "") continue;
    out = out === "" ? p : `${p}/${out}`;
    if (p.startsWith("/")) {
      abs = true;
      break;
    }
  }
  if (!abs) out = out === "" ? cwd() : `${cwd()}/${out}`;
  return `/${normalizeParts(split(out), false).join("/")}`;
}

export function dirname(p) {
  if (p === "") return ".";
  let s = p;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, s.length - 1);
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return s.slice(0, i);
}

export function basename(p, ext) {
  let s = p;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, s.length - 1);
  const i = s.lastIndexOf("/");
  let b = i < 0 ? s : s.slice(i + 1);
  // 宿主的规矩：只要结尾对得上就削掉，削光了就是空串（basename(".js", ".js") === ""）
  if (ext !== undefined && ext !== "" && b.endsWith(ext)) {
    b = b.slice(0, b.length - ext.length);
  }
  return b;
}

export function relative(from, to) {
  const a = split(resolve(from));
  const b = split(resolve(to));
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i = i + 1;
  const up = [];
  for (let k = i; k < a.length; k++) up.push("..");
  return [...up, ...b.slice(i)].join("/");
}
