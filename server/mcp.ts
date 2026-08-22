import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../shared/folders";
import { buildReferencesChain, buildThreadingHeaders, generateMessageId, stripHtmlToText } from "../workers/lib/email-helpers";
import type { EmailFull } from "../workers/lib/schemas";
import { getMailbox, listMailboxes, MailboxStore } from "./db";
import { sendEmail } from "./gateway";

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function error(message: string) {
	return { ...result({ error: message }), isError: true as const };
}

async function store(mailboxId: string) {
	return await getMailbox(mailboxId) ? new MailboxStore(mailboxId.toLowerCase()) : null;
}

async function deliver(mailboxId: string, to: string, subject: string, bodyHtml: string, original?: EmailFull) {
	const mailbox = await store(mailboxId);
	if (!mailbox) return { error: `Mailbox "${mailboxId}" not found` };
	const limited = await mailbox.checkSendRateLimit();
	if (limited) return { error: limited };
	const domain = mailboxId.split("@")[1];
	if (!domain) return { error: "Invalid mailbox address" };
	const { messageId, outgoingMessageId } = generateMessageId(domain);
	const threading = original ? buildReferencesChain(original) : null;
	await mailbox.createEmail(Folders.SENT, {
		id: messageId, sender: mailboxId.toLowerCase(), recipient: to.toLowerCase(), subject, body: bodyHtml,
		date: new Date().toISOString(), in_reply_to: threading?.originalMsgId,
		email_references: threading ? JSON.stringify(threading.references) : null,
		thread_id: threading?.threadId ?? messageId, message_id: outgoingMessageId,
	}, []);
	await sendEmail({
		to, from: mailboxId, subject, html: bodyHtml,
		...(threading ? { headers: buildThreadingHeaders(threading.originalMsgId, threading.references) } : {}),
	});
	return { status: "sent", id: messageId };
}

function createServer() {
	const server = new McpServer({ name: "agentic-inbox", version: "2.0.0" });

	server.tool("list_mailboxes", "List all available mailboxes", {}, async () => result(await listMailboxes()));
	server.tool("list_emails", "List emails in a mailbox folder", {
		mailboxId: z.string(), folder: z.string().default(Folders.INBOX).describe(FOLDER_TOOL_DESCRIPTION),
		limit: z.number().default(20), page: z.number().default(1),
	}, async ({ mailboxId, folder, limit, page }) => {
		const mailbox = await store(mailboxId);
		return mailbox ? result(await mailbox.getEmails({ folder, limit, page })) : error(`Mailbox "${mailboxId}" not found`);
	});
	server.tool("get_email", "Read one complete email", {
		mailboxId: z.string(), emailId: z.string(),
	}, async ({ mailboxId, emailId }) => {
		const mailbox = await store(mailboxId);
		if (!mailbox) return error(`Mailbox "${mailboxId}" not found`);
		const email = await mailbox.getEmail(emailId);
		return email ? result({ ...email, body_text: stripHtmlToText(email.body ?? "") }) : error("Email not found");
	});
	server.tool("get_thread", "Read a complete email thread", {
		mailboxId: z.string(), threadId: z.string(),
	}, async ({ mailboxId, threadId }) => {
		const mailbox = await store(mailboxId);
		return mailbox ? result(await mailbox.getThreadEmails(threadId)) : error(`Mailbox "${mailboxId}" not found`);
	});
	server.tool("search_emails", "Search emails", {
		mailboxId: z.string(), query: z.string(), folder: z.string().optional(),
	}, async ({ mailboxId, query, folder }) => {
		const mailbox = await store(mailboxId);
		return mailbox ? result(await mailbox.searchEmails({ query, folder, limit: 50 })) : error(`Mailbox "${mailboxId}" not found`);
	});
	server.tool("create_draft", "Create a new draft email", {
		mailboxId: z.string(), to: z.string().optional(), subject: z.string(), bodyHtml: z.string(),
		in_reply_to: z.string().optional(), thread_id: z.string().optional(),
	}, async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
		const mailbox = await store(mailboxId);
		if (!mailbox) return error(`Mailbox "${mailboxId}" not found`);
		const id = crypto.randomUUID();
		await mailbox.createEmail(Folders.DRAFT, {
			id, sender: mailboxId.toLowerCase(), recipient: to?.toLowerCase() ?? "", subject, body: bodyHtml,
			date: new Date().toISOString(), in_reply_to, thread_id: thread_id || in_reply_to || id,
		}, []);
		return result({ status: "draft_created", draftId: id });
	});
	server.tool("delete_email", "Permanently delete an email", {
		mailboxId: z.string(), emailId: z.string(),
	}, async ({ mailboxId, emailId }) => {
		const mailbox = await store(mailboxId);
		return mailbox ? result({ deleted: (await mailbox.deleteEmail(emailId)) !== null }) : error(`Mailbox "${mailboxId}" not found`);
	});
	server.tool("mark_email_read", "Mark an email read or unread", {
		mailboxId: z.string(), emailId: z.string(), read: z.boolean(),
	}, async ({ mailboxId, emailId, read }) => {
		const mailbox = await store(mailboxId);
		return mailbox ? result(await mailbox.updateEmail(emailId, { read })) : error(`Mailbox "${mailboxId}" not found`);
	});
	server.tool("move_email", "Move an email to another folder", {
		mailboxId: z.string(), emailId: z.string(), folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
	}, async ({ mailboxId, emailId, folderId }) => {
		const mailbox = await store(mailboxId);
		return mailbox ? result({ moved: await mailbox.moveEmail(emailId, folderId) }) : error(`Mailbox "${mailboxId}" not found`);
	});
	server.tool("send_email", "Send a new email after user confirmation", {
		mailboxId: z.string(), to: z.string().email(), subject: z.string(), bodyHtml: z.string(),
	}, async ({ mailboxId, to, subject, bodyHtml }) => {
		const sent = await deliver(mailboxId, to, subject, bodyHtml);
		return "error" in sent ? error(sent.error) : result(sent);
	});
	server.tool("send_reply", "Send a reply after user confirmation", {
		mailboxId: z.string(), originalEmailId: z.string(), to: z.string().email(), subject: z.string(), bodyHtml: z.string(),
	}, async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
		const mailbox = await store(mailboxId);
		if (!mailbox) return error(`Mailbox "${mailboxId}" not found`);
		const original = await mailbox.getEmail(originalEmailId) as EmailFull | null;
		if (!original) return error("Original email not found");
		const sent = await deliver(mailboxId, to, subject, bodyHtml, original);
		return "error" in sent ? error(sent.error) : result(sent);
	});

	return server;
}

export async function handleMcp(request: Request) {
	const server = createServer();
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	return transport.handleRequest(request);
}
