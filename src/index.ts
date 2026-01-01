import { Hono } from 'hono'
import { Bkper } from 'bkper-js'
import type { BkperWebhookPayload } from './types'
import { detectSavings } from './webhook'
import { validatePercentages, distributeToAllBuckets, distributeToSuffixBuckets, distributeToOverrideBuckets, findBucketTransactionsByGlId, trashBucketTransactions, validateBalances } from './bucket'

type Bindings = {
  BKPER_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.text('OK'))

app.post('/webhook', async (c) => {
  const payload = await c.req.json<BkperWebhookPayload>()

  console.log('Webhook received:', payload.type, payload.resource)

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

    const hashtag = result.context.bucketHashtag || ''
    const date = result.context.date
    const glTransactionId = result.context.transactionId

    // Get expected count from bucket accounts for early termination
    const accounts = await bucketBook.getAccounts()
    const bucketAccounts = accounts.filter(acc =>
      acc.getType() === 'ASSET' && acc.getProperties().percentage !== undefined
    )
    const expectedCount = bucketAccounts.length

    // Find bucket transactions for this GL transaction
    const bucketTransactions = await findBucketTransactionsByGlId(
      bucketBook,
      hashtag,
      date,
      glTransactionId,
      expectedCount
    )

    console.log(`Found ${bucketTransactions.length} bucket transactions to trash`)

    // Batch trash them
    const trashedCount = await trashBucketTransactions(bucketBook, bucketTransactions)

    console.log(`Trashed ${trashedCount} bucket transactions`)
    return c.json({ success: true, trashedCount })
  }

  // Handle TRANSACTION_POSTED - distribute to buckets
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

    const hashtag = result.context.bucketHashtag || ''
    const date = result.context.date
    const glTransactionId = result.context.transactionId

    // Get expected count from bucket accounts for early termination
    const accounts = await bucketBook.getAccounts()
    const bucketAccounts = accounts.filter(acc =>
      acc.getType() === 'ASSET' && acc.getProperties().percentage !== undefined
    )
    const expectedCount = bucketAccounts.length

    // Find bucket transactions for this GL transaction
    const bucketTransactions = await findBucketTransactionsByGlId(
      bucketBook,
      hashtag,
      date,
      glTransactionId,
      expectedCount
    )

    console.log(`Found ${bucketTransactions.length} bucket transactions to trash`)

    // Batch trash them
    const trashedCount = await trashBucketTransactions(bucketBook, bucketTransactions)

    console.log(`Trashed ${trashedCount} bucket transactions`)
    return c.json({ success: true, trashedCount })
  }

  // Handle TRANSACTION_POSTED - distribute to buckets
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
