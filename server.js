// server.js
const express = require('express');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { Client } = require('pg');

// --- CONFIGURACIÓN ---
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123451";
const DATABASE_URL = process.env.DATABASE_URL; // URL de la base de datos en producción

let db; // Nuestra variable de base de datos

// --- LÓGICA DE LA BASE DE DATOS (SQLite o PostgreSQL) ---

const dbWrapper = {
    // Función para ejecutar queries con placeholders ($1, $2)
    async run(sql, params = []) {
        if (DATABASE_URL) {
            return db.query(sql, params);
        } else {
            // SQLite usa '?' para los placeholders, los reemplazamos
            const sqliteSql = sql.replace(/\$\d+/g, '?');
            return db.run(sqliteSql, params);
        }
    },
    // Función para obtener una sola fila
    async get(sql, params = []) {
        if (DATABASE_URL) {
            const res = await db.query(sql, params);
            return res.rows[0];
        } else {
            const sqliteSql = sql.replace(/\$\d+/g, '?');
            return db.get(sqliteSql, params);
        }
    },
    // Función para obtener todas las filas
    async all(sql, params = []) {
        if (DATABASE_URL) {
            const res = await db.query(sql, params);
            return res.rows;
        } else {
            const sqliteSql = sql.replace(/\$\d+/g, '?');
            return db.all(sqliteSql, params);
        }
    }
};

// --- INICIALIZACIÓN DE LA APLICACIÓN ---
(async () => {
    try {
        if (DATABASE_URL) {
            // --- MODO PRODUCCIÓN: PostgreSQL ---
            console.log("Modo producción detectado. Conectando a PostgreSQL...");
            db = new Client({
                connectionString: DATABASE_URL,
                ssl: { rejectUnauthorized: false }
            });
            await db.connect();
            console.log("Conectado a PostgreSQL exitosamente.");

            // Creación de tablas para PostgreSQL (sintaxis ligeramente diferente)
            await db.query(`
                CREATE TABLE IF NOT EXISTS clients (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    address TEXT,
                    email TEXT,
                    phone TEXT,
                    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS orders (
                    id SERIAL PRIMARY KEY,
                    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                    is_active BOOLEAN DEFAULT true,
                    description TEXT,
                    agreed_price REAL DEFAULT 0,
                    paid_price REAL DEFAULT 0,
                    cost_price REAL DEFAULT 0,
                    status TEXT DEFAULT 'Pendiente',
                    due_datetime TIMESTAMPTZ,
                    last_admin_responder TEXT,
                    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE TABLE IF NOT EXISTS measurement_tasks (
                    id SERIAL PRIMARY KEY,
                    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                    description TEXT,
                    address TEXT,
                    task_datetime TIMESTAMPTZ NOT NULL,
                    is_completed BOOLEAN DEFAULT false,
                    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );

                CREATE OR REPLACE FUNCTION update_updated_at_column()
                RETURNS TRIGGER AS $$
                BEGIN
                   NEW."updatedAt" = now(); 
                   RETURN NEW;
                END;
                $$ language 'plpgsql';

                DROP TRIGGER IF EXISTS update_order_timestamp ON orders;
                CREATE TRIGGER update_order_timestamp
                BEFORE UPDATE ON orders
                FOR EACH ROW
                EXECUTE PROCEDURE update_updated_at_column();
            `);
            
        } else {
            // --- MODO LOCAL: SQLite ---
            console.log("Modo local detectado. Usando SQLite.");
            const dbPath = path.join(__dirname, 'database');
            const fs = require('fs');
            if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });

            db = await open({
                filename: path.join(dbPath, 'starwin_pro.db'),
                driver: sqlite3.Database
            });
            await db.exec('PRAGMA foreign_keys = ON;');

            // Creación de tablas para SQLite (como estaba antes)
             await db.exec(`
                CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, address TEXT, email TEXT, phone TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP);
                CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, is_active BOOLEAN DEFAULT true, description TEXT, agreed_price REAL DEFAULT 0, paid_price REAL DEFAULT 0, cost_price REAL DEFAULT 0, status TEXT DEFAULT 'Pendiente', due_datetime DATETIME, last_admin_responder TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE);
                CREATE TABLE IF NOT EXISTS measurement_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, description TEXT, address TEXT, task_datetime DATETIME NOT NULL, is_completed BOOLEAN DEFAULT false, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE);
                CREATE TRIGGER IF NOT EXISTS update_order_timestamp AFTER UPDATE ON orders FOR EACH ROW BEGIN UPDATE orders SET updatedAt = CURRENT_TIMESTAMP WHERE id = OLD.id; END;
            `);
        }
        console.log("Base de datos lista y tablas aseguradas.");

    } catch (err) {
        console.error("Error inicializando la base de datos:", err);
    }

    // Iniciar el servidor Express después de la inicialización de la BD
    startServer();

})();


function startServer() {
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));
    
    // --- API Endpoints (USANDO EL WRAPPER) ---
    // Ahora todas las llamadas a la BD usan dbWrapper, que funciona para ambos sistemas

    // Autenticación
    app.post('/api/login', (req, res) => {
        const { password } = req.body;
        if (password === ADMIN_PASSWORD) res.json({ success: true });
        else res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
    });

    // Dashboard
    app.get('/api/dashboard-summary', async (req, res) => {
        try {
            const activeOrders = await dbWrapper.all("SELECT * FROM orders WHERE is_active = true AND status != 'Cancelado'");
            const measurements = await dbWrapper.all("SELECT m.*, c.name as \"clientName\" FROM measurement_tasks m JOIN clients c ON m.client_id = c.id WHERE m.is_completed = false");
            const ordersForTasks = await dbWrapper.all("SELECT o.*, c.name as \"clientName\" FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.is_active = true AND o.status NOT IN ('Finalizado', 'Cancelado')");
            
            // ... (el resto de la lógica del dashboard es igual)
             const kpis = { totalPaid: activeOrders.reduce((s, o) => s + (o.paid_price || 0), 0), totalCosts: activeOrders.reduce((s, o) => s + (o.cost_price || 0), 0) };
             kpis.netProfit = kpis.totalPaid - kpis.totalCosts;
             kpis.totalDebt = activeOrders.reduce((s, o) => s + (o.agreed_price || 0), 0) - kpis.totalPaid;
             const statusCounts = activeOrders.reduce((acc, o) => { acc[o.status] = (acc[o.status] || 0) + 1; return acc; }, {});
             const statusSummary = Object.entries(statusCounts).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
             const monthlyFinancials = []; const now = new Date(); for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); const monthLabel = d.toLocaleString('es-ES', { month: 'short', year: '2-digit' }); const ordersInMonth = activeOrders.filter(o => { const orderDate = new Date(o.createdAt); return orderDate.getFullYear() === d.getFullYear() && orderDate.getMonth() === d.getMonth(); }); monthlyFinancials.push({ month: monthLabel, agreed: ordersInMonth.reduce((s, o) => s + o.agreed_price, 0), paid: ordersInMonth.reduce((s, o) => s + o.paid_price, 0), cost: ordersInMonth.reduce((s, o) => s + o.cost_price, 0), }); }
             const upcomingTasks = []; const today = new Date(); ordersForTasks.forEach(o => { if (o.due_datetime && new Date(o.due_datetime) >= today) { upcomingTasks.push({ id: o.id, type: 'Entrega', icon: 'rocket-outline', date: new Date(o.due_datetime), clientName: o.clientName, clientId: o.client_id }); } }); measurements.forEach(m => { if (m.task_datetime && new Date(m.task_datetime) >= today) { upcomingTasks.push({ id: m.id, type: 'Medición', icon: 'build-outline', date: new Date(m.task_datetime), clientName: m.clientName, clientId: m.client_id }); } });
             const sortedTasks = upcomingTasks.sort((a, b) => a.date - b.date).slice(0, 5);
             res.json({ kpis, statusSummary, monthlyFinancials, upcomingTasks: sortedTasks });
        } catch (e) {
            console.error("Dashboard error:", e);
            res.status(500).json({ error: 'Error al obtener resumen del dashboard' });
        }
    });

    // Clientes
    app.get('/api/clients', async (req, res) => { try { const c = await dbWrapper.all('SELECT * FROM clients ORDER BY name ASC'); res.json(c); } catch (e) { res.status(500).json({ error: 'Error al obtener clientes' }); } });
    app.post('/api/clients', async (req, res) => { try { const { name, address, email, phone } = req.body; const result = await dbWrapper.run('INSERT INTO clients (name, address, email, phone) VALUES ($1, $2, $3, $4) RETURNING id', [name, address, email, phone]); const newClientId = DATABASE_URL ? result.rows[0].id : result.lastID; res.status(201).json({ id: newClientId, ...req.body, orders: [], measurement_tasks: [] }); } catch (e) { console.error(e); res.status(500).json({ error: 'Error al crear cliente' }); } });
    app.delete('/api/clients/:id', async (req, res) => { try { await dbWrapper.run('DELETE FROM clients WHERE id = $1', [req.params.id]); res.status(204).send(); } catch (e) { res.status(500).json({ error: 'Error al eliminar cliente' }); } });

    // Pedidos
    app.get('/api/orders', async (req, res) => { try { const o = await dbWrapper.all(`SELECT o.*, c.name as "clientName", c.phone as "clientPhone" FROM orders o JOIN clients c ON o.client_id = c.id ORDER BY o."createdAt" DESC`); res.json(o); } catch (e) { res.status(500).json({ error: 'Error al obtener todos los pedidos' }); } });
    app.post('/api/orders', async (req, res) => { try { const { client_id, description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active } = req.body; const result = await dbWrapper.run('INSERT INTO orders (client_id, description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id', [client_id, description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active]); const newOrderId = DATABASE_URL ? result.rows[0].id : result.lastID; const newOrder = await dbWrapper.get(`SELECT o.*, c.name as "clientName" FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = $1`, [newOrderId]); res.status(201).json(newOrder); } catch (e) { res.status(500).json({ error: 'Error al crear pedido' }); } });
    app.put('/api/orders/:id', async (req, res) => { try { const { id } = req.params; const { description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active } = req.body; await dbWrapper.run('UPDATE orders SET description=$1, agreed_price=$2, paid_price=$3, cost_price=$4, status=$5, due_datetime=$6, last_admin_responder=$7, is_active=$8 WHERE id=$9', [description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active, id]); const updatedOrder = await dbWrapper.get(`SELECT o.*, c.name as "clientName" FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = $1`, [id]); res.json(updatedOrder); } catch (e) { res.status(500).json({ error: 'Error al actualizar pedido' }); } });
    app.delete('/api/orders/:id', async (req, res) => { try { await dbWrapper.run('DELETE FROM orders WHERE id = $1', [req.params.id]); res.status(204).send(); } catch (e) { res.status(500).json({ error: 'Error al eliminar pedido' }); } });

    // Mediciones
    app.get('/api/measurements', async (req, res) => { try { const t = await dbWrapper.all(`SELECT m.*, c.name as "clientName" FROM measurement_tasks m JOIN clients c ON m.client_id = c.id ORDER BY m.task_datetime ASC`); res.json(t); } catch (e) { res.status(500).json({ error: 'Error al obtener tareas' }); } });
    app.post('/api/measurements', async (req, res) => { try { const { client_id, description, address, task_datetime } = req.body; const result = await dbWrapper.run('INSERT INTO measurement_tasks (client_id, description, address, task_datetime) VALUES ($1, $2, $3, $4) RETURNING id', [client_id, description, address, task_datetime]); const newTaskId = DATABASE_URL ? result.rows[0].id : result.lastID; const newTask = await dbWrapper.get(`SELECT m.*, c.name as "clientName" FROM measurement_tasks m JOIN clients c ON m.client_id = c.id WHERE m.id = $1`, [newTaskId]); res.status(201).json(newTask); } catch (e) { res.status(500).json({ error: 'Error al crear tarea' }); } });
    app.put('/api/measurements/:id', async (req, res) => { try { const { id } = req.params; const { is_completed } = req.body; await dbWrapper.run('UPDATE measurement_tasks SET is_completed = $1 WHERE id = $2', [is_completed, id]); res.status(200).json({ success: true }); } catch (e) { res.status(500).json({ error: 'Error al actualizar tarea' }); } });
    app.delete('/api/measurements/:id', async (req, res) => { try { await dbWrapper.run('DELETE FROM measurement_tasks WHERE id = $1', [req.params.id]); res.status(204).send(); } catch (e) { res.status(500).json({ error: 'Error al eliminar tarea' }); } });

    // Servir el index.html para cualquier otra ruta no API
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.listen(PORT, () => console.log(`🚀 Servidor Starwin PRO escuchando en http://localhost:${PORT}`));
}