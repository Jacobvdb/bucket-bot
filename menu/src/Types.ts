/**
 * Information about a book in the collection
 */
interface BookInfo {
  id: string;
  name: string;
  currencyCode: string;
  isCurrentGlBook: boolean;
  isBucketBook: boolean;
}

/**
 * Basic account information
 */
interface AccountInfo {
  id: string;
  name: string;
  type: string;
  balance: number;
}

/**
 * Bucket account with percentage
 */
interface BucketAccountInfo {
  id: string;
  name: string;
  percentage: number;
  suffix: string | null;
  balance: number;
}

/**
 * Savings account in GL book
 */
interface SavingsAccountInfo {
  id: string;
  name: string;
  balance: number;
  suffix: string | null;
  hasSavingsProperty: boolean;
}

/**
 * Bucket configuration for wizard
 */
interface BucketConfig {
  id: string | null;  // null if creating new
  name: string;
  percentage: number;
  isNew: boolean;
}

/**
 * Distribution for a suffix group
 */
interface SuffixDistribution {
  suffix: string | null;
  totalBalance: number;
  savingsAccounts: { id: string; name: string; balance: number }[];
  bucketAmounts: { [bucketName: string]: number };
}

/**
 * Complete wizard state
 */
interface WizardState {
  glBookId: string;
  glBookName: string;
  isEditMode: boolean;
  canEdit: boolean;
  permissionError: string | null;

  // Step 1: Bucket Book
  bucketBookId: string | null;
  bucketBookName: string | null;
  availableBooks: BookInfo[];
  createNewBucketBook: boolean;

  // Step 2: Income/Withdrawal Accounts
  incomeAccountName: string;
  withdrawalAccountName: string;
  availableIncomingAccounts: AccountInfo[];
  availableOutgoingAccounts: AccountInfo[];

  // Step 3: Bucket Accounts
  buckets: BucketConfig[];
  availableBucketAccounts: BucketAccountInfo[];

  // Step 4: GL Savings Accounts
  savingsAccountIds: string[];
  availableGlAssetAccounts: AccountInfo[];
  currentSavingsAccounts: SavingsAccountInfo[];

  // Step 5: Initial Distribution
  distributions: SuffixDistribution[];
  showDistributionStep: boolean;
}

/**
 * Configuration to apply
 */
interface ApplyConfig {
  glBookId: string;

  // Bucket book
  bucketBookId: string | null;
  createNewBucketBook: boolean;
  newBucketBookName: string;

  // Accounts
  incomeAccountName: string;
  withdrawalAccountName: string;
  createNewIncomeAccount: boolean;
  createNewWithdrawalAccount: boolean;

  // Buckets
  buckets: BucketConfig[];

  // Savings
  savingsAccountIds: string[];
  newSavingsAccountName: string | null;

  // Distribution
  bucketAmounts: { [bucketName: string]: number };
}

/**
 * Result of applying configuration
 */
interface ApplyResult {
  success: boolean;
  bucketBookId: string | null;
  accountsCreated: number;
  propertiesSet: number;
  transactionsCreated: number;
  error: string | null;
}

/**
 * Result of resetting configuration
 */
interface ResetResult {
  success: boolean;
  transactionsTrashed: number;
  error: string | null;
}
