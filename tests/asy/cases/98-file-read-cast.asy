// 第六十四刀：从 file **隐式**读一个词（builtin.cc:494-497 的四条
// `addCast(ve, t, primFile(), read<T>)`）。asy 那边 `string s=stdin;` 就是这么读的。
// 这一层的 file 只有 stdin/stdout、没有真的读，所以体是 abort —— 这个用例钉的是
// "这几句降得下来"，所以只声明、不调用（调了就该响，那不是这一条要钉的东西）。
// 用形参当句柄：`stdin`/`stdout` 是 plain_constants.asy:63 里的量，这一条不必 import plain。

string askstr(file f) { return f; }
int askint(file f) { return f; }
real askreal(file f) { return f; }
pair askpair(file f) { return f; }
triple asktriple(file f) { return f; }
bool askbool(file f) { return f; }
string[] lines(file f) { return f; }
real[] nums(file f) { return f; }
pair[] pts(file f) { return f; }

// 赋值与初值两处也共用这条隐式转换
void use(file f) {
  string s = f;
  s = f;
  int n = f;
  write(s, n);
}

write("ok");
write(1);
