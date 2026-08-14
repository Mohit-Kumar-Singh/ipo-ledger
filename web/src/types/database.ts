export type UserRole = 'admin' | 'member'
export type ApplicationCategory = 'RETAIL' | 'SHNI' | 'BHNI' | 'SHAREHOLDER' | 'EMPLOYEE'
export type ApplicationStatus = 'APPLIED' | 'ALLOTTED' | 'NOT_ALLOTTED' | 'SOLD'
export type Registrar =
  | 'MUFG_INTIME'
  | 'KFINTECH'
  | 'BIGSHARE'
  | 'CAMEO'
  | 'SKYLINE'
  | 'MAASHITLA'
  | 'OTHER'
export type NotificationType = 'APPLIED' | 'ALLOTTED' | 'SELL_REMINDER' | 'CUSTOM' | 'GMP_ALERT' | 'ROLLUP'
export type NotificationStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SIMULATED'

export interface Profile {
  id: string
  full_name: string
  phone_e164: string | null
  role: UserRole
  created_at: string
  has_seen_tour: boolean
  self_pan_hash: string | null
  self_pan_masked: string | null
}

export interface DematAccount {
  id: string
  holder_name: string
  phone_e164: string
  pan_masked: string
  pan_hash: string
  broker: string | null
  dp_client_id: string | null
  linked_user_id: string | null
  notes: string | null
  profit_share_percent: number
  is_active: boolean
  created_at: string
  // Broker-app login details — plaintext by design (no reveal step, unlike
  // PAN), all optional. Visible only to the account's own linked owner and
  // admin (same RLS grant as the rest of the row).
  application_name: string | null
  login_email: string | null
  login_password: string | null
  app_password: string | null
  t_pin: string | null
  // Free text — where/when this account has already been logged in, so a
  // fresh login/OTP isn't accidentally re-triggered. Same plaintext, no
  // reveal-step treatment as the other credential fields.
  logged_in_notes: string | null
}

export interface BankAccount {
  id: string
  demat_id: string | null
  linked_user_id: string | null
  account_holder_name: string | null
  bank_name: string | null
  last4: string | null
  upi_id: string | null
  phone_e164: string | null
  is_default: boolean
}

export interface Ipo {
  id: string
  company_name: string
  symbol: string | null
  exchange: string | null
  price_low: number | null
  price_high: number | null
  lot_size: number
  open_date: string
  close_date: string
  allotment_date: string | null
  listing_date: string | null
  registrar: Registrar
  registrar_url: string | null
  gmp_notes: string | null
  issue_size: string | null
  retail_issue_size: string | null
  shareholder_issue_size: string | null
  retail_subscription_rate: string | null
  created_at: string
  is_archived: boolean
  // null = unknown (neither "Allotment Out" nor "Allotment Awaited" seen on
  // ipoji, or never imported from there) — see deriveStatus in IposPage.tsx.
  allotment_out: boolean | null
}

export interface Application {
  id: string
  ipo_id: string
  demat_id: string
  bank_account_id: string | null
  // Independent of bank_account_id — that's "which UPI literally paid
  // ipoji" (stays tied to mandate approval, never touched by this field).
  // This is "who gets funding credit," settable only by hand, for the case
  // where the real funder handed money over off-app and someone else's own
  // UPI placed the actual bid. Every funder-credit consumer prefers this
  // over bank_account_id when set; the ipoji sync never writes to it.
  funder_override_id: string | null
  category: ApplicationCategory
  lots: number
  bid_amount: number | null
  status: ApplicationStatus
  applied_at: string
  status_changed_at: string
  changed_by: string | null
  sell_price: number | null
  is_backdated: boolean
  imported_from_ipoji: boolean
  ipoji_app_number: string | null
  created_by: string | null
  mandate_status: MandateStatus
  mandate_marked_by: string | null
  mandate_marked_at: string | null
  mandate_marked_by_ipoji: boolean
  ipoji_status_text: string | null
}

export type MandateStatus = 'PENDING' | 'APPROVED' | 'CANCELLED'

export interface Notification {
  id: string
  application_id: string | null
  demat_id: string | null
  ipo_id: string | null
  type: NotificationType
  to_phone: string
  template_name: string
  variables: Record<string, unknown>
  wa_message_id: string | null
  status: NotificationStatus
  error_detail: string | null
  created_at: string
  updated_at: string
  is_archived: boolean
}

export interface AllotmentBoardRow {
  application_id: string
  ipo_id: string
  demat_id: string
  company_name: string
  listing_date: string | null
  holder_name: string
  pan_masked: string
  phone_e164: string
  profit_share_percent: number
  bank_name: string | null
  last4: string | null
  lots: number
  bid_amount: number | null
  status: ApplicationStatus
  sell_price: number | null
  lot_size: number
  split_profit_with_funder: boolean
  demat_cut_paid: boolean
  funder_share_paid: boolean
  upi_id: string | null
  bank_account_holder_name: string | null
  bank_account_phone: string | null
  mandate_status: MandateStatus
  ipo_is_archived: boolean
  // Funding credit for this application was manually reassigned to a
  // different bank/UPI account (funder_override_id, migration 0063) — i.e.
  // someone else transferred money in rather than the applicant's own UPI
  // paying. See migration 0067.
  is_funder_override: boolean
}

export interface RegistrarLink {
  registrar: Registrar
  check_url: string
}

export type LinkRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface DematLinkRequest {
  id: string
  member_id: string
  demat_id: string
  status: LinkRequestStatus
  requested_at: string
  decided_by: string | null
  decided_at: string | null
}

export interface BankLinkRequest {
  id: string
  member_id: string
  bank_account_id: string
  status: LinkRequestStatus
  requested_at: string
  decided_by: string | null
  decided_at: string | null
}

export interface ApplicationAttributionRow {
  application_id: string
  ipo_id: string
  company_name: string
  open_date: string
  demat_id: string
  holder_name: string
  bank_account_id: string | null
  funder_user_id: string | null
  funder_name: string | null
  created_by: string | null
}

// Minimal Database type so supabase-js generics resolve without full codegen.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any
