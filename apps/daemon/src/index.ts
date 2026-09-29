import { createServer } from "node:http";
import { runTask } from "@lattice/core";

const port = Number(process.env.LATTICE_PORT ?? 4774);

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "lattice" }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/tasks") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const input = JSON.parse(body) as { task?: string; cwd?: string };
      const result = await runTask(input.task ?? "", { cwd: input.cwd });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Lattice daemon listening on http://127.0.0.1:${port}`);
});
