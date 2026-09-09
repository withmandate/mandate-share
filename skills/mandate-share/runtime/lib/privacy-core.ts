import { slugFormatError } from "./slug.ts";

export type SharingVisibility = "private" | "unlisted" | "public";
export interface PagePolicy { visibility: SharingVisibility; indexable: boolean }
export type PagePolicyManifest = Record<string, PagePolicy>;
export const NOINDEX = "noindex, nofollow";

export function validatePagePolicy(value: unknown): asserts value is PagePolicy {
  const item = value as PagePolicy;
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      !["private", "unlisted", "public"].includes(item.visibility) || typeof item.indexable !== "boolean" ||
      Object.keys(item).some(key => !["visibility", "indexable"].includes(key)) ||
      (item.indexable && item.visibility !== "public")) throw new Error("Invalid sharing policy; indexing requires a public page.");
}
export function validatePagePolicies(value: unknown): asserts value is PagePolicyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid page sharing policies.");
  for (const [slug, policy] of Object.entries(value)) {
    if (slugFormatError(slug)) throw new Error("Invalid page sharing policy slug.");
    validatePagePolicy(policy);
  }
}
export function pageSlugForPath(pathname: string): string | undefined {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\/.*|\.(?:html|mdx)(?:\/.*)?)?$/u.exec(pathname);
  return match && !slugFormatError(match[1]) ? match[1] : undefined;
}
export function robotsForPath(pathname: string, policy?: PagePolicy, status = 200): string {
  if (status >= 400 || /\.mdx(?:\/|$)/u.test(pathname)) return NOINDEX;
  return policy?.visibility === "public" && policy.indexable ? "index, follow" : NOINDEX;
}
