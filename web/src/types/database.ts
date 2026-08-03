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
export type NotificationType = 'APPLIED' | 'ALLOTTED' | 'SELL_REMINDER' | 'CUSTOM'
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
  retail_subscription_rate: string | null
  created_at: string
}

export interface Application {
  id: string
  ipo_id: string
  demat_id: string
  bank_account_id: string | null
  category: ApplicationCategory
  lots: number
  bid_amount: number | null
  status: ApplicationStatus
  applied_at: string
  status_changed_at: string
  changed_by: string | null
  sell_price: number | null
  is_backdated: boolean
  created_by: string | null
}

export interface Notification {
  id: string
  application_id: string | null
  demat_id: string | null
  type: NotificationType
  to_phone: string
  template_name: string
  variables: Record<string, unknown>
  wa_message_id: string | null
  status: NotificationStatus
  error_detail: string | null
  created_at: string
  updated_at: string
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

export interface ApplicationAttributionRow {
  application_id: string
  ipo_id: string
  company_name: string
  open_date: string
  demat_id: string
  holder_name: string
  bank_account_id: string | null
  funder_user_id: string | null
  created_by: string | null
}

// Minimal Database type so supabase-js generics resolve without full codegen.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any
