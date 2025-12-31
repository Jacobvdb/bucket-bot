import { Hono } from 'hono'
import { Bkper } from 'bkper-js'
import type { BkperWebhookPayload } from './types'
import { detectSavings } from './webhook'
import { validatePercentages, distributeToAllBuckets, distributeToSuffixBuckets } from './bucket'

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
    return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount })
  }

  // Check for bucket override (not yet implemented)
  if (result.context.bucketOverride) {
    console.log('Bucket override present, not yet implemented')
    return c.json({ success: true, skipped: true })
  }

  // Basic distribution - no suffix, no override
  const distribution = await distributeToAllBuckets(bucketBook, result.context)

  console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

  return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount })
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
    return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount })
  }

  // Check for bucket override (not yet implemented)
  if (result.context.bucketOverride) {
    console.log('Bucket override present, not yet implemented')
    return c.json({ success: true, skipped: true })
  }

  // Basic distribution - no suffix, no override
  const distribution = await distributeToAllBuckets(bucketBook, result.context)

  console.log(`Distributed ${distribution.totalDistributed} to ${distribution.transactionCount} buckets`)

  return c.json({ success: true, distributed: distribution.totalDistributed, transactions: distribution.transactionCount })
})

export default app
