import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

const { default: app } = await import("../src/index.js");
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  process.stdout.write(`plutus listening on http://localhost:${port}\n`);
});
