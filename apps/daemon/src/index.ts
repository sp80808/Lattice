import { startLatticeServer } from "@lattice/server";

const port = Number(process.env.LATTICE_PORT ?? 4774);
const started = await startLatticeServer({
  port,
  token: process.env.LATTICE_DAEMON_TOKEN || undefined,
});

console.log(`Lattice daemon listening on ${started.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void started.close().finally(() => process.exit(0));
  });
}
