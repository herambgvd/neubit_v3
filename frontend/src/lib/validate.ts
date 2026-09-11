// SMALL VALIDATORS THAT CANNOT BACKTRACK.
//
// Five different email regexes lived in this codebase and three of them were
// ambiguous enough to backtrack super-linearly: `[^\s@]+@[^\s@]+\.[^\s@]+` lets
// the second and third groups both match a dot, so a long address with no dot at
// the end makes the engine try every split. Typed into a login form that is a
// browser tab locking up; it is still a defect, and five spellings of "valid
// email" that disagree with each other is a second one.
//
// So this is structural rather than a regex. It is linear by construction — every
// character is looked at a fixed number of times — and, more usefully, a reader
// can check it against the rule they have in mind without simulating a backtracker.
//
// It is DELIBERATELY not RFC 5322. That grammar admits quoted local parts,
// comments and bracketed literals, and nothing in this product wants them; the
// only question a form needs answered is "could this plausibly be delivered to",
// and the authority on that is the mail server.
//
// ASCII ONLY, matching core/fields.AsciiEmail. That is not tidiness — EmailStr
// alone accepts an emoji local part, and an account was created under an address
// no mail server here will deliver to. It also invites impersonation: an
// emoji-carrying variant of a real address is indistinguishable at a glance in a
// user list. Two of the five validators this replaced already enforced it; the
// other three did not, which is exactly the kind of disagreement one rule ends.

/** Roughly what a mail server will take, and nothing clever. */
export function isEmail(value: string): boolean {
  const v = (value ?? "").trim();
  const at = v.indexOf("@");
  // Exactly one @, with something either side. lastIndexOf catches the second one
  // without a second scan of the whole string.
  if (at <= 0 || at !== v.lastIndexOf("@") || at === v.length - 1) return false;

  if (!isAscii(v)) return false;

  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (hasSpace(local) || hasSpace(domain)) return false;

  // A domain is dot-separated labels, each non-empty. That rejects "a@b",
  // "a@.b", "a@b." and "a@b..c" in one rule rather than four.
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => label.length > 0);
}

function isAscii(s: string): boolean {
  // `codePointAt`, not `charCodeAt`: an astral character (an emoji) is two UTF-16
  // units, and `charCodeAt` reports each half separately. Both halves happen to be
  // > 127 so the answer here is the same either way — but only by luck, and the
  // next person to reuse this should get the character, not a surrogate.
  for (const ch of s) if ((ch.codePointAt(0) ?? 0) > 127) return false;
  return true;
}

function hasSpace(s: string): boolean {
  for (const ch of s) if (ch.trim() === "") return true;
  return false;
}

/** Strip every leading and trailing occurrence of `chars`.
 *
 *  A loop, not `/^x+|x+$/` — an anchored `+` run is the other shape Sonar flags
 *  for super-linear runtime, and "remove these from the ends" is clearer said
 *  directly than as two alternated anchors. */
export function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Strip trailing occurrences only — the shape a URL path or a hostname wants. */
export function trimEnd(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}
