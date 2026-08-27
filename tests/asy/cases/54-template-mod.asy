// 模板模块的实例化：`from m(T=…) access X as Y`（第三十一刀）。
// 量过的三条都在这里：同一份实参只跑一遍体、不同实参是**另一个**实例（另一块存储）、
// 两个实例里的 `Box_T` 是**两个**类型。
from mod_tbox(T=int) access Box_T as Box_int, first as first_int, hits as hits_int;
from mod_tbox(T=string) access Box_T as Box_str, first as first_str, hits as hits_str;
// 同一份实参再写一遍：体不再跑，拿到的还是那个实例（下面 hits_int() 是 2 就是证据）
from mod_tbox(T=int) access first as first_int2;

Box_int a = Box_int(7);
Box_str s = Box_str('hi');
write(a.v);
write(a.get());
write(s.get());

write(first_int(1, 2));
write(first_int2(3, 4));
write(first_str('x', 'y'));
write(hits_int());
write(hits_str());
