ALTER TABLE "simulation_answers" ADD COLUMN "is_flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "simulation_answers" ADD COLUMN "time_spent_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "simulation_packages" ADD COLUMN "warn_at_remaining_ms" integer;