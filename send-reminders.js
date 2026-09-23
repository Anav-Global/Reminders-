const nodemailer = require("nodemailer");

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const SYSTEM_USER_EMAIL = process.env.SYSTEM_USER_EMAIL;
const SYSTEM_USER_PASSWORD = process.env.SYSTEM_USER_PASSWORD;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((startOfDay(a) - startOfDay(b)) / msPerDay);
}

function parseFirestoreFields(fields) {
  const out = {};
  if (!fields) return out;
  for (const key of Object.keys(fields)) {
    const val = fields[key];
    if (val.stringValue !== undefined) out[key] = val.stringValue;
    else if (val.integerValue !== undefined) out[key] = parseInt(val.integerValue, 10);
    else if (val.doubleValue !== undefined) out[key] = val.doubleValue;
    else if (val.booleanValue !== undefined) out[key] = val.booleanValue;
    else if (val.nullValue !== undefined) out[key] = null;
    else if (val.timestampValue !== undefined) out[key] = new Date(val.timestampValue);
    else if (val.arrayValue !== undefined) {
      out[key] = (val.arrayValue.values || []).map((v) => (v.stringValue !== undefined ? v.stringValue : v));
    } else out[key] = null;
  }
  return out;
}

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

async function getDoc(idToken, collection, id) {
  const res = await fetch(`${FIRESTORE_BASE}/${collection}/${id}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return parseFirestoreFields(data.fields);
}

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"Anav Task Manager" <${GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`Sent email to ${to}: ${subject}`);
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err.message);
  }
}

async function main() {
  const idToken = await signIn();
  const today = new Date();

  const pendingTasks = await runQuery(idToken, {
    from: [{ collectionId: "tasks" }],
    where: {
      fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } },
    },
  });

  if (pendingTasks.length === 0) {
    console.log("No pending tasks found.");
    return;
  }

  const managers = await runQuery(idToken, {
    from: [{ collectionId: "users" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "role" },
        op: "IN",
        value: { arrayValue: { values: [{ stringValue: "tl" }, { stringValue: "manager" }] } },
      },
    },
  });
  const managerEmails = managers.map((m) => m.email).filter(Boolean);

  const userCache = new Map();
  const clientCache = new Map();

  async function getUser(uid) {
    if (!uid) return null;
    if (userCache.has(uid)) return userCache.get(uid);
    const data = await getDoc(idToken, "users", uid);
    userCache.set(uid, data);
    return data;
  }

  async function getClientName(clientId) {
    if (!clientId) return "Unknown Client";
    if (clientCache.has(clientId)) return clientCache.get(clientId);
    const data = await getDoc(idToken, "clients", clientId);
    const name = data ? data.name : "Unknown Client";
    clientCache.set(clientId, name);
    return name;
  }

  let remindersSent = 0;
  let escalationsSent = 0;

  for (const task of pendingTasks) {
    if (!task.due_date || !task.assigned_to) continue;

    const dueDate = new Date(task.due_date);
    const diff = daysBetween(dueDate, today);
    if (diff > 3) continue;

    const assignee = await getUser(task.assigned_to);
    if (!assignee || !assignee.email) {
      console.warn(`Task ${task.id} has no resolvable assignee email, skipping.`);
      continue;
    }

    const clientName = await getClientName(task.client_id);

    const statusLine =
      diff < 0
        ? `<strong style="color:#b91c1c;">Overdue by ${Math.abs(diff)} day(s)</strong>`
        : diff === 0
        ? `<strong style="color:#b45309;">Due today</strong>`
        : `Due in ${diff} day(s)`;

    const html = `
      <p>Hi ${assignee.name || "there"},</p>
      <p>This is a reminder about a task assigned to you:</p>
      <ul>
        <li><strong>Task:</strong> ${task.title}</li>
        <li><strong>Client:</strong> ${clientName}</li>
        <li><strong>Due date:</strong> ${dueDate.toDateString()}</li>
        <li>${statusLine}</li>
      </ul>
      <p>Please complete it in the dashboard and mark it done, or add a comment explaining any delay.</p>
    `;

    await sendEmail(
      assignee.email,
      diff < 0 ? `Overdue: ${task.title}` : `Reminder: ${task.title} due soon`,
      html
    );
    remindersSent++;

    if (diff < 0 && managerEmails.length > 0) {
      const escalationHtml = `
        <p>The following task assigned to <strong>${assignee.name || assignee.email}</strong> is overdue:</p>
        <ul>
          <li><strong>Task:</strong> ${task.title}</li>
          <li><strong>Client:</strong> ${clientName}</li>
          <li><strong>Due date:</strong> ${dueDate.toDateString()}</li>
          <li><strong>Overdue by:</strong> ${Math.abs(diff)} day(s)</li>
        </ul>
      `;
      for (const mgrEmail of managerEmails) {
        await sendEmail(mgrEmail, `Overdue task: ${task.title}`, escalationHtml);
        escalationsSent++;
      }
    }
  }

  console.log(`Run complete. Reminders sent: ${remindersSent}. Manager escalations sent: ${escalationsSent}.`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
