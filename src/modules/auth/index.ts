export { authModule } from "./routes.js";
export { authService, getUserClaims, issueAccessToken, createRefreshToken, revokeRefreshToken, revokeFamily } from "./service.js";
export type { AuthResult } from "./service.js";
export { renderEmailJob } from "./jobs.js";
export type { EmailJobPayload } from "./jobs.js";
