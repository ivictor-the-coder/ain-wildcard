/**
 * CSV export.
 *
 * Exports carry stored values, not screen values: money leaves as a decimal
 * number and instants as ISO-8601, because the file's next stop is a
 * spreadsheet or a re-import, and `$80,000.00` is neither a number nor a
 * currency the importer can read back.
 */

import { zonedDay } from './time';

/** RFC 4180 quoting, plus the leading-quote guard for formula injection. */
export function csvCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value);
  const body = risky ? `'${value}` : value;
  return /["\n\r,]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * `Companies 2026-08-31.csv` — sortable, and safe on every filesystem.
 *
 * The day is the workspace's day, not UTC's and not the browser's: a file
 * stamped tomorrow because the operator exported it after 7pm in New York is
 * the sort of thing nobody reports and everybody trips over.
 */
export function exportFilename(label: string, at: number, timeZone: string): string {
  return `${label.replace(/[^\w -]+/g, '').trim() || 'records'} ${zonedDay(at, timeZone)}.csv`;
}
