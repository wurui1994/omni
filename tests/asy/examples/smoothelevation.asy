import graph3;
import grid3;
import palette;

currentlight=Viewport;

if(settings.render <= 0) settings.prc=false;

currentprojection=orthographic(dir(40,60));

size(400,300,IgnoreAspect);

real f(pair z) {return cos(2*pi*z.x)*sin(2*pi*z.y);}

// OMNI 改过：原例是 `…,20,Spline`，即 20×20 的样条网格（400 块补片，每块再切 Bezier）。
// 真 asy 自己在这台机器上就要 >5s（串行量到 5041ms），所以缩到 6×6：图的形状与配色不变、
// 只是网格粗一点，而两侧跑的是**同一份**源码，逐记号对照照样成立。
surface s=surface(f,(-1/2,-1/2),(1/2,1/2),6,Spline);
s.colors(palette(s.map(zpart),Rainbow()));

draw(s,render(tessellate=false));

scale(true);

xaxis3(Label("$x$",0.5),Bounds,InTicks);
yaxis3(Label("$y$",0.5),Bounds,InTicks);
zaxis3(Label("$z$",0.5),Bounds,InTicks(beginlabel=false));

grid3(XYZgrid);
