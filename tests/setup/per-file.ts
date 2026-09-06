import { afterAll } from "vitest";
import { closeTestPool } from "../helpers/db.js";

afterAll(async () => {
  await closeTestPool();
});
