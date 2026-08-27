// `explicit` 形参（第二十六刀）：这个槽只收类型一模一样的实参。量过的五条都在这里 ——
//   - `explicit real` 收 3.0；
//   - 算符与数组形参上一样管用；
//   - **不进签名身份**：同签名的第二份是**替换**，所以下面 two 走 explicit 那份、
//     而反序的 three 走后写的 plain 那份（于是 int 也进得去）；
//   - 一支 explicit 一支不 explicit 时，explicit 那支直接不匹配，另一支赢，不算歧义。
// asy 自己拒的那条（`explicit real` 喂 int，连内建提升都挡）在 strict/explicit-int。
void one(explicit real r) { write(r); }
one(3.0);

struct V { int n; }
bool operator ==(explicit V a, V b) { return a.n == b.n; }
V a; V b;
write(a == b);

void arr(explicit int[] xs) { write(xs.length); }
int[] q = {1, 2, 3};
arr(q);

void two(real r) { write("plain"); }
void two(explicit real r) { write("explicit"); }
two(3.0);

void three(explicit real r) { write("explicit3"); }
void three(real r) { write("plain3"); }
three(3);

void four(explicit string s) { write("string"); }
void four(real r) { write("real4"); }
four(3);
