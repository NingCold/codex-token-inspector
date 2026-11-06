/** Decimal token units; promote rounded boundary values instead of showing 1000K/M. */
export function formatTokens(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(n);
  const units = [{ scale: 1e9, suffix: 'B' }, { scale: 1e6, suffix: 'M' }, { scale: 1e3, suffix: 'K' }];
  let index = n >= 1e9 ? 0 : n >= 1e6 ? 1 : 2;
  const render = () => (n / units[index].scale).toFixed(index < 2 ? 2 : n % 1000 ? 1 : 0);
  let value = render();
  if (Number(value) >= 1000 && index > 0) { index--; value = render(); }
  return value + units[index].suffix;
}
