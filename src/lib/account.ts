import { supabase } from './supabase';

export type AccountType = 'personal' | 'business';

export type Profile = {
  id: string;
  email: string | null;
  account_type: AccountType;
  country: string | null;
  full_name: string | null;
  phone: string | null;
  phone_verified: boolean;
  business_name: string | null;
  business_type: string | null;
  business_category: string | null;
  onboarding_step: number;
  onboarding_status:
    | 'started'
    | 'details_pending'
    | 'kyc_pending'
    | 'submitted'
    | 'verified'
    | 'rejected';
  created_at: string;
  updated_at: string;
};

export type KycApplication = {
  id: string;
  user_id: string;
  status: 'draft' | 'submitted' | 'pending_review' | 'verified' | 'rejected';
  legal_name: string | null;
  date_of_birth: string | null;
  nationality: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  occupation: string | null;
  place_of_birth: string | null;
  country_of_birth: string | null;
  secondary_nationality: string | null;
  gender: string | null;
  marital_status: string | null;
  employer: string | null;
  employment_status: string | null;
  source_of_funds: string | null;
  expected_monthly_volume: string | null;
  bank_country: string | null;
  bank_name: string | null;
  bank_account_holder: string | null;
  bank_account_number: string | null;
  bank_iban: string | null;
  bank_swift_bic: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  tax_residence: string | null;
  document_type: string | null;
  document_number: string | null;
  document_country: string | null;
  submitted_at: string | null;
};

export type LedgerAccount = {
  id: string;
  currency: string;
  available_minor: number;
  pending_minor: number;
  status: 'unfunded' | 'active' | 'restricted';
};

export type Transaction = {
  id: string;
  currency: string;
  amount_minor: number;
  direction: 'in' | 'out';
  status: 'pending' | 'authorized' | 'settled' | 'failed';
  rail: string | null;
  reference: string | null;
  created_at: string;
};

export type SecuritySettings = {
  transaction_password_hash: string | null;
  transaction_password_salt: string | null;
  transaction_password_iterations: number | null;
  mfa_secret: string | null;
  mfa_enabled: boolean;
};

export async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export async function loadKyc(userId: string): Promise<KycApplication | null> {
  const { data, error } = await supabase
    .from('kyc_applications')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as KycApplication) ?? null;
}

export async function loadLedger(userId: string): Promise<LedgerAccount[]> {
  const { data, error } = await supabase
    .from('ledger_accounts')
    .select('*')
    .eq('user_id', userId)
    .order('currency');
  if (error) throw error;
  return (data as LedgerAccount[]) ?? [];
}

export async function loadTransactions(userId: string): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw error;
  return (data as Transaction[]) ?? [];
}

export async function loadSecurity(userId: string): Promise<SecuritySettings | null> {
  const { data, error } = await supabase
    .from('security_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as SecuritySettings) ?? null;
}

export type ProfilePatch = Partial<
  Pick<
    Profile,
    | 'account_type'
    | 'country'
    | 'full_name'
    | 'phone'
    | 'phone_verified'
    | 'business_name'
    | 'business_type'
    | 'business_category'
    | 'onboarding_status'
    | 'onboarding_step'
  >
>;

export async function saveProfile(userId: string, patch: ProfilePatch) {
  const { error } = await supabase.from('profiles').upsert({ id: userId, ...patch });
  if (error) throw error;
}

export type KycPatch = Partial<Omit<KycApplication, 'id' | 'user_id'>>;

export async function saveKyc(userId: string, patch: KycPatch) {
  const { error } = await supabase
    .from('kyc_applications')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function recordAudit(
  _userId: string,
  event: string,
  entity: string,
  entityId?: string,
  metadata: Record<string, unknown> = {},
) {
  const { error } = await supabase.from('audit_events').insert({
    user_id: _userId,
    event,
    entity,
    entity_id: entityId ?? null,
    metadata,
  });
  if (error) throw error;
}

export async function saveSecurity(userId: string, patch: Partial<SecuritySettings>) {
  const { error } = await supabase
    .from('security_settings')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function ensureLedgerAccount(_userId: string, currency = 'USD') {
  const { data, error } = await supabase.rpc('ensure_ledger_account', {
    p_currency: currency,
  });
  if (error) throw error;
  return data as LedgerAccount;
}

export const formatMinor = (minor: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);

export const STATUS_COPY: Record<Profile['onboarding_status'], string> = {
  started: 'Account created — add your details to unlock payments.',
  details_pending: 'Your details are saved. Submit them for verification.',
  kyc_pending: 'Identity verification is in progress.',
  submitted: 'Submitted — our review team is checking your details.',
  verified: 'Verified — your account is fully active.',
  rejected: 'Verification was not approved. Contact support to continue.',
};
