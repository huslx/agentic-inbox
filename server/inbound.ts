import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import PostalMime from "postal-mime";
import { Folders } from "../shared/folders";
import { createMailbox, getMailbox, MailboxStore } from "./db";
import { acknowledgeInboundEmail, pullInboundEmail } from "./gateway";
import { storeBinaryAttachment } from "./storage";

function extractMessageId(value: string) {
	const match = value.match(/<([^>]+)>/);
	return match ? match[1] : value.trim().split(/\s+/)[0];
}

async function notifyMailReceived(payload: Record<string, unknown>) {
	if (!process.env.MAIL_WEBHOOK_URL || !process.env.INBOX_WEBHOOK_SECRET) return;
	const body = JSON.stringify(payload);
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signature = createHmac("sha256", process.env.INBOX_WEBHOOK_SECRET)
		.update(`${timestamp}.${body}`)
		.digest("hex");
	const response = await fetch(process.env.MAIL_WEBHOOK_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Inbox-Timestamp": timestamp,
			"X-Inbox-Signature": `v1=${signature}`,
		},
		body,
	});
	if (!response.ok) throw new Error(`Mail webhook returned ${response.status}`);
}

export async function processInboundEmail(raw: ArrayBuffer, envelopeFrom: string, envelopeTo: string) {
	const parsed = await new PostalMime().parse(raw);
	const mailboxId = envelopeTo.trim().toLowerCase();
	if (!mailboxId.includes("@")) throw new Error(`Invalid recipient: ${mailboxId}`);
	if (!(await getMailbox(mailboxId))) await createMailbox(mailboxId, mailboxId.split("@")[0]);

	const store = new MailboxStore(mailboxId);
	const id = crypto.randomUUID();
	const attachments = await Promise.all((parsed.attachments ?? []).map((attachment) =>
		storeBinaryAttachment(id, attachment),
	));
	const inReplyTo = parsed.inReplyTo ? extractMessageId(parsed.inReplyTo) : null;
	const references = parsed.references
		? parsed.references.split(/\s+/).filter(Boolean).map(extractMessageId)
		: [];
	let threadId = references[0] || inReplyTo || id;
	if (!inReplyTo && !references.length) {
		threadId = await store.findThreadBySubject(parsed.subject ?? "", parsed.from?.address) ?? id;
	}
	const sender = (parsed.from?.address || envelopeFrom).toLowerCase();
	const body = parsed.html || parsed.text || "";
	await store.createEmail(Folders.INBOX, {
		id,
		subject: parsed.subject ?? "",
		sender,
		recipient: (parsed.to ?? []).map((entry) => entry.address?.toLowerCase()).filter(Boolean).join(", ") || mailboxId,
		cc: (parsed.cc ?? []).map((entry) => entry.address?.toLowerCase()).filter(Boolean).join(", ") || null,
		bcc: (parsed.bcc ?? []).map((entry) => entry.address?.toLowerCase()).filter(Boolean).join(", ") || null,
		date: new Date().toISOString(),
		body,
		in_reply_to: inReplyTo,
		email_references: references.length ? JSON.stringify(references) : null,
		thread_id: threadId,
		message_id: parsed.messageId ? extractMessageId(parsed.messageId) : null,
		raw_headers: JSON.stringify(parsed.headers),
	}, attachments);
	await notifyMailReceived({ mailbox: mailboxId, emailId: id, sender, subject: parsed.subject ?? "", body });
}

export function verifySmtpSecret(value = "") {
	const expected = process.env.SMTP_DELIVERY_SECRET;
	if (!expected) return false;
	const digest = (input: string) => createHash("sha256").update(input).digest();
	return timingSafeEqual(digest(value), digest(expected));
}

let polling = false;

export function startInboundPoller() {
	if (!process.env.MAIL_GATEWAY_URL) return;
	const poll = async () => {
		if (polling) return;
		polling = true;
		try {
			for (let email = await pullInboundEmail(); email; email = await pullInboundEmail()) {
				await processInboundEmail(email.raw, email.from, email.to);
				await acknowledgeInboundEmail(email.key);
			}
		} catch (error) {
			console.error("Inbound email poll failed:", error);
		} finally {
			polling = false;
		}
	};
	void poll();
	setInterval(poll, 30_000).unref();
}
