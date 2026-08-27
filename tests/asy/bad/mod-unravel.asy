// `unravel m;`：把模块的名字摊进当前作用域。量过 asy 对模块 unravel 报
// "qualifier is not a record" —— 但 `from m unravel x;` 是另一回事，都还没做。
unravel mod_dupa;
write(1);
