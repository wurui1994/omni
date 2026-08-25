// Omni stage0 — 路径计算（纯 JS，不进封闭 ABI）
//
// 为什么不进 ABI（ADR-0011 决策 2）：join / dirname / basename / resolve / relative /
// isAbsolute 全是字符串计算。放进 ABI 就多一处"宿主实现和我的实现是否逐字符一致"的
// 分叉点；写在这里，node 直接跑它、降级之后也是同一份代码，两边不可能不一致。
//
// 只做 posix 语义（仓库的目标平台是 macOS / Linux）。唯一碰宿主的地方是 resolve 里的
// process.cwd()，那个在封闭 ABI 里是 js_proc_cwd。

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

export function join(...parts) {
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
  if (!abs) out = out === "" ? process.cwd() : `${process.cwd()}/${out}`;
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
