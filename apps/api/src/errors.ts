export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public detail?: unknown) { super(message ?? code); }
}
