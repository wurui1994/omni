// 第六十三刀：字符串与数之间的四对显式转换（builtin.cc:365-372）。
// string -> 数走 castop.h:48 castString<T>（lexical.h:14：整串都要是一个数，前后空白除外）；
// 数 -> string 走 castop.h:39 stringCast<T>（precision(DBL_DIG)，与 write 同一份格式）。

// (real) string
write((real) "3.5");
write((real) "  3.5  ");
write((real) "+3.5");
write((real) ".5");
write((real) "5.");
write((real) "1e10");
write((real) "1e-10");
write((real) "0.333333333333333");
write((real) "-0.125");

// (int) string
write((int) "42");
write((int) "007");
write((int) "+7");
write((int) "-13");

// 数 -> string：15 位有效数字，pair/triple 是 `(x,y)` / `(x,y,z)`
write((string) 42);
write((string) 3.5);
write((string)(1/3));
write((string) 1e20);
write((string)((1/3,2/7)));
write((string)((1,2,3)));

// pair / triple <- string：括号可选，分量之间是逗号或空白（无括号时 pair 可以只给 x）
write((pair) "1");
write((pair) "1,2");
write((pair) "(1,2)");
write((pair) "(1 2)");
write((pair) "( 1 , 2 )");
write((triple) "1,2,3");
write((triple) "(1,2,3)");
write((triple) "(1 2 3)");

// 一圈回来还是原来那个数
real x = 1/7;
write((real)((string) x) == x);
pair z = (1/3, 2/7);
write((pair)((string) z) == z);
