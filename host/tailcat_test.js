import {parseLinks, resolveArgs, Tailcat} from "./tailcat.js";

const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
};
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

Deno.test("tailcat: links and their arguments", () => {
  eq(parseLinks("engels: forward @~/a/engels.addr 7691 2222:22; x: serve 1"), [{
    name: "engels",
    args: ["forward", "@~/a/engels.addr", "7691", "2222:22"],
  }, {name: "x", args: ["serve", "1"]}], "parsed");
  eq(parseLinks(""), [], "none");
  let threw = false;
  try {
    parseLinks("forward x");
  } catch {
    threw = true;
  }
  eq(threw, true, "no name");
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${dir}/addr`, "tcADDR\n");
  eq(resolveArgs(["forward", "--key=~/k.json", `@${dir}/addr`, "7691"], "/h"), [
    ["forward", "--key=/h/k.json", "tcADDR", "7691"],
  ], "~ and @file");
  eq(
    resolveArgs(["forward", "@~/missing"], dir),
    [null, "no ~/missing"],
    "a file not there yet",
  );
});

Deno.test("tailcat: an exit is restarted, a forward to a host down a minute is killed", async () => {
  const dir = Deno.makeTempDirSync(), bin = `${dir}/tailcat`;
  Deno.writeTextFileSync(
    bin,
    `#!/bin/sh\necho "# forwarding x, address: tc${"x".repeat(60)}" >&2\nexec sleep 30\n`,
  );
  Deno.chmodSync(bin, 0o755);
  let down = null;
  const t = new Tailcat(parseLinks("engels: forward 7691"), () => down, bin);
  t.start();
  await wait(300);
  let [s] = t.state();
  eq(
    [s.state, s.line, s.restarts],
    ["running", "forwarding x, address: tc…", 0],
    "running, the address hidden",
  );
  const pid = s.pid;
  down = "refused";
  t.check(Date.now());
  t.check(Date.now() + 61_000);
  eq(t.state()[0].pid, pid, "not before the forward ran a minute");
  t.links[0].since -= 61_000;
  t.check(Date.now() + 61_000);
  await wait(300);
  [s] = t.state();
  eq([s.state, s.restarts], ["exited", 1], "killed");
  t.stop();
});
