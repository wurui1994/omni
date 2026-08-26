// 数组：第一刀不收。asy 的数组是引用语义 + 切片 + 一大堆内建（map/sort/concat…），
// 而核心方言这一层连容器都还没有。
int[] a = new int[3];
a[0] = 1;
write(a[0]);
