import { describe, it, expect } from 'vitest'
import { validatePercentages } from '../src/bucket'
import type { Book, Account } from 'bkper-js'

// Helper to create mock accounts
function createMockAccount(type: 'ASSET' | 'LIABILITY' | 'INCOMING' | 'OUTGOING', percentage?: string): Account {
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

describe('validatePercentages', () => {
  it('returns valid when ASSET accounts sum to 100%', async () => {
    const book = createMockBook([
      createMockAccount('ASSET', '50'),
      createMockAccount('ASSET', '30'),
      createMockAccount('ASSET', '20'),
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(true)
    expect(result.totalPercentage).toBe(100)
    expect(result.accountCount).toBe(3)
  })

  it('returns invalid when ASSET accounts sum to less than 100%', async () => {
    const book = createMockBook([
      createMockAccount('ASSET', '50'),
      createMockAccount('ASSET', '30'),
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(false)
    expect(result.totalPercentage).toBe(80)
    expect(result.accountCount).toBe(2)
  })

  it('returns invalid when ASSET accounts sum to more than 100%', async () => {
    const book = createMockBook([
      createMockAccount('ASSET', '60'),
      createMockAccount('ASSET', '50'),
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(false)
    expect(result.totalPercentage).toBe(110)
    expect(result.accountCount).toBe(2)
  })

  it('ignores INCOMING accounts', async () => {
    const book = createMockBook([
      createMockAccount('ASSET', '100'),
      createMockAccount('INCOMING'), // Savings - no percentage
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(true)
    expect(result.totalPercentage).toBe(100)
    expect(result.accountCount).toBe(1)
  })

  it('ignores ASSET accounts without percentage property', async () => {
    const book = createMockBook([
      createMockAccount('ASSET', '100'),
      createMockAccount('ASSET'), // No percentage property
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(true)
    expect(result.totalPercentage).toBe(100)
    expect(result.accountCount).toBe(1)
  })

  it('returns invalid when no accounts have percentage', async () => {
    const book = createMockBook([
      createMockAccount('INCOMING'), // Savings
      createMockAccount('OUTGOING'), // Withdrawal
    ])

    const result = await validatePercentages(book)

    expect(result.isValid).toBe(false)
    expect(result.totalPercentage).toBe(0)
    expect(result.accountCount).toBe(0)
  })
})
