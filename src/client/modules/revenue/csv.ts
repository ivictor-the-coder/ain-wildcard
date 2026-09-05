/**
 * What a revenue operator's week ends in.
 *
 * Everything exported is what the grid is showing at that moment — the same
 * filter, the same order — because a file holding rows the screen did not is
 * how a reconciliation goes wrong twice. Amounts are plain decimals in the
 * major unit with the currency in its own column: a spreadsheet cannot add
 * "€1.309,00", and it adds `130900` to the wrong answer.
 *
 * Pure: no React, no design system, so the columns a screen exports can be
 * checked in a unit test against the rows the API returns.
 */
import { exponentOf, type Currency } from '../../../shared/money';

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

export const csvAmount = (minor: number | null | undefined, currency: string): string => {
  if (minor === null || minor === undefined) return '';
  const exp = exponentOf((currency || 'usd').toLowerCase() as Currency);
  return (minor / 10 ** exp).toFixed(exp);
};

export const csvDay = (ts: number | null | undefined): string =>
  (ts === null || ts === undefined ? '' : new Date(ts).toISOString().slice(0, 10));

export const csvInstant = (ts: number | null | undefined): string =>
  (ts === null || ts === undefined ? '' : new Date(ts).toISOString());

/** RFC 4180: quote anything with a comma, a quote or a newline; double the quotes. */
const csvCell = (raw: string | number | null | undefined): string => {
  if (raw === null || raw === undefined) return '';
  const text = String(raw);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  // Excel on Windows wants the CRLF, and the BOM is what lets it read the €
  // and £ signs a multi-currency book is full of.
  return `﻿${lines.join('\r\n')}\r\n`;
}
