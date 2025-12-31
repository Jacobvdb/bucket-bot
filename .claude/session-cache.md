# Bucket Bot - Session Cache

## Project Overview
Cloudflare Worker that distributes savings transactions from a GL (General Ledger) book to a Bucket book in Bkper.

## Current State (2025-12-31)

### Completed
1. **Payload parsing & savings detection** (`src/webhook.ts`)
   - Detects `savings: "true"` on accounts or groups
   - Extracts direction: `deposit` (debit has savings) or `withdrawal` (credit has savings)
   - Extracts suffix from account/group name (last uppercase word, e.g., "RDB LONG" → "LONG")
   - Extracts `bucketOverride` from transaction property `bucket` (overrides suffix routing)
   - All context extracted from webhook payload - no API calls needed

2. **Context object** (`SavingsContext` in `src/types.ts`)
   ```
   bucketBookId, bucketHashtag, bucketIncomeAcc, bucketWithdrawalAcc,
   amount, transactionId, description, date, fromAccount, toAccount,
   bucketOverride, direction, suffix, savingsAccountName, savingsGroupName
   ```

3. **Bkper API integration** (`src/index.ts`)
   - OAuth token from `bkper-oauth-token` header (NOT Authorization)
   - API key from Cloudflare secret `BKPER_API_KEY`
   - Calling `bkper.getBook(bucketBookId, true, true)` to get book with accounts/groups

4. **Tests** (`test/webhook.spec.ts`) - 19 tests passing

5. **Git/GitHub**
   - Remote: https://github.com/Jacobvdb/bucket-bot
   - Latest commit includes all savings detection logic

### In Progress
- Exploring what `getBook(id, true, true)` returns
- Need to see if accounts/groups are included in response or require separate calls

### Next Steps (Bucket Side Logic - Not Yet Implemented)
1. Find bucket accounts to distribute to (using suffix or bucketOverride)
2. Calculate distribution amounts based on percentage properties
3. Create transactions in bucket book

## Key Files
- `src/index.ts` - Hono app, webhook handlers, Bkper API calls
- `src/webhook.ts` - `detectSavings()` function
- `src/types.ts` - TypeScript types for payload and context
- `test/webhook.spec.ts` - Test suite
- `bkperapp.yaml` - Bkper app config (events: POSTED, UPDATED, DELETED, RESTORED)
- `payload.json` - Example webhook payload (gitignored)

## Important Notes

### Bkper Authentication
- OAuth token: `bkper-oauth-token` header (sent by Bkper with each webhook)
- API key: `bkper-api-key` header OR `BKPER_API_KEY` Cloudflare secret

### Direction Logic
- Debit (to) has `savings: true` → `deposit` → Bucket: Savings >> Bucket
- Credit (from) has `savings: true` → `withdrawal` → Bucket: Bucket >> Withdrawal

### Suffix Extraction
- Multi-word name: last word if uppercase (e.g., "RDB LONG" → "LONG")
- Single word: no suffix (e.g., "Provisioning" → undefined)

### Bucket Override
- Transaction property `bucket: "bucket1, bucket2"` overrides suffix routing
- If present, suffix extraction is skipped

### Webhook Retries
- Bkper retries failed webhooks (up to 4 times)
- Return `{ success: true }` quickly to avoid retries

## Bucket Book Properties (from payload)
```
bucket_hashtag: "#in_spaarpot"
bucket_income_acc: "Savings"
bucket_withdrawal_acc: "Withdrawal"
```

## Commands
```bash
npm run deploy    # Deploy to Cloudflare
npx wrangler tail # View live logs
npm test          # Run tests
```
