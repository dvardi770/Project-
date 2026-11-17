import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** An error that is safe to show to API clients. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message: string) => new HttpError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (code: string, message: string) => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);

export const serviceUnavailable = (code: string, message: string) => new HttpError(503, code, message);
export const badGateway = (code: string, message: string) => new HttpError(502, code, message);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof HttpError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      // Fastify's own client errors: malformed JSON, payload too large, …
      return reply.status(status).send({ error: { code: 'bad_request', message: err.message } });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } }),
  );
}
