const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONFIGURACIÓN DE BASE DE DATOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

// --- 2. CONFIGURACIÓN GOOGLE DRIVE ---
const DRIVE_PARENT_FOLDER_ID = '1v-E638QF0AaPr7zywfH2luZvnHXtJujp';

let drive;
try {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
        const oAuth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            "https://developers.google.com/oauthplayground"
        );
        oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
        drive = google.drive({ version: 'v3', auth: oAuth2Client });
        console.log('✅ Autenticación OAuth2 configurada correctamente.');
    }
} catch (error) {
    console.error("ERROR DRIVE:", error);
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 3. FUNCIONES DE BASE DE DATOS ---

async function getRecentShipments() {
    try {
        const res = await pool.query('SELECT id, name FROM "Shipment" ORDER BY "createdAt" DESC LIMIT 10');
        return res.rows;
    } catch (err) {
        console.error('Error consultando Envios:', err);
        return [];
    }
}

// --- 4. ENDPOINTS API ---

app.get('/api/envio-id', async (req, res) => {
    try {
        const shipments = await getRecentShipments();
        res.json({ shipments });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo envíos' });
    }
});

app.get('/api/search', async (req, res) => {
    const { q, shipmentId } = req.query;
    if (!shipmentId) return res.status(400).json({ error: 'Falta el ID del envío' });

    try {
        const query = `
            SELECT * FROM "ShipmentItem" 
            WHERE "shipmentId" = $1 
            AND ("itemId" ILIKE $2 OR "title" ILIKE $2 OR "sku" ILIKE $2)
            LIMIT 50
        `;
        const values = [shipmentId, `%${q}%`];
        const result = await pool.query(query, values);
        
        const formattedResults = result.rows.map(row => ({
            title: row.itemId, 
            subtitle: row.sku,
            publicationName: row.title,
            variation: row.variation,
            image: row.imageUrl,
            quantity: row.quantity,
            envio: 'Cargado desde DB',
            // Enviamos el contenido de agregados tal cual (puede ser un string con comas)
            agregados: row.agregados ? [row.agregados] : [] 
        }));
        
        res.json(formattedResults);
    } catch (error) {
        console.error('Error en búsqueda:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { itemId, itemName, envioId } = req.body;
    const file = req.file;
    if (!file || !itemId || !envioId) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const shipRes = await pool.query('SELECT name FROM "Shipment" WHERE id = $1', [envioId]);
        const envioName = shipRes.rows.length > 0 ? shipRes.rows[0].name : envioId;
        const safeEnvioId = envioName.toString().replace(/[^a-zA-Z0-9-_]/g, '_');
        let folderName = itemId;
        if (itemName && itemName !== 'undefined' && itemName.trim() !== '') {
            folderName = `${itemId} - ${itemName}`;
        }
        const safeFolderName = folderName.replace(/[/\\?%*:|"<>]/g, '').trim();
        const envioFolderId = await findOrCreateFolder(safeEnvioId, DRIVE_PARENT_FOLDER_ID);
        const itemFolderId = await findOrCreateFolder(safeFolderName, envioFolderId);
        await uploadFileToDrive(file, itemFolderId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function findOrCreateFolder(folderName, parentId) {
    if (!drive) throw new Error("Google Drive no configurado.");
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;
    const res = await drive.files.list({ q: query, fields: 'files(id, name)' });
    if (res.data.files.length > 0) return res.data.files[0].id;
    const file = await drive.files.create({
        resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] },
        fields: 'id',
    });
    return file.data.id;
}

async function uploadFileToDrive(fileObject, parentFolderId) {
    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileObject.buffer);
    const file = await drive.files.create({
        resource: { name: fileObject.originalname, parents: [parentFolderId] },
        media: { mimeType: fileObject.mimetype, body: bufferStream },
        fields: 'id',
    });
    return file.data.id;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
