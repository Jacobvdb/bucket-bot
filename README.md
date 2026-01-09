# Bucket Bot

Automate envelope budgeting for your savings without sacrificing yield or control.

## The Problem

You want to use envelope budgeting (also known as bucket budgeting) to organize your savings into specific goals: an emergency fund, a vacation fund, a new car fund. Many banks offer "buckets" or "spaces" as a feature, but they come with trade-offs:

- **Lower yields**: Bank buckets often sit in low-interest accounts while your main savings could earn more in a high-yield savings account or money market fund.
- **Limited control**: You're locked into one institution's rules about how many buckets you can have, how transfers work, and when you can access your money.
- **Fragmented view**: If you use multiple savings vehicles (a savings account for short-term goals, an investment fund for long-term goals), bank buckets can't span across them.

What if you could keep your money wherever it earns the best return—a high-yield savings account, a money market fund, a brokerage account—and have full control over maturity dates and redemption periods that *you* choose? Immediate access for your emergency fund, a few days for medium-term goals, or 30+ days for long-term savings with better yields. All while still tracking exactly how much is allocated to each savings goal.

## The Solution

Bucket Bot bridges the gap between where your money *actually lives* and how you *want to think about it*.

You maintain two books in [Bkper](https://bkper.com):

1. **General Ledger (GL) Book**: Your real financial accounts—bank accounts, savings accounts, money market funds, or any instrument where your money earns returns.

2. **Bucket Book**: Virtual envelopes that track your savings goals—Emergency Fund, Vacation, New Car, etc.

When money flows into or out of your savings accounts in the GL, Bucket Bot **automatically and instantly** distributes those transactions across your buckets according to your defined percentages. Your physical money stays in high-yield accounts; your mental accounting stays organized in buckets.

## Example

Let's say you have:

**General Ledger Book** (where your money actually is):
- Short Term Savings Account: €8,000 (earns 3.5% APY)
- Long Term Investment Fund: €14,000 (earns 7% average)
- **Total**: €22,000

**Bucket Book** (how you think about your savings):
- Emergency Fund: 45% → €9,900
- Vacation Fund: 20% → €4,400
- New Car Fund: 25% → €5,500
- Gift Fund: 10% → €2,200
- **Total**: €22,000

When you deposit €1,000 into your Short Term Savings Account, Bucket Bot instantly creates four transactions in your Bucket Book:
- €450 → Emergency Fund
- €200 → Vacation Fund
- €250 → New Car Fund
- €100 → Gift Fund

The €1,000 physically stays in your high-yield savings account. The bucket transactions are purely for tracking—showing you exactly how your deposit is allocated across your goals.

When you withdraw €500 specifically for a vacation, you can use the `bucket` property override on the GL transaction to target only the Vacation Fund. Bucket Bot then withdraws from your Vacation Fund bucket, keeping your bucket balances accurate with your GL.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    GENERAL LEDGER BOOK                      │
│  ┌─────────────────────┐  ┌─────────────────────────────┐   │
│  │ Short Term Savings  │  │ Long Term Investment Fund   │   │
│  │ savings:true        │  │ savings:true                │   │
│  │ Balance: €8,000     │  │ Balance: €14,000            │   │
│  └─────────────────────┘  └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         │ Bkper Webhook Events               │ Setup Wizard
         ▼                                    ▼
┌─────────────────┐                 ┌─────────────────┐
│   Bucket Bot    │                 │   Menu UI       │
│  (Cloudflare    │                 │  (Google Apps   │
│   Worker)       │                 │   Script)       │
└─────────────────┘                 └─────────────────┘
         │                                    │
         │ Automatic Distribution             │ Configuration
         ▼                                    ▼
┌─────────────────────────────────────────────────────────────┐
│                       BUCKET BOOK                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │
│  │ Emergency    │ │ Vacation     │ │ New Car      │  ...    │
│  │ percentage:45│ │ percentage:20│ │ percentage:25│         │
│  │ €9,900       │ │ €4,400       │ │ €5,500       │         │
│  └──────────────┘ └──────────────┘ └──────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

Bucket Bot consists of two components:

1. **Cloudflare Worker**: Receives webhook events from Bkper and automatically distributes transactions to buckets in real-time.

2. **Setup Wizard (Menu UI)**: A Google Apps Script web app accessible from Bkper's menu that guides you through configuration with a step-by-step wizard.

## Setup

### Prerequisites

1. A [Bkper](https://bkper.com) account with a GL book in a Collection (the bucket book can be created via the wizard)
2. A [Cloudflare](https://cloudflare.com) account for deploying the Worker
3. [Node.js](https://nodejs.org/) and npm installed
4. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed: `npm install -g wrangler`

### Installation

```bash
git clone https://github.com/anthropics/bucket-bot.git
cd bucket-bot
npm install
```

### Deploy to Cloudflare Workers

1. Authenticate with Cloudflare:
   ```bash
   wrangler login
   ```

2. Set your Bkper API key as a secret:
   ```bash
   wrangler secret put BKPER_API_KEY
   ```

3. Deploy the worker:
   ```bash
   npm run deploy
   ```

4. Note the deployed URL (e.g., `https://bucket-bot.your-subdomain.workers.dev`)

### Register the Bkper Bot

1. Go to [Bkper Developer Console](https://bkper.com/docs/#bots)
2. Create a new Bot with the webhook URL from your deployment
3. Subscribe to these events:
   - `TRANSACTION_POSTED`
   - `TRANSACTION_UPDATED`
   - `TRANSACTION_DELETED`
   - `TRANSACTION_RESTORED`
   - `TRANSACTION_UNTRASHED`
   - `ACCOUNT_CREATED`
   - `ACCOUNT_UPDATED`
   - `ACCOUNT_DELETED`
4. Install the bot on your GL book

### Using the Setup Wizard (Recommended)

Once the bot is installed, the easiest way to configure Bucket Bot is through the **Setup Wizard**:

1. Open your GL book in Bkper
2. Click on the Bucket Bot menu item
3. Follow the 6-step wizard:

| Step | Description |
|------|-------------|
| **1. Bucket Book** | Select an existing book from the collection or create a new one (automatically added to the same collection) |
| **2. Accounts** | Configure income and withdrawal accounts |
| **3. Buckets** | Add bucket accounts and set percentages (must sum to 100%) |
| **4. Savings** | Select which GL accounts should trigger distribution |
| **5. Distribution** | Optionally distribute existing savings balances to buckets based on percentages |
| **6. Review** | Review and apply all changes |

The wizard handles all the property configuration automatically. You can re-run it anytime to modify your setup or reset the configuration.

### Manual Configuration (Alternative)

If you prefer to configure manually, or need to understand the underlying properties:

#### Configure Your GL Book

Add this property to your General Ledger book:

| Property | Value | Description |
|----------|-------|-------------|
| `bucket_book_id` | `abc123...` | The ID of your Bucket Book |

Find your book ID in the Bkper URL: `https://app.bkper.com/b/BOOK_ID_HERE`

Mark your savings accounts with this property:

| Property | Value | Description |
|----------|-------|-------------|
| `savings` | `true` | Transactions on this account will sync to buckets |

You can also set `savings: true` on a **Group** to mark all accounts in that group as savings accounts.

#### Configure Your Bucket Book

Add these properties to your Bucket Book:

| Property | Default | Description |
|----------|---------|-------------|
| `bucket_income_acc` | `Savings` | Name of the Incoming account for deposits (green) |
| `bucket_withdrawal_acc` | `Withdrawal` | Name of the Outgoing account for withdrawals (red) |
| `bucket_hashtag` | - | (Optional) Hashtag appended to synced transactions |

Create these accounts in your Bucket Book:
- An **Incoming** type account (green) for deposits (e.g., "Savings")
- An **Outgoing** type account (red) for withdrawals (e.g., "Withdrawal")

Create your Bucket accounts (Asset type) with this property:

| Property | Value | Description |
|----------|-------|-------------|
| `percentage` | `45` | Percentage of transactions this bucket receives |

**Important**: Percentages must sum to exactly 100%.

## Basic Functionality

### Automatic Transaction Distribution

When a transaction is posted to a savings account in your GL book, Bucket Bot automatically:

1. Detects the direction (deposit or withdrawal)
2. Validates that bucket percentages sum to 100%
3. Creates corresponding transactions in your Bucket Book
4. Validates that GL and Bucket totals match
5. Marks transactions as "checked" if balanced

### Supported Events

| Event | Action |
|-------|--------|
| `TRANSACTION_POSTED` | Creates bucket transactions based on distribution rules |
| `TRANSACTION_UPDATED` | Removes old bucket transactions and creates new ones |
| `TRANSACTION_DELETED` | Trashes corresponding bucket transactions |
| `TRANSACTION_UNTRASHED` | Recreates bucket transactions |
| `ACCOUNT_UPDATED` | Handles savings property changes and archive/unarchive |
| `ACCOUNT_DELETED` | Cleans up bucket transactions for deleted savings accounts |

### Direction Detection

The bot automatically detects whether a transaction is a deposit or withdrawal:

- **Deposit**: Money flows TO a savings account (the debit account has `savings: true`)
- **Withdrawal**: Money flows FROM a savings account (the credit account has `savings: true`)

### Balance Validation

After every distribution, Bucket Bot validates that:

```
Sum of GL savings accounts = Sum of Bucket accounts
```

If balanced, all new transactions are automatically marked as "checked" in Bkper.
If there's a mismatch, transactions remain unchecked for manual review.

## Advanced Features

### I. Suffix-Based Routing

Route transactions to specific subsets of buckets using uppercase suffixes.

**Example**: You have short-term and long-term savings accounts, and want deposits to each to go to different buckets.

GL Accounts:
- `Short Term Savings QUICK` (savings: true)
- `Long Term Fund GROW` (savings: true)

Bucket Accounts:
- `Emergency Fund QUICK` (percentage: 60)
- `Vacation Fund QUICK` (percentage: 40)
- `Retirement GROW` (percentage: 70)
- `Investment GROW` (percentage: 30)

When €1,000 is deposited to "Short Term Savings QUICK":
- Only QUICK buckets receive the distribution
- Emergency Fund gets 60% → €600
- Vacation Fund gets 40% → €400

The GROW buckets are untouched. Percentages are automatically normalized within the matching suffix group.

**Suffix Rules**:
- Suffix is the last word if entirely UPPERCASE (A-Z only)
- Can be applied on the Account name or the parent Group name
- Examples: `"Savings LONG"` → suffix `LONG`, `"Emergency"` → no suffix

### II. Transaction-Level Bucket Override

Override the default routing for specific transactions using the `bucket` property.

Add to a GL transaction:

| Property | Value |
|----------|-------|
| `bucket` | `Vacation, Emergency` |

This transaction will be split **evenly** between only the Vacation and Emergency buckets, ignoring the normal percentage distribution and any suffix routing.

**Use cases**:
- A bonus specifically for vacation
- A gift earmarked for a specific goal
- Correcting a previous distribution

### III. Account Lifecycle Management

Bucket Bot automatically handles account changes:

**When `savings: true` is added to an existing account:**
- Initializes bucket transactions for the current account balance
- Only initializes if the account is an Asset type with balance > 0

**When `savings: true` is removed from an account:**
- Trashes all bucket transactions linked to that account

**When a savings account is archived:**
- Trashes all bucket transactions for that account

**When a savings account is unarchived:**
- Reinitializes bucket transactions with the current balance

**When a savings account is deleted:**
- Cleans up all related bucket transactions

### IV. GL Traceability

Every bucket transaction maintains links back to the GL for full traceability:

| Field | Purpose |
|-------|---------|
| `gl_account_id` property | Links to the savings account ID in GL |
| `#gl_{account_name}` hashtag | Human-readable link in description |
| `remoteId` | Links to original GL transaction ID |

The `remoteId` format ensures uniqueness and prevents duplicates:
```
{glTransactionId}_{bucketAccountName}_{timestamp}
```

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npx tsc --noEmit

# Start local dev server
npm run dev
```

### Project Structure

```
src/                        # Cloudflare Worker (webhook handler)
├── index.ts                # Main app, routes, event orchestration
├── webhook.ts              # Savings detection, suffix extraction
├── bucket.ts               # Distribution logic, transaction management
└── types.ts                # TypeScript type definitions

menu/                       # Google Apps Script (setup wizard)
└── src/
    ├── Bot.ts              # Entry point, exposed functions
    ├── WizardView.html     # Multi-step wizard UI
    ├── WizardService.ts    # Wizard logic and state management
    ├── BookService.ts      # Book operations
    ├── AccountService.ts   # Account operations
    ├── TransactionService.ts # Transaction operations
    └── Types.ts            # TypeScript interfaces

test/
├── webhook.spec.ts         # Savings detection tests
└── bucket.spec.ts          # Distribution logic tests
```

### Testing with Local Tunnel

For local development with real Bkper webhooks:

1. Start the dev server:
   ```bash
   npm run dev
   ```

2. Expose via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
   ```bash
   cloudflared tunnel --url http://localhost:8787
   ```

3. Update your Bkper Bot webhook URL to the tunnel URL

## Error Handling

Bucket Bot includes guards for common error conditions:

| Condition | Handling |
|-----------|----------|
| No `bucket_book_id` on GL book | Skips processing |
| Percentages don't sum to 100% | Returns error, no distribution |
| Missing bucket override accounts | Returns error listing missing accounts |
| No suffix-matching buckets found | Returns error |
| Account balance ≤ 0 for initialization | Skips initialization |
| Non-Asset account for initialization | Skips initialization |

## License

MIT
