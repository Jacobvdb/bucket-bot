import type { Book } from 'bkper-js'

export interface PercentageValidationResult {
  isValid: boolean
  totalPercentage: number
  accountCount: number
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
