/**
 * RBAC registry — single source of truth for permissions and default roles.
 * Enforced via requirePermission preHandler (reads JWT claims, zero DB hit).
 */
export const Permissions = {
  USER_READ: "user:read",
  USER_UPDATE: "user:update",
  USER_MANAGE: "user:manage",

  COURSE_CREATE: "course:create",
  COURSE_UPDATE: "course:update",
  COURSE_PUBLISH: "course:publish",
  COURSE_DELETE: "course:delete",

  QUESTION_MANAGE: "question:manage",
  SIMULATION_MANAGE: "simulation:manage",

  VIDEO_UPLOAD: "video:upload",
  VIDEO_TRANSCODE: "video:transcode",

  PAYMENT_READ: "payment:read",
  PAYMENT_REFUND: "payment:refund",

  CHAT_MODERATE: "chat:moderate",
  IAM_MANAGE: "iam:manage",
  ANALYTICS_READ: "analytics:read"
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

export const RoleName = {
  STUDENT: "student",
  MENTOR: "mentor",
  ADMIN: "admin"
} as const;

export type RoleName = (typeof RoleName)[keyof typeof RoleName];

/** Default permission sets per role (seeded into Postgres at bootstrap). */
export const ROLE_SEED: Record<RoleName, Permission[]> = {
  [RoleName.STUDENT]: [
    Permissions.USER_READ,
    Permissions.USER_UPDATE,
    Permissions.VIDEO_UPLOAD,
    Permissions.PAYMENT_READ
  ],
  [RoleName.MENTOR]: [
    Permissions.USER_READ,
    Permissions.USER_UPDATE,
    Permissions.COURSE_CREATE,
    Permissions.COURSE_UPDATE,
    Permissions.COURSE_PUBLISH,
    Permissions.QUESTION_MANAGE,
    Permissions.SIMULATION_MANAGE,
    Permissions.VIDEO_UPLOAD,
    Permissions.VIDEO_TRANSCODE,
    Permissions.PAYMENT_READ
  ],
  [RoleName.ADMIN]: Object.values(Permissions)
};

/** Does the claim set include this permission (via any role)? */
export function hasPermission(permissions: string[] | undefined, required: Permission): boolean {
  return permissions?.includes(required) ?? false;
}
