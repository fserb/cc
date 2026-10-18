// cc's web-only support functions (cchost keeps the session work). Served at /cc/api/.
//   GET grep?q=<text>   live grep over ~/nadya, as the files tab shows it: no dotfiles, no tmp/; {q, files: [{file, n, name}], hits}
//   GET recent          the 10 files of ~/nadya changed last, the same ones left out: [{file, at (ms)}]
//   GET docs?dir=~/ai/x   a project dir on this host: its docs (*.md, and what is under docs/, mocks/, research/), names only
//   GET doc?path=         one of those, as text; log?dir= the dir's last 60 commits. Each takes host=marx: then over ssh
import Lemon from "lemon";

const PER = 10;  // matching lines kept per file
const LINE = 300;  // characters of each kept

// files: every file whose name holds q or whose text does, with n its matching lines; hits: up to PER lines of each.
// Not cut by path order, so the page can put name matches first and then the files with the most hits
async function grep(q) {
  // the query goes on stdin (grep -f -), never into the shell string `host` runs
  const cmd = new Deno.Command("host", {
    args: [`cd ~/nadya && grep -rIniF --exclude-dir=tmp --exclude-dir='.*' --exclude='.*' -f - -- *`],
    stdin: "piped", stdout: "piped", stderr: "piped",
  });
  const p = cmd.spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(`${q}\n`));
  await w.close();
  const [{stdout}, all] = await Promise.all([p.output(), list()]);
  const lines = new TextDecoder().decode(stdout).split("\n").filter(Boolean);
  const lq = q.toLowerCase();
  const files = new Map(), hits = [];
  for (const file of all) if (file.split("/").at(-1).toLowerCase().includes(lq)) files.set(file, {file, n: 0, name: true});
  for (const l of lines) {
    const [, file, line, text] = l.match(/^(.*?):(\d+):(.*)$/) ?? [];
    if (!file) continue;
    const f = files.get(file) ?? files.set(file, {file, n: 0, name: false}).get(file);
    if (++f.n > PER) continue;
    // a long line keeps the part around its first match
    const k = text.toLowerCase().indexOf(lq);
    hits.push({file, line: +line, text: k > LINE - 100 ? `…${text.slice(k - 60, k - 60 + LINE)}` : text.slice(0, LINE)});
  }
  return {q, files: [...files.values()], hits};
}

// every file of ~/nadya, the same ones left out as grep
async function list() {
  const cmd = new Deno.Command("host", {
    args: [`cd ~/nadya && find . -path ./tmp -prune -o -name '.?*' -prune -o -type f -printf '%P\\n'`],
    stdout: "piped", stderr: "piped",
  });
  const {stdout} = await cmd.output();
  return new TextDecoder().decode(stdout).split("\n").filter(Boolean);
}

async function recent() {
  const cmd = new Deno.Command("host", {
    args: [`cd ~/nadya && find . -path ./tmp -prune -o -name '.?*' -prune -o -type f -printf '%T@ %P\\n' | sort -rn | head -n 10`],
    stdout: "piped", stderr: "piped",
  });
  const {stdout} = await cmd.output();
  return new TextDecoder().decode(stdout).split("\n").filter(Boolean).map((l) => {
    const k = l.indexOf(" ");
    return {file: l.slice(k + 1), at: Math.round(+l.slice(0, k) * 1000)};
  });
}

// a project's dir (projects page): ~/ai/<x>, ~/web/<x>, ~/srv/<x>, ~/nadya[/<x>], or on marx ~/prj/<x>, checked by shape
// since it goes into the shell string `host` runs. ~/ai holds keys (credentials.json, apis), so only its docs are read (doc below)
const DIR = /^~\/(ai|web|srv|nadya|prj)(\/[\w.-]+)*$/;
async function sh(cmd) {
  const {stdout} = await new Deno.Command("host", {args: [cmd], stdout: "piped", stderr: "piped"}).output();
  return new TextDecoder().decode(stdout).split("\n").filter(Boolean);
}
// a command on nadya, or on marx over ssh (user, Oct 18th: "allow the server to ssh marx to list/fetch files only").
// marx's half has no ' in it: it goes inside one
const on = (host, cmd) => host === "marx" ? `ssh -o BatchMode=yes -o ConnectTimeout=5 marx '${cmd}'` : cmd;
// what a project writes about itself: *.md anywhere, and every file under docs/, mocks/ or research/, 3 levels down,
// no dotfiles, node_modules or tmp/; newest first, 80: [{file, at (ms), size}]. marx is macOS: no -printf, stat -f
const DOC = /(^|\/)((docs|mocks|research)\/.*\.(md|html?|txt)|[^/]+\.md)$/;
async function docs(host, dir) {
  const find = `cd ${dir} && find . -maxdepth 4 \\( -name ".?*" -o -name node_modules -o -name tmp \\) -prune -o -type f \\( -name "*.md" -o -path "*/docs/*" -o -path "*/mocks/*" -o -path "*/research/*" \\)`;
  const ls = await sh(on(host, `${find} ${host === "marx" ? `-exec stat -f "%m %z %N" {} +` : `-printf "%T@ %s %p\\n"`} | sort -rn`));
  return ls.map((l) => { const [at, size, ...f] = l.split(" "); return {file: f.join(" ").replace(/^\.\//, ""), at: Math.round(+at * 1000), size: +size}; })
    .filter((f) => DOC.test(f.file)).slice(0, 80);
}
// one doc's text: a path made only of [\w./-] (it goes into the shell string too) under a DIR, that DOC matches; under 2 MB
async function doc(host, path) {
  const rel = path.replace(/^~\/(ai|web|srv|nadya|prj)\//, "");
  if (!/^~\/[\w.\/-]+$/.test(path) || /(^|\/)\./.test(rel) || rel === path || !DOC.test(rel)) return new Response("not a doc", {status: 400});
  // base64, since `host` drops blank lines
  const b64 = (await sh(on(host, host === "marx" ? `[ $(stat -f %z ${path}) -lt 2000000 ] && base64 -i ${path}` : `[ $(stat -c %s ${path}) -lt 2000000 ] && base64 ${path}`))).join("");
  return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), {headers: {"content-type": `${/\.html?$/.test(path) ? "text/html" : "text/plain"}; charset=utf-8`}});
}
// its last 60 commits, if it is a git repo: [{h, at (ms), s}]
async function log(host, dir) {
  const ls = await sh(on(host, `git -C ${dir} log -60 --format="%h%x09%ct%x09%s" 2>/dev/null`));
  return ls.map((l) => { const [h, at, ...s] = l.split("\t"); return {h, at: +at * 1000, s: s.join("\t")}; });
}

async function get(req) {
  if (req.subpath === "/recent") return await recent();
  const host = req.url.searchParams.get("host") === "marx" ? "marx" : "nadya";
  if (req.subpath === "/doc") return await doc(host, req.url.searchParams.get("path") ?? "");
  if (req.subpath === "/docs" || req.subpath === "/log") {
    const dir = req.url.searchParams.get("dir") ?? "";
    if (!DIR.test(dir) || dir.includes("..")) return new Response("bad dir", {status: 400});
    return req.subpath === "/docs" ? await docs(host, dir) : await log(host, dir);
  }

  if (req.subpath !== "/grep") return Response.HTTP_NOT_FOUND;
  const q = (req.url.searchParams.get("q") ?? "").replace(/[\r\n]+/g, " ").trim();
  if (q.length < 2) return {q, files: [], hits: []};
  return await grep(q);
}

await Lemon(get);
