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
  return startOfDay(date).toISOString().slice(0, 10);
}

function shiftToFridayIfWeekend(date) {
  const d = new Date(date);
  const day = d.getDay();
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
  for (const key of Object.keys(obj)) fields[key] = toFirestoreValue(obj[key]);
  return { fields };
}

async function signIn() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SYSTEM_USER_EMAIL, password: SYSTEM_USER_PASSWORD, returnSecureToken: true }),
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
  const res = await fetch(`${FIRESTORE_BASE}/${collection}/${id}`, { headers: { Authorization: `Bearer ${idToken}` } });
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

function computeMissingCycles(template, existingDateKeys, today) {
  const missing = [];

  function walkFixedPeriod(anchor, addFn) {
    let cursor = new Date(anchor);
    for (let i = 0; i < 500; i++) {
      const shifted = shiftToFridayIfWeekend(cursor);
      const key = dateKey(shifted);
      if (!existingDateKeys.has(key)) missing.push({ dueDate: shifted, key });
      if (daysBetween(shifted, today) >= 0) break;
      if (i === 499) {
        console.warn(`Safety cap hit walking cycles for template "${template.title}" — check its anchor_date.`);
      }
      cursor = addFn(cursor);
    }
  }

  if (template.frequency === "daily") {
    walkFixedPeriod(template.anchor_date, (d) => {
      const n = new Date(d);
      n.setDate(n.getDate() + 1);
      return n;
    });
  } else if (template.frequency === "weekly") {
    walkFixedPeriod(template.anchor_date, (d) => {
      const n = new Date(d);
      n.setDate(n.getDate() + 7);
      return n;
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
    for (const field of ["anchor_day_1", "anchor_day_2"]) {
      const anchorDay = template[field];
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
    const existingDateKeys = new Set(existingTasks.filter((t) => t.due_date).map((t) => dateKey(new Date(t.due_date))));
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

function taskRowHtml(item) {
  const statusLine =
    item.diff < 0
      ? `<strong style="color:#b91c1c;">Overdue by ${Math.abs(item.diff)} day(s)</strong>`
      : item.diff === 0
      ? `<strong style="color:#b45309;">Due today</strong>`
      : `Due in ${item.diff} day(s)`;
  return `
    <li style="margin-bottom:10px;">
      <strong>${item.task.title}</strong> — ${item.clientName}<br/>
      Due: ${item.dueDate.toDateString()} · ${statusLine}
    </li>`;
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

  // Group everything by assignee, and separately collect overdue items for
  // the manager escalation digest — one email per person, not one per task.
  const byAssignee = new Map(); // uid -> { name, email, items: [] }
  const overdueForManagers = []; // { assigneeName, item }

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
    const item = { task, dueDate, diff, clientName };

    if (!byAssignee.has(task.assigned_to)) {
      byAssignee.set(task.assigned_to, { name: assignee.name, email: assignee.email, items: [] });
    }
    byAssignee.get(task.assigned_to).items.push(item);

    if (diff < 0) {
      overdueForManagers.push({ assigneeName: assignee.name || assignee.email, item });
    }
  }

  let remindersSent = 0;
  let escalationsSent = 0;

  // One consolidated email per employee.
  for (const [, { name, email, items }] of byAssignee) {
    if (items.length === 0) continue;
    items.sort((a, b) => a.dueDate - b.dueDate);

    const hasOverdue = items.some((i) => i.diff < 0);
    const subject = hasOverdue
      ? `You have ${items.length} task(s) needing attention (some overdue)`
      : `You have ${items.length} task(s) coming up`;

    const html = `
      <p>Hi ${name || "there"},</p>
      <p>Here's a summary of your tasks that need attention:</p>
      <ul>${items.map(taskRowHtml).join("")}</ul>
      <p>Please complete each in the dashboard and mark it done, or add a comment explaining any delay.</p>
    `;

    await sendEmail(email, subject, html);
    remindersSent++;
  }

  // One consolidated escalation email per manager/TL, listing every overdue
  // item across all employees, instead of one email per overdue task.
  if (overdueForManagers.length > 0 && managerEmails.length > 0) {
    const grouped = new Map(); // assigneeName -> [items]
    for (const { assigneeName, item } of overdueForManagers) {
      if (!grouped.has(assigneeName)) grouped.set(assigneeName, []);
      grouped.get(assigneeName).push(item);
    }

    const sections = [...grouped.entries()]
      .map(
        ([assigneeName, items]) => `
        <h4>${assigneeName}</h4>
        <ul>${items.map(taskRowHtml).join("")}</ul>
      `
      )
      .join("");

    const escalationHtml = `
      <p>The following tasks are currently overdue:</p>
      ${sections}
    `;

    for (const mgrEmail of managerEmails) {
      await sendEmail(mgrEmail, `${overdueForManagers.length} overdue task(s) across the team`, escalationHtml);
      escalationsSent++;
    }
  }

  console.log(
    `Run complete (mode: ${RUN_MODE}). Employee digest emails sent: ${remindersSent}. Manager escalation emails sent: ${escalationsSent}.`
  );
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
