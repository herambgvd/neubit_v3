// Field rules for the site create/edit form, mirroring users/validation.js and
// roles/validation.js: the operator is told which field is wrong, next to that
// field, instead of reading a 422 out of a toast.

// ASCII-only, same rule the backend enforces (core/fields.AsciiEmail).
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// Zip code and phone are numeric fields — letters used to sail straight through
// to the API. Same rules the backend now enforces (sites/shared.py).
const ZIP_RE = /^\d{3,10}$/;
const PHONE_RE = /^\+?[\d\s()-]+$/;

// Strip anything that can't belong in the field as the operator types, so a
// letter never lands in the box in the first place.
export const sanitizeZip = (v) => v.replace(/\D/g, "").slice(0, 10);
export const sanitizePhone = (v) =>
  // A "+" is only meaningful as a country-code prefix, so keep it at the front only.
  (v.startsWith("+") ? "+" : "") + v.replace(/[^\d\s()-]/g, "").slice(0, 24);

function coordError(value, label, limit) {
  if (value === "" || value == null) return undefined; // coordinates are optional
  const n = Number(value);
  if (Number.isNaN(n)) return `${label} must be a number.`;
  if (n < -limit || n > limit) return `${label} must be between −${limit} and ${limit}.`;
  return undefined;
}

export function validateSite({ name, emailAddress, latitude, longitude, zipCode, contactPhone }: any) {
  const errors: any = {};
  if (!name?.trim()) errors.name = "Site name is required.";

  const zip = zipCode?.trim() || "";
  if (zip && !ZIP_RE.test(zip)) errors.zipCode = "Zip code must be 3 to 10 digits, numbers only.";

  const phone = contactPhone?.trim() || "";
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (!PHONE_RE.test(phone)) {
      errors.contactPhone = "Phone can only contain numbers, and + ( ) - separators.";
    } else if (digits.length < 7 || digits.length > 15) {
      errors.contactPhone = "Phone must have 7 to 15 digits.";
    }
  }

  const email = emailAddress?.trim() || "";
  if (email) {
    // Optional field — but a filled-in address is held to the same rule as a user's.
    if (!/^[\x20-\x7e]*$/.test(email)) {
      errors.emailAddress = "Email can only contain plain letters, numbers and . _ % + - symbols.";
    } else if (!EMAIL_RE.test(email)) {
      errors.emailAddress = "Enter a valid email address, e.g. name@company.com.";
    }
  }

  // A pin only lands on the map when both halves are present and in range.
  const lat = coordError(latitude, "Latitude", 90);
  const lng = coordError(longitude, "Longitude", 180);
  if (lat) errors.latitude = lat;
  if (lng) errors.longitude = lng;
  if (!lat && !lng) {
    const hasLat = latitude !== "" && latitude != null;
    const hasLng = longitude !== "" && longitude != null;
    if (hasLat !== hasLng) {
      const missing = hasLat ? "longitude" : "latitude";
      errors[hasLat ? "longitude" : "latitude"] = `Enter a ${missing} too, or clear both.`;
    }
  }
  return errors;
}
