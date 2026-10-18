import { z } from 'zod';
import { roleSchema } from './roles.ts';

// Request and response contracts for /api/v1/auth. The web app validates forms with the
// same schemas the API enforces (docs/architecture/auth-and-sessions.md §2).

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound keeps Argon2 hashing cost predictable for hostile inputs. */
export const PASSWORD_MAX_LENGTH = 128;

/** Trimmed and lower-cased so lookups and the unique index see one canonical form. */
export const emailSchema = z
  .string({ error: 'Enter your email address' })
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address')
  .max(254, 'Email addresses can be at most 254 characters')
  .pipe(z.email({ error: 'Enter a valid email address' }));

export const passwordSchema = z
  .string({ error: 'Enter a password' })
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

const personNameSchema = z
  .string({ error: 'Enter your name' })
  .trim()
  .min(1, 'Enter your name')
  .max(100, 'Names can be at most 100 characters');

export const organizationNameSchema = z
  .string({ error: 'Enter an organization name' })
  .trim()
  .min(2, 'Use at least 2 characters')
  .max(100, 'Organization names can be at most 100 characters');

export const registerRequestSchema = z
  .object({
    name: personNameSchema,
    email: emailSchema,
    password: passwordSchema,
    organizationName: organizationNameSchema,
  })
  .refine((value) => value.password.trim().toLowerCase() !== value.email, {
    path: ['password'],
    message: 'Your password can’t be your email address',
  });
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Only bounded here: login must not reveal the password policy of an existing account.
  password: z
    .string({ error: 'Enter your password' })
    .min(1, 'Enter your password')
    .max(PASSWORD_MAX_LENGTH, 'Incorrect email or password'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const switchOrganizationRequestSchema = z.object({
  organizationId: z.uuid({ error: 'Choose an organization' }),
});
export type SwitchOrganizationRequest = z.infer<typeof switchOrganizationRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** An organization the signed-in user belongs to, with their role in it. */
export const organizationMembershipSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  role: roleSchema,
});
export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>;

/**
 * Body of `GET /api/v1/auth/session` and of successful register / login / switch responses.
 * `activeOrganization` is null when the user no longer belongs to the organization their
 * session points at (e.g. they were removed); they must choose another one.
 */
export const authSessionSchema = z.object({
  user: sessionUserSchema,
  activeOrganization: organizationMembershipSchema.nullable(),
  organizations: z.array(organizationMembershipSchema),
});
export type AuthSession = z.infer<typeof authSessionSchema>;
