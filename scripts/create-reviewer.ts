// Create a named reviewer/operator. The token is printed ONCE and only its hash is stored.
// Usage: npx tsx --env-file=.env --env-file=.env.local scripts/create-reviewer.ts "Name" operator|reviewer|admin
// Note: as soon as ONE reviewer exists, the shared demo passcode stops working everywhere.
import { createReviewer, ensureSchema, type Role } from "../src/lib/db";

async function main() {
  const [name, role] = process.argv.slice(2);
  if (!name || !["operator", "reviewer", "admin"].includes(role)) {
    console.error('usage: create-reviewer.ts "Name" operator|reviewer|admin');
    process.exit(1);
  }
  await ensureSchema();
  const { id, token } = await createReviewer(name, role as Role);
  console.log(`created ${role} "${name}" (${id})`);
  console.log(`TOKEN (shown once, store it safely): ${token}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
