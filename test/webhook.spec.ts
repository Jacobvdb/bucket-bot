import { describe, it, expect } from 'vitest'
import { extractSuffix, detectSavings } from '../src/webhook'
import type { BkperWebhookPayload, BkperAccount, BkperGroup } from '../src/types'

describe('extractSuffix', () => {
  it('extracts uppercase suffix from multi-word name', () => {
    expect(extractSuffix('RDB LONG')).toBe('LONG')
  })

  it('extracts uppercase suffix from group name', () => {
    expect(extractSuffix('Savings LONG')).toBe('LONG')
  })

  it('returns undefined for single word name', () => {
    expect(extractSuffix('Provisioning')).toBeUndefined()
  })

  it('returns undefined when last word is not uppercase', () => {
    expect(extractSuffix('Bank Account')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(extractSuffix('')).toBeUndefined()
  })

  it('handles mixed case properly', () => {
    expect(extractSuffix('My Account Long')).toBeUndefined()
  })

  it('extracts suffix with multiple spaces', () => {
    expect(extractSuffix('Some  Account  LONG')).toBe('LONG')
  })
})

// Helper to create minimal test payloads
function createTestPayload(overrides: {
  creditAccountProps?: Record<string, string>
  debitAccountProps?: Record<string, string>
  creditAccountGroups?: BkperGroup[]
  debitAccountGroups?: BkperGroup[]
  creditAccountName?: string
  debitAccountName?: string
  bucketBookId?: string
  transactionProps?: Record<string, string>
}): BkperWebhookPayload {
  const bucketBookId = overrides.bucketBookId ?? 'bucket-book-id'

  return {
    id: 'event-id',
    type: 'TRANSACTION_POSTED',
    bookId: 'gl-book-id',
    resource: 'transaction-id',
    book: {
      id: 'gl-book-id',
      name: 'GL Book',
      properties: {
        bucket_book_id: bucketBookId,
      },
      collection: {
        id: 'collection-id',
        name: 'Collection',
        books: [
          {
            id: bucketBookId,
            name: 'Bucket Book',
            properties: {
              bucket_hashtag: '#savings',
              bucket_income_acc: 'Savings',
              bucket_withdrawal_acc: 'Withdrawal',
            },
          },
        ],
      },
    },
    data: {
      object: {
        transaction: {
          id: 'transaction-id',
          amount: '1000.00',
          description: 'Test transaction',
          date: '2025-01-01',
          checked: false,
          posted: true,
          draft: false,
          trashed: false,
          properties: overrides.transactionProps,
          creditAccount: {
            id: 'credit-acc-id',
            name: overrides.creditAccountName ?? 'Bank Account',
            normalizedName: 'bank_account',
            type: 'ASSET',
            credit: false,
            permanent: true,
            properties: overrides.creditAccountProps,
            groups: overrides.creditAccountGroups,
          },
          debitAccount: {
            id: 'debit-acc-id',
            name: overrides.debitAccountName ?? 'Savings Account',
            normalizedName: 'savings_account',
            type: 'ASSET',
            credit: false,
            permanent: true,
            properties: overrides.debitAccountProps,
            groups: overrides.debitAccountGroups,
          },
        },
      },
    },
  }
}

describe('detectSavings', () => {
  describe('account-level savings', () => {
    it('detects savings on debit account with direction deposit', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB LONG',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.direction).toBe('deposit')
        expect(result.context.suffix).toBe('LONG')
        expect(result.context.savingsAccountName).toBe('RDB LONG')
        expect(result.context.savingsGroupName).toBeUndefined()
      }
    })

    it('detects savings on credit account with direction withdrawal', () => {
      const payload = createTestPayload({
        creditAccountProps: { savings: 'true' },
        creditAccountName: 'RDB LONG',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.direction).toBe('withdrawal')
        expect(result.context.suffix).toBe('LONG')
        expect(result.context.savingsAccountName).toBe('RDB LONG')
      }
    })
  })

  describe('group-level savings', () => {
    it('detects savings from group when account has no savings property', () => {
      const savingsGroup: BkperGroup = {
        id: 'group-id',
        name: 'Savings LONG',
        normalizedName: 'savings_long',
        credit: false,
        permanent: true,
        properties: { savings: 'true' },
      }

      const payload = createTestPayload({
        debitAccountGroups: [savingsGroup],
        debitAccountName: 'Some Account',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.direction).toBe('deposit')
        expect(result.context.suffix).toBe('LONG')
        expect(result.context.savingsGroupName).toBe('Savings LONG')
      }
    })

    it('detects savings from credit account group with direction withdrawal', () => {
      const savingsGroup: BkperGroup = {
        id: 'group-id',
        name: 'Savings SHORT',
        normalizedName: 'savings_short',
        credit: false,
        permanent: true,
        properties: { savings: 'true' },
      }

      const payload = createTestPayload({
        creditAccountGroups: [savingsGroup],
        creditAccountName: 'Some Account',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.direction).toBe('withdrawal')
        expect(result.context.suffix).toBe('SHORT')
        expect(result.context.savingsGroupName).toBe('Savings SHORT')
      }
    })

    it('returns no suffix for single-word group name', () => {
      const savingsGroup: BkperGroup = {
        id: 'group-id',
        name: 'Provisioning',
        normalizedName: 'provisioning',
        credit: false,
        permanent: true,
        properties: { savings: 'true' },
      }

      const payload = createTestPayload({
        debitAccountGroups: [savingsGroup],
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.suffix).toBeUndefined()
        expect(result.context.savingsGroupName).toBe('Provisioning')
      }
    })
  })

  describe('stop conditions', () => {
    it('stops when neither account nor groups have savings', () => {
      const payload = createTestPayload({})

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(false)
    })

    it('stops when account has savings: false and no groups have savings', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'false' },
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(false)
    })

    it('stops when no bucket_book_id is configured', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        bucketBookId: '',
      })
      payload.book.properties = {}

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(false)
    })
  })

  describe('context extraction', () => {
    it('extracts all required context fields', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB LONG',
        creditAccountName: 'Bank Account',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.bucketBookId).toBe('bucket-book-id')
        expect(result.context.bucketHashtag).toBe('#savings')
        expect(result.context.bucketIncomeAcc).toBe('Savings')
        expect(result.context.bucketWithdrawalAcc).toBe('Withdrawal')
        expect(result.context.amount).toBe('1000.00')
        expect(result.context.transactionId).toBe('transaction-id')
        expect(result.context.description).toBe('Test transaction')
        expect(result.context.date).toBe('2025-01-01')
        expect(result.context.fromAccount).toBe('Bank Account')
        expect(result.context.toAccount).toBe('RDB LONG')
      }
    })

    it('extracts savingsAccountId from the savings account', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB LONG',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.savingsAccountId).toBe('debit-acc-id')
        expect(result.context.savingsAccountNormalizedName).toBe('savings_account')
      }
    })

    it('extracts savingsAccountId from credit account when withdrawal', () => {
      const payload = createTestPayload({
        creditAccountProps: { savings: 'true' },
        creditAccountName: 'RDB LONG',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.savingsAccountId).toBe('credit-acc-id')
        expect(result.context.savingsAccountNormalizedName).toBe('bank_account')
      }
    })
  })

  describe('suffix from account groups', () => {
    it('extracts suffix from account groups when account has savings:true but no suffix in name', () => {
      const groupWithSuffix: BkperGroup = {
        id: 'group-id',
        name: 'Savings LONG',
        normalizedName: 'savings_long',
        credit: false,
        permanent: true,
        // Note: group does NOT have savings:true, only the account does
      }

      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB', // No suffix in account name
        debitAccountGroups: [groupWithSuffix], // Group has suffix
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.suffix).toBe('LONG')
        expect(result.context.savingsAccountName).toBe('RDB')
        expect(result.context.savingsGroupName).toBeUndefined() // savingsGroup is undefined because savings detected at account level
      }
    })

    it('uses first matching suffix from multiple groups', () => {
      const group1: BkperGroup = {
        id: 'group-1',
        name: 'No Suffix Here',
        normalizedName: 'no_suffix_here',
        credit: false,
        permanent: true,
      }
      const group2: BkperGroup = {
        id: 'group-2',
        name: 'Provisioning LONG',
        normalizedName: 'provisioning_long',
        credit: false,
        permanent: true,
      }

      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB',
        debitAccountGroups: [group1, group2],
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.suffix).toBe('LONG')
      }
    })

    it('returns no suffix when account and groups have no suffix', () => {
      const groupNoSuffix: BkperGroup = {
        id: 'group-id',
        name: 'Savings',
        normalizedName: 'savings',
        credit: false,
        permanent: true,
      }

      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB',
        debitAccountGroups: [groupNoSuffix],
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.suffix).toBeUndefined()
      }
    })
  })

  describe('bucket override', () => {
    it('extracts bucketOverride from transaction properties', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB LONG',
        transactionProps: { bucket: 'bucket1, bucket2' },
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.bucketOverride).toBe('bucket1, bucket2')
      }
    })

    it('skips suffix extraction when bucketOverride is present', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB LONG',
        transactionProps: { bucket: 'bucket1' },
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.bucketOverride).toBe('bucket1')
        expect(result.context.suffix).toBeUndefined()
      }
    })

    it('extracts suffix when no bucketOverride', () => {
      const payload = createTestPayload({
        debitAccountProps: { savings: 'true' },
        debitAccountName: 'RDB LONG',
      })

      const result = detectSavings(payload)

      expect(result.isSavings).toBe(true)
      if (result.isSavings) {
        expect(result.context.bucketOverride).toBeUndefined()
        expect(result.context.suffix).toBe('LONG')
      }
    })
  })
})
