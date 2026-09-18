// TextDecoder（ADR-0011 的字节缓冲那一族）。要紧的不是"能解 utf-8"，是**坏字节的
// 替换口径**与宿主逐个码元相同：拿"一个坏字节一个 U+FFFD"的老路顶替，会在截断 /
// 过长 / 代理项三处静静地少一个或多两个 FFFD。JSON.stringify 之后再比 —— 落单的
// 代理项与 FFFD 在管道上看不出区别，转义了才看得出是哪一个码元。
const d = new TextDecoder();
const B = (bs) => JSON.stringify(d.decode(new Uint8Array(bs)));
console.log(typeof d, d.decode(new Uint8Array([65, 90])), JSON.stringify(d.decode()));
console.log(d.decode(new Uint8Array([228, 184, 173])), d.decode(new Uint8Array([240, 159, 152, 128])));
// BOM：没给 ignoreBOM 时去掉**开头那一个**（两个只去一个，中间那个照旧是 U+FEFF）
console.log(B([239, 187, 191, 65]), B([239, 187, 191, 239, 187, 191]), B([65, 239, 187, 191, 65]));
// 坏字节那几类：截断、落单的续字节、非法头、过长、代理项、超出 U+10FFFF、重新对齐
console.log(B([228, 184]), B([194]), B([128, 65]), B([255, 65]));
console.log(B([192, 128]), B([224, 128, 128]), B([237, 160, 128]), B([244, 144, 128, 128]));
console.log(B([228, 65, 66]), B([244, 143, 191, 191]));
// 标签：utf-8 那一族按大小写不敏感认，两头的 ASCII 空白先去掉
console.log(new TextDecoder("UTF-8").decode(new Uint8Array([228, 184, 173])),
  new TextDecoder(" utf8 ").decode(new Uint8Array([65])));
console.log("end");
