// Keep the browsing order across polling, filters and view switches. New sessions append.
export function retainSessionOrder<T extends { id: string }>(rows: T[], previous: readonly string[], reset = false) {
  const known = new Set(previous);
  const order = reset ? rows.map(row => row.id) : [...previous, ...rows.filter(row => !known.has(row.id)).map(row => row.id)];
  const byId = new Map(rows.map(row => [row.id, row]));
  return { order, rows: order.flatMap(id => { const row = byId.get(id); return row ? [row] : []; }) };
}
