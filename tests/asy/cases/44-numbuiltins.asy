// asy 在 C++ 里带的一批非绘图内建（写在 stage0/lib/asy/asy_builtins.asy 里）。
// 量出来的理由：`import graph;` 那 193 条诊断里「缺的内建函数」占 33 条，这几个是
// 现在就写得起的（不需要方言加东西）。每一行的期望都是 `asy -noV` 出来的。
write(pi);
write(sgn(-3.5)); write(sgn(0.0)); write(sgn(2.1));
write(degrees(pi)); write(degrees(-pi/2)); write(radians(180));

// pair 那一版归一化到 [0,360)，real 那一版不归一化
write(degrees((0,1))); write(degrees((-1,0))); write(degrees((0,-1)));
write(degrees((-1,-1))); write(degrees((1,-1)));
// 命名实参（graph.asy 里就是 `degrees(dir,warn=false)` 这么调的）
write(degrees((1,1),warn=false));

// copy 是深拷：改副本不动原数组
int[] a = {5,1,9};
int[] b = copy(a);
b[0]=99; write(a[0]); write(b[0]);
bool[] bs={true,false}; write(copy(bs).length);

// search：最后一个 <= key 的下标，key 比首元素还小给 -1
real[] s = {1,3,5,7,9};
write(search(s,5.0)); write(search(s,6.0)); write(search(s,0.0)); write(search(s,100.0));

// sequence(n)=0..n-1，sequence(a,b)=a..b（两头都要，a>b 是空数组）
write(sequence(4)); write(sequence(1,5)); write(sequence(3,3)); write(sequence(4,2).length);
