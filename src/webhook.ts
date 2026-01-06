import type {
  BkperWebhookPayload,
  BkperAccount,
  BkperGroup,
  BkperBook,
  SavingsContext,
  SavingsDetectionResult,
  Direction,
} from './types'

/**
 * Check if an account has savings: "true" property
 */
function accountHasSavings(account: BkperAccount): boolean {
  return account.properties?.savings === 'true'
}

/**
 * Check if an account has savings: "false" property (explicitly disabled)
 */
function accountHasSavingsFalse(account: BkperAccount): boolean {
  return account.properties?.savings === 'false'
}

/**
 * Find a group with savings: "true" property in an account's groups
 * Returns the first group found with savings: "true", or undefined
 */
function findSavingsGroup(account: BkperAccount): BkperGroup | undefined {
  if (!account.groups) return undefined
  return account.groups.find((group) => group.properties?.savings === 'true')
}

/**
 * Extract suffix from a name (last uppercase word)
 * Returns undefined if name is a single word or last word is not uppercase
 *
 * Examples:
 * - "RDB LONG" → "LONG"
 * - "Savings LONG" → "LONG"
 * - "Provisioning" → undefined (single word)
 * - "Bank Account" → undefined (last word not uppercase)
 */
export function extractSuffix(name: string): string | undefined {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return undefined

  const lastWord = parts[parts.length - 1]
  if (lastWord === lastWord.toUpperCase() && /^[A-Z]+$/.test(lastWord)) {
    return lastWord
  }
  return undefined
}

/**
 * Extract suffix from an account by checking:
 * 1. Account name
 * 2. Account's groups
 *
 * Used for account initialization when savings:true is added.
 */
export function extractSuffixFromAccount(account: BkperAccount): string | undefined {
  // Try account name first
  let suffix = extractSuffix(account.name)

  // If no suffix, check account's groups
  if (!suffix && account.groups) {
    for (const group of account.groups) {
      suffix = extractSuffix(group.name)
      if (suffix) break
    }
  }

  return suffix
}

/**
 * Find the bucket book in the collection by ID
 */
function findBucketBook(payload: BkperWebhookPayload, bucketBookId: string): BkperBook | undefined {
  return payload.book.collection?.books?.find((book) => book.id === bucketBookId)
}

/**
 * Detect if the transaction involves a savings account and extract context
 */
export function detectSavings(payload: BkperWebhookPayload): SavingsDetectionResult {
  const transaction = payload.data.object.transaction
  const creditAccount = transaction.creditAccount
  const debitAccount = transaction.debitAccount

  // Get bucket_book_id from GL book properties
  const bucketBookId = payload.book.properties?.bucket_book_id
  if (!bucketBookId) {
    return { isSavings: false }
  }

  // Find the bucket book in the collection
  const bucketBook = findBucketBook(payload, bucketBookId)
  if (!bucketBook) {
    return { isSavings: false }
  }

  // Check for savings on accounts first
  let savingsAccount: BkperAccount | undefined
  let savingsGroup: BkperGroup | undefined
  let direction: Direction

  // Check debit account (to) for savings
  if (accountHasSavings(debitAccount)) {
    savingsAccount = debitAccount
    direction = 'deposit'
  }
  // Check credit account (from) for savings
  else if (accountHasSavings(creditAccount)) {
    savingsAccount = creditAccount
    direction = 'withdrawal'
  }
  // Check groups if accounts don't have savings property (and not explicitly false)
  else {
    // Check debit account groups
    if (!accountHasSavingsFalse(debitAccount)) {
      savingsGroup = findSavingsGroup(debitAccount)
      if (savingsGroup) {
        savingsAccount = debitAccount
        direction = 'deposit'
      }
    }

    // Check credit account groups if not found yet
    if (!savingsAccount && !accountHasSavingsFalse(creditAccount)) {
      savingsGroup = findSavingsGroup(creditAccount)
      if (savingsGroup) {
        savingsAccount = creditAccount
        direction = 'withdrawal'
      }
    }
  }

  // No savings found
  if (!savingsAccount) {
    return { isSavings: false }
  }

  // Get bucket override from transaction properties (takes precedence over suffix)
  const bucketOverride = transaction.properties?.bucket

  // Only extract suffix if no bucket override (saves processing time)
  let suffix: string | undefined
  if (!bucketOverride) {
    // Try savingsGroup first (if savings detected via group)
    if (savingsGroup) {
      suffix = extractSuffix(savingsGroup.name)
    }
    // Otherwise try account name
    if (!suffix) {
      suffix = extractSuffix(savingsAccount.name)
    }
    // If still no suffix, check account's groups
    if (!suffix && savingsAccount.groups) {
      for (const group of savingsAccount.groups) {
        suffix = extractSuffix(group.name)
        if (suffix) break
      }
    }
  }

  // Build context
  const context: SavingsContext = {
    bucketBookId,
    bucketHashtag: bucketBook.properties?.bucket_hashtag,
    bucketIncomeAcc: bucketBook.properties?.bucket_income_acc ?? 'Savings',
    bucketWithdrawalAcc: bucketBook.properties?.bucket_withdrawal_acc ?? 'Withdrawal',
    amount: transaction.amount,
    transactionId: transaction.id,
    description: transaction.description,
    date: transaction.date,
    fromAccount: creditAccount.name,
    toAccount: debitAccount.name,
    bucketOverride,
    direction: direction!,
    suffix,
    savingsAccountName: savingsAccount.name,
    savingsAccountId: savingsAccount.id,
    savingsAccountNormalizedName: savingsAccount.normalizedName,
    savingsGroupName: savingsGroup?.name,
  }

  return { isSavings: true, context }
}
