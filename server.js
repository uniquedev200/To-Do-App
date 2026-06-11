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
  const createTables = `
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'Other',
      priority TEXT DEFAULT 'medium',
      due TEXT,
      notes TEXT DEFAULT '',
      done BOOLEAN DEFAULT false,
      completed_at TIMESTAMP,
      created TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS memories (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'note',
      content TEXT DEFAULT '',
      tags TEXT[] DEFAULT '{}',
      created TIMESTAMP DEFAULT NOW()
    );
  `;

  pool.query(createTables, function (err) {
    if (err) {
      console.error('Failed to initialize database tables:', err.message);
    } else {
      console.log('Database tables initialized.');
      // Add completed_at column if it doesn't exist (migration for existing installs)
      pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP', function (migrateErr) {
        if (migrateErr) console.error('Migration warning:', migrateErr.message);
      });
    }
  });
}

/* ===== API Routes ===== */

// Health check
app.get('/api/health', function (req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ----- Tasks ----- */

// GET /api/tasks
app.get('/api/tasks', function (req, res) {
  pool.query('SELECT * FROM tasks ORDER BY created DESC', function (err, result) {
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
    created: created || new Date().toISOString(),
  };

  pool.query(
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
  pool.query(
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
  pool.query(
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
  pool.query('SELECT * FROM memories ORDER BY created DESC', function (err, result) {
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
    created: created || new Date().toISOString(),
  };

  pool.query(
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
  pool.query(
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
  const activePromise = pool.query('SELECT title, priority, category, due, notes FROM tasks WHERE done = false ORDER BY created DESC');
  const donePromise = pool.query("SELECT title, priority, category, completed_at FROM tasks WHERE done = true AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 50");
  const memoriesPromise = pool.query('SELECT type, title, content, tags FROM memories ORDER BY created DESC');
  const statsPromise = pool.query("SELECT COUNT(*)::int AS total, SUM(CASE WHEN done = false THEN 1 ELSE 0 END)::int AS active, SUM(CASE WHEN done = true THEN 1 ELSE 0 END)::int AS done FROM tasks");
  const overduePromise = pool.query("SELECT COUNT(*)::int AS count FROM tasks WHERE done = false AND due IS NOT NULL AND due::date < CURRENT_DATE");

  Promise.all([activePromise, donePromise, memoriesPromise, statsPromise, overduePromise])
    .then(function ([activeResult, doneResult, memoriesResult, statsResult, overdueResult]) {
      const active = activeResult.rows;
      const completed = doneResult.rows;
      const memories = memoriesResult.rows;
      const stats = statsResult.rows[0];
      const overdueCount = overdueResult.rows[0].count;

      res.json({
        generated: new Date().toISOString(),
        memories: memories.map(function (m) {
          return { type: m.type, title: m.title, content: m.content, tags: m.tags || [] };
        }),
        goals: memories.filter(function (m) { return m.type === 'goal'; }).map(function (m) { return m.title; }),
        task_context: {
          active_count: stats.active,
          overdue_count: overdueCount,
          overdue_tasks: active.filter(function (t) { return t.due && t.due < new Date().toISOString().slice(0, 10); }).map(function (t) {
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
        created: t.created || new Date().toISOString(),
      };
      ops.push(
        pool.query(
          'INSERT INTO tasks (id, title, category, priority, due, notes, done, completed_at, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET title=$2, category=$3, priority=$4, due=$5, notes=$6, done=$7, completed_at=$8',
          [task.id, task.title, task.category, task.priority, task.due, task.notes, task.done, task.completedAt, task.created]
        )
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
        created: m.created || new Date().toISOString(),
      };
      ops.push(
        pool.query(
          'INSERT INTO memories (id, title, type, content, tags, created) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET title=$2, type=$3, content=$4, tags=$5',
          [memory.id, memory.title, memory.type, memory.content, memory.tags, memory.created]
        )
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
});
