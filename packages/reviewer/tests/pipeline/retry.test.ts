import { describe, expect, it, vi } from "vitest";
import { callWithRetry } from "../../src/pipeline/retry.js";

describe("callWithRetry", () => {
  it("returns the result when the call succeeds first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(callWithRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with backoff and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce("ok");

    await expect(callWithRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after max attempts and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(callWithRetry(fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses the configured backoff delays", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      callWithRetry(fn, { attempts: 3, backoffMs: [100, 200, 400] }),
    ).rejects.toThrow();

    // one scheduled delay per retry: 100ms then 200ms
    expect(sleepSpy.mock.calls.filter((c) => c[1] === 100).length).toBeGreaterThan(0);
    expect(sleepSpy.mock.calls.filter((c) => c[1] === 200).length).toBeGreaterThan(0);
    sleepSpy.mockRestore();
  });

  it("does not retry when the error is auth-related (AUTH_FAILED marker)", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("401 invalid api key"), { isAuth: true }));

    await expect(callWithRetry(fn, { isRetryable: (e) => !(e instanceof Error && "isAuth" in e) })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
