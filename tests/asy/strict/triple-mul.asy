// asy 自己就不收：triple 上没有 `triple * triple`（量过报
// "no matching function 'operator *(triple, triple)'"）—— 逐分量乘要写 realmult。
// `*` 在 triple 上只有 real 那一个重载。
write((1,2,3)*(4,5,6));
