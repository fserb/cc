// cc's web-only support functions (cchost keeps the session work). Served at /cc/api/.
//   GET grep?q=<text>   live grep over ~/nadya, as the files tab shows it: no dotfiles, no tmp/; {q, files: [{file, n, name}], hits}
//   GET recent          the 10 files of ~/nadya changed last, the same ones left out: [{file, at (ms)}]
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

async function get(req) {
  if (req.subpath === "/recent") return await recent();
  if (req.subpath !== "/grep") return Response.HTTP_NOT_FOUND;
  const q = (req.url.searchParams.get("q") ?? "").replace(/[\r\n]+/g, " ").trim();
  if (q.length < 2) return {q, files: [], hits: []};
  return await grep(q);
}

await Lemon(get);
