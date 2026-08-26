// asy 自己就不收后缀 ++/--（量过：`asy -noV` 说 "postfix expressions are not allowed"），
// 变量和下标都一样。语法认得它（camp.y 里有那条产生式），语义层拒。
// 我们照着拒 —— 收下来不会让任何用例输出不同，只会让"等价"这两个字变虚。
int b = 1;
b++;
write(b);
