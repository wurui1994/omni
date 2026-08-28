// 第五十五刀：frame 上那一批画图内建（runpicture.in）加几个零碎的。
// fill(frame, path[], pen) 是真做的；shading/clip/tex/… 是"签名抄准、体是 abort"。
frame f;
path[] ps = {(0,0)--(1,0)--(1,1)--cycle, (2,2)--(3,2)--(3,3)--cycle};
fill(f, ps);
write(min(f));
write(max(f));

// 字号（runtime.in:590/596）：默认那一格是 12pt 换成 bp 的那个数。
write(fontsize(currentpen));
write(fontsize(fontsize(9)));

// shift(transform)：只留平移，线性部分清零（runtime.in:1169）。
transform s = shift(shift(3,4)*scale(2));
write(s);
write(shift(3,4)*scale(2));

// interp / minbound / maxbound（builtin.cc 里那批模板）
write(interp((0,0), (2,4), 0.25));
pair[] a = {(1,5), (3,2)};
write(minbound(a));
write(maxbound(a));
