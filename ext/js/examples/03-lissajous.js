// 函数图像：三条 Lissajous 曲线 + 一格坐标轴。
//
// 曲线是一串 `line` 接起来的（`polyline`）—— 与 BGI 那边一样，图元落在设备上，
// 不是往外印一串坐标。
import {
  initgraph, closegraph, setbkcolor, cleardevice, setcolor, setlinewidth,
  line, polyline, RGB,
} from '../lib/ege.js';

const W = 480;
const H = 320;
initgraph(W, H);
setbkcolor(RGB(250, 250, 252));
cleardevice();

/* 坐标轴 */
setcolor(RGB(200, 204, 212));
setlinewidth(1);
line(0, H / 2, W - 1, H / 2);
line(W / 2, 0, W / 2, H - 1);

/** 一条 Lissajous：x = sin(a t + p)、y = sin(b t)，取 n 个点连成折线。 */
function lissajous(a, b, p, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push(W / 2 + 0.46 * W * Math.sin(a * t + p));
    pts.push(H / 2 + 0.46 * H * Math.sin(b * t));
  }
  return pts;
}

setcolor(RGB(220, 60, 60));
setlinewidth(2);
polyline(lissajous(3, 2, 0, 480));

setcolor(RGB(40, 120, 220));
polyline(lissajous(5, 4, Math.PI / 4, 600));

setcolor(RGB(30, 160, 110));
polyline(lissajous(7, 6, Math.PI / 2, 720));

closegraph();
