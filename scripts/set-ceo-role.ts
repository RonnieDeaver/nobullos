import { db } from "../server/db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";

const EMAIL = "admin@nobullmarketing.com";

async function setCeoRole() {
  console.log(`Setting CEO role for: ${EMAIL}`);
  
  const result = await db
    .update(users)
    .set({ role: "ceo" })
    .where(eq(users.email, EMAIL))
    .returning();
  
  if (result.length > 0) {
    console.log("Success! Updated to CEO role.");
  } else {
    console.log("No user found with that email. Checking all users...");
    const allUsers = await db.select().from(users);
    console.log("Users in database:", allUsers.map(u => ({ id: u.id, email: u.email, role: u.role })));
  }
}

setCeoRole().catch(console.error);
