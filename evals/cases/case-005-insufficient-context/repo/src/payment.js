// Payment processing module
// TODO: Add business rules for payment validation

function processPayment(_amount, _currency) {
  // Missing: currency validation
  // Missing: amount limits
  // Missing: fraud detection
  return { success: true, transactionId: "tx-" + Date.now() };
}

function refund(_transactionId) {
  // Missing: refund policy
  // Missing: partial refund support
  return { success: true };
}

module.exports = { processPayment, refund };
