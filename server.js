const express = require('express');
const axios = require('axios');
const Papa = require('papaparse');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
// REEMPLAZA ESTA URL CON LA TUYA DE GOOGLE SHEETS (Debe terminar en /export?format=csv)
// Ejemplo: https://docs.google.com/spreadsheets/d/TU_ID_DE_HOJA/export?format=csv
const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1q0qWmIcRAybrxQcYRhJd5s-A1xiEe_VenWEA84Xptso/export?format=csv&gid=1839169689';

app.use(cors());
app.use(express.static('public')); // Sirve los archivos estáticos de la carpeta public

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
        // Si no hay URL configurada, devolvemos datos de prueba
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

        // Lógica de búsqueda flexible
        const results = data.filter(row => {
            // Asumimos nombres de columnas basados en la descripción, pero buscamos en todos los valores por si acaso
            // O mapeamos específicamente si las columnas son fijas.
            // Para máxima flexibilidad, buscamos el query en todos los valores de la fila.
            return Object.values(row).some(val =>
                String(val).toLowerCase().includes(query)
            );
        });

        // Mapeamos los resultados para devolver una estructura limpia al frontend
        const cleanResults = results.map(row => {
            // Intentamos detectar las columnas dinámicamente o usamos índices si los nombres varían
            // Basado en el pedido:
            // A: ITEM ID
            // E: Envío
            // N, O, P, Q: Agregados

            // Como PapaParse usa headers, necesitamos los nombres exactos de las columnas.
            // Si no los tenemos, podemos acceder por índice si usamos header: false, pero header: true es más seguro.
            // AQUÍ HACEMOS UN MAPEO INTELIGENTE BASADO EN LAS KEYS DEL OBJETO
            const keys = Object.keys(row);

            // Asumimos orden si los headers no son predecibles, o buscamos nombres comunes
            const itemId = row['ITEM ID'] || row[keys[0]] || 'S/D';
            const envio = row['Envío'] || row['Envio'] || row[keys[4]] || 'S/D'; // Columna E es índice 4 aprox

            // Agregados: Columnas N(13), O(14), P(15), Q(16)
            // Esto es aproximado si usamos nombres, mejor concatenar todo lo que no sea ID o Envío si es genérico,
            // pero para ser específicos intentaremos tomar esas columnas si existen por índice en el array de keys.
            const agregados = [];
            if (keys[13]) agregados.push(row[keys[13]]);
            if (keys[14]) agregados.push(row[keys[14]]);
            if (keys[15]) agregados.push(row[keys[15]]);
            if (keys[16]) agregados.push(row[keys[16]]);

            return {
                title: itemId, // O Nombre si existe
                subtitle: row['Nombre'] || row['Titulo'] || row[keys[1]] || '', // Intento de buscar nombre
                envio: envio,
                agregados: agregados.filter(a => a).join(', ') // Unimos los agregados no vacíos
            };
        });

        res.json(cleanResults);

    } catch (error) {
        res.status(500).json({ error: 'Error al procesar la búsqueda' });
    }
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
