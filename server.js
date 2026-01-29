const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONFIGURACIÓN DE BASE DE DATOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

// --- 2. CONFIGURACIÓN DEL BUCKET S3 (Railway) ---
const s3Client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

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
            agregados: row.agregados ? [row.agregados] : [] 
        }));
        
        res.json(formattedResults);
    } catch (error) {
        console.error('Error en búsqueda:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

/**
 * NUEVO ENDPOINT DE SUBIDA AL BUCKET
 */
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { itemId, envioId } = req.body;
    const file = req.file;

    if (!file || !itemId || !envioId) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    try {
        // Armamos la ruta del archivo: auditoria/ID_ENVIO/MLA_FECHA.jpg
        const fileName = `auditoria/${envioId}/${itemId}_${Date.now()}.jpg`;

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype,
        });

        await s3Client.send(command);

        console.log(`✅ Foto subida al Bucket: ${fileName}`);
        res.json({ success: true, path: fileName });

    } catch (error) {
        console.error('ERROR SUBIDA BUCKET:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`🚀 Servidor de Guía listo en puerto ${PORT}`));
