namespace BookService {

  /**
   * Get the GL book by ID
   */
  export function getGlBook(bookId: string): Bkper.Book {
    return BkperApp.getBook(bookId);
  }

  /**
   * Get all books in the collection (excluding the current GL book)
   */
  export function getCollectionBooks(glBookId: string): BookInfo[] {
    const glBook = BkperApp.getBook(glBookId);
    const collection = glBook.getCollection();
    const currentBucketBookId = glBook.getProperty(BUCKET_BOOK_ID_PROP);

    const books: BookInfo[] = [];

    if (collection) {
      for (const book of collection.getBooks()) {
        books.push({
          id: book.getId(),
          name: book.getName(),
          currencyCode: book.getProperty('exc_code') || '',
          isCurrentGlBook: book.getId() === glBookId,
          isBucketBook: book.getId() === currentBucketBookId
        });
      }
    }

    return books;
  }

  /**
   * Create a new bucket book via REST API
   * Inherits settings from GL book and adds to collection
   */
  export function createBucketBook(glBookId: string, name: string): string {
    const glBook = BkperApp.getBook(glBookId);
    const collection = glBook.getCollection();

    if (!collection) {
      throw new Error('GL book must be in a collection to create a bucket book');
    }

    const collectionId = collection.getId();
    const decimalSeparator = glBook.getDecimalSeparator();
    const decimalSeparatorValue = decimalSeparator === BkperApp.DecimalSeparator.COMMA ? 'COMMA' : 'DOT';

    const payload = {
      name: name,
      fractionDigits: glBook.getFractionDigits(),
      timeZone: glBook.getTimeZone(),
      datePattern: glBook.getDatePattern(),
      decimalSeparator: decimalSeparatorValue
    };

    const token = ScriptApp.getOAuthToken();
    const headers = { 'Authorization': 'Bearer ' + token };

    // Step 1: Create the book
    const createResponse = UrlFetchApp.fetch('https://app.bkper.com/_ah/api/bkper/v5/books', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const createCode = createResponse.getResponseCode();
    if (createCode !== 200 && createCode !== 201) {
      throw new Error('Failed to create book: ' + createResponse.getContentText());
    }

    const createdBook = JSON.parse(createResponse.getContentText());
    const bookId = createdBook.id;

    // Step 2: Add the book to the collection
    const addToCollectionPayload = {
      items: [{ id: bookId }]
    };

    const addResponse = UrlFetchApp.fetch(
      `https://app.bkper.com/_ah/api/bkper/v5/collections/${collectionId}/books/add`,
      {
        method: 'patch',
        contentType: 'application/json',
        headers: headers,
        payload: JSON.stringify(addToCollectionPayload),
        muteHttpExceptions: true
      }
    );

    const addCode = addResponse.getResponseCode();
    if (addCode !== 200) {
      throw new Error('Failed to add book to collection: ' + addResponse.getContentText());
    }

    return bookId;
  }

  /**
   * Link a bucket book to the GL book
   */
  export function linkBucketBook(glBookId: string, bucketBookId: string): void {
    const glBook = BkperApp.getBook(glBookId);
    glBook.setProperty(BUCKET_BOOK_ID_PROP, bucketBookId).update();
  }

  /**
   * Get the linked bucket book (if any)
   */
  export function getBucketBook(glBookId: string): Bkper.Book | null {
    const glBook = BkperApp.getBook(glBookId);
    const bucketBookId = glBook.getProperty(BUCKET_BOOK_ID_PROP);

    if (!bucketBookId) {
      return null;
    }

    try {
      return BkperApp.getBook(bucketBookId);
    } catch (e) {
      return null;
    }
  }

  /**
   * Set bucket book properties (income/withdrawal account names)
   */
  export function setBucketBookProperties(
    bucketBookId: string,
    incomeAccountName: string,
    withdrawalAccountName: string,
    hashtag?: string
  ): void {
    const book = BkperApp.getBook(bucketBookId);
    book.setProperty(BUCKET_INCOME_ACC_PROP, incomeAccountName);
    book.setProperty(BUCKET_WITHDRAWAL_ACC_PROP, withdrawalAccountName);
    if (hashtag) {
      book.setProperty(BUCKET_HASHTAG_PROP, hashtag);
    }
    book.update();
  }

  /**
   * Clear bucket book link from GL book
   */
  export function unlinkBucketBook(glBookId: string): void {
    const glBook = BkperApp.getBook(glBookId);
    glBook.deleteProperty(BUCKET_BOOK_ID_PROP).update();
  }

  /**
   * Check if user can edit the book
   */
  export function canUserEditBook(book: Bkper.Book): boolean {
    const permission = book.getPermission();
    return permission === BkperApp.Permission.EDITOR || permission === BkperApp.Permission.OWNER;
  }

}
