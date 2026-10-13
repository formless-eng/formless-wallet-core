import { describe, expect, it, jest } from "@jest/globals";
import {
  FormlessRPCClient,
  makeFormlessRPCRequest,
} from "../lib/FormlessRPCClient";

function jsonResponse(status: number, body?: unknown) {
  return {
    status,
    statusText: `status ${status}`,
    json: async () => body,
  } as Response;
}

describe("makeFormlessRPCRequest", () => {
  it("authorizes requests with an unidentified JWT", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = jest.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      bodies.push(body);
      return jsonResponse(200, {
        result:
          body.method === "create_unidentified_share_jwt"
            ? { token: "jwt" }
            : { ok: true },
      });
    }) as unknown as typeof fetch;
    const request = makeFormlessRPCRequest({
      endpoint: "https://rpc.test/v1",
      fetchFn,
    });

    await expect(
      request("unique_id_fetch_data", { unique_id: "u1" }, 1)
    ).resolves.toEqual({ ok: true });
    expect(bodies.map((body) => body.method)).toEqual([
      "create_unidentified_share_jwt",
      "unique_id_fetch_data",
    ]);
    expect(bodies[1].params).toEqual({
      unique_id: "u1",
      share_unidentified_jwt: "jwt",
    });
  });

  it("retries server errors but not JSON-RPC errors", async () => {
    let calls = 0;
    const fetchFn = jest.fn(async (_url: unknown, init: unknown) => {
      const { method } = JSON.parse((init as { body: string }).body);
      if (method === "create_unidentified_share_jwt") {
        return jsonResponse(200, { result: { token: "jwt" } });
      }
      calls++;
      if (method === "flaky" && calls === 1) {
        return jsonResponse(503);
      }
      if (method === "failing") {
        return jsonResponse(200, { error: { message: "nope" } });
      }
      return jsonResponse(200, { result: "ok" });
    }) as unknown as typeof fetch;
    const request = makeFormlessRPCRequest({
      endpoint: "https://rpc.test/v1",
      fetchFn,
      retryDelayMs: 0,
    });

    await expect(request("flaky", {}, 2)).resolves.toBe("ok");
    calls = 0;
    await expect(request("failing", {}, 5)).rejects.toThrow(
      'Service failure with message "nope" for method failing'
    );
    expect(calls).toBe(1);
  });
});

describe("FormlessRPCClient", () => {
  it("caches RPC endpoints, but not failures", async () => {
    let attempt = 0;
    const request = jest.fn(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error("unavailable");
      }
      return { rpc_endpoint: "https://base.test" };
    });
    const client = new FormlessRPCClient(request);

    await expect(client.getRPCEndpoint(8453)).rejects.toThrow();
    await expect(client.getRPCEndpoint(8453)).resolves.toBe(
      "https://base.test"
    );
    await expect(client.getRPCEndpoint(8453)).resolves.toBe(
      "https://base.test"
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("only sends the unique_id_provision parameters provided", async () => {
    const request = jest.fn(async () => ({ unique_id: "u1" }));
    const client = new FormlessRPCClient(request);

    await client.uniqueIDProvision("a@b.c", undefined, "0xabc");
    expect(request).toHaveBeenCalledWith(
      "unique_id_provision",
      { email_address: "a@b.c", primary_wallet_address: "0xabc" },
      10
    );
  });
});
