// `operator ecast` 只给 `(T) x` 用：隐式位置不收它（量过 asy 报
// "cannot cast 'int' to 'U'"）。不带 ASY_NOPE。
struct U {
  int n;
}

U operator ecast(int x) {
  U u = new U;
  u.n = x;
  return u;
}

U b = 5;
