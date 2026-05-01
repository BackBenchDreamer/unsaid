/**
 * Centralized error types for the service layer.
 */

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class AuthError extends ServiceError {
  constructor(message: string, details?: unknown) {
    super(message, 'AUTH_ERROR', 401, details);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends ServiceError {
  constructor(message: string = 'Access denied') {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ServiceError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ServiceError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends ServiceError {
  constructor(errors: string[]) {
    super(errors.join('; '), 'VALIDATION', 400, errors);
    this.name = 'ValidationError';
  }
}

/**
 * Wrap a Supabase response and throw on error.
 */
export function unwrap<T>(result: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (result.error) {
    throw new ServiceError(
      result.error.message,
      result.error.code ?? 'SUPABASE_ERROR',
    );
  }
  if (result.data === null) {
    throw new NotFoundError('Resource');
  }
  return result.data;
}
