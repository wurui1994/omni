// 内建那一族的名字当**函数值**用：`abs` 现在是内建面里真的四格函数（int/real/pair/triple），
// 所以 `m(abs, zs)` 拿得到 `(fnref …)`。examples/cheese.asy:11、pOrbital.asy:25 与
// sphericalharmonic.asy:13 的 `s.map(abs)` 靠这条（那里要的是 `real(triple)`）。
real f(pair z) { return abs(z); }

real[] m(real g(pair), pair[] zs) {
  real[] r=new real[zs.length];
  for(int i=0; i < zs.length; ++i) r[i]=g(zs[i]);
  return r;
}

pair[] zs={(3,4),(0,-2)};
write(m(abs,zs)[0]);
write(m(abs,zs)[1]);
write(m(f,zs)[0]);
write(abs(-3));
write(abs(-3.5));
write(abs((1,2,3)));
