// Field rules for the Add / Edit user modals. Shared so the two dialogs can never
// disagree about what a valid account looks like, and so the operator is told WHICH
// field is wrong up front instead of reading a 422 out of a toast.
//
// These mirror the backend: EmailStr for the address, and the password policy from
// app/auth/security.py::validate_password (min length, a letter, a number).

// ASCII-only on purpose. A "no spaces, one @" pattern happily accepts
// "mohit😀@example.com" — and so did the API, so emoji addresses were reaching the
// user table. This is the same rule the backend now enforces (core/fields.AsciiEmail).
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PASSWORD_HINT = "At least 8 characters, with a letter and a number.";

export { PASSWORD_HINT };

export function nameError(value) {
  return value?.trim() ? undefined : "Full name is required.";
}

export function emailError(value) {
  const email = value?.trim() || "";
  if (!email) return "Email is required.";
  // Called out separately: "invalid address" next to a field that looks fine to the
  // eye is baffling when the only problem is a pasted emoji or accented character.
  if (!/^[\x20-\x7e]*$/.test(email)) return "Email can only contain plain letters, numbers and . _ % + - symbols.";
  if (!EMAIL_RE.test(email)) return "Enter a valid email address, e.g. name@company.com.";
  return undefined;
}

// `optional` = the edit form, where a blank field means "keep the current password".
export function passwordError(value, { optional = false } = {}) {
  const pw = value || "";
  if (!pw) return optional ? undefined : "Password is required.";
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return "Password must contain a letter and a number.";
  return undefined;
}

function compact(errors) {
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v));
}

export function validateNewUser(form) {
  return compact({
    full_name: nameError(form.full_name),
    email: emailError(form.email),
    password: passwordError(form.password),
    role_id: form.role_id ? undefined : "Pick a role for this user.",
  });
}

export function validateEditUser(form) {
  return compact({
    full_name: nameError(form.full_name),
    email: emailError(form.email),
    // Blank = unchanged, so only a filled-in password is held to the policy.
    password: passwordError(form.password, { optional: true }),
    role_id: form.role_id ? undefined : "Pick a role for this user.",
  });
}
