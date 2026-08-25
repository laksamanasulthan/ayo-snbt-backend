# Engineering Investigations

Documents for non-feature investigations that inform architecture decisions.

---

## I1 — MongoDB high-CPU investigation

### Status

- **Date:** 2026-08-25
- **Investigator:** (code review)
- **Measurement phase:** ⏳ pending (needs production traffic)

### Scope

MongoDB is used exclusively for the **chat module** (`src/modules/chat/`):
two collections (`chat_rooms`, `chat_messages`), accessed through a single
shared client (`getChatDb`, `serverSelectionTimeoutMS: 2000`). The CPU
spikes to >90% under real usage.

### Code-level architecture (verified)

**Connection:** one `MongoClient` singleton, created on first use. On error,
`discardMongoClient()` nulls the singleton — next call creates a new client.
No connection pool tuning (default maxPoolSize = 100). No replica set.

**Indexes (ensured at boot by `ensureChatIndexes`):**

- `chat_messages`: `{roomId: 1, seq: -1}` (history query) ✓
- `chat_messages`: `{roomId: 1, seq: 1}` (unique) ✓
- `chat_rooms`: `{courseId: 1}` unique partial (course dedup) ✓
- `chat_rooms`: `{memberIds: 1}` (my rooms query) ✓
- `chat_rooms`: `{lastMessageAt: -1}` (sort) ✓

**Missing indexes:** none for the hot queries — all covered.

**Per-message write pattern (`persistMessage`):**

1. `findOneAndUpdate({_id: roomId}, {$inc: {lastSeq: 1}})` — seq counter
2. `insertOne(message)` — message doc
3. `updateOne({_id: roomId}, {$set: {lastMessageAt}, $inc: {unreadCounts.*}})`
   — per-member unread increment

**Read patterns:**

- `history`: `{roomId, seq < before}` → sort seq desc, limit — covered by `{roomId, seq}` index
- `listMyRooms`: `{memberIds: userId}` → multikey index covers
- `markRead`: `updateOne({_id: roomId}, {$set: {unreadCounts.<userId>: 0}})`

### Ranked hypotheses

| Rank | Hypothesis                                                                                                                                                         | Evidence                                                                                        | Fix candidate                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| H1   | **Unbounded message growth** — no TTL index on `createdAt`; once the working set exceeds RAM, WiredTiger pages to disk                                             | Messages collection has no TTL, no archival, no cap. Dev Docker typically has 256 MB RAM limit. | Add TTL index on `createdAt` (90 days) + archival job for older messages          |
| H2   | **Unread-count write amplification** — room doc updates with `$inc unreadCounts.<member>` for EVERY member; a room with 100 members = 100 field writes per message | Room doc grows with member count; large rooms (course rooms) can have hundreds of members.      | Move unread to a separate `room_members` collection or compute on read            |
| H3   | **Per-message seq contention** — every message serializes on the room document's `$inc lastSeq`; high-volume rooms bottleneck on one doc                           | Same room doc is updated per message for `lastSeq` AND `lastMessageAt` AND `unreadCounts`.      | Decouple seq into a dedicated counters collection; reduce writes to room document |
| H4   | **Connection churn** — `discardMongoClient` + process restarts (dev watcher) create clients repeatedly                                                             | Dev watcher restarts the process on every file save → new MongoClient per restart.              | Mitigated in dev; would not affect prod; still check `currentOp` connections      |
| H5   | **Config/deployment** — standalone (no replica set for read scaling), WiredTiger cache default 50% of RAM minus 1 GB, possibly spinning disk on host               | `serverStatus.wiredTiger.cache` + `globalLock` will show                                        | Tune WiredTiger cache size; add replica set for read scaling if needed            |
| H6   | **Missing index on history query** — theory disproven by code review (index exists)                                                                                | —                                                                                               | N/A                                                                               |

### Measurement plan (executed against production/staging)

```bash
# 1. Collection sizes
mongosh --eval 'db.chat_messages.stats()' --eval 'db.chat_rooms.stats()'

# 2. Room-size distribution (how many rooms have > 10 / 50 / 100 members?)
mongosh --eval 'db.chat_rooms.aggregate([{$project:{memberCount:{$size:"$memberIds"}}},{$group:{_id:null,avg:{$avg:"$memberCount"},max:{$max:"$memberCount"},buckets:{$push:{$switch:{branches:[{case:{$gte:["$memberCount",100]},then:"100+"},{case:{$gte:["$memberCount",50]},then:"50-99"},{else:"<50"}]}}}}})])'

# 3. Message rate per hour
mongosh --eval 'db.chat_messages.aggregate([{$group:{_id:{$dateTrunc:{date:"$createdAt",unit:"hour"}},count:{$sum:1}}},{$sort:{_id:-1}},{$limit:48}])'

# 4. Hot queries — enable profiling for 1 hour
mongosh --eval 'db.setProfilingLevel(1, {slowms: 100})'
# After 1 hour: db.system.profile.find().sort({ts:-1}).limit(20).pretty()

# 5. Page faults + WiredTiger cache
mongosh --eval 'db.serverStatus().wiredTiger.cache'
mongosh --eval 'db.serverStatus().extra_info.page_faults'

# 6. top operations
mongotop 5  # run for 60 seconds during a traffic window
```

### Decision record

After the measurement phase, the team will decide between:

1. **Keep Mongo + apply fixes** (TTL, unread re-design, counter collection,
   WiredTiger tuning) — lower risk, chat data volume is small.
2. **Migrate chat to Postgres** — eliminate the Mongo dependency entirely;
   chat data model (rooms, messages, seq) fits relational storage well;
   the app already has a Postgres pool. Requires migration of the three
   collections + replay of any un-processed messages during cutover.

**Recommendation:** start with the cheap fixes (TTL, unread move off the room
doc) — they address the most likely root cause (H1/H2) and cost < 2 person-days.
Re-measure after each. Only if CPU remains high, evaluate the full migration.

### Fixed

- **TTL index ✅** — the chat_messages collection now carries a TTL index
  on createdAt with expireAfterSeconds = CHAT_RETENTION_DAYS x 86400
  (default **90 days**, env-overridable). Created idempotently at chat
  module boot (ensureChatIndexes); the Mongo monitor purges old
  documents in the background. Verified by an integration test asserting
  the index spec.
- Unread-count re-design, counter collection, WiredTiger tuning: after
  measurement confirms the hypothesis (see the measurement plan above).
