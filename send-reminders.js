const admin = require("firebase-admin");

// Service account JSON is passed in as a GitHub Actions secret (a full JSON
// string), decoded here rather than committed to the repo as a file.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = "Anav Task Manager <onboarding@resend.dev>";

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((startOfDay(a) - startOfDay(b)) / msPerDay);
}

async function sendEmail(to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Failed to send email to ${to}:`, errText);
  } else {
    console.log(`Sent email to ${to}: ${subject}`);
  }
}

async function main() {
  const today = new Date();

  const tasksSnap = await db.collection("tasks").where("status", "==", "pending").get();

  if (tasksSnap.empty) {
    console.log("No pending tasks found.");
    return;
  }

  const userCache = new Map();
  const clientCache = new Map();

  async function getUser(uid) {
    if (!uid) return null;
    if (userCache.has(uid)) return userCache.get(uid);
    const snap = await db.collection("users").doc(uid).get();
    const data = snap.exists ? snap.data() : null;
    userCache.set(uid, data);
    return data;
  }

  async function getClientName(clientId) {
    if (!clientId) return "Unknown Client";
    if (clientCache.has(clientId)) return clientCache.get(clientId);
    const snap = await db.collection("clients").doc(clientId).get();
    const name = snap.exists ? snap.data().name : "Unknown Client";
    clientCache.set(clientId, name);
    return name;
  }

  const managersSnap = await db.collection("users").where("role", "in", ["tl", "manager"]).get();
  const managerEmails = managersSnap.docs.map((d) => d.data().email).filter(Boolean);

  let remindersSent = 0;
  let escalationsSent = 0;

  for (const doc of tasksSnap.docs) {
    const task = doc.data();
    if (!task.due_date || !task.assigned_to) continue;

    const dueDate = task.due_date.toDate();
    const diff = daysBetween(dueDate, today);

    if (diff > 3) continue;

    const assignee = await getUser(task.assigned_to);
    if (!assignee || !assignee.email) {
      console.warn(`Task ${doc.id} has no resolvable assignee email, skipping.`);
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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
