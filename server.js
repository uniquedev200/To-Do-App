/*
 * JARVIS — Backend API Server
 * Express + PostgreSQL
 *
 * Provides REST API endpoints for task and memory CRUD operations.
 * Frontend uses localStorage by default; this server is the
 * future sync target and can replace localStorage entirely.
 */

require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ===== IST Utilities ===== */

/**
 * Returns the current time as an IST ISO-8601 string.
 * Uses Intl.DateTimeFormat — no manual offset math, no DST bugs.
 * Works correctly regardless of the server's system timezone (e.g. UTC on Render).
 */
function istISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+05:30`;
}

/**
 * Returns today's date in IST as YYYY-MM-DD.
 * Critical for overdue comparisons — avoids UTC date being 1 day behind IST.
 */
function istDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // en-CA locale produces YYYY-MM-DD naturally
}

/* ===== PostgreSQL Connection ===== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.connect(function (err) {
  if (err) {
    console.error('Database connection failed:', err.message);
    console.log('Server will run without database persistence.');
  } else {
    console.log('Connected to PostgreSQL database.');
    initDatabase();
  }
});

/* ===== Database Initialization ===== */
function initDatabase() {
  // Set the session timezone to IST so NOW(), CURRENT_DATE, etc. all return IST values.
  // This runs once on startup; individual queries inherit the pool's default timezone.
  pool.query("SET TIME ZONE 'Asia/Kolkata'", function (tzErr) {
    if (tzErr) console.error('Failed to set timezone:', tzErr.message);
    else console.log('PostgreSQL session timezone set to Asia/Kolkata (IST).');
  });

  const createTables = `
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'Other',
      priority TEXT DEFAULT 'medium',
      due TEXT,
      notes TEXT DEFAULT '',
      done BOOLEAN DEFAULT false,
      completed_at TIMESTAMP WITH TIME ZONE,
      created TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS memories (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'note',
      content TEXT DEFAULT '',
      tags TEXT[] DEFAULT '{}',
      created TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;

  pool.query(createTables, function (err) {
    if (err) {
      console.error('Failed to initialize database tables:', err.message);
    } else {
      console.log('Database tables initialized.');
      pool.query(
        'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE',
        function (migrateErr) {
          if (migrateErr) console.error('Migration warning:', migrateErr.message);
        }
      );
    }
  });
}

/**
 * Wraps pool.query to ensure every query runs in the IST timezone.
 * Render spins up fresh DB connections that reset to UTC — this guarantees
 * CURRENT_DATE, NOW(), and all timestamp operations are IST-aware per query.
 */
function queryIST(sql, params, callback) {
  pool.connect(function (err, client, release) {
    if (err) return callback(err);
    client.query("SET LOCAL TIME ZONE 'Asia/Kolkata'", function (tzErr) {
      if (tzErr) { release(); return callback(tzErr); }
      client.query(sql, params, function (queryErr, result) {
        release();
        callback(queryErr, result);
      });
    });
  });
}

/* ===== API Routes ===== */

// Health check — lightweight, for continuous uptime monitoring
function healthResponse(res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    status: 'ok',
    timezone: 'Asia/Kolkata',
    timestamp: new Date().toISOString(),
    ist: istISO(),
  });
}

app.get('/health', function (req, res) { healthResponse(res); });
app.get('/api/health', function (req, res) { healthResponse(res); });

/* ----- Tasks ----- */

// GET /api/tasks
app.get('/api/tasks', function (req, res) {
  queryIST('SELECT * FROM tasks ORDER BY created DESC', [], function (err, result) {
    if (err) return res.status(500).json({ error: err.message });
    res.json(result.rows);
  });
});

// POST /api/tasks
app.post('/api/tasks', function (req, res) {
  const { id, title, category, priority, due, notes, done, completedAt, created } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const task = {
    id: id || Date.now(),
    title,
    category: category || 'Other',
    priority: priority || 'medium',
    due: due || null,
    notes: notes || '',
    done: done || false,
    completedAt: completedAt || null,
    created: created || istISO(),
  };

  queryIST(
    'INSERT INTO tasks (id, title, category, priority, due, notes, done, completed_at, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET title=$2, category=$3, priority=$4, due=$5, notes=$6, done=$7, completed_at=$8 RETURNING *',
    [task.id, task.title, task.category, task.priority, task.due, task.notes, task.done, task.completedAt, task.created],
    function (err, result) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json(result.rows[0]);
    }
  );
});

// PATCH /api/tasks/:id/toggle
app.patch('/api/tasks/:id/toggle', function (req, res) {
  const id = Number(req.params.id);
  queryIST(
    'UPDATE tasks SET done = NOT done, completed_at = CASE WHEN done = false THEN NOW() ELSE NULL END WHERE id = $1 RETURNING *',
    [id],
    function (err, result) {
      if (err) return res.status(500).json({ error: err.message });
      if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
      res.json(result.rows[0]);
    }
  );
});

// DELETE /api/tasks/:id
app.delete('/api/tasks/:id', function (req, res) {
  const id = Number(req.params.id);
  queryIST(
    'DELETE FROM tasks WHERE id = $1 RETURNING *',
    [id],
    function (err, result) {
      if (err) return res.status(500).json({ error: err.message });
      if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
      res.json(result.rows[0]);
    }
  );
});

/* ----- Memories ----- */

// GET /api/memories
app.get('/api/memories', function (req, res) {
  queryIST('SELECT * FROM memories ORDER BY created DESC', [], function (err, result) {
    if (err) return res.status(500).json({ error: err.message });
    res.json(result.rows);
  });
});

// POST /api/memories
app.post('/api/memories', function (req, res) {
  const { id, title, type, content, tags, created } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  const memory = {
    id: id || Date.now(),
    title,
    type: type || 'note',
    content,
    tags: tags || [],
    created: created || istISO(),
  };

  queryIST(
    'INSERT INTO memories (id, title, type, content, tags, created) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET title=$2, type=$3, content=$4, tags=$5 RETURNING *',
    [memory.id, memory.title, memory.type, memory.content, memory.tags, memory.created],
    function (err, result) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json(result.rows[0]);
    }
  );
});

// DELETE /api/memories/:id
app.delete('/api/memories/:id', function (req, res) {
  const id = Number(req.params.id);
  queryIST(
    'DELETE FROM memories WHERE id = $1 RETURNING *',
    [id],
    function (err, result) {
      if (err) return res.status(500).json({ error: err.message });
      if (result.rows.length === 0) return res.status(404).json({ error: 'Memory not found' });
      res.json(result.rows[0]);
    }
  );
});

/* ----- Export / Sync ----- */

// GET /api/export — full context for AI consumption
app.get('/api/export', function (req, res) {
  const today = istDateString(); // IST-aware "today", not UTC

  const activePromise = new Promise(function (resolve, reject) {
    queryIST('SELECT title, priority, category, due, notes FROM tasks WHERE done = false ORDER BY created DESC', [], function (err, r) { err ? reject(err) : resolve(r); });
  });
  const donePromise = new Promise(function (resolve, reject) {
    queryIST('SELECT title, priority, category, completed_at FROM tasks WHERE done = true AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 50', [], function (err, r) { err ? reject(err) : resolve(r); });
  });
  const memoriesPromise = new Promise(function (resolve, reject) {
    queryIST('SELECT type, title, content, tags FROM memories ORDER BY created DESC', [], function (err, r) { err ? reject(err) : resolve(r); });
  });
  const statsPromise = new Promise(function (resolve, reject) {
    queryIST('SELECT COUNT(*)::int AS total, SUM(CASE WHEN done = false THEN 1 ELSE 0 END)::int AS active, SUM(CASE WHEN done = true THEN 1 ELSE 0 END)::int AS done FROM tasks', [], function (err, r) { err ? reject(err) : resolve(r); });
  });
  // Use JS-computed IST date for overdue check — avoids CURRENT_DATE being UTC on Render
  const overduePromise = new Promise(function (resolve, reject) {
    queryIST('SELECT COUNT(*)::int AS count FROM tasks WHERE done = false AND due IS NOT NULL AND due < $1', [today], function (err, r) { err ? reject(err) : resolve(r); });
  });

  Promise.all([activePromise, donePromise, memoriesPromise, statsPromise, overduePromise])
    .then(function ([activeResult, doneResult, memoriesResult, statsResult, overdueResult]) {
      const active = activeResult.rows;
      const completed = doneResult.rows;
      const memories = memoriesResult.rows;
      const stats = statsResult.rows[0];
      const overdueCount = overdueResult.rows[0].count;

      res.json({
        generated: istISO(),
        memories: memories.map(function (m) {
          return { type: m.type, title: m.title, content: m.content, tags: m.tags || [] };
        }),
        goals: memories.filter(function (m) { return m.type === 'goal'; }).map(function (m) { return m.title; }),
        task_context: {
          active_count: stats.active,
          overdue_count: overdueCount,
          overdue_tasks: active.filter(function (t) { return t.due && t.due < today; }).map(function (t) {
            return { title: t.title, priority: t.priority, category: t.category, due: t.due };
          }),
        },
        active_tasks: active.map(function (t) {
          return { title: t.title, priority: t.priority, category: t.category, due: t.due || null, notes: t.notes || null };
        }),
        completion_history: completed.map(function (t) {
          return { title: t.title, priority: t.priority, category: t.category, completed_at: t.completed_at };
        }),
        trends: {
          total_completed: stats.done,
          overdue: overdueCount,
          completion_rate_pct: stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100),
        },
      });
    })
    .catch(function (err) {
      res.status(500).json({ error: err.message });
    });
});

// POST /api/sync — bulk sync from localStorage
app.post('/api/sync', function (req, res) {
  const { tasks, memories } = req.body;

  if (!tasks && !memories) {
    return res.status(400).json({ error: 'Provide tasks and/or memories to sync' });
  }

  const ops = [];

  if (Array.isArray(tasks)) {
    tasks.forEach(function (t) {
      const task = {
        id: t.id || Date.now() + Math.floor(Math.random() * 1000),
        title: t.title,
        category: t.category || 'Other',
        priority: t.priority || 'medium',
        due: t.due || null,
        notes: t.notes || '',
        done: t.done || false,
        completedAt: t.completedAt || null,
        created: t.created || istISO(),
      };
      ops.push(
        new Promise(function (resolve, reject) {
          queryIST(
            'INSERT INTO tasks (id, title, category, priority, due, notes, done, completed_at, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET title=$2, category=$3, priority=$4, due=$5, notes=$6, done=$7, completed_at=$8',
            [task.id, task.title, task.category, task.priority, task.due, task.notes, task.done, task.completedAt, task.created],
            function (err, r) { err ? reject(err) : resolve(r); }
          );
        })
      );
    });
  }

  if (Array.isArray(memories)) {
    memories.forEach(function (m) {
      const memory = {
        id: m.id || Date.now() + Math.floor(Math.random() * 1000),
        title: m.title,
        type: m.type || 'note',
        content: m.content || '',
        tags: m.tags || [],
        created: m.created || istISO(),
      };
      ops.push(
        new Promise(function (resolve, reject) {
          queryIST(
            'INSERT INTO memories (id, title, type, content, tags, created) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET title=$2, type=$3, content=$4, tags=$5',
            [memory.id, memory.title, memory.type, memory.content, memory.tags, memory.created],
            function (err, r) { err ? reject(err) : resolve(r); }
          );
        })
      );
    });
  }

  Promise.all(ops)
    .then(function () {
      res.json({ synced: true, tasks: (tasks || []).length, memories: (memories || []).length });
    })
    .catch(function (err) {
      res.status(500).json({ error: err.message });
    });
});

/* ===== Serve SPA fallback ===== */
app.get(/^\/[^.]*$/, function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 for any unmatched static file requests
app.use(function (req, res) {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.status(404).sendFile(path.join(__dirname, 'offline.html'));
  }
});

/* ===== Start Server ===== */
app.listen(PORT, function () {
  console.log('JARVIS server running on http://localhost:' + PORT);
  console.log('API available at http://localhost:' + PORT + '/api');
  console.log('IST time on startup: ' + istISO());
});