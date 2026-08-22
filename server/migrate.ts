import { createMailbox, getMailbox, MailboxStore, updateMailbox } from "./db";
import { storeBinaryAttachment } from "./storage";

const url = process.env.MIGRATION_URL?.replace(/\/$/, "");
const secret = process.env.MIGRATION_SECRET;
if (!url || !secret) throw new Error("MIGRATION_URL and MIGRATION_SECRET are required");
const headers = { Authorization: `Bearer ${secret}` };

async function json(path: string) {
	const response = await fetch(`${url}${path}`, { headers });
	if (!response.ok) throw new Error(`${path} returned ${response.status}`);
	return response.json();
}

let emailCount = 0;
let attachmentCount = 0;
const mailboxes = await json("/mailboxes") as string[];
for (const mailboxId of mailboxes) {
	const exported = await json(`/mailbox/${encodeURIComponent(mailboxId)}`) as any;
	if (!(await getMailbox(mailboxId))) await createMailbox(mailboxId, exported.settings?.fromName || mailboxId.split("@")[0]);
	await updateMailbox(mailboxId, exported.settings ?? {});
	const store = new MailboxStore(mailboxId);
	const existingFolders = new Set((await store.getFolders()).map((folder) => folder.id));
	for (const folder of exported.folders ?? []) {
		if (!existingFolders.has(folder.id)) await store.createFolder(folder.id, folder.name);
	}
	for (const email of exported.emails ?? []) {
		if (await store.getEmail(email.id)) continue;
		const attachments = [];
		for (const attachment of email.attachments ?? []) {
			const key = `attachments/${email.id}/${attachment.id}/${attachment.filename}`;
			const response = await fetch(`${url}/attachment?key=${encodeURIComponent(key)}`, { headers });
			if (!response.ok) throw new Error(`Attachment ${key} returned ${response.status}`);
			attachments.push(await storeBinaryAttachment(email.id, {
				id: attachment.id,
				filename: attachment.filename,
				mimeType: attachment.mimetype,
				content: await response.arrayBuffer(),
				contentId: attachment.content_id,
				disposition: attachment.disposition,
			}));
			attachmentCount++;
		}
		await store.createEmail(email.folder_id, email, attachments);
		emailCount++;
	}
}

console.log(JSON.stringify({ mailboxes: mailboxes.length, emails: emailCount, attachments: attachmentCount }));

