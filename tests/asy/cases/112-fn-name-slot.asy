// asy 的函数声明其实就是"一格函数类型的变量"：声明之后这个名字可以被**重新赋值**
// （plain.asy:71 的 restore 与 :113 的 `return restore=buildRestoreThunk();`）。
void restore()
{
  write("no matching save");
}
typedef void thunk();
thunk build() {
  thunk r = restore;
  return new void() {
    write("undo");
    restore = r;
  };
}
thunk save() {
  return restore = build();
}
restore();
save();
restore();
restore();
// 赋成一个匿名函数，也能读回来当值
void hello() { write("hello"); }
thunk keep = hello;
hello = new void() { write("changed"); };
hello();
keep();
// 一层套一层：连着存两格再依次还原
int depth = 0;
void down() { write("bottom"); }
void push() {
  thunk old = down;
  ++depth;
  down = new void() { write("level " + string(depth)); old(); };
}
push();
push();
down();
