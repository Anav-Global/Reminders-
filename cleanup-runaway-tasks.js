// ONE-TIME CLEANUP: deletes task instances that were wrongly created by
// the runaway-loop bug (auto-generated tasks with due dates far in the
// future, up to year 2050+). Run this once, then discard this script —
// it is not part of the regular reminder workflow.

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const SYSTEM_USER_EMAIL = process.env.SYSTEM_USER_EMAIL;
const SYSTEM_USER_PASSWORD = process.env.SYSTEM_USER_PASSWORD;

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// Anything auto-generated with a due date more than this many days out is
// almost certainly bogus — the generator is only ever supposed to create
// one upcoming cycle at a time, never dozens of years ahead.
const SAFE_HORIZON_DAYS = 60;

async function signIn() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: SYSTEM_USER_EMAIL,
        password: SYSTEM_USER_PASSWORD,
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Sign-in failed: ${JSON.stringify(data)}`);
  return data.idToken;
}

function parseFirestoreFields(fields) {
  const out = {};
  if (!fields) return out;
  for (const key of Object.keys(fields)) {
    const val = fields[key];
    if (val.stringValue !== undefined) out[key] = val.stringValue;
    else if (val.timestampValue !== undefined) out[key] = new Date(val.timestampValue);
    else out[key] = null;
  }
  return out;
}

async function runQuery(idToken, structuredQuery) {
  const res = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Query failed: ${JSON.stringify(data)}`);
  return data
    .filter((row) => row.document)
    .map((row) => ({ id: row.document.name.split("/").pop(), ...parseFirestoreFields(row.document.fields) }));
}

async function deleteDoc(idToken, collection, id) {
  const res = await fetch(`${FIRESTORE_BASE}/${collection}/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return res.ok;
}

async function main() {
  const idToken = await signIn();
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + SAFE_HORIZON_DAYS);

  const systemGenerated = await runQuery(idToken, {
    from: [{ collectionId: "tasks" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "created_by" },
        op: "EQUAL",
        value: { stringValue: "system-recurrence" },
      },
    },
  });

  const toDelete = systemGenerated.filter((t) => t.due_date && new Date(t.due_date) > cutoff);

  console.log(`Found ${systemGenerated.length} system-generated tasks total.`);
  console.log(`${toDelete.length} of them have a due date beyond ${cutoff.toDateString()} — deleting these.`);

  let deleted = 0;
  for (const task of toDelete) {
    const ok = await deleteDoc(idToken, "tasks", task.id);
    if (ok) {
      deleted++;
    } else {
      console.error(`Failed to delete task ${task.id}`);
    }
  }

  console.log(`Cleanup complete. Deleted ${deleted} bogus future task instance(s).`);
}

main().catch((err) => {
  console.error("Cleanup script failed:", err);
  process.exit(1);
});
