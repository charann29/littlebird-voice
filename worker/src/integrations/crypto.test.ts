import { describe, it, expect } from "vitest";
import {
  constantTimeEqual,
  decryptToken,
  encryptToken,
  generateStateId,
  signState,
  verifyState,
} from "./crypto";

// 32 bytes base64 (same key style as production INTEGRATIONS_TOKEN_KEY).
const KEY = "9jJVsRLZ9AsGGxvsIZ3HYyWDL4WYAY1TQK+I2AhQfvM=";
const OTHER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SIGNING = "test-state-signing-key";

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips a token", async () => {
    const token = "ya29.a0AfB_secret-access-token";
    const enc = await encryptToken(token, KEY);
    expect(enc).not.toContain(token);
    expect(await decryptToken(enc, KEY)).toBe(token);
  });

  it("uses a fresh IV per encryption (same plaintext → different ciphertext)", async () => {
    const a = await encryptToken("same", KEY);
    const b = await encryptToken("same", KEY);
    expect(a).not.toBe(b);
    expect(await decryptToken(a, KEY)).toBe("same");
    expect(await decryptToken(b, KEY)).toBe("same");
  });

  it("rejects tampered ciphertext", async () => {
    const enc = await encryptToken("secret", KEY);
    const bytes = Uint8Array.from(atob(enc), (ch) => ch.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff; // flip a tag bit
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decryptToken(tampered, KEY)).rejects.toThrow();
  });

  it("rejects decryption with the wrong key", async () => {
    const enc = await encryptToken("secret", KEY);
    await expect(decryptToken(enc, OTHER_KEY)).rejects.toThrow();
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encryptToken("x", btoa("short"))).rejects.toThrow(/32 bytes/);
  });

  it("rejects too-short ciphertext", async () => {
    await expect(decryptToken(btoa("tiny"), KEY)).rejects.toThrow();
  });
});

describe("OAuth state signing (HMAC-SHA256)", () => {
  it("generates 32-byte hex state ids", () => {
    const id = generateStateId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(generateStateId()).not.toBe(id);
  });

  it("signs and verifies a state", async () => {
    const id = generateStateId();
    const state = await signState(id, SIGNING);
    expect(state.startsWith(`${id}.`)).toBe(true);
    expect(await verifyState(state, SIGNING)).toBe(id);
  });

  it("rejects a forged signature", async () => {
    const id = generateStateId();
    expect(await verifyState(`${id}.${"0".repeat(64)}`, SIGNING)).toBeNull();
  });

  it("rejects a swapped id with a valid signature for another id", async () => {
    const state = await signState(generateStateId(), SIGNING);
    const sig = state.split(".")[1];
    expect(await verifyState(`${generateStateId()}.${sig}`, SIGNING)).toBeNull();
  });

  it("rejects malformed states", async () => {
    for (const bad of ["", "nodot", ".sigonly", "idonly.", "a.b.c"]) {
      expect(await verifyState(bad, SIGNING), bad).toBeNull();
    }
  });

  it("rejects verification with a different signing key", async () => {
    const id = generateStateId();
    const state = await signState(id, SIGNING);
    expect(await verifyState(state, "other-key")).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("compares correctly", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
