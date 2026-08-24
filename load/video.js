import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const latency = new Trend("latency");

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 20 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    errors: ["rate<0.001"],
    latency: ["p(99)<150"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.ACCESS_TOKEN;
const VIDEO_ID = __ENV.VIDEO_ID;

export default function () {
  if (!VIDEO_ID) { sleep(1); return; }
  const res = http.get(BASE + "/api/v1/videos/" + VIDEO_ID + "/master.m3u8", {
    headers: { cookie: "access_token=" + TOKEN },
    redirects: 0,
  });
  check(res, { "307": (r) => r.status === 307 });
  errorRate.add(res.status !== 307);
  latency.add(res.timings.duration);
  sleep(0.5);
}
