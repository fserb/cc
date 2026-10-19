// cc's web-only support functions (cchost keeps the session work). Served at /cc/api/.
//   GET grep?q=<text>   live grep over ~/nadya, as the files tab shows it: no dotfiles, no tmp/; {q, files: [{file, n, name}], hits}
//   GET recent          the 10 files of ~/nadya changed last, the same ones left out: [{file, at (ms)}]
//   GET docs?dir=~/ai/x   a project dir on this host: its docs (*.md, and what is under docs/, mocks/, research/), names only
//   GET doc?path=         one of those, as text. Each takes host=marx: then over ssh
//   GET inbox             the inbox, newest first: [{id, title, url, by, at (ms), read, mock?}]; new mocks are added to it first
//   POST inbox {title, url, by?}   post one (a mock, a report): {id}. by defaults to the posting machine. A url already
//                                  there is that item again, unread and on top
//   POST inbox/read {id} | inbox/clear {id}   mark one opened, or take it out (id "read": every opened one)
//   POST screen {w, h, dpr, coarse, ua}   what a device's cc measured, once per size: ~/nadya/tmp/cc-screens.jsonl (50 kept)
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

// every ~/web/<x>/mocks/*.html changed in the last 2 days, newest first: [{url, dir, name, at (ms)}]. ~/web/<x> is served
// at /<x>/ on this host. They go into the inbox (user, Oct 19th: "we probably want mocks and researchs together in inbox")
async function mocks() {
  const ls = await sh(`find ~/web/*/mocks/ -maxdepth 1 -name '*.html' -mmin -2880 -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -n 40`);
  return ls.map((l) => {
    const [at, ...p] = l.split(" "), path = p.join(" ").replace(/^.*?\/web\//, "");
    return {url: `/${path}`, dir: path.split("/")[0], name: path.split("/").at(-1).replace(/\.html$/, ""), at: Math.round(+at * 1000)};
  });
}

// the inbox (user, Oct 19th: "update section that contained posted mocks/researches links", "like an inbox"): what nadya
// and the sessions post for the user to look at, in ~/nadya/tmp/inbox.jsonl, one JSON object a line, oldest first, 100 kept.
// url is a link, or a path the files tab opens (`research/x.md` in ~/nadya, `~/web/x/mocks/y.html`, `marx:~/web/...`)
const INBOX = "~/nadya/tmp/inbox.jsonl";
async function inboxRead() {
  return (await sh(`cat ${INBOX} 2>/dev/null`)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .map((x) => ({...x, url: oneUrl(x.url)}));
}
// one form per place, so the same page posted twice is one item: this host's full URL as a path (/nadya/x.html), and an
// .html under ~/web as the page it serves (nadya's /x/y.html, marx's https://marx.gum.ts.net/x/y.html)
function oneUrl(u = "") {
  return u.replace(/^https:\/\/nadya(\.gum\.ts\.net)?(?=\/)/, "")
    .replace(/^(marx:)?(~|\/(home|Users)\/fserb)\/web(\/.*\.html?)$/, (_, m, _h, _u, p) => m ? `https://marx.gum.ts.net${p}` : p);
}
// a mock changed since the inbox last took it is an item: a new one, or its own again, unread and on top. inbox-mocks.json
// keeps url -> the time taken, so a cleared mock stays out until it changes. The first run only notes what is there
const MOCKS = "~/nadya/tmp/inbox-mocks.json";
async function inboxMocks() {
  const [ms, seen] = await Promise.all([mocks(), sh(`cat ${MOCKS} 2>/dev/null`).then((l) => JSON.parse(l.join("") || "null")).catch(() => null)]);
  const fresh = ms.filter((m) => m.at > (seen?.[m.url] ?? 0));
  if (seen && fresh.length) await inboxEdit((all) => {
    for (const m of fresh.reverse()) {
      const x = all.find((y) => y.url === m.url);
      if (x && x.at >= m.at) continue;  // posted after its last change
      if (x) all.splice(all.indexOf(x), 1);
      all.push({...x ?? {id: newId(), title: m.name, by: `${m.dir} mocks`, mock: true}, url: m.url, at: m.at, read: false});
    }
  });
  if (!seen || fresh.length) await write(MOCKS, JSON.stringify(Object.fromEntries(ms.map((m) => [m.url, m.at]))));
}
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function write(f, text) {
  const p = new Deno.Command("host", {args: [`cat > ${f}.tmp && mv ${f}.tmp ${f}`], stdin: "piped", stdout: "null", stderr: "null"}).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(text));
  await w.close();
  await p.status;
}
// writes go one at a time; the text goes on stdin, never into the shell string
let inboxQ = Promise.resolve();
function inboxEdit(f) {
  const run = inboxQ.then(async () => {
    const all = await inboxRead(), out = f(all);
    await write(INBOX, all.slice(-100).map((x) => `${JSON.stringify(x)}\n`).join(""));
    return out;
  });
  inboxQ = run.catch(() => {});
  return run;
}
async function post(req) {
  const b = await req.json().catch(() => ({}));
  if (req.subpath === "/inbox") {
    const title = `${b.title ?? ""}`.trim().slice(0, 200), url = oneUrl(`${b.url ?? ""}`.trim().slice(0, 1000));
    if (!title && !url) return new Response("title or url", {status: 400});
    const by = `${b.by ?? ""}`.trim().slice(0, 40) || (await req.whois().catch(() => null))?.node?.split(".")[0] || "?";
    const name = title || url.replace(/\/+$/, "").split("/").at(-1).replace(/\.(html?|md)$/, "");
    // the same url again (nadya publishing what a helper posted, a new round in place) is that item, not a second one
    return await inboxEdit((all) => {
      const x = url && all.find((y) => y.url === url);
      if (x) all.splice(all.indexOf(x), 1);
      const id = x?.id ?? newId();
      all.push({id, title: name, url, by, at: Date.now(), read: false});
      return {id};
    });
  }
  // the phone's real viewport (nadya, Oct 19th: the Pixel 9 Pro XL's was computed from its screenshots, not measured)
  if (req.subpath === "/screen") {
    const n = (v) => Number.isFinite(+v) ? +v : null;
    const line = {at: Date.now(), node: (await req.whois().catch(() => null))?.node?.split(".")[0] ?? "?", w: n(b.w), h: n(b.h),
      dpr: n(b.dpr), coarse: !!b.coarse, ua: `${b.ua ?? ""}`.slice(0, 300)};
    const f = "~/nadya/tmp/cc-screens.jsonl";
    const p = new Deno.Command("host", {args: [`{ tail -n 49 ${f} 2>/dev/null; cat; } > ${f}.tmp && mv ${f}.tmp ${f}`], stdin: "piped", stdout: "null", stderr: "null"}).spawn();
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    await w.close();
    await p.status;
    return {ok: true};
  }
  if (req.subpath === "/inbox/read") return await inboxEdit((all) => { for (const x of all) if (x.id === b.id) x.read = true; return {ok: true}; });
  if (req.subpath === "/inbox/clear") return await inboxEdit((all) => {
    const keep = all.filter((x) => b.id === "read" ? !x.read : x.id !== b.id);
    all.splice(0, all.length, ...keep);
    return {ok: true};
  });
  return Response.HTTP_NOT_FOUND;
}

async function get(req) {
  if (req.subpath === "/inbox") { await inboxMocks().catch(() => {}); return (await inboxRead()).reverse().sort((a, b) => b.at - a.at); }
  if (req.subpath === "/recent") return await recent();
  const host = req.url.searchParams.get("host") === "marx" ? "marx" : "nadya";
  if (req.subpath === "/doc") return await doc(host, req.url.searchParams.get("path") ?? "");
  if (req.subpath === "/docs") {
    const dir = req.url.searchParams.get("dir") ?? "";
    if (!DIR.test(dir) || dir.includes("..")) return new Response("bad dir", {status: 400});
    return await docs(host, dir);
  }

  if (req.subpath !== "/grep") return Response.HTTP_NOT_FOUND;
  const q = (req.url.searchParams.get("q") ?? "").replace(/[\r\n]+/g, " ").trim();
  if (q.length < 2) return {q, files: [], hits: []};
  return await grep(q);
}

await Lemon(get, post);
