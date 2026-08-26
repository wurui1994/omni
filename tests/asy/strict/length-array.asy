// length 只有 string 和 pair 两个重载 —— asy 自己就报
// "no matching function 'length(int[])'"。数组的长度写 a.length。
int[] a = {1,2,3};
write(length(a));
