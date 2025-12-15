const express = require('express');
const axios = require('axios');
const Papa = require('papaparse');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1q0qWmIcRAybrxQcYRhJd5s-A1xiEe_VenWEA84Xptso/export?format=csv&gid=1839169689';

// ID DE CARPETA DE DRIVE (Tu carpeta compartida)
const DRIVE_PARENT_FOLDER_ID = '1v-E638QF0AaPr7zywfH2luZvnHXtJujp';

// --- NUEVA CONFIGURACIÓN DE AUTENTICACIÓN (OAUTH2) ---
// Esto reemplaza al método antiguo del "Robot"
let drive;

try {
    // Verificamos que las variables existan en Railway
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
        
        const oAuth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            "https://developers.google.com/oauthplayground" // URI de redirección usada para obtener el token
        );

        // Le damos el token maestro para que siempre tenga acceso
        oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

        drive = google.drive({ version: 'v3', auth: oAuth2Client });
        console.log('✅ Autenticación OAuth2 configurada correctamente.');
        
    } else {
        console.warn('⚠️ ADVERTENCIA: Faltan variables de entorno OAuth en Railway.');
    }
} catch (error) {
    console.error("ERROR CRÍTICO CONFIGURANDO DRIVE:", error);
}

// --- CONFIGURACIÓN MULTER ---
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
// Servir archivos estáticos desde la raíz
app.use(express.static(__dirname));

// --- CACHÉ ---
let cachedData = null;
let cachedEnvioId = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;

// --- HELPERS ---
function getEnvioIdFromRow(row, keys) {
    if (row['ID ENVIO']) return row['ID ENVIO'];
    if (row['ENVIO ID']) return row['ENVIO ID'];
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
            const firstRow = parsed.data[0];
            const keys = Object.keys(firstRow);
            envioId = getEnvioIdFromRow(firstRow, keys);
            if(envioId) envioId = envioId.trim();
        }

        cachedData = parsed.data;
        cachedEnvioId = envioId;
        lastFetchTime = now;
        return { data: cachedData, envioId: cachedEnvioId };
    } catch (error) {
        console.error('Error fetching Sheet:', error.message);
        throw error;
    }
}

async function findOrCreateFolder(folderName, parentId) {
    if (!drive) throw new Error("Google Drive no está configurado (faltan credenciales).");
    
    // Buscamos carpeta que NO esté en la papelera
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
    if (!drive) throw new Error("Google Drive no está configurado.");

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
        console.error('Error Drive Upload:', err);
        throw err;
    }
}

// --- ENDPOINTS API ---

app.get('/api/search', async (req, res) => {
    const query = req.query.q ? req.query.q.toLowerCase().trim() : '';
    if (!query) return res.json([]);

    try {
        const { data } = await getSheetData();
        // Filtramos buscando en todos los valores de la fila
        const results = data.filter(row => Object.values(row).some(val => String(val).toLowerCase().includes(query)));

        const cleanResults = results.map(row => {
            const keys = Object.keys(row);
            
            // Mapeo de columnas basado en índices (A=0, B=1, C=2)
            const itemId = row['ITEM ID'] || row[keys[0]] || 'S/D';    // Columna A
            const skuInventario = row['Nombre'] || row['Titulo'] || row[keys[1]] || ''; // Columna B (Antes usada como subtitle)
            const nombrePublicacion = row[keys[2]] || ''; // Columna C -> NUEVO CAMPO
            const envio = row['Envío'] || row['Envio'] || row[keys[4]] || 'S/D'; // Columna E (aprox)
            
            const agregados = [];
            // Recolectamos notas extra de columnas posteriores
            [13, 14, 15, 16].forEach(idx => {
                if(keys[idx] && row[keys[idx]]) agregados.push(row[keys[idx]]);
            });

            return {
                title: itemId,
                subtitle: skuInventario, // Mantenemos la Columna B como dato secundario
                publicationName: nombrePublicacion, // Enviamos la Columna C
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

    if (!file || !itemId) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const { envioId } = await getSheetData();
        const safeEnvioId = envioId ? envioId.replace(/[^a-zA-Z0-9-_]/g, '_') : 'SIN_ID';
        const safeItemId = itemId.replace(/[^a-zA-Z0-9-_]/g, '_');

        const envioFolderId = await findOrCreateFolder(safeEnvioId, DRIVE_PARENT_FOLDER_ID);
        const itemFolderId = await findOrCreateFolder(safeItemId, envioFolderId);
        const fileId = await uploadFileToDrive(file, itemFolderId);

        res.json({ success: true, fileId });

    } catch (error) {
        console.error('ERROR UPLOAD:', error);
        res.status(500).json({ error: error.message || 'Error al subir' });
    }
});

// Ruta principal para servir el HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Servidor listo en puerto ${PORT}`);
});

