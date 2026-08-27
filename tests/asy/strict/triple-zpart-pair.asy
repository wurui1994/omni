// asy 自己就不收：`zpart` 只有 triple 那一个重载（量过 `zpart((1,2))` 报
// "cannot call 'real zpart(triple v)' with parameter 'pair'"）。
write(zpart((1,2)));
