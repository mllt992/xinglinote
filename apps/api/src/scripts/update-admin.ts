import { eq } from "drizzle-orm";
import { hashPassword, validPassword } from "@kb/core";
import { db, sql } from "../db/client.ts";
import { users } from "../db/schema.ts";

const [oldEmail, newEmail, password] = process.argv.slice(2);
if (!oldEmail || !newEmail || !password) {
  console.error("usage: update-admin <old-email> <new-email> <password>");
  process.exit(2);
}
if (!validPassword(password)) {
  console.error("password does not meet policy");
  process.exit(2);
}

const [user] = await db.select().from(users).where(eq(users.email, oldEmail.toLowerCase()));
if (!user) {
  console.error(`user not found: ${oldEmail}`);
  process.exit(1);
}
if (user.roleInstance !== "admin") {
  console.error("target user is not an instance admin");
  process.exit(1);
}

await db
  .update(users)
  .set({
    email: newEmail.toLowerCase(),
    passwordHash: await hashPassword(password),
    emailVerifiedAt: new Date(),
    updatedAt: new Date(),
  })
  .where(eq(users.id, user.id));

await sql.end();
console.log(`updated admin ${user.id}: ${oldEmail} -> ${newEmail}`);
