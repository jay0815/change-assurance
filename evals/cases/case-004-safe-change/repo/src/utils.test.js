const { formatName, isPositive } = require("./utils");

test("formatName combines first and last name", () => {
  expect(formatName("John", "Doe")).toBe("John Doe");
});

test("formatName trims whitespace", () => {
  expect(formatName("  John  ", "  Doe  ")).toBe("John Doe");
});

test("isPositive returns true for positive numbers", () => {
  expect(isPositive(5)).toBe(true);
});

test("isPositive returns false for negative numbers", () => {
  expect(isPositive(-5)).toBe(false);
});

test("isPositive returns false for zero", () => {
  expect(isPositive(0)).toBe(false);
});
