ALTER TABLE "questions" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "review_status" varchar(20) DEFAULT 'draft' NOT NULL;