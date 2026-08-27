// 有多个重载的名字**当值用**，靠期望类型定案（第三十五刀）。
//
// 实参位置那一条早就通了（cases/42-fntype 的 useI/useR，走 overArg / fit）。这一刀把
// 同一条路子铺到别的位置：nameOf 回一个**不定案的记号**，coerce 拿目标类型落地。
// 这个文件是从 bad/overload-value-init 提上来的 —— 期望值都是 `asy -noV` 量的。

int both(int a, int b) {return a + b;}
real both(real a, real b) {return a * b;}

// 变量的初值：左边写着类型，那就是定案的依据
real g(real,real) = both;
write(g(2,5));
int h(int,int) = both;
write(h(2,5));

// typedef 拼出来的同一件事
typedef int IF(int,int);
IF k = both;
write(k(2,5));

// return 的位置：函数的返回类型就是期望类型（返回类型自己是函数类型时 asy 的语法要
// 一个 typedef —— `real(real,real) pickr()` 那样写 asy 自己报 syntax error，量过）
typedef real RF(real,real);
RF pickr() {return both;}
RF gr = pickr();
write(gr(2,5));
IF picki() {return both;}
IF gi = picki();
write(gi(2,5));

// 实参位置（老路，一起量着）
int apply(int f(int,int), int a, int b) {return f(a,b);}
write(apply(both, 3, 4));

// 挑出来的那一份就是那一份：改一个重载的实现，另一个不受影响
int pick(int a, int b) {return a - b;}
real pick(real a, real b) {return a + b;}
int pi(int,int) = pick;
real pr(real,real) = pick;
write(pi(9,4));
write(pr(9,4));
