// Shared rule for a password the user CHOOSES (Change Password, Forgot
// Password). Not applied to the admin-issued temp password ("lastname12345")
// for logging in — only when someone sets a new one, which forces them off
// the weak default.

export const PASSWORD_MIN_LENGTH = 8;

/**
 * Returns a human-readable error string if `password` breaks the rule, or
 * null if it's acceptable. Rule: at least 8 characters, at least one digit,
 * at least one non-alphanumeric character. Letters are allowed but not
 * required.
 */
export const validateNewPassword = (password: string): string | null => {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[0-9]/.test(password)) {
    return "Password must include at least one number.";
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return "Password must include at least one special character (e.g. ! @ # $).";
  }
  return null;
};
