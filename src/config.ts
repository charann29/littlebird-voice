/**
 * Central configuration for Soniox integration and app-wide constants.
 *
 * The Soniox API key never ships in the client bundle: async transcription is
 * relayed through the Worker's allow-listed /api/stt/* routes (which inject
 * the key server-side), and live transcription mints a short-lived temporary
 * key via POST /api/auth/soniox-token.
 */

/** Base path for the Worker's Soniox async relay (same-origin). */
export const API_BASE = "/api/stt";

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
