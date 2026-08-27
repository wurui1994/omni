// asy 自己就不收：pair 到 triple 没有转换（量过 `triple t=(1,2);` 报
// "cannot cast 'pair' to 'triple'"）。反过来也没有。
triple t=(1,2);
write(t);
