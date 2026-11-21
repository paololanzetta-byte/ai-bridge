function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Somiglianza di Jaccard sulle parole: 0 = niente in comune, 1 = identici. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const union = wa.size + wb.size - common;
  return union === 0 ? 0 : common / union;
}
