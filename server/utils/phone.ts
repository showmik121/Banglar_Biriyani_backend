/** Last 10 digits of a Bangladeshi number: "01711-000001", "+8801711000001" -> "1711000001". */
export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

/** True when two phone numbers are the same subscriber number (ignores spaces, dashes, +880). */
export function samePhone(a: string, b: string): boolean {
  const ka = phoneKey(a)
  return ka.length === 10 && ka === phoneKey(b)
}
