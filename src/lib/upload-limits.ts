export const MAX_MAIN_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_AUXILIARY_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 128;
export const MAX_ARCHIVE_TOTAL_BYTES = 25 * 1024 * 1024;

export type UploadLimitErrorCode =
  | "upload_file_too_large"
  | "upload_archive_too_large"
  | "upload_archive_too_many_entries";

export class UploadLimitError extends Error {
  errorCode: UploadLimitErrorCode;
  status: number;

  constructor(errorCode: UploadLimitErrorCode, message: string, status = 413) {
    super(message);
    this.name = "UploadLimitError";
    this.errorCode = errorCode;
    this.status = status;
  }
}

export function validateMainUploadSize(byteLength: number): UploadLimitErrorCode | null {
  return byteLength > MAX_MAIN_UPLOAD_BYTES ? "upload_file_too_large" : null;
}

export function validateAuxiliaryUploadSize(byteLength: number): UploadLimitErrorCode | null {
  return byteLength > MAX_AUXILIARY_UPLOAD_BYTES ? "upload_file_too_large" : null;
}

export function consumeArchiveEntry(
  budget: { entries: number; totalBytes: number },
  byteLength: number,
):
  | { ok: true; budget: { entries: number; totalBytes: number } }
  | { ok: false; errorCode: UploadLimitErrorCode } {
  const nextEntries = budget.entries + 1;
  if (nextEntries > MAX_ARCHIVE_ENTRIES) {
    return { ok: false, errorCode: "upload_archive_too_many_entries" };
  }

  const nextTotalBytes = budget.totalBytes + byteLength;
  if (nextTotalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
    return { ok: false, errorCode: "upload_archive_too_large" };
  }

  return {
    ok: true,
    budget: {
      entries: nextEntries,
      totalBytes: nextTotalBytes,
    },
  };
}

export function throwIfUploadLimitExceeded(errorCode: UploadLimitErrorCode | null): void {
  if (!errorCode) return;
  switch (errorCode) {
    case "upload_file_too_large":
      throw new UploadLimitError(errorCode, "Uploaded file exceeds size limit");
    case "upload_archive_too_large":
      throw new UploadLimitError(errorCode, "Archive expands beyond supported size");
    case "upload_archive_too_many_entries":
      throw new UploadLimitError(errorCode, "Archive contains too many files");
  }
}
