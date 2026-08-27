// struct 体里的 `using` 严格按书写顺序：写在字段后面的别名，那个字段看不见它。
// 量过真 asy 报 "no type of name 'later'"（它自己也拒），所以我们这条也是 err 不是 nope。
struct Box {
  later h;
  using later=int;
}
