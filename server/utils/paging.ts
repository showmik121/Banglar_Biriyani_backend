// Reads ?limit= and ?offset= from a list request. Anything that is not a number
// falls back to the default instead of breaking the request.
export function parsePaging(
  query: { limit?: string; offset?: string },
  defaultLimit: number,
  maxLimit: number,
): { limit: number; offset: number } {
  const l = Number.parseInt(query.limit ?? "", 10)
  const o = Number.parseInt(query.offset ?? "", 10)
  return {
    limit: Number.isFinite(l) ? Math.min(maxLimit, Math.max(1, l)) : defaultLimit,
    offset: Number.isFinite(o) ? Math.max(0, o) : 0,
  }
}
