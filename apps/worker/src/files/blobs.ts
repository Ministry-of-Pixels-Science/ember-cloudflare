import { isPreviewableSize, isPreviewed, type RoomId, type StoredFile, type UserId } from "@ember/protocol";
import { statement, type Db, type Statement } from "../db";
import { sanitizedFilename } from "./filename";
import type { ImageSize } from "./images";
import type { StreamedFile } from "./streamed";

// A room's files as its storage keeps them (migrations/0028_blobs.sql), in its Durable Object SQLite
// storage or in D1 (see db.ts), from when someone starts uploading one until R2 has all of it and the
// room has posted it as their message (migrations/0029_file_messages.sql), and until the message is
// deleted, when the room deletes the file from R2 and forgets it (migrations/0031_purged_files.sql).

/** Where R2 keeps the file whose key is `key`. */
export const objectKey = (key: string) => `files/${key}`;

/** Where R2 keeps the preview of the file whose key is `key`. */
export const previewKey = (key: string) => `previews/${key}`;

/** A part of a file that R2 holds, which putting the parts together names. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** A file uploaded to a room, as far as its upload has come. */
export interface RoomBlob {
  /** Its key, by which R2 keeps it too. */
  id: string;
  uploaderId: UserId;
  /** Its name, as it was given. */
  filename: string;
  /** The type the browser declared until the first part identifies it. */
  contentType: string;
  byteSize: number;
  /** Active Storage's metadata, as JSON, written once the first part has identified the file. */
  metadata: string | null;
  /** R2's upload of a file in more than one part, once the first part has started it. */
  multipartUploadId: string | null;
  /** The parts R2 has of a file in more than one part, in order. */
  parts: UploadedPart[];
  /** The id the app gave the file's message, or null for an upload started before files were messages. */
  clientMessageId: string | null;
  completedAt: string | null;
  /** The message the room posted the file as, once R2 has all of it. */
  messageId: string | null;
  /** Its preview's size, once its uploader has sent one (migrations/0030_file_previews.sql). */
  preview: ImageSize | null;
  /** The message in whose thread it's a reply, or null (migrations/0044_threads.sql). */
  parentId: string | null;
  /** Whether a reply in a thread is also sent to the room. */
  alsoSent: boolean;
}

interface BlobRow {
  id: string;
  uploader_id: UserId;
  filename: string;
  content_type: string;
  byte_size: number;
  metadata: string | null;
  multipart_upload_id: string | null;
  parts: string;
  client_message_id: string | null;
  completed_at: string | null;
  message_id: string | null;
  preview: string | null;
  parent_id: string | null;
  also_sent: number;
}

const toBlob = (row: BlobRow): RoomBlob => ({
  id: row.id,
  uploaderId: row.uploader_id,
  filename: row.filename,
  contentType: row.content_type,
  byteSize: row.byte_size,
  metadata: row.metadata,
  multipartUploadId: row.multipart_upload_id,
  parts: JSON.parse(row.parts) as UploadedPart[],
  clientMessageId: row.client_message_id,
  completedAt: row.completed_at,
  messageId: row.message_id,
  preview: row.preview === null ? null : (JSON.parse(row.preview) as ImageSize),
  parentId: row.parent_id,
  alsoSent: row.also_sent === 1,
});

/** A file the room has marked deleted, which R2 is to forget: its key, and whether its upload in parts is unfinished. */
export interface DeletedBlob {
  id: string;
  /** R2's upload of the file in parts, while the room hasn't recorded that it's all there. */
  unfinishedUploadId: string | null;
}

/**
 * Marks deleted the files of the messages a JSON list of their ids names, which keep their files' keys.
 * `+room_id` has SQLite find each file by its key, where `index_blobs_on_room_id` would have it read every
 * file the room has.
 */
export const DELETE_FILES_OF = `UPDATE blobs SET deleted_at = ? WHERE +room_id = ? AND deleted_at IS NULL AND id IN
  (SELECT json_extract(attachment, '$.id') FROM messages WHERE room_id = ? AND id IN (SELECT value FROM json_each(?)) AND attachment IS NOT NULL)`;

/** Marks deleted the uploads still unfinished that started by a time. */
export const DELETE_UNFINISHED = `UPDATE blobs SET deleted_at = ? WHERE room_id = ? AND completed_at IS NULL AND created_at <= ? AND deleted_at IS NULL`;

/** When the oldest upload still unfinished started. */
export const OLDEST_UNFINISHED = `SELECT created_at FROM blobs WHERE room_id = ? AND completed_at IS NULL AND deleted_at IS NULL ORDER BY created_at LIMIT 1`;

/** Some of the files marked deleted. */
export const DELETED_FILES = `SELECT id, multipart_upload_id, completed_at FROM blobs WHERE room_id = ? AND deleted_at IS NOT NULL LIMIT ?`;

/** Forgets the files marked deleted that a JSON list of their keys names, each found by its key, as `DELETE_FILES_OF` finds them. */
export const FORGET_FILES = `DELETE FROM blobs WHERE +room_id = ? AND id IN (SELECT value FROM json_each(?)) AND deleted_at IS NOT NULL`;

/**
 * What marks deleted the files of the messages `listed` names, a JSON list of their ids, at `now`, for
 * the batch that deletes the messages, which has to run it first.
 */
export const deletingFilesOf = (roomId: RoomId, listed: string, now: string): Statement => statement(DELETE_FILES_OF, now, roomId, roomId, listed);

/** What marks deleted every file room `roomId` has, at `now`, uploads under way included, as deleting the room does. */
export const deletingAllFiles = (roomId: RoomId, now: string): Statement =>
  statement(`UPDATE blobs SET deleted_at = ? WHERE room_id = ? AND deleted_at IS NULL`, now, roomId);

/** What the first part of a file says of it: its type and Active Storage's metadata. */
export interface Identified {
  contentType: string;
  metadata: string;
}

/**
 * A file as its message keeps it (`messages.attachment`): as it shows, but for its addresses, which are
 * signed as it's read, and whether it has a preview to sign one for.
 */
export type AttachedFile = Omit<StoredFile, "url" | "downloadUrl" | "previewUrl"> & { preview?: true };

/**
 * What the message `blob` is posted as keeps of it, once its first part has identified it, as
 * `identified` says if it isn't recorded yet: with its preview, if it's a file shown by one, and that
 * preview's size where its own can't be read, as a video's can't. A picture keeps its preview only where
 * its own size is known and within 250 megapixels: the uploader's browser makes it, so it's checked
 * here.
 */
export function attachedFile(blob: RoomBlob, identified?: Identified): AttachedFile {
  const { contentType, metadata } = identified ?? { contentType: blob.contentType, metadata: blob.metadata! };
  const { width, height } = JSON.parse(metadata) as Partial<ImageSize>;
  const shownByPreview = contentType.startsWith("video") || isPreviewableSize({ width, height });
  const preview = isPreviewed(contentType) && shownByPreview ? blob.preview : null;
  const size = width !== undefined && height !== undefined ? { width, height } : preview;
  return {
    id: blob.id,
    name: sanitizedFilename(blob.filename),
    contentType,
    byteSize: blob.byteSize,
    ...(size && { width: size.width, height: size.height }),
    ...(preview && { preview: true as const }),
  };
}

export class Blobs {
  constructor(
    private readonly db: Db,
    readonly roomId: RoomId,
  ) {}

  /** Records that `blob`'s upload has started, at `createdAt`. */
  async create(blob: Pick<RoomBlob, "id" | "uploaderId" | "filename" | "contentType" | "byteSize" | "clientMessageId" | "parentId" | "alsoSent">, createdAt: string): Promise<void> {
    await this.db.run(
      `INSERT INTO blobs (id, room_id, uploader_id, filename, content_type, byte_size, client_message_id, created_at, parent_id, also_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      blob.id,
      this.roomId,
      blob.uploaderId,
      blob.filename,
      blob.contentType,
      blob.byteSize,
      blob.clientMessageId,
      createdAt,
      blob.parentId,
      blob.alsoSent ? 1 : 0,
    );
  }

  /** File `id`, unless it's been marked deleted. */
  async find(id: string): Promise<RoomBlob | null> {
    const [row] = await this.db.all<BlobRow>(`SELECT * FROM blobs WHERE room_id = ? AND id = ? AND deleted_at IS NULL`, this.roomId, id);
    return row ? toBlob(row) : null;
  }

  /**
   * Records what the first part of file `id`, in more than one part, identified it as, unless that's
   * recorded already, with the multipart upload and first part R2 has of it. Answers the file as it is
   * then, or null if it was identified already.
   */
  async identify(id: string, { contentType, metadata }: Identified, multipartUploadId: string, part: UploadedPart): Promise<RoomBlob | null> {
    const [row] = await this.db.all<BlobRow>(
      `UPDATE blobs SET content_type = ?, metadata = ?, multipart_upload_id = ?, parts = ?
        WHERE room_id = ? AND id = ? AND metadata IS NULL RETURNING *`,
      contentType,
      metadata,
      multipartUploadId,
      JSON.stringify([part]),
      this.roomId,
      id,
    );
    return row ? toBlob(row) : null;
  }

  /**
   * Records that `uploaderId`'s file `id` has a preview of `size`, in place of any it had, unless it's
   * posted already, answering the file as it is then, or null if they have no such file.
   */
  async recordPreview(id: string, uploaderId: UserId, size: ImageSize): Promise<RoomBlob | null> {
    const [row] = await this.db.all<BlobRow>(
      `UPDATE blobs SET preview = ? WHERE room_id = ? AND id = ? AND uploader_id = ? AND completed_at IS NULL AND deleted_at IS NULL RETURNING *`,
      JSON.stringify({ width: size.width, height: size.height }),
      this.roomId,
      id,
      uploaderId,
    );
    if (row) return toBlob(row);
    const blob = await this.find(id);
    return blob?.uploaderId === uploaderId ? blob : null;
  }

  /** Records `part` of file `id`, in place of any it had with its number, and answers the file as it is then. */
  async recordPart(blob: RoomBlob, part: UploadedPart): Promise<RoomBlob> {
    const parts = [...blob.parts.filter(({ partNumber }) => partNumber !== part.partNumber), part].sort((a, b) => a.partNumber - b.partNumber);
    await this.db.run(`UPDATE blobs SET parts = ? WHERE room_id = ? AND id = ?`, JSON.stringify(parts), this.roomId, blob.id);
    return { ...blob, parts };
  }

  /**
   * What records that R2 has all of file `id`, at `completedAt`, and that it's posted as message
   * `messageId`, for the batch that stores the message, with what its one part identified it as, for a
   * file in one part.
   */
  finished(id: string, messageId: string, completedAt: string, identified?: Identified): Statement {
    return identified
      ? statement(
          `UPDATE blobs SET content_type = ?, metadata = ?, completed_at = ?, message_id = ? WHERE room_id = ? AND id = ?`,
          identified.contentType,
          identified.metadata,
          completedAt,
          messageId,
          this.roomId,
          id,
        )
      : statement(`UPDATE blobs SET completed_at = ?, message_id = ? WHERE room_id = ? AND id = ?`, completedAt, messageId, this.roomId, id);
  }

  /**
   * What records that R2 has all of file `id`, which it was sent as it arrived, `byteSize` bytes that
   * their first part identified as `identified` says, with the size of its preview, if it has one, as
   * `finished` records a file the uploader sized first.
   */
  streamed(id: string, messageId: string, completedAt: string, { byteSize, identified, preview }: StreamedFile): Statement {
    return statement(
      `UPDATE blobs SET byte_size = ?, content_type = ?, metadata = ?, preview = ?, completed_at = ?, message_id = ? WHERE room_id = ? AND id = ?`,
      byteSize,
      identified.contentType,
      identified.metadata,
      preview ? JSON.stringify({ width: preview.width, height: preview.height }) : null,
      completedAt,
      messageId,
      this.roomId,
      id,
    );
  }

  /** Marks deleted, at `now`, the uploads started by `startedBy` that are still unfinished. */
  async deleteUnfinished(startedBy: string, now: string): Promise<void> {
    await this.db.run(DELETE_UNFINISHED, now, this.roomId, startedBy);
  }

  /** When the oldest upload still unfinished started, or null when there's none. */
  async oldestUnfinished(): Promise<string | null> {
    const [row] = await this.db.all<{ created_at: string }>(OLDEST_UNFINISHED, this.roomId);
    return row?.created_at ?? null;
  }

  /** Up to `limit` of the files marked deleted. */
  async deleted(limit: number): Promise<DeletedBlob[]> {
    const rows = await this.db.all<{ id: string; multipart_upload_id: string | null; completed_at: string | null }>(DELETED_FILES, this.roomId, limit);
    return rows.map((row) => ({ id: row.id, unfinishedUploadId: row.completed_at === null ? row.multipart_upload_id : null }));
  }

  /** Forgets the files marked deleted that `ids` names, once R2 has. */
  async forget(ids: string[]): Promise<void> {
    await this.db.run(FORGET_FILES, this.roomId, JSON.stringify(ids));
  }
}
