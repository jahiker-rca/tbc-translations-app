const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: process.env.CORS_ALLOWED_ORIGIN,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
}));
app.use(bodyParser.json());

// Configuration
const ADMIN_API_URL = `https://${process.env.SHOPIFY_SHOP_NAME}/admin/api/2024-10`;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// ============= HELPER FUNCTIONS =============

async function makeGraphQLRequest(query) {
    try {
        const response = await axios.post(
            `${ADMIN_API_URL}/graphql.json`,
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            }
        );
        return response.data;
    } catch (error) {
        throw new Error(`GraphQL request failed: ${error.message}`);
    }
}

// Function to trigger auto-translation using different endpoints
async function triggerTranslateAndAdapt(productId, targetLocale = 'de') {
    const numericId = productId.replace('gid://shopify/Product/', '');

    const endpoints = [
        {
            url: `${ADMIN_API_URL}/translations/auto_translate.json`,
            data: {
                "resource_id": `gid://shopify/Product/${numericId}`,
                "locale": targetLocale,
                "translate_all": true
            }
        },
        {
            url: `${ADMIN_API_URL}/translations/auto_translate.json`,
            data: {
                "auto_translate": {
                    "resource_id": `gid://shopify/Product/${numericId}`,
                    "locale": targetLocale,
                    "translate_all": true
                }
            }
        },
        {
            url: `${ADMIN_API_URL}/translatable_resources/${numericId}/translations.json`,
            data: {
                "locale": targetLocale,
                "auto_translate": true
            }
        }
    ];

    for (const endpoint of endpoints) {
        try {
            console.log(`Trying endpoint: ${endpoint.url}`);
            const response = await axios.post(endpoint.url, endpoint.data, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            });

            console.log(`Success with endpoint: ${endpoint.url}`);
            return response.data;
        } catch (error) {
            console.log(`Failed endpoint ${endpoint.url}: ${error.response?.status} - ${error.message}`);
            continue;
        }
    }

    return null;
}

// Function to create translation using GraphQL mutations (if available)
async function createTranslationWithMutation(productId, namespace, key, originalValue, targetLocale) {
    try {
        const numericId = productId.replace('gid://shopify/Product/', '');
        const metafieldKey = `metafields.${namespace}.${key}`;

        const mutation = `
            mutation translationCreate($id: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $id, translations: $translations) {
                    translations {
                        key
                        value
                        locale
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        const variables = {
            id: productId,
            translations: [
                {
                    key: metafieldKey,
                    value: originalValue,
                    locale: targetLocale
                }
            ]
        };

        const response = await axios.post(
            `${ADMIN_API_URL}/graphql.json`,
            {
                query: mutation,
                variables: variables
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            }
        );

        return response.data;
    } catch (error) {
        console.log('GraphQL mutation failed:', error.message);
        return null;
    }
}

async function getOrCreateMetafieldTranslation(productId, namespace, key, targetLocale = 'de') {
    try {
        const checkQuery = `{
            translatableResource(resourceId: "${productId}") {
                translations(locale: "${targetLocale}") {
                    key
                    value
                }
            }
        }`;

        let response = await makeGraphQLRequest(checkQuery);
        const metafieldKey = `metafields.${namespace}.${key}`;
        const existingTranslation = response.data.translatableResource.translations
            .find(t => t.key === metafieldKey);

        if (existingTranslation) {
            return {
                value: existingTranslation.value,
                locale: targetLocale,
                isTranslated: true,
                source: 'existing_translation'
            };
        }

        const originalQuery = `{
            product(id: "${productId}") {
                metafield(namespace: "${namespace}", key: "${key}") {
                    value
                }
            }
        }`;

        const originalResponse = await makeGraphQLRequest(originalQuery);
        const originalValue = originalResponse.data.product.metafield?.value;

        if (!originalValue) {
            throw new Error('Metafield not found');
        }

        console.log('Attempting to trigger auto-translation...');
        const autoTranslateResult = await triggerTranslateAndAdapt(productId, targetLocale);

        if (autoTranslateResult) {
            await new Promise(resolve => setTimeout(resolve, 5000));

            const afterAutoResponse = await makeGraphQLRequest(checkQuery);
            const autoTranslation = afterAutoResponse.data.translatableResource.translations
                .find(t => t.key === metafieldKey);

            if (autoTranslation) {
                return {
                    value: autoTranslation.value,
                    locale: targetLocale,
                    isTranslated: true,
                    source: 'auto_translation_created'
                };
            }
        }

        console.log('Attempting GraphQL mutation...');
        const mutationResult = await createTranslationWithMutation(
            productId, namespace, key, originalValue, targetLocale
        );

        if (mutationResult && !mutationResult.errors) {
            return {
                value: originalValue,
                locale: targetLocale,
                isTranslated: false,
                source: 'mutation_created',
                message: 'Translation entry created. You may need to edit it manually in Translate & Adapt app.'
            };
        }

        return {
            value: originalValue,
            locale: 'en',
            isTranslated: false,
            source: 'original_fallback',
            message: 'Could not create translation automatically. Please create it manually in Translate & Adapt app.'
        };

    } catch (error) {
        throw new Error(`Failed to get or create metafield translation: ${error.message}`);
    }
}

// ============= ENDPOINTS =============

app.post('/api/get-metafield', async (req, res) => {
    try {
        const response = await axios.post(
            `${ADMIN_API_URL}/graphql.json`,
            { query: req.body.query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/get-translated-metafield', async (req, res) => {
    try {
        const { productId, namespace, key, locale = 'de' } = req.body;

        if (!productId || !namespace || !key) {
            return res.status(400).json({
                error: 'Missing required parameters: productId, namespace, key'
            });
        }

        const result = await getOrCreateMetafieldTranslation(
            productId,
            namespace,
            key,
            locale
        );

        res.json({
            success: true,
            value: result.value,
            locale: result.locale,
            isTranslated: result.isTranslated,
            source: result.source,
            requestedLocale: locale,
            metafieldKey: `${namespace}.${key}`,
            message: result.message,
            instructions: result.instructions
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
