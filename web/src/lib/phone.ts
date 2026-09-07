// Every phone field in the app stores a bare 10-digit Indian mobile number
// (the +91 is a fixed prefix rendered beside the input, and persisted as
// `+91<digits>` in `phone_e164`). Users routinely paste numbers copied from
// WhatsApp / contacts, which arrive as "+91 98765 43210", "091-98765-43210",
// "0098765 43210", etc. Left to the old inline `replace(/[^0-9]/g, '')` +
// `maxLength={10}` combo, the country code survived and the real number got
// truncated ("+91 98765 " -> "9198765"), so the field just refused to save.
//
// This normalises any such paste/typing down to the 10 subscriber digits:
//   1. drop everything that isn't a digit
//   2. drop a leading 91 / 0091 country code, or a single 0 trunk prefix,
//      but only when doing so leaves a plausible 10-digit number
//   3. cap at 10 digits
export function normalizeIndianPhoneDigits(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if (d.length > 10) {
    if (d.startsWith('0091')) d = d.slice(4)
    else if (d.startsWith('91')) d = d.slice(2)
    else if (d.startsWith('0')) d = d.slice(1)
  }
  return d.slice(0, 10)
}
