namespace TransactionService {

  const GL_ACCOUNT_ID_PROP = 'gl_account_id';

  /**
   * Create initial distribution transactions in bucket book
   */
  export function createInitialDistribution(
    bucketBookId: string,
    incomeAccountName: string,
    distributions: SuffixDistribution[]
  ): number {
    const book = BkperApp.getBook(bucketBookId);
    const incomeAccount = book.getAccount(incomeAccountName);

    if (!incomeAccount) {
      throw new Error(`Income account not found: ${incomeAccountName}`);
    }

    const today = Utilities.formatDate(new Date(), book.getTimeZone(), 'yyyy-MM-dd');
    const transactions: Bkper.Transaction[] = [];

    for (const dist of distributions) {
      for (const savingsAccount of dist.savingsAccounts) {
        for (const bucketName in dist.bucketAmounts) {
          const amount = dist.bucketAmounts[bucketName];
          if (amount > 0) {
            const bucketAccount = book.getAccount(bucketName);
            if (!bucketAccount) {
              throw new Error(`Bucket account not found: ${bucketName}`);
            }

            const tx = book.newTransaction()
              .setDate(today)
              .setAmount(amount)
              .setDescription('Initial balance')
              .from(incomeAccount)
              .to(bucketAccount)
              .setProperty(GL_ACCOUNT_ID_PROP, savingsAccount.id);

            transactions.push(tx);
          }
        }
      }
    }

    if (transactions.length > 0) {
      book.batchCreateTransactions(transactions);
    }

    return transactions.length;
  }

  /**
   * Trash all bucket transactions (for reset)
   * Returns the number of transactions trashed
   */
  export function trashAllBucketTransactions(bucketBookId: string): number {
    const book = BkperApp.getBook(bucketBookId);

    // Find all transactions with gl_account_id property
    const iterator = book.listTransactions(`${GL_ACCOUNT_ID_PROP}:*`);
    const transactions: Bkper.Transaction[] = [];

    while (iterator.hasNext()) {
      transactions.push(iterator.next());
    }

    if (transactions.length > 0) {
      book.batchTrashTransactions(transactions, true);
    }

    return transactions.length;
  }

  /**
   * Trash bucket transactions for a specific GL account
   */
  export function trashBucketTransactionsForAccount(
    bucketBookId: string,
    glAccountId: string
  ): number {
    const book = BkperApp.getBook(bucketBookId);

    const iterator = book.listTransactions(`${GL_ACCOUNT_ID_PROP}:"${glAccountId}"`);
    const transactions: Bkper.Transaction[] = [];

    while (iterator.hasNext()) {
      transactions.push(iterator.next());
    }

    if (transactions.length > 0) {
      book.batchTrashTransactions(transactions, true);
    }

    return transactions.length;
  }

}
