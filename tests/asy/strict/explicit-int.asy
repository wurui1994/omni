// `explicit real` 连内建的 int->real 提升都挡（量过 asy 报
// "cannot call 'void p(explicit real r)' with parameter 'int'"）——
// 不带 ASY_NOPE：不是我们还没做，是这个程序本来就不对。
void p(explicit real r) { write(r); }
p(3);
