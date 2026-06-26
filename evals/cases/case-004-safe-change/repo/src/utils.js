function formatName(first, last) {
  return `${first} ${last}`.trim();
}

function isPositive(n) {
  return n > 0;
}

module.exports = { formatName, isPositive };
