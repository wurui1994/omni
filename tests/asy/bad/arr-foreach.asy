// for-each 没做：它要一个隐藏的下标变量与每轮的绑定，跟 C 式 for 不是同一条降级。
int[] a = {1,2,3};
for (int x : a) write(x);
