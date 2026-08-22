import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { z } from "zod";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../shared/folders";
import { stripHtmlToText, textToHtml } from "../workers/lib/email-helpers";
import { getMailbox, MailboxStore } from "./db";

const DEFAULT_SYSTEM_PROMPT = `You are an email assistant. You can read and organize this mailbox and create drafts, but never send email.
Before drafting a reply, read the complete thread. Draft bodies must contain only the email text, with no commentary or markdown. Keep replies short, natural, and direct.`;

function defineTool(description: string, inputSchema: z.ZodTypeAny, execute: (input: any) => Promise<unknown>) {
	return { description, inputSchema, execute };
}

function tools(store: MailboxStore, mailboxId: string) {
	return {
		list_emails: defineTool("List emails in a folder.", z.object({
			folder: z.string().default(Folders.INBOX).describe(FOLDER_TOOL_DESCRIPTION),
			limit: z.number().default(20), page: z.number().default(1),
		}), async ({ folder, limit, page }) => store.getEmails({ folder, limit, page })),
		get_email: defineTool("Read one complete email.", z.object({ emailId: z.string() }), async ({ emailId }) => {
			const email = await store.getEmail(emailId);
			return email ? { ...email, body_text: stripHtmlToText(email.body ?? "") } : { error: "Email not found" };
		}),
		get_thread: defineTool("Read a complete email thread in chronological order.", z.object({ threadId: z.string() }), async ({ threadId }) => {
			const messages = await store.getThreadEmails(threadId);
			return messages.map((email) => ({ ...email, body_text: stripHtmlToText(email.body ?? "") }));
		}),
		search_emails: defineTool("Search email subject, body, sender, and recipient.", z.object({
			query: z.string(), folder: z.string().optional(),
		}), async ({ query, folder }) => store.searchEmails({ query, folder, limit: 20 })),
		draft_email: defineTool("Create a new draft; never sends it.", z.object({
			to: z.string().email(), subject: z.string(), body: z.string(),
		}), async ({ to, subject, body }) => {
			const id = crypto.randomUUID();
			await store.createEmail(Folders.DRAFT, {
				id, subject, sender: mailboxId, recipient: to.toLowerCase(), date: new Date().toISOString(),
				body: textToHtml(body), thread_id: id,
			}, []);
			return { status: "draft_created", id, to, subject, body };
		}),
		draft_reply: defineTool("Create a reply draft after reading the thread; never sends it.", z.object({
			originalEmailId: z.string(), to: z.string().email(), subject: z.string(), body: z.string(),
		}), async ({ originalEmailId, to, subject, body }) => {
			const original = await store.getEmail(originalEmailId);
			if (!original) return { error: "Original email not found" };
			const id = crypto.randomUUID();
			await store.createEmail(Folders.DRAFT, {
				id, subject, sender: mailboxId, recipient: to.toLowerCase(), date: new Date().toISOString(),
				body: textToHtml(body), in_reply_to: original.id, thread_id: original.thread_id || original.id,
			}, []);
			return { status: "draft_created", id, to, subject, body };
		}),
		mark_email_read: defineTool("Mark an email read or unread.", z.object({
			emailId: z.string(), read: z.boolean(),
		}), async ({ emailId, read }) => store.updateEmail(emailId, { read })),
		move_email: defineTool("Move an email to another folder.", z.object({
			emailId: z.string(), folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
		}), async ({ emailId, folderId }) => ({ moved: await store.moveEmail(emailId, folderId) })),
		discard_draft: defineTool("Delete a draft.", z.object({ draftId: z.string() }), async ({ draftId }) => ({
			deleted: (await store.deleteEmail(draftId)) !== null,
		})),
	};
}

export async function chat(mailboxId: string, request: Request) {
	if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });
	const { messages } = await request.json() as { messages: unknown[] };
	const mailbox = await getMailbox(mailboxId);
	if (!mailbox) return Response.json({ error: "Mailbox not found" }, { status: 404 });
	const provider = createOpenAI({
		apiKey: process.env.OPENAI_API_KEY,
		baseURL: process.env.OPENAI_BASE_URL || undefined,
	});
	const result = streamText({
		model: provider(process.env.OPENAI_MODEL ?? "gpt-5-mini"),
		system: typeof mailbox.settings?.agentSystemPrompt === "string" && mailbox.settings.agentSystemPrompt.trim()
			? mailbox.settings.agentSystemPrompt
			: DEFAULT_SYSTEM_PROMPT,
		messages: await convertToModelMessages(messages as any),
		tools: tools(new MailboxStore(mailboxId), mailboxId),
		stopWhen: stepCountIs(5),
	});
	return result.toUIMessageStreamResponse();
}
