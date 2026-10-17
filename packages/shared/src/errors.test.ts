import { describe, expect, it } from 'vitest';
import { isProblemDetails, problemDetailsSchema } from './errors.ts';

const valid = {
  type: 'about:blank',
  title: 'Not Found',
  status: 404,
  code: 'NOT_FOUND',
  requestId: '3f0e6a52-1d7c-4f0e-9a39-5a0a5f7c2b11',
};

describe('problemDetailsSchema', () => {
  it('accepts a minimal problem document', () => {
    expect(isProblemDetails(valid)).toBe(true);
  });

  it('accepts field-level validation errors', () => {
    const parsed = problemDetailsSchema.parse({
      ...valid,
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'body.email', message: 'Invalid email address' }],
    });
    expect(parsed.errors).toHaveLength(1);
  });

  it('rejects unknown error codes so clients can rely on the enum', () => {
    expect(isProblemDetails({ ...valid, code: 'SOMETHING_ELSE' })).toBe(false);
  });

  it('rejects non-error HTTP statuses', () => {
    expect(isProblemDetails({ ...valid, status: 200 })).toBe(false);
  });

  it('requires a requestId for support correlation', () => {
    const { requestId: _omit, ...withoutRequestId } = valid;
    expect(isProblemDetails(withoutRequestId)).toBe(false);
  });
});
