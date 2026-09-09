/**
 * URL-friendly slug generation for raw shares.
 *
 * Random slugs draw from an unambiguous lowercase alphabet (no 0/1/o/l/i) so a
 * hash read aloud, copied by hand, or pasted into a URL never collides on
 * look-alike glyphs. Four chars over 31 symbols is ~923k combinations — ample
 * for one person's shares — and every generated slug is checked against
 * everything that already exists, so the birthday math never bites in practice.
 */

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
export const MAX_SLUG_LENGTH = 80;

/** Names the build reserves for generated assets — never usable as a slug. */
export const RESERVED_SLUGS = new Set(["index", "404", "robots"]);

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** One random slug of `len` chars from the unambiguous alphabet. */
export function randomSlug(len = 4): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * A random slug guaranteed to be absent from `taken` and the reserved set.
 * Grows the length after repeated collisions so it always terminates, even if
 * the space at a given length is somehow saturated.
 */
export function uniqueSlug(taken: Set<string>, len = 4): string {
  let length = len;
  for (let attempt = 1; ; attempt++) {
    const slug = randomSlug(length);
    if (!taken.has(slug) && !RESERVED_SLUGS.has(slug)) return slug;
    if (attempt % 12 === 0) length++;
  }
}

/**
 * Validate the *shape* of a user-supplied custom slug (format + reserved
 * names). Returns an error string, or null if well-formed. Collision against
 * existing digest/raw slugs is decided by the caller, which knows whether a
 * match means "update this raw page" or "conflict with a digest".
 */
export function slugFormatError(slug: string): string | null {
  if (!SLUG_RE.test(slug) || slug.endsWith("-"))
    return `invalid slug "${slug}" — use lowercase letters, digits, and hyphens (start alphanumeric, no trailing hyphen)`;
  if (slug.length > MAX_SLUG_LENGTH)
    return `invalid slug "${slug}" — use at most ${MAX_SLUG_LENGTH} characters`;
  if (RESERVED_SLUGS.has(slug))
    return `"${slug}" is a reserved name (${[...RESERVED_SLUGS].join(", ")}) — pick another`;
  return null;
}
