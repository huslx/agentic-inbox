import { Pool, type PoolClient } from "pg";
import { Folders, FOLDER_DISPLAY_NAMES } from "../shared/folders";

export type EmailInput = {
	id: string;
	subject?: string | null;
	sender?: string | null;
	recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	date?: string | null;
	body?: string | null;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
};

export type AttachmentInput = {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
};

export const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});

const schema = `
CREATE TABLE IF NOT EXISTS mailboxes (
  id text PRIMARY KEY,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS folders (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  is_deletable boolean NOT NULL DEFAULT true,
  PRIMARY KEY (mailbox_id, id),
  UNIQUE (mailbox_id, name)
);
CREATE TABLE IF NOT EXISTS emails (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  id text NOT NULL,
  folder_id text NOT NULL,
  subject text,
  sender text,
  recipient text,
  cc text,
  bcc text,
  date timestamptz NOT NULL DEFAULT now(),
  "read" boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  body text,
  in_reply_to text,
  email_references text,
  thread_id text,
  message_id text,
  raw_headers text,
  PRIMARY KEY (mailbox_id, id),
  FOREIGN KEY (mailbox_id, folder_id) REFERENCES folders(mailbox_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS emails_mailbox_folder_date ON emails(mailbox_id, folder_id, date DESC);
CREATE INDEX IF NOT EXISTS emails_mailbox_thread ON emails(mailbox_id, thread_id);
CREATE TABLE IF NOT EXISTS attachments (
  mailbox_id text NOT NULL,
  id text NOT NULL,
  email_id text NOT NULL,
  filename text NOT NULL,
  mimetype text NOT NULL,
  size integer NOT NULL,
  content_id text,
  disposition text,
  PRIMARY KEY (mailbox_id, id),
  FOREIGN KEY (mailbox_id, email_id) REFERENCES emails(mailbox_id, id) ON DELETE CASCADE
);
`;

export async function initializeDatabase() {
	if (!process.env.DATABASE_URL && !process.env.PGDATABASE) throw new Error("DATABASE_URL or PGDATABASE is required");
	await pool.query(schema);
}

const DEFAULT_SETTINGS = {
	fromName: "",
	forwarding: { enabled: false, email: "" },
	signature: { enabled: false, text: "" },
	autoReply: { enabled: false, subject: "", message: "" },
};

export async function listMailboxes() {
	const { rows } = await pool.query("SELECT id, settings FROM mailboxes ORDER BY id");
	return rows.map(({ id, settings }) => ({ id, email: id, name: id, settings }));
}

export async function getMailbox(id: string) {
	return (await pool.query("SELECT id, settings FROM mailboxes WHERE id = $1", [id.toLowerCase()])).rows[0] ?? null;
}

export async function createMailbox(id: string, name: string, settings: Record<string, unknown> = {}) {
	id = id.toLowerCase();
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const finalSettings = { ...DEFAULT_SETTINGS, fromName: name, ...settings };
		await client.query("INSERT INTO mailboxes (id, settings) VALUES ($1, $2)", [id, finalSettings]);
		for (const [folderId, folderName] of Object.entries(FOLDER_DISPLAY_NAMES)) {
			await client.query(
				"INSERT INTO folders (mailbox_id, id, name, is_deletable) VALUES ($1, $2, $3, false)",
				[id, folderId, folderName],
			);
		}
		await client.query("COMMIT");
		return { id, email: id, name, settings: finalSettings };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function updateMailbox(id: string, settings: Record<string, unknown>) {
	const row = (await pool.query(
		"UPDATE mailboxes SET settings = $2 WHERE id = $1 RETURNING id, settings",
		[id.toLowerCase(), settings],
	)).rows[0];
	return row ? { id: row.id, email: row.id, name: row.id, settings: row.settings } : null;
}

export async function deleteMailbox(id: string) {
	return (await pool.query("DELETE FROM mailboxes WHERE id = $1", [id.toLowerCase()])).rowCount === 1;
}

const emailColumns = `id, subject, sender, recipient, cc, bcc, date::text, "read", starred,
  in_reply_to, email_references, thread_id, folder_id`;

export class MailboxStore {
	constructor(readonly mailboxId: string) {}

	async getEmails(options: {
		folder?: string;
		thread_id?: string;
		page?: number;
		limit?: number;
		sortColumn?: string;
		sortDirection?: "ASC" | "DESC";
	} = {}) {
		const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
		const page = Math.max(options.page ?? 1, 1);
		const allowedSort = new Set(["id", "subject", "sender", "recipient", "date", "read", "starred"]);
		const sort = allowedSort.has(options.sortColumn ?? "") ? options.sortColumn! : "date";
		const direction = options.sortDirection === "ASC" ? "ASC" : "DESC";
		const values: unknown[] = [this.mailboxId];
		const conditions = ["mailbox_id = $1"];
		if (options.folder) {
			values.push(options.folder);
			conditions.push(`folder_id = $${values.length}`);
		}
		if (options.thread_id) {
			values.push(options.thread_id);
			conditions.push(`thread_id = $${values.length}`);
		}
		values.push(limit, (page - 1) * limit);
		return (await pool.query(
			`SELECT ${emailColumns}, left(body, 300) AS snippet FROM emails
			 WHERE ${conditions.join(" AND ")} ORDER BY "${sort}" ${direction}
			 LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		)).rows;
	}

	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const values: unknown[] = [this.mailboxId];
		const conditions = ["mailbox_id = $1"];
		for (const [column, value] of [["folder_id", options.folder], ["thread_id", options.thread_id]] as const) {
			if (value) { values.push(value); conditions.push(`${column} = $${values.length}`); }
		}
		return Number((await pool.query(`SELECT count(*) FROM emails WHERE ${conditions.join(" AND ")}`, values)).rows[0].count);
	}

	async getThreadedEmails(options: { folder?: string; page?: number; limit?: number } = {}) {
		if (!options.folder) return this.getEmails(options);
		const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
		const offset = (Math.max(options.page ?? 1, 1) - 1) * limit;
		// ponytail: groups legacy headerless mail by id; add normalized-subject grouping if imports need it.
		const group = options.folder === Folders.DRAFT ? "coalesce(in_reply_to, id)" : "coalesce(thread_id, id)";
		return (await pool.query(
			`WITH ranked AS (
			  SELECT e.*, ${group} AS conversation_id,
			    row_number() OVER (PARTITION BY ${group} ORDER BY date DESC) AS rn,
			    count(*) OVER (PARTITION BY ${group})::int AS thread_count,
			    count(*) FILTER (WHERE NOT "read") OVER (PARTITION BY ${group})::int AS thread_unread_count,
			    string_agg(sender, ',') OVER (PARTITION BY ${group}) AS participants
			  FROM emails e WHERE mailbox_id = $1 AND folder_id = $2
			)
			SELECT ${emailColumns}, left(body, 300) AS snippet, thread_count, thread_unread_count, participants
			FROM ranked WHERE rn = 1 ORDER BY date DESC LIMIT $3 OFFSET $4`,
			[this.mailboxId, options.folder, limit, offset],
		)).rows;
	}

	async countThreadedEmails(folder: string) {
		const group = folder === Folders.DRAFT ? "coalesce(in_reply_to, id)" : "coalesce(thread_id, id)";
		return Number((await pool.query(
			`SELECT count(DISTINCT ${group}) FROM emails WHERE mailbox_id = $1 AND folder_id = $2`,
			[this.mailboxId, folder],
		)).rows[0].count);
	}

	async getEmail(id: string) {
		const email = (await pool.query(
			`SELECT *, date::text FROM emails WHERE mailbox_id = $1 AND id = $2`,
			[this.mailboxId, id],
		)).rows[0];
		if (!email) return null;
		email.attachments = (await pool.query(
			"SELECT id, email_id, filename, mimetype, size, content_id, disposition FROM attachments WHERE mailbox_id = $1 AND email_id = $2",
			[this.mailboxId, id],
		)).rows;
		return email;
	}

	async getThreadEmails(threadId: string) {
		const rows = (await pool.query(
			`SELECT *, date::text FROM emails WHERE mailbox_id = $1 AND thread_id = $2 ORDER BY date ASC`,
			[this.mailboxId, threadId],
		)).rows;
		if (!rows.length) return [];
		const attachments = (await pool.query(
			"SELECT * FROM attachments WHERE mailbox_id = $1 AND email_id = ANY($2::text[])",
			[this.mailboxId, rows.map((row) => row.id)],
		)).rows;
		return rows.map((row) => ({ ...row, attachments: attachments.filter((a) => a.email_id === row.id) }));
	}

	async updateEmail(id: string, updates: { read?: boolean; starred?: boolean }) {
		const sets: string[] = [];
		const values: unknown[] = [this.mailboxId, id];
		if (updates.read !== undefined) { values.push(updates.read); sets.push(`"read" = $${values.length}`); }
		if (updates.starred !== undefined) { values.push(updates.starred); sets.push(`starred = $${values.length}`); }
		if (sets.length) await pool.query(`UPDATE emails SET ${sets.join(", ")} WHERE mailbox_id = $1 AND id = $2`, values);
		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		await pool.query("UPDATE emails SET \"read\" = true WHERE mailbox_id = $1 AND thread_id = $2", [this.mailboxId, threadId]);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const attachments = (await pool.query(
			"SELECT id, filename FROM attachments WHERE mailbox_id = $1 AND email_id = $2",
			[this.mailboxId, id],
		)).rows;
		const result = await pool.query("DELETE FROM emails WHERE mailbox_id = $1 AND id = $2", [this.mailboxId, id]);
		return result.rowCount ? attachments : null;
	}

	async getAttachment(id: string) {
		return (await pool.query("SELECT * FROM attachments WHERE mailbox_id = $1 AND id = $2", [this.mailboxId, id])).rows[0] ?? null;
	}

	async getFolders() {
		return (await pool.query(
			`SELECT f.id, f.name, count(e.id) FILTER (WHERE NOT e."read")::int AS "unreadCount"
			 FROM folders f LEFT JOIN emails e ON e.mailbox_id = f.mailbox_id AND e.folder_id = f.id
			 WHERE f.mailbox_id = $1 GROUP BY f.id, f.name ORDER BY min(f.id)`,
			[this.mailboxId],
		)).rows;
	}

	async createFolder(id: string, name: string, isDeletable = true) {
		try {
			const row = (await pool.query(
				"INSERT INTO folders (mailbox_id, id, name, is_deletable) VALUES ($1, $2, $3, $4) RETURNING id, name",
				[this.mailboxId, id, name, isDeletable],
			)).rows[0];
			return { ...row, unreadCount: 0 };
		} catch (error: any) {
			if (error?.code === "23505") return null;
			throw error;
		}
	}

	async updateFolder(id: string, name: string) {
		return (await pool.query(
			"UPDATE folders SET name = $3 WHERE mailbox_id = $1 AND id = $2 RETURNING id, name",
			[this.mailboxId, id, name],
		)).rows[0] ?? null;
	}

	async deleteFolder(id: string) {
		return (await pool.query(
			"DELETE FROM folders WHERE mailbox_id = $1 AND id = $2 AND is_deletable RETURNING id",
			[this.mailboxId, id],
		)).rowCount === 1;
	}

	async moveEmail(id: string, folderId: string) {
		return (await pool.query(
			`UPDATE emails SET folder_id = $3 WHERE mailbox_id = $1 AND id = $2
			 AND EXISTS (SELECT 1 FROM folders WHERE mailbox_id = $1 AND id = $3) RETURNING id`,
			[this.mailboxId, id, folderId],
		)).rowCount === 1;
	}

	private searchWhere(options: Record<string, unknown>) {
		const values: unknown[] = [this.mailboxId];
		const conditions = ["e.mailbox_id = $1"];
		const add = (sql: string, value: unknown) => { values.push(value); conditions.push(sql.replaceAll("?", `$${values.length}`)); };
		if (options.query) add("(e.subject ILIKE ? OR e.body ILIKE ? OR e.sender ILIKE ? OR e.recipient ILIKE ?)", `%${options.query}%`);
		if (options.folder) add("e.folder_id = ?", options.folder);
		if (options.from) add("e.sender ILIKE ?", `%${options.from}%`);
		if (options.subject) add("e.subject ILIKE ?", `%${options.subject}%`);
		if (options.date_start) add("e.date >= ?", options.date_start);
		if (options.date_end) add("e.date <= ?", options.date_end);
		if (options.is_read !== undefined) add("e.\"read\" = ?", options.is_read);
		if (options.is_starred !== undefined) add("e.starred = ?", options.is_starred);
		if (options.has_attachment) conditions.push("EXISTS (SELECT 1 FROM attachments a WHERE a.mailbox_id = e.mailbox_id AND a.email_id = e.id)");
		const recipients = Array.isArray(options.to) ? options.to : options.to ? [options.to] : [];
		if (recipients.length) add("concat_ws(',', e.recipient, e.cc, e.bcc) ILIKE ANY(?)", recipients.map((r) => `%${r}%`));
		return { values, conditions };
	}

	async searchEmails(options: Record<string, unknown> & { page?: number; limit?: number }) {
		const { values, conditions } = this.searchWhere(options);
		const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
		const offset = (Math.max(options.page ?? 1, 1) - 1) * limit;
		values.push(limit, offset);
		return (await pool.query(
			`SELECT ${emailColumns}, left(body, 300) AS snippet, folder_id AS folder_name FROM emails e
			 WHERE ${conditions.join(" AND ")} ORDER BY date DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		)).rows;
	}

	async countSearchResults(options: Record<string, unknown>) {
		const { values, conditions } = this.searchWhere(options);
		return Number((await pool.query(`SELECT count(*) FROM emails e WHERE ${conditions.join(" AND ")}`, values)).rows[0].count);
	}

	async findThreadBySubject(subject: string, sender?: string) {
		const normalized = subject.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "").trim();
		if (!normalized) return null;
		const rows = (await pool.query(
			`SELECT thread_id, subject, sender, recipient FROM emails
			 WHERE mailbox_id = $1 AND thread_id IS NOT NULL AND date >= now() - interval '7 days'
			 ORDER BY date DESC LIMIT 50`,
			[this.mailboxId],
		)).rows;
		return rows.find((row) =>
			String(row.subject ?? "").replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "").trim().toLowerCase() === normalized.toLowerCase()
			&& (!sender || `${row.sender},${row.recipient}`.toLowerCase().includes(sender.toLowerCase())),
		)?.thread_id ?? null;
	}

	async checkSendRateLimit() {
		for (const [interval, max] of [["1 hour", 20], ["1 day", 100]] as const) {
			const count = Number((await pool.query(
				`SELECT count(*) FROM emails WHERE mailbox_id = $1 AND folder_id = $2 AND date >= now() - $3::interval`,
				[this.mailboxId, Folders.SENT, interval],
			)).rows[0].count);
			if (count >= max) return `Rate limit exceeded: max ${max} emails per ${interval} per mailbox`;
		}
		return null;
	}

	async createEmail(folder: string, email: EmailInput, attachments: AttachmentInput[]) {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await this.insertEmail(client, folder, email);
			for (const attachment of attachments) {
				await client.query(
					`INSERT INTO attachments (mailbox_id, id, email_id, filename, mimetype, size, content_id, disposition)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
					[this.mailboxId, attachment.id, attachment.email_id, attachment.filename, attachment.mimetype, attachment.size, attachment.content_id, attachment.disposition],
				);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async insertEmail(client: PoolClient, folder: string, email: EmailInput) {
		await client.query(
			`INSERT INTO emails (mailbox_id,id,folder_id,subject,sender,recipient,cc,bcc,date,"read",starred,body,in_reply_to,email_references,thread_id,message_id,raw_headers)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
			[this.mailboxId, email.id, folder, email.subject, email.sender, email.recipient, email.cc, email.bcc,
				email.date ?? new Date().toISOString(), folder === Folders.SENT || !!email.read, !!email.starred, email.body,
				email.in_reply_to, email.email_references, email.thread_id, email.message_id, email.raw_headers],
		);
	}
}
