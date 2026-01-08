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

// Obtiene los envíos disponibles
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

// Lista de envíos para el dropdown
app.get('/api/envio-id', async (req, res) => {
    try {
        const shipments = await getRecentShipments();
        res.json({ shipments });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo envíos' });
    }
});

// NUEVO: Obtiene los items de un envío específico
app.get('/api/shipment-items', async (req, res) => {
    const shipmentName = req.query.name;
    if (!shipmentName) return res.status(400).json({ error: 'Falta el nombre del envío' });

    try {
        // Hacemos un JOIN entre Shipment y ShipmentItem para filtrar por el nombre del envío
        const query = `
            SELECT si.* FROM "ShipmentItem" si
            JOIN "Shipment" s ON si."shipmentId" = s.id
            WHERE s.name = $1
        `;
        const result = await pool.query(query, [shipmentName]);
        
        // Mapeamos los datos para que el frontend los entienda
        const formattedResults = result.rows.map(row => ({
            title: row.itemId, // Usamos el MLA como título principal
            subtitle: row.sku,
            publicationName: row.title, // Nombre largo del producto
            variation: row.variation,
            image: row.imageUrl,
            envio: shipmentName,
            quantity: row.quantity,
            // Si agregados es un string, lo metemos en un array para que el frontend no falle
            agregados: row.agregados ? [row.agregados] : [] 
        }));
        
        res.json(formattedResults);
    } catch (error) {
        console.error('Error obteniendo items:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// Subida de fotos a Drive
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { itemId, itemName, envioId } = req.body;
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
        await uploadFileToDrive(file, itemFolderId);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 5. FUNCIONES DRIVE ---
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
