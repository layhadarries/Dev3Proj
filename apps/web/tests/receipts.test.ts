import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../lib/client/api";
import { submissionOutcome } from "../lib/client/flow";
import { clearReceipt, loadReceipt, saveReceipt, type ReceiptStorage } from "../lib/client/receipts";

const memory = (): ReceiptStorage => {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};
const first = "2".repeat(88);
const second = "3".repeat(88);

describe("unsettled receipts", () => {
  it("survives a reload, for the same wallet only", () => {
    const storage = memory();
    saveReceipt(storage, "alice", first);
    expect(loadReceipt(storage, "alice")).toBe(first);
    expect(loadReceipt(storage, "bob")).toBeUndefined();
  });
  it("clears only the receipt that was settled", () => {
    const storage = memory();
    saveReceipt(storage, "alice", second);
    clearReceipt(storage, "alice", first);
    expect(loadReceipt(storage, "alice")).toBe(second);
    clearReceipt(storage, "alice", second);
    expect(loadReceipt(storage, "alice")).toBeUndefined();
  });
  it("ignores stored text that is not a signature", () => {
    const storage = memory();
    saveReceipt(storage, "alice", "javascript:alert(1)");
    expect(loadReceipt(storage, "alice")).toBeUndefined();
  });
  it("tolerates missing or blocked storage", () => {
    const blocked: ReceiptStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    for (const storage of [blocked, undefined]) {
      expect(() => saveReceipt(storage, "alice", first)).not.toThrow();
      expect(loadReceipt(storage, "alice")).toBeUndefined();
      expect(() => clearReceipt(storage, "alice", first)).not.toThrow();
    }
  });
});

describe("what counts as not sent", () => {
  const reply = (status: number, body: string) =>
    createApi((async () => new Response(body, { status })) as typeof fetch)("submit", {}).catch((e: unknown) => e);

  it.each([
    [408, '{"error":"Request timed out"}'],
    [404, '{"error":"Not found"}'],
    [409, "<html>proxy</html>"],
    [429, ""],
  ])("keeps HTTP %i with body %j unknown", async (status, body) => {
    expect(submissionOutcome(await reply(status, body))).toBe("unknown");
  });
  it.each([400, 401, 403, 409, 413, 415, 429])("accepts the app's own HTTP %i refusal", async (status) => {
    expect(submissionOutcome(await reply(status, '{"error":"refused"}'))).toBe("not_sent");
    expect(submissionOutcome(new ApiError("refused", status))).toBe("not_sent");
  });
});
