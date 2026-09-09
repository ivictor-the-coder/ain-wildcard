/**
 * The currencies a price may be denominated in.
 *
 * The register itself moved to `src/shared/currencies.ts` so that
 * `v.currency()` can check against it — catalog was the first module to notice
 * that `[a-z]{3}` accepts "zzz", and wrapped the shared validator in
 * `assertCurrency` by hand; the validator does it for every door now. This file
 * stays as catalog's name for the list it prices in.
 */
export { CURRENCIES, CURRENCY_CODES, assertCurrency, currencyName, isCurrency } from '../../../shared/currencies';
