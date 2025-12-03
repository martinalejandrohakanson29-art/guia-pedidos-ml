const express = require('express');
const axios = require('axios');
const Papa = require('papaparse');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
// REEMPLAZA ESTA URL CON LA TUYA DE GOOGLE SHEETS (Debe terminar en /export?format=csv)
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1q0qWmIcRAybrxQcYRhJd5s-A1xiEe_VenWEA84Xptso/export?format=csv&gid=1839169689';

// --- CONFIGURACIÓN DRIVE ---
const KEYFILE_PATH = path.join(__dirname, 'google-credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILE_PATH,
    scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });

// --- CONFIGURACIÓN MULTER ---
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB límite
});

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// --- CACHÉ SIMPLE ---
let cachedData = null;
let cachedEnvioId = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos

// --- FUNCIÓN PARA OBTENER DATOS ---
async function getSheetData() {
    const now = Date.now();
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        return { data: cachedData, envioId: cachedEnvioId };
    }

    try {
        console.log('Fetching data from Google Sheets...');
        if (GOOGLE_SHEET_CSV_URL === 'TU_URL_DE_GOOGLE_SHEETS_AQUI') {
            // Datos de prueba
            return {
                data: [],
                envioId: 'TEST-123'
            };
        }

        const response = await axios.get(GOOGLE_SHEET_CSV_URL);
        const csvData = response.data;

        const parsed = Papa.parse(csvData, {
            header: true,
            skipEmptyLines: true,
        });

        // Extraer ID DE ENVÍO de la celda S2 (Fila 0 del array de datos parseados, columna 18 si es 0-indexed, o por nombre si header es true)
        // PapaParse con header:true devuelve un array de objetos.
        // La fila 2 del Excel es el primer elemento del array `parsed.data` (índice 0).
        // La columna S es la 19ª columna.
        // Vamos a intentar acceder por índice de keys si el nombre de la columna varía, o asumir que las keys están en orden.

        let envioId = 'DESCONOCIDO';
        if (parsed.data && parsed.data.length > 0) {
            const firstRow = parsed.data[0];
            const keys = Object.keys(firstRow);
            // S es la columna 19. En array 0-indexed es 18.
            if (keys.length > 18) {
                envioId = firstRow[keys[18]]; // Columna S
            }
        }

        cachedData = parsed.data;
        cachedEnvioId = envioId;
        lastFetchTime = now;
        return { data: cachedData, envioId: cachedEnvioId };
    } catch (error) {
        console.error('Error fetching Google Sheet:', error.message);
        throw error;
    }
}

// --- FUNCIONES HELPER DRIVE ---
async function findOrCreateFolder(folderName, parentId = null) {
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) {
        query += ` and '${parentId}' in parents`;
    }

    try {
        const res = await drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (res.data.files.length > 0) {
            return res.data.files[0].id;
        } else {
            // Crear carpeta
            const fileMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
            };
            if (parentId) {
                fileMetadata.parents = [parentId];
            }
            const file = await drive.files.create({
                resource: fileMetadata,
                fields: 'id',
            });
            return file.data.id;
        }
    } catch (err) {
        console.error('Error en Drive findOrCreateFolder:', err);
        throw err;
    }
}

async function uploadFileToDrive(fileObject, parentFolderId) {
    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileObject.buffer);

    const fileMetadata = {
        name: fileObject.originalname,
        parents: [parentFolderId],
    };
    const media = {
        mimeType: fileObject.mimetype,
        body: bufferStream,
    };

    try {
        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });
        return file.data.id;
    } catch (err) {
        console.error('Error subiendo archivo a Drive:', err);
        throw err;
    }
}

// --- API ENDPOINTS ---

app.get('/api/search', async (req, res) => {
    const query = req.query.q ? req.query.q.toLowerCase().trim() : '';

    if (!query) {
        return res.json([]);
    }

    try {
        const { data } = await getSheetData();

        const results = data.filter(row => {
            return Object.values(row).some(val =>
                String(val).toLowerCase().includes(query)
            );
        });

        const cleanResults = results.map(row => {
            const keys = Object.keys(row);

            const itemId = row['ITEM ID'] || row[keys[0]] || 'S/D';
            const envio = row['Envío'] || row['Envio'] || row[keys[4]] || 'S/D';

            // Agregados: Columnas N(13), O(14), P(15), Q(16)
            const agregados = [];
            if (keys[13] && row[keys[13]]) agregados.push(row[keys[13]]);
            if (keys[14] && row[keys[14]]) agregados.push(row[keys[14]]);
            if (keys[15] && row[keys[15]]) agregados.push(row[keys[15]]);
            if (keys[16] && row[keys[16]]) agregados.push(row[keys[16]]);

            return {
                title: itemId,
                subtitle: row['Nombre'] || row['Titulo'] || row[keys[1]] || '',
                envio: envio,
                agregados: agregados
            };
        });

        res.json(cleanResults);

    } catch (error) {
        res.status(500).json({ error: 'Error al procesar la búsqueda' });
    }
});

app.get('/api/envio-id', async (req, res) => {
    try {
        const { envioId } = await getSheetData();
        res.json({ envioId });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo ID de envío' });
    }
});

app.post('/api/refresh', async (req, res) => {
    cachedData = null;
    cachedEnvioId = null;
    lastFetchTime = 0;
    try {
        const { envioId } = await getSheetData();
        res.json({ success: true, message: 'Datos actualizados', envioId });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar datos' });
    }
});

app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { itemId } = req.body;
    const file = req.file;

    if (!file || !itemId) {
        return res.status(400).json({ error: 'Faltan datos (archivo o itemId)' });
    }

    try {
        // 1. Obtener ID DE ENVÍO actual
        const { envioId } = await getSheetData();
        const safeEnvioId = envioId ? envioId.replace(/[^a-zA-Z0-9-_]/g, '_') : 'SIN_ID';
        const safeItemId = itemId.replace(/[^a-zA-Z0-9-_]/g, '_');

        // 2. Buscar/Crear carpeta ID ENVÍO (en raíz)
        const envioFolderId = await findOrCreateFolder(safeEnvioId);

        // 3. Buscar/Crear carpeta ITEM ID (dentro de ID ENVÍO)
        const itemFolderId = await findOrCreateFolder(safeItemId, envioFolderId);

        // 4. Subir archivo
        const fileId = await uploadFileToDrive(file, itemFolderId);

        res.json({ success: true, fileId: fileId });

    } catch (error) {
        console.error('Error en upload:', error);
        res.status(500).json({ error: 'Error al subir archivo a Drive' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
