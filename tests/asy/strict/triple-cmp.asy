// asy 自己就不收：triple 上没有大小比较（量过报
// "no matching function 'operator <(triple, triple)'"）。`==`/`!=` 才是内建的。
write((1,2,3)<(2,3,4));
