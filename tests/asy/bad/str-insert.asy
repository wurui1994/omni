// insert 用 substr 拼一下就能写出来，但 asy 的越界行为（pos 为负、pos > 长度）还没量全 ——
// 这一刀所有字符串函数的边界都是量出来的，不是猜出来的，所以宁可不收。
write(insert("abc", 1, "X"));
