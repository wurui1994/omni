// `code` 这一层是**桩**：`quote{ … }` 把里头那段块**扔掉**，只留一格空壳
// （types.h 的 primCode / plain_debugger.asy:13 的用法），`_eval(code)` 直接 abort。
// 能过的只有「传来传去」这些：默认实参、变量、参数、返回值、数组元素，
// 以及把 string(string,int,int,code) 交给 atbreakpoint（runsystem.in:132 那个
// callableBp 的签名）。真跑那段块要等 code 能带住 AST，那是另一刀。
void f(code s=quote{}) { write("f"); }
f();
f(quote{ write(9); });

code c = quote{ write(1); };
f(c);

code g(code s) { return s; }
f(g(c));

code[] a = new code[2];
a[0] = c;
write(a.length);

string bp(string file, int line, int col, code s) { return "step"; }
atbreakpoint(bp);
write("done");
