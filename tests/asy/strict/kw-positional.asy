// keyword 的槽只能按名字给：量过 asy 报 "cannot call 'void f(int keyword a)' with
// parameter 'int'" 并且**退 1** —— 不是我们没做，是那门语言本来就不收。
void f(int keyword a) { write(a); }
f(3);
