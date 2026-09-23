// Mandelbrot —— **一个像素一个 `putpixel`**，384×288 一共 110592 次。
//
// 这一份就是"图形设备不是一串字"的那格证据：十一万次 putpixel 全落在内存里那块 RGBA 上，
// 跨出程序的只有一帧表面。换成往 stdout 印命令的话，这儿就是十一万行。
import { initgraph, closegraph, putpixel, RGB } from '../lib/ege.js';

const W = 384;
const H = 288;
const MAXIT = 80;

initgraph(W, H);

/** 逃逸次数：`z <- z² + c`，跑满 MAXIT 就当在集合里。 */
function escapes(cr, ci) {
  let zr = 0;
  let zi = 0;
  let i = 0;
  while (i < MAXIT) {
    const r2 = zr * zr;
    const i2 = zi * zi;
    if (r2 + i2 > 4) return i;
    zi = 2 * zr * zi + ci;
    zr = r2 - i2 + cr;
    i = i + 1;
  }
  return MAXIT;
}

for (let y = 0; y < H; y++) {
  const ci = -1.2 + (2.4 * y) / H;
  for (let x = 0; x < W; x++) {
    const cr = -2.1 + (3.0 * x) / W;
    const n = escapes(cr, ci);
    if (n >= MAXIT) continue;                  /* 集合内：底色已经是黑的 */
    const t = n / MAXIT;
    putpixel(x, y, RGB(255 * t * t, 140 * t, 90 * (1 - t) + 40));
  }
}

closegraph();
