// nurb（runpath.in:136 / path.cc:1310）：有理三次 Bézier 采样成 m+1 个结
path g=nurb((0,0),(1,2),(3,2),(4,0),1,0.8,1.2,1,4);
write(length(g));
for(int i=0;i<=length(g);++i) write(point(g,i));
write(postcontrol(g,0));
write(precontrol(g,1));
write(postcontrol(g,2));
// straightness（runpath3d.in:183 / triple.h:398）：离 1/3、2/3 两点的距离平方里大的那个
triple z0=(0,0,0), c0=(1,0,0), c1=(2,0,0), z1=(3,0,0);
write(straightness(z0,c0,c1,z1));
write(straightness(z0,(1,1,0),(2,1,0),z1));
write(straightness((0,0,0),(0.4,0.2,0.1),(1.9,-0.3,0.5),(3,1,2)));
