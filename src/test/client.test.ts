import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { MollieClient } from "../mollie/client";
import { MollieApiError } from "../mollie/errors";
import { Rejected } from "./support/helpers";
import { IsTcpAddress } from "./stand-in/server";

interface Answer {
  status: number;
  body: string;
}

const READ = { method: "GET", path: "/payments/tr_abcdefghij" } as const;

describe("[mollie] client, on answers Mollie does not document", () => {
  let next: Answer = { status: 200, body: "{}" };
  let server: Server | undefined;
  let client: MollieClient;

  before(async () => {
    const listening = createServer((_message, response) => {
      response.writeHead(next.status);
      response.end(next.body);
    });
    server = listening;
    await new Promise<void>((resolve) =>
      listening.listen(0, "127.0.0.1", resolve),
    );
    const address = listening.address();
    if (!IsTcpAddress(address)) throw new Error("not listening on TCP");
    client = new MollieClient({
      apiKey: "test_client",
      apiUrl: `http://127.0.0.1:${address.port}`,
    });
  });

  after(async () => {
    const listening = server;
    if (!listening) return;
    listening.closeAllConnections();
    await new Promise<void>((resolve) => listening.close(() => resolve()));
  });

  function refusal(answer: Answer): Promise<MollieApiError> {
    next = answer;
    return Rejected(client.request(READ), MollieApiError);
  }

  it("reports a JSON null error body as Mollie's error status", async () => {
    const error = await refusal({ status: 500, body: "null" });
    assert.equal(error.status, 500);
    assert.equal(error.message, "Mollie answered 500");
  });

  it("reads the error fields only when they are text", async () => {
    const error = await refusal({
      status: 422,
      body: '{"title":"Unprocessable Entity","detail":{"x":1},"field":42}',
    });
    assert.equal(error.message, "Unprocessable Entity");
    assert.equal(error.providerCode, "422");
  });

  it("refuses a successful answer that is not JSON", async () => {
    const error = await refusal({ status: 200, body: "<html>x</html>" });
    assert.equal(error.status, 200);
  });

  it("refuses an empty successful answer where a resource is expected", async () => {
    assert.equal((await refusal({ status: 200, body: "" })).status, 200);
    assert.equal((await refusal({ status: 204, body: "" })).status, 204);
  });

  it("carries out a call whose answer has no use: a 204, a 202 or a 200 that echoes what it changed", async () => {
    next = { status: 204, body: "" };
    assert.equal(
      await client.execute({
        method: "DELETE",
        path: "/customers/cst_abcdefghij",
      }),
      undefined,
    );
    next = { status: 202, body: "" };
    assert.equal(
      await client.execute({
        method: "POST",
        path: "/payments/tr_abcdefghij/release-authorization",
        body: {},
      }),
      undefined,
    );
    next = { status: 200, body: '{"resource":"payment"}' };
    assert.equal(
      await client.execute({
        method: "DELETE",
        path: "/payments/tr_abcdefghij",
      }),
      undefined,
    );
    next = { status: 404, body: '{"title":"Not Found"}' };
    const error = await Rejected(
      client.execute({ method: "DELETE", path: "/payments/tr_abcdefghij" }),
      MollieApiError,
    );
    assert.equal(error.isNotFound, true);
  });
});
