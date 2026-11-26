// Errors the API answers with: an HTTP status, a stable machine-readable code,
// a human message the app can show, and an optional Retry-After in seconds.

export class HttpError extends Error {
  constructor(status, code, message, retryAfterSec) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}
