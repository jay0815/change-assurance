const { add, subtract, multiply, divide } = require("./calculator");

// Weak test: calls function but doesn't assert critical behavior
test("add function", () => {
  add(1, 2);
  // No assertion!
});

test("subtract function", () => {
  subtract(5, 3);
  // No assertion!
});

test("multiply function", () => {
  multiply(2, 3);
  // No assertion!
});

test("divide function", () => {
  divide(10, 2);
  // No assertion!
});
