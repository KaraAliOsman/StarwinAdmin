// server.js
const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000; // Importante para el despliegue online
// NOTA DE SEGURIDAD: En un entorno de producción, esta contraseña NUNCA debe estar en el código.
// Úsala desde una variable de entorno (process.env.ADMIN_PASSWORD) para mayor seguridad.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123451"; 

app.use(express.json());
app.use(express.static('public'));

let db;

// Función autoejecutable para inicializar la base de datos
(async () => {
    try {
        // Modificación para despliegue: Usar un directorio de datos persistente si está disponible
        const dbDir = process.env.DATABASE_PATH || path.join(__dirname, 'database');
        const dbPath = path.join(dbDir, 'starwin_pro.db');

        const fs = require('fs');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
            console.log(`Directorio de base de datos creado en: ${dbDir}`);
        }

        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
        
        console.log(`Base de datos conectada en: ${dbPath}`);

        await db.exec('PRAGMA foreign_keys = ON;');

        // Creación de las tablas
        await db.exec(`
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                address TEXT,
                email TEXT,
                phone TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,
                is_active BOOLEAN DEFAULT true,
                description TEXT,
                agreed_price REAL DEFAULT 0,
                paid_price REAL DEFAULT 0,
                cost_price REAL DEFAULT 0,
                status TEXT DEFAULT 'Pendiente' CHECK(status IN ('Pendiente', 'Confirmado', 'En Producción', 'Instalado', 'Finalizado', 'Cancelado')),
                due_datetime DATETIME,
                last_admin_responder TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
            );
            
            CREATE TABLE IF NOT EXISTS measurement_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,
                description TEXT,
                address TEXT,
                task_datetime DATETIME NOT NULL,
                is_completed BOOLEAN DEFAULT false,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
            );

            CREATE TRIGGER IF NOT EXISTS update_order_timestamp
            AFTER UPDATE ON orders
            FOR EACH ROW
            BEGIN
                UPDATE orders SET updatedAt = CURRENT_TIMESTAMP WHERE id = OLD.id;
            END;
        `);

        console.log('Tablas de la base de datos aseguradas.');

    } catch (err) {
        console.error("Error inicializando la base de datos:", err);
    }
})();

// --- API Endpoints ---

// Autenticación
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
    }
});

// Endpoint centralizado para el Dashboard
app.get('/api/dashboard-summary', async (req, res) => {
    try {
        const activeOrders = await db.all("SELECT * FROM orders WHERE is_active = true AND status != 'Cancelado'");
        const allMeasurements = await db.all("SELECT m.*, c.name as clientName FROM measurement_tasks m JOIN clients c ON m.client_id = c.id WHERE m.is_completed = false");
        const allOrdersForTasks = await db.all("SELECT o.*, c.name as clientName FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.is_active = true AND o.status NOT IN ('Finalizado', 'Cancelado')");

        // 1. KPIs Financieros
        const kpis = {
            totalPaid: activeOrders.reduce((sum, o) => sum + (o.paid_price || 0), 0),
            totalCosts: activeOrders.reduce((sum, o) => sum + (o.cost_price || 0), 0),
            totalDebt: activeOrders.reduce((sum, o) => sum + (o.agreed_price || 0), 0) - activeOrders.reduce((sum, o) => sum + (o.paid_price || 0), 0),
        };
        kpis.netProfit = kpis.totalPaid - kpis.totalCosts;

        // 2. Resumen de Estados de Pedidos
        const statusCounts = activeOrders.reduce((acc, order) => {
            acc[order.status] = (acc[order.status] || 0) + 1;
            return acc;
        }, {});
        const statusSummary = Object.entries(statusCounts)
            .map(([status, count]) => ({ status, count }))
            .sort((a, b) => b.count - a.count);

        // 3. Datos Financieros Mensuales (Últimos 6 meses)
        const monthlyFinancials = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthLabel = d.toLocaleString('es-ES', { month: 'short', year: '2-digit' });
            
            const ordersInMonth = activeOrders.filter(o => {
                const orderDate = new Date(o.createdAt);
                return orderDate.getFullYear() === d.getFullYear() && orderDate.getMonth() === d.getMonth();
            });

            monthlyFinancials.push({
                month: monthLabel,
                agreed: ordersInMonth.reduce((sum, o) => sum + o.agreed_price, 0),
                paid: ordersInMonth.reduce((sum, o) => sum + o.paid_price, 0),
                cost: ordersInMonth.reduce((sum, o) => sum + o.cost_price, 0),
            });
        }
        
        // 4. Próximas Tareas
        const upcomingTasks = [];
        const today = new Date();
        allOrdersForTasks.forEach(o => {
            if (o.due_datetime && new Date(o.due_datetime) >= today) {
                upcomingTasks.push({ id: o.id, type: 'Entrega', icon: 'rocket-outline', date: new Date(o.due_datetime), clientName: o.clientName, clientId: o.client_id });
            }
        });
        allMeasurements.forEach(m => {
            if (m.task_datetime && new Date(m.task_datetime) >= today) {
                upcomingTasks.push({ id: m.id, type: 'Medición', icon: 'build-outline', date: new Date(m.task_datetime), clientName: m.clientName, clientId: m.client_id });
            }
        });
        const sortedTasks = upcomingTasks.sort((a, b) => a.date - b.date).slice(0, 5);
        
        res.json({ kpis, statusSummary, monthlyFinancials, upcomingTasks: sortedTasks });

    } catch (e) {
        console.error("Error getting dashboard summary:", e);
        res.status(500).json({ error: 'Error al obtener resumen del dashboard' });
    }
});


// Clientes (Sin cambios)
app.get('/api/clients', async (req, res) => { try { const c = await db.all('SELECT * FROM clients ORDER BY name ASC'); res.json(c); } catch (e) { res.status(500).json({ error: 'Error al obtener clientes' }); } });
app.post('/api/clients', async (req, res) => { try { const { name, address, email, phone } = req.body; const r = await db.run('INSERT INTO clients (name, address, email, phone) VALUES (?, ?, ?, ?)', [name, address, email, phone]); res.status(201).json({ id: r.lastID, ...req.body, orders: [], measurement_tasks: [] }); } catch (e) { res.status(500).json({ error: 'Error al crear cliente' }); } });
app.delete('/api/clients/:id', async (req, res) => { try { await db.run('DELETE FROM clients WHERE id = ?', req.params.id); res.status(204).send(); } catch (e) { res.status(500).json({ error: 'Error al eliminar cliente' }); } });

// Pedidos (Sin cambios)
app.get('/api/orders', async (req, res) => { try { const o = await db.all(`SELECT o.*, c.name as clientName, c.phone as clientPhone FROM orders o JOIN clients c ON o.client_id = c.id ORDER BY o.createdAt DESC`); res.json(o); } catch (e) { res.status(500).json({ error: 'Error al obtener todos los pedidos' }); } });
app.post('/api/orders', async (req, res) => { try { const { client_id, description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active } = req.body; const r = await db.run('INSERT INTO orders (client_id, description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [client_id, description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active]); const n = await db.get('SELECT o.*, c.name as clientName FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = ?', r.lastID); res.status(201).json(n); } catch (e) { res.status(500).json({ error: 'Error al crear pedido' }); } });
app.put('/api/orders/:id', async (req, res) => { try { const { id } = req.params; const { description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active } = req.body; await db.run('UPDATE orders SET description=?, agreed_price=?, paid_price=?, cost_price=?, status=?, due_datetime=?, last_admin_responder=?, is_active=? WHERE id=?', [description, agreed_price, paid_price, cost_price, status, due_datetime, last_admin_responder, is_active, id]); const u = await db.get('SELECT o.*, c.name as clientName FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = ?', id); res.json(u); } catch (e) { res.status(500).json({ error: 'Error al actualizar pedido' }); } });
app.delete('/api/orders/:id', async (req, res) => { try { await db.run('DELETE FROM orders WHERE id = ?', req.params.id); res.status(204).send(); } catch (e) { res.status(500).json({ error: 'Error al eliminar pedido' }); } });

// Mediciones (Sin cambios)
app.get('/api/measurements', async (req, res) => { try { const t = await db.all(`SELECT m.*, c.name as clientName FROM measurement_tasks m JOIN clients c ON m.client_id = c.id ORDER BY m.task_datetime ASC`); res.json(t); } catch (e) { res.status(500).json({ error: 'Error al obtener tareas de medición' }); } });
app.post('/api/measurements', async (req, res) => { try { const { client_id, description, address, task_datetime } = req.body; const r = await db.run('INSERT INTO measurement_tasks (client_id, description, address, task_datetime) VALUES (?, ?, ?, ?)', [client_id, description, address, task_datetime]); const n = await db.get('SELECT m.*, c.name as clientName FROM measurement_tasks m JOIN clients c ON m.client_id = c.id WHERE m.id = ?', r.lastID); res.status(201).json(n); } catch (e) { res.status(500).json({ error: 'Error al crear tarea de medición' }); } });
app.put('/api/measurements/:id', async (req, res) => { try { const { id } = req.params; const { is_completed } = req.body; await db.run('UPDATE measurement_tasks SET is_completed = ? WHERE id = ?', [is_completed, id]); res.status(200).json({ success: true }); } catch (e) { res.status(500).json({ error: 'Error al actualizar la tarea de medición'}); } });
app.delete('/api/measurements/:id', async (req, res) => { try { await db.run('DELETE FROM measurement_tasks WHERE id = ?', req.params.id); res.status(204).send(); } catch (e) { res.status(500).json({ error: 'Error al eliminar tarea de medición' }); } });

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor Starwin PRO escuchando en http://localhost:${PORT}`);
});