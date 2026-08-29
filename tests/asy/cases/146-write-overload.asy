// 内建 write 与用户 write 谁赢：实参正好是内建那一族的 T（int/real/string/bool/pair/triple）
// 时，内建那一条一次转换都不用，重载解析里它赢 —— 哪怕用户那条能靠 `operator cast` 接住。
// 量的就是这一格：`write("hi")` 印的是 hi，不是 <hi>。
struct Box { string s; }
Box operator cast(string s) { Box b; b.s = s; return b; }
void write(Box b) { write("<" + b.s + ">"); }

write("hi");                 // 内建赢（用户那条要 string -> Box 一次转换）
write("x = ", 7);            // 前缀那一支也是内建
Box b = "boxed";
write(b);                    // 同型的是用户那条
write((Box) "cast");         // 显式转换之后也是用户那条

// 三个实参就落到内建那条**可变形参**的签名上（builtin.cc:501 的 addRestFunc(writeArray)），
// 而可变形参那条输给同型的普通重载 —— 所以这一句印的是用户那条
void write(string s, int a, int c) { write("three:" + s + string(a) + string(c)); }
write("s", 1, 2);
