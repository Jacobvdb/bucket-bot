import { describe, it, expect } from 'vitest'
import { validatePercentages, distributeToAllBuckets, accountMatchesSuffix } from '../src/bucket'
import type { Book, Account, Group } from 'bkper-js'
import type { SavingsContext } from '../src/types'

// Helper to create mock group
function createMockGroup(name: string): Group {
  return {
    getName: () => name,
  } as unknown as Group
}

// Helper to create mock accounts
function createMockAccount(
  type: 'ASSET' | 'LIABILITY' | 'INCOMING' | 'OUTGOING',
  name: string,
  percentage?: string,
  groups?: Group[]
): Account {
  return {
    getType: () => type,
    getName: () => name,
    getProperties: () => percentage !== undefined ? { percentage } : {},
    getGroups: async () => groups || [],
  } as unknown as Account
}

// Helper for validation tests (simpler mock)
function createSimpleMockAccount(type: 'ASSET' | 'LIABILITY' | 'INCOMING' | 'OUTGOING', percentage?: string): Account {
  return {
    getType: () => type,
    getProperties: () => percentage !== undefined ? { percentage } : {},
  } as unknown as Account
}

// Helper to create mock book with accounts
function createMockBook(accounts: Account[]): Book {
  return {
    getAccounts: async () => accounts,
  } as unknown as Book
}

// Helper to create mock context
function createMockContext(overrides: Partial<SavingsContext> = {}): SavingsContext {
  return {
    bucketBookId: 'bucket-book-id',
    bucketHashtag: '#in_spaarpot',
    bucketIncomeAcc: 'Savings',
    bucketWithdrawalAcc: 'Withdrawal',
    amount: '1000',
    transactionId: 'tx-id',
    description: 'test deposit',
    date: '2025-01-01',
    fromAccount: 'Bank',
    toAccount: 'RDB',
    bucketOverride: undefined,
    direction: 'deposit',
    suffix: undefined,
    savingsAccountName: 'RDB',
    savingsGroupName: undefined,
    ...overrides,
  }
}

describe('validatePercentages', () => {
  it('returns valid when ASSET accounts sum to 100%', async () => {
    const book = createMockBook([
      createSimpleMockAccount('ASSET', '50'),
      createSimpleMockAccount('ASSET', '30'),
      createSimpleMockAccount('ASSET', '20'),
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(true)
    expect(result.totalPercentage).toBe(100)
    expect(result.accountCount).toBe(3)
  })

  it('returns invalid when ASSET accounts sum to less than 100%', async () => {
    const book = createMockBook([
      createSimpleMockAccount('ASSET', '50'),
      createSimpleMockAccount('ASSET', '30'),
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(false)
    expect(result.totalPercentage).toBe(80)
    expect(result.accountCount).toBe(2)
  })

  it('returns invalid when ASSET accounts sum to more than 100%', async () => {
    const book = createMockBook([
      createSimpleMockAccount('ASSET', '60'),
      createSimpleMockAccount('ASSET', '50'),
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(false)
    expect(result.totalPercentage).toBe(110)
    expect(result.accountCount).toBe(2)
  })

  it('ignores INCOMING accounts', async () => {
    const book = createMockBook([
      createSimpleMockAccount('ASSET', '100'),
      createSimpleMockAccount('INCOMING'), // Savings - no percentage
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(true)
    expect(result.totalPercentage).toBe(100)
    expect(result.accountCount).toBe(1)
  })

  it('ignores ASSET accounts without percentage property', async () => {
    const book = createMockBook([
      createSimpleMockAccount('ASSET', '100'),
      createSimpleMockAccount('ASSET'), // No percentage property
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(true)
    expect(result.totalPercentage).toBe(100)
    expect(result.accountCount).toBe(1)
  })

  it('returns invalid when no accounts have percentage', async () => {
    const book = createMockBook([
      createSimpleMockAccount('INCOMING'), // Savings
      createSimpleMockAccount('OUTGOING'), // Withdrawal
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(false)
    expect(result.totalPercentage).toBe(0)
    expect(result.accountCount).toBe(0)
  })
})

describe('distributeToAllBuckets', () => {
  it('skips distribution when suffix is present', async () => {
    const book = createMockBook([
      createMockAccount('ASSET', 'Bucket1', '100'),
    ])
    const context = createMockContext({ suffix: 'LONG' })

    const result = await distributeToAllBuckets(book, context)

    expect(result.success).toBe(true)
    expect(result.transactionCount).toBe(0)
    expect(result.skipped).toBe(true)
  })

  it('skips distribution when bucketOverride is present', async () => {
    const book = createMockBook([
      createMockAccount('ASSET', 'Bucket1', '100'),
    ])
    const context = createMockContext({ bucketOverride: 'bucket1' })

    const result = await distributeToAllBuckets(book, context)

    expect(result.success).toBe(true)
    expect(result.transactionCount).toBe(0)
    expect(result.skipped).toBe(true)
  })

  // Note: Integration tests for actual transaction creation would require
  // mocking the full bkper-js Transaction class which has complex internals.
  // The actual distribution logic is tested via deployment/manual testing.
})

describe('accountMatchesSuffix', () => {
  it('matches when account name ends with suffix', async () => {
    const account = createMockAccount('ASSET', 'New Car LONG', '10')
    const result = await accountMatchesSuffix(account, 'LONG')
    expect(result).toBe(true)
  })

  it('matches when account belongs to group ending with suffix', async () => {
    const group = createMockGroup('Provisioning LONG')
    const account = createMockAccount('ASSET', 'Health Insurance', '10', [group])
    const result = await accountMatchesSuffix(account, 'LONG')
    expect(result).toBe(true)
  })

  it('does not match when neither account nor group has suffix', async () => {
    const group = createMockGroup('Low')
    const account = createMockAccount('ASSET', 'Emergency Reserve', '10', [group])
    const result = await accountMatchesSuffix(account, 'LONG')
    expect(result).toBe(false)
  })

  it('matches by account suffix even when group has different suffix', async () => {
    const group = createMockGroup('Some Group MID')
    const account = createMockAccount('ASSET', 'New Car LONG', '10', [group])
    const result = await accountMatchesSuffix(account, 'LONG')
    expect(result).toBe(true)
  })

  it('matches by group suffix even when account has different suffix', async () => {
    const group = createMockGroup('Provisioning LONG')
    const account = createMockAccount('ASSET', 'IPVA MID', '10', [group])
    const result = await accountMatchesSuffix(account, 'LONG')
    expect(result).toBe(true)
  })

  it('matches when any of multiple groups has the suffix', async () => {
    const group1 = createMockGroup('Low')
    const group2 = createMockGroup('New Stuff LONG')
    const account = createMockAccount('ASSET', 'New Phone', '10', [group1, group2])
    const result = await accountMatchesSuffix(account, 'LONG')
    expect(result).toBe(true)
  })
})
