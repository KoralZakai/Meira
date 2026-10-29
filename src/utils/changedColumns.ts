/** The columns of `now` that differ from `was`, never the key. A column an edit did not touch is not ours to write. */
export function changedColumns(
  was: Record<string, unknown>,
  now: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of Object.keys(now)) {
    if (col === 'userId' || col === 'id') continue;
    if (JSON.stringify(now[col]) !== JSON.stringify(was[col])) out[col] = now[col];
  }
  return out;
}
