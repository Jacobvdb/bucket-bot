namespace AccountService {

  /**
   * Extract suffix from account name (last word if all uppercase)
   */
  export function extractSuffix(name: string): string | null {
    if (!name) return null;

    const words = name.trim().split(/\s+/);
    if (words.length < 2) return null;

    const lastWord = words[words.length - 1];
    if (/^[A-Z]+$/.test(lastWord)) {
      return lastWord;
    }
    return null;
  }

  /**
   * Get account balance
   */
  function getAccountBalance(book: Bkper.Book, accountName: string): number {
    try {
      const report = book.getBalancesReport(`account:"${accountName}"`);
      const containers = report.getBalancesContainers();
      if (containers && containers.length > 0) {
        const balance = containers[0].getCumulativeBalance();
        return balance ? balance.toNumber() : 0;
      }
    } catch (e) {
      // Account may not have any transactions
    }
    return 0;
  }

  /**
   * Get accounts by type
   */
  export function getAccountsByType(bookId: string, type: string): AccountInfo[] {
    const book = BkperApp.getBook(bookId);
    const accounts = book.getAccounts();
    const result: AccountInfo[] = [];

    for (const account of accounts) {
      if (account.getType() === type && !account.isArchived()) {
        result.push({
          id: account.getId(),
          name: account.getName(),
          type: account.getType(),
          balance: getAccountBalance(book, account.getName())
        });
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get bucket accounts (ASSET accounts with percentage property)
   */
  export function getBucketAccounts(bucketBookId: string): BucketAccountInfo[] {
    const book = BkperApp.getBook(bucketBookId);
    const accounts = book.getAccounts();
    const result: BucketAccountInfo[] = [];

    for (const account of accounts) {
      if (account.getType() === 'ASSET' && !account.isArchived()) {
        const percentageStr = account.getProperty(PERCENTAGE_PROP);
        if (percentageStr) {
          result.push({
            id: account.getId(),
            name: account.getName(),
            percentage: parseFloat(percentageStr) || 0,
            suffix: extractSuffix(account.getName()),
            balance: getAccountBalance(book, account.getName())
          });
        }
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get savings accounts from GL book (accounts with savings:true)
   */
  export function getSavingsAccounts(glBookId: string): SavingsAccountInfo[] {
    const book = BkperApp.getBook(glBookId);
    const accounts = book.getAccounts();
    const result: SavingsAccountInfo[] = [];

    for (const account of accounts) {
      if (account.getType() === 'ASSET' && !account.isArchived()) {
        const savingsValue = account.getProperty(SAVINGS_PROP);
        if (savingsValue === 'true') {
          result.push({
            id: account.getId(),
            name: account.getName(),
            balance: getAccountBalance(book, account.getName()),
            suffix: extractSuffix(account.getName()),
            hasSavingsProperty: true
          });
        }
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create an account in a book
   */
  export function createAccount(
    bookId: string,
    name: string,
    type: 'ASSET' | 'LIABILITY' | 'INCOMING' | 'OUTGOING'
  ): Bkper.Account {
    const book = BkperApp.getBook(bookId);

    // Check if account already exists
    const existing = book.getAccount(name);
    if (existing) {
      return existing;
    }

    const accountType = type === 'ASSET' ? BkperApp.AccountType.ASSET
      : type === 'LIABILITY' ? BkperApp.AccountType.LIABILITY
        : type === 'INCOMING' ? BkperApp.AccountType.INCOMING
          : BkperApp.AccountType.OUTGOING;

    return book.newAccount()
      .setName(name)
      .setType(accountType)
      .create();
  }

  /**
   * Set percentage property on bucket account
   */
  export function setPercentage(bookId: string, accountName: string, percentage: number): void {
    const book = BkperApp.getBook(bookId);
    const account = book.getAccount(accountName);
    if (account) {
      account.setProperty(PERCENTAGE_PROP, percentage.toString()).update();
    }
  }

  /**
   * Set savings property on GL account
   */
  export function setSavingsProperty(bookId: string, accountName: string, value: boolean): void {
    const book = BkperApp.getBook(bookId);
    const account = book.getAccount(accountName);
    if (account) {
      if (value) {
        account.setProperty(SAVINGS_PROP, 'true').update();
      } else {
        account.deleteProperty(SAVINGS_PROP).update();
      }
    }
  }

  /**
   * Batch set savings property on multiple accounts
   */
  export function setSavingsPropertyBatch(
    bookId: string,
    accountIds: string[],
    currentSavingsIds: string[]
  ): void {
    const book = BkperApp.getBook(bookId);
    const accountIdsSet = new Set(accountIds);
    const currentSet = new Set(currentSavingsIds);

    // Add savings:true to newly selected accounts
    for (const accountId of accountIds) {
      if (!currentSet.has(accountId)) {
        const account = book.getAccounts().find(a => a.getId() === accountId);
        if (account) {
          account.setProperty(SAVINGS_PROP, 'true').update();
        }
      }
    }

    // Remove savings property from deselected accounts
    for (const accountId of currentSavingsIds) {
      if (!accountIdsSet.has(accountId)) {
        const account = book.getAccounts().find(a => a.getId() === accountId);
        if (account) {
          account.deleteProperty(SAVINGS_PROP).update();
        }
      }
    }
  }

  /**
   * Get ALL Asset accounts from bucket book for Percentage Manager
   * Returns percentage as null if not set
   */
  export function getAllBucketAssets(bucketBookId: string): PercentageManagerAccount[] {
    const book = BkperApp.getBook(bucketBookId);
    const accounts = book.getAccounts();
    const result: PercentageManagerAccount[] = [];

    for (const account of accounts) {
      if (account.getType() === 'ASSET' && !account.isArchived()) {
        const percentageStr = account.getProperty(PERCENTAGE_PROP);
        result.push({
          id: account.getId(),
          name: account.getName(),
          percentage: percentageStr ? parseFloat(percentageStr) : null
        });
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Save percentages for all accounts in Percentage Manager
   */
  export function savePercentages(
    bucketBookId: string,
    percentages: { accountId: string; percentage: number }[]
  ): SavePercentagesResult {
    const result: SavePercentagesResult = {
      success: false,
      accountsUpdated: 0,
      error: null
    };

    try {
      const book = BkperApp.getBook(bucketBookId);
      const accounts = book.getAccounts();
      const accountMap = new Map<string, Bkper.Account>();

      for (const account of accounts) {
        accountMap.set(account.getId(), account);
      }

      for (const { accountId, percentage } of percentages) {
        const account = accountMap.get(accountId);
        if (account) {
          account.setProperty(PERCENTAGE_PROP, percentage.toString()).update();
          result.accountsUpdated++;
        }
      }

      result.success = true;
    } catch (e) {
      result.success = false;
      result.error = e instanceof Error ? e.message : 'Unknown error';
    }

    return result;
  }

}
