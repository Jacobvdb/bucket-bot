// Bkper Webhook Payload Types

export interface BkperGroup {
  id: string
  name: string
  normalizedName: string
  properties?: Record<string, string>
  parent?: {
    id: string
    name: string
    normalizedName: string
    properties?: Record<string, string>
  }
  credit: boolean
  permanent: boolean
  hasAccounts?: boolean
  hasGroups?: boolean
  hidden?: boolean
  locked?: boolean
  mixed?: boolean
  createdAt?: string
}

export interface BkperAccount {
  id: string
  name: string
  normalizedName: string
  type: 'ASSET' | 'LIABILITY' | 'INCOMING' | 'OUTGOING'
  properties?: Record<string, string>
  groups?: BkperGroup[]
  credit: boolean
  permanent: boolean
  archived?: boolean
  balance?: string
  balanceVerified?: boolean
  hasTransactionPosted?: boolean
  createdAt?: string
}

export interface BkperTransaction {
  id: string
  amount: string
  description: string
  date: string
  dateFormatted?: string
  dateValue?: number
  creditAccount: BkperAccount
  debitAccount: BkperAccount
  checked: boolean
  posted: boolean
  draft: boolean
  trashed: boolean
  properties?: Record<string, string>
  tags?: string[]
  remoteIds?: string[]
  files?: unknown[]
  urls?: string[]
  createdAt?: string
  createdBy?: string
  updatedAt?: string
}

export interface BkperBook {
  id: string
  name: string
  properties?: Record<string, string>
  collection?: {
    id: string
    name: string
    books?: BkperBook[]
  }
  fractionDigits?: number
  datePattern?: string
  decimalSeparator?: string
  timeZone?: string
  period?: string
}

export interface BkperWebhookPayload {
  id: string
  type: 'TRANSACTION_POSTED' | 'TRANSACTION_UPDATED' | 'TRANSACTION_DELETED' | 'TRANSACTION_RESTORED' | 'TRANSACTION_UNTRASHED'
  bookId: string
  resource: string
  book: BkperBook
  data: {
    object: {
      transaction: BkperTransaction
      accounts?: BkperAccount[]
    }
    previousAttributes?: Record<string, string>
  }
  user?: {
    username: string
    name: string
  }
  createdAt?: string
}

// Context object that carries extracted data through the request

export type Direction = 'deposit' | 'withdrawal'

export interface SavingsContext {
  // From GL Book
  bucketBookId: string

  // From Bucket Book
  bucketHashtag: string | undefined
  bucketIncomeAcc: string
  bucketWithdrawalAcc: string

  // From Transaction
  amount: string
  transactionId: string
  description: string
  date: string
  fromAccount: string
  toAccount: string
  bucketOverride: string | undefined // e.g., "bucket1, bucket2" - overrides suffix routing

  // Derived
  direction: Direction
  suffix: string | undefined // only set if no bucketOverride
  savingsAccountName: string
  savingsGroupName: string | undefined
}

export type SavingsDetectionResult = {
  isSavings: true
  context: SavingsContext
} | {
  isSavings: false
}

export interface DeleteResult {
  trashedCount: number
}
