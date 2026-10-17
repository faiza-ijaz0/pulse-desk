import type { Request, Response } from 'express';
import {
  PROBLEM_CONTENT_TYPE,
  type ErrorCode,
  type FieldError,
  type ProblemDetails,
} from '@pulsedesk/shared';

export type ProblemInput = {
  status: number;
  code: ErrorCode;
  title: string;
  detail?: string | undefined;
  errors?: FieldError[] | undefined;
};

/** Writes an RFC 9457 problem response. The single place that shapes error bodies. */
export function sendProblem(req: Request, res: Response, problem: ProblemInput): void {
  const body: ProblemDetails = {
    type: 'about:blank',
    title: problem.title,
    status: problem.status,
    code: problem.code,
    instance: req.originalUrl,
    // requestContext always assigns a string ID; the fallback only guards misconfiguration.
    requestId: typeof req.id === 'string' ? req.id : 'unknown',
    ...(problem.detail !== undefined && { detail: problem.detail }),
    ...(problem.errors !== undefined && { errors: problem.errors }),
  };
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
}
