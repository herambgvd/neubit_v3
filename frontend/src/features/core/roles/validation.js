// Field rules for the Role form + clone dialogs, mirroring users/validation.js.
// Same reason: name the bad field next to the field, instead of letting the API
// answer with a 422 the operator has to decode out of a toast.

export function roleNameError(value) {
  const name = value?.trim() || "";
  if (!name) return "Role name is required.";
  if (name.length < 2) return "Role name is too short.";
  return undefined;
}

export function validateRole(form) {
  const error = roleNameError(form.name);
  return error ? { name: error } : {};
}
