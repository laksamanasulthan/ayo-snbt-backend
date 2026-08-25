CREATE TABLE "question_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_upvotes" (
	"reply_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "reply_upvotes_reply_id_user_id_pk" PRIMARY KEY("reply_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "question_replies" ADD CONSTRAINT "question_replies_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_replies" ADD CONSTRAINT "question_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_upvotes" ADD CONSTRAINT "reply_upvotes_reply_id_question_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."question_replies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_upvotes" ADD CONSTRAINT "reply_upvotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_reply_thread_idx" ON "question_replies" USING btree ("question_id","created_at");