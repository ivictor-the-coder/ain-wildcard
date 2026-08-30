/** Pure matching for the command palette, kept out of the component file so it
 *  can be tuned and tested without a DOM. */

export interface CommandMatchable {
  title: string;
  subtitle?: string;
  keywords?: string[];
}

/**
 * Substring match across title, subtitle and keywords, ranked by where the
 * query hits: a title prefix beats a title substring beats a keyword. Shorter
 * titles win ties, so "Invoices" outranks "Invoice reminder settings".
 */
export function rankCommands<T extends CommandMatchable>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const scored: { entry: T; score: number }[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 100;
    else if (title.includes(q)) score = 70;
    else if ((entry.subtitle?.toLowerCase() ?? '').includes(q)) score = 45;
    else if ((entry.keywords ?? []).some((k) => k.toLowerCase().includes(q))) score = 40;
    if (score >= 0) scored.push({ entry, score: score - title.length * 0.01 });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}
