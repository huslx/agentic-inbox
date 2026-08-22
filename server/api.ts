import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { Folders } from "../shared/folders";
import { SendEmailRequestSchema, type EmailFull } from "../workers/lib/schemas";
import {
	buildReferencesChain,
	buildThreadingHeaders,
	generateMessageId,
	SenderValidationError,
	validateSender,
} from "../workers/lib/email-helpers";
import {
	createMailbox,
	deleteMailbox,
	getMailbox,
	listMailboxes,
	MailboxStore,
	updateMailbox,
} from "./db";
import { sendEmail } from "./gateway";
import { deleteAttachment, readAttachment, storeAttachments } from "./storage";
import { chat } from "./chat";

type Variables = { store: MailboxStore; mailboxId: string };
type ApiContext = Context<{ Variables: Variables }>;

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(),
});

const DraftBody = z.object({
	to: z.string().optional(), cc: z.string().optional(), bcc: z.string().optional(),
	subject: z.string().optional(), body: z.string(), in_reply_to: z.string().optional(),
	thread_id: z.string().optional(), draft_id: z.string().optional(),
});

const requireMailbox = createMiddleware<{ Variables: Variables }>(async (c, next) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId") ?? "").toLowerCase();
	if (!mailboxId) return c.json({ error: "Mailbox ID required" }, 400);
	if (!(await getMailbox(mailboxId))) return c.json({ error: "Not found" }, 404);
	c.set("mailboxId", mailboxId);
	c.set("store", new MailboxStore(mailboxId));
	await next();
});

function intQuery(c: ApiContext, key: string) {
	const value = c.req.query(key);
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function boolQuery(c: ApiContext, key: string) {
	const value = c.req.query(key);
	return value === undefined || value === "" ? undefined : value === "true" || value === "1";
}

function slugify(value: string) {
	return value.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]+/g, "").replace(/--+/g, "-").replace(/^-|-$/g, "");
}

export const api = new Hono<{ Variables: Variables }>();
api.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

api.get("/api/v1/config", (c) => c.json({
	domains: (process.env.DOMAINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
	emailAddresses: (process.env.EMAIL_ADDRESSES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
}));

api.get("/api/v1/mailboxes", async (c) => c.json(await listMailboxes()));

api.post("/api/v1/mailboxes", async (c) => {
	const body = CreateMailboxBody.parse(await c.req.json());
	const allowed = (process.env.EMAIL_ADDRESSES ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
	if (allowed.length && !allowed.includes(body.email.toLowerCase())) return c.json({ error: "Mailbox creation is restricted" }, 403);
	try {
		return c.json(await createMailbox(body.email, body.name, body.settings), 201);
	} catch (error: any) {
		if (error?.code === "23505") return c.json({ error: "Mailbox already exists" }, 409);
		throw error;
	}
});

api.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailbox = await getMailbox(c.var.mailboxId);
	return c.json({ id: mailbox.id, email: mailbox.id, name: mailbox.id, settings: mailbox.settings });
});

api.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const { settings } = await c.req.json<{ settings: Record<string, unknown> }>();
	const mailbox = await updateMailbox(c.var.mailboxId, settings);
	return mailbox ? c.json(mailbox) : c.json({ error: "Not found" }, 404);
});

api.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	await deleteMailbox(c.var.mailboxId);
	return c.body(null, 204);
});

api.get("/api/v1/mailboxes/:mailboxId/emails", async (c: ApiContext) => {
	const folder = c.req.query("folder");
	const options = {
		folder,
		thread_id: c.req.query("thread_id"),
		page: intQuery(c, "page"),
		limit: intQuery(c, "limit"),
		sortColumn: c.req.query("sortColumn"),
		sortDirection: c.req.query("sortDirection") as "ASC" | "DESC" | undefined,
	};
	if (boolQuery(c, "threaded") && folder) {
		return c.json({
			emails: await c.var.store.getThreadedEmails(options),
			totalCount: await c.var.store.countThreadedEmails(folder),
		});
	}
	const emails = await c.var.store.getEmails(options);
	return folder
		? c.json({ emails, totalCount: await c.var.store.countEmails(options) })
		: c.json(emails);
});

api.post("/api/v1/mailboxes/:mailboxId/chat", (c: ApiContext) => chat(c.var.mailboxId, c.req.raw));

async function deliver(c: ApiContext, original?: EmailFull, forwarding = false) {
	const body = SendEmailRequestSchema.parse(await c.req.json());
	let sender;
	try {
		sender = validateSender(body.to, body.from, c.var.mailboxId);
	} catch (error) {
		if (error instanceof SenderValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
	const rateLimit = await c.var.store.checkSendRateLimit();
	if (rateLimit) return c.json({ error: rateLimit }, 429);
	const { messageId, outgoingMessageId } = generateMessageId(sender.fromDomain);
	const attachmentData = await storeAttachments(messageId, body.attachments);
	const threading = original && !forwarding ? buildReferencesChain(original) : null;
	await c.var.store.createEmail(Folders.SENT, {
		id: messageId,
		subject: body.subject,
		sender: sender.fromEmail,
		recipient: sender.toStr,
		cc: body.cc ? (Array.isArray(body.cc) ? body.cc.join(", ") : body.cc).toLowerCase() : null,
		bcc: body.bcc ? (Array.isArray(body.bcc) ? body.bcc.join(", ") : body.bcc).toLowerCase() : null,
		date: new Date().toISOString(),
		body: body.html || body.text || "",
		in_reply_to: threading?.originalMsgId ?? body.in_reply_to ?? null,
		email_references: threading ? JSON.stringify(threading.references) : body.references ? JSON.stringify(body.references) : null,
		thread_id: threading?.threadId ?? body.thread_id ?? messageId,
		message_id: outgoingMessageId,
	}, attachmentData);
	await sendEmail({
		...body,
		...(threading ? { headers: buildThreadingHeaders(threading.originalMsgId, threading.references) } : {}),
	});
	if (threading) await c.var.store.markThreadRead(threading.threadId);
	return c.json({ id: messageId, status: "sent" }, 202);
}

api.post("/api/v1/mailboxes/:mailboxId/emails", (c: ApiContext) => deliver(c));

api.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: ApiContext) => {
	const body = DraftBody.parse(await c.req.json());
	if (body.draft_id) await c.var.store.deleteEmail(body.draft_id);
	const id = crypto.randomUUID();
	const date = new Date().toISOString();
	await c.var.store.createEmail(Folders.DRAFT, {
		id, subject: body.subject ?? "", sender: c.var.mailboxId,
		recipient: (body.to ?? "").toLowerCase(), cc: body.cc?.toLowerCase(), bcc: body.bcc?.toLowerCase(),
		date, body: body.body, in_reply_to: body.in_reply_to, thread_id: body.thread_id || body.in_reply_to || id,
	}, []);
	return c.json({ id, draft_id: id, status: "draft", subject: body.subject ?? "", recipient: body.to ?? "", date }, 201);
});

api.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: ApiContext) => {
	const email = await c.var.store.getEmail(c.req.param("id"));
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

api.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: ApiContext) => {
	const email = await c.var.store.updateEmail(c.req.param("id"), await c.req.json());
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

api.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: ApiContext) => {
	const id = c.req.param("id");
	const attachments = await c.var.store.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	await Promise.all(attachments.map((attachment) => deleteAttachment(id, attachment.id, attachment.filename)));
	return c.body(null, 204);
});

api.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: ApiContext) => {
	const { folderId } = await c.req.json<{ folderId: string }>();
	return await c.var.store.moveEmail(c.req.param("id"), folderId)
		? c.json({ status: "moved" })
		: c.json({ error: "Folder not found" }, 400);
});

api.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: ApiContext) =>
	c.json(await c.var.store.getThreadEmails(c.req.param("threadId"))));

api.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: ApiContext) => {
	await c.var.store.markThreadRead(c.req.param("threadId"));
	return c.json({ status: "marked_read" });
});

api.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", async (c: ApiContext) => {
	let original = await c.var.store.getEmail(c.req.param("id")) as EmailFull | null;
	if (!original) return c.json({ error: "Original email not found" }, 404);
	if (original.folder_id === Folders.DRAFT && original.in_reply_to) original = await c.var.store.getEmail(original.in_reply_to) as EmailFull ?? original;
	return deliver(c, original);
});

api.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", async (c: ApiContext) => {
	const original = await c.var.store.getEmail(c.req.param("id")) as EmailFull | null;
	return original ? deliver(c, original, true) : c.json({ error: "Original email not found" }, 404);
});

api.get("/api/v1/mailboxes/:mailboxId/folders", async (c: ApiContext) => c.json(await c.var.store.getFolders()));
api.post("/api/v1/mailboxes/:mailboxId/folders", async (c: ApiContext) => {
	const { name } = await c.req.json<{ name: string }>();
	const id = slugify(name);
	if (!id) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const folder = await c.var.store.createFolder(id, name);
	return folder ? c.json(folder, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});
api.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: ApiContext) => {
	const { name } = await c.req.json<{ name: string }>();
	const folder = await c.var.store.updateFolder(c.req.param("id"), name);
	return folder ? c.json(folder) : c.json({ error: "Folder not found" }, 404);
});
api.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: ApiContext) =>
	await c.var.store.deleteFolder(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "Folder cannot be deleted" }, 400));

api.get("/api/v1/mailboxes/:mailboxId/search", async (c: ApiContext) => {
	const options = {
		query: c.req.query("query") ?? "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.queries("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"), is_starred: boolQuery(c, "is_starred"),
		has_attachment: boolQuery(c, "has_attachment"), page: intQuery(c, "page"), limit: intQuery(c, "limit"),
	};
	return c.json({ emails: await c.var.store.searchEmails(options), totalCount: await c.var.store.countSearchResults(options) });
});

api.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: ApiContext) => {
	const attachment = await c.var.store.getAttachment(c.req.param("attachmentId"));
	if (!attachment || attachment.email_id !== c.req.param("emailId")) return c.json({ error: "Attachment not found" }, 404);
	const bytes = await readAttachment(attachment.email_id, attachment.id, attachment.filename);
	const safe = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	return new Response(bytes, { headers: {
		"Content-Type": attachment.mimetype,
		"Content-Disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
	} });
});
