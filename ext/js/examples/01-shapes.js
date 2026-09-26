// BGI/EasyX 的第一课：开设备、换笔、画几个形状、把这一帧交出去。
//
//   omni run ext/js/examples/01-shapes.js
//   -> #gfx png .omni-cache/gfx/01-shapes.png 480 320
//
// stdout 上只有那一行**指针**；图在那份表面文件里（480*320*4 字节的 RGBA）。
// Studio 见着这一行就把表面贴到 canvas 上；本机那侧贴进 glfw 窗口。
import {
  initgraph, closegraph, setbkcolor, cleardevice, setcolor, setfillcolor, setlinewidth,
  line, rectangle, bar, circle, fillcircle, fillellipse, polyline, fillpoly,
  RGB, RED, YELLOW, CYAN, LIGHTGRAY,
} from '../lib/ege.js';

initgraph(480, 320);
setbkcolor(RGB(16, 24, 32));
cleardevice();

// 地平线
setcolor(RGB(60, 72, 88));
setlinewidth(1);
for (let y = 40; y < 320; y = y + 40) line(0, y, 479, y);

// 一栋楼：填充矩形 + 描边
setfillcolor(RGB(38, 52, 70));
bar(40, 160, 120, 140);
setcolor(LIGHTGRAY);
rectangle(40, 160, 120, 140);

// 窗户
setfillcolor(YELLOW);
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 3; c++) bar(54 + c * 36, 176 + r * 40, 20, 24);
}

// 太阳：填充圆 + 两圈光环
setfillcolor(RGB(255, 190, 60));
fillcircle(380, 80, 34);
setcolor(RGB(255, 220, 130));
circle(380, 80, 44);
circle(380, 80, 54);

// 一朵云：三个填充椭圆
setfillcolor(RGB(200, 210, 225));
fillellipse(180, 70, 40, 16);
fillellipse(215, 62, 28, 12);
fillellipse(150, 64, 24, 10);

// 屋顶：折线（描边）+ 山墙（填充多边形）
setfillcolor(RGB(120, 40, 40));
fillpoly([30, 160, 100, 110, 170, 160]);
setcolor(RED);
setlinewidth(3);
polyline([30, 160, 100, 110, 170, 160]);

// 一条路：两段线收到消失点
setcolor(CYAN);
setlinewidth(2);
line(200, 319, 300, 200);
line(440, 319, 320, 200);

closegraph();
