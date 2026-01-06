import { Transaction } from 'bkper-js'
import type { Book, Account } from 'bkper-js'
import type { SavingsContext } from './types'
import { extractSuffix } from './webhook'

/**
 * Build a unique remote ID with timestamp to avoid idempotency conflicts.
 * Format: {identifier}_{normalizedAccountName}_{timestamp}
 * For initialization: init_{accountId}_{normalizedAccountName}_{timestamp}
 */
function buildRemoteId(
  identifier: string,
  normalizedAccountName: string,
  isInitialization?: boolean
): string {
  const timestamp = Date.now()
  const prefix = isInitialization ? 'init_' : ''
  return `${prefix}${identifier}_${normalizedAccountName}_${timestamp}`
}

export interface PercentageValidationResult {
  isValid: boolean
  totalPercentage: number
  accountCount: number
}

export interface ValidationResult {
  isBalanced: boolean
  glTotal: number
  bucketTotal: number
  difference: number
}

export interface DistributionResult {
  success: boolean
  transactionCount: number
  totalDistributed: number
  skipped?: boolean
  error?: string
  transactions?: Transaction[]
}

/**
 * Check if an account matches a suffix by:
 * 1. Account name ending with the suffix (e.g., "New Car LONG" matches "LONG")
 * 2. OR account belonging to a group ending with the suffix (e.g., group "Provisioning LONG")
 */
export async function accountMatchesSuffix(account: Account, suffix: string): Promise<boolean> {
  // Check account name for suffix
  const accountName = account.getName()
  const accountSuffix = extractSuffix(accountName)
  if (accountSuffix === suffix) return true

  // Check if any group has the suffix
  const groups = await account.getGroups()
  for (const group of groups) {
    const groupSuffix = extractSuffix(group.getName())
    if (groupSuffix === suffix) return true
  }

  return false
}

export async function validatePercentages(bucketBook: Book): Promise<PercentageValidationResult> {
  const accounts = await bucketBook.getAccounts()

  let totalPercentage = 0
  let accountCount = 0

  for (const account of accounts) {
    if (account.getType() !== 'ASSET') {
      continue
    }

    const percentage = account.getProperties().percentage
    if (percentage === undefined) {
      continue
    }

    totalPercentage += Number(percentage)
    accountCount++
  }

  return {
    isValid: totalPercentage === 100,
    totalPercentage,
    accountCount,
  }
}

export async function distributeToAllBuckets(
  bucketBook: Book,
  context: SavingsContext
): Promise<DistributionResult> {
  // Skip if suffix or bucketOverride exists (not basic distribution)
  if (context.suffix || context.bucketOverride) {
    return {
      success: true,
      transactionCount: 0,
      totalDistributed: 0,
      skipped: true,
    }
  }

  const accounts = await bucketBook.getAccounts()
  const totalAmount = Number(context.amount)

  // Get bucket accounts (ASSET with percentage property)
  const bucketAccounts = accounts.filter(account => {
    if (account.getType() !== 'ASSET') return false
    const percentage = account.getProperties().percentage
    return percentage !== undefined
  })

  // Build description with hashtags (bucket hashtag + GL account hashtag)
  const glHashtag = `#gl_${context.savingsAccountNormalizedName}`
  let description = context.description
  if (context.bucketHashtag) {
    description = `${description} ${context.bucketHashtag}`
  }
  description = `${description} ${glHashtag}`

  // Get source/destination accounts based on direction
  const incomeAccount = await bucketBook.getAccount(context.bucketIncomeAcc)
  const withdrawalAccount = await bucketBook.getAccount(context.bucketWithdrawalAcc)

  let transactionCount = 0
  let totalDistributed = 0
  const transactions: Transaction[] = []

  // For initialization, use savingsAccountId as identifier; for normal transactions use transactionId
  const remoteIdIdentifier = context.isInitialization ? context.savingsAccountId : context.transactionId

  for (const bucketAccount of bucketAccounts) {
    const percentage = Number(bucketAccount.getProperties().percentage)
    const amount = totalAmount * (percentage / 100)
    const remoteId = buildRemoteId(remoteIdIdentifier, bucketAccount.getNormalizedName(), context.isInitialization)

    const transaction = new Transaction(bucketBook)
      .setDate(context.date)
      .setAmount(amount)
      .setDescription(description)
      .addRemoteId(remoteId)
      .setProperty('gl_account_id', context.savingsAccountId)

    if (context.direction === 'deposit') {
      // Savings (INCOMING) → Bucket (ASSET)
      transaction.setCreditAccount(incomeAccount!)
      transaction.setDebitAccount(bucketAccount)
    } else {
      // Bucket (ASSET) → Withdrawal (OUTGOING)
      transaction.setCreditAccount(bucketAccount)
      transaction.setDebitAccount(withdrawalAccount!)
    }

    const postedTransaction = await transaction.post()
    transactions.push(postedTransaction)
    transactionCount++
    totalDistributed += amount
  }

  return {
    success: true,
    transactionCount,
    totalDistributed,
    transactions,
  }
}

/**
 * Distribute to bucket accounts matching a suffix.
 * Percentages are recalculated to sum to 100% for the filtered accounts.
 */
export async function distributeToSuffixBuckets(
  bucketBook: Book,
  context: SavingsContext
): Promise<DistributionResult> {
  const suffix = context.suffix
  if (!suffix) {
    return {
      success: false,
      transactionCount: 0,
      totalDistributed: 0,
      error: 'No suffix provided',
    }
  }

  const accounts = await bucketBook.getAccounts()
  const totalAmount = Number(context.amount)

  // Filter to ASSET accounts with percentage that match the suffix
  const matchingAccounts: { account: Account; originalPercentage: number }[] = []

  for (const account of accounts) {
    if (account.getType() !== 'ASSET') continue

    const percentage = account.getProperties().percentage
    if (percentage === undefined) continue

    const matches = await accountMatchesSuffix(account, suffix)
    if (matches) {
      matchingAccounts.push({
        account,
        originalPercentage: Number(percentage),
      })
    }
  }

  // Check if any accounts matched
  if (matchingAccounts.length === 0) {
    return {
      success: false,
      transactionCount: 0,
      totalDistributed: 0,
      error: `No accounts match suffix '${suffix}' in bucket book`,
    }
  }

  // Calculate sum of original percentages and recalculate to 100%
  const sumOfOriginal = matchingAccounts.reduce((sum, a) => sum + a.originalPercentage, 0)

  // Recalculate percentages to sum to 100%
  const recalculatedAccounts = matchingAccounts.map((a, index) => {
    let newPercentage = (a.originalPercentage / sumOfOriginal) * 100
    return {
      account: a.account,
      percentage: newPercentage,
    }
  })

  // Handle rounding to ensure sum is exactly 100%
  const sumRecalculated = recalculatedAccounts.reduce((sum, a) => sum + a.percentage, 0)
  const remainder = 100 - sumRecalculated
  if (Math.abs(remainder) > 0.0001 && recalculatedAccounts.length > 0) {
    recalculatedAccounts[0].percentage += remainder
  }

  // Build description with hashtags (bucket hashtag + GL account hashtag)
  const glHashtag = `#gl_${context.savingsAccountNormalizedName}`
  let description = context.description
  if (context.bucketHashtag) {
    description = `${description} ${context.bucketHashtag}`
  }
  description = `${description} ${glHashtag}`

  // Get source/destination accounts based on direction
  const incomeAccount = await bucketBook.getAccount(context.bucketIncomeAcc)
  const withdrawalAccount = await bucketBook.getAccount(context.bucketWithdrawalAcc)

  let transactionCount = 0
  let totalDistributed = 0
  const transactions: Transaction[] = []

  // For initialization, use savingsAccountId as identifier; for normal transactions use transactionId
  const remoteIdIdentifier = context.isInitialization ? context.savingsAccountId : context.transactionId

  for (const { account: bucketAccount, percentage } of recalculatedAccounts) {
    const amount = totalAmount * (percentage / 100)
    const remoteId = buildRemoteId(remoteIdIdentifier, bucketAccount.getNormalizedName(), context.isInitialization)

    const transaction = new Transaction(bucketBook)
      .setDate(context.date)
      .setAmount(amount)
      .setDescription(description)
      .addRemoteId(remoteId)
      .setProperty('gl_account_id', context.savingsAccountId)

    if (context.direction === 'deposit') {
      // Savings (INCOMING) → Bucket (ASSET)
      transaction.setCreditAccount(incomeAccount!)
      transaction.setDebitAccount(bucketAccount)
    } else {
      // Bucket (ASSET) → Withdrawal (OUTGOING)
      transaction.setCreditAccount(bucketAccount)
      transaction.setDebitAccount(withdrawalAccount!)
    }

    const postedTransaction = await transaction.post()
    transactions.push(postedTransaction)
    transactionCount++
    totalDistributed += amount
  }

  return {
    success: true,
    transactionCount,
    totalDistributed,
    transactions,
  }
}

/**
 * Distribute to specific bucket accounts listed in bucketOverride.
 * Amount is distributed equally among all listed accounts.
 */
export async function distributeToOverrideBuckets(
  bucketBook: Book,
  context: SavingsContext
): Promise<DistributionResult> {
  if (!context.bucketOverride) {
    return {
      success: false,
      transactionCount: 0,
      totalDistributed: 0,
      error: 'No bucket override provided',
    }
  }

  // Parse comma-separated account names
  const accountNames = context.bucketOverride.split(',').map(name => name.trim())
  const totalAmount = Number(context.amount)

  // Look up each account by exact name
  const bucketAccounts: Account[] = []
  const missingAccounts: string[] = []

  for (const name of accountNames) {
    const account = await bucketBook.getAccount(name)
    if (account) {
      bucketAccounts.push(account)
    } else {
      missingAccounts.push(name)
    }
  }

  // Return error if any accounts are missing
  if (missingAccounts.length > 0) {
    return {
      success: false,
      transactionCount: 0,
      totalDistributed: 0,
      error: `Accounts not found: ${missingAccounts.join(', ')}`,
    }
  }

  // Calculate equal percentage for each account
  const percentage = 100 / bucketAccounts.length
  const amount = totalAmount * (percentage / 100)

  // Build description with hashtags (bucket hashtag + GL account hashtag)
  const glHashtag = `#gl_${context.savingsAccountNormalizedName}`
  let description = context.description
  if (context.bucketHashtag) {
    description = `${description} ${context.bucketHashtag}`
  }
  description = `${description} ${glHashtag}`

  // Get source/destination accounts based on direction
  const incomeAccount = await bucketBook.getAccount(context.bucketIncomeAcc)
  const withdrawalAccount = await bucketBook.getAccount(context.bucketWithdrawalAcc)

  let transactionCount = 0
  let totalDistributed = 0
  const transactions: Transaction[] = []

  for (const bucketAccount of bucketAccounts) {
    const remoteId = buildRemoteId(context.transactionId, bucketAccount.getNormalizedName())

    const transaction = new Transaction(bucketBook)
      .setDate(context.date)
      .setAmount(amount)
      .setDescription(description)
      .addRemoteId(remoteId)
      .setProperty('gl_account_id', context.savingsAccountId)

    if (context.direction === 'deposit') {
      // Savings (INCOMING) → Bucket (ASSET)
      transaction.setCreditAccount(incomeAccount!)
      transaction.setDebitAccount(bucketAccount)
    } else {
      // Bucket (ASSET) → Withdrawal (OUTGOING)
      transaction.setCreditAccount(bucketAccount)
      transaction.setDebitAccount(withdrawalAccount!)
    }

    const postedTransaction = await transaction.post()
    transactions.push(postedTransaction)
    transactionCount++
    totalDistributed += amount
  }

  return {
    success: true,
    transactionCount,
    totalDistributed,
    transactions,
  }
}

/**
 * Find all bucket transactions that originated from a specific GL transaction.
 * Uses optimized query with hashtag and date, then filters by remoteId prefix.
 *
 * @param book - The bucket book to search
 * @param hashtag - The bucket hashtag to filter by (e.g., "#bucket-sync")
 * @param date - The transaction date in YYYY-MM-DD format
 * @param glTransactionId - The GL transaction ID to find bucket transactions for
 * @param expectedCount - Optional: stop early when this many transactions are found
 * @returns Array of matching Transaction objects
 */
export async function findBucketTransactionsByGlId(
  book: Book,
  hashtag: string,
  date: string,
  glTransactionId: string,
  expectedCount?: number
): Promise<Transaction[]> {
  const matchingTransactions: Transaction[] = []
  const query = `${hashtag} on:${date}`
  const remoteIdPrefix = `${glTransactionId}_`

  let transactionList = await book.listTransactions(query)

  while (true) {
    const transactions = transactionList.getItems()

    if (transactions.length === 0) {
      break
    }

    for (const tx of transactions) {
      const remoteIds = tx.getRemoteIds()
      if (remoteIds) {
        for (const remoteId of remoteIds) {
          if (remoteId.startsWith(remoteIdPrefix)) {
            matchingTransactions.push(tx)
            // Early termination if we found all expected transactions
            if (expectedCount && matchingTransactions.length >= expectedCount) {
              return matchingTransactions
            }
            break // Don't add same transaction twice
          }
        }
      }
    }

    const cursor = transactionList.getCursor()
    if (!cursor) {
      break
    }

    transactionList = await book.listTransactions(query, undefined, cursor)
  }

  return matchingTransactions
}

/**
 * Trash bucket transactions using batch operation.
 * Uses batchTrashTransactions with trashChecked=true to handle both
 * unchecking and trashing in a single API call.
 *
 * @param book - The bucket book
 * @param transactions - The transactions to trash
 * @returns The number of transactions trashed
 */
export async function trashBucketTransactions(
  book: Book,
  transactions: Transaction[]
): Promise<number> {
  if (transactions.length === 0) {
    return 0
  }

  await book.batchTrashTransactions(transactions, true)
  return transactions.length
}

/**
 * Cleanup bucket transactions for a GL transaction before redistribution.
 * Finds existing bucket transactions by GL ID and trashes them.
 *
 * @param book - The bucket book
 * @param hashtag - The bucket hashtag to filter by
 * @param date - The transaction date in YYYY-MM-DD format
 * @param glTransactionId - The GL transaction ID
 * @param expectedCount - Optional: stop early when this many transactions are found
 * @returns The number of transactions trashed
 */
const VERIFY_MAX_RETRIES = 5
const VERIFY_RETRY_DELAY_MS = 500

/**
 * Verify that all transactions have been trashed by checking their isTrashed status.
 * Retries with delay if transactions are not yet trashed.
 *
 * @param book - The bucket book
 * @param transactions - The transactions to verify
 * @param maxRetries - Maximum number of retries (default: 5)
 * @param retryDelayMs - Delay between retries in milliseconds (default: 500)
 */
export async function verifyTransactionsTrashed(
  book: Book,
  transactions: Transaction[],
  maxRetries: number = VERIFY_MAX_RETRIES,
  retryDelayMs: number = VERIFY_RETRY_DELAY_MS
): Promise<void> {
  if (transactions.length === 0) {
    return
  }

  const transactionIds = transactions.map(tx => tx.getId())
  let pendingIds = [...transactionIds]
  let retryCount = 0

  while (pendingIds.length > 0 && retryCount <= maxRetries) {
    const stillPending: string[] = []

    for (const id of pendingIds) {
      const tx = await book.getTransaction(id)
      if (tx && !tx.isTrashed()) {
        stillPending.push(id)
      }
    }

    if (stillPending.length === 0) {
      console.log(`[VERIFY] All ${transactionIds.length} transactions confirmed trashed`)
      return
    }

    pendingIds = stillPending
    retryCount++

    if (retryCount <= maxRetries) {
      console.log(`[VERIFY] ${stillPending.length} transactions not yet trashed, retry ${retryCount}/${maxRetries}`)
      await new Promise(resolve => setTimeout(resolve, retryDelayMs))
    }
  }

  console.warn(`[VERIFY] ${pendingIds.length} transactions still not trashed after ${maxRetries} retries`)
}

export async function cleanupBucketTransactions(
  book: Book,
  hashtag: string,
  date: string,
  glTransactionId: string,
  expectedCount?: number
): Promise<number> {
  const bucketTransactions = await findBucketTransactionsByGlId(
    book,
    hashtag,
    date,
    glTransactionId,
    expectedCount
  )

  if (bucketTransactions.length === 0) {
    return 0
  }

  // Trash the transactions
  await book.batchTrashTransactions(bucketTransactions, true)

  // Verify all transactions are actually trashed before returning
  // This prevents race conditions where new transactions are posted
  // before the old ones are fully processed
  await verifyTransactionsTrashed(book, bucketTransactions)

  return bucketTransactions.length
}

/**
 * Find all bucket transactions linked to a specific GL account ID.
 * Queries by gl_account_id property without date filtering to get ALL transactions.
 *
 * @param book - The bucket book to search
 * @param glAccountId - The GL account ID to find bucket transactions for
 * @returns Array of matching Transaction objects
 */
export async function findBucketTransactionsByGlAccountId(
  book: Book,
  glAccountId: string
): Promise<Transaction[]> {
  const allTransactions: Transaction[] = []
  const query = `gl_account_id:"${glAccountId}"`

  console.log(`[ACCOUNT_CLEANUP] Querying bucket transactions: ${query}`)

  let transactionList = await book.listTransactions(query)

  while (true) {
    const transactions = transactionList.getItems()

    if (transactions.length === 0) {
      break
    }

    allTransactions.push(...transactions)
    console.log(`[ACCOUNT_CLEANUP] Found ${transactions.length} transactions (total: ${allTransactions.length})`)

    const cursor = transactionList.getCursor()
    if (!cursor) {
      break
    }

    transactionList = await book.listTransactions(query, undefined, cursor)
  }

  return allTransactions
}

/**
 * Cleanup all bucket transactions for a GL account when savings:true is removed.
 * Finds all transactions with gl_account_id property and trashes them.
 *
 * @param book - The bucket book
 * @param glAccountId - The GL account ID whose transactions should be trashed
 * @returns The number of transactions trashed
 */
export async function cleanupBucketTransactionsForAccount(
  book: Book,
  glAccountId: string
): Promise<number> {
  const bucketTransactions = await findBucketTransactionsByGlAccountId(book, glAccountId)

  if (bucketTransactions.length === 0) {
    console.log(`[ACCOUNT_CLEANUP] No bucket transactions found for gl_account_id: ${glAccountId}`)
    return 0
  }

  console.log(`[ACCOUNT_CLEANUP] Trashing ${bucketTransactions.length} bucket transactions for gl_account_id: ${glAccountId}`)

  // Trash the transactions (trashChecked=true handles checked transactions)
  await book.batchTrashTransactions(bucketTransactions, true)

  // Verify all transactions are actually trashed
  await verifyTransactionsTrashed(book, bucketTransactions)

  console.log(`[ACCOUNT_CLEANUP] Successfully trashed ${bucketTransactions.length} transactions`)

  return bucketTransactions.length
}

const BALANCE_TOLERANCE = 0.01

/**
 * Get total balance for GL accounts with savings:true property.
 * Loads accounts, filters by property, then queries balances.
 */
async function getGlSavingsTotal(glBook: Book): Promise<number> {
  const accounts = await glBook.getAccounts()

  // Filter for accounts with savings:true property
  const savingsAccounts = accounts.filter(account => {
    const props = account.getProperties()
    return props.savings === 'true'
  })

  if (savingsAccounts.length === 0) {
    return 0
  }

  // Build OR query for all savings accounts
  const query = savingsAccounts
    .map(acc => `account:"${acc.getName()}"`)
    .join(' or ')

  const balancesReport = await glBook.getBalancesReport(query)
  const containers = balancesReport.getBalancesContainers()

  let total = 0
  for (const container of containers) {
    total += container.getCumulativeBalance().toNumber()
  }

  return total
}

/**
 * Get total balance for bucket accounts with percentage property.
 * Loads accounts, filters by property, then queries balances.
 */
async function getBucketTotal(bucketBook: Book): Promise<number> {
  const accounts = await bucketBook.getAccounts()

  // Filter for ASSET accounts with percentage property
  const bucketAccounts = accounts.filter(account => {
    if (account.getType() !== 'ASSET') return false
    const props = account.getProperties()
    return props.percentage !== undefined
  })

  if (bucketAccounts.length === 0) {
    return 0
  }

  // Build OR query for all bucket accounts
  const query = bucketAccounts
    .map(acc => `account:"${acc.getName()}"`)
    .join(' or ')

  const balancesReport = await bucketBook.getBalancesReport(query)
  const containers = balancesReport.getBalancesContainers()

  let total = 0
  for (const container of containers) {
    total += container.getCumulativeBalance().toNumber()
  }

  return total
}

/**
 * Validate that GL savings accounts total matches bucket percentage accounts total.
 *
 * @param glBook - The GL book containing savings:true accounts
 * @param bucketBook - The bucket book containing percentage accounts
 * @returns ValidationResult with isBalanced, glTotal, bucketTotal, and difference
 */
export async function validateBalances(
  glBook: Book,
  bucketBook: Book
): Promise<ValidationResult> {
  const glTotal = await getGlSavingsTotal(glBook)
  const bucketTotal = await getBucketTotal(bucketBook)
  const difference = glTotal - bucketTotal

  return {
    isBalanced: Math.abs(difference) < BALANCE_TOLERANCE,
    glTotal,
    bucketTotal,
    difference,
  }
}
