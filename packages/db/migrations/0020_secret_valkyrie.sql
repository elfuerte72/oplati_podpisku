CREATE INDEX "attachments_order_id_idx" ON "attachments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "attachments_message_id_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_staff_id_idx" ON "messages" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "orders_conversation_id_idx" ON "orders" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "orders_service_id_idx" ON "orders" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "orders_supervisor_id_idx" ON "orders" USING btree ("supervisor_id");--> statement-breakpoint
CREATE INDEX "orders_card_id_idx" ON "orders" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "referral_accruals_source_user_id_idx" ON "referral_accruals" USING btree ("source_user_id");