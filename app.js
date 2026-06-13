/* ===== CONFIG ===== */
const CONFIG = {
  JARVIS_API_URL: window.location.origin + '/api',
  AUTO_SYNC: true,
  SYNC_INTERVAL_MS: 30000,
};

/* ===== IST TIME UTILITIES ===== */
// India Standard Time = UTC+5:30, permanently. No DST ever.
// We always derive IST from the system UTC clock using Intl.
// We do NOT use worldtimeapi for timezone conversion — it only
// returns a tiny clock-drift delta, not a timezone offset.
// Reading getUTCHours() on an unadjusted Date gives UTC, not IST.

function _istParts(includeTime) {
  const opts = {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  };
  if (includeTime) {
    opts.hour = '2-digit';
    opts.minute = '2-digit';
    opts.second = '2-digit';
    opts.hour12 = false;
  }
  const p = {};
  new Intl.DateTimeFormat('en-GB', opts)
    .formatToParts(new Date())
    .forEach(function (part) { p[part.type] = part.value; });
  // en-GB hour12:false can return "24" at midnight — normalise
  if (p.hour === '24') p.hour = '00';
  return p;
}

/** Current IST hour (0–23) */
function istHour() { return parseInt(_istParts(true).hour, 10); }

/** Today's date in IST as YYYY-MM-DD */
function getWorldToday() {
  const p = _istParts(false);
  return p.year + '-' + p.month + '-' + p.day;
}

/** Current IST datetime as ISO-8601 with +05:30 */
function getWorldISO() {
  const p = _istParts(true);
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + '+05:30';
}

/** Current IST time as a plain Date (for .getTime() / arithmetic only — do not read local* methods) */
function getWorldNow() { return new Date(); }

/* ===== DATA LAYER ===== */
function getTasks() {
  try { return JSON.parse(localStorage.getItem('jarvis_tasks')) || []; }
  catch { return []; }
}
function saveTasks(tasks) {
  localStorage.setItem('jarvis_tasks', JSON.stringify(tasks));
}
function getMemories() {
  try { return JSON.parse(localStorage.getItem('jarvis_memories')) || []; }
  catch { return []; }
}
function saveMemories(memories) {
  localStorage.setItem('jarvis_memories', JSON.stringify(memories));
}

function addTask(data) {
  const tasks = getTasks();
  const task = {
    id: Date.now(),
    title: data.title.trim(),
    category: data.category || 'Other',
    priority: data.priority || 'medium',
    due: data.due || null,
    notes: data.notes || '',
    done: false,
    completedAt: null,
    created: getWorldISO(),
  };
  tasks.unshift(task);
  saveTasks(tasks);
  lastMutation = Date.now(); syncToBackend();
  return task;
}

function toggleTaskDone(id) {
  const tasks = getTasks();
  const task = tasks.find(t => t.id === id);
  if (task) {
    task.done = !task.done;
    task.completedAt = task.done ? getWorldISO() : null;
    saveTasks(tasks);
    lastMutation = Date.now(); syncToBackend();
  }
  return task;
}

function deleteTask(id) {
  const tasks = getTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  const removed = tasks.splice(idx, 1)[0];
  saveTasks(tasks);
  lastMutation = Date.now(); syncToBackend();
  if (navigator.onLine && CONFIG.JARVIS_API_URL) {
    fetch(CONFIG.JARVIS_API_URL + '/tasks/' + id, { method: 'DELETE' }).catch(function () {});
  }
  return removed;
}

function addMemory(data) {
  const memories = getMemories();
  const memory = {
    id: Date.now(),
    title: data.title.trim(),
    type: data.type || 'note',
    content: data.content.trim(),
    tags: data.tags ? data.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
    created: getWorldISO(),
  };
  memories.unshift(memory);
  saveMemories(memories);
  lastMutation = Date.now(); syncToBackend();
  return memory;
}

function deleteMemory(id) {
  const memories = getMemories();
  const idx = memories.findIndex(m => m.id === id);
  if (idx === -1) return null;
  const removed = memories.splice(idx, 1)[0];
  saveMemories(memories);
  lastMutation = Date.now(); syncToBackend();
  if (navigator.onLine && CONFIG.JARVIS_API_URL) {
    fetch(CONFIG.JARVIS_API_URL + '/memories/' + id, { method: 'DELETE' }).catch(function () {});
  }
  return removed;
}

/* ===== TOAST SYSTEM ===== */
function showToast(message, type, undoCallback) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  const icons = { success: '✓', error: '✕', info: '●' };
  toast.className = `toast toast-${type || 'info'}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || '●'}</span>
    <span class="toast-message">${message}</span>
    ${undoCallback ? '<button class="toast-undo">Undo</button>' : ''}
  `;
  container.appendChild(toast);

  if (undoCallback) {
    toast.querySelector('.toast-undo').addEventListener('click', function () {
      undoCallback();
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
      showToast('Undo successful', 'success');
    });
  }

  setTimeout(function () {
    if (toast.parentNode) {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }
  }, undoCallback ? 4000 : 3000);
}

/* ===== ROUTER ===== */
let currentPage = 'dashboard';

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll(`.nav-item[data-page="${page}"], .bottom-nav-item[data-page="${page}"]`)
    .forEach(n => n.classList.add('active'));
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('hamburger').setAttribute('aria-expanded', 'false');
  renderPage(page);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPage(page) {
  switch (page) {
    case 'dashboard': renderDashboard(); break;
    case 'tasks': renderTasks(); break;
    case 'knowledge': renderKnowledge(); break;
    case 'overview': renderOverview(); break;
  }
}

/* ===== CLOCK ===== */
function updateClock() {
  // Use Intl directly — never read getUTCHours() on a plain Date for IST display
  const p = _istParts(true);

  const clock = document.getElementById('clock');
  if (clock) clock.textContent = p.hour + ':' + p.minute + ':' + p.second;

  const dateEl = document.getElementById('date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
  }

  const greeting = document.getElementById('greeting');
  if (greeting) {
    const h = parseInt(p.hour, 10);
    let period = 'morning';
    if (h >= 12 && h < 17) period = 'afternoon';
    else if (h >= 17) period = 'evening';
    greeting.textContent = 'Good ' + period + ', Commander.';
  }

  const minuteKey = p.year + p.month + p.day + p.hour + p.minute;
  if (minuteKey !== lastRolloverCheck) {
    lastRolloverCheck = minuteKey;
    rolloverOverdueTasks();
  }
}

/* ===== DASHBOARD ===== */
function renderDashboard() {
  const tasks = getTasks();
  const memories = getMemories();
  const active = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  const overdue = tasks.filter(t => isOverdue(t));

  document.getElementById('dash-total').textContent = tasks.length;
  document.getElementById('dash-active').textContent = active.length;
  document.getElementById('dash-done').textContent = done.length;
  document.getElementById('dash-memories').textContent = memories.length;

  const today = getWorldToday();
  const dueToday = tasks.filter(t => t.due === today && !t.done);
  const dueContainer = document.getElementById('dash-due-today');

  let dueHtml = '';
  if (overdue.length > 0) {
    dueHtml += '<div style="margin-bottom:0.5rem;font-size:0.75rem;color:var(--priority-high);font-weight:500;text-transform:uppercase;letter-spacing:0.06em">⚠ Overdue (' + overdue.length + ')</div>';
    dueHtml += overdue.slice(0, 3).map(t => `
      <div class="due-item due-urgent" style="margin-bottom:0.25rem">
        <span class="due-item-title">${escHtml(t.title)}</span>
        <span class="badge badge-high" style="font-size:0.65rem">${t.due}</span>
      </div>
    `).join('');
    if (overdue.length > 3) dueHtml += '<div style="font-size:0.72rem;color:var(--text-muted);padding-top:0.25rem">+' + (overdue.length - 3) + ' more overdue</div>';
    dueHtml += '<div style="border-top:1px solid rgba(255,255,255,0.06);margin:0.5rem 0"></div>';
  }

  if (dueToday.length === 0) {
    dueHtml += '<div class="empty-state" style="padding:0.5rem 0"><div class="empty-icon" aria-hidden="true" style="font-size:1.2rem">✓</div><p>All clear. No deadlines today.</p></div>';
  } else {
    dueHtml += dueToday.map(t => `
      <div class="due-item due-urgent">
        <span class="due-item-title">${escHtml(t.title)}</span>
        <span class="badge badge-${t.priority}">${t.priority}</span>
      </div>
    `).join('');
  }
  dueContainer.innerHTML = dueHtml;

  const recent = memories.slice(0, 3);
  const memContainer = document.getElementById('dash-recent-memories');
  if (recent.length === 0) {
    memContainer.innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🧠</div><p>Knowledge bank is empty. Add goals and notes for Jarvis.</p></div>';
  } else {
    memContainer.innerHTML = recent.map(m => `
      <div class="due-item">
        <span class="due-item-title">${escHtml(m.title)}</span>
        <span class="badge badge-${m.type}">${m.type}</span>
      </div>
    `).join('');
  }
}

/* ===== TASKS ===== */
let taskFilter = 'all';
let taskSearch = '';
let taskSort = 'created';

function renderTasks() {
  let tasks = getTasks();
  const list = document.getElementById('task-list');
  const today = getWorldToday();

  if (taskFilter === 'active') tasks = tasks.filter(t => !t.done);
  else if (taskFilter === 'done') tasks = tasks.filter(t => t.done);
  else if (taskFilter === 'high') tasks = tasks.filter(t => t.priority === 'high' && !t.done);
  else if (taskFilter === 'overdue') tasks = tasks.filter(t => isOverdue(t));
  else if (['Work', 'Personal', 'Learning'].includes(taskFilter)) tasks = tasks.filter(t => t.category === taskFilter);

  if (taskSearch) {
    const q = taskSearch.toLowerCase();
    tasks = tasks.filter(t => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  }

  if (taskSort === 'due') tasks.sort((a, b) => (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99'));
  else if (taskSort === 'priority') {
    const order = { high: 0, medium: 1, low: 2 };
    tasks.sort((a, b) => order[a.priority] - order[b.priority]);
  } else if (taskSort === 'title') tasks.sort((a, b) => a.title.localeCompare(b.title));
  else tasks.sort((a, b) => b.id - a.id);

  if (tasks.length === 0) {
    const msgs = {
      overdue: '<div class="empty-state"><div class="empty-icon" aria-hidden="true">✓</div><p>No overdue tasks. All caught up, Commander.</p></div>',
      done: '<div class="empty-state"><div class="empty-icon" aria-hidden="true">✓</div><p>No completed tasks yet.</p></div>',
      high: '<div class="empty-state"><div class="empty-icon" aria-hidden="true">📋</div><p>No high priority tasks queued.</p></div>',
    };
    list.innerHTML = msgs[taskFilter] || '<div class="empty-state"><div class="empty-icon" aria-hidden="true">📋</div><p>No tasks queued, Commander.</p></div>';
    return;
  }

  list.innerHTML = '';
  tasks.forEach(function (t, i) {
    var overdue = isOverdue(t);
    var card = document.createElement('div');
    card.className = 'task-card glass card-enter' + (overdue ? ' task-overdue' : '');
    card.style.animationDelay = (i * 50) + 'ms';
    card.setAttribute('role', 'listitem');

    var check = document.createElement('div');
    check.className = 'task-check' + (t.done ? ' checked' : '');
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', t.done);
    check.setAttribute('aria-label', 'Toggle ' + escHtml(t.title));
    check.setAttribute('tabindex', '0');
    check.addEventListener('click', function () {
      var task = toggleTaskDone(t.id);
      if (task) {
        showToast(task.done ? 'Task completed ✓' : 'Task reopened', 'success');
        renderTasks();
        if (document.getElementById('page-dashboard').classList.contains('active')) renderDashboard();
      }
    });
    check.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); }
    });

    var body = document.createElement('div');
    body.className = 'task-body';

    var title = document.createElement('div');
    title.className = 'task-title';
    title.innerHTML = escHtml(t.title) + (overdue ? ' <span class="badge badge-high" style="font-size:0.65rem">OVERDUE</span>' : '');

    var meta = document.createElement('div');
    meta.className = 'task-meta';
    meta.innerHTML =
      '<span class="badge badge-' + t.priority + '">' + t.priority + '</span>' +
      '<span class="badge badge-category">' + t.category + '</span>' +
      (t.due ? '<span class="task-meta-item' + (overdue ? ' task-meta-overdue' : '') + '">📅 ' + t.due + '</span>' : '') +
      '<span class="task-meta-item">' + timeAgo(t.created) + '</span>';

    body.appendChild(title);
    body.appendChild(meta);

    if (t.notes) {
      var note = document.createElement('div');
      note.className = 'task-note-preview';
      note.textContent = t.notes;
      body.appendChild(note);
    }

    var del = document.createElement('button');
    del.className = 'task-delete';
    del.setAttribute('aria-label', 'Delete ' + escHtml(t.title));
    del.textContent = '✕';
    del.addEventListener('click', function () {
      var removed = deleteTask(t.id);
      if (removed) {
        showToast('Task deleted.', 'info', function () {
          var tasks = getTasks(); tasks.unshift(removed); saveTasks(tasks);
          lastMutation = Date.now(); syncToBackend();
          renderTasks();
          if (document.getElementById('page-dashboard').classList.contains('active')) renderDashboard();
        });
        renderTasks();
        if (document.getElementById('page-dashboard').classList.contains('active')) renderDashboard();
      }
    });

    card.appendChild(check);
    card.appendChild(body);
    card.appendChild(del);
    list.appendChild(card);
  });
}

/* ===== KNOWLEDGE (Goals & Notes) ===== */
function renderKnowledge() {
  const memories = getMemories();
  const container = document.getElementById('knowledge-list');

  var goals = memories.filter(function (m) { return m.type === 'goal'; });
  var notes = memories.filter(function (m) { return m.type !== 'goal'; });

  var goalsHtml = goals.length === 0
    ? '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon" aria-hidden="true">🎯</div><p>No goals defined yet.</p></div>'
    : goals.map(function (m, i) { return `
      <div class="knowledge-card glass card-enter" style="animation-delay:${i*50}ms" data-id="${m.id}">
        <div class="knowledge-card-header">
          <span class="badge badge-goal">Goal</span>
          <button class="knowledge-delete" data-id="${m.id}" aria-label="Delete">✕</button>
        </div>
        <div class="knowledge-card-title">${escHtml(m.title)}</div>
        <div class="knowledge-card-content">${escHtml(m.content)}</div>
        ${m.tags && m.tags.length ? '<div class="knowledge-card-tags">' + m.tags.map(function (t) { return '<span class="knowledge-tag">#' + escHtml(t) + '</span>'; }).join('') + '</div>' : ''}
      </div>`;
    }).join('');

  var notesHtml = notes.length === 0
    ? '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon" aria-hidden="true">📝</div><p>No notes stored yet.</p></div>'
    : notes.map(function (m, i) { return `
      <div class="knowledge-card glass card-enter" style="animation-delay:${i*50}ms" data-id="${m.id}">
        <div class="knowledge-card-header">
          <span class="badge badge-${m.type}">${m.type}</span>
          <button class="knowledge-delete" data-id="${m.id}" aria-label="Delete">✕</button>
        </div>
        <div class="knowledge-card-title">${escHtml(m.title)}</div>
        <div class="knowledge-card-content">${escHtml(m.content)}</div>
        ${m.tags && m.tags.length ? '<div class="knowledge-card-tags">' + m.tags.map(function (t) { return '<span class="knowledge-tag">#' + escHtml(t) + '</span>'; }).join('') + '</div>' : ''}
      </div>`;
    }).join('');

  container.innerHTML = '<div class="knowledge-section"><h3 class="knowledge-section-title">🎯 Goals</h3><div class="knowledge-grid">' + goalsHtml + '</div></div><div class="knowledge-section"><h3 class="knowledge-section-title">📝 Notes & Facts</h3><div class="knowledge-grid">' + notesHtml + '</div></div>';
}

/* ===== OVERVIEW ===== */
function renderOverview() {
  const tasks = getTasks();
  const memories = getMemories();
  const active = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  const high = tasks.filter(t => t.priority === 'high' && !t.done);
  const overdue = tasks.filter(t => isOverdue(t));

  document.getElementById('ov-total').textContent = tasks.length;
  document.getElementById('ov-active').textContent = active.length;
  document.getElementById('ov-done').textContent = done.length;
  document.getElementById('ov-high').textContent = high.length;
  document.getElementById('ov-memories').textContent = memories.length;

  const total = tasks.length;
  const pct = total === 0 ? 0 : Math.round((done.length / total) * 100);
  const circumference = 2 * Math.PI * 56;
  const offset = circumference - (pct / 100) * circumference;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.strokeDasharray = `${offset} ${circumference}`;
  const text = document.getElementById('progress-text');
  if (text) text.textContent = pct + '%';

  const cats = ['Work', 'Personal', 'Learning', 'Health', 'Jarvis', 'Other'];
  const catCounts = {};
  cats.forEach(c => catCounts[c] = active.filter(t => t.category === c).length);
  const maxCount = Math.max(1, ...Object.values(catCounts));
  const catColors = {
    Work: '#00D4FF', Personal: '#7B61FF', Learning: '#4DFF91',
    Health: '#FF4D6A', Jarvis: '#FFB347', Other: 'rgba(255,255,255,0.3)'
  };

  const chartContainer = document.getElementById('category-chart');
  if (active.length === 0) {
    chartContainer.innerHTML = '<div class="empty-state"><p>No active tasks yet.</p></div>';
  } else {
    chartContainer.innerHTML = cats.map(c => `
      <div class="bar-row">
        <span class="bar-label">${c}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${(catCounts[c] / maxCount) * 100}%;background:${catColors[c]}"></div>
        </div>
        <span class="bar-count">${catCounts[c]}</span>
      </div>
    `).join('');
  }

  const upcomingSection = document.querySelector('#page-overview .overview-section[aria-label="Upcoming tasks"]');
  if (upcomingSection && overdue.length > 0) {
    let overdueBanner = upcomingSection.querySelector('.overdue-banner');
    if (!overdueBanner) {
      overdueBanner = document.createElement('div');
      overdueBanner.className = 'overdue-banner';
      overdueBanner.style.cssText = 'background:rgba(255,77,106,0.1);border:1px solid rgba(255,77,106,0.2);border-radius:10px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem';
      upcomingSection.insertBefore(overdueBanner, upcomingSection.querySelector('#upcoming-list'));
    }
    overdueBanner.innerHTML = '<span style="color:var(--priority-high);font-weight:500">⚠ ' + overdue.length + ' task' + (overdue.length > 1 ? 's' : '') + ' overdue</span> <span style="color:var(--text-muted);font-size:0.78rem">— complete them as soon as possible</span>';
    overdueBanner.style.display = 'flex';
  } else if (upcomingSection) {
    const overdueBanner = upcomingSection.querySelector('.overdue-banner');
    if (overdueBanner) overdueBanner.style.display = 'none';
  }

  // Upcoming 7 days
  const today = getWorldToday();
  const todayDate = new Date(today + 'T00:00:00+05:30');
  const sevenDays = Array.from({ length: 7 }, function (_, i) {
    const d = new Date(todayDate.getTime() + i * 86400000);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  });

  const upcoming = tasks.filter(t => t.due && !t.done && sevenDays.includes(t.due))
    .sort((a, b) => a.due.localeCompare(b.due));

  const upcomingContainer = document.getElementById('upcoming-list');
  if (upcoming.length === 0) {
    upcomingContainer.innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true">✓</div><p>All clear. No deadlines this week.</p></div>';
  } else {
    upcomingContainer.innerHTML = upcoming.map(t => {
      const dueDate = new Date(t.due + 'T00:00:00+05:30');
      const dayName = dueDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' });
      return `
        <div class="upcoming-item">
          <span class="upcoming-date">${dayName} ${t.due.slice(5)}</span>
          <span class="upcoming-title">${escHtml(t.title)}</span>
          <span class="upcoming-priority" style="background:var(--priority-${t.priority})" aria-label="${t.priority} priority"></span>
        </div>
      `;
    }).join('');
  }
}

/* ===== API EXPORT ===== */
function renderApiExports() {
  const memories = getMemories();
  const tasks = getTasks();
  const now = getWorldISO();
  const today = getWorldToday();

  const active = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  const overdue = tasks.filter(t => isOverdue(t));

  const memExport = {
    generated: now,
    memories: memories.map(m => ({ type: m.type, title: m.title, content: m.content, tags: m.tags })),
    goals: memories.filter(m => m.type === 'goal').map(m => m.title),
    task_context: {
      active_count: active.length,
      overdue_count: overdue.length,
      overdue_tasks: overdue.map(t => ({
        title: t.title, priority: t.priority, category: t.category, due: t.due,
        days_overdue: Math.max(0, Math.floor(
          (new Date(today + 'T00:00:00+05:30') - new Date(t.due + 'T00:00:00+05:30')) / 86400000
        )),
      })),
    },
  };

  const completedHistory = done
    .filter(t => t.completedAt)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 50)
    .map(t => ({ title: t.title, priority: t.priority, category: t.category, completed_at: t.completedAt }));

  const taskExport = {
    generated: now,
    active_tasks: active.map(t => ({
      title: t.title, priority: t.priority, category: t.category,
      due: t.due || null, notes: t.notes || null, overdue: isOverdue(t),
    })),
    completion_history: completedHistory,
    trends: {
      total_completed: done.length,
      overdue: overdue.length,
      completion_rate_pct: tasks.length === 0 ? 0 : Math.round((done.length / tasks.length) * 100),
    },
  };

  document.getElementById('mem-export').textContent = syntaxHighlight(memExport);
  document.getElementById('task-export').textContent = syntaxHighlight(taskExport);
  document.getElementById('mem-ts').textContent = 'Last updated: ' + now;
  document.getElementById('task-ts').textContent = 'Last updated: ' + now;
}

function syntaxHighlight(obj) {
  const json = JSON.stringify(obj, null, 2);
  const escaped = escHtml(json);
  return escaped
    .replace(/&quot;([^&]*)&quot;\s*:/g, '<span class="key">"$1"</span>:')
    .replace(/: &quot;([^&]*)&quot;/g, ': <span class="string">"$1"</span>')
    .replace(/\bnull\b/g, '<span class="null">null</span>')
    .replace(/\b(\d+)\b/g, '<span class="number">$1</span>')
    .replace(/([\[\]{}])/g, '<span class="bracket">$1</span>');
}

/* ===== OVERDUE ROLLOVER ===== */
function rolloverOverdueTasks() {
  const tasks = getTasks();
  const today = getWorldToday();
  let rolled = 0;
  tasks.forEach(function (t) {
    if (!t.done && t.due && t.due < today) {
      t.due = today;
      rolled++;
    }
  });
  if (rolled > 0) {
    saveTasks(tasks);
    lastMutation = Date.now(); syncToBackend();
    showToast(rolled + ' overdue task' + (rolled > 1 ? 's' : '') + ' rolled over to today', 'info');
    if (document.getElementById('page-' + currentPage)) renderPage(currentPage);
  }
}

/* ===== UTILITIES ===== */
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
}

function isOverdue(task) {
  if (task.done || !task.due) return false;
  return task.due < getWorldToday();
}

/* ===== AUTO-SYNC TO BACKEND ===== */
let syncQueue = [];
let syncInProgress = false;
let lastMutation = 0;

function syncToBackend() {
  if (!CONFIG.AUTO_SYNC) return;
  if (!navigator.onLine) { syncQueue.push(Date.now()); return; }
  flushSync();
}

function flushSync() {
  if (syncInProgress) return;
  syncInProgress = true;

  const tasks = getTasks();
  const memories = getMemories();
  const apiUrl = CONFIG.JARVIS_API_URL;
  if (!apiUrl) { syncInProgress = false; return; }

  fetch(apiUrl + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks, memories }),
  }).then(function (r) {
    if (!r.ok) throw new Error('Sync failed: ' + r.status);
    return r.json();
  }).then(function () {
    syncQueue = [];
  }).catch(function (err) {
    console.warn('Sync to backend failed, will retry:', err.message);
    if (syncQueue.length === 0) syncQueue.push(Date.now());
  }).finally(function () {
    syncInProgress = false;
    if (syncQueue.length > 0) setTimeout(flushSync, 2000);
  });
}

/* ===== PULL FROM BACKEND (cross-device) ===== */
function pullFromBackend() {
  if (!navigator.onLine) return;
  var apiUrl = CONFIG.JARVIS_API_URL;
  if (!apiUrl) return;
  if (syncInProgress || syncQueue.length > 0) {
    setTimeout(pullFromBackend, 2000);
    return;
  }

  fetch(apiUrl + '/tasks').then(function (r) {
    if (!r.ok) throw new Error('Pull tasks failed');
    return r.json();
  }).then(function (remote) {
    if (!remote || remote.length === 0) return;
    var tasks = remote.map(function (t) {
      return {
        id: t.id,
        title: t.title,
        category: t.category || 'Other',
        priority: t.priority || 'medium',
        due: t.due || null,
        notes: t.notes || '',
        done: t.done || false,
        completedAt: t.completed_at || t.completedAt || null,
        created: t.created || new Date().toISOString(),
      };
    });
    saveTasks(tasks);
  }).catch(function (err) {
    console.warn('Pull tasks from backend failed:', err.message);
  });

  fetch(apiUrl + '/memories').then(function (r) {
    if (!r.ok) throw new Error('Pull memories failed');
    return r.json();
  }).then(function (remote) {
    if (!remote || remote.length === 0) return;
    var memories = remote.map(function (m) {
      return {
        id: m.id,
        title: m.title,
        type: m.type || 'note',
        content: m.content || '',
        tags: m.tags || [],
        created: m.created || new Date().toISOString(),
      };
    });
    saveMemories(memories);
  }).catch(function (err) {
    console.warn('Pull memories from backend failed:', err.message);
  });
}

window.addEventListener('online', function () {
  if (syncQueue.length > 0) flushSync();
  pullFromBackend();
});

/* ===== EVENT SETUP ===== */
function setupEvents() {
  try {
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(el => {
    el.addEventListener('click', function () { navigateTo(this.dataset.page); });
  });

  const hamburger = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  hamburger.addEventListener('click', function () {
    const open = sidebar.classList.toggle('open');
    this.setAttribute('aria-expanded', open);
  });

  document.addEventListener('click', function (e) {
    if (window.innerWidth < 768 && sidebar.classList.contains('open')) {
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) {
        sidebar.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    }
  });

  document.getElementById('fab').addEventListener('click', function () {
    if (currentPage === 'knowledge') openKnowledgeModal();
    else openTaskModal();
  });

  document.getElementById('task-search').addEventListener('input', function () {
    taskSearch = this.value; renderTasks();
  });
  document.getElementById('task-sort').addEventListener('change', function () {
    taskSort = this.value; renderTasks();
  });

  document.querySelectorAll('#task-filters .chip').forEach(chip => {
    chip.addEventListener('click', function () {
      document.querySelectorAll('#task-filters .chip').forEach(c => { c.classList.remove('active'); c.setAttribute('aria-selected', 'false'); });
      this.classList.add('active');
      this.setAttribute('aria-selected', 'true');
      taskFilter = this.dataset.filter;
      renderTasks();
    });
  });

  document.getElementById('add-task-btn').addEventListener('click', openTaskModal);

  document.getElementById('add-memory-btn').addEventListener('click', openKnowledgeModal);

  document.getElementById('knowledge-list').addEventListener('click', function (e) {
    console.log('knowledge pressed');
    const target = e.target.closest('.knowledge-delete');
    if (!target) return;
    console.log('knowledge delete pressed', target.dataset.id);
    const id = Number(target.dataset.id);
    const removed = deleteMemory(id);
    if (removed) {
      showToast('Deleted', 'info');
      renderKnowledge();
      if (document.getElementById('page-dashboard').classList.contains('active')) renderDashboard();
    }
  });

  document.getElementById('task-modal-close').addEventListener('click', closeTaskModal);
  document.getElementById('task-cancel').addEventListener('click', closeTaskModal);
  document.querySelectorAll('.modal-cancel').forEach(b => {
    b.addEventListener('click', function () { this.closest('.modal-overlay').classList.remove('open'); });
  });

  document.querySelectorAll('.segmented-control').forEach(function (group) {
    group.addEventListener('click', function (e) {
      const opt = e.target.closest('.segmented-option');
      if (!opt) return;
      this.querySelectorAll('.segmented-option').forEach(function (o) {
        o.classList.remove('active'); o.setAttribute('aria-checked', 'false');
      });
      opt.classList.add('active');
      opt.setAttribute('aria-checked', 'true');
    });
    group.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        const opt = e.target.closest('.segmented-option');
        if (opt) { e.preventDefault(); opt.click(); }
      }
    });
  });

  document.getElementById('task-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const titleInput = document.getElementById('task-title-input');
    const title = titleInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    const priorityEl = document.querySelector('#task-priority-input .segmented-option.active');
    addTask({
      title,
      category: document.getElementById('task-category-input').value,
      priority: priorityEl ? priorityEl.dataset.value : 'medium',
      due: document.getElementById('task-due-input').value || null,
      notes: document.getElementById('task-notes-input').value,
    });
    showToast('Task queued ✓', 'success');
    closeTaskModal();
    this.reset();
    document.querySelector('#task-priority-input .segmented-option[data-value="medium"]').click();
    if (currentPage === 'tasks') renderTasks();
    if (currentPage === 'dashboard') renderDashboard();
  });

  document.getElementById('knowledge-modal-close').addEventListener('click', closeKnowledgeModal);
  document.getElementById('knowledge-cancel').addEventListener('click', closeKnowledgeModal);

  document.getElementById('knowledge-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const titleInput = document.getElementById('knowledge-title-input');
    const contentInput = document.getElementById('knowledge-content-input');
    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    if (!content) { contentInput.focus(); return; }
    addMemory({
      title: title,
      type: document.getElementById('knowledge-type-input').value,
      content: content,
      tags: document.getElementById('knowledge-tags-input').value,
    });
    showToast('Saved ✓', 'success');
    closeKnowledgeModal();
    this.reset();
    if (currentPage === 'knowledge') renderKnowledge();
    if (currentPage === 'dashboard') renderDashboard();
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', function (e) {
      if (e.target === this) this.classList.remove('open');
    });
  });

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = '#050810';
  } catch (e) { console.error('setupEvents failed:', e); }
}

/* ===== MODAL HELPERS ===== */
function openTaskModal() {
  document.getElementById('task-modal').classList.add('open');
  document.getElementById('task-title-input').focus();
}
function closeTaskModal() {
  document.getElementById('task-modal').classList.remove('open');
  document.getElementById('task-form').reset();
  document.querySelector('#task-priority-input .segmented-option[data-value="medium"]').click();
}

/* ===== KNOWLEDGE MODAL HELPERS ===== */
function openKnowledgeModal() {
  document.getElementById('knowledge-modal').classList.add('open');
  document.getElementById('knowledge-title-input').focus();
}
function closeKnowledgeModal() {
  document.getElementById('knowledge-modal').classList.remove('open');
  document.getElementById('knowledge-form').reset();
}

/* ===== INSTALL BANNER ===== */
let installPromptEvent = null;

function showInstallBanner() {
  const banner = document.createElement('div');
  banner.id = 'install-banner';
  banner.style.cssText = 'display:flex;align-items:center;gap:1rem;padding:0.75rem 1.25rem;background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);border-radius:12px;margin-bottom:1rem;font-size:0.85rem;';
  banner.innerHTML = `
    <span style="font-size:1.2rem">⬡</span>
    <span style="flex:1">Install JARVIS for the full experience.</span>
    <button class="btn-primary" id="install-btn" style="padding:0.5rem 1rem;font-size:0.8rem">Install</button>
    <button id="dismiss-install" style="padding:0.3rem 0.6rem;color:var(--text-muted);font-size:1rem">✕</button>
  `;
  const main = document.querySelector('.main-content');
  main.insertBefore(banner, main.firstChild);
  document.getElementById('install-btn').addEventListener('click', function () {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      installPromptEvent.userChoice.then(function (choice) {
        if (choice.outcome === 'accepted') banner.remove();
        installPromptEvent = null;
      });
    }
  });
  document.getElementById('dismiss-install').addEventListener('click', function () { banner.remove(); });
}

window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  installPromptEvent = e;
  if (!document.getElementById('install-banner')) showInstallBanner();
});

/* ===== INIT ===== */
let lastRolloverCheck = '';

function init() {
  console.log('init');
  try {
    updateClock();
    setInterval(updateClock, 1000);
    rolloverOverdueTasks();
    pullFromBackend();
    setInterval(pullFromBackend, 30000);
    setupEvents();
    navigateTo('dashboard');
  } catch (e) { console.error('init error:', e); }
}

document.addEventListener('DOMContentLoaded', init);