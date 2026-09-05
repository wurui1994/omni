// mintimes / maxtimes 是**精确**的：真 asy 在 path::bounds()（path.cc:472）里解导数的
// 零点，顺手把取到极值的时刻记进 times 那一份 bbox。原先这一层是"每段 32 个样点取最好的
// 那个"，而 solids.asy:17 的 tangent() 拿 mintimes(p)[1] 当迭代支点 ——
// hyperboloidsilhouette 的首处坐标于是从参考的 -3.77470652 变成 -3.77948357（相对 1.3e-3）。
// 这一格逐位比：值直接与 `asy -noV` 印出来的 17 位字面量比 ==，不比"差多少"。
path p1=(0,0)..(1,2)..(3,-1)..(4,1);
write(mintimes(p1)[0] == 0.31545224619221141);
write(mintimes(p1)[1] == 2.0889196412141553);
write(maxtimes(p1)[0] == 2.6845477538077889);
write(maxtimes(p1)[1] == 0.91108035878584448);
// 直段只看结点（straight(i) 那一支 continue）
path p2=(0,0)--(1,1)--(2,0)--cycle;
write(mintimes(p2)[0] == 3);
write(mintimes(p2)[1] == 3);
write(maxtimes(p2)[0] == 2);
write(maxtimes(p2)[1] == 1);
// 圆那两组**故意不放在这一格**：`unitcircle` 在 plain_paths 里，而这一轴只跑内建那一层。
// 另外那条 `(0,0)..(1,1)..(2,0)..cycle` 也不放 —— 量过：时刻 0.061691064009237212
// 对我们的 …191，差在**闭合 guide 解出来的控制点**最后一两位上，不是这一格的事。
// 单段、控制点在外面：根落在段内
path p3=(0,0)..controls (1,4) and (3,-4)..(4,0);
write(mintimes(p3)[0] == 0);
write(mintimes(p3)[1] == 0.78867513459481287);
write(maxtimes(p3)[0] == 1);
write(maxtimes(p3)[1] == 0.21132486540518711);
// 多段
path p5=(1,1)..(2,3)..(5,0)..(7,4)..(9,-2);
write(mintimes(p5)[0] == 0.29195888644286261);
write(mintimes(p5)[1] == 3.9286954572959463);
write(maxtimes(p5)[0] == 3.6107480240343675);
write(maxtimes(p5)[1] == 3.1916296026524558);
