let isSubmitting = false;

function submit(data) {
  isSubmitting = true;
  // Simulate API call
  if (!data.name) {
    throw new Error("Name is required");
  }
  return { success: true };
}

function reset() {
  isSubmitting = false;
}

module.exports = { submit, reset, isSubmitting };
