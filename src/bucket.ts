import { Transaction } from 'bkper-js'
import type { Book, Account } from 'bkper-js'
import type { SavingsContext } from './types'
import { extractSuffix } from './webhook'

export interface PercentageValidationResult {
  isValid: boolean
  totalPercentage: number
  accountCount: number
}

export interface DistributionResult {
  success: boolean
  transactionCount: number
  totalDistributed: number
  skipped?: boolean
  error?: string
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

  // Build description with hashtag
  const description = context.bucketHashtag
    ? `${context.description} ${context.bucketHashtag}`
    : context.description

  // Get source/destination accounts based on direction
  const incomeAccount = await bucketBook.getAccount(context.bucketIncomeAcc)
  const withdrawalAccount = await bucketBook.getAccount(context.bucketWithdrawalAcc)

  let transactionCount = 0
  let totalDistributed = 0

  for (const bucketAccount of bucketAccounts) {
    const percentage = Number(bucketAccount.getProperties().percentage)
    const amount = totalAmount * (percentage / 100)
    const remoteId = `${context.transactionId}_${bucketAccount.getNormalizedName()}`

    const transaction = new Transaction(bucketBook)
      .setDate(context.date)
      .setAmount(amount)
      .setDescription(description)
      .addRemoteId(remoteId)

    if (context.direction === 'deposit') {
      // Savings (INCOMING) → Bucket (ASSET)
      transaction.setCreditAccount(incomeAccount!)
      transaction.setDebitAccount(bucketAccount)
    } else {
      // Bucket (ASSET) → Withdrawal (OUTGOING)
      transaction.setCreditAccount(bucketAccount)
      transaction.setDebitAccount(withdrawalAccount!)
    }

    await transaction.post()
    transactionCount++
    totalDistributed += amount
  }

  return {
    success: true,
    transactionCount,
    totalDistributed,
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

  // Build description with hashtag
  const description = context.bucketHashtag
    ? `${context.description} ${context.bucketHashtag}`
    : context.description

  // Get source/destination accounts based on direction
  const incomeAccount = await bucketBook.getAccount(context.bucketIncomeAcc)
  const withdrawalAccount = await bucketBook.getAccount(context.bucketWithdrawalAcc)

  let transactionCount = 0
  let totalDistributed = 0

  for (const { account: bucketAccount, percentage } of recalculatedAccounts) {
    const amount = totalAmount * (percentage / 100)
    const remoteId = `${context.transactionId}_${bucketAccount.getNormalizedName()}`

    const transaction = new Transaction(bucketBook)
      .setDate(context.date)
      .setAmount(amount)
      .setDescription(description)
      .addRemoteId(remoteId)

    if (context.direction === 'deposit') {
      // Savings (INCOMING) → Bucket (ASSET)
      transaction.setCreditAccount(incomeAccount!)
      transaction.setDebitAccount(bucketAccount)
    } else {
      // Bucket (ASSET) → Withdrawal (OUTGOING)
      transaction.setCreditAccount(bucketAccount)
      transaction.setDebitAccount(withdrawalAccount!)
    }

    await transaction.post()
    transactionCount++
    totalDistributed += amount
  }

  return {
    success: true,
    transactionCount,
    totalDistributed,
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

  // Build description with hashtag
  const description = context.bucketHashtag
    ? `${context.description} ${context.bucketHashtag}`
    : context.description

  // Get source/destination accounts based on direction
  const incomeAccount = await bucketBook.getAccount(context.bucketIncomeAcc)
  const withdrawalAccount = await bucketBook.getAccount(context.bucketWithdrawalAcc)

  let transactionCount = 0
  let totalDistributed = 0

  for (const bucketAccount of bucketAccounts) {
    const remoteId = `${context.transactionId}_${bucketAccount.getNormalizedName()}`

    const transaction = new Transaction(bucketBook)
      .setDate(context.date)
      .setAmount(amount)
      .setDescription(description)
      .addRemoteId(remoteId)

    if (context.direction === 'deposit') {
      // Savings (INCOMING) → Bucket (ASSET)
      transaction.setCreditAccount(incomeAccount!)
      transaction.setDebitAccount(bucketAccount)
    } else {
      // Bucket (ASSET) → Withdrawal (OUTGOING)
      transaction.setCreditAccount(bucketAccount)
      transaction.setDebitAccount(withdrawalAccount!)
    }

    await transaction.post()
    transactionCount++
    totalDistributed += amount
  }

  return {
    success: true,
    transactionCount,
    totalDistributed,
  }
}
