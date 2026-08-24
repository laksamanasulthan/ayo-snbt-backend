import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const latency = new Trend("latency");

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 30 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    errors: ["rate<0.01"],
    latency: ["p(99)<250"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.ACCESS_TOKEN;
const SIM_PKG_ID = __ENV.SIM_PACKAGE_ID;

export default function () {
  if (!SIM_PKG_ID) { sleep(1); return; }
  const res = http.get(BASE + "/api/v1/simulations/packages", { headers: { cookie: "access_token=" + TOKEN } });
  check(res, { "200": (r) => r.status === 200 });
  errorRate.add(res.status !== 200);
  latency.add(res.timings.duration);
  sleep(0.3);
}
