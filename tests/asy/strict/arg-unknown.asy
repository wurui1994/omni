// asy 自己就不收：形参叫 a，实参按 'b' 这个名字给 —— 没有能匹配的签名。
void f(int a) { write(a); }
f(b=1);
