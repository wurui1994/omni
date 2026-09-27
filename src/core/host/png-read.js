// src/core/host/png-read.js —— **一份 PNG 解成 RGBA**（设备那一侧的图像解码器）
//
// 为什么要这一份：`pic("cloud.png",…)` / `glsettex("wood.png")` 这一族在**宿主设备**
// 那一档（CPU 帧缓冲，也就是默认那一档）先前压根没有解码器 —— `picsiz` 要 GL 插件的
// ImageIO（`--gfx gl` 才有）。后果不是"图贴不上"这么轻：`demos/lab3d.kc` 是拿
// `while (pic("doubcube.png",ix,iy) != 16777215)` 走光线的，`pic` 回 0 ⇒ **死循环**，
// 扫描把它记成"超时"。语料里 11 份 `.kc` 直接用 `pic`，还有一摊用文件纹理。
//
// ## 支持到哪儿（按**语料里真有的**那几种，不多做）
//
//   位深 1 / 2 / 4 / 8，颜色类型 0（灰）/ 2（RGB）/ 3（调色板）/ 4（灰+A）/ 6（RGBA），
//   过滤器 0..4（None/Sub/Up/Average/Paeth），**非隔行**。
//   语料里那七份 PNG 覆盖了 0@2、0@8、2@8、3@4、3@8 五种组合（我们自己写出来的是 6@8）。
//   16 位与隔行（Adam7）**当场报**——不许静默解出一张花屏。
//
// ## 与 C 那一侧的关系
//
// `src/runtime/omni_fmt.c` 里另有一份**同算法**的（`png_decode`/`inf_*`）——
// 两台宿主各自一份，与 KV6 那一族同一个安排（见 `host/kv6.js` 的头注）。
// 算法逐句对应是为了"三条腿逐字节相同"：DEFLATE 与过滤器都是定死的算术，
// 同一份输入必须给同一份字节。

/** 大端 32 位。 */
const be32 = (b, i) => (((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);

/**
 * `n` 格 0 的一格**普通数组**（码表那几张小表用它）。
 *
 * 为什么不用 `Int32Array`：**这一份要过我们自己那台 JS 前端**（`gfx-cpu.js` 静态 import
 * 它 ⇒ 它在 `src/cli.js` 那棵树里，`check:self` 与 `build:native` 都编它），而封闭 ABI 里
 * 只有 `ArrayBuffer` / `Uint8Array` / `DataView` 这一族，没有 `Int32Array`
 * （症状是 `check:self` 报七条 `unresolved identifier 'Int32Array'`，而 node 那条腿全绿）。
 * 这几张表最大 288 格、里头是小整数 —— 普通数组算出来的字节与从前**逐格相同**。
 */
const zeros = (n) => {
  const a = [];
  for (let i = 0; i < n; i++) a.push(0);
  return a;
};

/**
 * **DEFLATE（RFC 1951）**：`{ out, n }` —— `out` 是解出来的字节。
 *
 * 三种块都认：stored（BTYPE=0）、固定码表（1）、动态码表（2）。
 * 码表用"按长度数个数 + 按符号排序"那一手（RFC 1951 第 3.2.2 节的规范霍夫曼），
 * 解码走**逐位走表**的朴素路子（一格符号最多 15 位）—— 图都是几十 KB，
 * 不值得铺一张快查表，而朴素那一份与 C 那侧好逐句对齐。
 */
function inflate(src, from, cap) {
  const out = new Uint8Array(cap);
  let no = 0;
  let bp = from * 8;                     /* 位位置（从字节 `from` 起） */
  const bit = () => {
    const b = (src[bp >> 3] >> (bp & 7)) & 1;
    bp += 1;
    return b;
  };
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v |= bit() << i;
    return v;
  };
  /* 一张码表：`{ cnt, sym }` —— cnt[l] 是长度 l 的符号个数、sym 是按长度/符号排好的表。 */
  const build = (lens, n) => {
    const cnt = zeros(16);
    for (let i = 0; i < n; i++) cnt[lens[i]] += 1;
    cnt[0] = 0;
    const off = zeros(16);
    for (let l = 1; l < 16; l++) off[l] = off[l - 1] + cnt[l - 1];
    const sym = zeros(n);
    for (let i = 0; i < n; i++) if (lens[i] !== 0) { sym[off[lens[i]]] = i; off[lens[i]] += 1; }
    return { cnt, sym };
  };
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let l = 1; l < 16; l++) {
      code |= bit();
      const count = h.cnt[l];
      if (code - first < count) return h.sym[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('png: deflate 码字坏了');
  };
  /* 长度/距离那两张表（RFC 1951 第 3.2.5 节，照抄不自己编）。 */
  const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
    67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
    5, 5, 5, 5, 0];
  const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13];
  let fixL = null;
  let fixD = null;
  for (;;) {
    const last = bit();
    const type = bits(2);
    if (type === 0) {
      bp = (bp + 7) & ~7;                /* 对齐到字节 */
      const p = bp >> 3;
      const len = src[p] | (src[p + 1] << 8);
      for (let i = 0; i < len; i++) out[no + i] = src[p + 4 + i];
      no += len;
      bp = (p + 4 + len) * 8;
    } else {
      let hl = null;
      let hd = null;
      if (type === 1) {
        if (fixL === null) {
          const ll = zeros(288);
          for (let i = 0; i < 288; i++) ll[i] = i < 144 ? 8 : (i < 256 ? 9 : (i < 280 ? 7 : 8));
          const dl = zeros(30);
          for (let i = 0; i < 30; i++) dl[i] = 5;
          fixL = build(ll, 288);
          fixD = build(dl, 30);
        }
        hl = fixL;
        hd = fixD;
      } else if (type === 2) {
        const nlen = bits(5) + 257;
        const ndist = bits(5) + 1;
        const ncode = bits(4) + 4;
        const ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const cl = zeros(19);
        for (let i = 0; i < ncode; i++) cl[ORD[i]] = bits(3);
        const hc = build(cl, 19);
        const lens = zeros(nlen + ndist);
        let i = 0;
        while (i < nlen + ndist) {
          const s = decode(hc);
          if (s < 16) { lens[i] = s; i += 1; continue; }
          let rep = 0;
          let v = 0;
          if (s === 16) { v = lens[i - 1]; rep = 3 + bits(2); } else if (s === 17) { rep = 3 + bits(3); } else { rep = 11 + bits(7); }
          for (let k = 0; k < rep; k++) { lens[i] = v; i += 1; }
        }
        /* `slice` 而不是 `subarray`（那是类型化数组的方法）—— `build` 只按下标读，
           所以"另一格数组"与"同一块内存上的视图"在这儿是同一件事。 */
        hl = build(lens.slice(0, nlen), nlen);
        hd = build(lens.slice(nlen), ndist);
      } else throw new Error('png: deflate 块类型 3');
      for (;;) {
        const s = decode(hl);
        if (s < 256) { out[no] = s; no += 1; continue; }
        if (s === 256) break;
        const li = s - 257;
        const len = LB[li] + bits(LE[li]);
        const di = decode(hd);
        const dist = DB[di] + bits(DE[di]);
        for (let k = 0; k < len; k++) { out[no] = out[no - dist]; no += 1; }
      }
    }
    if (last !== 0) break;
  }
  return { out, n: no };
}

/** Paeth 预测（RFC 2083 第 6.6 节，照抄）。 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * **一份 PNG -> `{ w, h, px }`**（`px` 是 `w*h*4` 字节的 RGBA），解不开就回 `null`。
 *
 * 只认非隔行、位深 1/2/4/8。16 位与 Adam7 **当场报**（消息里说清是哪一格）——
 * 静默解出一张花屏比解不开更贵。
 */
export function decodePng(bytes) {
  const b = bytes;
  if (b.length < 8 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  let w = 0;
  let h = 0;
  let depth = 8;
  let color = 6;
  let pal = null;
  let trns = null;
  const idat = [];
  let i = 8;
  while (i + 8 <= b.length) {
    const n = be32(b, i);
    const ty = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const at = i + 8;
    if (ty === 'IHDR') {
      w = be32(b, at);
      h = be32(b, at + 4);
      depth = b[at + 8];
      color = b[at + 9];
      if (b[at + 12] !== 0) throw new Error('png: 隔行（Adam7）这一版不认');
      if (depth === 16) throw new Error('png: 16 位这一版不认');
      if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8) {
        throw new Error(`png: 位深 ${depth} 不认`);
      }
    } else if (ty === 'PLTE') {
      pal = b.subarray(at, at + n);
    } else if (ty === 'tRNS') {
      trns = b.subarray(at, at + n);
    } else if (ty === 'IDAT') {
      idat.push(b.subarray(at, at + n));
    } else if (ty === 'IEND') break;
    i = at + n + 4;
  }
  if (w === 0 || h === 0 || idat.length === 0) return null;
  /* 几段 IDAT 先拼成一条 zlib 流（头两字节是 zlib 的，DEFLATE 从第 2 字节起）。 */
  let zn = 0;
  for (const s of idat) zn += s.length;
  const z = new Uint8Array(zn);
  let zo = 0;
  for (const s of idat) { z.set(s, zo); zo += s.length; }
  return unfilter(z, w, h, depth, color, pal, trns);
}

/** 每像素几格样本（颜色类型 -> 通道数，RFC 2083 第 4.1.1 节）。 */
const CHANS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解压 + 去过滤 + 摊成 RGBA。过滤器是**按字节**做的（步长 = 每像素字节数，
 * 位深 < 8 时步长按 1 算，RFC 2083 第 6.3 节原话）。
 */
function unfilter(z, w, h, depth, color, pal, trns) {
  const ch = CHANS[color];
  if (ch === undefined) throw new Error(`png: 颜色类型 ${color} 不认`);
  const bpl = Math.ceil((w * ch * depth) / 8);            /* 一行的字节数（不含过滤器那格） */
  const bpp = Math.max(1, Math.trunc((ch * depth) / 8));  /* 过滤器的步长 */
  const raw = inflate(z, 2, h * (bpl + 1) + 64).out;
  const lines = new Uint8Array(h * bpl);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (bpl + 1)];
    const src = y * (bpl + 1) + 1;
    const dst = y * bpl;
    const up = dst - bpl;
    for (let x = 0; x < bpl; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? lines[dst + x - bpp] : 0;
      const bb = y > 0 ? lines[up + x] : 0;
      const c = (y > 0 && x >= bpp) ? lines[up + x - bpp] : 0;
      let o = v;
      if (ft === 1) o = v + a;
      else if (ft === 2) o = v + bb;
      else if (ft === 3) o = v + ((a + bb) >> 1);
      else if (ft === 4) o = v + paeth(a, bb, c);
      else if (ft !== 0) throw new Error(`png: 第 ${y} 行的过滤器是 ${ft}`);
      lines[dst + x] = o & 255;
    }
  }
  /* 取第 x 个样本（位深 < 8 时从高位往低位数，RFC 2083 第 7.2 节）。 */
  const samp = (row, k) => {
    if (depth === 8) return lines[row + k];
    const per = 8 / depth;
    const byte = lines[row + Math.trunc(k / per)];
    const shift = 8 - depth * ((k % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  /* 灰度要按位深拉到 0..255（1 位是 0/255、2 位是 0/85/170/255 …）。 */
  const grayMax = (1 << depth) - 1;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * bpl;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 255;
      if (color === 0 || color === 4) {
        const v = samp(row, x * ch);
        r = depth === 8 ? v : Math.round((v * 255) / grayMax);
        g = r;
        bl = r;
        if (color === 4) al = samp(row, x * ch + 1);
      } else if (color === 2 || color === 6) {
        r = samp(row, x * ch);
        g = samp(row, x * ch + 1);
        bl = samp(row, x * ch + 2);
        if (color === 6) al = samp(row, x * ch + 3);
      } else {
        const idx = samp(row, x);
        if (pal === null) throw new Error('png: 调色板那一档没有 PLTE');
        r = pal[idx * 3] ?? 0;
        g = pal[idx * 3 + 1] ?? 0;
        bl = pal[idx * 3 + 2] ?? 0;
        if (trns !== null && idx < trns.length) al = trns[idx];
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = bl;
      px[o + 3] = al;
    }
  }
  return { w, h, px };
}
