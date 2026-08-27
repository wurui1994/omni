// 有多个重载的名字当值用，而**没有一份**与那个槽同型：asy 也拒 —— 量过 `asy -noV` 报
//   cannot call 'int useOne(int f(int))' with parameter '<overloaded>'
//   use of variable 'both' is ambiguous
// 我们按期望类型挑重载（fit 里那一段）只认**同型**的一份，不给它任何转换余量；
// 给了余量就是"比 asy 多接受一门语言"。这一条不带 ASY_NOPE：不是还没做，是程序本来就不对。
int both(int a, int b) {return a + b;}
real both(real a, real b) {return a * b;}
int useOne(int f(int)) {return f(3);}
write(useOne(both));
