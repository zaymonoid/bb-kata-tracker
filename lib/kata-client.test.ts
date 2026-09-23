// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import { addressFromStatus, parseAddress } from "./kata-client.ts";

test("parseAddress: unix sockets and http(s) base URLs", () => {
  assert.deepEqual(parseAddress("unix:///tmp/k/daemon.sock"), { kind: "unix", socketPath: "/tmp/k/daemon.sock" });
  assert.deepEqual(parseAddress("http://127.0.0.1:7777/"), { kind: "tcp", baseUrl: "http://127.0.0.1:7777" });
  assert.equal(parseAddress("unix://"), null);
  assert.equal(parseAddress("127.0.0.1:7777"), null);
});

test("addressFromStatus: the first running daemon, never a guess", () => {
  const running = JSON.stringify({
    kata_api_version: 1,
    daemons: [{ pid: 1, address: "unix:///var/k/daemon.sock", web_url: "http://127.0.0.1:1" }],
  });
  assert.deepEqual(addressFromStatus(running), { kind: "unix", socketPath: "/var/k/daemon.sock" });
  assert.deepEqual(
    addressFromStatus(JSON.stringify({ daemons: [{ address: 7 }, { address: "http://h:1" }] })),
    { kind: "tcp", baseUrl: "http://h:1" },
  );
  assert.equal(addressFromStatus(JSON.stringify({ kata_api_version: 1, daemons: [] })), null);
  assert.equal(addressFromStatus(JSON.stringify({ daemons: null })), null);
  assert.equal(addressFromStatus("kata: no daemon"), null);
});
