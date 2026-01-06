import { Hono } from 'hono'
import { Bkper } from 'bkper-js'
import type { BkperWebhookPayload, BkperAccount, SavingsContext } from './types'
import { detectSavings, extractSuffixFromAccount } from './webhook'
import { validatePercentages, distributeToAllBuckets, distributeToSuffixBuckets, distributeToOverrideBuckets, cleanupBucketTransactions, cleanupBucketTransactionsForAccount, validateBalances } from './bucket'

type Bindings = {
  BKPER_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.text('OK'))

app.post('/webhook', async (c) => {
  const rawBody = await c.req.text()
  console.log('RAW PAYLOAD:', rawBody)

  const payload = JSON.parse(rawBody) as BkperWebhookPayload

  console.log('Webhook received:', payload.type, payload.resource)

  // Handle ACCOUNT_UPDATED - initialization when savings:true is added, cleanup when removed
  if (payload.type === 'ACCOUNT_UPDATED') {
    console.log('Handling ACCOUNT_UPDATED')
    console.log('Account data:', JSON.stringify(payload.data, null, 2))

    // For ACCOUNT_UPDATED, the object IS the account (not nested under .account)
    const account = payload.data.object as unknown as BkperAccount
    if (!account || !account.id) {
      console.log('No account in payload, skipping')
      return c.json({ success: true })
    }

    // Extract all relevant state FIRST before any case checks
    const previousSavings = payload.data.previousAttributes?.savings
    const currentSavings = account.properties?.savings
    const currentArchived = account.archived === true

    // Bkper sends 'active' in previousAttributes (not 'archived'), with inverted logic:
    // active: 'false' means the account WAS archived/inactive
    // active: 'true' means the account WAS active/not archived
    // If 'active' key exists in previousAttributes, it means the archived status changed
    const archivedStatusChanged = 'active' in (payload.data.previousAttributes || {})
    const previousArchived = payload.data.previousAttributes?.active === 'false'

    // Check if savings property actually changed (key exists in previousAttributes)
    const savingsPropertyChanged = 'savings' in (payload.data.previousAttributes || {})

    console.log(`Previous savings: ${previousSavings}, Current savings: ${currentSavings}`)
    console.log(`Previous archived: ${previousArchived}, Current archived: ${currentArchived}, archivedStatusChanged: ${archivedStatusChanged}`)

    // Get bucket_book_id from GL book properties
    const bucketBookId = payload.book.properties?.bucket_book_id
    if (!bucketBookId) {
      console.log('No bucket_book_id configured on GL book, skipping')
      return c.json({ success: true })
    }

    // PRIORITY 1: Handle archived status changes FIRST (takes precedence over savings changes)
    // Case A: Savings account was ARCHIVED - cleanup bucket transactions
    if (archivedStatusChanged && currentArchived && !previousArchived && currentSavings === 'true') {
      console.log(`Savings account archived: ${account.name} (${account.id})`)

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get bucket book
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Cleanup bucket transactions for this account
      const trashedCount = await cleanupBucketTransactionsForAccount(bucketBook, account.id)

      console.log(`Trashed ${trashedCount} bucket transactions for archived account ${account.name}`)
      return c.json({ success: true, action: 'archive_cleanup', trashedCount, accountId: account.id, accountName: account.name })
    }

    // Case B: Savings account was UNARCHIVED - re-initialize bucket transactions
    if (archivedStatusChanged && !currentArchived && previousArchived && currentSavings === 'true') {
      console.log(`Savings account unarchived: ${account.name} (${account.id})`)

      // Only initialize ASSET accounts
      if (account.type !== 'ASSET') {
        console.log(`Account type is ${account.type}, not ASSET - skipping initialization`)
        return c.json({ success: true })
      }

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get GL book and fetch actual account balance
      const glBook = await bkper.getBook(payload.bookId, true, true)
      console.log('GL book name:', glBook.getName())

      const balancesReport = await glBook.getBalancesReport(`account:"${account.name}"`)
      const container = balancesReport.getBalancesContainers()[0]
      const balance = container ? container.getCumulativeBalance().toNumber() : 0

      console.log(`Fetched actual balance from GL book: ${balance}`)

      if (balance <= 0) {
        console.log(`Account balance is ${balance}, skipping initialization (must be > 0)`)
        return c.json({ success: true })
      }

      console.log(`Re-initializing bucket transactions for unarchived account with balance: ${balance}`)

      // Get bucket book with accounts and groups
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Extract suffix from account
      const suffix = extractSuffixFromAccount(account)
      console.log(`Suffix extracted: ${suffix || 'none'}`)

      // Get today's date in YYYY-MM-DD format
      const today = new Date().toISOString().split('T')[0]

      // Build initialization context
      const initContext: SavingsContext = {
        bucketBookId,
        bucketHashtag: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_hashtag,
        bucketIncomeAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_income_acc ?? 'Savings',
        bucketWithdrawalAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_withdrawal_acc ?? 'Withdrawal',
        amount: String(balance),
        transactionId: account.id,
        description: 'Balance after unarchive',
        date: today,
        fromAccount: account.name,
        toAccount: account.name,
        bucketOverride: undefined,
        direction: 'deposit',
        suffix,
        savingsAccountName: account.name,
        savingsAccountId: account.id,
        savingsAccountNormalizedName: account.normalizedName,
        savingsGroupName: undefined,
        isInitialization: true,
      }

      // Validate percentages sum to 100%
      const validation = await validatePercentages(bucketBook)
      if (!validation.isValid) {
        console.log(`Percentage validation failed: ${validation.totalPercentage}% (${validation.accountCount} accounts)`)
        return c.json({
          success: false,
          error: `Cannot initialize: bucket percentages sum to ${validation.totalPercentage}%, not 100%`,
        })
      }

      console.log(`Percentage validation passed: ${validation.accountCount} accounts totaling 100%`)

      // Distribute based on suffix or to all buckets
      let distribution
      if (suffix) {
        console.log(`Using suffix-based distribution: ${suffix}`)
        distribution = await distributeToSuffixBuckets(bucketBook, initContext)
      } else {
        console.log('Using percentage-based distribution to all buckets')
        distribution = await distributeToAllBuckets(bucketBook, initContext)
      }

      if (!distribution.success) {
        console.log(`Initialization distribution failed: ${distribution.error}`)
        return c.json({ success: false, error: distribution.error })
      }

      console.log(`Re-initialized ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

      // Validate balances after distribution
      const balanceValidation = await validateBalances(glBook, bucketBook)
      console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

      // Check transactions if balances match
      let checkedCount = 0
      if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
        await bucketBook.batchCheckTransactions(distribution.transactions)
        checkedCount = distribution.transactions.length
        console.log(`Checked ${checkedCount} transactions`)
      } else if (!balanceValidation.isBalanced) {
        console.log('Balance mismatch - transactions NOT checked')
      }

      return c.json({
        success: true,
        action: 'unarchive_initialization',
        distributed: distribution.totalDistributed,
        transactions: distribution.transactionCount,
        balanceValidation,
        checkedCount,
        accountId: account.id,
        accountName: account.name,
      })
    }

    // PRIORITY 2: Handle savings property changes (only if archived status didn't change)
    // Case 1: savings:true was ADDED - initialize bucket transactions
    // Guard: account must not be archived, and savings must have actually changed
    if (savingsPropertyChanged && currentSavings === 'true' && previousSavings !== 'true' && !currentArchived) {
      console.log(`Savings added to account: ${account.name} (${account.id})`)

      // Only initialize ASSET accounts
      if (account.type !== 'ASSET') {
        console.log(`Account type is ${account.type}, not ASSET - skipping initialization`)
        return c.json({ success: true })
      }

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get GL book and fetch actual account balance (webhook payload balance is unreliable)
      const glBook = await bkper.getBook(payload.bookId, true, true)
      console.log('GL book name:', glBook.getName())

      const balancesReport = await glBook.getBalancesReport(`account:"${account.name}"`)
      const container = balancesReport.getBalancesContainers()[0]
      const balance = container ? container.getCumulativeBalance().toNumber() : 0

      console.log(`Fetched actual balance from GL book: ${balance}`)

      if (balance <= 0) {
        console.log(`Account balance is ${balance}, skipping initialization (must be > 0)`)
        return c.json({ success: true })
      }

      console.log(`Initializing bucket transactions for balance: ${balance}`)

      // Get bucket book with accounts and groups
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Extract suffix from account
      const suffix = extractSuffixFromAccount(account)
      console.log(`Suffix extracted: ${suffix || 'none'}`)

      // Get today's date in YYYY-MM-DD format
      const today = new Date().toISOString().split('T')[0]

      // Build initialization context
      const initContext: SavingsContext = {
        bucketBookId,
        bucketHashtag: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_hashtag,
        bucketIncomeAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_income_acc ?? 'Savings',
        bucketWithdrawalAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_withdrawal_acc ?? 'Withdrawal',
        amount: String(balance),
        transactionId: account.id, // Use account ID as identifier for initialization
        description: 'Initial balance',
        date: today,
        fromAccount: account.name,
        toAccount: account.name,
        bucketOverride: undefined,
        direction: 'deposit', // Positive balance = accumulated deposits
        suffix,
        savingsAccountName: account.name,
        savingsAccountId: account.id,
        savingsAccountNormalizedName: account.normalizedName,
        savingsGroupName: undefined,
        isInitialization: true,
      }

      // Validate percentages sum to 100%
      const validation = await validatePercentages(bucketBook)
      if (!validation.isValid) {
        console.log(`Percentage validation failed: ${validation.totalPercentage}% (${validation.accountCount} accounts)`)
        return c.json({
          success: false,
          error: `Cannot initialize: bucket percentages sum to ${validation.totalPercentage}%, not 100%`,
        })
      }

      console.log(`Percentage validation passed: ${validation.accountCount} accounts totaling 100%`)

      // Distribute based on suffix or to all buckets
      let distribution
      if (suffix) {
        console.log(`Using suffix-based distribution: ${suffix}`)
        distribution = await distributeToSuffixBuckets(bucketBook, initContext)
      } else {
        console.log('Using percentage-based distribution to all buckets')
        distribution = await distributeToAllBuckets(bucketBook, initContext)
      }

      if (!distribution.success) {
        console.log(`Initialization distribution failed: ${distribution.error}`)
        return c.json({ success: false, error: distribution.error })
      }

      console.log(`Initialized ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

      // Validate balances after distribution (glBook already fetched earlier)
      const balanceValidation = await validateBalances(glBook, bucketBook)
      console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

      // Check transactions if balances match
      let checkedCount = 0
      if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
        await bucketBook.batchCheckTransactions(distribution.transactions)
        checkedCount = distribution.transactions.length
        console.log(`Checked ${checkedCount} transactions`)
      } else if (!balanceValidation.isBalanced) {
        console.log('Balance mismatch - transactions NOT checked')
      }

      return c.json({
        success: true,
        action: 'initialization',
        distributed: distribution.totalDistributed,
        transactions: distribution.transactionCount,
        balanceValidation,
        checkedCount,
        accountId: account.id,
        accountName: account.name,
      })
    }

    // Case 2: savings:true was REMOVED - cleanup bucket transactions
    if (savingsPropertyChanged && previousSavings === 'true' && currentSavings !== 'true') {
      console.log(`Savings removed from account: ${account.name} (${account.id})`)

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get bucket book
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Cleanup bucket transactions for this account
      const trashedCount = await cleanupBucketTransactionsForAccount(bucketBook, account.id)

      console.log(`Trashed ${trashedCount} bucket transactions for account ${account.name}`)
      return c.json({ success: true, action: 'cleanup', trashedCount, accountId: account.id, accountName: account.name })
    }

    // Neither case applies
    console.log('No relevant property change detected, skipping')
    return c.json({ success: true })
  }

  // Handle ACCOUNT_DELETED - cleanup bucket transactions when savings account is deleted
  if (payload.type === 'ACCOUNT_DELETED') {
    console.log('Handling ACCOUNT_DELETED')
    console.log('Account data:', JSON.stringify(payload.data, null, 2))

    const account = payload.data.object as unknown as BkperAccount
    if (!account || !account.id) {
      console.log('No account in payload, skipping')
      return c.json({ success: true })
    }

    // Only cleanup if the deleted account had savings:true
    const savings = account.properties?.savings
    if (savings !== 'true') {
      console.log(`Account ${account.name} was not a savings account, skipping cleanup`)
      return c.json({ success: true })
    }

    console.log(`Savings account deleted: ${account.name} (${account.id})`)

    // Get bucket_book_id from GL book properties
    const bucketBookId = payload.book.properties?.bucket_book_id
    if (!bucketBookId) {
      console.log('No bucket_book_id configured on GL book, skipping')
      return c.json({ success: true })
    }

    // Get OAuth token
    const oauthToken = c.req.header('bkper-oauth-token')
    if (!oauthToken) {
      console.log('No OAuth token in bkper-oauth-token header')
      return c.json({ success: false, error: 'No OAuth token' })
    }

    // Create Bkper instance
    const bkper = new Bkper({
      apiKeyProvider: () => c.env.BKPER_API_KEY,
      oauthTokenProvider: () => oauthToken,
    })

    // Get bucket book
    const bucketBook = await bkper.getBook(bucketBookId, true, true)
    console.log('Bucket book name:', bucketBook.getName())

    // Cleanup bucket transactions for this account
    const trashedCount = await cleanupBucketTransactionsForAccount(bucketBook, account.id)

    console.log(`Trashed ${trashedCount} bucket transactions for deleted account ${account.name}`)
    return c.json({ success: true, action: 'cleanup', trashedCount, accountId: account.id, accountName: account.name })
  }

  const result = detectSavings(payload)

  if (!result.isSavings) {
    console.log('Not a savings transaction, skipping')
    return c.json({ success: true })
  }

  console.log('Savings detected:', JSON.stringify(result.context, null, 2))

  // Get OAuth token from bkper-oauth-token header (sent by Bkper)
  const oauthToken = c.req.header('bkper-oauth-token')
  if (!oauthToken) {
    console.log('No OAuth token in bkper-oauth-token header')
    return c.json({ success: false, error: 'No OAuth token' })
  }

  // Create Bkper instance
  const bkper = new Bkper({
    apiKeyProvider: () => c.env.BKPER_API_KEY,
    oauthTokenProvider: () => oauthToken,
  })

  // Get bucket book with accounts and groups
  const bucketBook = await bkper.getBook(result.context.bucketBookId, true, true)

  console.log('Bucket book name:', bucketBook.getName())

  // Handle TRANSACTION_DELETED - trash related bucket transactions
  if (payload.type === 'TRANSACTION_DELETED') {
    console.log('Handling TRANSACTION_DELETED')

    const trashedCount = await cleanupBucketTransactions(
      bucketBook,
      result.context.bucketHashtag || '',
      result.context.date,
      result.context.transactionId
    )

    console.log(`Trashed ${trashedCount} bucket transactions`)
    return c.json({ success: true, trashedCount })
  }

  // Handle TRANSACTION_UPDATED - cleanup old transactions, then redistribute
  if (payload.type === 'TRANSACTION_UPDATED') {
    console.log('Handling TRANSACTION_UPDATED')

    const trashedCount = await cleanupBucketTransactions(
      bucketBook,
      result.context.bucketHashtag || '',
      result.context.date,
      result.context.transactionId
    )

    console.log(`Cleaned up ${trashedCount} bucket transactions before redistribution`)
    // Fall through to distribution logic below
  }

  // Handle TRANSACTION_UNTRASHED - create new bucket transactions
  // (old bucket transactions stay in trash, new ones created with timestamped remote IDs)
  if (payload.type === 'TRANSACTION_UNTRASHED') {
    console.log('Handling TRANSACTION_UNTRASHED')
    // Fall through to distribution logic below
  }

  // Handle TRANSACTION_POSTED / TRANSACTION_UPDATED / TRANSACTION_UNTRASHED - distribute to buckets
  // Validate percentages sum to 100%
  const validation = await validatePercentages(bucketBook)
  if (!validation.isValid) {
    console.log(`Percentage validation failed: ${validation.totalPercentage}% (${validation.accountCount} accounts)`)
    return c.json({
      success: false,
      error: `Cannot distribute: bucket percentages sum to ${validation.totalPercentage}%, not 100%`,
    })
  }

  console.log(`Percentage validation passed: ${validation.accountCount} accounts totaling 100%`)

  // Check for suffix-based distribution
  if (result.context.suffix) {
    console.log(`Suffix detected: ${result.context.suffix}`)
    const distribution = await distributeToSuffixBuckets(bucketBook, result.context)

    if (!distribution.success) {
      console.log(`Suffix distribution failed: ${distribution.error}`)
      return c.json({ success: false, error: distribution.error })
    }

    console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} suffix-matched buckets`)

    // Validate balances after distribution
    const glBook = await bkper.getBook(payload.bookId, true, true)
    const balanceValidation = await validateBalances(glBook, bucketBook)
    console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

    // Check transactions if balances match
    let checkedCount = 0
    if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
      await bucketBook.batchCheckTransactions(distribution.transactions)
      checkedCount = distribution.transactions.length
      console.log(`Checked ${checkedCount} transactions`)
    } else if (!balanceValidation.isBalanced) {
      console.log(`Balance mismatch - transactions NOT checked`)
    }

    return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount, balanceValidation, checkedCount })
  }

  // Check for bucket override
  if (result.context.bucketOverride) {
    console.log(`Bucket override: ${result.context.bucketOverride}`)
    const distribution = await distributeToOverrideBuckets(bucketBook, result.context)

    if (!distribution.success) {
      console.log(`Override distribution failed: ${distribution.error}`)
      return c.json({ success: false, error: distribution.error })
    }

    console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} override buckets`)

    // Validate balances after distribution
    const glBook = await bkper.getBook(payload.bookId, true, true)
    const balanceValidation = await validateBalances(glBook, bucketBook)
    console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

    // Check transactions if balances match
    let checkedCount = 0
    if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
      await bucketBook.batchCheckTransactions(distribution.transactions)
      checkedCount = distribution.transactions.length
      console.log(`Checked ${checkedCount} transactions`)
    } else if (!balanceValidation.isBalanced) {
      console.log(`Balance mismatch - transactions NOT checked`)
    }

    return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount, balanceValidation, checkedCount })
  }

  // Basic distribution - no suffix, no override
  const distribution = await distributeToAllBuckets(bucketBook, result.context)

  console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

  // Validate balances after distribution
  const glBook = await bkper.getBook(payload.bookId, true, true)
  const balanceValidation = await validateBalances(glBook, bucketBook)
  console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

  // Check transactions if balances match
  let checkedCount = 0
  if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
    await bucketBook.batchCheckTransactions(distribution.transactions)
    checkedCount = distribution.transactions.length
    console.log(`Checked ${checkedCount} transactions`)
  } else if (!balanceValidation.isBalanced) {
    console.log(`Balance mismatch - transactions NOT checked`)
  }

  return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount, balanceValidation, checkedCount })
})

app.post('/', async (c) => {
  const payload = await c.req.json<BkperWebhookPayload>()

  console.log('Webhook received:', payload.type, payload.resource)

  // Handle ACCOUNT_UPDATED - initialization when savings:true is added, cleanup when removed
  if (payload.type === 'ACCOUNT_UPDATED') {
    console.log('Handling ACCOUNT_UPDATED')
    console.log('Account data:', JSON.stringify(payload.data, null, 2))

    // For ACCOUNT_UPDATED, the object IS the account (not nested under .account)
    const account = payload.data.object as unknown as BkperAccount
    if (!account || !account.id) {
      console.log('No account in payload, skipping')
      return c.json({ success: true })
    }

    // Extract all relevant state FIRST before any case checks
    const previousSavings = payload.data.previousAttributes?.savings
    const currentSavings = account.properties?.savings
    const currentArchived = account.archived === true

    // Bkper sends 'active' in previousAttributes (not 'archived'), with inverted logic:
    // active: 'false' means the account WAS archived/inactive
    // active: 'true' means the account WAS active/not archived
    // If 'active' key exists in previousAttributes, it means the archived status changed
    const archivedStatusChanged = 'active' in (payload.data.previousAttributes || {})
    const previousArchived = payload.data.previousAttributes?.active === 'false'

    // Check if savings property actually changed (key exists in previousAttributes)
    const savingsPropertyChanged = 'savings' in (payload.data.previousAttributes || {})

    console.log(`Previous savings: ${previousSavings}, Current savings: ${currentSavings}`)
    console.log(`Previous archived: ${previousArchived}, Current archived: ${currentArchived}, archivedStatusChanged: ${archivedStatusChanged}`)

    // Get bucket_book_id from GL book properties
    const bucketBookId = payload.book.properties?.bucket_book_id
    if (!bucketBookId) {
      console.log('No bucket_book_id configured on GL book, skipping')
      return c.json({ success: true })
    }

    // PRIORITY 1: Handle archived status changes FIRST (takes precedence over savings changes)
    // Case A: Savings account was ARCHIVED - cleanup bucket transactions
    if (archivedStatusChanged && currentArchived && !previousArchived && currentSavings === 'true') {
      console.log(`Savings account archived: ${account.name} (${account.id})`)

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get bucket book
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Cleanup bucket transactions for this account
      const trashedCount = await cleanupBucketTransactionsForAccount(bucketBook, account.id)

      console.log(`Trashed ${trashedCount} bucket transactions for archived account ${account.name}`)
      return c.json({ success: true, action: 'archive_cleanup', trashedCount, accountId: account.id, accountName: account.name })
    }

    // Case B: Savings account was UNARCHIVED - re-initialize bucket transactions
    if (archivedStatusChanged && !currentArchived && previousArchived && currentSavings === 'true') {
      console.log(`Savings account unarchived: ${account.name} (${account.id})`)

      // Only initialize ASSET accounts
      if (account.type !== 'ASSET') {
        console.log(`Account type is ${account.type}, not ASSET - skipping initialization`)
        return c.json({ success: true })
      }

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get GL book and fetch actual account balance
      const glBook = await bkper.getBook(payload.bookId, true, true)
      console.log('GL book name:', glBook.getName())

      const balancesReport = await glBook.getBalancesReport(`account:"${account.name}"`)
      const container = balancesReport.getBalancesContainers()[0]
      const balance = container ? container.getCumulativeBalance().toNumber() : 0

      console.log(`Fetched actual balance from GL book: ${balance}`)

      if (balance <= 0) {
        console.log(`Account balance is ${balance}, skipping initialization (must be > 0)`)
        return c.json({ success: true })
      }

      console.log(`Re-initializing bucket transactions for unarchived account with balance: ${balance}`)

      // Get bucket book with accounts and groups
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Extract suffix from account
      const suffix = extractSuffixFromAccount(account)
      console.log(`Suffix extracted: ${suffix || 'none'}`)

      // Get today's date in YYYY-MM-DD format
      const today = new Date().toISOString().split('T')[0]

      // Build initialization context
      const initContext: SavingsContext = {
        bucketBookId,
        bucketHashtag: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_hashtag,
        bucketIncomeAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_income_acc ?? 'Savings',
        bucketWithdrawalAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_withdrawal_acc ?? 'Withdrawal',
        amount: String(balance),
        transactionId: account.id,
        description: 'Balance after unarchive',
        date: today,
        fromAccount: account.name,
        toAccount: account.name,
        bucketOverride: undefined,
        direction: 'deposit',
        suffix,
        savingsAccountName: account.name,
        savingsAccountId: account.id,
        savingsAccountNormalizedName: account.normalizedName,
        savingsGroupName: undefined,
        isInitialization: true,
      }

      // Validate percentages sum to 100%
      const validation = await validatePercentages(bucketBook)
      if (!validation.isValid) {
        console.log(`Percentage validation failed: ${validation.totalPercentage}% (${validation.accountCount} accounts)`)
        return c.json({
          success: false,
          error: `Cannot initialize: bucket percentages sum to ${validation.totalPercentage}%, not 100%`,
        })
      }

      console.log(`Percentage validation passed: ${validation.accountCount} accounts totaling 100%`)

      // Distribute based on suffix or to all buckets
      let distribution
      if (suffix) {
        console.log(`Using suffix-based distribution: ${suffix}`)
        distribution = await distributeToSuffixBuckets(bucketBook, initContext)
      } else {
        console.log('Using percentage-based distribution to all buckets')
        distribution = await distributeToAllBuckets(bucketBook, initContext)
      }

      if (!distribution.success) {
        console.log(`Initialization distribution failed: ${distribution.error}`)
        return c.json({ success: false, error: distribution.error })
      }

      console.log(`Re-initialized ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

      // Validate balances after distribution
      const balanceValidation = await validateBalances(glBook, bucketBook)
      console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

      // Check transactions if balances match
      let checkedCount = 0
      if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
        await bucketBook.batchCheckTransactions(distribution.transactions)
        checkedCount = distribution.transactions.length
        console.log(`Checked ${checkedCount} transactions`)
      } else if (!balanceValidation.isBalanced) {
        console.log('Balance mismatch - transactions NOT checked')
      }

      return c.json({
        success: true,
        action: 'unarchive_initialization',
        distributed: distribution.totalDistributed,
        transactions: distribution.transactionCount,
        balanceValidation,
        checkedCount,
        accountId: account.id,
        accountName: account.name,
      })
    }

    // PRIORITY 2: Handle savings property changes (only if archived status didn't change)
    // Case 1: savings:true was ADDED - initialize bucket transactions
    // Guard: account must not be archived, and savings must have actually changed
    if (savingsPropertyChanged && currentSavings === 'true' && previousSavings !== 'true' && !currentArchived) {
      console.log(`Savings added to account: ${account.name} (${account.id})`)

      // Only initialize ASSET accounts
      if (account.type !== 'ASSET') {
        console.log(`Account type is ${account.type}, not ASSET - skipping initialization`)
        return c.json({ success: true })
      }

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get GL book and fetch actual account balance (webhook payload balance is unreliable)
      const glBook = await bkper.getBook(payload.bookId, true, true)
      console.log('GL book name:', glBook.getName())

      const balancesReport = await glBook.getBalancesReport(`account:"${account.name}"`)
      const container = balancesReport.getBalancesContainers()[0]
      const balance = container ? container.getCumulativeBalance().toNumber() : 0

      console.log(`Fetched actual balance from GL book: ${balance}`)

      if (balance <= 0) {
        console.log(`Account balance is ${balance}, skipping initialization (must be > 0)`)
        return c.json({ success: true })
      }

      console.log(`Initializing bucket transactions for balance: ${balance}`)

      // Get bucket book with accounts and groups
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Extract suffix from account
      const suffix = extractSuffixFromAccount(account)
      console.log(`Suffix extracted: ${suffix || 'none'}`)

      // Get today's date in YYYY-MM-DD format
      const today = new Date().toISOString().split('T')[0]

      // Build initialization context
      const initContext: SavingsContext = {
        bucketBookId,
        bucketHashtag: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_hashtag,
        bucketIncomeAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_income_acc ?? 'Savings',
        bucketWithdrawalAcc: payload.book.collection?.books?.find(b => b.id === bucketBookId)?.properties?.bucket_withdrawal_acc ?? 'Withdrawal',
        amount: String(balance),
        transactionId: account.id, // Use account ID as identifier for initialization
        description: 'Initial balance',
        date: today,
        fromAccount: account.name,
        toAccount: account.name,
        bucketOverride: undefined,
        direction: 'deposit', // Positive balance = accumulated deposits
        suffix,
        savingsAccountName: account.name,
        savingsAccountId: account.id,
        savingsAccountNormalizedName: account.normalizedName,
        savingsGroupName: undefined,
        isInitialization: true,
      }

      // Validate percentages sum to 100%
      const validation = await validatePercentages(bucketBook)
      if (!validation.isValid) {
        console.log(`Percentage validation failed: ${validation.totalPercentage}% (${validation.accountCount} accounts)`)
        return c.json({
          success: false,
          error: `Cannot initialize: bucket percentages sum to ${validation.totalPercentage}%, not 100%`,
        })
      }

      console.log(`Percentage validation passed: ${validation.accountCount} accounts totaling 100%`)

      // Distribute based on suffix or to all buckets
      let distribution
      if (suffix) {
        console.log(`Using suffix-based distribution: ${suffix}`)
        distribution = await distributeToSuffixBuckets(bucketBook, initContext)
      } else {
        console.log('Using percentage-based distribution to all buckets')
        distribution = await distributeToAllBuckets(bucketBook, initContext)
      }

      if (!distribution.success) {
        console.log(`Initialization distribution failed: ${distribution.error}`)
        return c.json({ success: false, error: distribution.error })
      }

      console.log(`Initialized ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

      // Validate balances after distribution (glBook already fetched earlier)
      const balanceValidation = await validateBalances(glBook, bucketBook)
      console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

      // Check transactions if balances match
      let checkedCount = 0
      if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
        await bucketBook.batchCheckTransactions(distribution.transactions)
        checkedCount = distribution.transactions.length
        console.log(`Checked ${checkedCount} transactions`)
      } else if (!balanceValidation.isBalanced) {
        console.log('Balance mismatch - transactions NOT checked')
      }

      return c.json({
        success: true,
        action: 'initialization',
        distributed: distribution.totalDistributed,
        transactions: distribution.transactionCount,
        balanceValidation,
        checkedCount,
        accountId: account.id,
        accountName: account.name,
      })
    }

    // Case 2: savings:true was REMOVED - cleanup bucket transactions
    if (savingsPropertyChanged && previousSavings === 'true' && currentSavings !== 'true') {
      console.log(`Savings removed from account: ${account.name} (${account.id})`)

      // Get OAuth token
      const oauthToken = c.req.header('bkper-oauth-token')
      if (!oauthToken) {
        console.log('No OAuth token in bkper-oauth-token header')
        return c.json({ success: false, error: 'No OAuth token' })
      }

      // Create Bkper instance
      const bkper = new Bkper({
        apiKeyProvider: () => c.env.BKPER_API_KEY,
        oauthTokenProvider: () => oauthToken,
      })

      // Get bucket book
      const bucketBook = await bkper.getBook(bucketBookId, true, true)
      console.log('Bucket book name:', bucketBook.getName())

      // Cleanup bucket transactions for this account
      const trashedCount = await cleanupBucketTransactionsForAccount(bucketBook, account.id)

      console.log(`Trashed ${trashedCount} bucket transactions for account ${account.name}`)
      return c.json({ success: true, action: 'cleanup', trashedCount, accountId: account.id, accountName: account.name })
    }

    // Neither case applies
    console.log('No relevant property change detected, skipping')
    return c.json({ success: true })
  }

  // Handle ACCOUNT_DELETED - cleanup bucket transactions when savings account is deleted
  if (payload.type === 'ACCOUNT_DELETED') {
    console.log('Handling ACCOUNT_DELETED')
    console.log('Account data:', JSON.stringify(payload.data, null, 2))

    const account = payload.data.object as unknown as BkperAccount
    if (!account || !account.id) {
      console.log('No account in payload, skipping')
      return c.json({ success: true })
    }

    // Only cleanup if the deleted account had savings:true
    const savings = account.properties?.savings
    if (savings !== 'true') {
      console.log(`Account ${account.name} was not a savings account, skipping cleanup`)
      return c.json({ success: true })
    }

    console.log(`Savings account deleted: ${account.name} (${account.id})`)

    // Get bucket_book_id from GL book properties
    const bucketBookId = payload.book.properties?.bucket_book_id
    if (!bucketBookId) {
      console.log('No bucket_book_id configured on GL book, skipping')
      return c.json({ success: true })
    }

    // Get OAuth token
    const oauthToken = c.req.header('bkper-oauth-token')
    if (!oauthToken) {
      console.log('No OAuth token in bkper-oauth-token header')
      return c.json({ success: false, error: 'No OAuth token' })
    }

    // Create Bkper instance
    const bkper = new Bkper({
      apiKeyProvider: () => c.env.BKPER_API_KEY,
      oauthTokenProvider: () => oauthToken,
    })

    // Get bucket book
    const bucketBook = await bkper.getBook(bucketBookId, true, true)
    console.log('Bucket book name:', bucketBook.getName())

    // Cleanup bucket transactions for this account
    const trashedCount = await cleanupBucketTransactionsForAccount(bucketBook, account.id)

    console.log(`Trashed ${trashedCount} bucket transactions for deleted account ${account.name}`)
    return c.json({ success: true, action: 'cleanup', trashedCount, accountId: account.id, accountName: account.name })
  }

  const result = detectSavings(payload)

  if (!result.isSavings) {
    console.log('Not a savings transaction, skipping')
    return c.json({ success: true })
  }

  console.log('Savings detected:', JSON.stringify(result.context, null, 2))

  // Get OAuth token from bkper-oauth-token header (sent by Bkper)
  const oauthToken = c.req.header('bkper-oauth-token')
  if (!oauthToken) {
    console.log('No OAuth token in bkper-oauth-token header')
    return c.json({ success: false, error: 'No OAuth token' })
  }

  // Create Bkper instance
  const bkper = new Bkper({
    apiKeyProvider: () => c.env.BKPER_API_KEY,
    oauthTokenProvider: () => oauthToken,
  })

  // Get bucket book with accounts and groups
  const bucketBook = await bkper.getBook(result.context.bucketBookId, true, true)

  console.log('Bucket book name:', bucketBook.getName())

  // Handle TRANSACTION_DELETED - trash related bucket transactions
  if (payload.type === 'TRANSACTION_DELETED') {
    console.log('Handling TRANSACTION_DELETED')

    const trashedCount = await cleanupBucketTransactions(
      bucketBook,
      result.context.bucketHashtag || '',
      result.context.date,
      result.context.transactionId
    )

    console.log(`Trashed ${trashedCount} bucket transactions`)
    return c.json({ success: true, trashedCount })
  }

  // Handle TRANSACTION_UPDATED - cleanup old transactions, then redistribute
  if (payload.type === 'TRANSACTION_UPDATED') {
    console.log('Handling TRANSACTION_UPDATED')

    const trashedCount = await cleanupBucketTransactions(
      bucketBook,
      result.context.bucketHashtag || '',
      result.context.date,
      result.context.transactionId
    )

    console.log(`Cleaned up ${trashedCount} bucket transactions before redistribution`)
    // Fall through to distribution logic below
  }

  // Handle TRANSACTION_UNTRASHED - create new bucket transactions
  // (old bucket transactions stay in trash, new ones created with timestamped remote IDs)
  if (payload.type === 'TRANSACTION_UNTRASHED') {
    console.log('Handling TRANSACTION_UNTRASHED')
    // Fall through to distribution logic below
  }

  // Handle TRANSACTION_POSTED / TRANSACTION_UPDATED / TRANSACTION_UNTRASHED - distribute to buckets
  // Validate percentages sum to 100%
  const validation = await validatePercentages(bucketBook)
  if (!validation.isValid) {
    console.log(`Percentage validation failed: ${validation.totalPercentage}% (${validation.accountCount} accounts)`)
    return c.json({
      success: false,
      error: `Cannot distribute: bucket percentages sum to ${validation.totalPercentage}%, not 100%`,
    })
  }

  console.log(`Percentage validation passed: ${validation.accountCount} accounts totaling 100%`)

  // Check for suffix-based distribution
  if (result.context.suffix) {
    console.log(`Suffix detected: ${result.context.suffix}`)
    const distribution = await distributeToSuffixBuckets(bucketBook, result.context)

    if (!distribution.success) {
      console.log(`Suffix distribution failed: ${distribution.error}`)
      return c.json({ success: false, error: distribution.error })
    }

    console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} suffix-matched buckets`)

    // Validate balances after distribution
    const glBook = await bkper.getBook(payload.bookId, true, true)
    const balanceValidation = await validateBalances(glBook, bucketBook)
    console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

    // Check transactions if balances match
    let checkedCount = 0
    if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
      await bucketBook.batchCheckTransactions(distribution.transactions)
      checkedCount = distribution.transactions.length
      console.log(`Checked ${checkedCount} transactions`)
    } else if (!balanceValidation.isBalanced) {
      console.log(`Balance mismatch - transactions NOT checked`)
    }

    return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount, balanceValidation, checkedCount })
  }

  // Check for bucket override
  if (result.context.bucketOverride) {
    console.log(`Bucket override: ${result.context.bucketOverride}`)
    const distribution = await distributeToOverrideBuckets(bucketBook, result.context)

    if (!distribution.success) {
      console.log(`Override distribution failed: ${distribution.error}`)
      return c.json({ success: false, error: distribution.error })
    }

    console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} override buckets`)

    // Validate balances after distribution
    const glBook = await bkper.getBook(payload.bookId, true, true)
    const balanceValidation = await validateBalances(glBook, bucketBook)
    console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

    // Check transactions if balances match
    let checkedCount = 0
    if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
      await bucketBook.batchCheckTransactions(distribution.transactions)
      checkedCount = distribution.transactions.length
      console.log(`Checked ${checkedCount} transactions`)
    } else if (!balanceValidation.isBalanced) {
      console.log(`Balance mismatch - transactions NOT checked`)
    }

    return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount, balanceValidation, checkedCount })
  }

  // Basic distribution - no suffix, no override
  const distribution = await distributeToAllBuckets(bucketBook, result.context)

  console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

  // Validate balances after distribution
  const glBook = await bkper.getBook(payload.bookId, true, true)
  const balanceValidation = await validateBalances(glBook, bucketBook)
  console.log(`Balance validation: GL=${balanceValidation.glTotal}, Bucket=${balanceValidation.bucketTotal}, Diff=${balanceValidation.difference}, Balanced=${balanceValidation.isBalanced}`)

  // Check transactions if balances match
  let checkedCount = 0
  if (balanceValidation.isBalanced && distribution.transactions && distribution.transactions.length > 0) {
    await bucketBook.batchCheckTransactions(distribution.transactions)
    checkedCount = distribution.transactions.length
    console.log(`Checked ${checkedCount} transactions`)
  } else if (!balanceValidation.isBalanced) {
    console.log(`Balance mismatch - transactions NOT checked`)
  }

  return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount, balanceValidation, checkedCount })
})

export default app
