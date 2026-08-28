int f(int a=1, int b=2 ... int[] xs) { int s = a*100 + b*10; for (int x : xs) s += x; return s; }
write(f());
write(f(7));
write(f(7,8));
write(f(7,8,9));
write(f(... new int[] {5,6}));
write(f(7, ... new int[] {5,6}));
write(f(b=3, ... new int[] {5,6}));
int g(int a=1, string s="z" ... int[] xs) { int t = a; for (int x : xs) t += x; return t; }
write(g(9));
write(g(9, 8));
write(g("q", 8));
int tot(int k = 2 ... int[] xs) { int s = k; for (int x : xs) s += x; return s; }
write(tot(... new int[] {1,2,3}));
