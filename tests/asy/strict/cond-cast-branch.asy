// `? :` 的类型是在**两支之间**定案的，不看外面要什么：pair 与 guide 之间有
// `path operator cast(pair)`，于是整条式子是 guide —— 再往 pair 上收就不行了。
// 量过 asy 报 "cannot cast 'guide' to 'pair'"（1.31）。
pair z = false ? (0,0) : (1,1)--(2,2);
write(z);
