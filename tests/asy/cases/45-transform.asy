// 仿射变换：asy 的 transform 是 6 个 real（平移 (x,y) + 2x2 的 (xx,xy;yx,yy)）。
// 量出来的理由：`import graph;` 那 188 条诊断里 transform 占 5 条，而 base 里
// scale 用 37 次、shift 36、identity 26、rotate 24、inverse 14、shiftless 8、reflect 2。
// 注意 base 的 plain_constants.asy 写的是 `restricted transform identity;`（不带初值）——
// 靠的是"transform 的零值是恒等"，所以这里的字段默认值就是恒等，identity 那个**变量**
// 由 base 给；这份用例没有 base，所以调的是 identity() 那个函数。
// 每一行的期望都是 `asy -noV` 出来的。
transform t=identity();
write(t.x); write(t.y); write(t.xx); write(t.xy); write(t.yx); write(t.yy);
transform s=shift(3,4);
write(s.x); write(s.y);
transform sc=scale(2);
write(sc.xx); write(sc.yy);
transform r=rotate(90);
write(r.xx); write(r.xy); write(r.yx); write(r.yy);
write(s*(1,1));
write((s*sc)*(1,1));
write(inverse(s)*(4,5));
transform a=shift((3,4)); write(a.x); write(a.y);
transform b=xscale(2); write(b.xx); write(b.yy);
transform c=yscale(3); write(c.xx); write(c.yy);
transform d=scale(2,5); write(d.xx); write(d.yy);
transform e=shift(1,2)*scale(3);
transform f=shiftless(e); write(f.x); write(f.y); write(f.xx); write(f.yy);
transform g=reflect((0,0),(1,1)); write(g.xx); write(g.xy); write(g.yx); write(g.yy);
write(identity()*(7,8));
transform h=rotate(90,(1,1)); write(h*(2,1));
