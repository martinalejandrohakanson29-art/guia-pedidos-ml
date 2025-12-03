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
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1q0qWmIcRAybrxQcYRhJd5s-A1xiEe_VenWEA84Xptso/export?format=csv&gid=1839169689';

// *** IMPORTANTE: PEGA AQUÍ EL ID DE LA CARPETA DE DRIVE QUE COMPARTISTE CON EL ROBOT ***
// Ejemplo: const DRIVE_PARENT_FOLDER_ID = '1abcDEfghIjkLMnoPqrstUVwxYz';
const DRIVE_PARENT_FOLDER_ID = '1v-E638QF0AaPr7zywfH2luZvnHXtJujp';

// --- CONFIGURACIÓN DRIVE ---
const KEYFILE_PATH = path.join(__dirname, 'google-credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/drive']; // Scope más amplio para evitar errores de permisos

const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILE_PATH,
    scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });

// --- CONFIGURACIÓN MULTER ---
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors());
app.use(express.static('public')); // Si usas carpeta public
app.use(express.static(__dirname)); // Fallback por si los archivos están en la raíz
app.use(express.json());

// --- CACHÉ ---
let cachedData = null;
let cachedEnvioId = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;

// --- FUNCIÓN HELPER: OBTENER COLUMNA S (ID ENVÍO) ---
function getEnvioIdFromRow(row, keys) {
    // Intento 1: Buscar por nombre exacto si existe
    if (row['ID ENVIO']) return row['ID ENVIO'];
    if (row['ENVIO ID']) return row['ENVIO ID'];
    
    // Intento 2: Buscar por posición (Columna S es la 19, índice 18)
    // Aseguramos que el índice exista
    if (keys.length > 18) {
        return row[keys[18]]; 
    }
    return 'SIN_ID';
}

async function getSheetData() {
    const now = Date.now();
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        return { data: cachedData, envioId: cachedEnvioId };
    }

    try {
        console.log('Fetching Google Sheet...');
        const response = await axios.get(GOOGLE_SHEET_CSV_URL);
        
        const parsed = Papa.parse(response.data, {
            header: true,
            skipEmptyLines: true,
        });

        let envioId = 'SIN_ID';
        if (parsed.data && parsed.data.length > 0) {
            // Usamos la primera fila de datos para leer la celda S2 (que se repite en la columna)
            // Ojo: En CSV exportado, la fila 1 es headers. parsed.data[0] es la fila 2 del Excel.
            const firstRow = parsed.data[0];
            const keys = Object.keys(firstRow);
            
            envioId = getEnvioIdFromRow(firstRow, keys);
            
            // Limpieza básica del ID
            if(envioId) envioId = envioId.trim();
        }

        cachedData = parsed.data;
        cachedEnvioId = envioId;
        lastFetchTime = now;
        console.log('Datos actualizados. ID Envio actual:', cachedEnvioId);
        return { data: cachedData, envioId: cachedEnvioId };
    } catch (error) {
        console.error('Error fetching Sheet:', error.message);
        throw error;
    }
}

// --- FUNCIONES DRIVE ---
async function findOrCreateFolder(folderName, parentId) {
    // Importante: Buscamos solo carpetas que no estén en la papelera
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
            console.log(`Carpeta encontrada: ${folderName} (${res.data.files[0].id})`);
            return res.data.files[0].id;
        } else {
            console.log(`Creando carpeta: ${folderName} dentro de ${parentId || 'root'}`);
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
        console.error('Error Drive findOrCreate:', err);
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
        console.log('Archivo subido con ID:', file.data.id);
        return file.data.id;
    } catch (err) {
        console.error('Error Drive Upload:', err);
        throw err;
    }
}

// --- ENDPOINTS ---

app.get('/api/search', async (req, res) => {
    const query = req.query.q ? req.query.q.toLowerCase().trim() : '';
    if (!query) return res.json([]);

    try {
        const { data } = await getSheetData();
        const results = data.filter(row => Object.values(row).some(val => String(val).toLowerCase().includes(query)));

        const cleanResults = results.map(row => {
            const keys = Object.keys(row);
            // Mapeo robusto
            const itemId = row['ITEM ID'] || row[keys[0]] || 'S/D';
            const envio = row['Envío'] || row['Envio'] || row[keys[4]] || 'S/D'; // Ajustar índice según tu hoja real si falla
            
            // Agregados N(13) a Q(16). Ajusta índices si moviste columnas.
            const agregados = [];
            [13, 14, 15, 16].forEach(idx => {
                if(keys[idx] && row[keys[idx]]) agregados.push(row[keys[idx]]);
            });

            return {
                title: itemId,
                subtitle: row['Nombre'] || row['Titulo'] || row[keys[1]] || '',
                envio: envio,
                agregados: agregados
            };
        });
        res.json(cleanResults);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error búsqueda' });
    }
});

app.get('/api/envio-id', async (req, res) => {
    try {
        const { envioId } = await getSheetData();
        res.json({ envioId });
    } catch (error) {
        res.status(500).json({ error: 'Error ID' });
    }
});

app.post('/api/refresh', async (req, res) => {
    cachedData = null; 
    try {
        const { envioId } = await getSheetData();
        res.json({ success: true, envioId });
    } catch (error) {
        res.status(500).json({ error: 'Error refresh' });
    }
});

app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { itemId } = req.body;
    const file = req.file;

    console.log(`Intentando subir foto para Item: ${itemId}`);

    if (!file || !itemId) return res.status(400).json({ error: 'Faltan datos' });
    if (DRIVE_PARENT_FOLDER_ID === 'AQUI_PEGA_TU_ID_DE_CARPETA') {
        return res.status(500).json({ error: 'Falta configurar el ID de la carpeta Drive en server.js' });
    }

    try {
        // 1. Obtener ID Envío
        const { envioId } = await getSheetData();
        const safeEnvioId = envioId ? envioId.replace(/[^a-zA-Z0-9-_]/g, '_') : 'SIN_ID';
        const safeItemId = itemId.replace(/[^a-zA-Z0-9-_]/g, '_');

        console.log(`Estructura: [${DRIVE_PARENT_FOLDER_ID}] -> [${safeEnvioId}] -> [${safeItemId}]`);

        // 2. Buscar/Crear carpeta ENVIO dentro de la carpeta MAESTRA
        const envioFolderId = await findOrCreateFolder(safeEnvioId, DRIVE_PARENT_FOLDER_ID);

        // 3. Buscar/Crear carpeta ITEM dentro de carpeta ENVIO
        const itemFolderId = await findOrCreateFolder(safeItemId, envioFolderId);

        // 4. Subir
        const fileId = await uploadFileToDrive(file, itemFolderId);

        res.json({ success: true, fileId });

    } catch (error) {
        console.error('ERROR FINAL EN UPLOAD:', error);
        // Devolvemos el error detallado al frontend para que lo veas en la alerta si falla
        res.status(500).json({ error: error.message || 'Error interno al subir' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor listo en puerto ${PORT}`);
});
