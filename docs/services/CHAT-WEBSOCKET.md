# Live Chat — WebSocket Gateway

Real-time chat over `/api/v1/chat/ws` (`@fastify/websocket`), backed by
MongoDB for storage and Redis for pub/sub fan-out + presence. HTTP API under
`/api/v1/chat/*`.

## Connect & authenticate

`ws://host/api/v1/chat/ws` — authenticate one of two ways:

1. **Cookie**: send the `access_token` cookie (valid JWT).
2. **Ticket**: `POST /api/v1/chat/ticket` (auth required) → short-lived
   (120 s) `ws-ticket` JWT; connect with `?ticket=<ticket>`.

On success the server sends:

```json
{ "type": "welcome", "userId": "…" }
```

Unauthenticated connections are closed with code `4001`.

## Client → server messages

| `type`    | Payload                | Server behavior                                                                               |
| --------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `join`    | `{ roomId }`           | verify room + membership → `joined` (socket added to room fan-out)                            |
| `leave`   | `{ roomId }`           | → `left`                                                                                      |
| `message` | `{ roomId, body }`     | validate (non-empty, ≤ 2000 chars), rate-limit (30/min), persist, → `ack` + fan-out `message` |
| `typing`  | `{ roomId, isTyping }` | fan-out typing indicator                                                                      |
| `ping`    | —                      | → `pong` (heartbeat)                                                                          |

Any other `type` → `{ type: "error", code: "UNKNOWN_EVENT" }` (connection
stays open).

## Server → client messages

| Type              | Payload                                                                   | Meaning                      |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `welcome`         | `{ userId }`                                                              | auth OK                      |
| `joined` / `left` | `{ roomId }`                                                              | membership events            |
| `ack`             | `{ messageId, seq }`                                                      | message persisted (own send) |
| `message`         | `{ message: { id, roomId, senderId, senderName, body, seq, createdAt } }` | delivered to other members   |
| `typing`          | `{ roomId, userId, isTyping }`                                            | typing indicator             |
| `pong`            | —                                                                         | ping reply                   |
| `error`           | `{ code, message }`                                                       | protocol/validation errors   |

## Error codes

| Code                | When                                        |
| ------------------- | ------------------------------------------- |
| `BAD_JSON`          | frame is not valid JSON                     |
| `EMPTY_MESSAGE`     | empty/whitespace body                       |
| `MESSAGE_TOO_LONG`  | body > 2000 chars                           |
| `UNKNOWN_EVENT`     | unrecognized `type`                         |
| `JOIN_FAILED`       | room missing or user is not a member        |
| `SEND_FAILED`       | send failed (membership, persistence, etc.) |
| `TOO_MANY_REQUESTS` | send rate limit exceeded (30/min/user)      |

## Rooms & membership

| Type     | Created by   | Identity                                                                                                       |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `course` | mentor/admin | one room per `courseId` (dedupe — repeated creates return the same room); members: creator + enrolled students |
| `mentor` | anyone       | deterministic `1:1:<sorted ids>` room id; members: both participants                                           |
| `group`  | anyone       | member list (deduped), creator included                                                                        |

- `assertMember`: explicit member, or course room → enrolled student
  (checked via `coursesService.isEnrolled`) / mentor / admin.
- Outsiders get `403 NOT_ROOM_MEMBER` from the HTTP API and
  `JOIN_FAILED`/error frames from WS.
- HTTP surface: `GET /chat/rooms` (my rooms + unread counts),
  `POST /chat/rooms`, `POST /chat/rooms/:id/join`,
  `GET /chat/rooms/:id/messages?before=&limit=`, `POST /chat/rooms/:id/read`.

## Message persistence & history

- `persistMessage`: per-room atomic sequence (`nextRoomSeq`, Mongo
  counter), body truncated to 2000 chars, room `lastMessageAt` updated,
  unread counters incremented for all members except the sender.
- History: seq-descending with `before=<seq>` cursor (exclusive),
  `limit` capped at 100, returned ascending.
- `markRead` zeroes the caller's unread counter; room list shows
  `unreadCount`.

## Presence & fan-out

- Presence: `chat:presence:<userId}` in Redis, TTL 90 s, refreshed by a
  30 s heartbeat while connected; cleared on close.
- Fan-out: local sockets delivered directly; cross-instance via Redis
  pub/sub (`chat:room:<id>`). When the presence gate degrades, delivery is
  local-only — never a crash.

## Send rate limiting

Redis `INCR + PEXPIRE` (60 s window), 30 messages/min/user, in-memory
fallback when Redis is down. Exceeded → `TOO_MANY_REQUESTS` error frame
(the message is NOT persisted).

## MongoDB layout

DB `ayosnbt_chat`; collections `rooms`, `messages`, counters.
Indexes ensured at boot; unreachable Mongo degrades the module (boot never
fails). See [DATABASE.md](../architecture/DATABASE.md).
