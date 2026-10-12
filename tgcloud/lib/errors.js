export class AppError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'AppError'; this.code = code; this.details = details; }
}
export function fail(code, message, details) { throw new AppError(code, message, details); }
