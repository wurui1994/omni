// 算符重载**盖住内建算符**（asy 前端第二十三刀的另一半）。这一条是量出来的，而且反直觉：
// asy 把内建算符与用户算符放在**同一张候选表**里打分，所以
//   int operator *(int a, int b) { return a + b; }
// 之后 `3 * 4` 印的是 **7**，不是 12。这不是"多接受一门语言"那种漏洞 —— 漏了这一问会
// 算出**不同的答案**，所以 opUser 是对所有操作数类型都问一遍的，不是只问 struct。
// 同型优先仍然管着：只写了 `real operator +(real,real)` 时 `2 + 3` 走的还是内建的
// int 加法（内建那份同型，用户那份要两次转换）。
int operator *(int a, int b) { return a + b; }
write(3 * 4);
write(2 * 2 * 2);

real operator +(real a, real b) { return a - b; }
write(2 + 3);
write(2.5 + 1.5);
write(2 + 1.5);

string operator ^(string s, int k) { return s + s; }
write("ab" ^ 3);

bool operator !(int n) { return n > 0; }
write(!0);
write(!5);

int operator -(int n) { return n + 100; }
write(-7);
write(0 - 7);

// 用户算符跟普通重载一样是**顺序解析**的：这一句在下面那份 `operator #` 之前，
// 走的还是内建的整数商
write(7 # 2);
int operator #(int a, int b) { return a * b; }
write(7 # 2);
