export { getRedis, getBullConnections, closeRedis } from "./client.js";
export { CircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker.js";
export { RedisHealthMonitor, DegradationManager } from "./degradation.js";
export type { GateName, GateMode, HealthState, HealthSample, GateSnapshot, MonitorOptions } from "./degradation.js";
