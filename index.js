
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: process.env.CORS_ALLOWED_ORIGIN,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
}));
app.use(bodyParser.json());

app.post('/api/get-metafield', async (req, res) => {
    try {
        const response = await fetch(`https://${process.env.SHOPIFY_SHOP_NAME}/admin/api/2025-07/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN
            },
            body: JSON.stringify({ query: req.body.query })
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
