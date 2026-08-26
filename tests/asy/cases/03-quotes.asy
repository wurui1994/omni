// 两种引号，两套转义规则（量过，od -c）：双引号是 verbatim，只认 \" ；
// 单引号走 C 转义。asy 这么定是为了把串直接塞进 TeX。
write("a\tb");
write("a\\b");
write("a\"b");
write("a\nb");
write('a\tb');
write('a\\b');
write('a\'b');
write('a' + "b");
string tex = "\begin{align}";
write(tex);
