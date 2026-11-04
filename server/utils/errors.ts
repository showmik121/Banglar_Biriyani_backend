/**
 * What to put in the "details" field of a 500 response.
 * On the live site it is always null, so database messages never reach the browser
 * (they are still written to the server log). While developing or testing the real
 * message is shown to make problems easy to find.
 */
export function errorDetails(error: unknown): string | null {
  // Fail closed: only show the message when NODE_ENV is explicitly development or test.
  // A forgotten NODE_ENV on the live site must not leak database messages.
  const env = process.env.NODE_ENV
  if (env !== "development" && env !== "test") return null
  return error instanceof Error ? error.message : String(error)
}
