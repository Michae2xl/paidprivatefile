import type { ProductLocale } from "./types";

type SearchParamValue = string | string[] | undefined;
type SearchParamsRecord = Record<string, SearchParamValue>;

export type ProductSearchParams =
  | SearchParamsRecord
  | Promise<SearchParamsRecord>
  | undefined;

const DEFAULT_LOCALE: ProductLocale = "en";

// English-only: the PT/EN toggle has been removed from the UI, so the app always
// renders the English copy. We intentionally ignore the `?lang=` query param (the
// pt.* strings remain in the copy file but are unreachable). The async signature
// is kept so existing server-component call sites do not need to change.
export async function resolveProductLocale(
  _searchParams: ProductSearchParams,
): Promise<ProductLocale> {
  return DEFAULT_LOCALE;
}

// English-only: the `?lang=` param is ignored on read, so we no longer append it
// to generated URLs (share links, public routes, internal nav). The `locale` arg
// is kept so the call sites do not need to change.
export function withProductLocale(
  href: string,
  _locale: ProductLocale,
): string {
  return href;
}
