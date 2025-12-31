import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validatePercentages, distributeToAllBuckets, distributeToSuffixBuckets, distributeToOverrideBuckets, accountMatchesSuffix, findBucketTransactionsByGlId, trashBucketTransactions } from '../src/bucket'
import type { Book, Account, Group, TransactionList } from 'bkper-js'
import type { SavingsContext } from '../src/types'
import { Transaction } from 'bkper-js'

vi.mock('bkper-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bkper-js')>()
  return {
    ...actual,
    Transaction: vi.fn(),
  }
})

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
  groups?: Group[],
  normalizedName?: string
): Account {
  return {
    getType: () => type,
    getName: () => name,
    getNormalizedName: () => normalizedName || name.toLowerCase().replace(/\s+/g, '_'),
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
function createMockBook(accounts: Account[], namedAccounts?: Record<string, Account>): Book {
  return {
    getAccounts: async () => accounts,
    getAccount: async (name: string) => namedAccounts?.[name] || null,
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

// Helper to create a mock transaction that tracks method calls
function createMockTransaction() {
  const calls: { method: string; args: unknown[] }[] = []
  const mockTx: Record<string, unknown> = {}

  mockTx.setDate = vi.fn().mockImplementation((...args: unknown[]) => { calls.push({ method: 'setDate', args }); return mockTx })
  mockTx.setAmount = vi.fn().mockImplementation((...args: unknown[]) => { calls.push({ method: 'setAmount', args }); return mockTx })
  mockTx.setDescription = vi.fn().mockImplementation((...args: unknown[]) => { calls.push({ method: 'setDescription', args }); return mockTx })
  mockTx.addRemoteId = vi.fn().mockImplementation((...args: unknown[]) => { calls.push({ method: 'addRemoteId', args }); return mockTx })
  mockTx.setCreditAccount = vi.fn().mockImplementation((...args: unknown[]) => { calls.push({ method: 'setCreditAccount', args }); return mockTx })
  mockTx.setDebitAccount = vi.fn().mockImplementation((...args: unknown[]) => { calls.push({ method: 'setDebitAccount', args }); return mockTx })
  mockTx.post = vi.fn().mockResolvedValue(mockTx)
  mockTx.getCalls = () => calls

  return mockTx
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  it('sets remote ID with format transactionId_normalizedAccountName', async () => {
    const mockTx = createMockTransaction()
    vi.mocked(Transaction).mockImplementation(() => mockTx as unknown as Transaction)

    const savingsAccount = createMockAccount('INCOMING', 'Savings')
    const bucketAccount = createMockAccount('ASSET', 'New Car', '100', [], 'new_car')
    const book = createMockBook(
      [savingsAccount, bucketAccount],
      { 'Savings': savingsAccount, 'Withdrawal': createMockAccount('OUTGOING', 'Withdrawal') }
    )
    const context = createMockContext({ transactionId: 'ABCDEF123' })

    await distributeToAllBuckets(book, context)

    expect(mockTx.addRemoteId).toHaveBeenCalledWith('ABCDEF123_new_car')
  })

  it('creates unique remote IDs for multiple bucket accounts', async () => {
    const mockTransactions: ReturnType<typeof createMockTransaction>[] = []
    vi.mocked(Transaction).mockImplementation(() => {
      const mockTx = createMockTransaction()
      mockTransactions.push(mockTx)
      return mockTx as unknown as Transaction
    })

    const savingsAccount = createMockAccount('INCOMING', 'Savings')
    const bucket1 = createMockAccount('ASSET', 'New Car', '50', [], 'new_car')
    const bucket2 = createMockAccount('ASSET', 'Emergency Fund', '50', [], 'emergency_fund')
    const book = createMockBook(
      [savingsAccount, bucket1, bucket2],
      { 'Savings': savingsAccount, 'Withdrawal': createMockAccount('OUTGOING', 'Withdrawal') }
    )
    const context = createMockContext({ transactionId: 'TX123' })

    await distributeToAllBuckets(book, context)

    expect(mockTransactions).toHaveLength(2)
    expect(mockTransactions[0].addRemoteId).toHaveBeenCalledWith('TX123_new_car')
    expect(mockTransactions[1].addRemoteId).toHaveBeenCalledWith('TX123_emergency_fund')
  })
})

describe('distributeToSuffixBuckets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets remote ID with format transactionId_normalizedAccountName', async () => {
    const mockTx = createMockTransaction()
    vi.mocked(Transaction).mockImplementation(() => mockTx as unknown as Transaction)

    const savingsAccount = createMockAccount('INCOMING', 'Savings')
    const bucketAccount = createMockAccount('ASSET', 'New Car LONG', '100', [], 'new_car_long')
    const book = createMockBook(
      [savingsAccount, bucketAccount],
      { 'Savings': savingsAccount, 'Withdrawal': createMockAccount('OUTGOING', 'Withdrawal') }
    )
    const context = createMockContext({ transactionId: 'ABCDEF123', suffix: 'LONG' })

    await distributeToSuffixBuckets(book, context)

    expect(mockTx.addRemoteId).toHaveBeenCalledWith('ABCDEF123_new_car_long')
  })
})

describe('distributeToOverrideBuckets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns error when no bucketOverride is provided', async () => {
    const book = createMockBook([])
    const context = createMockContext({ bucketOverride: undefined })

    const result = await distributeToOverrideBuckets(book, context)

    expect(result.success).toBe(false)
    expect(result.error).toBe('No bucket override provided')
  })

  it('distributes equally to accounts listed in bucketOverride', async () => {
    const mockTransactions: ReturnType<typeof createMockTransaction>[] = []
    vi.mocked(Transaction).mockImplementation(() => {
      const mockTx = createMockTransaction()
      mockTransactions.push(mockTx)
      return mockTx as unknown as Transaction
    })

    const savingsAccount = createMockAccount('INCOMING', 'Savings')
    const bucket1 = createMockAccount('ASSET', 'New Car', undefined, [], 'new_car')
    const bucket2 = createMockAccount('ASSET', 'Emergency Fund', undefined, [], 'emergency_fund')
    const book = createMockBook(
      [savingsAccount, bucket1, bucket2],
      {
        'Savings': savingsAccount,
        'Withdrawal': createMockAccount('OUTGOING', 'Withdrawal'),
        'New Car': bucket1,
        'Emergency Fund': bucket2,
      }
    )
    const context = createMockContext({
      bucketOverride: 'New Car, Emergency Fund',
      amount: '1000',
      transactionId: 'TX123',
    })

    const result = await distributeToOverrideBuckets(book, context)

    expect(result.success).toBe(true)
    expect(result.transactionCount).toBe(2)
    expect(result.totalDistributed).toBe(1000)
    expect(mockTransactions).toHaveLength(2)
    expect(mockTransactions[0].setAmount).toHaveBeenCalledWith(500)
    expect(mockTransactions[1].setAmount).toHaveBeenCalledWith(500)
  })

  it('sets remote IDs with format transactionId_normalizedAccountName', async () => {
    const mockTransactions: ReturnType<typeof createMockTransaction>[] = []
    vi.mocked(Transaction).mockImplementation(() => {
      const mockTx = createMockTransaction()
      mockTransactions.push(mockTx)
      return mockTx as unknown as Transaction
    })

    const savingsAccount = createMockAccount('INCOMING', 'Savings')
    const bucket1 = createMockAccount('ASSET', 'New Car', undefined, [], 'new_car')
    const bucket2 = createMockAccount('ASSET', 'Emergency Fund', undefined, [], 'emergency_fund')
    const book = createMockBook(
      [savingsAccount, bucket1, bucket2],
      {
        'Savings': savingsAccount,
        'Withdrawal': createMockAccount('OUTGOING', 'Withdrawal'),
        'New Car': bucket1,
        'Emergency Fund': bucket2,
      }
    )
    const context = createMockContext({
      bucketOverride: 'New Car, Emergency Fund',
      transactionId: 'ABCDEF123',
    })

    await distributeToOverrideBuckets(book, context)

    expect(mockTransactions[0].addRemoteId).toHaveBeenCalledWith('ABCDEF123_new_car')
    expect(mockTransactions[1].addRemoteId).toHaveBeenCalledWith('ABCDEF123_emergency_fund')
  })

  it('returns error when account does not exist', async () => {
    const savingsAccount = createMockAccount('INCOMING', 'Savings')
    const book = createMockBook(
      [savingsAccount],
      {
        'Savings': savingsAccount,
        'Withdrawal': createMockAccount('OUTGOING', 'Withdrawal'),
      }
    )
    const context = createMockContext({
      bucketOverride: 'New Car, NonExistent Account',
    })

    const result = await distributeToOverrideBuckets(book, context)

    expect(result.success).toBe(false)
    expect(result.error).toContain('New Car')
  })
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

// Helper to create mock transaction with remoteIds
function createMockTransactionWithRemoteIds(remoteIds: string[]): Transaction {
  return {
    getRemoteIds: () => remoteIds,
  } as unknown as Transaction
}

// Helper to create mock TransactionList
function createMockTransactionList(transactions: Transaction[], cursor?: string): TransactionList {
  return {
    getItems: () => transactions,
    getCursor: () => cursor,
  } as unknown as TransactionList
}

// Helper to create mock book with listTransactions and batchTrashTransactions
function createMockBookForTransactions(
  transactionLists: TransactionList[],
  accounts?: Account[]
): Book {
  let callIndex = 0
  return {
    listTransactions: vi.fn().mockImplementation(() => {
      const result = transactionLists[callIndex] || createMockTransactionList([])
      callIndex++
      return Promise.resolve(result)
    }),
    batchTrashTransactions: vi.fn().mockResolvedValue(undefined),
    getAccounts: async () => accounts || [],
  } as unknown as Book
}

describe('findBucketTransactionsByGlId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds transactions matching glTransactionId prefix in remoteIds', async () => {
    const tx1 = createMockTransactionWithRemoteIds(['TX123_new_car'])
    const tx2 = createMockTransactionWithRemoteIds(['TX123_emergency_fund'])
    const tx3 = createMockTransactionWithRemoteIds(['TX999_other'])
    const transactionList = createMockTransactionList([tx1, tx2, tx3])
    const book = createMockBookForTransactions([transactionList])

    const result = await findBucketTransactionsByGlId(book, '#bucket', '2025-01-01', 'TX123')

    expect(result).toHaveLength(2)
    expect(result).toContain(tx1)
    expect(result).toContain(tx2)
    expect(result).not.toContain(tx3)
  })

  it('uses optimized query with hashtag and date', async () => {
    const transactionList = createMockTransactionList([])
    const book = createMockBookForTransactions([transactionList])

    await findBucketTransactionsByGlId(book, '#bucket-sync', '2025-01-15', 'TX123')

    expect(book.listTransactions).toHaveBeenCalledWith('#bucket-sync on:2025-01-15')
  })

  it('paginates through multiple pages', async () => {
    const tx1 = createMockTransactionWithRemoteIds(['TX123_bucket1'])
    const tx2 = createMockTransactionWithRemoteIds(['TX123_bucket2'])
    const page1 = createMockTransactionList([tx1], 'cursor-1')
    const page2 = createMockTransactionList([tx2], undefined)
    const book = createMockBookForTransactions([page1, page2])

    const result = await findBucketTransactionsByGlId(book, '#bucket', '2025-01-01', 'TX123')

    expect(result).toHaveLength(2)
    expect(book.listTransactions).toHaveBeenCalledTimes(2)
  })

  it('terminates early when expectedCount is reached', async () => {
    const tx1 = createMockTransactionWithRemoteIds(['TX123_bucket1'])
    const tx2 = createMockTransactionWithRemoteIds(['TX123_bucket2'])
    const tx3 = createMockTransactionWithRemoteIds(['TX123_bucket3'])
    const page1 = createMockTransactionList([tx1, tx2, tx3], 'cursor-1')
    const page2 = createMockTransactionList([createMockTransactionWithRemoteIds(['TX123_bucket4'])])
    const book = createMockBookForTransactions([page1, page2])

    const result = await findBucketTransactionsByGlId(book, '#bucket', '2025-01-01', 'TX123', 2)

    expect(result).toHaveLength(2)
    expect(book.listTransactions).toHaveBeenCalledTimes(1) // Early termination - no second page
  })

  it('returns empty array when no transactions match', async () => {
    const tx1 = createMockTransactionWithRemoteIds(['OTHER_bucket1'])
    const transactionList = createMockTransactionList([tx1])
    const book = createMockBookForTransactions([transactionList])

    const result = await findBucketTransactionsByGlId(book, '#bucket', '2025-01-01', 'TX123')

    expect(result).toHaveLength(0)
  })

  it('handles transactions with multiple remoteIds', async () => {
    const tx1 = createMockTransactionWithRemoteIds(['OTHER_id', 'TX123_bucket1'])
    const transactionList = createMockTransactionList([tx1])
    const book = createMockBookForTransactions([transactionList])

    const result = await findBucketTransactionsByGlId(book, '#bucket', '2025-01-01', 'TX123')

    expect(result).toHaveLength(1)
    expect(result).toContain(tx1)
  })

  it('handles transactions with no remoteIds', async () => {
    const tx1 = createMockTransactionWithRemoteIds([])
    const transactionList = createMockTransactionList([tx1])
    const book = createMockBookForTransactions([transactionList])

    const result = await findBucketTransactionsByGlId(book, '#bucket', '2025-01-01', 'TX123')

    expect(result).toHaveLength(0)
  })
})

describe('trashBucketTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls batchTrashTransactions with trashChecked=true', async () => {
    const tx1 = createMockTransactionWithRemoteIds(['TX123_bucket1'])
    const tx2 = createMockTransactionWithRemoteIds(['TX123_bucket2'])
    const book = createMockBookForTransactions([])

    const result = await trashBucketTransactions(book, [tx1, tx2])

    expect(book.batchTrashTransactions).toHaveBeenCalledWith([tx1, tx2], true)
    expect(result).toBe(2)
  })

  it('returns 0 when transactions array is empty', async () => {
    const book = createMockBookForTransactions([])

    const result = await trashBucketTransactions(book, [])

    expect(book.batchTrashTransactions).not.toHaveBeenCalled()
    expect(result).toBe(0)
  })
})
