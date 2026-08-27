// 记录套记录还不收，与 pair/数组字段同一条理由。
struct A { int x; }
struct B { A a; }
B b = new B;
write(b.a.x);
