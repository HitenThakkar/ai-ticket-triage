/** Error carried out to the HTTP layer with an explicit status code and machine-readable code. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }

  static badRequest(message, details) {
    return new HttpError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Missing or invalid API key') {
    return new HttpError(401, 'unauthorized', message);
  }
  static notFound(message = 'Resource not found') {
    return new HttpError(404, 'not_found', message);
  }
  static conflict(message, details) {
    return new HttpError(409, 'conflict', message, details);
  }
}
