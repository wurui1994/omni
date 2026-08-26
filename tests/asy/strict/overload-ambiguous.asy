// asy 自己就不收：p(real) 与 p(pair) 各要一次隐式转换（int->real / int->pair），
// 谁也不比谁同型 —— 量过 asy 报 "call of function 'p(int)' is ambiguous"。
string p(real x) { return "p-real"; }
string p(pair z) { return "p-pair"; }
write(p(1));
