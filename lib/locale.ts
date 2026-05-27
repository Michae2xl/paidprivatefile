import type { ProductLocale } from "./types";

type SearchParamValue = string | string[] | undefined;
type SearchParamsRecord = Record<string, SearchParamValue>;

export type ProductSearchParams =
  | SearchParamsRecord
  | Promise<SearchParamsRecord>
  | undefined;

const DEFAULT_LOCALE: ProductLocale = "en";

export async function resolveProductLocale(
  searchParams: ProductSearchParams,
): Promise<ProductLocale> {
  const resolved = searchParams ? await searchParams : undefined;
  const candidate = resolved?.lang;
  const value = Array.isArray(candidate) ? candidate[0] : candidate;

  return value === "pt" || value === "en" ? value : DEFAULT_LOCALE;
}

export function withProductLocale(href: string, locale: ProductLocale): string {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}lang=${locale}`;
}
