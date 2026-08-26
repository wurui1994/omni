// 字符串与 write 的分隔规则：asy 的 write 在参数之间放**制表符**，
// 但第一个参数是字符串时它当前缀用（量过：write("x = ", 7) 是 "x = 7"）。
string s = "ab";
string t = s + "cd";
write(t);
write("x = ", 7);
write("a", "b");
write(1, 2, 3);
write(s + t);
write("");
write("tab\there");
write("quote\"inside");
write("back\\slash");
bool p = true, q = false;
write(p);
write(q);
write(p && q);
write(p || q);
write("p = ", p);
write("n=", 1, 2);
string u = "";
u += "x";
u += "y";
write(u);
write(s == "ab");
write(s != "ab");
write(s < "b");
