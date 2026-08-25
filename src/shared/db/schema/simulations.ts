import { pgTable, uuid, text, varchar, timestamp, jsonb, integer, boolean, doublePrecision, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { questions } from "./questions.js";
import { questionOptions } from "./questions.js";

export const simulationPackages = pgTable("simulation_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull().default(120),
  questionCounts: jsonb("question_counts").notNull().default({}),
  scoring: jsonb("scoring").notNull().default({ correct: 4, blank: 0, wrong: 0 }),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  // M3: warn the student when remaining time drops below this (ms). Null = no warning.
  warnAtRemainingMs: integer("warn_at_remaining_ms"),
  // M4: attempt policy. maxAttempts null = unlimited; retakeCooldownMinutes null = no cooldown.
  maxAttempts: integer("max_attempts"),
  retakeCooldownMinutes: integer("retake_cooldown_minutes"),
  // A1: scheduled tryout window. Null = always available.
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const simulationSessions = pgTable("simulation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Nullable for practice sessions (untimed drills without a package)
  packageId: uuid("package_id").references(() => simulationPackages.id, { onDelete: "cascade" }),
  // "simulation" (timed tryout) | "practice" (untimed drill, planned M2)
  type: varchar("type", { length: 20 }).notNull().default("simulation"),
  status: varchar("status", { length: 20 }).notNull().default("in_progress"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  score: integer("score"),
  maxScore: integer("max_score"),
  correctCount: integer("correct_count").notNull().default(0),
  wrongCount: integer("wrong_count").notNull().default(0),
  blankCount: integer("blank_count").notNull().default(0),
  percentile: doublePrecision("percentile"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  sessionUserIdx: index("sim_session_user_idx").on(table.userId, table.status),
  sessionPackageIdx: index("sim_session_pkg_idx").on(table.packageId, table.status, table.score)
}));

export const simulationAnswers = pgTable("simulation_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => simulationSessions.id, { onDelete: "cascade" }),
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  selectedOptionId: uuid("selected_option_id").references(() => questionOptions.id, { onDelete: "set null" }),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  isCorrect: boolean("is_correct"),
  // Exam UX (M3): flag for review + server-side time accounting per question
  isFlagged: boolean("is_flagged").notNull().default(false),
  timeSpentMs: integer("time_spent_ms").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0)
}, (table) => ({
  answerUnique: uniqueIndex("sim_answer_session_q_idx").on(table.sessionId, table.questionId)
}));
