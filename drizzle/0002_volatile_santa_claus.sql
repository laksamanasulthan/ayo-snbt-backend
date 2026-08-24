DROP INDEX "rt_user_id_idx";--> statement-breakpoint
CREATE INDEX "rt_user_id_idx" ON "refresh_tokens" USING btree ("user_id","family_id");