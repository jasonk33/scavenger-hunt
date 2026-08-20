"use client";

import * as tus from "tus-js-client";
import { errorMessage } from "./client";

/**
 * Direct browser -> Supabase Storage upload.
 *
 * This configuration was validated on real iPhone and Android hardware over 5G
 * (11 uploads, 0 failures, 150 MB in under 30s). Every option below is load
 * bearing. Do not "clean it up".
 */

export type UploadConfig = { endpoint: string; anonKey: string; bucket: string };

export type UploadHandle = {
  abort: () => void;
};

/**
 * iPhone .mov files are ISO base media (structurally MP4) carrying H.264/AAC,
 * but Safari labels them video/quicktime -- which Chrome refuses to play inline
 * and DOWNLOADS instead. Relabelling to video/mp4 fixes playback everywhere with
 * no transcoding. Mirrored on the server so the stored object gets the right
 * content-type header; kept here so the two never disagree.
 */
export function playableType(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (t === "video/quicktime" || /\.mov$/i.test(file.name)) return "video/mp4";
  return file.type || "application/octet-stream";
}

/**
 * Supabase Storage requires an Authorization header AND requires it to be a JWT.
 * The newer `sb_publishable_...` keys are not JWTs and fail with
 * "Invalid Compact JWS". Checked up front so the failure is a clear message
 * rather than a mid-upload error.
 */
export const isJwt = (k: string) => /^ey[A-Za-z0-9_-]+\./.test(k ?? "");

/** tus surfaces the HTTP response only on DetailedError, not on plain Errors. */
function httpStatus(err: Error | tus.DetailedError): number {
  return "originalResponse" in err ? (err.originalResponse?.getStatus() ?? 0) : 0;
}

export function uploadFile(opts: {
  file: File;
  objectName: string;
  contentType: string;
  config: UploadConfig;
  onProgress: (sent: number, total: number) => void;
  onRetry: (n: number) => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}): UploadHandle {
  const { file, objectName, contentType, config } = opts;
  let retries = 0;

  const upload = new tus.Upload(file, {
    endpoint: config.endpoint,
    retryDelays: [0, 3000, 5000, 10000, 20000],
    headers: {
      authorization: `Bearer ${config.anonKey}`,
      apikey: config.anonKey,
      "x-upsert": "true",
    },
    uploadDataDuringCreation: true,
    // Without this, re-shooting a task and uploading a file with the SAME name
    // resumes the OLD upload from cache and silently attaches the wrong footage.
    // Undetectable at the judge screen. Do not remove.
    removeFingerprintOnSuccess: true,
    // Supabase requires exactly 6MB. Their docs say do not change it.
    chunkSize: 6 * 1024 * 1024,
    metadata: {
      bucketName: config.bucket,
      objectName,
      contentType,
      cacheControl: "3600",
    },
    onShouldRetry(err: tus.DetailedError) {
      // Retry network blips. Surface auth/config errors immediately instead of
      // burning 40 seconds of retries on a problem that will never resolve.
      const status = httpStatus(err);
      if (status >= 400 && status < 500 && status !== 409 && status !== 423) return false;
      retries += 1;
      opts.onRetry(retries);
      return true;
    },
    onProgress(sent: number, total: number) {
      opts.onProgress(sent, total);
    },
    onError(err: Error | tus.DetailedError) {
      const status = httpStatus(err);
      let hint = "";
      if (status === 401 || status === 403) hint = " Upload key was rejected — tell an organizer.";
      if (status === 413) hint = " File too large for the storage limit — tell an organizer.";
      opts.onError(`${errorMessage(err)}${hint}`);
    },
    onSuccess() {
      opts.onSuccess();
    },
  });

  upload.start();
  return { abort: () => void upload.abort(true).catch(() => {}) };
}

/**
 * Holds a screen wake lock while bytes are moving. iOS has no Background Fetch
 * and no Background Sync, so a locked phone can stall an upload; uploads finish
 * in seconds in practice, but this removes the failure mode entirely for the
 * cost of three lines.
 *
 * Not a React hook -- a plain factory, so it can be held in a ref without
 * re-running on every render.
 */
export function createWakeLock() {
  let lock: WakeLockSentinel | null = null;
  return {
    async acquire() {
      try {
        lock = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        /* unsupported; harmless */
      }
    },
    release() {
      try {
        lock?.release();
      } catch {
        /* ignore */
      }
      lock = null;
    },
  };
}
