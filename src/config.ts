/**
 * Central configuration for Soniox integration and app-wide constants.
 *
 * Security note: VITE_SONIOX_API_KEY is inlined into the client bundle at build
 * time (Vite inlines all VITE_* vars). This matches the reference MVP. For a
 * public deployment, replace API_BASE + authHeaders in lib/soniox-async.ts with
 * a serverless proxy that holds the key server-side. This module is the single
 * seam where that swap happens.
 */

export const SONIOX_API_KEY = import.meta.env.VITE_SONIOX_API_KEY as string;

/** Base URL for Soniox REST API (async transcription). */
export const API_BASE = "https://api.soniox.com";

/** Realtime streaming model (online live transcription). */
export const RT_MODEL = "stt-rt-v5";

/** Async model (offline-recorded audio transcribed when back online). */
export const ASYNC_MODEL = "stt-async-v5";

/** Language hints shared by both realtime and async transcription. */
export const LANGUAGE_HINTS = ["en", "hi", "te"];

/** Interval between async transcription status polls (ms). */
export const POLL_INTERVAL_MS = 2000;

/** Give up polling an async job after this long (ms). */
export const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Soft cap on a single recording length (ms) to avoid runaway memory/quota. */
export const MAX_RECORDING_MS = 10 * 60 * 1000;

/** MediaRecorder timeslice (ms) so chunks flush periodically. */
export const RECORDER_TIMESLICE_MS = 1000;
