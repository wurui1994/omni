// 继承：任意 extends / super 调用 / instanceof 链 / toString 的 tag
class Shape {
  constructor(name) { this.name = name; }
  describe() { return "shape:" + this.name; }
  get area() { return 0; }
}
class Square extends Shape {
  constructor(side) { super("square"); this.side = side; }
  describe() { return "sq(" + super.describe() + ")"; }
  get area() { return this.side * this.side; }
}
const s = new Square(3);
console.log(s.describe(), s.area, s.name, s.side);
console.log(s instanceof Square, s instanceof Shape, s instanceof Object);
console.log(Object.getPrototypeOf(Square.prototype) === Shape.prototype);
class Tagged { get [Symbol.toStringTag]() { return "Tagged"; } }
console.log(Object.prototype.toString.call(new Tagged()));
console.log(Object.prototype.toString.call({}), Object.prototype.toString.call([]));
