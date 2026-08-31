import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.ts";
import * as schema from "./schema.ts";
import * as projectTagTables from "./project-tags.ts";

export const sql = postgres(env.databaseUrl, { max: 10 });
export const db = drizzle(sql, { schema: { ...schema, ...projectTagTables } });
