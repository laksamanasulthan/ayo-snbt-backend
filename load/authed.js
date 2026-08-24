import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const latency = new Trend("latency");

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "1m", target: 50 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    errors: ["rate<0.001"],
    latency: ["p(99)<200"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.ACCESS_TOKEN;

const HEADERS = { cookie: "access_token=" + TOKEN + "; csrf_token=k6", "x-csrf-token": "k6" };

export default function () {
  const res = http.get(BASE + "/api/v1/users/me", { headers: { cookie: "access_token=" + TOKEN } });
  check(res, { "200": (r) => r.status === 200 });
  errorRate.add(res.status !== 200);
  latency.add(res.timings.duration);
  sleep(0.5);
}
