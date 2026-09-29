// Turns anything that can go wrong — a Postgres/PostgREST error, an Edge
// Function failure, a dropped connection, a JS exception — into one short,
// plain sentence a non-technical person can act on. Nobody using this app
// should ever see "violates foreign key constraint", a table or column name,
// an error code, or "Load failed".
//
// Rules for what comes out:
//  - says what happened in everyday words, and what to do next when there's
//    something to do ("delete the duplicate instead", "try again");
//  - never names tables, columns, constraints, SQL, HTTP status codes;
//  - is safe to show as-is in a toast or under a form.
//
// Use friendlyError(err) anywhere an error reaches the screen. showToast()
// also runs every message through plainMessage() as a safety net, so a raw
// `error.message` handed to it is still translated — but call friendlyError
// explicitly in new code so the wording can be context-specific (`fallback`).

const GENERIC = 'Something went wrong. Please try again.'

// Table -> how a person would say it. Anything not listed falls back to a
// de-snake_cased name, which reads acceptably for the rest.
const TABLE_NOUNS: Record<string, { singular: string; plural: string }> = {
  bank_accounts: { singular: 'bank/UPI account', plural: 'bank/UPI accounts' },
  demat_accounts: { singular: 'demat account', plural: 'demat accounts' },
  applications: { singular: 'application', plural: 'applications' },
  ipos: { singular: 'IPO', plural: 'IPOs' },
  profiles: { singular: 'member', plural: 'members' },
  notifications: { singular: 'notification', plural: 'notifications' },
  settlement_payments: { singular: 'payment record', plural: 'payment records' },
  application_sells: { singular: 'sale record', plural: 'sale records' },
  account_managers: { singular: 'shared-account link', plural: 'shared-account links' },
  demat_link_requests: { singular: 'link request', plural: 'link requests' },
  bank_link_requests: { singular: 'link request', plural: 'link requests' },
  parent_companies: { singular: 'parent company', plural: 'parent companies' },
  sell_instruction_pdfs: { singular: 'sell-instruction PDF', plural: 'sell-instruction PDFs' },
}

function nounFor(table: string | undefined, plural = false): string {
  if (!table) return plural ? 'other records' : 'another record'
  const known = TABLE_NOUNS[table]
  if (known) return plural ? known.plural : known.singular
  return table.replace(/_/g, ' ')
}

// "amount_paid" -> "amount paid"
function fieldName(column: string): string {
  return column.replace(/_id$/, '').replace(/_/g, ' ').trim()
}

interface ErrorLike {
  message?: unknown
  code?: unknown
  status?: unknown
}

function asErrorLike(err: unknown): ErrorLike {
  if (typeof err === 'string') return { message: err }
  if (err && typeof err === 'object') return err as ErrorLike
  return {}
}

// Things that only a developer should ever read. If a message matches none
// of these it's assumed to be human-written already (e.g. a message raised
// on purpose by one of our own database functions) and is shown as-is.
const TECHNICAL =
  /violates|constraint|duplicate key|does not exist|invalid input|row-level security|permission denied|PGRST|\bJWT\b|jwt |Failed to fetch|Load failed|NetworkError|network request failed|TypeError|ReferenceError|SyntaxError|Unexpected token|is not a function|Cannot read|undefined|\bnull value\b|new row for relation|infinite recursion|could not serialize|deadlock|statement timeout|canceling statement|FunctionsHttpError|FunctionsFetchError|FunctionsRelayError|non-2xx|\bECONN|ETIMEDOUT|schema cache|relation "|column "|\bfunction \w+\(|\bat \S+:\d+:\d+|<!DOCTYPE|<html/i

const NETWORK = /Failed to fetch|Load failed|NetworkError|network request failed|ECONN|ETIMEDOUT|fetch failed|FunctionsFetchError/i

export function isTechnicalMessage(message: string): boolean {
  return TECHNICAL.test(message)
}

function fromMessage(message: string, code: string | undefined): string | null {
  // Foreign key — the one people hit most. The message names both tables:
  //   update or delete on table "A" violates foreign key constraint "..." on table "B"
  //   insert or update on table "B" violates foreign key constraint "..." (A missing)
  if (code === '23503' || /foreign key/i.test(message)) {
    const del = message.match(/update or delete on table "([^"]+)".*?on table "([^"]+)"/is)
    if (del) {
      return `This ${nounFor(del[1])} can't be removed because ${nounFor(del[2], true)} still use it. Remove or reassign those first.`
    }
    return 'This refers to something that no longer exists. Refresh the page and try again.'
  }

  if (code === '23505' || /duplicate key|already exists/i.test(message)) {
    const table = message.match(/relation "([^"]+)"/)?.[1]
    return table
      ? `That ${nounFor(table)} already exists. Check for a duplicate.`
      : 'That already exists. Check for a duplicate.'
  }

  if (code === '23502' || /null value in column/i.test(message)) {
    const col = message.match(/column "([^"]+)"/)?.[1]
    return col ? `Please fill in the ${fieldName(col)} field.` : 'A required field is empty. Please fill everything in.'
  }

  if (code === '23514' || /check constraint/i.test(message)) {
    return "One of the values isn't allowed. Please check what you entered."
  }

  if (code === '22P02' || code === '22007' || code === '22008' || /invalid input syntax/i.test(message)) {
    return "One of the values isn't in the right format. Please check what you entered."
  }

  if (code === '22001' || /value too long/i.test(message)) {
    return 'One of the entries is too long. Please shorten it.'
  }

  if (code === '42501' || /row-level security|permission denied/i.test(message)) {
    return "You don't have permission to do that."
  }

  if (/JWT|jwt|PGRST30[0-9]|invalid claim|not authenticated/i.test(message) || code === 'PGRST301') {
    return 'Your session has expired. Please sign in again.'
  }

  if (code === 'PGRST116' || /JSON object requested, multiple \(or no\) rows/i.test(message)) {
    return "We couldn't find that. It may have been removed. Refresh the page and try again."
  }

  if (NETWORK.test(message)) {
    return "Couldn't reach the server. Check your internet connection and try again."
  }

  if (/statement timeout|canceling statement|ETIMEDOUT|timed? ?out/i.test(message)) {
    return 'That took too long. Please try again in a moment.'
  }

  if (/deadlock|could not serialize|infinite recursion|schema cache/i.test(message)) {
    return 'Something went wrong on our side. Please try again in a moment.'
  }

  // Terse replies our own background functions send back.
  if (/^(unauthori[sz]ed|forbidden)\.?$/i.test(message)) return "You don't have permission to do that."
  if (/^internal (server )?error\.?$/i.test(message)) return 'Something went wrong on our side. Please try again in a moment.'

  if (/non-2xx|FunctionsHttpError|FunctionsRelayError/i.test(message)) {
    return "That didn't go through. Please try again in a moment."
  }

  return null
}

/** One plain-language sentence for whatever went wrong. */
export function friendlyError(err: unknown, fallback: string = GENERIC): string {
  const e = asErrorLike(err)
  const message = typeof e.message === 'string' ? e.message.trim() : ''
  const code = typeof e.code === 'string' ? e.code : undefined
  const status = typeof e.status === 'number' ? e.status : undefined

  const mapped = message || code ? fromMessage(message, code) : null
  if (mapped) return mapped

  if (status === 401) return 'Your session has expired. Please sign in again.'
  if (status === 403) return "You don't have permission to do that."
  if (status === 404) return "We couldn't find that. It may have been removed."
  if (status === 429) return "You're doing that too quickly. Wait a moment and try again."
  if (status && status >= 500) return 'Something went wrong on our side. Please try again in a moment.'

  // Human-written and not technical (e.g. raised on purpose by one of our
  // own database functions): keep it, tidied up.
  if (message && !isTechnicalMessage(message)) {
    return message.charAt(0).toUpperCase() + message.slice(1)
  }
  return fallback
}

/** For plain strings that may or may not be technical (showToast's safety
 *  net): translates technical ones, returns everything else untouched. */
export function plainMessage(message: string): string {
  return isTechnicalMessage(message) ? friendlyError(message) : message
}

/** Same, for APIs that return `string | null` errors (null = no error). */
export function friendlyErrorOrNull(err: unknown, fallback?: string): string | null {
  return err ? friendlyError(err, fallback) : null
}
