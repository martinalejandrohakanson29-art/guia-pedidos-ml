const express = require('express');
const axios = require('axios');
const Papa = require('papaparse');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
// REEMPLAZA ESTA URL CON LA TUYA DE GOOGLE SHEETS (Debe terminar en /export?format=csv)
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1q0qWmIcRAybrxQcYRhJd5s-A1xiEe_VenWEA84Xptso/export?format=csv&gid=1839169689';

app.use(cors());
app.use(express.static('public'));

// --- CACHÉ SIMPLE ---
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos

// --- FUNCIÓN PARA OBTENER DATOS ---
async function getSheetData() {
    const now = Date.now();
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        return cachedData;
    }

    try {
        console.log('Fetching data from Google Sheets...');
        if (GOOGLE_SHEET_CSV_URL === 'TU_URL_DE_GOOGLE_SHEETS_AQUI') {
            console.warn('ADVERTENCIA: URL de Google Sheets no configurada. Usando datos de prueba.');
            return [
                {
                    'ITEM ID': 'MLA123456',
                    'Nombre': 'Producto de Prueba 1',
                    'Inventario': 'INV-001',
                    'Envío': 'Full',
                    'Agregado1': 'Caja Roja',
                    'Agregado2': 'Etiqueta Frágil'
                },
                {
                    'ITEM ID': 'MLA999999',
                    'Nombre': 'Producto de Prueba 2',
                    'Inventario': 'INV-002',
                    'Envío': 'Colecta',
                    'Agregado1': 'Bolsa',
                    'Agregado2': ''
                }
            ];
        }

        const response = await axios.get(GOOGLE_SHEET_CSV_URL);
        const csvData = response.data;

        const parsed = Papa.parse(csvData, {
            header: true,
            skipEmptyLines: true,
        });

        cachedData = parsed.data;
        lastFetchTime = now;
        return cachedData;
    } catch (error) {
        console.error('Error fetching Google Sheet:', error.message);
        throw error;
    }
}

// --- API ENDPOINT ---
app.get('/api/search', async (req, res) => {
    const query = req.query.q ? req.query.q.toLowerCase().trim() : '';

    if (!query) {
        return res.json([]);
    }

    try {
        const data = await getSheetData();

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
                agregados: agregados // AHORA DEVOLVEMOS EL ARRAY PURO
            };
        });

        res.json(cleanResults);

    } catch (error) {
        res.status(500).json({ error: 'Error al procesar la búsqueda' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
