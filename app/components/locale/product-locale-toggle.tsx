"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

import type { ProductLocale } from "../../../lib/types";

interface ProductLocaleToggleProps {
  locale: ProductLocale;
  ariaLabel: string;
}

export function ProductLocaleToggle({
  locale,
  ariaLabel,
}: ProductLocaleToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const setLocale = useCallback(
    (next: ProductLocale) => {
      if (next === locale) return;
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("lang", next);
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      startTransition(() => {
        router.replace(href, { scroll: false });
      });
    },
    [locale, pathname, router, searchParams],
  );

  return (
    <div
      className="button-row product-locale-group"
      role="group"
      aria-label={ariaLabel}
      aria-busy={isPending}
    >
      <button
        type="button"
        className={locale === "pt" ? "button-primary" : "button-secondary"}
        aria-pressed={locale === "pt"}
        onClick={() => setLocale("pt")}
      >
        PT
      </button>
      <button
        type="button"
        className={locale === "en" ? "button-primary" : "button-secondary"}
        aria-pressed={locale === "en"}
        onClick={() => setLocale("en")}
      >
        EN
      </button>
    </div>
  );
}
