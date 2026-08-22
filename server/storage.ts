import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentInput } from "./db";

const root = path.resolve(process.env.ATTACHMENTS_DIR ?? "./data/attachments");

function attachmentPath(emailId: string, attachmentId: string, filename: string) {
	return path.join(root, encodeURIComponent(emailId), encodeURIComponent(attachmentId), path.basename(filename));
}

export async function storeAttachments(emailId: string, attachments?: {
	content: string;
	filename: string;
	type: string;
	disposition: string;
	contentId?: string;
}[]): Promise<AttachmentInput[]> {
	if (!attachments?.length) return [];
	const stored: AttachmentInput[] = [];
	for (const attachment of attachments) {
		const id = crypto.randomUUID();
		const filename = path.basename(attachment.filename || "untitled").replace(/[\x00-\x1f]/g, "_");
		const bytes = Buffer.from(attachment.content, "base64");
		const target = attachmentPath(emailId, id, filename);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, bytes, { flag: "wx" });
		stored.push({
			id,
			email_id: emailId,
			filename,
			mimetype: attachment.type,
			size: bytes.length,
			content_id: attachment.contentId ?? null,
			disposition: attachment.disposition,
		});
	}
	return stored;
}

export async function storeBinaryAttachment(emailId: string, attachment: {
	id?: string;
	filename?: string;
	mimeType: string;
	content: string | ArrayBuffer;
	contentId?: string;
	disposition?: string;
}): Promise<AttachmentInput> {
	const id = attachment.id ?? crypto.randomUUID();
	const filename = path.basename(attachment.filename || "untitled").replace(/[\x00-\x1f]/g, "_");
	const bytes = typeof attachment.content === "string"
		? Buffer.from(attachment.content)
		: Buffer.from(attachment.content);
	const target = attachmentPath(emailId, id, filename);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, bytes, { flag: "wx" });
	return {
		id,
		email_id: emailId,
		filename,
		mimetype: attachment.mimeType,
		size: bytes.length,
		content_id: attachment.contentId ?? null,
		disposition: attachment.disposition ?? "attachment",
	};
}

export function readAttachment(emailId: string, attachmentId: string, filename: string) {
	return readFile(attachmentPath(emailId, attachmentId, filename));
}

export async function deleteAttachment(emailId: string, attachmentId: string, filename: string) {
	await rm(attachmentPath(emailId, attachmentId, filename), { force: true });
}
