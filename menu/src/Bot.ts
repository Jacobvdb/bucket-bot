BkperApp.setApiKey(PropertiesService.getScriptProperties().getProperty('API_KEY'));

// Property constants
const BUCKET_BOOK_ID_PROP = 'bucket_book_id';
const BUCKET_INCOME_ACC_PROP = 'bucket_income_acc';
const BUCKET_WITHDRAWAL_ACC_PROP = 'bucket_withdrawal_acc';
const BUCKET_HASHTAG_PROP = 'bucket_hashtag';
const SAVINGS_PROP = 'savings';
const PERCENTAGE_PROP = 'percentage';

/**
 * Entry point for the web app
 */
function doGet(e: GoogleAppsScript.Events.AppsScriptHttpRequestEvent): GoogleAppsScript.HTML.HtmlOutput {
  const bookId = e.parameter.bookId;
  return WizardService.getWizardTemplate(bookId);
}

/**
 * Load wizard state - detects existing configuration
 */
function loadWizardState(glBookId: string): WizardState {
  return WizardService.loadState(glBookId);
}

/**
 * Get books in the collection for bucket book selection
 */
function getCollectionBooks(glBookId: string): BookInfo[] {
  return BookService.getCollectionBooks(glBookId);
}

/**
 * Create a new bucket book in the collection
 */
function createBucketBook(glBookId: string, name: string): string {
  return BookService.createBucketBook(glBookId, name);
}

/**
 * Get accounts by type from a book
 */
function getAccountsByType(bookId: string, type: string): AccountInfo[] {
  return AccountService.getAccountsByType(bookId, type);
}

/**
 * Get bucket accounts with percentages
 */
function getBucketAccounts(bucketBookId: string): BucketAccountInfo[] {
  return AccountService.getBucketAccounts(bucketBookId);
}

/**
 * Get savings accounts with balances from GL book
 */
function getSavingsAccounts(glBookId: string): SavingsAccountInfo[] {
  return AccountService.getSavingsAccounts(glBookId);
}

/**
 * Get all asset accounts from GL book (for savings selection)
 */
function getGlAssetAccounts(glBookId: string): AccountInfo[] {
  return AccountService.getAccountsByType(glBookId, 'ASSET');
}

/**
 * Apply the complete wizard configuration
 */
function applyConfiguration(config: ApplyConfig): ApplyResult {
  return WizardService.applyConfiguration(config);
}

/**
 * Reset configuration - trash bucket transactions and clear properties
 */
function resetConfiguration(glBookId: string): ResetResult {
  return WizardService.resetConfiguration(glBookId);
}

/**
 * Get all Asset accounts from bucket book for Percentage Manager
 */
function getAllBucketAssets(bucketBookId: string): PercentageManagerAccount[] {
  return AccountService.getAllBucketAssets(bucketBookId);
}

/**
 * Save percentages for accounts in Percentage Manager
 */
function savePercentages(
  bucketBookId: string,
  percentages: { accountId: string; percentage: number }[]
): SavePercentagesResult {
  return AccountService.savePercentages(bucketBookId, percentages);
}
