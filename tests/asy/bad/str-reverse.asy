// reverse 是按字节倒的，而 Omni 的 string 是 UTF-8 字节序列（ADR-0005）——
// 非 ASCII 倒出来是一串坏字节，C 那条腿原样吐、JS 那条腿要看宿主怎么处理，
// "六条腿逐字节相同"就保不住了。没量准的东西不收。
write(reverse("abc"));
