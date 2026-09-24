const nodemailer = require("nodemailer");

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const SYSTEM_USER_EMAIL = process.env.SYSTEM_USER_EMAIL;
const SYSTEM_USER_PASSWORD = process.env.SYSTEM_USER_PASSWORD;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const RUN_MODE = process.env.RUN_MODE || "full";

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

// ---------- date helpers ----------

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((startOfDay(a) - startOfDay(b)) / msPerDay);
}

function dateKey(date) {
  // Calendar-day key, ignoring time-of-day, so existence checks aren't
  // thrown off by small time differences between how the React app and
  // this script construct due_date timestamps.
  const d = startOfDay(date);
  return d.toISOString().slice(0, 10);
}

// Saturday -> Friday, Sunday -> Friday. Matches the app's 5-day work week.
function shiftToFridayIfWeekend(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 6) d.setDate(d.getDate() - 1);
  else if (day === 0) d.setDate(d.getDate() - 2);
  return d;
}

function addMonthsClamped(baseDate, monthsToAdd, targetDay) {
  const year = baseDate.getFullYear();
  const month0 = baseDate.getMonth();
  const totalMonths = month0 + monthsToAdd;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const clampedDay = Math.min(targetDay, daysInTargetMonth);
  return new Date(targetYear, targetMonth, clampedDay);
}

// ---------- Firestore REST helpers ----------

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

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  throw new Error(`Unsupported value type for Firestore write: ${v}`);
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const key of Object.keys(obj)) {
    fields[key] = toFirestoreValue(obj[key]);
  }
  return { fields };
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

async function createDoc(idToken, collection, dataObj) {
  const res = await fetch(`${FIRESTORE_BASE}/${collection}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(toFirestoreFields(dataObj)),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Failed to create task doc: ${JSON.stringify(data)}`);
    return null;
  }
  return data;
}

// ---------- recurrence generation ----------

// Given a template and the set of due-date day-keys that already have a
// task instance, figures out which cycles (up to and including the first
// one that is today-or-future) are missing, and returns their due dates.
function computeMissingCycles(template, existingDateKeys, today) {
  const missing = [];

  function walkFixedPeriod(anchor, addFn) {
    let cursor = new Date(anchor);
    // Safety cap: never walk more than 500 cycles back, in case of a
    // very old anchor with a tight period (e.g. daily) — avoids a
    // runaway loop if something is misconfigured.
    for (let i = 0; i < 500; i++) {
      const shifted = shiftToFridayIfWeekend(cursor);
      const key = dateKey(shifted);
      if (!existingDateKeys.has(key)) {
        missing.push({ dueDate: shifted, key });
      }
      if (daysBetween(shifted, today) >= 0) {
        // This cycle is today or in the future — stop after this one.
        break;
      }
      if (i === 499) {
        console.warn(
          `Safety cap hit while walking cycles for template — this likely means a bug or bad anchor_date. Stopped at ${key}.`
        );
      }
      cursor = addFn(cursor);
    }
  }

  if (template.frequency === "daily") {
    walkFixedPeriod(template.anchor_date, (d) => {
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      return next;
    });
  } else if (template.frequency === "weekly") {
    walkFixedPeriod(template.anchor_date, (d) => {
      const next = new Date(d);
      next.setDate(next.getDate() + 7);
      return next;
    });
  } else if (template.frequency === "monthly") {
    const anchorDay = new Date(template.anchor_date).getDate();
    walkFixedPeriod(template.anchor_date, (d) => addMonthsClamped(d, 1, anchorDay));
  } else if (template.frequency === "quarterly") {
    const anchorDay = new Date(template.anchor_date).getDate();
    walkFixedPeriod(template.anchor_date, (d) => addMonthsClamped(d, 3, anchorDay));
  } else if (template.frequency === "yearly") {
    const anchorDay = new Date(template.anchor_date).getDate();
    walkFixedPeriod(template.anchor_date, (d) => addMonthsClamped(d, 12, anchorDay));
  } else if (template.frequency === "semi_monthly") {
    // Simplified vs. a full historical walk: generates this month's and
    // (if needed) next month's occurrence for each anchor day. This
    // covers the current cycle reliably; it does not backfill deep
    // historical gaps for semi-monthly templates the way the other
    // frequencies do, since no starting year/month is stored for this
    // frequency type in the schema.
    for (const anchorDayField of ["anchor_day_1", "anchor_day_2"]) {
      const anchorDay = template[anchorDayField];
      if (!anchorDay) continue;
      for (const monthOffset of [0, 1]) {
        const base = addMonthsClamped(today, monthOffset, anchorDay);
        const shifted = shiftToFridayIfWeekend(base);
        const key = dateKey(shifted);
        if (daysBetween(shifted, today) <= 0 && !existingDateKeys.has(key)) {
          missing.push({ dueDate: shifted, key });
        }
      }
    }
  }

  return missing;
}

async function generateMissingTaskInstances(idToken, today) {
  const templates = await runQuery(idToken, {
    from: [{ collectionId: "task_templates" }],
    where: { fieldFilter: { field: { fieldPath: "active" }, op: "EQUAL", value: { booleanValue: true } } },
  });

  let created = 0;

  for (const template of templates) {
    const existingTasks = await runQuery(idToken, {
      from: [{ collectionId: "tasks" }],
      where: { fieldFilter: { field: { fieldPath: "template_id" }, op: "EQUAL", value: { stringValue: template.id } } },
    });
    const existingDateKeys = new Set(
      existingTasks.filter((t) => t.due_date).map((t) => dateKey(new Date(t.due_date)))
    );

    const missingCycles = computeMissingCycles(template, existingDateKeys, today);

    for (const cycle of missingCycles) {
      await createDoc(idToken, "tasks", {
        client_id: template.client_id,
        template_id: template.id,
        title: template.title,
        description: template.description || "",
        assigned_to: template.assigned_to,
        due_date: cycle.dueDate,
        status: "pending",
        created_by: "system-recurrence",
        created_at: new Date(),
        completed_at: null,
        completed_by: null,
      });
      created++;
      console.log(`Generated task instance for template "${template.title}" due ${cycle.key}`);
    }
  }

  console.log(`Recurrence generation complete. Created ${created} task instance(s).`);
}

// ---------- email sending ----------

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({ from: `"Anav Task Manager" <${GMAIL_USER}>`, to, subject, html });
    console.log(`Sent email to ${to}: ${subject}`);
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err.message);
  }
}

async function main() {
  const idToken = await signIn();
  const today = new Date();

  await generateMissingTaskInstances(idToken, today);

  const pendingTasks = await runQuery(idToken, {
    from: [{ collectionId: "tasks" }],
    where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
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
    if (RUN_MODE === "escalation-only" && diff >= 0) continue;

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

  console.log(
    `Run complete (mode: ${RUN_MODE}). Reminders sent: ${remindersSent}. Manager escalations sent: ${escalationsSent}.`
  );
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
