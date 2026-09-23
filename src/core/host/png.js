// src/core/host/png.js —— **一帧 RGBA 写成 PNG**（默认出口；`.rgba` 裸表面只是备选）
//
// 为什么默认是 PNG：图是给人看的与给工具比的 —— 双击就能开、`magick`/`compare` 直接吃。
// 裸表面（`#rgba <w> <h>\n` + 裸字节）留着当备选：它没有编码那一层，所以"逐字节相同"
// 那条判据在它上头最直接；两个出口按**落点的后缀**选（`.rgba` 走裸的、别的走 PNG）。
//
// ## 这一档 PNG 有多窄（明写）
//
// 8 位 RGBA、filter 0（每行前头一个 0 字节）、zlib **stored**（deflate 的未压缩块）。
// **不引 zlib**：stored 的那点格式（两字节头 + 每块五字节 + adler32）自己写比接一个库短，
// 而且**逐字节确定** —— 压缩器的版本一变字节就变，那会把"三条腿逐字节相同"那条判据毁掉。
// 代价是文件大（320×240 RGBA ≈ 308 KB）。要小就外面再过一遍 `optipng`。
//
// 与 `src/jit/png.c` 那一份是**同一套字节**（那份是宿主工具链里的，这份是编译器自己这条腿；
// 两个构建单元不公用头，所以各有一份 —— 算法就那五十行，分叉的风险比耦合低）。
//
// ## 字节怎么传
//
// 一律是**一字符一字节的串**（latin1）：封闭 ABI 的 `writeBinary` 收的就是这个形状，
// 而 `String.fromCharCode` 是我们那套 JS 子集里现成的。

/** CRC-32（PNG 那个反射多项式 0xEDB88320）。表按需生成一次。 */
let CRC_TAB = null;
function crcTab() {
  if (CRC_TAB !== null) return CRC_TAB;
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t.push(c >>> 0);
  }
  CRC_TAB = t;
  return t;
}

function crc32(s) {
  const t = crcTab();
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    c = (t[(c ^ s.charCodeAt(i)) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** adler32（zlib 流尾巴那四个字节）。 */
function adler32(s) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    a = (a + s.charCodeAt(i)) % 65521;
    b = (b + a) % 65521;
  }
  return (b * 65536 + a) >>> 0;
}

/** 大端四字节。 */
function be32(v) {
  const n = v >>> 0;
  return String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

/** 一格 chunk：长度 + 类型 + 数据 + CRC（CRC 算的是"类型 + 数据"）。 */
function chunk(ty, data) {
  return be32(data.length) + ty + data + be32(crc32(ty + data));
}

/** zlib 的 **stored** 流：两字节头 + 若干未压缩块（每块 5 字节头）+ adler32。 */
function zlibStored(raw) {
  const out = ['\u0078\u0001'];
  const MAX = 65535;
  let i = 0;
  while (i < raw.length) {
    const n = Math.min(MAX, raw.length - i);
    const last = i + n >= raw.length ? 1 : 0;
    out.push(String.fromCharCode(last, n & 255, (n >>> 8) & 255,
      (~n) & 255, ((~n) >>> 8) & 255));
    out.push(raw.slice(i, i + n));
    i += n;
  }
  out.push(be32(adler32(raw)));
  return out.join('');
}

/**
 * 一帧 RGBA（一字符一字节、第 0 行在**上**）-> 一份 PNG 的字节。
 *
 * `rgba` 的长度必须正好 `w*h*4` —— 对不上就当场报（比写出一份坏图好查）。
 */
export function pngFromRgba(rgba, w, h) {
  if (rgba.length !== w * h * 4) {
    throw new Error(`png: 字节数不对：${rgba.length} != ${w}*${h}*4`);
  }
  const ihdr = be32(w) + be32(h) + String.fromCharCode(8, 6, 0, 0, 0);
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push('\u0000');
    rows.push(rgba.slice(y * w * 4, (y + 1) * w * 4));
  }
  return '\u0089PNG\u000d\u000a\u001a\u000a'
    + chunk('IHDR', ihdr)
    + chunk('IDAT', zlibStored(rows.join('')))
    + chunk('IEND', '');
}

/** 这一格落点该写哪种（`.rgba` 是备选、别的都按 PNG）。 */
export function surfaceKind(path) {
  return path.endsWith('.rgba') ? 'rgba' : 'png';
}
