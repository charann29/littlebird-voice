/**
 * IndexedDB access layer for littlebird-voice, built on `idb`.
 *
 * Recordings (including their audio Blob) are stored directly in IndexedDB so
 * the app works fully offline: audio is captured and persisted locally, then
 * transcribed opportunistically once a network connection is available.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Recording } from "../types";

const DB_NAME = "littlebird-voice";
const DB_VERSION = 1;
const STORE = "recordings";

interface LittlebirdDB extends DBSchema {
  recordings: {
    key: string;
    value: Recording;
    indexes: {
      "by-createdAt": number;
      "by-status": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<LittlebirdDB>> | null = null;

/** Open (or reuse) the singleton IndexedDB connection. */
export function getDB(): Promise<IDBPDatabase<LittlebirdDB>> {
  if (!dbPromise) {
    dbPromise = openDB<LittlebirdDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("by-createdAt", "createdAt");
        store.createIndex("by-status", "status");
      },
    });
  }
  return dbPromise;
}

/** Persist a new recording. */
export async function addRecording(recording: Recording): Promise<void> {
  const db = await getDB();
  await db.put(STORE, recording);
}

/** Fetch a single recording by id, or undefined if not found. */
export async function getRecording(id: string): Promise<Recording | undefined> {
  const db = await getDB();
  return db.get(STORE, id);
}

/** Fetch all recordings sorted newest-first by createdAt. */
export async function getAllRecordings(): Promise<Recording[]> {
  const db = await getDB();
  const all = await db.getAll(STORE);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Merge a partial patch into an existing recording and persist it. Returns the
 * updated recording, or undefined if the id no longer exists.
 */
export async function updateRecording(
  id: string,
  patch: Partial<Recording>,
): Promise<Recording | undefined> {
  const db = await getDB();
  const existing = await db.get(STORE, id);
  if (!existing) return undefined;
  const updated: Recording = { ...existing, ...patch, id: existing.id };
  await db.put(STORE, updated);
  return updated;
}

/** Delete a recording by id. */
export async function deleteRecording(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, id);
}
