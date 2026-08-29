// 循环三对角解法（runarray.in:1524 的 tridiagonal）。四条分支各一格：零 Dirichlet
// 边界（n==4）、n==1、n==2、以及一般的循环情形（n==4 与 n==5）。
// 这一节要容差的**理由与超越函数不同**：算法是照抄那份 C++ 的（次序与括号都跟着），
// 但真 asy 那个二进制是 arm64 上编出来的，`a - b*c` 会**融合**成一条 fnmsub
// （中间不舍入）。量出来的样子就是第二格（n==4 的循环情形）：asy 印
// -0.0833333333333333，而按 IEEE 双精度一步一舍入是 -0.0833333333333334
// （拿 node 按同一次序单独算过，与这一层出来的一样）。差一个 ulp，所以摆在 tol/。
real[] a={0,1,1,1};
real[] b={2,2,2,2};
real[] c={1,1,1,0};
real[] f={1,2,3,4};
write(tridiagonal(a,b,c,f));
real[] a2={1,1,1,1};
real[] b2={4,4,4,4};
real[] c2={1,1,1,1};
write(tridiagonal(a2,b2,c2,f));
real[] a1={0};
real[] b1={2};
real[] c1={0};
real[] f1={6};
write(tridiagonal(a1,b1,c1,f1));
real[] a3={1,2};
real[] b3={3,4};
real[] c3={5,6};
real[] f3={7,8};
write(tridiagonal(a3,b3,c3,f3));
real[] a5={1,1,1,1,1};
real[] b5={5,5,5,5,5};
real[] c5={2,2,2,2,2};
real[] f5={1,2,3,4,5};
write(tridiagonal(a5,b5,c5,f5));
