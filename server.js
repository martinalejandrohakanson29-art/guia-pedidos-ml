const express = require('express');
const axios = require('axios');
const Papa = require('papaparse');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');
const { Pool } = require('pg'); // Conexión a tu base de datos de la tienda

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONFIGURACIÓN DE BASE DE DATOS (MIGRACIÓN) ---
// Usará la variable DATABASE_URL que configures en Railway
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

// --- 2. CONFIGURACIÓN GOOGLE (EXISTENTE) ---
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1q0qWmIcRAybrxQcYRhJd5s-A1xiEe_VenWEA84Xptso/export?format=csv&gid=1839169689';
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
    } else {
        console.warn('⚠️ ADVERTENCIA: Faltan variables de entorno OAuth.');
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

// --- 3. CACHÉ Y HELPERS ---
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;

async function getSheetData() {
    const now = Date.now();
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        return { data: cachedData };
    }
    try {
        const response = await axios.get(GOOGLE_SHEET_CSV_URL);
        const parsed = Papa.parse(response.data, { header: true, skipEmptyLines: true });
        cachedData = parsed.data;
        lastFetchTime = now;
        return { data: cachedData };
    } catch (error) {
        console.error('Error fetching Sheet:', error.message);
        throw error;
    }
}

// NUEVO: Función para traer los últimos 2 envíos de la tabla Shipment
async function getRecentShipments() {
    try {
        const res = await pool.query('SELECT name FROM "Shipment" ORDER BY "createdAt" DESC LIMIT 2');
        return res.rows.map(row => row.name);
    } catch (err) {
        console.error('Error consultando DB:', err);
        return [];
    }
}

// --- 4. ENDPOINTS API ---

app.get('/api/search', async (req, res) => {
    const query = req.query.q ? req.query.q.toLowerCase().trim() : '';
    if (!query) return res.json([]);

    try {
        const { data } = await getSheetData();
        const results = data.filter(row => Object.values(row).some(val => String(val).toLowerCase().includes(query)));

        const cleanResults = results.map(row => {
            const keys = Object.keys(row);
            return {
                title: row['ITEM ID'] || row[keys[0]] || 'S/D',
                subtitle: row['Nombre'] || row['Titulo'] || row[keys[1]] || '', 
                publicationName: row[keys[2]] || '', 
                variation: row['VARIATION LABEL'] || row[keys[3]] || '', 
                image: row['URLFOTO'] || row[keys[17]] || '', 
                envio: row['Envío'] || row['Envio'] || row[keys[4]] || 'S/D',
                agregados: [13, 14, 15, 16].map(idx => row[keys[idx]]).filter(Boolean)
            };
        });
        res.json(cleanResults);
    } catch (error) {
        res.status(500).json({ error: 'Error búsqueda' });
    }
});

// MODIFICADO: Ahora lee de la Base de Datos en lugar del Sheet
app.get('/api/envio-id', async (req, res) => {
    try {
        const shipments = await getRecentShipments();
        res.json({ shipments });
    } catch (error) {
        res.status(500).json({ error: 'Error ID' });
    }
});

app.post('/api/refresh', async (req, res) => {
    cachedData = null; 
    res.json({ success: true });
});

app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { itemId, itemName, envioId } = req.body; // Recibe el ID de envío desde el frontend
    const file = req.file;

    if (!file || !itemId || !envioId) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const safeEnvioId = envioId.replace(/[^a-zA-Z0-9-_]/g, '_');
        let folderName = itemId;
        if (itemName && itemName !== 'undefined' && itemName.trim() !== '') {
            folderName = `${itemId} - ${itemName}`;
        }
        const safeFolderName = folderName.replace(/[/\\?%*:|"<>]/g, '').trim();

        const envioFolderId = await findOrCreateFolder(safeEnvioId, DRIVE_PARENT_FOLDER_ID);
        const itemFolderId = await findOrCreateFolder(safeFolderName, envioFolderId);
        const fileId = await uploadFileToDrive(file, itemFolderId);

        res.json({ success: true, fileId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 5. FUNCIONES DRIVE (EXISTENTES) ---

async function findOrCreateFolder(folderName, parentId) {
    if (!drive) throw new Error("Google Drive no configurado.");
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;

    const res = await drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' });
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
