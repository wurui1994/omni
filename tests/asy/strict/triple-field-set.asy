// asy 自己就不收：triple 的分量也是**只读**的虚字段（量过 `t.x = 5` 报
// "virtual field is read-only"，与 pair 那条同一句话）。
triple t=(1,2,3);
t.x = 5;
write(t);
