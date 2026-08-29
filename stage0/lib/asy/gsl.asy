// gsl 模块（这一层只做用到的那一格：Bessel J）。
//
// asy 那边 `gsl` 不是 .asy 文件，是 gsl.cc 注册进来的一个内建模块。它整册有几十个特殊
// 函数，这里**只**给 `J` —— 220 个例子里只有 AiryDisk.asy:2 用它，要的就是 `J(1,r)`。
// 别的（Y、I、K、Ai、Bi、椭圆积分、ζ…）没给：给不出来不如不给，用到时会当场说"没有 J 之外的"。
//
// 精度这一节要说清，因为这是它当初被搁下的理由：
//   - 宿主数学库的**交集**里没有 Bessel（libm 有 j0/j1/jn，V8 没有），所以它进不了
//     `(rmath …)` 那张白名单，只能在 asy 这一层自己算。
//   - 直接拿 double 写升幂级数不够：级数是交替的，x=10 时最大项与结果之比约 2800、
//     x=21.3 时约 1e8 —— 量过，相对差 x=10 是 3e-13、x=21.3 是 8e-9。补偿求和（Kahan）
//     救不回来，因为误差出在**逐项相乘**里，不在求和里。
//   - 这里改成**双-双**（double-double，Dekker 拆分，只要 + - *，不要 FMA）：项与和都带
//     一截低位，等效 ~32 位十进制。量过（拿 `asy -noV` 的 gsl `J(1,x)` 当参考，
//     x 取 0.25…21.2133 二十八个点）：相对差最坏 3.7e-15 @ x=7 —— 那一点 J1 过零附近，
//     参考值本身只印到 15 位，所以这个数已经是"印不出差别"的量级。
// GSL 自己走的是 Chebyshev 拟合表加分段渐近；这里不搬那套表，双-双够到这一段就停。
//
// 阶只做**整数**（含负整数，J_{-n} = (-1)^n J_n）。非整数阶要 Γ(k+ν+1) 那条路，
// 那是另一件事（量过 asy 给 `J(0.5,2)` = 0.513016136561827），这里不猜，当场 abort。
// x ≤ 0 asy 报 "domain error"（量过 `J(1,0.0)` 与 `J(1,-3.0)` 都是），这一层没有那一格
// 错误类型，所以 abort，话说明白。

// 双-双用 pair 装：x 是高位、y 是低位（用 pair 而不是 real[]，省掉每一步一次数组分配；
// 注意**不能**用 pair 自己的 + 与 *，那是复数运算 —— 下面全是显式的函数）。
private real asy__ddsplit=134217729;  // 2^27 + 1

private pair asy__twoSum(real a, real b) {
  real s=a+b;
  real bb=s-a;
  return (s, (a-(s-bb))+(b-bb));
}
private pair asy__qSum(real a, real b) {
  real s=a+b;
  return (s, b-(s-a));
}
private pair asy__twoProd(real a, real b) {
  real p=a*b;
  real t=asy__ddsplit*a;
  real ah=t-(t-a); real al=a-ah;
  real u=asy__ddsplit*b;
  real bh=u-(u-b); real bl=b-bh;
  return (p, ((ah*bh-p)+ah*bl+al*bh)+al*bl);
}
private pair asy__ddAdd(pair x, pair y) {
  pair a=asy__twoSum(x.x,y.x);
  pair b=asy__twoSum(x.y,y.y);
  pair c=asy__qSum(a.x, a.y+b.x);
  return asy__qSum(c.x, c.y+b.y);
}
private pair asy__ddMul(pair x, pair y) {
  pair p=asy__twoProd(x.x,y.x);
  return asy__qSum(p.x, p.y+(x.x*y.y+x.y*y.x));
}
private pair asy__ddDiv(pair x, real b) {
  real q1=x.x/b;
  pair p=asy__twoProd(q1,b);
  pair s=asy__twoSum(x.x,-p.x);
  return asy__qSum(q1, (s.x+(s.y-p.y)+x.y)/b);
}

// J_n(x) = (x/2)^n * Σ_k (-1)^k (x²/4)^k / (k! (k+n)!)，n ≥ 0、x > 0。
private real asy__besselJn(int n, real x) {
  pair h=asy__ddDiv((x,0), 2);          // x/2
  pair z=asy__ddMul(h,h);               // x²/4
  pair t=(1,0);
  for(int k=1; k <= n; ++k) t=asy__ddDiv(t,k);   // 1/n!
  pair sum=t;
  // 收敛判据用高位：项一旦小到和的 1e-40 就停（双-双大约 32 位十进制，再往下没意义）。
  // 上界 400 是兜底 —— x ≤ 1e3 时项在 k ≈ x/2 之后就掉得比阶乘快。
  for(int k=1; k < 400; ++k) {
    t=asy__ddMul(t,z);
    t=asy__ddDiv(t,-k*(k+n));
    sum=asy__ddAdd(sum,t);
    if(abs(t.x) < 1e-40*abs(sum.x)) break;
  }
  pair p=(1,0);
  for(int k=0; k < n; ++k) p=asy__ddMul(p,h);
  return asy__ddMul(sum,p).x;
}

real J(real nu, real x)
{
  if(x <= 0) abort("J: domain error（x 要大于 0；asy 那边这一格报 \"domain error\"）");
  int n=round(nu);
  if(nu != n)
    abort("J: 这一层只算整数阶（给的是 "+string(nu)+"）—— 非整数阶要 Γ(k+ν+1) 那条路，没做");
  if(n < 0) return (n % 2 == 0 ? 1 : -1)*asy__besselJn(-n, x);
  return asy__besselJn(n, x);
}
