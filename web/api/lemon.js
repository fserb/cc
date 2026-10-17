// cc's web-only support functions (cchost keeps the session work). Served at /cc/api/.
//   GET grep?q=<text>   live grep over ~/nadya, as the files tab shows it: no dotfiles, no tmp/
import Lemon from "lemon";

const MAX = 300;  // matching lines
const LINE = 300;  // characters of each kept

async function grep(q) {
  // the query goes on stdin (grep -f -), never into the shell string `host` runs
  const cmd = new Deno.Command("host", {
    args: [`cd ~/nadya && grep -rIniF --exclude-dir=tmp --exclude-dir='.*' --exclude='.*' -f - -- * | head -n ${MAX + 1}`],
    stdin: "piped", stdout: "piped", stderr: "piped",
  });
  const p = cmd.spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(`${q}\n`));
  await w.close();
  const {stdout} = await p.output();
  const lines = new TextDecoder().decode(stdout).split("\n").filter(Boolean);
  const lq = q.toLowerCase();
  const hits = lines.slice(0, MAX).map((l) => {
    const [, file, line, text] = l.match(/^(.*?):(\d+):(.*)$/) ?? [];
    if (!file) return null;
    // a long line keeps the part around its first match
    const k = text.toLowerCase().indexOf(lq);
    return {file, line: +line, text: k > LINE - 100 ? `…${text.slice(k - 60, k - 60 + LINE)}` : text.slice(0, LINE)};
  }).filter(Boolean);
  return {q, hits, more: lines.length > MAX};
}

async function get(req) {
  if (req.subpath !== "/grep") return Response.HTTP_NOT_FOUND;
  const q = (req.url.searchParams.get("q") ?? "").replace(/[\r\n]+/g, " ").trim();
  if (q.length < 2) return {q, hits: [], more: false};
  return await grep(q);
}

await Lemon(get);
