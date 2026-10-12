// `deno test -A --ext js relay_test.js`. The relay's address handling against fake sockets
// in a temp dir is not possible (SOCKS is fixed), so the rewrite and the checks run pure,
// and one delivery runs against a real socket in SOCKS. The live round trip between two
// daemons was run by hand (CLAUDE.md).

import {deliverable, Relay, relayName, SOCKS, standInPid} from "./relay.js";
import {ownHost, tailnetOrLocal} from "./server.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

Deno.test("standInPid: above any real pid, apart per host, stable", () => {
  const a = standInPid("nadya", 4194303), b = standInPid("marx", 1);
  eq(a > 4194304 && b > 4194304, true, "above pid_max");
  eq(standInPid("nadya", 7), standInPid("nadya", 7), "stable");
  eq(a < 2 ** 31, true, "an int32");
});

Deno.test("deliverable: a socket in SOCKS and nothing else", () => {
  eq(deliverable(`${SOCKS}/123.sock`), true, "a session socket");
  eq(deliverable(relayName("marx", "nadya", "/tmp/cc-socks/9.sock")), true, "a relay socket");
  eq(deliverable(`${SOCKS}/../etc.sock`), false, "a ..");
  eq(deliverable(`${SOCKS}/a/b.sock`), false, "a subdirectory");
  eq(deliverable("/var/run/docker.sock"), false, "elsewhere");
  eq(deliverable("/run/user/1000/cc-socks/5.sock"), true, "Linux's runtime dir");
  eq(deliverable("/run/user/x/cc-socks/5.sock"), false, "a uid that is not a number");
  eq(deliverable(7), false, "not a string");
});

Deno.test("relayName: a reply address Claude Code accepts, one per daemon, host and socket", () => {
  const n = relayName("marx", "nadya", "/run/user/1000/cc-socks/42.sock");
  eq(/^\d+-[0-9a-f]{8}\.sock$/.test(n.slice(SOCKS.length + 1)), true, "the shape");
  eq(n === relayName("marx", "nadya", "/run/user/1000/cc-socks/43.sock"), false, "per socket");
  eq(n === relayName("lenin", "nadya", "/run/user/1000/cc-socks/42.sock"), false, "per daemon");
  eq(n, relayName("marx", "nadya", "/run/user/1000/cc-socks/42.sock"), "stable");
});

Deno.test("Relay.rewrite: every remote uds becomes our relay socket for it", () => {
  const r = new Relay("marx", () => null);
  const links = [];
  r.link = (host, sock) => (links.push([host, sock]), relayName("marx", host, sock));
  const line = JSON.stringify({from: "uds:/tmp/cc-socks/42.sock", message: {content:
    '<cross-session-message from="uds:/tmp/cc-socks/42.sock" from-name="x">\nhi\n</cross-session-message>'}});
  const out = JSON.parse(r.rewrite(line, "nadya"));
  const mine = `uds:${relayName("marx", "nadya", "/tmp/cc-socks/42.sock")}`;
  eq(out.from, mine, "top level");
  eq(out.message.content.startsWith(`<cross-session-message from="${mine}" from-name="x">`),
    true, "the envelope, attribute order kept");
  eq(links, [["nadya", "/tmp/cc-socks/42.sock"], ["nadya", "/tmp/cc-socks/42.sock"]], "linked");
});

Deno.test("Relay.deliver: refuses a bad request, writes rewritten lines to the socket", async () => {
  const r = new Relay("marx", () => null);
  eq(await r.deliver({from: "marx", sock: `${SOCKS}/1.sock`, lines: []}), "bad from", "self");
  eq((await r.deliver({from: "n", sock: "/etc/x.sock", lines: []})).startsWith("not a socket"),
    true, "outside SOCKS");
  eq(await r.deliver({from: "n", sock: `${SOCKS}/1.sock`, lines: [1]}), "bad lines", "lines");
  Deno.mkdirSync(SOCKS, {recursive: true, mode: 0o700});
  const path = `${SOCKS}/ccx-test-${Deno.pid}.sock`;
  const l = Deno.listen({transport: "unix", path});
  const got = (async () => {
    const c = await l.accept();
    let s = "";
    for await (const b of c.readable) s += new TextDecoder().decode(b);
    return s;
  })();
  r.link = (host, sock) => relayName("marx", host, sock);
  eq(await r.deliver({from: "n", sock: path, lines: ['{"from":"uds:/tmp/cc-socks/3.sock"}']}),
    null, "delivered");
  eq(await got, `{"from":"uds:${relayName("marx", "n", "/tmp/cc-socks/3.sock")}"}\n`,
    "the line, rewritten");
  l.close();
});

Deno.test("tailnetOrLocal: loopback and the tailnet ranges only", () => {
  for (const a of ["127.0.0.1", "::1", "100.64.0.1", "100.127.255.1", "::ffff:100.100.1.2",
    "fd7a:115c:a1e0::1"]) eq(tailnetOrLocal(a), true, a);
  for (const a of ["100.63.0.1", "100.128.0.1", "192.168.1.2", "10.0.0.1", "fd7a:115c:a1e1::1"]) {
    eq(tailnetOrLocal(a), false, a);
  }
  eq(tailnetOrLocal("172.17.0.5"), false, "a container on a docker bridge");
});

Deno.test("ownHost: our names and addresses on our port, nobody else's name", () => {
  for (const h of ["localhost:7681", "127.0.0.1:7681", "marx:7681", "100.1.2.3:7681",
    "marx.giraffe-yo.ts.net:7681", "[::1]:7681"]) eq(ownHost(h, 7681, "marx"), true, h);
  for (const h of ["evil.com:7681", "marx:80", "localhost", "marx.evil.com:7681",
    "nadya:7681", "xmarx.giraffe-yo.ts.net:7681"]) eq(ownHost(h, 7681, "marx"), false, h);
});
