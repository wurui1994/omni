// 文件级变量（asy 前端第二十四刀）。核心方言这一刀加了 `(global 名字 类型)`，
// 于是函数里读得到、改得到它 —— 之前只能当 `(main …)` 的局部量，函数里一律报错。
// 每条都量过（asy -noV）：
//   - 函数里读写文件级变量就是那一份存储（`bump()` 与 `peek()` 看到的是同一个）；
//   - 名字解析是**顺序**的：函数体只看得见**前面**声明的那些（引用后面的，
//     asy 报 "no matching variable of name 'g'" —— strict/global-fwd 钉着）；
//   - 局部量与形参**遮蔽**同名的文件级变量，被遮的那份一动不动；
//   - 同一个名字可以在文件里声明多次，那是两个变量（后面那句起用后面那份）；
//   - 一句里多个声明项，后面的能引用前面的（`int a = 1, b = a + 10;`）；
//   - 没写初值就是零（int 0 / real 0 / bool false / string 空串）；
//   - 初值在**它那一行**求，不是提前求（`int t = tick();` 与下面 write 的顺序看得出来）。
int counter = 7;
string label;
real ratio;
bool on;

int bump(int k) { counter += k; return counter; }
int peek() { return counter; }
void rename(string s) { label += s; }
int shadow(int counter) { return counter * 2; }

write(counter);
write(label == "");
write(ratio);
write(on);

write(bump(5));
write(bump(3));
write(peek());
counter = 100;
write(peek());
++counter;
write(counter);

rename("ab");
rename("cd");
write(label);

ratio = 1/8;
write(ratio);
on = (counter == 101);
write(on);

// 遮蔽：形参那份，全局那份没动
write(shadow(50));
write(peek());

// 遮蔽：块里的局部量
{ int counter = 1; write(counter); }
write(peek());

// for 的循环变量也是局部的
for (int counter = 0; counter < 2; ++counter) write(counter);
write(peek());

// 初值在这一行求：先印 1，再印 2
int tick() { counter += 1000; return counter; }
int t1 = tick();
write(t1);
write(peek());

// 同名再声明一次：那是另一个变量
int t1 = -5;
write(t1);
