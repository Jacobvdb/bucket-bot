namespace WizardService {

  /**
   * Get the wizard HTML template
   */
  export function getWizardTemplate(bookId: string): GoogleAppsScript.HTML.HtmlOutput {
    const book = BkperApp.getBook(bookId);

    const template = HtmlService.createTemplateFromFile('WizardView');
    template.glBookId = bookId;
    template.glBookName = book.getName();

    // Check permissions
    if (!BookService.canUserEditBook(book)) {
      template.canEdit = false;
      template.permissionError = `You need EDITOR or OWNER permission in ${book.getName()} book`;
    } else {
      template.canEdit = true;
      template.permissionError = null;
    }

    // Check if already configured
    const bucketBookId = book.getProperty(BUCKET_BOOK_ID_PROP);
    template.isEditMode = !!bucketBookId;
    template.bucketBookId = bucketBookId || null;

    return template.evaluate()
      .setTitle('Bucket Bot Setup')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  /**
   * Load the full wizard state for client-side rendering
   */
  export function loadState(glBookId: string): WizardState {
    const glBook = BkperApp.getBook(glBookId);

    const state: WizardState = {
      glBookId: glBookId,
      glBookName: glBook.getName(),
      isEditMode: false,
      canEdit: BookService.canUserEditBook(glBook),
      permissionError: null,

      // Step 1
      bucketBookId: null,
      bucketBookName: null,
      availableBooks: [],
      createNewBucketBook: false,

      // Step 2
      incomeAccountName: 'Savings',
      withdrawalAccountName: 'Withdrawal',
      availableIncomingAccounts: [],
      availableOutgoingAccounts: [],

      // Step 3
      buckets: [],
      availableBucketAccounts: [],

      // Step 4
      savingsAccountIds: [],
      availableGlAssetAccounts: [],
      currentSavingsAccounts: [],

      // Step 5
      distributions: [],
      showDistributionStep: false
    };

    if (!state.canEdit) {
      state.permissionError = `You need EDITOR or OWNER permission in ${glBook.getName()} book`;
      return state;
    }

    // Get available books in collection
    state.availableBooks = BookService.getCollectionBooks(glBookId);

    // Get current savings accounts in GL book
    state.currentSavingsAccounts = AccountService.getSavingsAccounts(glBookId);
    state.savingsAccountIds = state.currentSavingsAccounts.map(a => a.id);

    // Get all asset accounts in GL book for selection
    state.availableGlAssetAccounts = AccountService.getAccountsByType(glBookId, 'ASSET');

    // Check if already configured
    const bucketBookId = glBook.getProperty(BUCKET_BOOK_ID_PROP);
    if (bucketBookId) {
      state.isEditMode = true;
      state.bucketBookId = bucketBookId;

      try {
        const bucketBook = BkperApp.getBook(bucketBookId);
        state.bucketBookName = bucketBook.getName();

        // Load bucket book accounts
        state.incomeAccountName = bucketBook.getProperty(BUCKET_INCOME_ACC_PROP) || 'Savings';
        state.withdrawalAccountName = bucketBook.getProperty(BUCKET_WITHDRAWAL_ACC_PROP) || 'Withdrawal';

        state.availableIncomingAccounts = AccountService.getAccountsByType(bucketBookId, 'INCOMING');
        state.availableOutgoingAccounts = AccountService.getAccountsByType(bucketBookId, 'OUTGOING');

        // Load bucket accounts
        state.availableBucketAccounts = AccountService.getBucketAccounts(bucketBookId);
        state.buckets = state.availableBucketAccounts.map(a => ({
          id: a.id,
          name: a.name,
          percentage: a.percentage,
          isNew: false
        }));
      } catch (e) {
        // Bucket book may have been deleted
        state.isEditMode = false;
        state.bucketBookId = null;
      }
    }

    // Check if distribution step should be shown
    const totalBalance = state.currentSavingsAccounts.reduce((sum, a) => sum + a.balance, 0);
    state.showDistributionStep = totalBalance > 0;

    if (state.showDistributionStep) {
      state.distributions = buildDistributions(state);
    }

    return state;
  }

  /**
   * Build suffix-grouped distributions
   */
  function buildDistributions(state: WizardState): SuffixDistribution[] {
    const distributions: SuffixDistribution[] = [];
    const suffixGroups: Map<string | null, SavingsAccountInfo[]> = new Map();

    // Group savings accounts by suffix
    for (const account of state.currentSavingsAccounts) {
      const suffix = account.suffix;
      if (!suffixGroups.has(suffix)) {
        suffixGroups.set(suffix, []);
      }
      suffixGroups.get(suffix)!.push(account);
    }

    // Build distribution for each suffix group
    for (const [suffix, accounts] of suffixGroups) {
      const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

      // Filter buckets by suffix
      const matchingBuckets = state.availableBucketAccounts.filter(b =>
        suffix === null || b.suffix === suffix || b.suffix === null
      );

      // Calculate bucket amounts based on percentages
      const bucketAmounts: { [bucketName: string]: number } = {};
      const totalPercentage = matchingBuckets.reduce((sum, b) => sum + b.percentage, 0);

      for (const bucket of matchingBuckets) {
        const normalizedPercentage = totalPercentage > 0 ? (bucket.percentage / totalPercentage) * 100 : 0;
        bucketAmounts[bucket.name] = Math.round((normalizedPercentage / 100) * totalBalance * 100) / 100;
      }

      distributions.push({
        suffix: suffix,
        totalBalance: totalBalance,
        savingsAccounts: accounts.map(a => ({
          id: a.id,
          name: a.name,
          balance: a.balance
        })),
        bucketAmounts: bucketAmounts
      });
    }

    return distributions;
  }

  /**
   * Apply the complete wizard configuration
   */
  export function applyConfiguration(config: ApplyConfig): ApplyResult {
    const result: ApplyResult = {
      success: false,
      bucketBookId: null,
      accountsCreated: 0,
      propertiesSet: 0,
      transactionsCreated: 0,
      error: null
    };

    try {
      let bucketBookId = config.bucketBookId;

      // Step 1: Create or link bucket book
      if (config.createNewBucketBook) {
        bucketBookId = BookService.createBucketBook(config.glBookId, config.newBucketBookName);
        result.accountsCreated++;
      }

      if (!bucketBookId) {
        throw new Error('No bucket book selected or created');
      }

      result.bucketBookId = bucketBookId;

      // Link bucket book to GL
      BookService.linkBucketBook(config.glBookId, bucketBookId);
      result.propertiesSet++;

      // Step 2: Create income/withdrawal accounts
      if (config.createNewIncomeAccount) {
        AccountService.createAccount(bucketBookId, config.incomeAccountName, 'INCOMING');
        result.accountsCreated++;
      }

      if (config.createNewWithdrawalAccount) {
        AccountService.createAccount(bucketBookId, config.withdrawalAccountName, 'OUTGOING');
        result.accountsCreated++;
      }

      // Set bucket book properties
      BookService.setBucketBookProperties(
        bucketBookId,
        config.incomeAccountName,
        config.withdrawalAccountName
      );
      result.propertiesSet++;

      // Step 3: Create bucket accounts and set percentages
      for (const bucket of config.buckets) {
        if (bucket.isNew) {
          AccountService.createAccount(bucketBookId, bucket.name, 'ASSET');
          result.accountsCreated++;
        }
        AccountService.setPercentage(bucketBookId, bucket.name, bucket.percentage);
        result.propertiesSet++;
      }

      // Step 4: Set savings property on GL accounts
      const currentSavings = AccountService.getSavingsAccounts(config.glBookId);
      const currentSavingsIds = currentSavings.map(a => a.id);
      AccountService.setSavingsPropertyBatch(config.glBookId, config.savingsAccountIds, currentSavingsIds);
      result.propertiesSet += config.savingsAccountIds.length;

      // Create new savings account if specified
      if (config.newSavingsAccountName) {
        const newAccount = AccountService.createAccount(config.glBookId, config.newSavingsAccountName, 'ASSET');
        AccountService.setSavingsProperty(config.glBookId, config.newSavingsAccountName, true);
        result.accountsCreated++;
        result.propertiesSet++;
      }

      // Step 5: Create initial distribution transactions
      if (config.distributions && config.distributions.length > 0) {
        const hasDistributions = config.distributions.some(d =>
          Object.values(d.bucketAmounts).some(amount => amount > 0)
        );

        if (hasDistributions) {
          result.transactionsCreated = TransactionService.createInitialDistribution(
            bucketBookId,
            config.incomeAccountName,
            config.distributions
          );
        }
      }

      result.success = true;
    } catch (e) {
      result.success = false;
      result.error = e instanceof Error ? e.message : 'Unknown error occurred';
    }

    return result;
  }

  /**
   * Reset configuration - trash all bucket transactions and clear properties
   */
  export function resetConfiguration(glBookId: string): ResetResult {
    const result: ResetResult = {
      success: false,
      transactionsTrashed: 0,
      error: null
    };

    try {
      const glBook = BkperApp.getBook(glBookId);
      const bucketBookId = glBook.getProperty(BUCKET_BOOK_ID_PROP);

      if (bucketBookId) {
        // Trash all bucket transactions
        result.transactionsTrashed = TransactionService.trashAllBucketTransactions(bucketBookId);

        // Clear bucket_book_id property
        BookService.unlinkBucketBook(glBookId);
      }

      result.success = true;
    } catch (e) {
      result.success = false;
      result.error = e instanceof Error ? e.message : 'Unknown error occurred';
    }

    return result;
  }

}
